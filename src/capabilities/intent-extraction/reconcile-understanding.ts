import { appendNote } from "@/lib/domain/conversation";
import { isDeferrable } from "@/capabilities/shared/interview-coverage-policy";
import {
  normalizeColorAnswer,
  normalizeProductAnswer,
  PRODUCT_NOUN_CANONICAL,
} from "@/capabilities/shared/field-normalization";
import {
  namesAPrintProduct,
  stripDesignArtifactWords,
} from "@/capabilities/shared/print-product-vocabulary";
import { traceConversationUnderstanding } from "@/lib/debug/conversation-understanding-trace";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type {
  PrintPlacement,
  RequestedProductionOutput,
  TShirtDesignBrief,
} from "@/lib/domain/types";

import type { BriefFieldPatch } from "./extraction";
import { textExpressesPaletteIntent } from "./extraction";
import { mergeDesignDescription } from "./design-description-merge";
import { preserveDesignDetail } from "./preserve-design-detail";

/**
 * Sprint 2L Phase 1: turns a (already-sanitized) `ConversationUnderstandingResult`
 * into the same `BriefFieldPatch` shape deterministic extraction produces —
 * the one and only place a semantic interpretation is validated,
 * normalized, and allowed to touch the Design Brief.
 *
 * This is deliberately the *sole* authority for "does this proposed update
 * become a Design Brief field" — `IntentExtractionCapability.extract` calls
 * this once, calls `extractAdaptive` once, and merges their outputs
 * per-field (understanding wins when present) rather than letting two
 * independent systems fight over the same brief (see
 * `capability-boundaries.ts`).
 *
 * Deterministic precedence encoded here (Goal 9):
 *   1. Reject any section this brief doesn't actually back, or any
 *      confidence value of `"ambiguous"` — an uncertain interpretation is
 *      never silently applied (Goal 6/7). It is left for Brief Evaluation /
 *      Interview Intelligence to notice the section is still unresolved and
 *      ask about it, exactly as if nothing had been said.
 *   2. Grounding is field-specific, not one universal rule (Sprint 2L
 *      Phase 1A):
 *        - Required wording is exact and protected (Goal 8): a proposed
 *          value must actually appear in its own `evidence` (normalized
 *          for punctuation/case only, never fuzzy-matched) or it is
 *          rejected outright — this is the concrete guard against a
 *          paraphrased or hallucinated required wording ever reaching the
 *          brief. An explicit "no wording" (`value === ""`) is honored
 *          only at `"explicit"` confidence.
 *        - Product is a canonicalized field, not a verbatim one: the
 *          customer says "team t-shirts", the brief should read
 *          "T-shirt" — requiring the canonical value to appear literally
 *          in evidence would make that impossible. Instead, a proposed
 *          product value is grounded either by literal containment (an
 *          uncommon/descriptive product phrase kept as-is) OR by evidence
 *          containing a recognized product-noun synonym
 *          (`PRODUCT_NOUN_CANONICAL`) that canonicalizes to the *same*
 *          value the provider proposed — "team t-shirts" grounds "T-shirt"
 *          because "shirts" is a recognized synonym for it; "team
 *          t-shirts" evidence could never ground a proposed "Hoodie".
 *          This still rejects a value with no relationship to the
 *          evidence at all (protects against outright hallucination)
 *          while allowing the exact normalization Sprint 2L Phase 1
 *          product regressions require. Grounding alone is not enough,
 *          though: it proves only that the value came from the customer's
 *          own words, not that those words name something printable, so a
 *          grounded value must additionally survive
 *          `stripDesignArtifactWords` — see
 *          `shared/print-product-vocabulary.ts`.
 *        - Every other field has no additional grounding check beyond
 *          "not ambiguous confidence" — they are free-text fields with no
 *          fixed canonical vocabulary to check against, and normalization
 *          (below) already keeps their *shape* consistent with a direct
 *          answer.
 *   3. Every other field is normalized exactly the same way a direct
 *      customer answer would be (`normalizeProductAnswer`,
 *      `normalizeColorAnswer`, `appendNote`, `PrintPlacement` parsing) —
 *      Conversation Understanding never bypasses the deterministic
 *      normalization/protection layer.
 *   4. A deferral is only ever honored for a deferrable section
 *      (`isDeferrable`) — required sections can never be silently deferred
 *      just because a provider proposed it.
 *   5. Detailed-Description Fidelity (Phase 1): `graphics` additionally
 *      passes through `preserveDesignDetail`, which restores design-critical
 *      objects, counts, positions and relationships the provider's synthesis
 *      dropped. This is the ONE place the two layers are reconciled rather
 *      than left to fight: the provider's polished designer-language value
 *      is kept as the base (it reads far better than raw customer text), and
 *      only the specific clauses it genuinely lost are added back from what
 *      the customer actually said. The raw message is never appended
 *      wholesale, and garment-color / print-placement / required-wording
 *      clauses are excluded by construction — see
 *      `preserve-design-detail.ts`.
 */

