/**
 * Existing Artwork → Print Ready Phase 1.2: isolated near-background residue.
 *
 * ## The problem this exists to solve
 *
 * The exterior fill and the cavity pass both remove pixels that are WITHIN
 * TOLERANCE of the estimated background. A real export is not that tidy. On
 * the audited bowling artwork the background is (1,1,1) with a fill tolerance
 * of 12, and the encoder left a scatter of pixels at channel distance 13–24 —
 * just past the cut. Every one of them is invisible against the black they
 * came from, and every one of them becomes a black dot the moment the
 * background goes away. The prepared file carried 488 of them, and on a light
 * garment they read as a dotted outline traced around the whole design.
 *
 * ## Why this is NOT "widen the tolerance"
 *
 * Widening the fill tolerance to 24 would apply that looser test to the entire
 * image, including the customer's intentional dark line work — the same line
 * work the whole pipeline exists to protect. The bowling artwork has 34,392
 * dark foreground pixels; a global widening would put thousands of them inside
 * the background model and let the flood fill march straight through them.
 *
 * The residue is distinguishable from artwork not by its COLOUR but by its
 * TOPOLOGY: it is a fleck floating in space with no connection to anything.
 * That is a much stronger and much narrower piece of evidence, and it is what
 * this pass gates on.
 *
 * ## The evidence this pass requires, all of it, for every island
 *
 * 1. FULLY ISOLATED. The component of retained pixels is surrounded on every
 *    side by pixels the earlier passes ALREADY removed (or by the image
 *    border). Not "mostly surrounded", not "thin" — every neighbour outside
 *    the component is confirmed background. A pixel touching real artwork is
 *    part of real artwork, and this pass cannot see it.
 * 2. TINY. At most `SPECKLE_MAX_ISLAND_PX` pixels.
 * 3. NEAR-BACKGROUND. Every pixel in it is within
 *    `SPECKLE_BACKGROUND_DISTANCE_MULTIPLIER` x the confirmed fill tolerance
 *    of the confirmed background colour — expressed against the SAME colour
 *    and the SAME metric the fill used, so a noisier export gets a
 *    proportionally wider allowance and a clean one gets none to speak of.
 *
 * Rule 1 is what makes this safe, and it is why the pass needs no notion of
 * "near the edge" at all: an island enclosed by removed background is, by
 * construction, adjacent to removed background. Nothing deeper than one pixel
 * from an already-removed boundary can qualify.
 *
 * ## What the real file measured
 *
 * 488 isolated islands, 520 pixels. Sizes 1px (463), 2px (19), 3px (5), 4px
 * (1) — and then NOTHING until 21px, where the artwork's own smallest retained
 * component begins. `SPECKLE_MAX_ISLAND_PX = 4` sits inside a genuine gap in
 * the data rather than on a slope. Colour: channel distance 13 (min) to 24
 * (max), median 14; a limit of 2 x 12 = 24 catches all 488 and a limit of 21
 * catches 487.
 *
 * ## Direction of error
 *
 * Same as everywhere else in this pipeline: AMBIGUITY PRESERVES. A retained
 * fleck is a blemish; a destroyed one is artwork nobody can get back. A
 * deliberate 1px accent floating in the background — a star, a spark, a bit of
 * confetti — fails rule 3 by a mile and is never touched.
 *
 * Pure: no I/O, no codec, no provider, no randomness.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { RgbColor } from "./contracts";
import { channelDistance } from "./pixel-metrics";

/**
 * Largest isolated island this pass may remove, in pixels.
 *
 * Four is the largest island the audited artwork actually produced. The next
 * retained component in that image is 21px, so this threshold sits in an empty
 * five-fold gap rather than cutting through a continuous distribution. Raising
 * it buys nothing measured and starts spending that gap.
 */
export const SPECKLE_MAX_ISLAND_PX = 4;

/**
 * How far past the confirmed fill tolerance an island pixel may sit and still
 * read as background residue, as a multiple of that tolerance.
 *
 * Two, because the residue is by definition the population the fill JUST
 * missed: on the audited file every island pixel landed between 13 and 24
 * against a tolerance of 12. Expressed as a multiplier rather than an absolute
 * so it tracks the analyzer's own measurement of how noisy this particular
 * export is, instead of hard-coding one file's encoder.
 */
