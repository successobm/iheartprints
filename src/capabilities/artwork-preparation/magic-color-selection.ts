/**
 * Existing Artwork → Print Ready Phase 1.7 / 1.7B: Magic Select.
 *
 * Customer-controlled colour selection. NOT automatic background detection
 * and NOT naive "select all similar colour everywhere".
 *
 * Phase 1.7B: a residue-like click (thin, exterior-facing, small component)
 * magnetically attracts other pixels of the same structural class within the
 * customer's Chebyshev colour tolerance. Artwork-like clicks (thick outlines,
 * enclosed interiors, holes) fall back to the original 4-connected wand.
 *
 * The mode split is INTERNAL — there is no customer Connected/Similar toggle.
 * Tolerance controls colour distance only; topology/thickness/size gates are
 * fixed.
 *
 * Pure: no I/O, no provider, no randomness, no product-specific geometry.
 */

import { createHash } from "node:crypto";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { ArtworkBounds, RgbColor } from "./contracts";
import type { GuidedRemovalPoint } from "./guided-removal";
import {
  channelDistance,
  VISIBLE_ALPHA_THRESHOLD,
} from "./pixel-metrics";

/** Customer-facing default — conservative so residue clicks stay local. */
export const MAGIC_SELECT_DEFAULT_TOLERANCE = 8;
export const MAGIC_SELECT_TOLERANCE_STEP = 2;
export const MAGIC_SELECT_TOLERANCE_MIN = 0;
export const MAGIC_SELECT_TOLERANCE_MAX = 40;

/** Connected-only key/replay semantics (Phase 1.7). */
export const MAGIC_SELECT_RULE_V1 = "magic-select:v1";
/** Seed-fingerprint dispatcher + magnetic similar (Phase 1.7B). */
export const MAGIC_SELECT_RULE_V2 = "magic-select:v2";

/**
 * Maximum local visible thickness (pixels) for a residue-like seed/candidate.
 * Audited Model E: thickness ≤ 2. Tolerance must never loosen this.
 */
export const MAGIC_SELECT_RESIDUE_MAX_THICKNESS = 2;

/**
 * Maximum 4-connected visible component size for residue-like pixels.
 * Audited Model E size cap. Protects anti-aliased edges of large letterforms.
 * Tolerance must never loosen this.
 */
export const MAGIC_SELECT_RESIDUE_MAX_COMPONENT = 80;

/**
 * Fixed Chebyshev radius that defines the seed's structural colour class for
 * component size. Independent of customer Tolerance — raising the slider must
 * not merge thin specks into nearby letterforms.
 */
export const MAGIC_SELECT_STRUCTURAL_COLOR_GATE = 16;

/**
 * When the seed itself is this dark, thickness is measured in dark visible
 * ink (same luma threshold as Phase 1.6 fringe). That keeps outline edges
 * thick even when brown anti-aliasing interrupts the seed-colour run.
 */
export const MAGIC_SELECT_DARK_LUMA = 64;

/** 4-connected neighbours — matches exterior fill / cavity topology. */
const FOUR_CONNECTED: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export type MagicSelectOutcome =
  | "eligible"
  | "outside_image"
  | "already_removed";

export type MagicSelectionMode = "connected" | "similar";

export interface MagicSelectResult {
  outcome: MagicSelectOutcome;
  /** Present only when `outcome === "eligible"`. */
  selection: MagicColorSelection | null;
}

export interface MagicColorSelection {
  point: GuidedRemovalPoint;
  tolerance: number;
  /** True iff the resolved mode is connected (Phase 1.7 field, still persisted). */
  connectedOnly: boolean;
  selectionMode: MagicSelectionMode;
  ruleVersion: string;
  referenceColor: RgbColor;
  /** Opaque identity of the selected set — for tokens and idempotency. */
  selectionKey: string;
  pixelCount: number;
  bounds: ArtworkBounds;
  /** 1 = selected. Length = width * height. */
  mask: Uint8Array;
}

interface ResidueFeatures {
  distClear: Uint16Array;
  thickness: Uint8Array;
  componentSizeAt: Int32Array;
}

function lumaAt(data: Buffer, idx: number): number {
  return 0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!;
}

/**
 * Clamp a customer tolerance to the Phase 1.7 bounds. Non-finite values fall
 * back to the default.
 */
export function clampMagicSelectTolerance(value: number): number {
  if (!Number.isFinite(value)) return MAGIC_SELECT_DEFAULT_TOLERANCE;
  const stepped = Math.round(value);
  return Math.min(
    MAGIC_SELECT_TOLERANCE_MAX,
    Math.max(MAGIC_SELECT_TOLERANCE_MIN, stepped),
  );
}

/**
 * Phase 1.7B entry point. Classifies the seed once, then either magnetically
 * selects disconnected residue-class pixels or falls back to 4-connected.
 */
