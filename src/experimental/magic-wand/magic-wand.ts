/**
 * Phase 27C — EXPERIMENTAL / LOCAL-ONLY. Deterministic single-click
 * "magic wand" contiguous color selection, prototyped to test whether it
 * replaces Phase 27B's magnetic/live-wire tracing as the primary correction
 * interaction. This module is intentionally isolated under
 * `src/experimental/` — it is not wired into any production capability,
 * route, or schema.
 *
 * CORE SEMANTIC: a click does not mean "select every pixel of this color in
 * the image." It means "select the CONNECTED region of sufficiently similar
 * color reachable from this exact pixel, without crossing disconnected
 * areas that merely happen to share a color." Two visually identical but
 * physically separate black shapes (a bowling ball and a line of black
 * lettering elsewhere on the same artwork) must never be treated as one
 * selection just because they're both "black" — see the adversarial tests
 * in magic-wand.test.ts (cases A/B/C in the Phase 27C report).
 *
 * No semantic AI. No "dark = background" inference. No garment-color pixel
 * authority. `applyMagicWandCorrection`'s signature takes only
 * (current, source, mask, action) — there is no way to pass garment/preview
 * context into the geometry.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface Point {
  x: number;
  y: number;
}

export const MAGIC_WAND_ALGORITHM_VERSION = "magic-wand:v1";

/**
 * CONNECTIVITY CHOICE: 4-connected (not 8-connected).
 *
 * Reasoning (see Phase 27C report §7 "Connectivity choice"): 8-connectivity
 * lets a selection leak through a single diagonal pixel-to-pixel touch —
 * exactly the kind of incidental, geometrically-thin bridge Phase 17 warned
 * about ("connected to exterior" != "safe to treat as one region"). Two
 * shapes that only brush at a corner are usually perceived by a human as
 * separate objects, not one blob. 4-connectivity treats a single diagonal
 * touch as NOT connected, matching that perception and erring toward the
 * more conservative, more explainable selection. This is also the default
 * most raster paint tools (MS Paint's fill, GIMP's default select-by-color
 * contiguous mode) use for the same reason.
 *
 * 8-connectivity remains available (`connectivity: 8`) for comparison/
 * testing only — it is never the default and the lab UI never exposes it.
 */
export const DEFAULT_CONNECTIVITY: 4 | 8 = 4;

