import { appendNote } from "@/lib/domain/conversation";
import { EXPLICIT_NO_WORDING_VALUE } from "@/lib/domain/required-wording";
import type { PrintPlacement, TShirtDesignBrief } from "@/lib/domain/types";
import { isDeferrable } from "@/capabilities/shared/interview-coverage-policy";
import {
  normalizeColorAnswer,
  normalizeProductAnswer,
} from "@/capabilities/shared/field-normalization";
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
  // A bare negative reply to a *deferrable* question (e.g. "Any color
  // preference?" / "no.") reads as "no preference, you decide" — never as
  // literal content. Sprint 2K Phase 2: this is the fix for "no" leaking
  // into `preferredColors` as if it were a color name. Required sections
  // never reach this branch (`isDeferrable` gates it above), so a bare "no"
  // answering the required-wording question is untouched here and still
  // handled by `EXPLICIT_NO_WORDING_PATTERN` below.
  /^(?:no|nope|nah|no thanks|not really)\.?$/i,
];

const CORRECTION_CUE_PATTERN =
  /\b(actually|instead|change (?:it|that|the \w+)? ?to|forgot|forget|no longer|scratch that)\b/i;

const EXPLICIT_NO_WORDING_PATTERN =
  /^(?:none|no|nope|no text|no wording|n\/a|na|nothing)$/i;
const NO_WORDING_PHRASE_PATTERN =
  /\bno (?:text|wording)(?: needed| required)?\b/i;

/* ------------------------------------------------------------------ */
/* Named entities — team/company/event/organization names, recognized  */
/* as required wording independent of the generic "should say" cue.    */
/* ------------------------------------------------------------------ */

const ENTITY_NOUNS =
  "team|company|business|group|club|organization|non-?profit|event|league|school|shop|store|brand";

// Tried in order; the first match wins. Ordered most-specific ("name is X")
// before the bare "name X" variant so "team name is My 3 Sons" never
// captures the leading "is" as part of the name.
const ENTITY_NAME_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:${ENTITY_NOUNS})(?:'s)?\\s+name\\s+is\\s+([^.,;!?\\n]+)`, "i"),
  new RegExp(`\\b(?:${ENTITY_NOUNS})\\s+(?:is\\s+)?(?:called|named)\\s+([^.,;!?\\n]+)`, "i"),
  new RegExp(`\\b(?:${ENTITY_NOUNS})\\s+name\\s*[:\\-]?\\s+([^.,;!?\\n]+)`, "i"),
  new RegExp(`\\bour\\s+(?:${ENTITY_NOUNS})\\s+is\\s+([^.,;!?\\n]+)`, "i"),
  /\bcall\s+it\s+([^.,;!?\n]+)/i,
];

// Used to strip a trailing name-cue clause out of an *audience* match so
// "bowling team name My 3 Sons" / "bowling team called My 3 Sons" resolves
// to audience "bowling team" instead of absorbing the required wording.
const NAME_CUE_BOUNDARY_PATTERN =
  /\s+(?:name\s+is|name|is\s+called|is\s+named|named|called)\b.*$/i;

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
  // Sprint 2K Phase 3 (Goal 2): normalize here, at the point the Design
  // Brief field is actually written, so every downstream reader (Brief
  // Evaluation, Design Summary, Prompt Translation) sees the canonical
  // form without duplicating the lookup. Required wording is deliberately
  // exempt (see `extractRequiredWording`) — only product/color fields are
  // normalized, never the literal text to print.
  if (colors.productColor) fields.shirtColor = normalizeColorAnswer(colors.productColor);
  if (colors.artworkColors.length > 0) {
    fields.preferredColors = colors.artworkColors.map(normalizeColorAnswer);
  }

  const style = extractStyle(positiveText);
  if (style) fields.designStyle = style;

  const graphics = extractGraphics(positiveText);
  if (graphics) fields.designDescription = graphics;

  // Sprint 2K Phase 3 (Goal 1): a short, single-clause reply is a direct
  // answer to whatever question is actually pending — a generic product
  // noun that merely appears inside it ("bowling league team **shirts**"
  // answering *purpose*) must not be reinterpreted as a spontaneous product
  // update. An already-resolved Product additionally can never be silently
  // overwritten by an unrelated answer regardless of clause count. See
  // `isDedicatedToADifferentPendingSection` below.
  const product = isDedicatedToADifferentPendingSection(
    context,
    positiveText,
    "product",
    Boolean(context.brief.productSummary?.trim()),
  )
    ? null
    : extractProduct(positiveText);
  if (product) fields.productSummary = normalizeProductAnswer(product);

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
/* Cross-field contamination guard (Sprint 2K Phase 3, Goal 1)         */
/* ------------------------------------------------------------------ */