export function selectMagicColor(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  toleranceInput: number,
): MagicSelectResult {
  const prepared = prepareSeed(image, point, toleranceInput);
  if (prepared.outcome !== "eligible") {
    return { outcome: prepared.outcome, selection: null };
  }

  const features = buildResidueFeatures(image, prepared.referenceColor, prepared.seed);
  if (isResidueLikePixel(features, prepared.seed)) {
    return finishSimilarSelection(image, prepared, features);
  }
  return finishConnectedSelection(image, prepared);
}

/**
 * Connected similar-colour selection from a click on the CURRENT prepared
 * image. Compares every reachable visible pixel to the SEED colour (not to
 * its neighbour), so the match stays anchored to what the customer clicked.
 *
 * Kept as the Phase 1.7 primitive so old `magic-select:v1` operations replay
 * without ever entering the magnetic path.
 */
export function selectConnectedMagicColor(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  toleranceInput: number,
): MagicSelectResult {
  const prepared = prepareSeed(image, point, toleranceInput);
  if (prepared.outcome !== "eligible") {
    return { outcome: prepared.outcome, selection: null };
  }
  return finishConnectedSelection(image, prepared);
}

/**
 * Global magnetic selection: colour within tolerance AND the residue
 * structural class (thin, exterior-facing, small component). Does not
 * re-classify the seed — callers that persist `selectionMode: "similar"`
 * must replay through this path so the mode is not re-inferred.
 */
export function selectSimilarMagicColor(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  toleranceInput: number,
): MagicSelectResult {
  const prepared = prepareSeed(image, point, toleranceInput);
  if (prepared.outcome !== "eligible") {
    return { outcome: prepared.outcome, selection: null };
  }
  return finishSimilarSelection(
    image,
    prepared,
    buildResidueFeatures(image, prepared.referenceColor, prepared.seed),
  );
}

/**
 * Replay a persisted Magic Select op using its stored mode. Never re-infers
 * residue-like from the seed — that would let a later algorithm change
 * rewrite history.
 */
export function selectMagicColorByMode(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  toleranceInput: number,
  selectionMode: MagicSelectionMode,
): MagicSelectResult {
  if (selectionMode === "similar") {
    return selectSimilarMagicColor(image, point, toleranceInput);
  }
  return selectConnectedMagicColor(image, point, toleranceInput);
}

export function isResidueLikeSeed(
  image: RgbaImage,
  point: GuidedRemovalPoint,
): boolean {
  const { width, height, data } = image;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const seed = y * width + x;
  if (data[seed * 4 + 3]! < VISIBLE_ALPHA_THRESHOLD) return false;
  const referenceColor: RgbColor = {
    r: data[seed * 4]!,
    g: data[seed * 4 + 1]!,
    b: data[seed * 4 + 2]!,
  };
  return isResidueLikePixel(buildResidueFeatures(image, referenceColor, seed), seed);
}

/**
 * Sets selected pixels to alpha 0. RGB is left unchanged (prepared-asset
 * convention — invisible colour may still feed a later halo/resample path).
 * Mutates `image` in place; callers own a working buffer.
 */
export function eraseMagicSelection(image: RgbaImage, mask: Uint8Array): number {
  const { data } = image;
  let erased = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel] !== 1) continue;
    data[pixel * 4 + 3] = 0;
    erased += 1;
  }
  return erased;
}

interface PreparedSeed {
  outcome: "eligible";
  x: number;
  y: number;
  seed: number;
  tolerance: number;
  referenceColor: RgbColor;
}

function prepareSeed(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  toleranceInput: number,
): PreparedSeed | { outcome: "outside_image" | "already_removed" } {
  const { width, height, data } = image;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  const tolerance = clampMagicSelectTolerance(toleranceInput);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { outcome: "outside_image" };
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return { outcome: "outside_image" };
  }

  const seed = y * width + x;
  const seedIdx = seed * 4;
  if (data[seedIdx + 3]! < VISIBLE_ALPHA_THRESHOLD) {
    return { outcome: "already_removed" };
  }

  return {
    outcome: "eligible",
    x,
    y,
    seed,
    tolerance,
    referenceColor: {
      r: data[seedIdx]!,
      g: data[seedIdx + 1]!,
      b: data[seedIdx + 2]!,
    },
  };
}

