/**
 * Signs Phase S1: the rigid-sign resolution POLICY table (Constitution
 * §16A.4).
 *
 * Sign resolution requirements are a profile policy derived from product
 * class, physical dimensions, viewing distance, and production process —
 * never a universal constant, and never copied from another profile. The
 * apparel profile's 300 PPI is an apparel fact and does not appear here;
 * likewise nothing here is "all signs = 150 PPI": each policy row names the
 * envelope it governs, and an ordered size outside every envelope has NO
 * policy and fails closed.
 *
 * Revising a figure inside this profile is an operational decision recorded
 * here and in ARCHITECTURE.md (§16A.4), not a Constitution amendment.
 * Adding a policy for a NEW sign class is a deliberate product decision,
 * never a fallback.
 */

import {
  PROVIDER_MAX_RECONSTRUCTION_SCALE,
  RECONSTRUCTION_HEADROOM,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";

export interface SignResolutionPolicy {
  /** Stable identity, stamped onto confirmations and plans. Versioned. */
  id: string;
  /** Effective-resolution target (warning threshold below it). */
  targetPpi: number;
  /** Blocking minimum effective resolution. */
  minPpi: number;
  /**
   * The envelope this policy governs: the ordered rectangle must fit within
   * shortSideMaxIn × longSideMaxIn in either orientation.
   */
  shortSideMaxIn: number;
  longSideMaxIn: number;
}

/**
 * V1: rectangular rigid signs up to 24×36 in, at typical near-view signage
 * distance. 150 target / 100 blocking minimum per the Phase S0 audit and
 * Constitution §16A.4 — initial production policy, expected to evolve from
 * production evidence.
 */
export const RIGID_RECT_UP_TO_24X36_V1: SignResolutionPolicy = {
  id: "rigid_rect_up_to_24x36:v1",
  targetPpi: 150,
  minPpi: 100,
  shortSideMaxIn: 24,
  longSideMaxIn: 36,
};

export const RIGID_SIGN_RESOLUTION_POLICIES: readonly SignResolutionPolicy[] = [
  RIGID_RECT_UP_TO_24X36_V1,
];

/**
 * The policy governing one ordered size, or `null` when no policy covers it
 * — in which case confirmation/planning fail closed rather than borrowing a
 * figure from a class nobody decided (`unsupported_input`).
 */
export function resolveSignResolutionPolicy(
  orderedWidthIn: number,
  orderedHeightIn: number,
): SignResolutionPolicy | null {
  if (!isPositiveFinite(orderedWidthIn) || !isPositiveFinite(orderedHeightIn)) {
    return null;
  }
  const shortSide = Math.min(orderedWidthIn, orderedHeightIn);
  const longSide = Math.max(orderedWidthIn, orderedHeightIn);
  return (
    RIGID_SIGN_RESOLUTION_POLICIES.find(
      (policy) =>
        shortSide <= policy.shortSideMaxIn && longSide <= policy.longSideMaxIn,
    ) ?? null
  );
}

export function getSignResolutionPolicyById(
  id: string,
): SignResolutionPolicy | null {
  return RIGID_SIGN_RESOLUTION_POLICIES.find((policy) => policy.id === id) ?? null;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The reconstruction bounds the PLANNER may assume (Constitution §16A.3:
 * provider operations are bounded and refused pre-dispatch when a need
 * exceeds them). Imported from the live provider module — the same
 * live-billed-order-proven 4× ceiling and 1.02 headroom the apparel
 * pipeline's `resolveReconstructionRequest` enforces — so the planner and
 * the executor can never quietly disagree about what is dispatchable.
 * Provider-neutral in meaning: if a future provider changes the bound, this
 * import is the single seam that moves.
 */
export const SIGN_RECONSTRUCTION_SCALE_CEILING = PROVIDER_MAX_RECONSTRUCTION_SCALE;
export const SIGN_RECONSTRUCTION_HEADROOM = RECONSTRUCTION_HEADROOM;