/**
 * True when `positiveText` is a reply to a *different* pending question
 * than `ownSection` and should NOT be allowed to opportunistically
 * (re-)populate `ownSection` — the general boundary a pattern-based
 * extractor (e.g. `extractProduct`, whose vocabulary is generic nouns like
 * "shirts" that show up in all kinds of unrelated sentences) must respect
 * so it never reinterprets a direct answer to one question as an update to
 * a different field.
 *
 * Two independent conditions each suppress, since they catch two different
 * shapes of the same contamination bug:
 *   - `alreadyResolved` — `ownSection` already has a real value. A later,
 *     unrelated answer must never silently overwrite an already-resolved
 *     field just because it happens to contain a matching word, no matter
 *     how many clauses that reply has (e.g. a *graphics* answer mentioning
 *     "chef's hat" must not overwrite an already-resolved Product of
 *     "T-shirt" just because "hat" is also a recognized product noun).
 *   - single-clause reply — a short, single-topic reply to a *different*
 *     question is presumptively "owned" by that question even before
 *     `ownSection` has any value yet (e.g. "bowling league team shirts"
 *     answering *purpose* must not become Product).
 *
 * Both are skipped by an explicit correction cue ("actually", "instead",
 * ...) — the customer is deliberately steering to a different field, so
 * cross-field extraction still applies — and by there being no pending
 * question at all (an opener/free-flowing reply with nothing specific
 * pending may always fill in any field it can).
 */
