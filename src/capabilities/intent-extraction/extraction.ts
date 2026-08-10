import { appendNote } from "@/lib/domain/conversation";
import { EXPLICIT_NO_WORDING_VALUE } from "@/lib/domain/required-wording";
import type { PrintPlacement, TShirtDesignBrief } from "@/lib/domain/types";
import { isDeferrable } from "@/capabilities/shared/interview-coverage-policy";
import {
  normalizeColorAnswer,
  normalizeProductAnswer,
} from "@/capabilities/shared/field-normalization";
import {
  namesAPrintProduct,
  stripDesignArtifactWords,
} from "@/capabilities/shared/print-product-vocabulary";
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
  /**
   * Sprint 2M Phase 2G (Goal 2): true only for the post-concept-selection
   * revision loop (`ask_revisions` / `revision_received`). Lets an explicit
   * design-change imperative ("make the boat larger") that no dedicated
   * field extractor recognizes still land in `designDescription` (concept-
   * relevant) instead of the `additionalInstructions` catch-all — never
   * applied pre-approval, where an unmatched free-text reply legitimately
   * has nowhere better to go yet.
   */
  isPostSelectionRevision?: boolean;
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

/**
 * Nouns naming a part of the ARTWORK ITSELF — as opposed to something the
 * artwork merely depicts. A color touching one of these is a statement
 * about how the design should be rendered ("gold lettering", "make the
 * design mostly blue"); a color touching anything else is an attribute of
 * the subject ("red roses", "a red 1988 Toyota MR2"), which the design
 * description already carries.
 */
const DESIGN_ELEMENT_WORDS = [
  "design",
  "designs",
  "artwork",
  "art",
  "graphic",
  "graphics",
  "logo",
  "lettering",
  "letters",
  "text",
  "wording",
  "type",
  "typography",
  "font",
  "fonts",
  "background",
  "outline",
  "border",
  "ink",
  "palette",
  "scheme",
  "print",
];

/**
 * The rest of a color list, so the noun that closes it can be read as the
 * noun every color in it modifies: "red and gold lettering" and
 * "gold-and-white design" both attach to their final noun. Hyphens count
 * as separators — customers write "black-and-white" as often as "black and
 * white".
 */
const COLOR_LIST_SEPARATOR = `[\\s,&\\-]*(?:and[\\s,&\\-]+)?(?:(?:${COLOR_WORDS.join("|")})[\\s,&\\-]+(?:and[\\s,&\\-]+)?)*`;

/** A design element within one word BEFORE the color: "the design mostly blue", "lettering in gold". */
const DESIGN_ELEMENT_BEFORE_COLOR = new RegExp(
  `\\b(?:${DESIGN_ELEMENT_WORDS.join("|")})\\b(?:\\s+\\w+)?\\s*$`,
  "i",
);

/**
 * A design element closing the color list the color belongs to: matches
 * both "gold lettering" and the "red" of "red and gold lettering", while
 * never reaching past a non-color word ("red roses with gold lettering"
 * leaves "red" on the roses, where it belongs).
 */
const DESIGN_ELEMENT_AFTER_COLOR = new RegExp(
  `^${COLOR_LIST_SEPARATOR}(?:${DESIGN_ELEMENT_WORDS.join("|")})\\b`,
  "i",
);

/** The customer talking about the palette itself: "use red and gold", "mostly blue", "warm colors". */
const PALETTE_CUE_PATTERN =
  /\b(colou?rs?|colou?red|palette|scheme|tones?|mostly|primarily|mainly|use|using|stick to)\b/i;

/** The color sits directly on the product: "gray hoodie", "black and white tees", "navy cotton shirt". */
const PRODUCT_AFTER_COLOR = new RegExp(
  `^${COLOR_LIST_SEPARATOR}(?:\\w+\\s+)?(?:${PRODUCT_WORDS.join("|")})\\b`,
  "i",
);

/**
 * Predicate form: "the shirt is black", "hoodies should be navy", "tees in
 * white", "make the shirt color forest green". Requires the linking word —
 * mere proximity would also match "black t-shirt with a red MR2", where
 * the second color plainly belongs to the car.
 */
