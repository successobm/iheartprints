/**
 * LIVE PRODUCT BLOCKER #4C: source-space ↔ reconstruction-space coordinate
 * mapping for preservation verification. Pure — no I/O, no capability
 * imports (mirrors `sign-preparation/sign-geometry.ts`'s own discipline;
 * this module never imports `sign-preparation` — the tolerance below is
 * re-stated, not imported, the same discipline `sign-preservation
 * -deterministic-checks.ts`'s own doc comment already follows for every
 * other cross-capability fact it needs).
 *
 * BACKGROUND. Before this phase, both `checkSourceSimilarity` and
 * `deriveSemanticComparisonImages` required the reconstruction to be an
 * EXACT INTEGER multiple of the source dimensions (`scaleX === scaleY &&
 * Number.isInteger(scaleX)`). That requirement was never a real
 * mathematical necessity of resampling itself — `resampleExact`
 * (`final-artwork/raster-transform.ts`) already performs ordinary bilinear
 * resampling to any destination size, integer scale or not, and both
 * functions already called it unconditionally for the "overview" images.
 * It WAS a real necessity for the OLD native-resolution grid-crop math in
 * `deriveSemanticComparisonImages` (`x0 * scale` needing to land on an
 * exact source pixel boundary for a lossless native crop) — but a real
 * sign reconstruction's scale is `targetPpi / effectivePpi * headroom`,
 * essentially never an integer (the real customer's own persisted plan:
 * 3.38121546961326×), so that requirement blocked ordinary production use
 * outright, not merely an unusual edge case.
 *
 * THE FIX. Two independent scale factors (`scaleX`, `scaleY`), required to
 * be PROPORTIONAL within an explicit, bounded raster-rounding tolerance —
 * never required to be integers, never required to be exactly equal bit
 * for bit. A reconstruction whose axes disagree beyond that tolerance
 * (an unauthorized distortion, not a rounding artifact) still fails
 * closed exactly as before — arbitrary scale support was never meant to
 * license arbitrary distortion.
 */

/**
 * Mirrors `sign-preparation/sign-inspection.ts`'s own `SIGN_ASPECT_TOLERANCE`
 * value exactly (1%) — the same bar the rest of this codebase already uses
 * to distinguish "proportional, modulo raster rounding" from "a genuinely
 * different aspect ratio". A real reconstruction's own rounding slack
 * (`Math.round(sourceDim * scale)` applied independently per axis) is
 * smaller than this by orders of magnitude for any real sign source, so
 * this tolerance is generous, not permissive of real distortion.
 */
export const RECONSTRUCTION_SCALE_PROPORTIONALITY_TOLERANCE = 0.01;

export interface SourceReconstructionScale {
  /** `reconstructionWidthPx / sourceWidthPx`. */
  scaleX: number;
  /** `reconstructionHeightPx / sourceHeightPx`. */
  scaleY: number;
}

/**
 * Resolves the two independent axis scales and proves they are
 * PROPORTIONAL within `RECONSTRUCTION_SCALE_PROPORTIONALITY_TOLERANCE` —
 * never that they are integers, never that they are bit-identical.
 * Returns `null` (unavailable, not guessed) for non-positive dimensions or
 * a genuine aspect disagreement beyond the tolerance — the same fail-closed
 * shape the integer-only gate this replaces already had.
 */
export function resolveProportionalReconstructionScale(
  sourceWidthPx: number,
  sourceHeightPx: number,
  reconstructionWidthPx: number,
  reconstructionHeightPx: number,
): SourceReconstructionScale | null {
  if (
    !(sourceWidthPx > 0) ||
    !(sourceHeightPx > 0) ||
    !(reconstructionWidthPx > 0) ||
    !(reconstructionHeightPx > 0)
  ) {
    return null;
  }
  const scaleX = reconstructionWidthPx / sourceWidthPx;
  const scaleY = reconstructionHeightPx / sourceHeightPx;
  const larger = Math.max(scaleX, scaleY);
  const relativeDelta = Math.abs(scaleX - scaleY) / larger;
  if (relativeDelta > RECONSTRUCTION_SCALE_PROPORTIONALITY_TOLERANCE) return null;
  return { scaleX, scaleY };
}

/**
 * Maps a `[start, end)` range in SOURCE-space pixels to the corresponding
 * range in RECONSTRUCTION-space pixels along one axis, using explicit
 * rounding — never naive integer multiplication, never left to float
 * truncation. The result is GUARANTEED to:
 *
 *   - stay within `[0, dimLimit]` (never index outside the actual
 *     reconstruction raster, regardless of rounding at the frame edge);
 *   - never be empty (`end > start` always) — a degenerate crop is
 *     widened by the minimum single pixel needed, expanding forward
 *     unless already at the image's own edge, in which case it expands
 *     backward instead. This can only happen for a vanishingly thin grid
 *     cell at an extreme scale; ordinary sign geometry never approaches
 *     it, but the guarantee is unconditional rather than assumed.
 *
 * Deliberately `Math.round`, not floor/ceil: it is the same rounding rule
 * every OTHER pixel-boundary decision in the Signs planner/executor
 * already uses (`Math.round(sourceDim * scale)`), so a source-space grid
 * boundary and the SAME boundary re-derived here land on the identical
 * pixel whenever the two computations agree — which is the common case,
 * not a coincidence.
 */
export function mapSourceRangeToReconstruction(
  start: number,
  end: number,
  scale: number,
  dimLimit: number,
): { start: number; end: number } {
  let mappedStart = Math.round(start * scale);
  let mappedEnd = Math.round(end * scale);
  mappedStart = Math.max(0, Math.min(mappedStart, dimLimit));
  mappedEnd = Math.max(0, Math.min(mappedEnd, dimLimit));
  if (mappedEnd <= mappedStart) {
    if (mappedStart < dimLimit) {
      mappedEnd = mappedStart + 1;
    } else {
      mappedStart = Math.max(0, mappedEnd - 1);
    }
  }
  return { start: mappedStart, end: mappedEnd };
}
