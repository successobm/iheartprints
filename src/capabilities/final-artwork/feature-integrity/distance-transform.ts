/**
 * DTF Feature Integrity Phase 1: pure raster distance-transform primitives.
 *
 * No I/O, no PNG codec, no provider — mirrors `raster-transform.ts`'s reason
 * for existing. Two-pass raster scan, O(n) in the number of pixels, matching
 * the complexity class of every other pixel-buffer algorithm in this codebase
 * (`region-separation.ts`'s `chebyshevDistanceTransform`,
 * `background-cavities.ts`'s BFS distance passes) — never a per-pixel search
 * over the whole image.
 *
 * CHAMFER, NOT EXACT EUCLIDEAN. This computes a (5,7) chamfer distance
 * transform (weight 5 orthogonal, weight 7 diagonal, distances reported in
 * units of `1/5` pixel so orthogonal steps equal 1.0) rather than the exact
 * Euclidean distance transform (which needs a parabola-envelope algorithm to
 * stay O(n)). (5,7) is the well-known Borgefors refinement of the simpler
 * (3,4) chamfer, chosen specifically because (3,4)'s diagonal ratio (4/3 ≈
 * 1.333) is a poor stand-in for √2 ≈ 1.414 (~5.7% error at exactly 45°),
 * while (5,7)'s ratio (7/5 = 1.4) keeps worst-case error against true
 * Euclidean distance to roughly 2-3% — far tighter than the Chebyshev
 * distance this codebase's other distance transform uses
 * (`chebyshevDistanceTransform`, ~30-40% error on diagonals, appropriate for
 * that function's gap-closing use but which would systematically
 * UNDER-measure a diagonal stroke's true physical width here). Chosen over
 * exact Euclidean for implementation simplicity in this phase; an exact
 * transform can replace it later without changing any caller's contract if
 * calibration against real prints ever shows this approximation is the
 * limiting source of error (it will not be — DTF process variation is far
 * larger than a few percent).
 */

/** Orthogonal step weight. Distances are returned in pixel units (already divided by this). */
const ORTHOGONAL_WEIGHT = 5;
/** Diagonal step weight — the Borgefors (5,7) chamfer constant. */
const DIAGONAL_WEIGHT = 7;

/**
 * Distance, in pixel units, from every pixel to the nearest pixel where
 * `mask` is falsy (0). Pixels where `mask` is already falsy have distance 0.
 *
 * `mask` is read as "inside the region being measured" — callers pass an ink
 * mask to measure distance-to-background (for positive-feature thickness) or
 * a gap mask to measure distance-to-ink (for negative-space width). The
 * function itself has no opinion about which side is "foreground."
 */
export function chamferDistanceTransform(
  mask: Uint8Array,
  width: number,
  height: number,
): Float64Array {
  const INF = 1 << 28;
  const d = new Int32Array(width * height);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? INF : 0;

  // Forward pass: top-left to bottom-right.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i]!;
      if (x > 0) best = Math.min(best, d[i - 1]! + ORTHOGONAL_WEIGHT);
      if (y > 0) best = Math.min(best, d[i - width]! + ORTHOGONAL_WEIGHT);
      if (x > 0 && y > 0) best = Math.min(best, d[i - width - 1]! + DIAGONAL_WEIGHT);
      if (x < width - 1 && y > 0) best = Math.min(best, d[i - width + 1]! + DIAGONAL_WEIGHT);
      d[i] = best;
    }
  }

  // Backward pass: bottom-right to top-left.
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i]!;
      if (x < width - 1) best = Math.min(best, d[i + 1]! + ORTHOGONAL_WEIGHT);
      if (y < height - 1) best = Math.min(best, d[i + width]! + ORTHOGONAL_WEIGHT);
      if (x < width - 1 && y < height - 1) best = Math.min(best, d[i + width + 1]! + DIAGONAL_WEIGHT);
      if (x > 0 && y < height - 1) best = Math.min(best, d[i + width - 1]! + DIAGONAL_WEIGHT);
      d[i] = best;
    }
  }

  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = d[i]! / ORTHOGONAL_WEIGHT;
  return out;
}

