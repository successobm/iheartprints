/**
 * What counts as a PRINT PRODUCT, as opposed to the artwork printed on it.
 *
 * Live acceptance found "create a design of a red 1988 Toyota MR2" storing
 * Product = "Design", which then produced the question "What color Designs
 * will these print on?". The two extraction layers disagreed about what a
 * product is: the deterministic extractor already classifies "design" /
 * "artwork" / "graphic" as design-context words that are explicitly NOT
 * products, while the semantic layer's grounding check accepted any value
 * literally present in its own evidence — and "design" is present in
 * "create a design". Nothing reconciled the two.
 *
 * This module is the single shared answer, kept deliberately as a deny-list
 * rather than an allow-list of products: a print shop prints on banners,
 * signs, tote bags, mugs and things not yet thought of, so the rule cannot
 * be "must be one of these". What it can say confidently is that a word
 * naming the ARTIFACT BEING DESIGNED never identifies the product it will
 * be printed on.
 */

import { PRODUCT_NOUN_CANONICAL, normalizeProductAnswer } from "./field-normalization";

/**
 * Words for the thing being created rather than the thing printed on.
 * Deliberately generic — "make a design of my dog", "create artwork of our
 * building", "make a graphic of a red Corvette" and "design something with
 * our logo" must all leave the product unresolved, with no per-subject
 * special cases.
 */
const DESIGN_ARTIFACT_WORDS = new Set([
  "design",
  "designs",
  "artwork",
  "art",
  "graphic",
  "graphics",
  "image",
  "images",
  "imagery",
  "picture",
  "pictures",
  "photo",
  "photos",
  "drawing",
  "drawings",
  "illustration",
  "illustrations",
  "sketch",
  "logo",
  "logos",
  "concept",
  "concepts",
  "mockup",
  "something",
  "anything",
  "thing",
]);

/** Articles and vague qualifiers that never carry the product noun themselves. */
const QUALIFIER_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "our",
  "your",
  "some",
  "custom",
  "new",
  "cool",
  "nice",
  "simple",
  "awesome",
  "great",
]);

/** A question may only interpolate a product this short — longer values read as a sentence. */
const MAX_QUESTION_PRODUCT_WORDS = 3;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu, ""))
    .filter(Boolean);
}

function withoutWords(value: string, ...vocabularies: Array<Set<string>>): string {
  return value
    .trim()
    .split(/\s+/)
    .filter((word) => {
      const normalized = word
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu, "");
      return !vocabularies.some((vocabulary) => vocabulary.has(normalized));
    })
    .join(" ")
    .trim();
}

/**
 * Removes only the design-artifact words from a proposed product, leaving
 * whatever actually names a printable product — "t-shirt design" →
 * "t-shirt", "graphic tee" → "tee" — while leaving the customer's own
 * descriptive wording ("custom tote bags") and products this module has
 * never heard of ("yard sign") completely untouched.
 */
export function stripDesignArtifactWords(value: string): string {
  return withoutWords(value, DESIGN_ARTIFACT_WORDS);
}

/**
 * Whether a value identifies a print product at all. False for "design",
 * "artwork", "a graphic", "logo concept" and "custom design" — none of
 * which tell us what the artwork gets printed on — and true for any value
 * with a real noun left over, whether or not this codebase recognizes it.
 * Qualifiers are discounted for this judgement only, never removed from
 * the value itself: "custom" alone names nothing, but "custom tote bags"
 * is exactly how the customer described their product.
 */
export function namesAPrintProduct(value: string): boolean {
  return withoutWords(value, DESIGN_ARTIFACT_WORDS, QUALIFIER_WORDS).length > 0;
}

/**
 * The product name a customer-facing question may interpolate, or `null`
 * when the question must fall back to generic phrasing. Prefers the
 * canonical print-shop name so the sentence reads as written prose
 * ("What color T-shirt will you be printing on?") and refuses anything
 * that does not name a product or is long enough to be a sentence
 * fragment, so no raw customer text is ever grammatically inflected into
 * a question.
 */
export function productNameForQuestion(product: string | null | undefined): string | null {
  const raw = product?.trim() ?? "";
  if (!namesAPrintProduct(raw)) return null;
  const stripped = stripDesignArtifactWords(raw);
  if (!stripped) return null;

  const canonical = PRODUCT_NOUN_CANONICAL[tokenize(stripped).join(" ")];
  if (canonical) return canonical;

  if (tokenize(stripped).length > MAX_QUESTION_PRODUCT_WORDS) return null;
  return normalizeProductAnswer(stripped);
}
