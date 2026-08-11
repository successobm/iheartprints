/**
 * Existing Artwork → Print Ready Phase 2 (Goals 4, 5, 15): the ONE place that
 * decides whether uploaded artwork needs a paid reconstruction pass at all.
 *
 * The decision is pure arithmetic on two numbers that are both already known
 * before any provider is contacted:
 *
 *     the VISIBLE artwork's width, in real source pixels
 *     vs
 *     the production target width, in pixels (target inches × target PPI)
 *
 * Visible width, never canvas width. Transparent padding is not resolution —
 * a 4000x4000 file whose artwork occupies 600px in the middle has 600px of
 * detail, and paying to reconstruct it as though it had 4000 would be both
 * wrong and expensive. This is the same rule
 * `artwork-preparation/image-analysis.ts` already applies when it tells the
 * customer whether enhancement will be needed, so what they were told before
 * approving and what production actually does cannot disagree.
 *
 * Why this is a separate module rather than a branch inside the worker: it is
 * a COST policy as much as a quality one, and cost policy that lives inline
 * in a 600-line worker is policy nobody can test in isolation or find later.
 *
 * Pure — no I/O, no provider, no repository, no clock.
 */

/** What a finalization run did (or will do) to reach production resolution. */
export type EnhancementMethod =
  /**
   * No reconstruction at all. The artwork already carried at least the
   * production target's worth of real pixels, so the deliverable is a pure
   * local geometric transform (alpha trim → proportional resample → PNG).
   * Never a paid provider call.
   */
  | "skipped"
  /**
   * A provider-hosted reconstruction ran (Sprint 2M Phase 2E's Topaz
   * Transparency Upscale, in live configuration). Reported as one word
   * internally; the provider's identity is never surfaced to a customer.
   */
  | "reconstructed";

export interface EnhancementDecision {
  method: EnhancementMethod;
  /** True exactly when `method === "reconstructed"` — the paid path. */
  requiresReconstruction: boolean;
  /** The VISIBLE (alpha-bound) artwork width the decision was made from, in source pixels. */
  sourceVisibleWidthPx: number;
  /** `targetWidthIn × targetPpi`, rounded — e.g. 3150px for 10.5in at 300 PPI. */
  requiredWidthPx: number;
  /** `sourceVisibleWidthPx / requiredWidthPx`. `>= 1` means no reconstruction is needed. */
  coverageRatio: number;
  /** Internal-only rationale, for observability and job diagnostics. Never customer-facing copy. */
  reason: string;
}

export interface EnhancementDecisionInput {
  /** Width of the artwork's own alpha bounding box in the prepared source, in pixels. */
  sourceVisibleWidthPx: number;
  /** Production target physical width, in inches. */
  targetWidthIn: number;
  /** Production target resolution, in pixels per inch. */
  targetPpi: number;
}

/**
 * Decides whether reconstruction is required for one finalization run.
 *
 * Deliberately has no "close enough" band in either direction:
 *
 *   - Below target, reconstruction is required even by one pixel. The
 *     alternative — locally stretching artwork to reach the target and
 *     calling it print-ready — is exactly the self-deception the Upscaling
 *     Truthfulness work exists to prevent.
 *   - At or above target, reconstruction is skipped even by one pixel. The
 *     artwork already carries the detail; a paid call could only re-render
 *     pixels the customer already has, at their expense.
 *
 * This function never decides whether the RESULT is acceptable. A provider
 * whose reconstruction still lands short of the target produces a plate that
 * authoritative Print Validation fails honestly (see
 * `reconstruction_sufficiency` in `print-validation-capability.ts`) — there is
 * deliberately no retry-with-a-bigger-scale loop anywhere in this pipeline.
 */
export function decideEnhancement(
  input: EnhancementDecisionInput,
): EnhancementDecision {
  const requiredWidthPx = Math.max(
    1,
    Math.round(input.targetWidthIn * input.targetPpi),
  );
  const sourceVisibleWidthPx = Math.max(0, Math.round(input.sourceVisibleWidthPx));
  const coverageRatio = sourceVisibleWidthPx / requiredWidthPx;

  if (sourceVisibleWidthPx >= requiredWidthPx) {
    return {
      method: "skipped",
      requiresReconstruction: false,
      sourceVisibleWidthPx,
      requiredWidthPx,
      coverageRatio,
      reason: `Visible artwork is ${sourceVisibleWidthPx}px wide, at or above the ${requiredWidthPx}px this production size requires — no reconstruction needed.`,
    };
  }

  return {
    method: "reconstructed",
    requiresReconstruction: true,
    sourceVisibleWidthPx,
    requiredWidthPx,
    coverageRatio,
    reason: `Visible artwork is ${sourceVisibleWidthPx}px wide, below the ${requiredWidthPx}px this production size requires — reconstruction is required.`,
  };
}
