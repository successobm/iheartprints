import {
  clauseBodySource,
  splitOnClauseBoundaries,
} from "@/lib/domain/clause-boundaries";
import { designContentTokens, stemToken } from "@/lib/domain/design-content-contract";

/**
 * Detailed-Description Fidelity (Phase 1), part A — the deterministic
 * backstop for Conversation Understanding's design synthesis.
 *
 * THE PROVEN FAILURE. In the Discovery Bay live acceptance audit the
 * customer described a lighthouse on the left, a T-shaped waterway, a
 * marina and its position, homes and their position, and three distinct
 * boat types. Conversation Understanding — correctly following its
 * instruction to produce "a short phrase a designer would actually write on
 * a brief" — returned roughly "A design featuring the Discovery Bay
 * California lighthouse, water shaped like a T, ski boats, cruiser boats,
 * and jet skis." Every position, the marina, and the homes were gone before
 * any image provider was ever called.
 *
 * The provider prompt has been strengthened (see
 * `openai-conversation-understanding-provider.ts`), but a prompt is a
 * request, not a guarantee, and a prompt cannot be regression-tested without
 * a paid network call. This module is the guarantee: given the synthesized
 * value and the customer's own message, it finds design-critical clauses
 * that did NOT survive and puts them back.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never appends the raw customer
 * message. Only clauses that (a) carry a position/shape/relationship or an
 * explicit enumeration of several subjects, (b) are not about the garment
 * color, the print placement, or the required wording, and (c) contain a
 * content word the synthesis genuinely lost, are restored. A faithful
 * synthesis is left byte-for-byte alone — which is the normal case, and the
 * reason a simple "I want a cool red race car" never grows an addendum.
 *
 * Generic by construction: position words, shape words, enumeration and
 * conversational filler are the only vocabulary. There are no Discovery
 * Bay, nautical, or other subject-specific patterns here, and none may be
 * added.
 */

/** Position/relationship words — the same structural vocabulary the content contract reads. */
const SPATIAL_TERM_PATTERN =
  /\b(?:left|right|top|bottom|upper|lower|above|below|beneath|underneath|behind|in front of|front of|foreground|background|backdrop|beside|alongside|next to|adjacent|between|around|surrounding|encircling|across|along|opposite|facing|toward|towards|centered|centred|centre|center|middle|corner|edge|either side|side|diagonal|diagonally|horizontal|vertical|north|south|east|west|overhead|on top of|flanking|framing)\b/i;

const SHAPE_TERM_PATTERN =
  /\b(?:[a-z]-shaped|[a-z] shape|shaped like|in the shape of|shape of|circular|rectangular|triangular|oval|arched|curved|winding|forming a|arranged in)\b/i;

