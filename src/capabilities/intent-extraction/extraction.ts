import { appendNote } from "@/lib/domain/conversation";
import { EXPLICIT_NO_WORDING_VALUE } from "@/lib/domain/required-wording";
import type { PrintPlacement, TShirtDesignBrief } from "@/lib/domain/types";
import { isDeferrable } from "@/capabilities/shared/interview-coverage-policy";
import type {
  BriefSectionKey,
  DetectedIntent,
} from "@/capabilities/shared/contracts";

/**
 * Deterministic multi-field extraction engine (Sprint 2F).
 *
 * Replaces the Sprint 1 "one field per phase" mapping with a heuristic
 * extractor that reads everything a free-text reply can confidently support
 * — several Design Brief fields at once, corrections, explicit deferrals,
 * and an explicit "no wording" signal — without an LLM dependency.
 *
 * Conservative by design: when a fragment is genuinely ambiguous (doesn't
 * match a known vocabulary/pattern), it is preserved verbatim in
 * `additionalInstructions` rather than force-fit into a structured field.
 * The one exception is the section the customer was just asked about
 * (`pendingSection`) — a direct, on-topic reply always gets recorded
 * against that field even without a keyword match, exactly like the
 * Sprint 1 scripted ladder did for its one question per turn.
 */

export type BriefFieldPatch = Partial<
  Omit<TShirtDesignBrief, "id" | "projectId" | "createdAt" | "updatedAt">
>;

export interface ExtractionOutcome {
  fields: BriefFieldPatch;
  intents: DetectedIntent[];
}

export interface ExtractionContext {
  brief: TShirtDesignBrief;
  reply: string;
  /** The section Interview Intelligence most recently asked/clarified, if any. */
  pendingSection: BriefSectionKey | null;
}

/* ------------------------------------------------------------------ */
/* Vocabularies                                                        */
/* ------------------------------------------------------------------ */

// Longest phrases first so multi-word colors match before their substrings.
const COLOR_WORDS = [
  "heather grey",
  "heather gray",
  "forest green",
  "kelly green",
  "royal blue",
  "navy blue",
  "hot pink",
  "light blue",
  "baby blue",
  "burnt orange",
  "navy",
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "purple",
  "pink",
  "gray",
  "grey",
  "gold",
  "silver",
  "maroon",
  "cream",
  "tan",
  "brown",
  "charcoal",
  "teal",
  "turquoise",
  "burgundy",
  "olive",
  "mint",
  "lavender",
  "coral",
  "beige",
  "khaki",
  "rust",
];

const COLOR_PATTERN = new RegExp(`\\b(${COLOR_WORDS.join("|")})\\b`, "gi");

const PRODUCT_WORDS = [
  "t-shirts?",
  "tshirts?",
  "tees?",
  "shirts?",
  "hoodies?",
  "sweatshirts?",
  "tank tops?",
  "long sleeves?",
  "crewnecks?",
  "polos?",
  "jerseys?",
  "caps?",
  "hats?",
];
const PRODUCT_PATTERN = new RegExp(`\\b(${PRODUCT_WORDS.join("|")})\\b`, "i");

const DESIGN_CONTEXT_PATTERN =
  /\b(design|logo|artwork|print|lettering|text|graphic|image|imagery)\b/i;

const STYLE_WORDS = [
  "hand-drawn",
  "vintage",
  "modern",
  "minimalist",
  "minimal",
  "retro",
  "classic",
  "bold",
  "elegant",
  "playful",
  "rustic",
  "athletic",
  "edgy",
  "whimsical",
  "clean",
  "distressed",
  "grunge",
  "grungy",
  "cartoonish",
  "cartoon",
  "realistic",
  "geometric",
  "funny",
  "cute",
  "professional",
  "sporty",
  "preppy",
  "industrial",
  "watercolor",
  "sketch",
];
const STYLE_PATTERN = new RegExp(`\\b(${STYLE_WORDS.join("|")})\\b`, "gi");

