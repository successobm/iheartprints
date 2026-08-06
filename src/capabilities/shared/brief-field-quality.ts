import type { PrintPlacement } from "@/lib/domain/types";

/**
 * Sprint 2K Phase 2 — Workstream B: deterministic, rule-based detection of
 * obviously malformed structured Design Brief data.
 *
 * The Design Interview's field extraction (Intent Extraction) is
 * conservative by design, but it is not the only way a field ever gets
 * written — and even a careful extractor can still be fed something a
 * customer clearly didn't mean as a clean field value. This module is a
 * second, independent layer: it never trusts that a field marked
 * "provided" is actually clean, and it never uses an AI/LLM judgment call —
 * every rule here is a plain, explainable heuristic over the text itself.
 *
 * Used by `BriefEvaluationCapability` to downgrade an obviously malformed
 * value from "provided" back to "unknown" — the same bucket a field that
 * was never answered falls into — so a corrupted field can never make it
 * into an approvable Design Summary. It does not repair, rewrite, or guess
 * a better value; it only flags.
 */

const SENTENCE_TERMINATOR_PATTERN = /[.!?]+(?:\s+|$)/g;

/** True when text reads as more than one sentence. */
function hasMultipleSentences(text: string): boolean {
  const matches = text.match(SENTENCE_TERMINATOR_PATTERN);
  if (!matches) return false;
  // A single trailing terminator ("Camp shirts.") is not "multiple
  // sentences" — only count a terminator that has non-whitespace content
  // after it, i.e. there's a second sentence following the first.
  let count = 0;
  for (const match of matches) {
    const endIndex = text.indexOf(match) + match.length;
    if (text.slice(endIndex).trim().length > 0) count++;
  }
  return count > 0;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const DESIGN_DESCRIPTION_CUE_PATTERN =
  /\b(design|logo|artwork|graphic|imagery|print|lettering)\b/i;

/** Meta-instruction language that belongs in conversation, never in the
 * literal text that gets printed on the product. */
const WORDING_META_LANGUAGE_PATTERN =
  /\b(please|we want|we need|i want|i need|design|logo|shirt|hoodie|should say|wording|team name|company name)\b/i;

const NEGATIVE_ANSWER_WORDS = new Set([
  "no",
  "nope",
  "nah",
  "none",
  "n/a",
  "na",
  "not really",
]);

const VALID_PRINT_PLACEMENTS: ReadonlySet<PrintPlacement> = new Set([
  "full_front",
  "full_back",
  "left_chest",
  "sleeve",
]);

export interface FieldQualityIssue {
  /** Short, stable machine-readable reason code. */
  code: string;
  /** Plain-language reason, safe to surface internally (never customer copy on its own). */
  reason: string;
}

/**
 * Product must name a product, not explain the order. A real answer is a
 * short phrase ("black t-shirts"); a paragraph or multi-sentence reply is a
 * sign the field absorbed more than a product name.
 */
export function checkProductQuality(value: string): FieldQualityIssue | null {
  if (hasMultipleSentences(value)) {
    return {
      code: "product_multiple_sentences",
      reason: "Product contains multiple sentences instead of a product name.",
    };
  }
  if (wordCount(value) > 8) {
    return {
      code: "product_too_long",
      reason: "Product reads as an explanatory sentence rather than a product name.",
    };
  }
  return null;
}

/**
 * Audience describes *who* the design is for ("bowling team", "camp
 * families") — it must not carry a design description along with it.
 */
export function checkAudienceQuality(value: string): FieldQualityIssue | null {
  if (DESIGN_DESCRIPTION_CUE_PATTERN.test(value)) {
    return {
      code: "audience_contains_design_description",
      reason: "Audience contains design-description language instead of describing who this is for.",
    };
  }
  if (hasMultipleSentences(value)) {
    return {
      code: "audience_multiple_sentences",
      reason: "Audience contains multiple sentences instead of a short description.",
    };
  }
  if (wordCount(value) > 12) {
    return {
      code: "audience_too_long",
      reason: "Audience reads as an explanatory sentence rather than a short description.",
    };
  }
  return null;
}

/**
 * Required wording must be the literal text to print — a short slogan,
 * name, or phrase — never an explanatory paragraph or a bare negative word
 * that should have been recorded as "no wording" instead of literal text.
 */
export function checkRequiredWordingQuality(value: string): FieldQualityIssue | null {
  const normalized = value.trim().toLowerCase();
  if (NEGATIVE_ANSWER_WORDS.has(normalized)) {
    return {
      code: "required_wording_is_negative_answer",
      reason: 'Required wording is a bare negative answer ("no"/"none") rather than actual print text.',
    };
  }
  if (hasMultipleSentences(value)) {
    return {
      code: "required_wording_explanatory_paragraph",
      reason: "Required wording contains an explanatory paragraph instead of the exact text to print.",
    };
  }
  // Deliberately no standalone word-count ceiling here: required wording
  // can legitimately be long ("Camp Wildwood Summer Session Two Thousand
  // Twenty Six Edition") — ProductIntelligence's `small_placement_long_
  // wording` rule pack is what advises on wording length relative to
  // placement (Constitution §12), not this validator. This check only
  // rejects wording that reads as instructional/conversational rather than
  // literal print text, regardless of length.
  if (WORDING_META_LANGUAGE_PATTERN.test(value)) {
    return {
      code: "required_wording_meta_language",
      reason: "Required wording contains instructional language rather than the exact text to print.",
    };
  }
  return null;
}

/**
 * Preferred colors is a list of color names. A negative/declining answer
 * ("no", "none", ...) must never be treated as a color — that is a deferral
 * ("designer determined"), not a literal preference.
 */
export function checkPreferredColorsQuality(
  values: readonly string[],
): FieldQualityIssue | null {
  const malformed = values.find((value) =>
    NEGATIVE_ANSWER_WORDS.has(value.trim().toLowerCase()),
  );
  if (malformed) {
    return {
      code: "preferred_colors_is_negative_answer",
      reason: `Preferred colors contains "${malformed}", a declined answer rather than an actual color.`,
    };
  }
  return null;
}

/**
 * Defense in depth for print location: `TShirtDesignBrief.printPlacement`
 * is a closed enum at the type level, so this can only fail if something
 * upstream writes a value TypeScript didn't catch (e.g. deserializing
 * untrusted/legacy data). Kept for the same reason the other checks exist —
 * the Design Summary must never present a corrupted value as resolved.
 */
export function checkPrintLocationQuality(
  value: string,
): FieldQualityIssue | null {
  if (!VALID_PRINT_PLACEMENTS.has(value as PrintPlacement)) {
    return {
      code: "print_location_unrecognized",
      reason: "Print location does not match a known placement.",
    };
  }
  return null;
}
