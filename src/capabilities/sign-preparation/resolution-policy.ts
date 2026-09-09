/**
 * Signs Raster Artwork Preparation: the resolution POLICY (Constitution
 * §16A.4, narrowed by the Dimension-Driven Signs Refactor).
 *
 * iHeartPrints prepares print-ready artwork. It does not need to know, and
 * this policy does not ask, whether the finished file will later be printed
 * on ACM, banner vinyl, coroplast, PVC, foam board, or any other Signs
 * substrate — that is a fulfillment/material fact outside the iHeartPrints
 * product boundary (AGENTS.md, Constitution §16A.5). What DOES vary the
 * resolution policy is exactly what Constitution §16A.4 has always said it
 * should: "product class, physical dimensions, viewing distance, print
 * process — never a universal constant." This module reads that as: the
 * ordered PHYSICAL DIMENSIONS themselves, and this runtime's own proven
 * memory ceiling — never a product/substrate label.
 *
 * THE FORMER TWO-POLICY MODEL (Constitution amendment 3.3): a Rigid Sign
 * table row (≤24×36in, 150/100 PPI) and a Banner table row (≤36×96in,
 * 72/50 PPI), matched by an explicit `SignProductionCategory` the customer
 * had to answer BEFORE dimensions. Real production use proved this wrong in
 * two ways: (1) it required a "what are we making?" question the artwork-
 * preparation job never actually needed an answer to, and (2) coupling
 * resolution to a discrete product-category boundary meant a genuinely
 * larger physical order was refused for being the wrong LABEL, not for
 * being technically unsafe to produce.
 *
 * THE CURRENT MODEL: one continuous, dimension-driven formula.
 * `resolveSignResolutionPolicy(width, height)` — no category parameter —
 * computes:
 *
 *   1. A MEMORY-SAFE target PPI, bounded above so the constructed canvas
 *      never exceeds `SAFE_CANVAS_PIXEL_BUDGET`: `sqrt(SAFE_CANVAS_PIXEL_
 *      BUDGET / (widthIn * heightIn))`. `SAFE_CANVAS_PIXEL_BUDGET` is not
 *      an invented number — it is exactly the pixel count of the 84×24in
 *      canvas at 72 PPI (6048×1728 = 10,450,944px) that the Banner
 *      Production Profile Audit empirically measured at ~257MB peak RSS in
 *      the REAL `buildSignCompositionPlan -> executeSignRepairPlan ->
 *      encodeSignPlate` pipeline (isolated fresh Node processes, this
 *      runtime's actual ~512MB/1-shared-vCPU DigitalOcean profile) — the
 *      largest tested point with genuine safety margin (the same audit
 *      measured ~416MB at 20.2MP, "already negligible margin", and ~566MB
 *      at 29.0MP, "unsafe outright"). This bound applies to EVERY Signs
 *      order now, not only large ones: an 18×24in order under a customer's
 *      own very-high-resolution artwork was previously able to construct an
 *      UNCAPPED, arbitrarily-dense canvas (the pre-Banner rigid policy had
 *      no `maxCanvasPpi` at all) — a latent version of the exact same
 *      memory risk the Banner audit found, simply never large enough in
 *      practice to have been caught. This formula closes that gap for every
 *      order, dimension-driven, the same way for all of them.
 *   2. A QUALITY target ceiling, `QUALITY_TARGET_PPI_CEILING` (150) — the
 *      original near-view rigid-sign figure, Phase S0's own viewing-
 *      distance judgment, preserved unchanged as the UPPER bound so small
 *      signs keep exactly their historical target quality (an 18×24in order
 *      still resolves to 150 PPI target — the memory-safe bound at that
 *      size, ~247 PPI, is well above it and never binds).
 *   3. `targetPpi = min(quality ceiling, memory-safe target)` — whichever is
 *      more conservative for THIS order's own physical size.
 *   4. `minPpi = targetPpi * MIN_TARGET_RATIO` (2/3 — the original rigid
 *      policy's own 100/150 ratio, applied consistently rather than two
 *      independently-fitted numbers), never below `ABSOLUTE_MIN_USABLE_PPI`.
 *   5. `maxCanvasPpi = targetPpi`, always — canvas CONSTRUCTION (not just
 *      the after-the-fact validation target) is capped at the same
 *      memory-safe figure, universally, closing the latent uncapped-canvas
 *      gap described above for every order size.
 *
 * When even `ABSOLUTE_MIN_USABLE_PPI` cannot be reached at the requested
 * physical size (an area so large that any technically-safe canvas would be
 * unusably low-resolution), the function returns `null` — fails closed,
 * exactly as the old envelope check did, but for an honest TECHNICAL
 * reason ("too large to safely and usefully produce") rather than a
 * product-label boundary. `isValidOrderedDimensionIn`'s existing 240in
 * (20ft) per-axis sanity ceiling (`sign-spec.ts`) is unchanged and remains
 * the first, cheaper degenerate-input guard.
 *
 * BACKWARD COMPATIBILITY: `RIGID_RECT_UP_TO_24X36_V1` and
 * `BANNER_RECT_UP_TO_36X96_V1` below are kept, UNCHANGED, as fixed
 * historical policy rows — never resolved by `resolveSignResolutionPolicy`
 * for a NEW confirmation, but still returned by `getSignResolutionPolicyById`
 * for an EXISTING preparation whose `resolutionPolicyId` was stamped under
 * the old two-policy model, so an already-planned/authorized Signs order
 * (of either former category) continues to load, re-plan, and validate
 * exactly as it always did. `SIGN_MINIMUM_SAFE_INSET_IN` (a physical
 * finishing-tolerance fact, not a resolution concern) is unchanged.
 */

