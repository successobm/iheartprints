/**
 * Phase 27I — TOOL-BASED BACKGROUND CLEANUP WORKSPACE V1.
 *
 * NEW, non-frozen algorithms for the two tools added alongside Magic Wand:
 * Restore Fill and the Restore Brush / Eraser stroke rasterizer. This file
 * does NOT modify, import from behavior-wise, or duplicate the frozen
 * flood-fill/tolerance/connectivity logic in `magic-wand-algorithm.ts` — it
 * only reuses that file's plain data types (`RgbaImage`, `Point`) and its
 * `DEFAULT_CONNECTIVITY` constant for consistency, and its ALREADY-generic
 * `applyMagicWandCorrection` (which cares only about a mask + "restore" vs
 * "remove", never about how the mask was derived) is reused unchanged by
 * the capability layer for both new tools' actual pixel writes.
 *
 * CORE AUTHORITY RULE (Phase 27I §0, restated): restored RGBA always comes
 * from the immutable original at the corresponding pixel; removal only ever
 * lowers alpha. Neither algorithm here writes a pixel itself — both only
 * ever produce a `mask: Uint8Array` for `applyMagicWandCorrection` to apply,
 * exactly like `floodFillSelect` already does for Magic Wand.
 */
import { DEFAULT_CONNECTIVITY, type Point, type RgbaImage } from "./magic-wand-algorithm";

export const FILL_ALGORITHM_VERSION = "restore-fill:v1";
export const BRUSH_ALGORITHM_VERSION = "brush-stroke:v1";

/**
 * V1 compact brush-size control (Phase 27I §D: "Small / Medium / Large OR
 * equivalent compact control"). Values are in image-space pixels, not
 * canvas/screen pixels, so brush footprint stays correct at any zoom level
 * (the capability layer only ever receives raw image-space points; the
 * radius is looked up here once and stored on the operation as a plain
 * number, never recomputed from a canvas-space size).
 */
export const BRUSH_RADIUS_LEVELS = {
  small: 6,
  medium: 14,
  large: 24,
} as const;
export type BrushSizeLevel = keyof typeof BRUSH_RADIUS_LEVELS;
export function isBrushSizeLevel(value: unknown): value is BrushSizeLevel {
  return value === "small" || value === "medium" || value === "large";
}

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

export interface TransparentComponentResult {
  mask: Uint8Array;
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  /** True if the connected transparent region reaches the image boundary — the ONLY thing that determines "unsafe" (see `isEnclosedComponent`). */
  touchesEdge: boolean;
}

/**
 * Phase 27I §C — Restore Fill's core algorithm.
 *
 * DELIBERATELY DIFFERENT from Magic Wand's `floodFillSelect`: this walks
 * connected pixels of the CURRENT RESULT'S TRANSPARENCY (alpha === 0), not
 * connected pixels of the ORIGINAL IMAGE'S COLOR. That distinction is the
 * entire reason this tool exists — the original's black bowling-ball fill
 * is colour-connected to the original's much larger black background
 * (Magic Wand can never safely separate them by colour), but once enough of
 * that background has been removed, the SPECIFIC missing pocket left
 * behind by the ball's fill can be a topologically distinct, ENCLOSED hole
 * in the current transparency map, independent of what colour any of it
 * used to be.
 *
 * "Missing" is exactly alpha === 0 — the same binary value
 * `applyMagicWandCorrection`'s "remove" branch already produces — never a
 * soft/fractional threshold.
 */
export function computeTransparentComponent(
  image: RgbaImage,
  seed: Point,
  connectivity: 4 | 8 = DEFAULT_CONNECTIVITY,
): TransparentComponentResult {
  const { width, height } = image;
  if (seed.x < 0 || seed.x >= width || seed.y < 0 || seed.y >= height) {
    throw new Error("seed point is outside image bounds");
  }
  const isMissing = (idx: number) => image.data[idx * 4 + 3] === 0;

  const seedIdx = seed.y * width + seed.x;
  if (!isMissing(seedIdx)) {
    // Clicked on a pixel that isn't missing at all -- nothing to fill here,
    // exactly like Magic Wand's "click didn't match" empty-selection case.
    return { mask: new Uint8Array(width * height), pixelCount: 0, bounds: null, touchesEdge: false };
  }

  const neighbors = connectivity === 8 ? NEIGHBORS_8 : NEIGHBORS_4;
  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0;
  let qTail = 0;

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
      if (!isMissing(nIdx)) continue;
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
  return { mask, pixelCount, bounds, touchesEdge };
}

/**
 * Phase 27I §C safety gate — a single, purely topological signal, not a
 * fixture-fitted number: a transparent component that touches the image
 * boundary is, by construction, connected to "the outside" (the canvas
 * exterior/background is always border-connected) and is never safe to
 * one-click-restore. A component that does NOT touch the boundary is fully
 * enclosed by non-missing pixels on every side — an actual bounded pocket,
 * regardless of its size. This is the only hard gate; V1 deliberately does
 * NOT add a size-based hard refusal on top of it (see the module doc and
 * the Phase 27I report's Fill-safety section for why: a size threshold
 * would be exactly the kind of fixture-fitted number this phase was told
 * to avoid, and border-connectivity already rules out the dangerous case
 * -- an enormous but genuinely enclosed hole is a legitimate, if unusual,
 * one-click restoration).
 */
export function isEnclosedComponent(component: Pick<TransparentComponentResult, "touchesEdge">): boolean {
  return !component.touchesEdge;
}

export interface StrokeRasterResult {
  mask: Uint8Array;
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
}

/**
 * Phase 27I §D/E — deterministic brush/eraser stroke rasterizer, shared by
 * Restore Brush and Eraser (they differ only in which `applyMagicWandCorrection`
 * action the capability layer applies to the resulting mask, "restore" vs
 * "remove" -- this function has no opinion about that).
 *
 * Pure function of (points, radius, width, height) only -- no timing, no
 * randomness, no client-supplied raster mask. A stroke is stored as raw
 * image-space points (already integer-rounded by the client) plus a
 * radius; replaying the SAME points+radius always produces the SAME mask.
 *
 * "No gaps caused by pointer-event spacing": stamps a filled circle at the
 * first point, then walks each subsequent segment and stamps additional
 * circles at a fixed sub-radius interval (half the radius) so consecutive
 * stamps always overlap, regardless of how far apart two consecutive
 * pointer-move samples happened to land.
 */
export function rasterizeStroke(points: readonly Point[], radius: number, width: number, height: number): StrokeRasterResult {
  const mask = new Uint8Array(width * height);
  if (points.length === 0 || radius <= 0 || width <= 0 || height <= 0) {
    return { mask, pixelCount: 0, bounds: null };
  }

  const r2 = radius * radius;
  function stampAt(cx: number, cy: number) {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = minY; y <= maxY; y += 1) {
      const dy = y - cy;
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
      }
    }
  }

  stampAt(points[0].x, points[0].y);
  const step = Math.max(1, radius * 0.5);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist === 0) continue;
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      stampAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }

  let pixelCount = 0;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    pixelCount += 1;
    const x = i % width;
    const y = Math.floor(i / width);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const bounds = pixelCount > 0 ? { left, top, width: right - left + 1, height: bottom - top + 1 } : null;
  return { mask, pixelCount, bounds };
}