function finishConnectedSelection(
  image: RgbaImage,
  prepared: PreparedSeed,
): MagicSelectResult {
  const { width, height, data } = image;
  const { x, y, seed, tolerance, referenceColor } = prepared;

  const mask = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  stack[top++] = seed;
  mask[seed] = 1;

  let pixelCount = 0;
  let left = x;
  let right = x + 1;
  let topBound = y;
  let bottom = y + 1;
  let lowestPixel = seed;

  while (top > 0) {
    const pixel = stack[--top]!;
    pixelCount += 1;
    if (pixel < lowestPixel) lowestPixel = pixel;

    const px = pixel % width;
    const py = (pixel - px) / width;
    if (px < left) left = px;
    if (px + 1 > right) right = px + 1;
    if (py < topBound) topBound = py;
    if (py + 1 > bottom) bottom = py + 1;

    for (const [dx, dy] of FOUR_CONNECTED) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (mask[neighbor] === 1) continue;

      const nIdx = neighbor * 4;
      if (data[nIdx + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;
      if (channelDistance(data, nIdx, referenceColor) > tolerance) continue;

      mask[neighbor] = 1;
      stack[top++] = neighbor;
    }
  }

  return eligibleResult({
    image,
    point: { x, y },
    tolerance,
    referenceColor,
    mask,
    pixelCount,
    lowestPixel,
    bounds: {
      left,
      top: topBound,
      right,
      bottom,
      width: right - left,
      height: bottom - topBound,
    },
    selectionMode: "connected",
    ruleVersion: MAGIC_SELECT_RULE_V1,
  });
}

function finishSimilarSelection(
  image: RgbaImage,
  prepared: PreparedSeed,
  features: ResidueFeatures,
): MagicSelectResult {
  const { width, height, data } = image;
  const { x, y, seed, tolerance, referenceColor } = prepared;
  const n = width * height;
  const mask = new Uint8Array(n);

  let pixelCount = 0;
  let left = x;
  let right = x + 1;
  let topBound = y;
  let bottom = y + 1;
  let lowestPixel = seed;

  for (let pixel = 0; pixel < n; pixel += 1) {
    const idx = pixel * 4;
    if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;
    if (!isResidueLikePixel(features, pixel)) continue;
    if (channelDistance(data, idx, referenceColor) > tolerance) continue;

    mask[pixel] = 1;
    pixelCount += 1;
    if (pixel < lowestPixel) lowestPixel = pixel;
    const px = pixel % width;
    const py = (pixel - px) / width;
    if (px < left) left = px;
    if (px + 1 > right) right = px + 1;
    if (py < topBound) topBound = py;
    if (py + 1 > bottom) bottom = py + 1;
  }

  if (mask[seed] !== 1) {
    mask[seed] = 1;
    pixelCount += 1;
  }

  return eligibleResult({
    image,
    point: { x, y },
    tolerance,
    referenceColor,
    mask,
    pixelCount,
    lowestPixel,
    bounds: {
      left,
      top: topBound,
      right,
      bottom,
      width: right - left,
      height: bottom - topBound,
    },
    selectionMode: "similar",
    ruleVersion: MAGIC_SELECT_RULE_V2,
  });
}

function eligibleResult(input: {
  image: RgbaImage;
  point: GuidedRemovalPoint;
  tolerance: number;
  referenceColor: RgbColor;
  mask: Uint8Array;
  pixelCount: number;
  lowestPixel: number;
  bounds: ArtworkBounds;
  selectionMode: MagicSelectionMode;
  ruleVersion: string;
}): MagicSelectResult {
  const { width, height } = input.image;
  return {
    outcome: "eligible",
    selection: {
      point: input.point,
      tolerance: input.tolerance,
      connectedOnly: input.selectionMode === "connected",
      selectionMode: input.selectionMode,
      ruleVersion: input.ruleVersion,
      referenceColor: input.referenceColor,
      selectionKey: magicSelectionKey({
        ruleVersion: input.ruleVersion,
        selectionMode: input.selectionMode,
        width,
        height,
        point: input.point,
        tolerance: input.tolerance,
        referenceColor: input.referenceColor,
        pixelCount: input.pixelCount,
        lowestPixel: input.lowestPixel,
        mask: input.mask,
      }),
      pixelCount: input.pixelCount,
      bounds: input.bounds,
      mask: input.mask,
    },
  };
}

function isResidueLikePixel(features: ResidueFeatures, pixel: number): boolean {
  return (
    features.distClear[pixel] === 1 &&
    features.thickness[pixel]! > 0 &&
    features.thickness[pixel]! <= MAGIC_SELECT_RESIDUE_MAX_THICKNESS &&
    features.componentSizeAt[pixel]! > 0 &&
    features.componentSizeAt[pixel]! <= MAGIC_SELECT_RESIDUE_MAX_COMPONENT
  );
}

function inSeedColourClass(
  data: Buffer,
  pixel: number,
  referenceColor: RgbColor,
): boolean {
  const idx = pixel * 4;
  if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) return false;
  return channelDistance(data, idx, referenceColor) <= MAGIC_SELECT_STRUCTURAL_COLOR_GATE;
}