const PRODUCT_BEFORE_COLOR = new RegExp(
  `\\b(?:${PRODUCT_WORDS.join("|")})\\b\\s+(?:colou?rs?\\s+)?(?:(?:is|are|should|shall|will|must|needs?\\s+to)\\s+)?(?:be\\s+)?(?:in\\s+)?$`,
  "i",
);

/**
 * Whether a color actually modifies the garment, rather than merely
 * sharing a clause with it. "black Labrador on a gray hoodie" names one
 * garment color, and it is not the first color in the sentence — the
 * Labrador's black is an attribute of the subject.
 */
function colorModifiesTheProduct(clause: string, color: string): boolean {
  const index = clause.toLowerCase().indexOf(color.toLowerCase());
  if (index < 0) return true;

  if (PRODUCT_BEFORE_COLOR.test(clause.slice(0, index))) return true;
  return PRODUCT_AFTER_COLOR.test(clause.slice(index + color.length));
}

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
  /\b(actually|instead|change (?:it|that|the \w+)? ?to|forgot|forget|no longer|scratch that|don'?t print|do not print|shouldn'?t appear|should not appear|remove|only use|just use|use the words?|i meant|not the whole (?:sentence|thing|phrase))\b/i;

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

/**
 * A generic 1-3 word descriptor ("boat", "dog", "boat's", "little dog") —
 * not a closed noun list. Used everywhere a naming cue ("name", "called",
 * "named") already does the real anchoring work, so the descriptor itself
 * doesn't need to be a recognized noun (Live Acceptance Corrective Pass,
 * Section 1/13): "the boat is named GLORIOUS" and "RUFUS, that's my dog's
 * name" work the same way "our team is called My 3 Sons" always has,
 * without a per-domain noun added for every new example. `ENTITY_NOUNS`
 * remains reserved for the ONE pattern below that has no such literal
 * naming-cue anchor and therefore genuinely needs the extra precision.
 */
// Excludes common function words from matching as a descriptor word — not
// a domain noun list, just closed-class grammar words ("is", "the",
// "which", ...) that can never themselves be what something is named
// after. Without this, a generic (non-noun-gated) descriptor is too loose:
// "which is the name of the boat" would otherwise let "is the" itself
// match as the "descriptor" before a literal "name", producing nonsense.
const DESCRIPTOR_STOPWORD_EXCLUSION =
  "(?!(?:is|the|a|an|that|which|who|of|and|or|but|not|this|it|are|was|were)\\b)";
const GENERIC_DESCRIPTOR_WORD = `${DESCRIPTOR_STOPWORD_EXCLUSION}[a-z][a-z'’]*`;
const GENERIC_DESCRIPTOR = `${GENERIC_DESCRIPTOR_WORD}(?:\\s+${GENERIC_DESCRIPTOR_WORD}){0,2}`;

// Tried in order; the first match wins. Ordered most-specific ("name is X")
// before the bare "name X" variant so "team name is My 3 Sons" never
// captures the leading "is" as part of the name.
const ENTITY_NAME_PATTERNS: RegExp[] = [
  new RegExp(`\\b${GENERIC_DESCRIPTOR}(?:'s)?\\s+name\\s+is\\s+([^.,;!?\\n]+)`, "i"),
  new RegExp(`\\b${GENERIC_DESCRIPTOR}\\s+(?:is\\s+)?(?:called|named)\\s+([^.,;!?\\n]+)`, "i"),
  new RegExp(`\\b${GENERIC_DESCRIPTOR}\\s+name\\s*[:\\-]?\\s+([^.,;!?\\n]+)`, "i"),
  // Sprint 2G Live Acceptance Corrective Pass: "the name of the <descriptor>
  // is X" — the descriptor follows "name of", entity follows the second
  // "is". Generic, same as the patterns above.
  new RegExp(
    `\\bname\\s+of\\s+(?:the|our|my)\\s+${GENERIC_DESCRIPTOR}\\s+is\\s+([^.,;!?\\n]+)`,
    "i",
  ),
  // Deliberately noun-gated (unlike every other pattern here): with no
  // literal "name"/"called"/"named" cue to anchor it, a fully generic
  // descriptor would false-positive on almost any "our/the X is Y"
  // sentence ("our design is complete"). Allows up to two descriptor words
  // between "our"/"the" and the entity noun ("our softball team is...",
  // "our local school is...") — the greedy `{0,2}` still resolves
  // correctly because what follows must be one of the specific
  // `ENTITY_NOUNS`, so the engine backtracks to whatever descriptor count
  // actually lines up.
  new RegExp(`\\b(?:our|the)\\s+(?:\\w+\\s+){0,2}(?:${ENTITY_NOUNS})\\s+is\\s+([^.,;!?\\n]+)`, "i"),
  /\bcall\s+it\s+([^.,;!?\n]+)/i,
];