export const SPECKLE_BACKGROUND_DISTANCE_MULTIPLIER = 2;

export interface BackgroundSpeckleOptions {
  backgroundColor: RgbColor;
  tolerance: number;
}

/** One isolated island the pass considered, removed or not. Internal diagnostics. */
export interface BackgroundSpeckleIsland {
  pixelCount: number;
  /** Largest channel distance from the background found in the island. */
  maxChannelDistance: number;
  removed: boolean;
}

export interface BackgroundSpeckleResult {
  /** The input mask UNION every island this pass confirmed is residue. */
  mask: Uint8Array;
  removedIslandCount: number;
  removedPixelCount: number;
  /**
   * Isolated islands that were considered and REFUSED — too large, or too far
   * from the background to be residue. Reported because a rising count here is
   * how "this pass started meeting real artwork" would first show up.
   */
  preservedIslandCount: number;
  preservedPixelCount: number;
}

/**
 * Extends `mask` with tiny, fully-enclosed, near-background islands of
 * otherwise-retained pixels.
 *
 * Never mutates the input mask; the returned mask is a copy. The image is
 * read-only throughout.
 *
 * ONE PASS IS ENOUGH, and deliberately so: an island qualifies only when it
 * has no retained neighbour, so removing it cannot isolate anything that was
 * not already isolated. Iterating could only creep outward from a boundary
 * that just moved, which is precisely the erosion this pass must not do.
 */
export function expandMaskWithBackgroundSpeckle(
  image: RgbaImage,
  mask: Uint8Array,
  options: BackgroundSpeckleOptions,
): BackgroundSpeckleResult {
  const { width, height, data } = image;
  const total = width * height;
  const next = Uint8Array.from(mask);

  const limit = options.tolerance * SPECKLE_BACKGROUND_DISTANCE_MULTIPLIER;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const island = new Int32Array(SPECKLE_MAX_ISLAND_PX + 1);

  let removedIslandCount = 0;
  let removedPixelCount = 0;
  let preservedIslandCount = 0;
  let preservedPixelCount = 0;

  for (let start = 0; start < total; start += 1) {
    if (mask[start] === 1 || visited[start] === 1) continue;

    // Flood the component of retained pixels containing `start`, stopping the
    // moment it grows past what this pass may ever remove. The component is
    // still fully marked visited so the scan never re-enters it.
    let top = 0;
    let size = 0;
    let overflowed = false;
    let maxDistance = 0;
    visited[start] = 1;
    stack[top++] = start;

    while (top > 0) {
      const pixel = stack[--top]!;
      if (size <= SPECKLE_MAX_ISLAND_PX) island[size] = pixel;
      size += 1;
      if (size > SPECKLE_MAX_ISLAND_PX) overflowed = true;
      if (!overflowed) {
        const distance = channelDistance(data, pixel * 4, options.backgroundColor);
        if (distance > maxDistance) maxDistance = distance;
      }

      const x = pixel % width;
      const y = (pixel - x) / width;
      const visit = (neighbor: number): void => {
        if (mask[neighbor] === 1 || visited[neighbor] === 1) return;
        visited[neighbor] = 1;
        stack[top++] = neighbor;
      };

      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (y > 0) visit(pixel - width);
      if (y < height - 1) visit(pixel + width);
    }

    // Evidence 1 is implicit: the flood above spreads through every retained
    // neighbour, so a component that stayed small IS one whose entire border
    // is already-removed background or the image edge.
    if (overflowed) continue;

    // Evidence 3: still background-coloured, just past where the fill cut.
    // An already-invisible pixel is not residue anyone can see, so it is left
    // for the alpha pass rather than counted as work done here.
    const removable = maxDistance <= limit;
    if (removable) {
      removedIslandCount += 1;
      removedPixelCount += size;
      for (let i = 0; i < size; i += 1) next[island[i]!] = 1;
    } else {
      preservedIslandCount += 1;
      preservedPixelCount += size;
    }
  }

  return {
    mask: next,
    removedIslandCount,
    removedPixelCount,
    preservedIslandCount,
    preservedPixelCount,
  };
}