/** The only Design Brief sections Conversation Understanding may ever touch — sections with no backing field (`references`, `production`, `layoutPreference`) are never accepted, matching `NO_FIELD_SECTIONS` in Brief Evaluation. */
const SUPPORTED_SECTIONS = new Set<BriefSectionKey>([
  "product",
  "graphics",
  "requiredWording",
  "productColor",
  "style",
  "colors",
  "audience",
  "purpose",
  "exclusions",
  "additionalNotes",
  "printLocation",
  // Sprint A2 (corrected) — see the capability's own SUPPORTED_SECTIONS.
  "production",
]);

const PRINT_LOCATION_TEXT_PATTERNS: Array<[RegExp, PrintPlacement]> = [
  [/\bfull\s+front\b/i, "full_front"],
  [/\bfull\s+back\b/i, "full_back"],
  [/\bleft\s+chest\b/i, "left_chest"],
  [/\bsleeve\b/i, "sleeve"],
  [/\bfront\b/i, "full_front"],
  [/\bback\b/i, "full_back"],
  [/\bchest\b/i, "left_chest"],
];

export interface ReconciledUnderstanding {
  fields: BriefFieldPatch;
  /** Newly deferred sections (validated), separate from `fields.deferredSections` so the caller can union it with extractAdaptive's own deferral output rather than one silently overwriting the other. */
  deferredSections: BriefSectionKey[];
  hadExplicitCorrection: boolean;
}

const EMPTY: ReconciledUnderstanding = {
  fields: {},
  deferredSections: [],
  hadExplicitCorrection: false,
};

/** Short, allowlisted rejection codes for `CONVERSATION_UNDERSTANDING_DEBUG` tracing only — never customer-facing. */
type RejectionCode =
  | "unsupported_section"
  | "ambiguous_confidence"
  | "empty_value"
  | "wording_not_grounded"
  | "product_not_grounded"
  | "product_not_a_print_product"
  | "empty_wording_requires_explicit"
  | "unresolvable_print_location"
  | "unresolvable_production_output"
  | "production_output_requires_explicit"
  /** A4 Correction B: a subject's color proposed as the artwork's palette. */
  | "colors_not_a_palette_preference";

/**
 * Sprint A2 (corrected): the CLOSED vocabulary for the `production` section.
 * Accepts the domain values themselves plus the small set of obvious
 * synonyms a model reasonably emits — and nothing else.
 *
 * Decoration methods are deliberately absent and must stay absent. "screen
 * print", "embroidery", "dtf" and "dtg" say where artwork is GOING; they do
 * not order a file, and mapping them here would silently rebuild the exact
 * conflation this correction removed.
 */
const REQUESTED_PRODUCTION_OUTPUT_SYNONYMS: Record<string, RequestedProductionOutput> = {
  production_png: "production_png",
  png: "production_png",
  "production png": "production_png",
  raster: "production_png",
  embroidery_digitization: "embroidery_digitization",
  "embroidery digitization": "embroidery_digitization",
  "embroidery digitizing": "embroidery_digitization",
  digitization: "embroidery_digitization",
  dst: "embroidery_digitization",
  screen_print_separations: "screen_print_separations",
  "screen print separations": "screen_print_separations",
  "color separations": "screen_print_separations",
  "colour separations": "screen_print_separations",
  separations: "screen_print_separations",
  vector_output: "vector_output",
  "vector output": "vector_output",
  "vector file": "vector_output",
  vector: "vector_output",
  svg: "vector_output",
  sublimation_specific: "sublimation_specific",
  "sublimation specific": "sublimation_specific",
  "sublimation production": "sublimation_specific",
};

function parseRequestedProductionOutput(
  value: string,
): RequestedProductionOutput | null {
  const key = value.trim().toLowerCase().replace(/\s+/g, " ");
  return REQUESTED_PRODUCTION_OUTPUT_SYNONYMS[key] ?? null;
}

