/**
 * Existing Artwork → Print Ready Phase 1: the low-level pixel predicates that
 * both background passes must agree on.
 *
 * These lived inside `background-isolation.ts` until the enclosed-cavity pass
 * needed the identical definitions. Two modules that each decide for
 * themselves what "matches the background" means would eventually disagree,
 * and the whole safety argument for cavity removal rests on the cavity pass
 * using the SAME membership test the exterior fill used — so the test lives in
 * exactly one place.
 *
 * Pure arithmetic. No I/O, no allocation, no state.
 */

import type { RgbColor } from "./contracts";

/**
 * Alpha at or above this counts as real artwork. Matches
 * `alpha-trim.ts`'s `DEFAULT_ALPHA_THRESHOLD` deliberately — soft glows and
 * anti-aliased outer edges are printable content, and the modules must agree
 * on what "visible" means or a prepared asset would be trimmed differently
 * than it was analyzed.
 */
export const VISIBLE_ALPHA_THRESHOLD = 8;

/**
 * How far from the background a colour must be (Euclidean RGB, 0–441) to
 * count as genuinely FOREGROUND rather than a blend of the two.
 *
 * Used in two places, for the same underlying reason. The fringe pass needs a
 * solid reference colour to undo a background composite against, and the
 * cavity pass needs evidence that the wall enclosing a candidate region is
 * real artwork rather than more almost-background. Both are asking "is this
 * pixel distinct enough from the background to reason about?", so both ask it
 * with one number.
 */
export const SOLID_REFERENCE_MIN_DISTANCE = 48;

/**
 * Per-channel (Chebyshev) distance between two colours — the metric the fill
 * tolerance is expressed in. The buffer-indexed `channelDistance` below is
 * this same formula applied to one pixel of an image; kept as one function
 * so a colour-to-colour comparison (e.g. confirmed garment vs detected
 * background) can never drift from the per-pixel membership test.
 */
export function channelDistanceBetweenColors(a: RgbColor, b: RgbColor): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** Per-channel (Chebyshev) distance — the metric the fill tolerance is expressed in. */
export function channelDistance(
  data: Buffer,
  idx: number,
  color: RgbColor,
): number {
  return channelDistanceBetweenColors(
    { r: data[idx]!, g: data[idx + 1]!, b: data[idx + 2]! },
    color,
  );
}

/** Euclidean RGB distance (0–441) — the metric magnitude comparisons need. */
export function colorDistance(
  data: Buffer,
  idx: number,
  color: RgbColor,
): number {
  const dr = data[idx]! - color.r;
  const dg = data[idx + 1]! - color.g;
  const db = data[idx + 2]! - color.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * THE background-membership test. A pixel reads as background when it is
 * already effectively invisible, or when its colour is within tolerance of the
 * estimated background colour.
 *
 * Note what this does NOT say: nothing here decides that such a pixel may be
 * REMOVED. Membership is a colour fact; removal additionally requires
 * affirmative evidence that the pixel belongs to the detected background —
 * border reachability for the exterior fill, or the cavity evidence in
 * `background-cavities.ts`.
 */
export function matchesBackgroundColor(
  data: Buffer,
  idx: number,
  color: RgbColor,
  tolerance: number,
): boolean {
  if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) return true;
  return channelDistance(data, idx, color) <= tolerance;
}