/**
 * Sprint 2L Phase 1C: a punctuation-free run-on message ("our team is
 * called My 3 Sons help me create a design for team t-shirts") has no
 * comma/period for `[^.,;!?\n]+` to stop at, so an `ENTITY_NAME_PATTERNS`
 * capture can run all the way to the end of the string, silently pulling
 * an unrelated following clause into what should have been just the
 * entity's name.
 *
 * General fix, not message-specific: a small set of clause-continuation
 * markers — a bare imperative ("help", "please"), a new subject + verb
 * ("and I need", "we're making"), or a new question ("can you...") — never
 * legitimately appear *inside* a team/company/event name, so the first
 * occurrence of one of these terminates the capture early, exactly like a
 * comma would if the customer had typed one. Deliberately narrow (e.g.
 * bare "and" alone does NOT trigger this — "Smith and Sons" must survive
 * intact) so it only fires on an actual new clause, not a normal
 * conjunction inside a real name.
 */
const CLAUSE_BOUNDARY_PATTERN =
  /\b(?:help|please|let'?s|so\s+(?:i|we)\b|and\s+(?:i|we|you)\b|can\s+you\b|could\s+you\b|would\s+you\b|will\s+you\b|i\s+(?:need|want)\b|we\s+(?:need|want)\b|we(?:'re|\s+are)\b|you\s+(?:choose|decide|can)\b)/i;

function boundEntityCapture(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(CLAUSE_BOUNDARY_PATTERN);
  if (!match || match.index === undefined) return trimmed;
  return trimmed.slice(0, match.index).trim();
}

/**
 * Sprint 2M Phase 2G (Goal 1), generalized further in the Live Acceptance
 * Corrective Pass (Section 1/13): the *reversed* naming shape — the entity
 * comes before the naming cue ("GLORIOUS is the boat name") rather than
 * after it ("the boat name is GLORIOUS" / "our team is called GLORIOUS",
 * already covered by `ENTITY_NAME_PATTERNS` above). Structural, not a
 * per-domain noun list: any descriptor before "name"/"title" works, so
 * this generalizes to boat/dog/event/company/band/product names alike
 * without an ever-growing keyword blacklist.
 *
 * The connector between entity and naming cue accepts either a plain "is"
 * or an appositive/relative-clause form — "X, which is the boat name",
 * "X which is the name of the boat" (no comma), "X — that's the company
 * name" — all of which are the same grammatical relationship a customer
 * expresses in ordinary speech, not a fixed phrase.
 */
const ENTITY_NAME_CONNECTOR =
  "(?:is|,?\\s*which\\s+is|,?\\s*that'?s|—\\s*that'?s|--\\s*that'?s)\\s+";

const REVERSED_ENTITY_NAME_PATTERN = new RegExp(
  `(?:^|[.!?;]\\s*)([^.,;!?\\n—]+?)\\s*${ENTITY_NAME_CONNECTOR}(?:the|our|my)\\s+${GENERIC_DESCRIPTOR}\\s+(?:name|title)\\b`,
  "i",
);

/**
 * The "name of the <descriptor>" order — "GLORIOUS is the name of the
 * boat" / "GLORIOUS which is the name of the boat". Same connector, same
 * generic descriptor, entity/descriptor order swapped relative to
 * `REVERSED_ENTITY_NAME_PATTERN`.
 */
const REVERSED_NAME_OF_PATTERN = new RegExp(
  `(?:^|[.!?;]\\s*)([^.,;!?\\n—]+?)\\s*${ENTITY_NAME_CONNECTOR}(?:the\\s+)?name\\s+of\\s+(?:the|our|my)\\s+${GENERIC_DESCRIPTOR}\\b`,
  "i",
);