const NEIGHBORS_4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NEIGHBORS_8: ReadonlyArray<readonly [number, number]> = [
  ...NEIGHBORS_4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * TOLERANCE LADDER — grounded in measured real-asset color-distance data
 * (`measure-color-distances.mts`, run against the real INCREDI-BOWLS
 * artwork before picking these numbers, not fit to make one case pass):
 *
 *  - Within-a-single-object adjacent-pixel color noise: median ~5, p90 ~90
 *    (the ink mask spans multiple sub-colors, so "same object" noise alone
 *    isn't a clean signal — see report for detail).
 *  - Real ink/background boundary jumps: p10 ~11, median ~48, p90 ~170.
 *  - Distance between DIFFERENT solid-black objects on the same artwork
 *    (bowling ball vs. separate lettering/outline regions): most pairs sit
 *    at 0-12 (i.e., colorically near-identical) — meaning tolerance alone
 *    can never be the thing that keeps those apart. Connectivity is what
 *    keeps them apart (see DEFAULT_CONNECTIVITY above); the ladder only
 *    controls how far a selection can walk along one physically connected
 *    region before real edges stop it.
 *
 * LESS sits just above pure per-pixel noise. DEFAULT sits below the median
 * real boundary jump (so ordinary edges reliably stop growth). MORE sits
 * above the median boundary jump, deliberately risking a soft/faint edge
 * bridging through, for the operator to judge visually before applying.
 */
export const TOLERANCE_LEVELS = {
  less: 16,
  default: 32,
  more: 56,
} as const;

export type ToleranceLevel = keyof typeof TOLERANCE_LEVELS;

export function isToleranceLevel(value: unknown): value is ToleranceLevel {
  return value === "less" || value === "default" || value === "more";
}

/**
 * A selection whose pixel count exceeds this fraction of the total canvas
 * area is flagged `broad: true` for the UI to show an advisory warning
 * before Apply. This is a soft, non-blocking heuristic — not a
 * fixture-fitted threshold, and not something that blocks Apply on its own
 * (see report §9, "do not silently apply, but explicit Apply always
 * remains the operator's call").
 */
export const BROAD_SELECTION_CANVAS_FRACTION = 0.35;

function pixelColor(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

/** Euclidean distance across R, G, B, A — deterministic, no weighting. */
export function colorDistance(a: readonly number[], b: readonly number[]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  const da = a[3] - b[3];
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

export interface SelectionResult {
  mask: Uint8Array;
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number };
  touchesEdge: boolean;
  broad: boolean;
  seedColor: [number, number, number, number];
}

/**
 * Deterministic contiguous flood-fill selection.
 *
 * Every candidate pixel is compared to the ORIGINAL CLICKED PIXEL's color
 * (not to its immediate accepted neighbor). Comparing to a fixed seed,
 * rather than allowing neighbor-to-neighbor drift, is what stops the
 * selection from "walking" arbitrarily far across a smooth gradient one
 * small step at a time — the same class of flaw Phase 27B found in
 * percentile-normalized edge confidence (each local step looks fine; the
 * cumulative drift is not). See falsification case H (gradients) in the
 * Phase 27C report.
 */
export function floodFillSelect(
  image: RgbaImage,
  seed: Point,
  toleranceLevel: ToleranceLevel,
  connectivity: 4 | 8 = DEFAULT_CONNECTIVITY,
): SelectionResult {
  const { width, height } = image;
  if (seed.x < 0 || seed.x >= width || seed.y < 0 || seed.y >= height) {
    throw new Error("seed point is outside image bounds");
  }
  const tolerance = TOLERANCE_LEVELS[toleranceLevel];
  const neighbors = connectivity === 8 ? NEIGHBORS_8 : NEIGHBORS_4;
  const seedColor = pixelColor(image, seed.x, seed.y);

  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0;
  let qTail = 0;

  const seedIdx = seed.y * width + seed.x;
  visited[seedIdx] = 1;
  mask[seedIdx] = 1;
  queue[qTail] = seedIdx;
  qTail += 1;

  let left = seed.x;
  let right = seed.x;
  let top = seed.y;
  let bottom = seed.y;
  let touchesEdge = seed.x === 0 || seed.y === 0 || seed.x === width - 1 || seed.y === height - 1;
  let pixelCount = 1;

  while (qHead < qTail) {
    const idx = queue[qHead];
    qHead += 1;
    const x = idx % width;
    const y = Math.floor(idx / width);
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      const candidateColor = pixelColor(image, nx, ny);
      if (colorDistance(seedColor, candidateColor) > tolerance) continue;
      mask[nIdx] = 1;
      pixelCount += 1;
      if (nx < left) left = nx;
      if (nx > right) right = nx;
      if (ny < top) top = ny;
      if (ny > bottom) bottom = ny;
      if (nx === 0 || ny === 0 || nx === width - 1 || ny === height - 1) touchesEdge = true;
      queue[qTail] = nIdx;
      qTail += 1;
    }
  }

  const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const broad = pixelCount / (width * height) > BROAD_SELECTION_CANVAS_FRACTION;
  return { mask, pixelCount, bounds, touchesEdge, broad, seedColor };
}

export type CorrectionAction = "restore" | "remove";

/**
 * Applies a computed selection mask to the current image.
 *
 * `restore`: copies RGBA bytes byte-for-byte from `source` (the immutable
 * original) at every masked pixel. Never synthesizes, recolors, or
 * interpolates.
 * `remove`: zeroes alpha only at masked pixels; RGB is left untouched.
 *
 * Neither branch mutates its inputs — always operates on a fresh copy of
 * `current`. Pixels outside the mask are guaranteed byte-identical to
 * `current`.
 */
export function applyMagicWandCorrection(
  current: RgbaImage,
  source: RgbaImage,
  mask: Uint8Array,
  action: CorrectionAction,
): RgbaImage {
  const data = Buffer.from(current.data);
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const o = i * 4;
    if (action === "restore") {
      source.data.copy(data, o, o, o + 4);
    } else {
      data[o + 3] = 0;
    }
  }
  return { width: current.width, height: current.height, data };
}

/**
 * Phase 27D ADDITIVE/SUBTRACTIVE SELECTION — pure, additive helpers only.
 * Neither of these touches `floodFillSelect`'s algorithm, tolerance ladder,
 * or per-click semantics; they operate purely on already-computed masks/
 * click lists, preserving Phase 27C's deterministic single-click behavior
 * exactly.
 */

/** Bitwise-OR union of any number of same-size masks. Pure, order-independent. */
export function unionMasks(masks: readonly Uint8Array[]): Uint8Array {
  if (masks.length === 0) throw new Error("unionMasks requires at least one mask");
  const size = masks[0].length;
  const result = new Uint8Array(size);
  for (const mask of masks) {
    if (mask.length !== size) throw new Error("all masks must be the same size");
    for (let i = 0; i < size; i += 1) {
      if (mask[i]) result[i] = 1;
    }
  }
  return result;
}

/**
 * Subtractive selection ("Alt/Option + click on a pending selected region
 * removes that region from the pending selection"). Deterministic and
 * fully server-computable from raw intent alone: a click is dropped from
 * the pending list if, and only if, THAT click's own individually
 * recomputed flood-fill selection contains the alt-clicked pixel. No mask
 * is ever accepted from the client — `removeAt` is a single raw point, and
 * every mask used to decide the answer is recomputed here from
 * `floodFillSelect`, never trusted from a caller.
 *
 * This deliberately removes the ENTIRE connected region a prior click
 * produced (i.e., "undo that one earlier click"), not an arbitrary
 * sub-pixel carve — carving an arbitrary shape out of a mask would require
 * either a client-supplied mask (breaking server authority) or a new
 * raster-diff persisted as authority (breaking "persist raw intent, not
 * pixel masks"). Whole-click removal keeps both invariants intact.
 */
export function filterClicksContaining(
  authority: RgbaImage,
  clicks: readonly Point[],
  toleranceLevel: ToleranceLevel,
  connectivity: 4 | 8,
  removeAt: Point,
): Point[] {
  return clicks.filter((click) => {
    const result = floodFillSelect(authority, click, toleranceLevel, connectivity);
    const idx = removeAt.y * authority.width + removeAt.x;
    return !result.mask[idx];
  });
}

/**
 * Renders a selection overlay for display: a translucent fill plus a
 * two-tone (alternating light/dark) boundary outline, so the selection
 * remains legible over black, white, red, gold, and transparent artwork —
 * not relying on a single overlay color that could disappear against the
 * artwork underneath it (see Phase 27C report §6 / the Phase 14 region
 * highlight precedent).
 */
export function renderSelectionOverlay(base: RgbaImage, mask: Uint8Array): RgbaImage {
  const { width, height } = base;
  const data = Buffer.from(base.data);

  // Boundary = masked pixels adjacent to an unmasked (or out-of-bounds) pixel.
  const isBoundary = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      let boundary = false;
      for (const [dx, dy] of NEIGHBORS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) {
          boundary = true;
          break;
        }
      }
      if (boundary) isBoundary[idx] = 1;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const o = idx * 4;
      if (isBoundary[idx]) {
        // Two-tone marching-ants style boundary, alternating magenta and
        // cyan by position parity. Deliberately NOT white or black: either
        // of those would disappear entirely against real white or black
        // artwork (the two most common apparel background/ink colors).
        // Magenta and cyan are both highly saturated and mutually
        // contrasting, and stay visible against black, white, red, gold,
        // and gray alike (see Phase 27C report §6 verification).
        const bright = (x + y) % 6 < 3;
        if (bright) {
          data[o] = 255;
          data[o + 1] = 0;
          data[o + 2] = 200;
        } else {
          data[o] = 0;
          data[o + 1] = 255;
          data[o + 2] = 255;
        }
        data[o + 3] = 255;
      } else if (mask[idx]) {
        // Translucent cyan fill over the interior of the selection.
        data[o] = Math.round(data[o] * 0.6 + 0 * 0.4);
        data[o + 1] = Math.round(data[o + 1] * 0.6 + 220 * 0.4);
        data[o + 2] = Math.round(data[o + 2] * 0.6 + 255 * 0.4);
      }
    }
  }
  return { width, height, data };
}