const PRINT_LOCATION_PHRASES: Array<[RegExp, PrintPlacement]> = [
  [/\bfull\s+front\b/i, "full_front"],
  [/\bfull\s+back\b/i, "full_back"],
  [/\bleft\s+chest\b/i, "left_chest"],
  [/\bsleeve\b/i, "sleeve"],
  [/\bfront\b/i, "full_front"],
  [/\bback\b/i, "full_back"],
  [/\bchest\b/i, "left_chest"],
];

const AUDIENCE_CUES =
  /\b(team|club|group|family|families|class|company|business|crew|staff|chapter|league|school|camp|organization|nonprofit|non-profit)\b/i;
const PURPOSE_CUES =
  /\b(event|fundraiser|celebration|reunion|tournament|game|wedding|birthday|anniversary|launch|festival|graduation|retirement)\b/i;

const DEFERRAL_PATTERNS = [
  /^(?:you|the designer)\s+(?:choose|decide|pick)\b/i,
  /\bwhatever\s+(?:you\s+(?:think|want|recommend)|works(?:\s+best)?|looks\s+good|is\s+fine)\b/i,
  /\bwhatever\s+\S+\s+works?\b/i,
  /\bsurprise me\b/i,
  /\bdecide for me\b/i,
  /^up to you\.?$/i,
  /\bno preference\b/i,
  /^(?:i'?m\s+)?not sure\.?$/i,
  /^(?:i\s+)?don'?t know\.?$/i,
  /^no idea\.?$/i,
  /\banything\s+(?:is fine|works)\b/i,
];

const CORRECTION_CUE_PATTERN =
  /\b(actually|instead|change (?:it|that|the \w+)? ?to|forget|no longer|scratch that)\b/i;

const EXPLICIT_NO_WORDING_PATTERN =
  /^(?:none|no text|no wording|n\/a|na|nothing)$/i;
const NO_WORDING_PHRASE_PATTERN =
  /\bno (?:text|wording)(?: needed| required)?\b/i;

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function extractAdaptive(context: ExtractionContext): ExtractionOutcome {
  const trimmed = context.reply.trim();
  const fields: BriefFieldPatch = {};

  // 1. Explicit deferral — checked first so a short "you choose" never
  // gets misread as an attempted (ambiguous) answer. Two ways to trigger
  // it: answering the pending question with a deferral phrase (the
  // interview case), or spontaneously naming a section to defer (the
  // revision case, where there is no pending question — "Actually, you
  // choose the print placement" said out of nowhere).
  const pendingDeferral =
    context.pendingSection &&
    isDeferrable(context.pendingSection) &&
    isDeferralReply(trimmed)
      ? context.pendingSection
      : null;
  const deferredTarget = pendingDeferral ?? detectMentionedDeferral(trimmed);

  if (deferredTarget) {
    const next = new Set(context.brief.deferredSections);
    next.add(deferredTarget);
    return {
      fields: { deferredSections: [...next] },
      intents: ["defer"],
    };
  }

  const isCorrection = CORRECTION_CUE_PATTERN.test(trimmed);
  const positiveText = stripNegatedClauses(trimmed);

  const wording = extractRequiredWording(trimmed, positiveText);
  if (wording !== undefined) fields.exactText = wording;

  const colors = extractColors(positiveText, context.pendingSection);
  if (colors.productColor) fields.shirtColor = colors.productColor;
  if (colors.artworkColors.length > 0) fields.preferredColors = colors.artworkColors;

  const style = extractStyle(positiveText);
  if (style) fields.designStyle = style;

  const graphics = extractGraphics(positiveText);
  if (graphics) fields.designDescription = graphics;

  const product = extractProduct(positiveText);
  if (product) fields.productSummary = product;

  const printPlacement = extractPrintLocation(positiveText);
  if (printPlacement) fields.printPlacement = printPlacement;

  const exclusions = extractExclusions(positiveText);
  if (exclusions) fields.exclusions = appendNote(context.brief.exclusions, exclusions);

  const audiencePurpose = extractAudiencePurpose(positiveText);
  if (audiencePurpose.audience) fields.audience = audiencePurpose.audience;
  if (audiencePurpose.purpose) fields.purpose = audiencePurpose.purpose;

  applyPendingSectionFallback(context, trimmed, fields);

  // Nothing structured could be pulled from a substantive reply — preserve
  // it rather than silently discard it.
  if (Object.keys(fields).length === 0 && wordCount(trimmed) > 3) {
    fields.additionalInstructions = appendNote(
      context.brief.additionalInstructions,
      trimmed,
    );
  }

  const intents: DetectedIntent[] = [];
  if (isCorrection && Object.keys(fields).length > 0) intents.push("correct");
  intents.push(Object.keys(fields).length > 0 ? "provide_info" : "unknown");

  return { fields, intents };
}

/* ------------------------------------------------------------------ */
/* Deferral                                                             */
/* ------------------------------------------------------------------ */

function isDeferralReply(trimmed: string): boolean {
  if (wordCount(trimmed) > 8) return false; // a deferral phrase inside a longer answer is not a deferral
  return DEFERRAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Unanchored deferral-verb detection, for the no-pending-question case
// (revisions). Kept separate from DEFERRAL_PATTERNS (mostly `^`-anchored,
// tuned for "this whole short reply IS the deferral") — this variant must
// also work mid-sentence ("Actually, you choose the print placement"), so
// it is paired with an explicit section mention to stay precise instead of
// firing on any passing use of "choose"/"decide".
const DEFERRAL_VERB_PATTERN =
  /\b(?:you|the designer)\s+(?:choose|decide|pick)\b|\bwhatever\s+(?:you\s+(?:think|want|recommend)|works(?:\s+best)?|looks\s+good|is\s+fine)\b|\bsurprise me\b|\bdecide for me\b|\bup to you\b|\bno preference\b|\bleave it (?:up )?to you\b/i;

const SECTION_MENTION_PATTERNS: Array<[RegExp, BriefSectionKey]> = [
  [/\bprint\s*(?:location|placement|position)\b|\bplacement\b/i, "printLocation"],
  [/\b(?:artwork|design)\s*colou?rs?\b|\bcolou?rs?\b/i, "colors"],
  [/\bstyle\b|\blook\b/i, "style"],
  [/\baudience\b/i, "audience"],
  [/\bpurpose\b|\boccasion\b/i, "purpose"],
];

function detectMentionedDeferral(trimmed: string): BriefSectionKey | null {
  if (wordCount(trimmed) > 14) return null; // stay scoped to short, clearly-deferral-shaped replies
  if (!DEFERRAL_VERB_PATTERN.test(trimmed)) return null;
  for (const [pattern, section] of SECTION_MENTION_PATTERNS) {
    if (pattern.test(trimmed) && isDeferrable(section)) return section;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Corrections — strip negated clauses so "actually navy, not black"    */
/* doesn't extract "black" as a positive value.                        */
/* ------------------------------------------------------------------ */

function stripNegatedClauses(text: string): string {
  return text
    .replace(/\bnot\s+[a-z][a-z\s]*?(?=[,.;]|$| and\b| but\b)/gi, "")
    .replace(
      /\bforget\s+[a-z][a-z\s]*?(?=[,.;]|$| and\b| but\b| use\b)/gi,
      "",
    )
    .replace(/\binstead of\s+[a-z][a-z\s]*?(?=[,.;]|$| and\b| but\b)/gi, "");
}

/* ------------------------------------------------------------------ */
/* Required wording                                                    */
/* ------------------------------------------------------------------ */

function extractRequiredWording(
  trimmed: string,
  positiveText: string,
): string | undefined {
  if (
    EXPLICIT_NO_WORDING_PATTERN.test(trimmed) ||
    NO_WORDING_PHRASE_PATTERN.test(trimmed)
  ) {
    return EXPLICIT_NO_WORDING_VALUE;
  }

  const quoted = trimmed.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) return (quoted[1] ?? quoted[2] ?? "").trim();

  const cued = positiveText.match(
    /\b(?:say|should say|it should say|the text is|wording should be|should read|print the words?|change (?:the )?(?:wording|text) to)\s*[:\-]?\s*"?([^".!?\n]+)"?/i,
  );
  if (cued?.[1]?.trim()) return cued[1].trim();

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Colors — clause-scoped context decides product vs. artwork color.    */
/* ------------------------------------------------------------------ */

function extractColors(
  positiveText: string,
  pendingSection: BriefSectionKey | null,
): { productColor: string | null; artworkColors: string[] } {
  const clauses = positiveText
    .split(/[,.;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  let productColor: string | null = null;
  const artworkColors: string[] = [];
  const undecided: string[] = [];

  for (const clause of clauses) {
    const colorsInClause = matchAllColors(clause);
    if (colorsInClause.length === 0) continue;

    const hasProductWord = PRODUCT_PATTERN.test(clause);
    const hasDesignWord = DESIGN_CONTEXT_PATTERN.test(clause);

    if (hasProductWord && !hasDesignWord) {
      productColor ??= colorsInClause[0] ?? null;
      artworkColors.push(...colorsInClause.slice(1));
    } else if (hasDesignWord && !hasProductWord) {
      artworkColors.push(...colorsInClause);
    } else if (hasProductWord && hasDesignWord) {
      productColor ??= colorsInClause[0] ?? null;
      artworkColors.push(...colorsInClause.slice(1));
    } else {
      undecided.push(...colorsInClause);
    }
  }

  if (undecided.length > 0) {
    if (pendingSection === "productColor" && !productColor) {
      productColor = undecided[0] ?? null;
      artworkColors.push(...undecided.slice(1));
    } else {
      artworkColors.push(...undecided);
    }
  }

  return { productColor, artworkColors: dedupeCaseInsensitive(artworkColors) };
}

function matchAllColors(text: string): string[] {
  const matches = [...text.matchAll(COLOR_PATTERN)];
  return dedupeCaseInsensitive(matches.map((m) => m[0]));
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Style                                                                */
/* ------------------------------------------------------------------ */

function extractStyle(positiveText: string): string | null {
  const matches = [...positiveText.matchAll(STYLE_PATTERN)].map((m) => m[0]);
  const unique = dedupeCaseInsensitive(matches);
  return unique.length > 0 ? unique.join(", ") : null;
}

/* ------------------------------------------------------------------ */
/* Graphics / imagery description                                      */
/* ------------------------------------------------------------------ */

function extractGraphics(positiveText: string): string | null {
  const match = positiveText.match(
    /\b(?:with|featuring|showing|depicting)\s+(?:a |an |some )?([^.!?]+)/i,
  );
  return match?.[1]?.trim() || null;
}

/* ------------------------------------------------------------------ */
/* Product                                                              */
/* ------------------------------------------------------------------ */

// "make (the|your|our|it) <product-word>" — a predicate about an existing
// product ("make the shirt black", "make it a hoodie" only WITHOUT an
// intervening article) reads as an attribute change, not a new product
// description. Deliberately does not match "make it a hoodie" (there's an
// article between "it" and "hoodie"), which should still count.
const PRODUCT_ATTRIBUTE_CHANGE_PATTERN = new RegExp(
  `\\bmake\\s+(?:the|your|our|it)?\\s*(${PRODUCT_WORDS.join("|")})\\b`,
  "i",
);

function extractProduct(positiveText: string): string | null {
  if (!PRODUCT_PATTERN.test(positiveText)) return null;
  // Use the clause containing the product word rather than the full,
  // possibly multi-sentence reply. A clause about the product's *color*
  // (mentions "color"/"colour", or reads as "make the shirt <word>") is
  // not a product description — skip it so a color correction never
  // overwrites the product description just because it names the garment.
  const clause = positiveText
    .split(/[.!?]/)
    .map((c) => c.trim())
    .find(
      (c) =>
        PRODUCT_PATTERN.test(c) &&
        !/\bcolou?r\b/i.test(c) &&
        !PRODUCT_ATTRIBUTE_CHANGE_PATTERN.test(c),
    );
  return clause || null;
}

/* ------------------------------------------------------------------ */
/* Print location                                                      */
/* ------------------------------------------------------------------ */

function extractPrintLocation(positiveText: string): PrintPlacement | null {
  for (const [pattern, placement] of PRINT_LOCATION_PHRASES) {
    if (pattern.test(positiveText)) return placement;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Exclusions                                                          */
/* ------------------------------------------------------------------ */

function extractExclusions(positiveText: string): string | null {
  const matches = [
    ...positiveText.matchAll(
      /\b(?:avoid|without|no)\s+([a-z][a-z\s]*?)(?=[,.!?]|$)/gi,
    ),
  ]
    .map((m) => m[1]?.trim())
    .filter((phrase): phrase is string => {
      if (!phrase) return false;
      const normalized = phrase.toLowerCase();
      // "no text"/"no wording" is handled by extractRequiredWording, not exclusions.
      return normalized !== "text" && normalized !== "wording";
    });

  if (matches.length === 0) return null;
  return matches.map((phrase) => `No ${phrase}`).join("; ");
}

/* ------------------------------------------------------------------ */
/* Audience / purpose — conservative, cue-word gated                   */
/* ------------------------------------------------------------------ */

function extractAudiencePurpose(positiveText: string): {
  audience: string | null;
  purpose: string | null;
} {
  const match = positiveText.match(
    /\bfor\s+(?:our|my|the)\s+([a-z0-9][^.,;!?]*)/i,
  );
  const phrase = match?.[1]?.trim();
  if (!phrase) return { audience: null, purpose: null };

  if (AUDIENCE_CUES.test(phrase)) return { audience: phrase, purpose: null };
  if (PURPOSE_CUES.test(phrase)) return { audience: null, purpose: phrase };
  return { audience: null, purpose: null };
}

/* ------------------------------------------------------------------ */
/* Pending-section fallback — guarantees a direct answer to the         */
/* question just asked is always recorded, matching Sprint 1 behavior   */
/* for the simple one-field-per-turn case.                              */
/* ------------------------------------------------------------------ */

const SECTION_FIELD_KEY: Partial<Record<BriefSectionKey, keyof BriefFieldPatch>> = {
  product: "productSummary",
  graphics: "designDescription",
  productColor: "shirtColor",
  requiredWording: "exactText",
  style: "designStyle",
  colors: "preferredColors",
  audience: "audience",
  purpose: "purpose",
  exclusions: "exclusions",
  additionalNotes: "additionalInstructions",
};

function applyPendingSectionFallback(
  context: ExtractionContext,
  trimmed: string,
  fields: BriefFieldPatch,
): void {
  const section = context.pendingSection;
  if (!section) return;
  const fieldKey = SECTION_FIELD_KEY[section];
  if (!fieldKey || fieldKey in fields) return;
  if (!trimmed) return;

  switch (section) {
    case "product":
      fields.productSummary = trimmed;
      return;
    case "graphics":
      fields.designDescription = trimmed;
      return;
    case "productColor":
      fields.shirtColor = trimmed;
      return;
    case "requiredWording":
      fields.exactText = trimmed;
      return;
    case "style":
      fields.designStyle = trimmed;
      return;
    case "colors":
      fields.preferredColors = dedupeCaseInsensitive(
        trimmed
          .split(/,|&|\band\b/i)
          .map((c) => c.trim())
          .filter(Boolean),
      );
      return;
    case "audience":
      fields.audience = trimmed;
      return;
    case "purpose":
      fields.purpose = trimmed;
      return;
    case "exclusions":
      fields.exclusions = appendNote(context.brief.exclusions, trimmed);
      return;
    case "additionalNotes":
      fields.additionalInstructions = appendNote(
        context.brief.additionalInstructions,
        trimmed,
      );
      return;
    default:
      return;
  }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