/**
 * A subject that refers back to the wording/text itself ("the wording is
 * the boat name shouldn't appear...") is talking ABOUT the required
 * wording, not providing a new one — must never be captured as the entity.
 */
const SELF_REFERENTIAL_SUBJECT_PATTERN =
  /^(?:the\s+)?(?:wording|text|name|title|it|this|that|the\s+design|the\s+artwork)\b/i;

/**
 * Live Acceptance Corrective Pass (Section 1/13): a bare imperative naming
 * instruction — "Use GLORIOUS", "Put ACME on it", "Print SOFIA" — the
 * entity is a short run of Capitalized/ALL-CAPS tokens immediately after a
 * small, generic set of instruction verbs a customer naturally uses to say
 * "this exact text." Deliberately typographic (capitalization signals
 * literal text) rather than domain-specific — works identically for a
 * boat, a dog, a company, or a person's name, and never fires on an
 * ordinary lowercase instruction ("use white and red") that belongs to a
 * different field entirely.
 */
// Note: deliberately NOT case-insensitive overall — the capture group's
// `[A-Z]` requirement (real, literal capitalization signaling "this is
// exact text") must stay case-SENSITIVE, so the verb alternative spells
// out both a sentence-initial-capitalized and a lowercase form instead of
// using the `/i` flag (which would also make the capture accept lowercase
// words like "white" in "use white and red", defeating the whole point).
const BARE_IMPERATIVE_ENTITY_PATTERN =
  /\b(?:[Uu]se|[Pp]ut|[Pp]rint|[Ww]rite)\s+((?:[A-Z][A-Za-z0-9'’]*\s*){1,4})/;

function extractReversedEntityName(positiveText: string): string | null {
  const match =
    positiveText.match(REVERSED_ENTITY_NAME_PATTERN) ??
    positiveText.match(REVERSED_NAME_OF_PATTERN);
  const entity = match?.[1]?.trim();
  if (!entity) return null;
  if (SELF_REFERENTIAL_SUBJECT_PATTERN.test(entity)) return null;
  return boundEntityCapture(entity) || null;
}

/**
 * If a captured cue phrase ("use the word X", "I meant X") itself has the
 * "<entity> is the <descriptor> name" shape, reduce it down to just the
 * entity — "I meant GLORIOUS is the boat name" resolves to GLORIOUS, not
 * the whole explanatory sentence. A no-op for an ordinary literal phrase
 * that doesn't have that shape.
 */
function reduceEntityNameSentence(phrase: string): string {
  return extractReversedEntityName(phrase) ?? phrase;
}

/* ------------------------------------------------------------------ */
/* Removal / exclusion corrections (Sprint 2M Phase 2G, Goal 2) —       */
/* "don't print X", "X shouldn't appear", "remove X" register as an     */
/* explicit correction updating exclusions, never silently falling      */
/* through to additionalNotes.                                          */
/* ------------------------------------------------------------------ */

const REMOVAL_TARGET_AFTER_CUE =
  /\b(?:don'?t print|do not print|please remove|remove|exclude|leave out|take out)\s+(?:the\s+)?(?:phrase\s+|words?\s+)?"?([^".!?\n]+?)"?(?=[,.;!?]|$)/i;
const REMOVAL_TARGET_BEFORE_CUE =
  /"?([^".!?\n]+?)"?\s+(?:shouldn'?t|should\s+not)\s+appear\b/i;
const REMOVAL_CUE_BEFORE_QUOTE_PATTERN =
  /\b(?:don'?t print|do not print|please remove|remove|exclude|leave out|take out)\s*$/i;

/**
 * A quoted phrase immediately preceded by a removal cue ("don't print
 * 'X'") names what to EXCLUDE, not literal required wording — the generic
 * quote-priority rule in `extractRequiredWording` must skip that specific
 * span so a later "use the word Y" cue in the same message still wins.
 */
function isQuotedRemovalTarget(text: string, matchIndex: number | undefined): boolean {
  if (matchIndex === undefined) return false;
  return REMOVAL_CUE_BEFORE_QUOTE_PATTERN.test(text.slice(0, matchIndex));
}

/** Strips a leading self-reference so "the wording is the boat name" reduces to "the boat name". */
function stripSelfReferentialPrefix(phrase: string): string {
  return phrase.replace(/^(?:the\s+)?(?:wording|text)\s+is\s+/i, "").trim();
}

function extractRemovalCorrection(trimmed: string): string | null {
  const match =
    trimmed.match(REMOVAL_TARGET_BEFORE_CUE) ?? trimmed.match(REMOVAL_TARGET_AFTER_CUE);
  const target = match?.[1]?.trim();
  if (!target) return null;
  const cleaned = stripSelfReferentialPrefix(target);
  return cleaned || null;
}

/**
 * Sprint 2M Phase 2G (Goal 2): a design-change imperative in the post-
 * selection revision loop that no dedicated field extractor recognized —
 * generic verbs only, never a per-domain noun list.
 */
const DESIGN_CHANGE_IMPERATIVE_PATTERN =
  /\b(?:make|change|remove|add|increase|decrease|enlarge|shrink|move|replace|swap|update|adjust|resize)\b/i;

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
  // choose the print placement" said out of nowhere; also, since Sprint 2L
  // Phase 1B, the ordinary case for an optional-tier section like colors,
  // which is never itself the pending section).
  //
  // An explicit section mention always wins over the ambient pending
  // section when they disagree — "No preference, choose whatever colors
  // work best." must defer *colors*, not whatever unrelated section
  // happens to be pending at that moment (e.g. print location), even
  // though the reply also reads as a generic deferral phrase.
  const mentionedDeferral = detectMentionedDeferral(trimmed);
  const pendingDeferral =
    context.pendingSection &&
    isDeferrable(context.pendingSection) &&
    isDeferralReply(trimmed)
      ? context.pendingSection
      : null;
  const deferredTarget = mentionedDeferral ?? pendingDeferral;

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

  // Sprint 2M Phase 2G (Goal 2): "don't print X" / "X shouldn't appear" /
  // "remove X" register as an explicit exclusion, independent of (and
  // additive to) the "avoid/without/no X" phrasing `extractExclusions`
  // already handles above.
  const removalNote = extractRemovalCorrection(trimmed);
  if (removalNote) {
    fields.exclusions = appendNote(
      fields.exclusions ?? context.brief.exclusions,
      `No ${removalNote}`,
    );
  }

  const audiencePurpose = extractAudiencePurpose(positiveText);
  if (audiencePurpose.audience) fields.audience = audiencePurpose.audience;
  if (audiencePurpose.purpose) fields.purpose = audiencePurpose.purpose;

  applyPendingSectionFallback(context, trimmed, fields);

  // Sprint 2M Phase 2G (Goal 2): in the post-selection revision loop, an
  // explicit design-change imperative no dedicated extractor recognized
  // must still land somewhere concept-relevant (`designDescription`) —
  // never silently in `additionalInstructions`, which is invisible to
  // concept-relevance/regeneration and produced the live "Got it — I've
  // updated the notes." bug for a real visual revision request.
  if (
    Object.keys(fields).length === 0 &&
    context.isPostSelectionRevision &&
    DESIGN_CHANGE_IMPERATIVE_PATTERN.test(trimmed) &&
    wordCount(trimmed) > 1
  ) {
    fields.designDescription = appendNote(context.brief.designDescription, trimmed);
  }

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

  // Sprint 2M Phase 2G (Goal 2): a quoted phrase right after a removal cue
  // ("don't print 'is the boat name'") names what to EXCLUDE, not the
  // literal wording — skip the generic quote-priority rule for that span so
  // a later "use the word X"/"I meant X" cue in the same message still wins.
  //
  // The single-quote alternative requires the opening `'` NOT be preceded
  // by a letter — otherwise a contraction apostrophe elsewhere in the same
  // message ("don't", "I'm", "shouldn't") is itself treated as an opening
  // quote, and everything up to the next real `'` (e.g. the genuine quoted
  // phrase later in the sentence) is captured as garbage.
  const quoted = trimmed.match(/"([^"]+)"|(?<![a-zA-Z])'([^']+)'/);
  if (quoted && !isQuotedRemovalTarget(trimmed, quoted.index)) {
    return (quoted[1] ?? quoted[2] ?? "").trim();
  }

  const cued = positiveText.match(
    /\b(?:say|should say|it should say|the text is|wording should be|should read|print the words?|change (?:the )?(?:wording|text) to|use the words?|only use|just use|i meant)\s*[:\-]?\s*"?([^".!?\n]+)"?/i,
  );
  if (cued?.[1]?.trim()) {
    const bounded = boundEntityCapture(cued[1]);
    if (bounded) return reduceEntityNameSentence(bounded);
  }

  // Live Acceptance Corrective Pass (Section 1/13): a bare imperative
  // naming instruction ("Use GLORIOUS", "Put ACME on it") — checked ahead
  // of the entity-naming patterns below since it is the most explicit
  // signal available (typographic capitalization, not just grammar).
  const imperative = positiveText.match(BARE_IMPERATIVE_ENTITY_PATTERN);
  if (imperative?.[1]?.trim()) {
    const bounded = boundEntityCapture(imperative[1]);
    if (bounded) return bounded;
  }

  // Explicit team/company/event/organization names — "our team is called My
  // 3 Sons", "the team name is My 3 Sons", "call it My 3 Sons". These are
  // required wording just as much as an explicit "it should say" cue; a
  // print shop treats a team/company/event name the customer gives as text
  // that must appear on the design. `boundEntityCapture` protects against a
  // punctuation-free run-on sentence carrying an unrelated trailing clause
  // into the name — see its doc comment.
  for (const pattern of ENTITY_NAME_PATTERNS) {
    const match = positiveText.match(pattern);
    if (match?.[1]?.trim()) {
      const bounded = boundEntityCapture(match[1]);
      if (bounded) return bounded;
    }
  }

  // Sprint 2M Phase 2G (Goal 1): the reversed shape — "<entity> is the
  // <descriptor> name/title" — e.g. "GLORIOUS is the boat name".
  const reversed = extractReversedEntityName(positiveText);
  if (reversed) return reversed;

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Colors — clause-scoped context decides product vs. artwork color.    */
/* ------------------------------------------------------------------ */

