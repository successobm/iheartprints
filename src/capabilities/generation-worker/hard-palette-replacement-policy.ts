/**
 * Phase 2C — AUTOMATIC HARD-FAIL CONCEPT REPLACEMENT policy.
 *
 * Pure decision rules, deliberately separated from the worker that spends
 * money against them. Nothing here does I/O, and nothing here counts spend:
 * the budget is durable (`paid_image_intents`), never an in-memory tally.
 *
 * WHAT THIS PHASE IS
 *
 * A customer must not be shown a generated concept that violates a HARD
 * production constraint when the platform can automatically replace it.
 * Phase 2B made that verdict available from actual pixels; Phase 2C acts on
 * it, exactly once per failed direction.
 *
 * WHAT THIS PHASE IS NOT
 *
 * It is not "generate until good". It is not a quality, taste, composition,
 * or subjective-preference retry loop. The only trigger is the deterministic
 * validator's authoritative HARD failure — see `isHardPrintPaletteFailure`
 * for the two conditions, both required.
 */

import type {
  ConceptEvaluation,
  PrintPaletteCompliance,
} from "@/lib/domain/types";

/**
 * The one and only automatic-replacement trigger.
 *
 * BOTH must hold:
 *   A. the print palette is a HARD production constraint for this brief
 *      (Phase 2A `printPaletteEnforcement === "hard"`), and
 *   B. the Phase 2B deterministic validator returned `"fail"`.
 *
 * Everything else is deliberately excluded, and the exclusions are the
 * substance of the rule rather than an afterthought:
 *
 *   "warn"            a real but non-blocking deviation. Customer-visible,
 *                     unchanged — Phase 2B calibrated WARN to mean exactly
 *                     that, and re-buying an image over it would be spending
 *                     money to enforce a threshold nobody set.
 *   "not_applicable"  no palette gate, or pixels could not be read. Neither
 *                     is evidence of a violation, and regenerating on
 *                     "we couldn't check" would pay for uncertainty.
 *   soft enforcement  a stated preference, never a production constraint.
 *   vision verdicts   subjective/semantic scoring. A vision provider can
 *                     never *trigger* a replacement here, and (Phase 2B
 *                     precedence, unchanged) can never reverse a hard FAIL
 *                     either.
 *
 * Reading `enforcement` from the recorded compliance metrics rather than
 * re-deriving it from the brief is intentional: the decision is made against
 * the same snapshot the verdict was computed from, so a brief re-approved
 * mid-job can never make an already-recorded FAIL look inapplicable.
 */
export function isHardPrintPaletteFailure(
  evaluation: ConceptEvaluation | null | undefined,
): boolean {
  const compliance = evaluation?.printPaletteCompliance;
  if (!compliance) return false;
  return (
    compliance.metrics.enforcement === "hard" && compliance.status === "fail"
  );
}

/**
 * What to do with a generated REPLACEMENT, once it has been evaluated by the
 * normal (deterministic + vision) pipeline.
 *
 *   "accept"            the replacement is customer-visible as evaluated.
 *   "accept_unverified" the replacement is customer-visible, but its
 *                       evaluation status is downgraded to `needs_review` —
 *                       nothing downstream may treat it as verified-compliant.
 *   "reject"            the replacement is NOT shown, and no further
 *                       generation is attempted for this direction.
 */
export type ReplacementAcceptance =
  | "accept"
  | "accept_unverified"
  | "reject";

/**
 * Replacement acceptance policy.
 *
 *   PASS            accept. The correction worked.
 *   WARN            accept. WARN is customer-visible for an ORIGINAL concept
 *                   (Phase 2B), and applying a stricter bar to a replacement
 *                   than to the concept it replaces would be incoherent — it
 *                   would discard artwork the platform already owns over a
 *                   deviation it accepts everywhere else.
 *   FAIL            reject, and stop. One automatic replacement per
 *                   direction is the entire budget; a second would be the
 *                   start of the unbounded loop this phase exists to avoid.
 *   NOT_APPLICABLE  accept, but only as `needs_review`. This should not
 *                   normally occur — the direction reached here precisely
 *                   BECAUSE it had a hard palette gate — so it means the
 *                   replacement's pixels could not be read. The honest
 *                   position is neither "throw away a paid image on a decode
 *                   failure" nor "claim hard compliance we did not verify",
 *                   and `needs_review` is exactly that middle.
 *
 * A missing compliance payload is treated identically to NOT_APPLICABLE: an
 * absent verdict is an unverified one, never a passing one.
 */
export function classifyReplacementAcceptance(
  compliance: PrintPaletteCompliance | null | undefined,
): ReplacementAcceptance {
  if (!compliance) return "accept_unverified";
  switch (compliance.status) {
    case "pass":
    case "warn":
      return "accept";
    case "fail":
      return "reject";
    case "not_applicable":
      return "accept_unverified";
  }
}

/**
 * Why a direction that hard-failed ended up without a replacement. Every
 * value is observable in the logs — a customer who receives fewer than three
 * concepts must always be explainable from the server record alone.
 */
export type ReplacementSkipReason =
  /** The job's durable paid-intent budget refused a further logical intent. */
  | "paid_budget_exhausted"
  /** The replacement image itself could not be produced (provider/storage). */
  | "replacement_generation_failed"
  /** The replacement was produced and still hard-failed. No second attempt. */
  | "replacement_failed_validation"
  /** The adapter exposes no per-direction paid unit to replace. */
  | "no_per_direction_paid_unit";
