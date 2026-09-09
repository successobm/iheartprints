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
import { BANNER_CATEGORY, RIGID_SIGN_CATEGORY, type SignProductionCategory } from "./contracts";

/**
 * Structural Layout Reflow Phase 1 (Foundations): the minimum physical
 * clearance meaningful content must keep from a rigid sign's finished cut
 * edge, on all four sides. A single, central figure — never duplicated as
 * a magic number anywhere else this value is needed (`SignProductionTemplate
 * .minimumSafeInsetIn`, `signSafeInsetPx`). This is a genuine production
 * fact (finishing/cutting tolerance), not an apparel figure and not
 * derived from `targetPpi`/`minPpi` — it could in principle vary by
 * policy exactly like they do, which is why it lives ON the policy row
 * rather than as a single bare global constant; V1 has exactly one rigid-
 * sign policy, so today every policy shares this same figure.
 */
export const SIGN_MINIMUM_SAFE_INSET_IN = 0.125;

export interface SignResolutionPolicy {
  /** Stable identity, stamped onto confirmations and plans. Versioned. */
  id: string;
  /**
   * Banner Production Profile: which Signs raster production profile this
   * policy governs — `resolveSignResolutionPolicy` never matches a policy
   * against the wrong category, so the SAME ordered dimensions can (and,
   * for a banner-shaped order, do) resolve differently depending on the
   * category explicitly requested. No policy row is ever matched by size
   * alone.
   */
  category: SignProductionCategory;
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
  /** See `SIGN_MINIMUM_SAFE_INSET_IN`'s own doc. */
  minimumSafeInsetIn: number;
  /**
   * Banner Production Profile Audit: an explicit, optional CONSTRUCTION
   * ceiling on canvas pixel density — never just a validation target.
   * `sign-composition-plan-builder.ts`'s `deriveCanvasPixelDensity` derives
   * canvas density from the (possibly reconstructed) ARTWORK's own actual
   * pixel resolution, uncapped by default — safe for the rigid-sign
   * envelope (≤24×36in even at the full 40 MP ingestion ceiling stays
   * within this runtime's proven-safe memory bounds), but NOT safe for
   * banner's larger physical envelope: empirical measurement (real
   * buildSignCompositionPlan -> executeSignRepairPlan -> encodeSignPlate
   * pipeline, isolated fresh processes) showed an un-capped, aspect-
   * matched, ingestion-ceiling-dense 84×24in banner could reach ~140
   * effective PPI — well past what this ~512 MB runtime safely handles.
   * When set, `deriveCanvasPixelDensity`'s result is clamped to this value
   * regardless of how much resolution the customer's artwork provides —
   * `undefined` (every existing rigid-sign policy) reproduces the
   * pre-audit uncapped behavior exactly, byte-for-byte.
   */
  maxCanvasPpi?: number;
}

/**
 * V1: rectangular rigid signs up to 24×36 in, at typical near-view signage
 * distance. 150 target / 100 blocking minimum per the Phase S0 audit and
 * Constitution §16A.4 — initial production policy, expected to evolve from
 * production evidence.
 */
export const RIGID_RECT_UP_TO_24X36_V1: SignResolutionPolicy = {
  id: "rigid_rect_up_to_24x36:v1",
  category: RIGID_SIGN_CATEGORY,
  targetPpi: 150,
  minPpi: 100,
  shortSideMaxIn: 24,
  longSideMaxIn: 36,
  minimumSafeInsetIn: SIGN_MINIMUM_SAFE_INSET_IN,
};