/**
 * Distance (in characters) from `position` to the nearest match of
 * `pattern` in `text`, or `null` if `pattern` doesn't match at all.
 * Generic proximity helper — used to decide which nearby noun a color
 * word most plausibly modifies (see `extractColors`).
 */
function nearestPatternDistance(text: string, pattern: RegExp, position: number): number | null {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let nearest: number | null = null;
  for (const match of text.matchAll(globalPattern)) {
    if (match.index === undefined) continue;
    const distance = Math.abs(match.index - position);
    if (nearest === null || distance < nearest) nearest = distance;
  }
  return nearest;
}

/**
 * Whether a color that is not the garment's color is a statement about the
 * ARTWORK'S PALETTE rather than an attribute of whatever the artwork
 * depicts. Live acceptance found "create a design of a red 1988 Toyota
 * MR2" storing Preferred Colors = Red: the clause mentions "design", so
 * every color in it was credited to the palette, and the customer was
 * later shown a palette preference they never expressed. The car's color
 * is not a palette preference — it is part of the subject, and the design
 * description is where it belongs.
 *
 * Nothing is lost by returning false: the same words are captured by
 * `extractGraphics` into the design description.
 */
function colorStatesAPalettePreference(clause: string, color: string): boolean {
  if (PALETTE_CUE_PATTERN.test(clause)) return true;

  const index = clause.toLowerCase().indexOf(color.toLowerCase());
  if (index < 0) return true;

  if (DESIGN_ELEMENT_BEFORE_COLOR.test(clause.slice(0, index))) return true;
  return DESIGN_ELEMENT_AFTER_COLOR.test(clause.slice(index + color.length));
}

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

    const palette = (color: string) => {
      if (colorStatesAPalettePreference(clause, color)) artworkColors.push(color);
    };

    if (hasProductWord && !hasDesignWord) {
      for (const color of colorsInClause) {
        if (!colorModifiesTheProduct(clause, color)) {
          palette(color);
          continue;
        }
        // A second color that also modifies the garment ("red and gold
        // tees") is a real customer statement with only one field to
        // land in — kept, as before, rather than dropped.
        if (productColor === null) productColor = color;
        else artworkColors.push(color);
      }
    } else if (hasDesignWord && !hasProductWord) {
      for (const color of colorsInClause) palette(color);
    } else if (hasProductWord && hasDesignWord) {
      // Both a product word ("shirt") and a design/artwork word ("design")
      // appear in the same clause — the earlier "first color always wins
      // the product" rule mis-attributed a color that plainly belongs to
      // the design's own subject (e.g. "a t-shirt design of my Red 1988
      // Toyota MR2" is not a red shirt). General fix, not a car-specific
      // one: attribute each color by which word it sits textually closer
      // to — the same signal a human reader uses — so a color near
      // "design"/"artwork" is credited to the artwork, not the garment.
      for (const color of colorsInClause) {
        const colorIndex = clause.toLowerCase().indexOf(color.toLowerCase());
        const productDistance = nearestPatternDistance(clause, PRODUCT_PATTERN, colorIndex);
        const designDistance = nearestPatternDistance(clause, DESIGN_CONTEXT_PATTERN, colorIndex);
        const closerToProduct =
          productDistance !== null &&
          (designDistance === null || productDistance <= designDistance);
        if (closerToProduct && productColor === null) {
          productColor = color;
        } else {
          palette(color);
        }
      }
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

/**
 * Cue phrases that introduce the subject/content of the artwork itself,
 * generalized (Live Acceptance Corrective Pass, Section 1) beyond the
 * original "with/featuring/showing/depicting" set to also cover the
 * "the design is X" / "it shows X" shape customers use when correcting a
 * design description mid-conversation. Anchoring the capture at the cue
 * phrase — rather than taking the whole raw message — is what keeps an
 * unrelated leading clause (e.g. a garment-color correction) out of the
 * captured design content: "the color of the shirt is black, the design
 * is my Red 1988 Toyota MR2" captures only "my Red 1988 Toyota MR2", not
 * the garment-color clause that precedes it. Not domain-specific — the
 * cue set is generic phrasing, not a car/vehicle keyword list.
 */
const GRAPHICS_CUE_PATTERN =
  /\b(?:with|featuring|showing|depicting|the design is|design is|it shows|it should show|(?:design|artwork|graphic|image|picture|photo|drawing|illustration)s?\s+of)\s+(?:a |an |some |my |our )?([^.!?]+)/i;

/**
 * A trailing "on a navy shirt" names the garment, not the artwork — the
 * design description must not absorb it (and `extractColors` has already
 * read the garment color out of it).
 */
const TRAILING_GARMENT_PHRASE = new RegExp(
  `\\s+(?:on|onto)\\s+(?:a |an |the |some )?(?:\\w+\\s+){0,2}(?:${PRODUCT_WORDS.join("|")})\\s*$`,
  "i",
);

/**
 * The "with" cue normally introduces the artwork ("a black t-shirt WITH a
 * red MR2"), but in "red roses with gold lettering" the subject comes
 * FIRST and anchoring at the cue would drop it — losing the roses, and
 * with them the only record that they are red. Distinguished generally,
 * not per-phrase: anchor at the cue only when the text before it is about
 * the product or the design artifact, which is what makes the cue an
 * introduction rather than a continuation.
 */
function graphicsCaptureStart(positiveText: string, match: RegExpMatchArray): number {
  const cueIndex = match.index ?? 0;
  if (cueIndex === 0) return -1;

  const before = positiveText.slice(0, cueIndex);
  if (!/^with\b/i.test(match[0])) return -1;
  if (PRODUCT_PATTERN.test(before) || DESIGN_CONTEXT_PATTERN.test(before)) return -1;
  return 0;
}

/** An instruction about the printing, not a description of the artwork. */
const LEADING_IMPERATIVE = /^(?:please\s+)?(?:print|put|place|use|make|do|send|order)\b/i;

/**
 * No cue phrase, but the sentence still names the subject: "black Labrador
 * on a gray hoodie" is a design description followed by the garment. This
 * matters beyond tidiness — the subject's own color is deliberately kept
 * out of the palette, so if the subject itself were dropped here, the
 * customer's "black" would vanish from the brief entirely.
 */
function subjectBeforeGarmentPhrase(positiveText: string): string | null {
  const clause = positiveText.split(/[.!?]/)[0]?.trim() ?? "";
  if (!TRAILING_GARMENT_PHRASE.test(clause)) return null;
  if (LEADING_IMPERATIVE.test(clause)) return null;

  const subject = clause.replace(TRAILING_GARMENT_PHRASE, "").trim();
  // A short noun phrase is a design subject; a run-on sentence that
  // happens to end in a garment is a whole conversation opener, and
  // storing it verbatim as the design description is exactly the
  // over-capture this fallback must not reintroduce.
  if (wordCount(subject) < 2 || wordCount(subject) > 8) return null;
  if (PRODUCT_PATTERN.test(subject)) return null;
  return subject;
}

function extractGraphics(positiveText: string): string | null {
  const match = positiveText.match(GRAPHICS_CUE_PATTERN);
  if (!match?.[1]?.trim()) return subjectBeforeGarmentPhrase(positiveText);

  const start = graphicsCaptureStart(positiveText, match);
  const captured =
    start < 0
      ? boundEntityCapture(match[1])
      : positiveText.slice(start).split(/[.!?]/)[0]?.trim() ?? "";

  return captured.replace(TRAILING_GARMENT_PHRASE, "").trim() || null;
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

// Live Acceptance Corrective Pass (canonical product): the product word
// sitting at the very END of the clause, nothing trailing it, is the
// structural signal for "this clause IS a product name" — true whether or
// not its leading qualifier is a recognized color/style word ("Camp
// shirts" survives intact even though "Camp" isn't in
// `PRODUCT_DESCRIPTOR_WORDS`). A product word with something trailing it
// ("t-shirt design", "T-shirt for the school fair") means the clause is
// describing something else — an action, a purpose, a sentence — that
// merely mentions the product in passing, and must be tightened instead.
const PRODUCT_WORD_AT_END_PATTERN = new RegExp(
  `(?:${PRODUCT_WORDS.join("|")})\\s*$`,
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

  // Live Acceptance Corrective Pass (canonical product): a reply that is a
  // SINGLE clause shaped like "<qualifier> <product word>" with nothing
  // trailing the product word — "Camp shirts", "black hoodies", "vintage
  // tees" — is the customer's one direct answer and is kept exactly as
  // written, even when the qualifier isn't a recognized color/style word
  // (Sprint 1 parity, refined). Both conditions matter: a reply with
  // MULTIPLE clauses ("Tony's Pizza crew shirts, old-school pizzeria
  // look.") still gets tightened even though its product clause also ends
  // in the product word — the comma is real evidence the customer said
  // more than just the product name, the same signal that already
  // separates the product clause from an unrelated one elsewhere in this
  // function. Anything else — the product word buried inside a longer
  // sentence, an action ("lets create a t-shirt design"), or a trailing
  // purpose clause ("a T-shirt for the school fair") — is tightened down
  // to the short descriptor+noun phrase around the product word instead,
  // so customer-facing questions and the Design Summary never derive from
  // a grammatically-assembled fragment of the customer's own sentence
  // structure. Falls back to the full clause only when the phrase pattern
  // genuinely finds no product word inside it (defensive; PRODUCT_PATTERN
  // already matched somewhere in the text).
  if (clauses.length <= 1 && PRODUCT_WORD_AT_END_PATTERN.test(clause)) return clause;
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
  // "just a design" answers the question with the artifact, not the thing
  // it prints on — the product genuinely stays unknown, and asking again
  // is better than recording the word "Design" as a product.
  return namesAPrintProduct(text);
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
      fields.productSummary = normalizeProductAnswer(
        stripDesignArtifactWords(trimmed),
      );
      return;
    case "graphics":
      // General quality boundary (mirrors "product"/"audience" above,
      // Live Acceptance Corrective Pass Section 1): a reply that already
      // resolved a *different* structured field this turn — the garment
      // color, a different product, or print placement — is a multi-topic
      // message, not a clean single-topic design description. Storing the
      // whole raw sentence verbatim would silently fold that other topic's
      // own wording into the design content too (e.g. a garment-color
      // correction bundled with the design subject in one sentence).
      // `extractGraphics` (cue-anchored, checked earlier and already
      // reflected in `fields` when it matches) is the one path allowed to
      // isolate just the design-relevant portion of such a message; this
      // verbatim fallback only ever applies to a genuinely single-topic
      // reply where nothing else claimed part of the sentence.
      if (
        fields.shirtColor !== undefined ||
        fields.productSummary !== undefined ||
        fields.printPlacement !== undefined
      ) {
        return;
      }
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
