/**
 * Sprint 2M Phase 1 — Goal 7: effective print resolution.
 *
 * "Effective resolution" is pixel dimensions ÷ intended physical print
 * dimensions — never PNG DPI metadata. Changing a file's embedded DPI tag
 * does not add image information, so it is never read or trusted here; the
 * only inputs are pixel dimensions (from asset metadata) and the target
 * physical size (from `ProductionRequirements`, itself derived from the
 * approved Design Brief's print placement).
 *
 * Pure, deterministic math — no I/O, no provider, no rounding surprises
 * hidden behind a library.
 */

import type { PhysicalDimensions, PixelDimensions } from "./contracts";

export interface EffectiveResolutionResult {
  /** Pixels per inch implied by width alone. */
  ppiWidth: number;
  /** Pixels per inch implied by height alone, or `null` when height is not constrained. */
  ppiHeight: number | null;
  /**
   * The binding (limiting) effective PPI — the lower of width/height PPI
   * when both are known, since production quality is only as good as the
   * more constrained dimension.
   */
  effectivePpi: number;
}

/**
 * Computes effective print resolution. Both `pixels` values must be
 * positive integers and `target.widthIn` must be positive — callers
 * (`deriveProductionRequirements` / the capability) are responsible for
 * only calling this once dimensions are actually known; this function does
 * not itself decide "unknown".
 */
export function calculateEffectiveResolution(
  pixels: PixelDimensions,
  target: PhysicalDimensions,
): EffectiveResolutionResult {
  const ppiWidth = pixels.widthPx / target.widthIn;
  const ppiHeight =
    target.heightIn && target.heightIn > 0
      ? pixels.heightPx / target.heightIn
      : null;
  const effectivePpi = ppiHeight !== null ? Math.min(ppiWidth, ppiHeight) : ppiWidth;
  return { ppiWidth, ppiHeight, effectivePpi };
}

/** Derives the minimum acceptable raster pixel dimensions for a target size at a given PPI floor. */
export function minimumRasterDimensionsFor(
  target: PhysicalDimensions,
  targetPpi: number,
): PixelDimensions {
  const heightIn = target.heightIn ?? target.widthIn;
  return {
    widthPx: Math.ceil(target.widthIn * targetPpi),
    heightPx: Math.ceil(heightIn * targetPpi),
  };
}