/**
 * Banner Production Profile (Constitution amendment 3.3, §16A-bis): V1
 * banner envelope and resolution figures — a deliberately bounded range
 * that comfortably includes the real motivating case (84×24in) with modest
 * headroom, not an unnecessarily broad maximum.
 *
 * targetPpi 72 / minPpi 50 — LOWER than rigid's 150/100, for two
 * independent, converging reasons (Constitution §16A.4: resolution policy
 * is "derived from product class, physical dimensions, viewing distance,
 * print process... never a universal constant"):
 *
 *   1. Viewing distance: a banner's much larger physical format (up to
 *      36×96in here, vs rigid's 24×36in) is real-world signage practice
 *      for viewing from meaningfully farther away than a near-view rigid
 *      sign — 72 PPI ("screen resolution") is a legitimate, commonly-used
 *      large-format print target at that distance, not a quality
 *      compromise invented for this runtime.
 *   2. Runtime memory: empirical measurement (real
 *      buildSignCompositionPlan -> executeSignRepairPlan ->
 *      encodeSignPlate pipeline, synthetic opaque 84×24in artwork,
 *      isolated fresh Node processes, this repo's actual ~512 MB/1-shared-
 *      vCPU DigitalOcean runtime) showed peak RSS climbing roughly
 *      linearly with canvas pixel count: ~257 MB at 72 PPI (84×24in
 *      canvas = 6048×1728px ≈ 10.5 MP), ~416 MB at 100 PPI (20.2 MP),
 *      ~566 MB at 120 PPI (29.0 MP) — 100 PPI already leaves negligible
 *      margin once realistic Next.js server baseline and any concurrency
 *      are added; 120+ PPI is unsafe outright. 72 PPI is the highest
 *      target in the tested range with genuine safety margin.
 *
 * `maxCanvasPpi: targetPpi` additionally CAPS canvas construction itself
 * (never just validation) at 72 PPI regardless of how much resolution the
 * customer's artwork provides — see `SignResolutionPolicy.maxCanvasPpi`'s
 * own doc for why this is required (not merely defensive) for banner's
 * larger physical envelope.
 *
 * shortSideMaxIn 36 mirrors rigid's own short-side cap (a reasonable
 * banner height ceiling). longSideMaxIn 96 (8ft) covers the real 84in case
 * with 12in of headroom — re-verified safe at the full envelope corner
 * (36×96in @ the 72 PPI cap = 2592×6912px ≈ 17.9 MP, well under the
 * 84×24in @ 72 PPI figure already measured safe above).
 */
export const BANNER_RECT_UP_TO_36X96_V1: SignResolutionPolicy = {
  id: "banner_rect_up_to_36x96:v1",
  category: BANNER_CATEGORY,
  targetPpi: 72,
  minPpi: 50,
  shortSideMaxIn: 36,
  longSideMaxIn: 96,
  minimumSafeInsetIn: SIGN_MINIMUM_SAFE_INSET_IN,
  maxCanvasPpi: 72,
};

export const RIGID_SIGN_RESOLUTION_POLICIES: readonly SignResolutionPolicy[] = [
  RIGID_RECT_UP_TO_24X36_V1,
];

export const BANNER_RESOLUTION_POLICIES: readonly SignResolutionPolicy[] = [
  BANNER_RECT_UP_TO_36X96_V1,
];

/** Every Signs resolution policy this build admits, across every production category. */
export const ALL_SIGN_RESOLUTION_POLICIES: readonly SignResolutionPolicy[] = [
  ...RIGID_SIGN_RESOLUTION_POLICIES,
  ...BANNER_RESOLUTION_POLICIES,
];

/**
 * The policy governing one ordered size UNDER ONE EXPLICIT production
 * category, or `null` when no policy in that category covers it — in
 * which case confirmation/planning fail closed rather than borrowing a
 * figure from a class nobody decided (`unsupported_input`).
 *
 * Banner Production Profile: `category` defaults to `RIGID_SIGN_CATEGORY`
 * so every pre-Banner call site (omitting the third argument) keeps
 * resolving EXACTLY as before — byte-for-byte. Deliberately never resolves
 * across categories: an 84×24in order explicitly requesting
 * `RIGID_SIGN_CATEGORY` is matched ONLY against rigid-sign policies (and
 * fails, correctly) even though a banner policy would otherwise cover that
 * size — there is no implicit "large sign means banner" inference
 * anywhere in this function.
 */
export function resolveSignResolutionPolicy(
  orderedWidthIn: number,
  orderedHeightIn: number,
  category: SignProductionCategory = RIGID_SIGN_CATEGORY,
): SignResolutionPolicy | null {
  if (!isPositiveFinite(orderedWidthIn) || !isPositiveFinite(orderedHeightIn)) {
    return null;
  }
  const shortSide = Math.min(orderedWidthIn, orderedHeightIn);
  const longSide = Math.max(orderedWidthIn, orderedHeightIn);
  return (
    ALL_SIGN_RESOLUTION_POLICIES.find(
      (policy) =>
        policy.category === category &&
        shortSide <= policy.shortSideMaxIn && longSide <= policy.longSideMaxIn,
    ) ?? null
  );
}

export function getSignResolutionPolicyById(
  id: string,
): SignResolutionPolicy | null {
  return ALL_SIGN_RESOLUTION_POLICIES.find((policy) => policy.id === id) ?? null;
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
