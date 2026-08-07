/**
 * Sprint 2M Phase 2E (Goal 6): the pre-reconstruction source eligibility
 * gate. The Phase 2D bake-off exposed a real defect class: one approved
 * concept whose required wording ("My 3 Sons") was not actually present as
 * literal text in the source artwork, even though its own Concept
 * Evaluation should have (and, in a correctly-run pipeline, did) record
 * that. Reconstruction cannot repair an already-invalid concept — Topaz (or
 * any reconstruction provider) faithfully preserves whatever is actually in
 * the source pixels, so paying for reconstruction of a concept already
 * known to be wrong both wastes money AND still produces unusable
 * production artwork (Constitution §15 — print readiness is earned, never
 * assumed).
 *
 * Deliberately narrow and conservative (Goal 6's "smallest honest
 * implementation"): this only ever fires on a DEFINITIVE, already-persisted
 * negative signal — Concept Evaluation's own `required_wording` criterion
 * explicitly resolved `passed: false`. Every other state (no evaluation
 * yet, `passed: null` / not-assessed, evaluation still `"pending"`) is
 * treated as "not enough evidence to block spending" and lets the job
 * proceed — independent production verification (Goal 7,
 * `production-verification.ts`) is the backstop that still catches those
 * cases after reconstruction, against the actual production asset.
 *
 * Provider-agnostic on purpose: this runs before ANY provider call (local
 * or Topaz), not just a paid one — an artwork already known to be wrong
 * should never be treated as finalizable regardless of which provider would
 * have transformed it.
 */

import type { ConceptEvaluation } from "@/lib/domain/types";

export interface SourceEligibilityResult {
  eligible: boolean;
  /** Internal-only reason — never customer-facing copy. `null` when eligible. */
  reason: string | null;
}

export function checkSourceEligibleForFinalization(
  evaluation: ConceptEvaluation | null,
): SourceEligibilityResult {
  if (!evaluation) {
    // No evaluation recorded at all — insufficient evidence to block on
    // (Goal 6's documented fallback). Production verification still runs
    // independently after reconstruction.
    return { eligible: true, reason: null };
  }
  const requiredWording = evaluation.criteria.find(
    (criterion) => criterion.key === "required_wording",
  );
  if (requiredWording?.passed === false) {
    return {
      eligible: false,
      reason:
        "The approved concept's own evaluation already found required wording missing or incorrect; reconstruction cannot repair an already-invalid concept.",
    };
  }
  return { eligible: true, reason: null };
}