function inThicknessClass(
  data: Buffer,
  pixel: number,
  referenceColor: RgbColor,
  seedIsDark: boolean,
): boolean {
  const idx = pixel * 4;
  if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) return false;
  if (seedIsDark) return lumaAt(data, idx) < MAGIC_SELECT_DARK_LUMA;
  return channelDistance(data, idx, referenceColor) <= MAGIC_SELECT_STRUCTURAL_COLOR_GATE;
}

/**
 * Generic raster features for the residue fingerprint.
 *
 * Thickness and component size are measured in the seed's structural colour
 * class (fixed Chebyshev gate), not "any visible pixel" and not the customer
 * Tolerance slider. That keeps coloured residue working without letting brown
 * anti-aliasing merge a black speck into nearby lettering.
 */
function buildResidueFeatures(
  image: RgbaImage,
  referenceColor: RgbColor,
  seedPixel: number,
): ResidueFeatures {
  const { width, height, data } = image;
  const n = width * height;
  const distClear = new Uint16Array(n);
  distClear.fill(65535);

  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let pixel = 0; pixel < n; pixel += 1) {
    if (data[pixel * 4 + 3]! >= VISIBLE_ALPHA_THRESHOLD) continue;
    distClear[pixel] = 0;
    queue[qt++] = pixel;
  }
  while (qh < qt) {
    const pixel = queue[qh++]!;
    const d = distClear[pixel]!;
    const x = pixel % width;
    const y = (pixel - x) / width;
    for (const [dx, dy] of FOUR_CONNECTED) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (distClear[neighbor]! <= d + 1) continue;
      distClear[neighbor] = d + 1;
      queue[qt++] = neighbor;
    }
  }

  const seedIsDark = lumaAt(data, seedPixel * 4) < MAGIC_SELECT_DARK_LUMA;
  const thickness = new Uint8Array(n);
  for (let pixel = 0; pixel < n; pixel += 1) {
    if (!inThicknessClass(data, pixel, referenceColor, seedIsDark)) continue;
    const x0 = pixel % width;
    const y0 = (pixel - x0) / width;
    let minRun = 255;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as Array<[number, number]>) {
      let run = 1;
      for (const step of [1, -1] as const) {
        let x = x0 + dx * step;
        let y = y0 + dy * step;
        while (x >= 0 && y >= 0 && x < width && y < height && run < 64) {
          if (!inThicknessClass(data, y * width + x, referenceColor, seedIsDark)) {
            break;
          }
          run += 1;
          x += dx * step;
          y += dy * step;
        }
      }
      if (run < minRun) minRun = run;
    }
    thickness[pixel] = minRun === 255 ? 1 : minRun;
  }

  const seen = new Uint8Array(n);
  const componentSizeAt = new Int32Array(n);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  for (let seed = 0; seed < n; seed += 1) {
    if (seen[seed] === 1) continue;
    if (!inSeedColourClass(data, seed, referenceColor)) continue;
    let top = 0;
    let size = 0;
    stack[top++] = seed;
    seen[seed] = 1;
    while (top > 0) {
      const pixel = stack[--top]!;
      members[size++] = pixel;
      const x = pixel % width;
      const y = (pixel - x) / width;
      for (const [dx, dy] of FOUR_CONNECTED) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (seen[neighbor] === 1) continue;
        if (!inSeedColourClass(data, neighbor, referenceColor)) continue;
        seen[neighbor] = 1;
        stack[top++] = neighbor;
      }
    }
    for (let i = 0; i < size; i += 1) {
      componentSizeAt[members[i]!] = size;
    }
  }

  return { distClear, thickness, componentSizeAt };
}

function magicSelectionKey(input: {
  ruleVersion: string;
  selectionMode: MagicSelectionMode;
  width: number;
  height: number;
  point: GuidedRemovalPoint;
  tolerance: number;
  referenceColor: RgbColor;
  pixelCount: number;
  lowestPixel: number;
  mask: Uint8Array;
}): string {
  const header =
    input.selectionMode === "connected"
      ? [
          MAGIC_SELECT_RULE_V1,
          `${input.width}x${input.height}`,
          `${input.point.x},${input.point.y}`,
          `t${input.tolerance}`,
          `c${input.referenceColor.r},${input.referenceColor.g},${input.referenceColor.b}`,
          `n${input.pixelCount}`,
          `p${input.lowestPixel}`,
        ].join(":")
      : [
          input.ruleVersion,
          input.selectionMode,
          `${input.width}x${input.height}`,
          `${input.point.x},${input.point.y}`,
          `t${input.tolerance}`,
          `c${input.referenceColor.r},${input.referenceColor.g},${input.referenceColor.b}`,
          `n${input.pixelCount}`,
          `p${input.lowestPixel}`,
        ].join(":");

  return createHash("sha256")
    .update(header)
    .update(Buffer.from(input.mask.buffer, input.mask.byteOffset, input.mask.byteLength))
    .digest("base64url")
    .slice(0, 22);
}
