/**
 * Phase 28T — THE COMPLETE PRODUCTION REQUEST IDENTITY.
 *
 * Pure — no repository, no capability, no I/O — shared by BOTH
 * `final-artwork-capability.ts` (job lookup/creation/revival) and
 * `final-artwork-worker-capability.ts` (the crash-recovery "reuse an
 * already-produced asset for this job" short-circuit). Extracted to its own
 * module specifically so neither capability has to import the OTHER's
 * orchestration code merely to share this arithmetic — mirrors why
 * `alpha-trim.ts`/`enhancement-decision.ts` are their own files in this same
 * directory.
 *
 * WHY THIS EXISTS. `production_width_in` is the CONFIRMED WIDTH INTENT, and
 * has been job identity since Print'em All Phase 1. It was never enough on
 * its own: Phase 28S proved a confirmed width can resolve to two materially
 * different plates (6.96x10.5 vs 9.28x14) depending on the confirmed MAX
 * HEIGHT / the artwork's own orientation — and `final_artwork_jobs` has no
 * height column to compare against. Rather than add one (a real schema
 * change this phase deliberately avoids — see the Phase 28T report's
 * migration discussion), `resolveEffectiveProductionTargetIn` re-derives the
 * CURRENT effective size fresh, on demand, from state that is ALREADY fully
 * persisted: the confirmed (width, boxMaxHeightIn) pair on the brief, and
 * the artwork's own visible bounds already recorded on the preparation's
 * `analysis`. Two requests genuinely have the same effective size when this
 * function returns the same answer for both — a fact, never a guess.
 */

import type { ArtworkPreparation, AssetRecord, PrintPlacement } from "@/lib/domain/types";
import {
  sizingPolicyForConfirmedSize,
  type ConfirmedProductionSize,
} from "@/capabilities/shared/confirmed-production-size";
import {
  resolveWidthConstrainedSizing,
  safetyMarginPxFor,
} from "@/capabilities/shared/print-placement-dimensions";

export interface EffectiveProductionTargetIn {
  widthIn: number;
  heightIn: number;
  targetPpi: number;
}

/**
 * Returns `null` when the artwork's visible bounds are not yet known (should
 * not happen for an approved preparation, but never crashes a lookup over
 * it) — callers treat `null` as "cannot verify", which means falling back to
 * the coarse (width/output/treatment/version) match alone, exactly
 * pre-Phase-28T behavior.
 */
export function resolveEffectiveProductionTargetIn(
  placement: PrintPlacement,
  confirmedSize: ConfirmedProductionSize,
  preparation: Pick<ArtworkPreparation, "analysis">,
): EffectiveProductionTargetIn | null {
  const bounds = (
    preparation.analysis as { artworkBounds?: { width?: number; height?: number } } | undefined
  )?.artworkBounds;
  if (!bounds?.width || !bounds?.height) return null;

  // Phase 28I: the SAME artwork-edge safety margin the customer-facing
  // preview and production normalization both apply — comparing against an
  // un-adjusted target would manufacture a fake ~0.02in "mismatch" against
  // every genuinely-current asset (see `print-ready-size.ts`'s identical
  // margin application and Phase 28S's own downstream-consistency test).
  const margin = safetyMarginPxFor({ width: bounds.width, height: bounds.height });
  const policy = sizingPolicyForConfirmedSize(placement, confirmedSize);
  const resolved = resolveWidthConstrainedSizing(
    policy,
    bounds.width + 2 * margin,
    bounds.height + 2 * margin,
  );
  return { widthIn: resolved.widthIn, heightIn: resolved.heightIn, targetPpi: policy.targetPpi };
}

/**
 * Phase 28T: two production INCH figures separated only by pixel-rounding,
 * margin arithmetic, or reconstruction's own measured drift must never
 * register as a different production request — mirrors
 * `final-artwork-capability.ts`'s own `PRODUCTION_WIDTH_EPSILON_IN`
 * reasoning, widened for two real, DOCUMENTED sources of noise a raw
 * rounding epsilon does not cover:
 *
 *   - `resolveReconstructionRequest`'s own doc comment records a REAL
 *     measured drift of "+0.13%" between a source's pre-reconstruction
 *     alpha bounds and the reconstructed raster's own re-measured bounds
 *     ("reconstruction softens edges, so re-applying the alpha threshold
 *     afterwards moves the bounds by a pixel or two in either direction").
 *     The effective target this module resolves is computed from the
 *     PRE-reconstruction source; the actual produced asset's dimensions
 *     come from the POST-reconstruction measurement — the same two
 *     numbers that comment is about.
 *   - a fixed absolute epsilon does not scale: 6px is generous for a 14in
 *     plate (4200px) and too tight for a 4in accent print (1200px), where
 *     the SAME percentage drift is a larger fraction of a smaller pixel
 *     count.
 *
 * A real measured example (this module's own regression coverage, a small
 * 4x1.8in accent-print fixture): a 547px actual height against a 540px
 * (1.8in @ 300 PPI) expected one — a 1.3% drift, an order of magnitude
 * above the "+0.13%" figure that comment quotes for a larger plate; small
 * fixtures see proportionally more edge-measurement noise. A 2% relative
 * tolerance, with a 0.02in floor for very small targets, comfortably
 * covers that while remaining far below any real size difference a human
 * or Phase 28U's size picker would ever produce — Phase 28T's own real
 * regression case (6.96x10.5 vs 9.28x14) differs by double-digit PERCENT,
 * not low single-digit.
 */
const PRODUCTION_SIZE_MATCH_MIN_TOLERANCE_IN = 0.02;
const PRODUCTION_SIZE_MATCH_RELATIVE_TOLERANCE = 0.02;

function withinProductionSizeTolerance(actualIn: number, expectedIn: number): boolean {
  const tolerance = Math.max(
    PRODUCTION_SIZE_MATCH_MIN_TOLERANCE_IN,
    expectedIn * PRODUCTION_SIZE_MATCH_RELATIVE_TOLERANCE,
  );
  return Math.abs(actualIn - expectedIn) < tolerance;
}

/** Does this specific produced asset already answer the CURRENT effective target? */
export function productionAssetMatchesEffectiveTarget(
  asset: Pick<AssetRecord, "widthPx" | "heightPx">,
  target: EffectiveProductionTargetIn,
): boolean {
  if (asset.widthPx === null || asset.heightPx === null) return false;
  const widthIn = asset.widthPx / target.targetPpi;
  const heightIn = asset.heightPx / target.targetPpi;
  return (
    withinProductionSizeTolerance(widthIn, target.widthIn) &&
    withinProductionSizeTolerance(heightIn, target.heightIn)
  );
}

/**
 * Phase 28V — a controlled two-pass Topaz reconstruction (see
 * `topaz-transparency-upscale-provider.ts`'s `planStandardRasterReconstruction`)
 * durably persists PASS 1's output as an ordinary `production_png`-role
 * asset — deliberately reusing the existing role rather than adding a new
 * `ProductionAssetRole` value, which would need a migration (`production_role`
 * carries a DB `CHECK` constraint enumerating exactly three values). What
 * makes it an INTERNAL reconstruction-stage artifact rather than the
 * customer's deliverable is purely this metadata marker — never a schema
 * distinction. It must never be handed to a customer, counted as "the"
 * production asset for a job, or treated as proof a job is stale/current.
 */
export const RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER = "pass1_intermediate";

export function isReconstructionIntermediateAsset(
  asset: Pick<AssetRecord, "metadata">,
): boolean {
  const metadata = asset.metadata as Record<string, unknown> | null | undefined;
  return metadata?.reconstructionStage === RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER;
}