export function reconcileUnderstanding(
  understanding: ConversationUnderstandingResult | null,
  context: {
    brief: TShirtDesignBrief;
    /**
     * The customer's own message this interpretation came from. Optional so
     * existing callers/tests that only reconcile a provider result keep
     * working; when supplied it is used ONLY as the source of design-critical
     * detail a lossy `graphics` synthesis dropped (see `preserveDesignDetail`).
     */
    message?: string | null;
  },
): ReconciledUnderstanding {
  if (!understanding) return EMPTY;

  const fields: BriefFieldPatch = {};
  let hadExplicitCorrection = false;
  const accepted: BriefSectionKey[] = [];
  const rejected: Array<{ section: string; code: RejectionCode }> = [];

  for (const update of understanding.proposedUpdates) {
    if (!SUPPORTED_SECTIONS.has(update.section)) {
      rejected.push({ section: update.section, code: "unsupported_section" });
      continue;
    }
    if (update.confidence === "ambiguous") {
      // Never silently apply an uncertain interpretation (Goal 6/7).
      rejected.push({ section: update.section, code: "ambiguous_confidence" });
      continue;
    }

    const value = update.value.trim();
    if (update.isCorrection) hadExplicitCorrection = true;
    const reject = (code: RejectionCode) => rejected.push({ section: update.section, code });

    switch (update.section) {
      case "product": {
        if (!value) {
          reject("empty_value");
          continue;
        }
        if (!productIsGrounded(value, update.evidence)) {
          reject("product_not_grounded");
          continue;
        }
        // Grounding proves the value came from what the customer said; it
        // does not prove the value names something printable. "create a
        // design of a red 1988 Toyota MR2" grounds "Design" perfectly
        // well, and stored it as the Product. Stripping first also
        // canonicalizes the common "t-shirt design" shape down to the
        // product noun the customer actually named.
        if (!namesAPrintProduct(value)) {
          reject("product_not_a_print_product");
          continue;
        }
        fields.productSummary = normalizeProductAnswer(
          stripDesignArtifactWords(value),
        );
        accepted.push("product");
        break;
      }
      case "graphics": {
        if (!value) {
          reject("empty_value");
          continue;
        }
        // Phase 1: restore design-critical detail a lossy synthesis dropped.
        // Phase 1.1: then merge that against what the brief ALREADY says
        // rather than overwriting it — the live multi-turn failure was a
        // straight assignment here, which is why turn 2 deleted turn 1's
        // Discovery Bay / waterways / aerial context outright.
        const restored = preserveDesignDetail(value, context.message);
        fields.designDescription = mergeDesignDescription(
          context.brief.designDescription,
          restored,
          context.message ?? restored,
        );
        accepted.push("graphics");
        break;
      }
      case "style":
        if (!value) {
          reject("empty_value");
          continue;
        }
        fields.designStyle = value;
        accepted.push("style");
        break;
      case "productColor":
        if (!value) {
          reject("empty_value");
          continue;
        }
        fields.shirtColor = normalizeColorAnswer(value);
        accepted.push("productColor");
        break;
      case "colors": {
        if (!value) {
          reject("empty_value");
          continue;
        }
        const colors = dedupeCaseInsensitive(
          value
            .split(/,|&|\band\b/i)
            .map((c) => normalizeColorAnswer(c.trim()))
            .filter(Boolean),
        );
        if (colors.length === 0) {
          reject("empty_value");
          break;
        }
        // A4 Correction B: the semantic layer is subject to the same
        // subject-vs-palette rule the deterministic layer is.
        //
        // Understanding's fields WIN the merge in
        // `IntentExtractionCapability.extract`, so without this the exact
        // defect the deterministic fix removes could walk straight back in
        // through a `colors: "Black"` proposal read off "black 2010 jeep
        // wrangler". Deliberately narrow: the update survives if the
        // customer was answering the colors question, or if ANY proposed
        // color reads as palette intent in the provider's own evidence or
        // in the customer's message. Only the pure false-inference case —
        // no palette language anywhere — is refused, and refusing it falls
        // back to deterministic extraction rather than to nothing.
        if (
          understanding.answeredPendingSection !== "colors" &&
          !colors.some(
            (color) =>
              textExpressesPaletteIntent(update.evidence, color) ||
              textExpressesPaletteIntent(context.message, color),
          )
        ) {
          reject("colors_not_a_palette_preference");
          continue;
        }
        fields.preferredColors = colors;
        accepted.push("colors");
        break;
      }
      case "audience":
        if (!value) {
          reject("empty_value");
          continue;
        }
        fields.audience = value;
        accepted.push("audience");
        break;
      case "purpose":
        if (!value) {
          reject("empty_value");
          continue;
        }
        fields.purpose = value;
        accepted.push("purpose");
        break;
      case "exclusions":
        if (!value) {
          reject("empty_value");
          continue;
        }
        fields.exclusions = appendNote(context.brief.exclusions, value);
        accepted.push("exclusions");
        break;
      case "additionalNotes":
        if (!value) {
          reject("empty_value");
          continue;
        }
        fields.additionalInstructions = appendNote(
          context.brief.additionalInstructions,
          value,
        );
        accepted.push("additionalNotes");
        break;
      /**
       * Sprint A2 (corrected): the structured requested production output.
       *
       * A CLOSED vocabulary, unlike every free-text section above. The
       * provider may only name one of the values the domain defines; anything
       * else — a decoration method, a paraphrase, an invented artifact — is
       * rejected rather than coerced. That closure is the whole point: this
       * field decides whether a customer's artwork gets produced, so it must
       * never carry a value nobody validated.
       *
       * Requires `"explicit"` confidence. Refusing to produce someone's
       * artwork on an INFERENCE about what they wanted is precisely the
       * false-positive class this correction removes; when the model is
       * merely fairly sure, the right answer is the supported default.
       */
      case "production": {
        const output = parseRequestedProductionOutput(value);
        if (!output) {
          reject("unresolvable_production_output");
          continue;
        }
        if (update.confidence !== "explicit") {
          reject("production_output_requires_explicit");
          continue;
        }
        fields.requestedProductionOutput = output;
        accepted.push("production");
        break;
      }
      case "printLocation": {
        const placement = parsePrintPlacement(value);
        if (!placement) {
          reject("unresolvable_print_location");
          continue;
        }
        fields.printPlacement = placement;
        accepted.push("printLocation");
        break;
      }
      case "requiredWording": {
        if (value === "") {
          // Explicit "no wording" — only ever honored at full confidence;
          // never inferred from ambiguity (which is already filtered above).
          if (update.confidence === "explicit") {
            fields.exactText = "";
            accepted.push("requiredWording");
          } else {
            reject("empty_wording_requires_explicit");
          }
          break;
        }
        if (!requiredWordingIsGrounded(value, update.evidence)) {
          reject("wording_not_grounded");
          continue;
        }
        fields.exactText = value;
        accepted.push("requiredWording");
        break;
      }
      default:
        break;
    }
  }

  const deferredSections: BriefSectionKey[] = [];
  for (const deferral of understanding.deferrals) {
    if (!SUPPORTED_SECTIONS.has(deferral.section)) continue;
    if (!isDeferrable(deferral.section)) continue;
    deferredSections.push(deferral.section);
  }

  traceConversationUnderstanding({
    stage: "reconciled",
    accepted,
    rejected,
    deferredSections,
  });

  return { fields, deferredSections, hadExplicitCorrection };
}

