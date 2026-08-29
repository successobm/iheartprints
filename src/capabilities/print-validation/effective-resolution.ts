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

/**
 * Derives the minimum acceptable raster pixel dimensions for a target size
 * at a given PPI floor.
 *
 * Phase 28V.1: `Math.round`, not `Math.ceil` — matches
 * `resolveWidthConstrainedSizing`'s own rounding rule for the identical
 * inches-to-pixels conversion (see `print-placement-dimensions.ts`), which
 * is what any real produced asset's dimensions are actually derived from.
 * `Math.ceil` has zero tolerance for the floating-point representation
 * error an inches value like 10.46 introduces on the round trip through a
 * division elsewhere (`10.46 * 300` evaluates to `3138.0000000000005`, not
 * exactly `3138`) — silently demanding one phantom pixel more than any
 * asset built from that exact target could ever honestly reach. This
 * function's own callers are currently shadowed by `checkMinimumRasterDimensions`'s
 * `normalization`-driven branch whenever normalization metadata exists (see
 * that function's own Phase 28V.1 fix, the real incident this pattern was
 * found from — project 7bcc3e19-5617-4712-99ab-65f1667b5eda), but the same
 * flaw here is corrected for the same reason, defensively.
 */
export function minimumRasterDimensionsFor(
  target: PhysicalDimensions,
  targetPpi: number,
): PixelDimensions {
  const heightIn = target.heightIn ?? target.widthIn;
  return {
    widthPx: Math.round(target.widthIn * targetPpi),
    heightPx: Math.round(heightIn * targetPpi),
  };
}
