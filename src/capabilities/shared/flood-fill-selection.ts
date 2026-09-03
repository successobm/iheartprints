/**
 * Wand-First Correction UX Phase: the pure, deterministic, framework-free
 * contiguous-region flood-fill selection algorithm — extracted from
 * `src/capabilities/artwork-preparation/magic-wand-algorithm.ts` (DTF's
 * "Magic Wand" tool) into a genuinely shared, capability-neutral location so
 * a Signs wand tool can consume the IDENTICAL, already-proven algorithm
 * without a second implementation and without importing across the
 * `artwork-preparation` capability boundary.
 *
 * This is a RELOCATION, not a rewrite: every byte of logic below is
 * unchanged from the DTF file as it stood at extraction time.
 * `magic-wand-algorithm.ts` now imports from here and re-exports the exact
 * same names, so every existing DTF call site keeps working unchanged — see
 * that file's own doc comment. DTF's own DTF-only concepts
 * (`applyMagicWandCorrection`'s alpha-zero "remove"/byte-copy "restore"
 * semantics, and the `CorrectionAction` type) deliberately stay in the DTF
 * file — they are not artwork-selection primitives, they are DTF's own
 * delete/restore policy, and Signs has its own, different delete policy
 * (masked background replacement — never transparency; see
 * `sign-wand-correction.ts`).
 *
 * FROZEN per the same Phase 27E mandate `magic-wand-algorithm.ts` already
 * carried: the flood-fill algorithm, connectivity choice, tolerance ladder,
 * and byte invariants below must not change without a demonstrated
 * integration bug (not a UX preference) — now doubly true, since DTF is
 * still built directly on this exact code path.
 *
 * CORE SEMANTIC: a click does not mean "select every pixel of this color in
 * the image." It means "select the CONNECTED region of sufficiently similar
 * color reachable from this exact pixel, without crossing disconnected
 * areas that merely happen to share a color." See `magic-wand-algorithm.ts`
 * and the original `src/experimental/magic-wand/magic-wand.test.ts` for the
 * full adversarial-case rationale this algorithm was proven against.
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

export const FLOOD_FILL_ALGORITHM_VERSION = "magic-wand:v1";

/**
 * CONNECTIVITY CHOICE: 4-connected (not 8-connected) — see
 * `magic-wand-algorithm.ts`'s own doc for the full rationale (a single
 * diagonal touch must never bridge two otherwise-separate shapes).
 * 8-connectivity remains available (`connectivity: 8`) for comparison/
 * testing only — it is never a UI default.
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
 * TOLERANCE LADDER — grounded in measured real-asset color-distance data;
 * see `magic-wand-algorithm.ts`'s own doc comment for the full derivation.
 * Unchanged from DTF's own values — both products share the identical
 * ladder, not a coincidentally-similar one.
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
 * before Apply. Soft, non-blocking — never refuses the selection itself.
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
 * Deterministic contiguous flood-fill selection. Every candidate pixel is
 * compared to the ORIGINAL CLICKED PIXEL's color (never to its immediate
 * accepted neighbor) — see `magic-wand-algorithm.ts`'s own doc for why this
 * is what stops selections from "walking" across smooth gradients.
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

/**
 * Phase 27D ADDITIVE/SUBTRACTIVE SELECTION — pure, additive helpers only.
 * See `magic-wand-algorithm.ts`'s own doc for the full "persist raw intent,
 * never a mask" invariant these were built to preserve.
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
 * removes that region from the pending selection") — see
 * `magic-wand-algorithm.ts`'s own doc for the full rationale. No mask is
 * ever accepted from the client; every mask used to decide the answer is
 * recomputed here from `floodFillSelect`.
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
 * remains legible over black, white, red, gold, and transparent artwork.
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
        // cyan by position parity — never white/black (would disappear
        // against common artwork colors).
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

/**
 * True iff `mask` fills every pixel of its own `bounds` rectangle exactly
 * (no interior gaps, no pixels selected outside `bounds`). A wand selection
 * that passes this check is provably identical to its bounding rectangle —
 * safe to hand to any rectangle-only primitive (e.g. Signs' governed
 * edge-intent classification) without risking that the rectangle covers any
 * pixel the operator did not actually select. A selection that FAILS this
 * check (a circle, a notch, an L-shape, a ring) must never be silently
 * widened to its bounding rectangle for such a use — see
 * `sign-wand-correction.ts`'s own doc for why.
 */
export function maskExactlyFillsBounds(mask: Uint8Array, width: number, bounds: SelectionResult["bounds"]): boolean {
  for (let y = bounds.top; y < bounds.top + bounds.height; y++) {
    const rowStart = y * width;
    for (let x = bounds.left; x < bounds.left + bounds.width; x++) {
      if (!mask[rowStart + x]) return false;
    }
  }
  return true;
}