/**
 * Goal 8: required wording must actually appear in its own evidence quote.
 * Comparison is punctuation/case-insensitive only — never fuzzy — matching
 * the same strictness `OpenAIConceptEvaluationProvider.wordingMatches` uses
 * downstream when verifying generated artwork.
 */
function requiredWordingIsGrounded(value: string, evidence: string): boolean {
  const normalizedEvidence = normalizeForContainment(evidence);
  const normalizedValue = normalizeForContainment(value);
  if (!normalizedValue || !normalizedEvidence) return false;
  return normalizedEvidence.includes(normalizedValue);
}

function normalizeForContainment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Sprint 2L Phase 1A: field-specific grounding for `product` (see the
 * module doc's precedence list, point 2). Unlike required wording, the
 * proposed *value* is a canonicalized product name and is not expected to
 * appear verbatim in `evidence` — "team t-shirts" must be able to ground a
 * proposed "T-shirt". Two independent ways to ground:
 *
 *   1. Literal (normalized) containment — covers a descriptive product
 *      phrase kept close to what the customer actually said (e.g. a
 *      provider proposing "Custom Tote Bags" grounded by evidence
 *      "custom tote bags").
 *   2. A recognized product-noun synonym inside `evidence`
 *      (`PRODUCT_NOUN_CANONICAL`) whose own canonical form matches the
 *      proposed value — this is what lets "team t-shirts" ground "T-shirt"
 *      without requiring the literal word "T-shirt" anywhere in the
 *      customer's message.
 *
 * A value grounded by neither is rejected outright — this is the defense
 * against a provider proposing a product with no real basis in what the
 * customer said (e.g. "Hoodie" grounded only by "team t-shirts" evidence
 * fails both checks and is rejected).
 */
function productIsGrounded(value: string, evidence: string): boolean {
  const normalizedEvidence = normalizeForContainment(evidence);
  const normalizedValue = normalizeForContainment(value);
  if (!normalizedValue || !normalizedEvidence) return false;

  if (normalizedEvidence.includes(normalizedValue)) return true;

  const canonicalValue = normalizeProductAnswer(value).toLowerCase();
  for (const noun of Object.keys(PRODUCT_NOUN_CANONICAL)) {
    const pattern = new RegExp(`\\b${escapeRegExp(noun)}\\b`, "i");
    if (!pattern.test(evidence)) continue;
    if (normalizeProductAnswer(noun).toLowerCase() === canonicalValue) return true;
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePrintPlacement(value: string): PrintPlacement | null {
  for (const [pattern, placement] of PRINT_LOCATION_TEXT_PATTERNS) {
    if (pattern.test(value)) return placement;
  }
  return null;
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
