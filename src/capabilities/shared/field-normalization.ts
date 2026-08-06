/**
 * Sprint 2K Phase 3 — Goal 2: deterministic, field-aware normalization.
 *
 * Customer language stays available where it matters — conversation
 * history is untouched, and required wording is never rewritten (see
 * `checkRequiredWordingQuality` / `deriveRequiredWording`, which this module
 * deliberately does not touch). What this module normalizes is the *value*
 * a structured Design Brief field stores for fields where a canonical form
 * genuinely helps: "tshirts" reads the same as "T-shirt" to a print shop,
 * but only one of those belongs in a customer-facing Design Summary.
 *
 * Every rule here is a plain lookup or capitalization pass over the text
 * itself — no LLM, fully deterministic, safe to call on every extraction.
 * A value that doesn't match a known synonym is left exactly as the
 * customer wrote it, never rewritten or guessed at — this module fixes
 * casing/wording only for short, value-shaped answers, never for a full
 * sentence a customer happened to give in reply (extraction already
 * decides, separately, when a whole sentence is appropriate to keep
 * verbatim — see extraction.ts's "Sprint 1 parity" comment on
 * `extractProduct`).
 */

/** A short reply worth canonicalizing, not a sentence to be preserved verbatim. */
const MAX_NORMALIZABLE_WORDS = 4;

function isShortValue(text: string): boolean {
  return text.split(/\s+/).filter(Boolean).length <= MAX_NORMALIZABLE_WORDS;
}

const PRODUCT_NOUN_CANONICAL: Record<string, string> = {
  tshirt: "T-shirt",
  tshirts: "T-shirt",
  "t-shirt": "T-shirt",
  "t-shirts": "T-shirt",
  tee: "T-shirt",
  tees: "T-shirt",
  shirt: "T-shirt",
  shirts: "T-shirt",
  hoodie: "Hoodie",
  hoodies: "Hoodie",
  sweatshirt: "Sweatshirt",
  sweatshirts: "Sweatshirt",
  tank: "Tank top",
  tanks: "Tank top",
  "tank top": "Tank top",
  "tank tops": "Tank top",
  "long sleeve": "Long sleeve shirt",
  "long sleeves": "Long sleeve shirt",
  crewneck: "Crewneck",
  crewnecks: "Crewneck",
  polo: "Polo",
  polos: "Polo",
  jersey: "Jersey",
  jerseys: "Jersey",
  cap: "Cap",
  caps: "Cap",
  hat: "Hat",
  hats: "Hat",
};

/** Title-cases every word, preserving internal hyphens as-is. */
function titleCaseWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("-")
        .map((part) =>
          part.length > 0 ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part,
        )
        .join("-"),
    )
    .join(" ");
}

/**
 * Normalizes a customer product answer to a canonical, print-shop-facing
 * name. "tshirts" / "t-shirts" / "tees" all become "T-shirt". A short
 * phrase this module doesn't recognize (e.g. it carries extra descriptor
 * words, like "vintage hoodies") is Title Cased rather than rewritten, so
 * nothing is silently dropped. A longer, sentence-shaped reply — the
 * "kept exactly as written" case `extractProduct` explicitly preserves —
 * is left completely untouched; casing a whole sentence would make it read
 * worse, not better.
 */
export function normalizeProductAnswer(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const key = trimmed.toLowerCase().replace(/\s+/g, " ");
  const canonical = PRODUCT_NOUN_CANONICAL[key];
  if (canonical) return canonical;
  return isShortValue(trimmed) ? titleCaseWords(trimmed) : trimmed;
}

/**
 * Normalizes a color name for display — "black" → "Black", "heather grey" →
 * "Heather Grey". Never used for a deferral/negative answer; callers must
 * route "no preference"-shaped replies through the deferral path instead
 * (see `DEFERRAL_PATTERNS` in intent-extraction). A longer, sentence-shaped
 * reply is left untouched rather than Title Cased word-for-word.
 */
export function normalizeColorAnswer(raw: string): string {
  const trimmed = raw.trim();
  return isShortValue(trimmed) ? titleCaseWords(trimmed) : trimmed;
}

/** Capitalizes only the first letter — used for short plain-language labels
 * (e.g. print placement: "full back" → "Full back") where every word does
 * not need its own capital. */
export function capitalizeFirst(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

/**
 * Normalizes a style descriptor list for display — each comma-separated
 * term gets its first letter capitalized ("retro, hand-drawn" → "Retro,
 * Hand-drawn"). Internal hyphenation is preserved.
 */
export function normalizeStyleAnswer(raw: string): string {
  return raw
    .split(",")
    .map((term) => capitalizeFirst(term.trim()))
    .filter(Boolean)
    .join(", ");
}