function isDedicatedToADifferentPendingSection(
  context: ExtractionContext,
  positiveText: string,
  ownSection: BriefSectionKey,
  alreadyResolved: boolean,
): boolean {
  const pending = context.pendingSection;
  if (!pending || pending === ownSection) return false;
  if (CORRECTION_CUE_PATTERN.test(positiveText)) return false;
  if (alreadyResolved) return true;
  const clauses = positiveText
    .split(/[.!?,;]/)
    .map((c) => c.trim())
    .filter(Boolean);
  return clauses.length <= 1;
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

  // Explicit team/company/event/organization names — "our team is called My
  // 3 Sons", "the team name is My 3 Sons", "call it My 3 Sons". These are
  // required wording just as much as an explicit "it should say" cue; a
  // print shop treats a team/company/event name the customer gives as text
  // that must appear on the design.
  for (const pattern of ENTITY_NAME_PATTERNS) {
    const match = positiveText.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }

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

// Up to two descriptor words (color or style) immediately preceding a
// product word, plus the product word itself — e.g. "black t-shirts",
// "vintage hoodies". Deliberately does NOT allow arbitrary preceding words
// (an unrestricted `\S+\s+` would recapture the "explanatory sentence"
// problem this function exists to avoid).
const PRODUCT_DESCRIPTOR_WORDS = [...COLOR_WORDS, ...STYLE_WORDS, "custom", "new"];
const PRODUCT_PHRASE_PATTERN = new RegExp(
  `((?:(?:${PRODUCT_DESCRIPTOR_WORDS.join("|")})\\s+){0,2}(?:${PRODUCT_WORDS.join("|")}))`,
  "i",
);

function extractProduct(positiveText: string): string | null {
  if (!PRODUCT_PATTERN.test(positiveText)) return null;

  // Splitting on commas too (not just sentence punctuation) keeps a
  // trailing clause like ", name is My 3 Sons" out of the product clause
  // even when it shares a sentence with the product word.
  const clauses = positiveText
    .split(/[.!?,;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  // A clause about the product's *color* (mentions "color"/"colour", or
  // reads as "make the shirt <word>") is not a product description — skip
  // it so a color correction never overwrites the product description just
  // because it names the garment.
  const clause = clauses.find(
    (c) =>
      PRODUCT_PATTERN.test(c) &&
      !/\bcolou?r\b/i.test(c) &&
      !PRODUCT_ATTRIBUTE_CHANGE_PATTERN.test(c),
  );
  if (!clause) return null;

  // Only tighten the clause down to a phrase around the product word(s)
  // when the reply actually had more than one clause to begin with — that
  // is the real "absorbed an explanatory sentence" shape: a product clause
  // sitting alongside an unrelated clause (team name, design description,
  // ...) in the same reply. A reply that is just a single clause, however
  // many words, is the customer's one direct answer and is kept exactly as
  // written ("A T-shirt for the school fair" stays as-is — Sprint 1
  // parity). Falls back to the full clause if the phrase pattern somehow
  // doesn't match (defensive; PRODUCT_PATTERN already matched).
  if (clauses.length <= 1) return clause;
  const phrase = clause.match(PRODUCT_PHRASE_PATTERN);
  return phrase?.[1]?.trim() ?? clause;
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
  const rawPhrase = match?.[1]?.trim();
  if (!rawPhrase) return { audience: null, purpose: null };

  // Strip a trailing name-cue clause so "bowling team name My 3 Sons" /
  // "bowling team called My 3 Sons" resolves to "bowling team" — the team
  // name itself is required wording, not part of the audience description.
  const phrase = rawPhrase.replace(NAME_CUE_BOUNDARY_PATTERN, "").trim() || rawPhrase;

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

/**
 * A reply that reads as an explanatory sentence/paragraph rather than a
 * short, direct answer — multiple sentences, or more than `maxWords` words.
 * Used to stop the pending-section fallback from stuffing a whole rich
 * reply into a single structured field just because that field happened to
 * be the pending question (Sprint 2K Phase 2: "Product extraction must
 * never absorb explanatory sentences" / "Audience extraction must never
 * absorb design descriptions").
 */
const MULTI_SENTENCE_PATTERN = /[.!?]\s*\S/;

function looksLikeExplanatorySentence(text: string, maxWords = 10): boolean {
  return MULTI_SENTENCE_PATTERN.test(text) || wordCount(text) > maxWords;
}

/** A 4-digit year, characteristic of event/reunion/session names ("Fun Run 2026"). */
const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;

/**
 * Sprint 2K Phase 3 (Goal 1): a genuine product answer is a short noun
 * phrase ("T-shirts", "black hoodies") — it is never event/audience/purpose
 * -shaped. This is what stops the very first message of a conversation
 * (naturally short, and the *first* pending question defaults to "product"
 * before anything else is known) from being swallowed whole as the product
 * just because it doesn't happen to trip the generic multi-sentence/
 * word-count heuristic — e.g. "Johnson Family Reunion 2026,
 * outdoors/camping theme." is 6 words with no sentence break, but is
 * obviously an event description, not a product name.
 */
function looksLikeADirectProductAnswer(text: string): boolean {
  if (looksLikeExplanatorySentence(text, 6)) return false;
  if (YEAR_PATTERN.test(text)) return false;
  if (AUDIENCE_CUES.test(text) || PURPOSE_CUES.test(text)) return false;
  return true;
}

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
      // A rich, multi-clause reply almost always contains more than the
      // product name (team/company name, design description, ...) — those
      // belong in their own fields (already extracted above, if
      // recognized), not folded into the product summary verbatim. Nor is
      // an event/audience/purpose-shaped reply a product name, even when
      // short — see `looksLikeADirectProductAnswer`.
      if (!looksLikeADirectProductAnswer(trimmed)) return;
      fields.productSummary = normalizeProductAnswer(trimmed);
      return;
    case "graphics":
      fields.designDescription = trimmed;
      return;
    case "productColor":
      fields.shirtColor = normalizeColorAnswer(trimmed);
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
          .map((c) => normalizeColorAnswer(c.trim()))
          .filter(Boolean),
      );
      return;
    case "audience":
      // Same reasoning as "product" above — a rich reply's audience clause
      // is extracted (with name-cue stripping) by extractAudiencePurpose
      // when it can be; a whole explanatory sentence must not be forced in.
      if (looksLikeExplanatorySentence(trimmed)) return;
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