/**
 * Approximate medial-axis ("ridge") pixels of `mask`, found by non-maximum
 * suppression on its own distance transform: a pixel is a ridge point when
 * no same-mask 8-neighbor has a strictly larger distance value. This is a
 * standard, cheap approximation of skeletonization (it never traces
 * connectivity of the skeleton itself, only marks local maxima) — sufficient
 * for THIS module's purpose, which is reading off the distance value AT the
 * ridge, not reconstructing the skeleton's shape.
 *
 * WHY A RIDGE, NOT THE RAW DISTANCE MAP: a pixel one step inside a stroke's
 * edge always has a small distance value regardless of how wide the stroke
 * is — that is proximity to an edge, not stroke width. Only at the ridge
 * (the stroke's local centerline) does the distance value equal half the
 * stroke's true local width. Reading minimum distance off ridge pixels only
 * is what makes this a width measurement rather than an edge-proximity
 * measurement.
 */
/**
 * Distance-transform-with-label-propagation: for every pixel, the chamfer
 * distance to the nearest "seed" pixel (one where `seedLabel >= 0`) and that
 * seed's own label. Seed pixels get distance 0 and their own label; a pixel
 * with no seed anywhere in the image gets label `-1`.
 *
 * This is the standard feature-transform extension of a chamfer distance
 * transform (propagate the source label alongside the running distance, and
 * whichever neighbor wins the minimum also donates its label) — used here to
 * answer "which ink component is nearest, and how far away is it?" for every
 * background pixel in one O(n) pass, rather than running a separate distance
 * transform per component (which would cost O(components x pixels) and is
 * exactly the accidentally-quadratic shape this phase's plan warns against).
 */
export function nearestSeedTransform(
  seedLabel: Int32Array,
  width: number,
  height: number,
): { distance: Float64Array; nearestLabel: Int32Array } {
  const INF = 1 << 28;
  const n = width * height;
  const d = new Int32Array(n);
  const label = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (seedLabel[i]! >= 0) {
      d[i] = 0;
      label[i] = seedLabel[i]!;
    } else {
      d[i] = INF;
      label[i] = -1;
    }
  }

  const relax = (i: number, ni: number, weight: number) => {
    if (label[ni]! < 0) return;
    const candidate = d[ni]! + weight;
    if (candidate < d[i]!) {
      d[i] = candidate;
      label[i] = label[ni]!;
    }
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      if (x > 0) relax(i, i - 1, ORTHOGONAL_WEIGHT);
      if (y > 0) relax(i, i - width, ORTHOGONAL_WEIGHT);
      if (x > 0 && y > 0) relax(i, i - width - 1, DIAGONAL_WEIGHT);
      if (x < width - 1 && y > 0) relax(i, i - width + 1, DIAGONAL_WEIGHT);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      if (x < width - 1) relax(i, i + 1, ORTHOGONAL_WEIGHT);
      if (y < height - 1) relax(i, i + width, ORTHOGONAL_WEIGHT);
      if (x < width - 1 && y < height - 1) relax(i, i + width + 1, DIAGONAL_WEIGHT);
      if (x > 0 && y < height - 1) relax(i, i + width - 1, DIAGONAL_WEIGHT);
    }
  }

  const distance = new Float64Array(n);
  for (let i = 0; i < n; i += 1) distance[i] = d[i]! >= INF ? Infinity : d[i]! / ORTHOGONAL_WEIGHT;
  return { distance, nearestLabel: label };
}

export function ridgeMask(
  mask: Uint8Array,
  distance: Float64Array,
  width: number,
  height: number,
): Uint8Array {
  const ridge = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const own = distance[i]!;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (!mask[ni]) continue;
          if (distance[ni]! > own) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) ridge[i] = 1;
    }
  }
  return ridge;
}
