/**
 * Signs — Production-Aware Perimeter Reconstruction Phase (Constitution
 * §16A.3, amendment 3.1). The bounded, non-generative, pixel-sourced
 * reconstruction capability that carve-out authorizes.
 *
 * SCOPE, DELIBERATELY NARROW. This module answers exactly one question:
 * "are the rows of pixels nearest an edge each internally uniform enough
 * that repeating them outward is a safe, deterministic way to extend the
 * canvas along that edge?" It does NOT attempt to segment the image into
 * "perimeter" vs "interior" regions, does not identify borders, frames,
 * rounded corners, or corner/hole indicators as distinct shapes, and does
 * not reposition anything. Those all remain either future work (requiring
 * their own deliberate authorization, exactly like this module needed its
 * own) or — for corner/hole indicators specifically — are handled by NOT
 * being handled: see the module-level note below on why that is safe, not
 * merely deferred.
 *
 * WHY THIS IS SAFE FOR THE CONSTITUTIONAL CONSTRAINTS:
 *   - "Built only from the customer's own already-present pixels" — every
 *     tiled row is a colour this function MEASURED from the real source
 *     image; nothing here ever synthesizes, blends, or guesses a colour.
 *   - "Protected interior never geometrically distorted" — the interior is
 *     never touched or resampled by this module at all. Extension uses the
 *     EXACT SAME axis/leadingPx/trailingPx geometry `extend_uniform_
 *     background`/`pad_uniform_background` already use (`sign-transform-
 *     executor.ts`'s `executeExtend`), so the original image is blitted
 *     byte-for-byte into the final canvas exactly as it always has been —
 *     this module only changes what fills the ADDED region, never how the
 *     original content is placed.
 *   - "Affirmative deterministic evidence, never a guess" — reconstructable
 *     is `true` only when EVERY sampled row clears the SAME uniform-
 *     coverage bar `edge-inspection.ts` already uses for a `uniform_
 *     background` verdict (`UNIFORM_MIN_COVERAGE`, `EDGE_BACKGROUND_
 *     TOLERANCE`) — no new, unaudited threshold introduced for this module.
 *
 * WHY CORNER/HOLE INDICATORS ARE SAFE WITHOUT A DEDICATED DETECTOR: an
 * isolated mark (a mounting-hole indicator, a symbol) breaks row uniformity
 * at whatever row(s) it occupies — the SAME row-uniformity gate above
 * therefore refuses (not silently ignores) any band containing one,
 * because that row's measured coverage will not clear the bar. This
 * capability never repositions such marks; it correctly declines to
 * reconstruct a perimeter band that contains one at all, which is the
 * conservative, safe behavior the product-owner authorization requires
 * ("if their exact geometry cannot be inferred safely: require operator
 * review or block that component"). A future phase that wants to actually
 * detect and reposition such marks is new, separately-authorized work, not
 * an extension of this module.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { EDGE_BACKGROUND_TOLERANCE, UNIFORM_MIN_COVERAGE, edgeBandDepthPx } from "./edge-inspection";
import type { SignEdge } from "./contracts";

export interface SignPerimeterBandRow {
  r: number;
  g: number;
  b: number;
}

/**
 * One edge's reconstructability verdict. `rows` is populated (length ===
 * `bandDepthPx`) only when `reconstructable` is `true` — a refused
 * measurement never carries partial/unverified colour data a caller could
 * mistakenly use.
 */
export interface SignPerimeterBandMeasurement {
  edge: SignEdge;
  bandDepthPx: number;
  rows: SignPerimeterBandRow[];
  reconstructable: boolean;
  /** Internal rationale — never customer-facing copy, same discipline as `SignEdgeEvidence.reason`. */
  reason: string;
}

function chebyshev(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}

const BUCKET_SHIFT = 4;

/** One pixel line's own dominant-colour membership measurement — see `measureLine`'s own doc. */
export interface SignLineMeasurement {
  dominantColor: SignPerimeterBandRow | null;
  coverage: number;
  transparentFraction: number;
}

/**
 * Dominant-colour coverage of ONE pixel line — the same bucket/membership
 * technique `edge-inspection.ts` uses for a whole band, applied to a
 * single row/column. Exported (Structural Layout Reflow Phase 1) for
 * `sign-layout-segmentation.ts`'s own reuse — the identical measurement
 * this module already trusts for perimeter-band reconstructability,
 * applied to full-width rows instead of edge-band lines. No behavior
 * change to this module's own callers.
 */