/** "show/include/add/put/with …" — the customer explicitly asking for content. */
const INCLUSION_CUE_PATTERN =
  /\b(?:show|shows|showing|include|includes|including|add|adds|adding|feature|featuring|put|place|with|there(?:'s| is| are)|has|have)\b/i;

/**
 * A clause that is about the GARMENT rather than the artwork. "the color of
 * the shirt is black" must never be folded into the design description — the
 * exact contamination the audit warned about.
 */
const GARMENT_COLOR_CLAUSE_PATTERN =
  /\b(?:colou?r of the (?:shirt|tee|t-shirt|hoodie|garment|product)|(?:shirt|tee|t-shirt|hoodie|garment|product)\s+(?:colou?r|is)|on a .{0,20}(?:shirt|tee|t-shirt|hoodie|tank|garment))\b/i;

/**
 * A clause about WHERE ON THE PRODUCT it prints, not what the artwork shows.
 * Two shapes: stated with a printing verb, and the bare placement answer a
 * customer gives when asked ("left chest") — which would otherwise look like
 * a composition statement purely because it contains the word "left".
 */
const PRINT_PLACEMENT_CLAUSE_PATTERN = new RegExp(
  `\\b(?:print|printed|printing|placement)\\b${clauseBodySource(".")}{0,40}\\b(?:full front|full back|left chest|chest|sleeve|front|back)\\b`,
  "i",
);
const PLACEMENT_ONLY_CLAUSE_PATTERN =
  /^(?:on\s+)?(?:the\s+)?(?:full\s+front|full\s+back|left\s+chest|right\s+chest|chest|sleeve|front|back)$/i;

/**
 * A clause that STATES the required wording. Its literal text belongs to
 * `requiredWording` and nowhere else — re-injecting "Wording is Discovery
 * Bay California" into the design description would both duplicate it and
 * risk the phrase "Wording is" being drawn.
 */
const WORDING_CLAUSE_PATTERN =
  /\b(?:wording|the text|text is|it says|says|say|spelled?|spelling|lettering reads?|reads)\b/i;

/** A clause expressing a palette preference for the rendering, not content. */
const PALETTE_PREFERENCE_CLAUSE_PATTERN = new RegExp(
  `\\b(?:use|keep|stick to|palette)\\b${clauseBodySource(".")}{0,30}\\bcolou?rs?\\b`,
  "i",
);

/** A leading conversational/imperative wrapper that carries no design content. */
const LEADING_WRAPPER_PATTERN =
  /^(?:please\s+)?(?:i(?:'|’)?d?\s+(?:like|want)\s+|i\s+want\s+|we\s+want\s+|can\s+you\s+|could\s+you\s+|let'?s\s+|lets\s+)?(?:create|make|build|design|draw|generate|produce|do)\s+(?:me\s+)?(?:a|an|the)?\s*(?:design|artwork|graphic|image|picture|illustration|drawing|logo)?\s*(?:of|for|with|showing|featuring)?\s+/i;

/** Restoration is a backstop, not a transcript — bounded so it can never run away. */
const MAX_RESTORED_CLAUSES = 6;
const MAX_CLAUSE_LENGTH = 220;

/**
 * Returns `synthesis` unchanged when it already carries every design-critical
 * detail the customer stated; otherwise returns it with the lost clauses
 * appended in the customer's own words.
 */
export function preserveDesignDetail(
  synthesis: string,
  customerMessage: string | null | undefined,
): string {
  const base = (synthesis ?? "").trim();
  const message = (customerMessage ?? "").trim();
  if (!base || !message) return base;

  const covered = new Set(designContentTokens(base).map(stemToken));
  const restored: string[] = [];

  for (const clause of designCriticalClauses(message)) {
    if (restored.length >= MAX_RESTORED_CLAUSES) break;
    const tokens = designContentTokens(clause).map(stemToken);
    if (tokens.length === 0) continue;
    if (tokens.every((token) => covered.has(token))) continue;
    const cleaned = cleanClause(clause);
    if (!cleaned) continue;
    restored.push(cleaned);
    for (const token of tokens) covered.add(token);
  }

  if (restored.length === 0) return base;

  const head = /[.!?]$/.test(base) ? base : `${base}.`;
  return [head, ...restored.map(asSentence)].join(" ");
}

/**
 * Splits the message into the clauses worth checking.
 *
 * Sentences are the default unit, because a relationship ("homes behind the
 * lighthouse") only survives intact if the words stay together. A sentence
 * is sub-split on commas only when TWO OR MORE of the resulting parts each
 * state a position of their own — that is the shape of "lighthouse on the
 * left, marina on the right, homes behind the lighthouse", where every comma
 * really does introduce a separately positioned element. Two conditions this
 * deliberately does NOT split: an enumeration ("ski boats, cruiser boats and
 * jet skis"), which would shred into fragments that individually look like
 * nothing; and a sentence whose position words all sit in one phrase
 * ("Going straight, homes are on the left side"), where splitting would
 * discard the lead-in clause the position depends on.
 */
function designCriticalClauses(message: string): string[] {
  const clauses: string[] = [];
  for (const sentence of splitOnClauseBoundaries(message, ".!?;")) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const commaParts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
    const separatelyPositionedParts = commaParts.filter((part) =>
      SPATIAL_TERM_PATTERN.test(part),
    ).length;
    const units = separatelyPositionedParts >= 2 ? commaParts : [trimmed];
    for (const unit of units) {
      if (unit.length > MAX_CLAUSE_LENGTH) continue;
      if (!isDesignContentClause(unit)) continue;
      if (!carriesDesignCriticalStructure(unit)) continue;
      clauses.push(unit);
    }
  }
  return clauses;
}

/** Excludes the clause kinds that belong to a different Design Brief field. */
function isDesignContentClause(clause: string): boolean {
  if (WORDING_CLAUSE_PATTERN.test(clause)) return false;
  if (GARMENT_COLOR_CLAUSE_PATTERN.test(clause)) return false;
  if (PRINT_PLACEMENT_CLAUSE_PATTERN.test(clause)) return false;
  if (PLACEMENT_ONLY_CLAUSE_PATTERN.test(clause.trim())) return false;
  if (PALETTE_PREFERENCE_CLAUSE_PATTERN.test(clause)) return false;
  return true;
}

/**
 * The restoration trigger. A clause qualifies when it states a position or a
 * shape, or when it explicitly asks for several subjects at once — the two
 * categories the audit proved Conversation Understanding drops. A plain
 * restatement of a single subject does not qualify, so a faithful short
 * synthesis is never padded with the customer's original phrasing.
 */
function carriesDesignCriticalStructure(clause: string): boolean {
  if (SPATIAL_TERM_PATTERN.test(clause)) return true;
  if (SHAPE_TERM_PATTERN.test(clause)) return true;
  if (!INCLUSION_CUE_PATTERN.test(clause)) return false;
  return enumeratedSubjectCount(clause) >= 2;
}

/**
 * How many SHORT NOUN PHRASES a clause lists — "ski boats, cruiser boats and
 * jet skis" lists three.
 *
 * The word-count bound is what makes this an enumeration test rather than a
 * comma test. Without it, an ordinary conversational sentence ("this is a
 * take on the old sitcom my 3 sons, so i want a team logo but bowling
 * themed, with that retro vibe") reads as a three-item list purely because it
 * contains two commas, and its filler gets restored on top of a perfectly
 * faithful synthesis. A genuine list item is a noun phrase, not a clause.
 */
const MAX_ENUMERATED_ITEM_WORDS = 4;

function enumeratedSubjectCount(clause: string): number {
  return clause
    .split(/,|\band\b/i)
    .map((part) => part.trim())
    .filter(
      (part) =>
        designContentTokens(part).length > 0 &&
        part.split(/\s+/).filter(Boolean).length <= MAX_ENUMERATED_ITEM_WORDS,
    ).length;
}

function cleanClause(clause: string): string {
  const stripped = clause.replace(LEADING_WRAPPER_PATTERN, "").trim();
  const value = (stripped || clause).replace(/^(?:and|then|so|but)\s+/i, "").trim();
  return designContentTokens(value).length > 0 ? value : "";
}

function asSentence(clause: string): string {
  const capitalized = clause.charAt(0).toUpperCase() + clause.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