import {
  PROVIDER_MAX_RECONSTRUCTION_SCALE,
  RECONSTRUCTION_HEADROOM,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { BANNER_CATEGORY, RIGID_SIGN_CATEGORY, type SignProductionCategory } from "./contracts";

/**
 * Structural Layout Reflow Phase 1 (Foundations): the minimum physical
 * clearance meaningful content must keep from a sign's finished cut edge,
 * on all four sides. A single, central figure — never duplicated as a
 * magic number anywhere else this value is needed
 * (`SignProductionTemplate.minimumSafeInsetIn`, `signSafeInsetPx`). This is
 * a genuine production fact (finishing/cutting tolerance), not derived from
 * `targetPpi`/`minPpi` — it could in principle vary, which is why it lives
 * ON the policy rather than as a single bare global constant; every Signs
 * order shares this same figure today.
 */
export const SIGN_MINIMUM_SAFE_INSET_IN = 0.125;

export interface SignResolutionPolicy {
  /** Stable identity, stamped onto confirmations and plans. Versioned. */
  id: string;
  /**
   * Retained for backward-compatible plan/validation dispatch
   * (`PrintValidationProfile`, `ProductionCategory`) — never a live
   * decision input any more. Every NEW resolution always resolves to
   * `RIGID_SIGN_CATEGORY`, the single unified Signs raster category; a
   * `BANNER_CATEGORY` policy can still be returned, but only for an
   * EXISTING preparation stamped with the old banner policy id.
   */
  category: SignProductionCategory;
  /** Effective-resolution target (warning threshold below it). */
  targetPpi: number;
  /** Blocking minimum effective resolution. */
  minPpi: number;
  /** See `SIGN_MINIMUM_SAFE_INSET_IN`'s own doc. */
  minimumSafeInsetIn: number;
  /**
   * Construction-time ceiling on canvas pixel density — never just a
   * validation target. `sign-composition-plan-builder.ts`'s
   * `deriveCanvasPixelDensity` derives canvas density from the (possibly
   * reconstructed) ARTWORK's own actual pixel resolution; the result is
   * clamped to this value regardless of how much resolution the customer's
   * artwork provides, so a customer's own high-resolution upload can never
   * push canvas construction past this policy's own proven-safe pixel
   * ceiling. Always set for a dimension-driven policy (`= targetPpi`);
   * `undefined` only for the legacy pre-audit rigid policy row below,
   * preserved so an already-planned rigid sign replays byte-for-byte.
   */
  maxCanvasPpi?: number;
}

/**
 * The empirically-proven-safe canvas pixel budget: exactly the pixel count
 * of the 84×24in canvas at 72 PPI (6048 × 1728px) the Banner Production
 * Profile Audit measured at ~257MB peak RSS in the real composition →
 * execution → encode pipeline, on this runtime's actual ~512MB/1-shared-
 * vCPU profile — the largest tested point with genuine safety margin. See
 * this file's own top-of-file doc for the full measured curve.
 */
export const SAFE_CANVAS_PIXEL_BUDGET = 6048 * 1728;

/**
 * Upper quality ceiling on target PPI — the original Phase S0 near-view
 * rigid-sign figure (Constitution §16A.4), unchanged. Binds for small
 * signs, where the memory-safe bound is far above it; never exceeded.
 */
export const QUALITY_TARGET_PPI_CEILING = 150;

/** target:minimum ratio — the original rigid policy's own 100/150, applied consistently rather than refit per size class. */
export const MIN_TARGET_PPI_RATIO = 2 / 3;

/**
 * Below this, output is not usable print resolution regardless of memory
 * headroom — a request whose only technically-safe canvas would fall below
 * it is refused (`resolveSignResolutionPolicy` returns `null`) rather than
 * silently producing a worthless file. Conservative relative to the lowest
 * figure ever offered (the legacy banner policy's 50 PPI minimum).
 */
export const ABSOLUTE_MIN_USABLE_PPI = 30;

/** Stable identity for the current dimension-driven formula. Bump on a formula revision that changes what a given size resolves to. */
export const SIGNS_DIMENSION_DRIVEN_POLICY_ID = "signs_dimension_driven:v1";

/**
 * LEGACY (Constitution amendment 3.0; superseded by the Dimension-Driven
 * Signs Refactor): the original rigid-sign policy row, ≤24×36in @ 150/100
 * PPI, uncapped canvas construction. Kept ONLY so an existing preparation
 * whose `resolutionPolicyId` was stamped with this id continues to load,
 * re-plan, and validate exactly as it always has — never resolved by
 * `resolveSignResolutionPolicy` for a new confirmation.
 */
export const RIGID_RECT_UP_TO_24X36_V1: SignResolutionPolicy = {
  id: "rigid_rect_up_to_24x36:v1",
  category: RIGID_SIGN_CATEGORY,
  targetPpi: 150,
  minPpi: 100,
  minimumSafeInsetIn: SIGN_MINIMUM_SAFE_INSET_IN,
};

/**
 * LEGACY (Constitution amendment 3.3; superseded by the Dimension-Driven
 * Signs Refactor): the original banner policy row, ≤36×96in @ 72/50 PPI,
 * canvas construction capped at 72 PPI. Kept ONLY so an existing
 * preparation whose `resolutionPolicyId` was stamped with this id
 * continues to load, re-plan, and validate exactly as it always has —
 * never resolved by `resolveSignResolutionPolicy` for a new confirmation.
 */
export const BANNER_RECT_UP_TO_36X96_V1: SignResolutionPolicy = {
  id: "banner_rect_up_to_36x96:v1",
  category: BANNER_CATEGORY,
  targetPpi: 72,
  minPpi: 50,
  minimumSafeInsetIn: SIGN_MINIMUM_SAFE_INSET_IN,
  maxCanvasPpi: 72,
};

/** Every legacy fixed policy row this build still recognizes for backward compatibility, keyed by id. Never consulted by `resolveSignResolutionPolicy`. */
const LEGACY_POLICIES_BY_ID: ReadonlyMap<string, SignResolutionPolicy> = new Map([
  [RIGID_RECT_UP_TO_24X36_V1.id, RIGID_RECT_UP_TO_24X36_V1],
  [BANNER_RECT_UP_TO_36X96_V1.id, BANNER_RECT_UP_TO_36X96_V1],
]);

/**
 * The dimension-driven resolution policy for one ordered physical size, or
 * `null` when no technically-safe, usable policy exists at that size (an
 * absurd/degenerate input, or a physical area so large that even the
 * memory-safe bound falls below `ABSOLUTE_MIN_USABLE_PPI`). See this file's
 * own top-of-file doc for the full derivation. Deliberately takes no
 * product/substrate/category parameter — the SAME two dimensions always
 * resolve to the SAME policy, independent of what the finished sign will
 * later be printed on.
 */
export function resolveSignResolutionPolicy(
  orderedWidthIn: number,
  orderedHeightIn: number,
): SignResolutionPolicy | null {
  if (!isPositiveFinite(orderedWidthIn) || !isPositiveFinite(orderedHeightIn)) {
    return null;
  }
  const areaSqIn = orderedWidthIn * orderedHeightIn;
  const memorySafeTargetPpi = Math.sqrt(SAFE_CANVAS_PIXEL_BUDGET / areaSqIn);
  const targetPpi = Math.round(Math.min(QUALITY_TARGET_PPI_CEILING, memorySafeTargetPpi));
  if (targetPpi < ABSOLUTE_MIN_USABLE_PPI) {
    return null;
  }
  const minPpi = Math.max(
    ABSOLUTE_MIN_USABLE_PPI,
    Math.round(targetPpi * MIN_TARGET_PPI_RATIO),
  );
  return {
    id: SIGNS_DIMENSION_DRIVEN_POLICY_ID,
    category: RIGID_SIGN_CATEGORY,
    targetPpi,
    minPpi,
    minimumSafeInsetIn: SIGN_MINIMUM_SAFE_INSET_IN,
    maxCanvasPpi: targetPpi,
  };
}

/**
 * Resolves a PERSISTED `resolutionPolicyId` back into the policy it means,
 * given the preparation's own ordered dimensions (a dimension-driven policy
 * is a pure function of size, never stored numbers alone — recomputed
 * fresh every time, exactly like `resolveSignResolutionPolicy` itself).
 * Recognizes the current dimension-driven id (recomputes from `orderedWidthIn`
 * /`orderedHeightIn`) and both legacy fixed ids (returns the unchanged
 * historical row, ignoring dimensions — an already-confirmed legacy spec's
 * envelope was validated once, at confirmation time, under the policy that
 * was live then). Any other id is an absence of knowledge, not a licence to
 * substitute a different policy: fails closed to `null`.
 */
export function getSignResolutionPolicyById(
  id: string,
  orderedWidthIn: number,
  orderedHeightIn: number,
): SignResolutionPolicy | null {
  if (id === SIGNS_DIMENSION_DRIVEN_POLICY_ID) {
    return resolveSignResolutionPolicy(orderedWidthIn, orderedHeightIn);
  }
  return LEGACY_POLICIES_BY_ID.get(id) ?? null;
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
