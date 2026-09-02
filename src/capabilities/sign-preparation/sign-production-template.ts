/**
 * Structural Layout Reflow Phase 1 (Foundations): builds the authoritative
 * `SignProductionTemplate` (`contracts.ts`) and converts its physical
 * safe-area figure into pixels for a given output geometry.
 *
 * Deliberately its own small file, never folded into `contracts.ts`
 * (which stays pure data — see that file's own doc) and never into
 * `resolution-policy.ts` (which stays the policy TABLE, not a builder).
 */

import type { SignProductionSpec, SignProductionTemplate } from "./contracts";
import type { SignResolutionPolicy } from "./resolution-policy";

/**
 * The ONLY constructor for `SignProductionTemplate`. Takes exactly the
 * human-confirmed ordered spec and the resolution policy it was confirmed
 * under — never an inspection report, never a measured frame model, never
 * a single pixel of customer artwork. This is what makes it structurally
 * impossible for a customer's rounded corner, frame radius, or hole
 * placement to influence `shape` (or any other field): there is no
 * parameter here through which artwork geometry could even be passed.
 */
export function buildSignProductionTemplate(
  spec: SignProductionSpec,
  policy: SignResolutionPolicy,
): SignProductionTemplate {
  return {
    widthIn: spec.orderedWidthIn,
    heightIn: spec.orderedHeightIn,
    // V1 admits exactly one shape (`SignProductionTemplateShape`) — this
    // is not a branch on anything; every rigid-sign order gets the same
    // straight rectangular cut area.
    shape: "straight_rectangle",
    minimumSafeInsetIn: policy.minimumSafeInsetIn,
  };
}

/**
 * Converts a physical inset (inches) to a pixel count for ONE axis of the
 * actual final output geometry — never a fixed/assumed PPI. Uses the
 * SAME "actual output pixels ÷ actual ordered inches" ratio
 * `achievedPpi`/`effectivePpi` are computed with elsewhere in this
 * capability (`sign-transform-executor.ts`'s own `achievedPpi`,
 * `print-validation`'s `effective-resolution.ts`), so this can never
 * silently disagree with what the rest of the pipeline calls "the PPI"
 * for the same asset.
 *
 * Rounds UP (`Math.ceil`) — the minimum physical inset must never shrink
 * below `insetIn` due to pixel-rounding; a caller enforcing "content must
 * stay outside this many pixels" needs the boundary to be at least as
 * generous as the physical minimum, never less.
 *
 * Returns `0` for any non-finite or non-positive input dimension (nothing
 * meaningful to convert) rather than throwing — callers that need a hard
 * failure on malformed geometry should check their own inputs before
 * calling this, exactly like `effective-resolution.ts`'s own PPI helpers
 * leave zero/invalid-geometry handling to their own callers.
 */
export function signSafeInsetPx(
  insetIn: number,
  outputPx: number,
  orderedIn: number,
): number {
  if (
    !Number.isFinite(insetIn) ||
    insetIn <= 0 ||
    !Number.isFinite(outputPx) ||
    outputPx <= 0 ||
    !Number.isFinite(orderedIn) ||
    orderedIn <= 0
  ) {
    return 0;
  }
  const pxPerIn = outputPx / orderedIn;
  return Math.ceil(insetIn * pxPerIn);
}