export function measureLine(
  image: RgbaImage,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  length: number,
): SignLineMeasurement {
  const data = image.data;
  const bucketCount = new Map<number, number>();
  const bucketSum = new Map<number, [number, number, number]>();
  let transparent = 0;

  for (let k = 0; k < length; k++) {
    const x = x0 + k * dx;
    const y = y0 + k * dy;
    const i = (y * image.width + x) * 4;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
    if (a < 255) transparent++;
    const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT);
    bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
    const sums = bucketSum.get(key);
    if (sums) { sums[0] += r; sums[1] += g; sums[2] += b; }
    else bucketSum.set(key, [r, g, b]);
  }

  let dominantKey: number | null = null;
  let dominantN = 0;
  for (const [key, count] of bucketCount) {
    if (count > dominantN) { dominantN = count; dominantKey = key; }
  }
  if (dominantKey === null || length === 0) {
    return { dominantColor: null, coverage: 0, transparentFraction: length === 0 ? 0 : transparent / length };
  }
  const sums = bucketSum.get(dominantKey)!;
  const dominantColor: SignPerimeterBandRow = {
    r: Math.round(sums[0] / dominantN),
    g: Math.round(sums[1] / dominantN),
    b: Math.round(sums[2] / dominantN),
  };

  let members = 0;
  for (let k = 0; k < length; k++) {
    const x = x0 + k * dx;
    const y = y0 + k * dy;
    const i = (y * image.width + x) * 4;
    if (
      chebyshev(data[i]!, data[i + 1]!, data[i + 2]!, dominantColor.r, dominantColor.g, dominantColor.b) <=
        EDGE_BACKGROUND_TOLERANCE &&
      data[i + 3] === 255
    ) {
      members++;
    }
  }

  return { dominantColor, coverage: members / length, transparentFraction: transparent / length };
}

/**
 * Measures whether `edge`'s nearest `edgeBandDepthPx` rows/columns are each
 * independently, affirmatively uniform enough to tile outward. Pure; reads
 * pixels, changes nothing.
 */
export function measurePerimeterBand(image: RgbaImage, edge: SignEdge): SignPerimeterBandMeasurement {
  const depth = edgeBandDepthPx(image.width, image.height);
  const rows: SignPerimeterBandRow[] = [];

  for (let i = 0; i < depth; i++) {
    let x0: number, y0: number, dx: number, dy: number, length: number;
    switch (edge) {
      case "top":
        x0 = 0; y0 = i; dx = 1; dy = 0; length = image.width;
        break;
      case "bottom":
        x0 = 0; y0 = image.height - 1 - i; dx = 1; dy = 0; length = image.width;
        break;
      case "left":
        x0 = i; y0 = 0; dx = 0; dy = 1; length = image.height;
        break;
      case "right":
        x0 = image.width - 1 - i; y0 = 0; dx = 0; dy = 1; length = image.height;
        break;
    }
    const line = measureLine(image, x0, y0, dx, dy, length);
    if (
      !line.dominantColor ||
      line.coverage < UNIFORM_MIN_COVERAGE ||
      line.transparentFraction > 0
    ) {
      return {
        edge,
        bandDepthPx: depth,
        rows,
        reconstructable: false,
        reason:
          `line ${i} of ${depth} (measured inward from the ${edge} edge) is not affirmatively uniform ` +
          `(coverage ${line.coverage.toFixed(4)}) — this band is not safe to tile automatically`,
      };
    }
    rows.push(line.dominantColor);
  }

  return {
    edge,
    bandDepthPx: depth,
    rows,
    reconstructable: true,
    reason: `all ${depth} lines nearest the ${edge} edge are affirmatively uniform and tile safely`,
  };
}

/**
 * The tiled colour for one row/column at `distanceFromContentPx` pixels
 * outside the original content, given a reconstructable measurement.
 * Cycles through `rows` periodically — `rows[0]` (the line that was
 * originally AT the edge) sits immediately outside the new canvas's own
 * outer edge; `rows[bandDepthPx - 1]` (deepest measured line) sits
 * immediately adjacent to the original content. A genuinely periodic
 * source band (e.g. alternating stripes) therefore continues its own
 * period outward; a solid single colour (every row identical) degenerates
 * to exactly what `extend_uniform_background` already produces.
 */
export function tiledRowColor(
  measurement: SignPerimeterBandMeasurement,
  distanceFromContentPx: number,
): SignPerimeterBandRow {
  const depth = measurement.bandDepthPx;
  const index = (depth - 1 - (distanceFromContentPx % depth) + depth) % depth;
  return measurement.rows[index]!;
}
