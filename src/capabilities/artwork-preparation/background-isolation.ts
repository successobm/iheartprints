/**
 * Existing Artwork → Print Ready Phase 1: deterministic, edge-connected
 * background isolation.
 *
 * THE CENTRAL RULE, and the reason this is a flood fill rather than a colour
 * threshold: a pixel is removed only if it belongs to a background region
 * REACHABLE FROM THE IMAGE BORDER. Colour similarity alone is never enough.
 *
 * The reference case makes the difference concrete. The audited bowling logo
 * is a near-black exterior touching all four edges, ~593k removable pixels —
 * and ~5,835 pixels of the SAME near-black that are intentional interior
 * strokes, shadows, and enclosed detail. "Remove every black pixel" would
 * delete the customer's line work. Only reachability tells the two apart.
 *
 * Everything here is pure: no I/O, no codec, no provider, no randomness. The
 * same bytes in always produce the same bytes out, which is what lets the
 * whole algorithm be pinned by fixture tests instead of by eyeballing.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type {
  ArtworkBounds,
  BackgroundPreparationRecord,
  RgbColor,
} from "./contracts";

/**
 * Alpha at or above this counts as real artwork. Matches
 * `alpha-trim.ts`'s `DEFAULT_ALPHA_THRESHOLD` deliberately — soft glows and
 * anti-aliased outer edges are printable content, and the two modules must
 * agree on what "visible" means or a prepared asset would be trimmed
 * differently than it was analyzed.
 */
export const VISIBLE_ALPHA_THRESHOLD = 8;

/**
 * Baseline colour tolerance, as a per-channel (Chebyshev) distance in 0–255.
 * 12 is the audited value for the reference artwork: it absorbs the encoder
 * noise in a "solid" near-black export without reaching the customer's
 * darkest intentional strokes.
 */
export const BASE_BACKGROUND_TOLERANCE = 12;

/**
 * Hard ceiling on the adaptive tolerance. Past this, "background" stops
 * being a colour and starts being a guess — such images are classified
 * `NEEDS_REVIEW` rather than aggressively masked.
 */
export const MAX_BACKGROUND_TOLERANCE = 40;

/**
 * How far from the removed exterior the fringe pass is allowed to reach, in
 * pixels. Two covers ordinary anti-aliasing at real export resolutions while
 * staying far too narrow to erode a stroke.
 */
export const FRINGE_RADIUS_PX = 2;

/**
 * A fringe pixel needs a nearby SOLID reference colour to reason about, and
 * that reference must be genuinely distinct from the background — otherwise
 * the alpha ratio below is dividing by noise. Euclidean RGB distance (0–441).
 */
export const SOLID_REFERENCE_MIN_DISTANCE = 48;

/** Window (radius, in pixels) searched for that solid reference. */
const SOLID_REFERENCE_SEARCH_RADIUS = 2;

/** Alpha at or above this makes a pixel eligible to BE a solid reference. */
const SOLID_REFERENCE_MIN_ALPHA = 200;

/**
 * A fringe pixel already this close to the solid colour is left completely
 * alone: it is the artwork, not a blend of artwork and background. This is
 * the guard that keeps intentional outlines intact.
 */
const FRINGE_PRESERVE_RATIO = 0.98;

/** Below this estimated coverage a fringe pixel is essentially pure background. */
const FRINGE_FULL_REMOVAL_RATIO = 0.02;

/**
 * How far the RGB of retained pixels is bled outward into the now-transparent
 * exterior. Transparent pixels still carry colour, and every downstream
 * resample in this codebase interpolates RGB independently of alpha
 * (`raster-transform.ts` is straight, not premultiplied) — so leaving the
 * original near-black RGB behind a zero alpha is exactly how a dark halo
 * reappears during Phase 2 upscaling. Bleeding a two-pixel guard band costs
 * nothing visually (alpha stays 0) and removes the failure mode.
 */
const HALO_GUARD_RADIUS_PX = 2;

export interface ExteriorMaskOptions {
  backgroundColor: RgbColor;
  tolerance: number;
}

export interface ExteriorMaskResult {
  /** 1 = exterior background (reachable from the border), 0 = keep. */
  mask: Uint8Array;
  exteriorCount: number;
  /**
   * Pixels whose colour matches the background but which NO border-connected
   * path reaches. These are the customer's interior line work, and they are
   * never removed. The single most important number this module reports.
   */
  disconnectedMatchCount: number;
  /** Bounds of everything the mask leaves behind. `null` when nothing survives. */
  bounds: ArtworkBounds | null;
}

/**
 * Adaptive tolerance. Stays at the audited baseline for a genuinely uniform
 * export (the reference artwork's edge sigma of ≈0.53 resolves to exactly
 * 12) and widens only as measured edge noise grows, up to a hard ceiling.
 */
export function resolveBackgroundTolerance(
  maxChannelStandardDeviation: number,
): number {
  const widened =
    BASE_BACKGROUND_TOLERANCE +
    2 * Math.max(0, maxChannelStandardDeviation - 1);
  return Math.min(
    MAX_BACKGROUND_TOLERANCE,
    Math.max(BASE_BACKGROUND_TOLERANCE, Math.round(widened)),
  );
}

/** Per-channel (Chebyshev) distance — the metric the fill tolerance is expressed in. */
function channelDistance(
  data: Buffer,
  idx: number,
  color: RgbColor,
): number {
  return Math.max(
    Math.abs(data[idx]! - color.r),
    Math.abs(data[idx + 1]! - color.g),
    Math.abs(data[idx + 2]! - color.b),
  );
}

/** Euclidean RGB distance (0–441) — the metric the fringe alpha ratio needs magnitude from. */
function colorDistance(data: Buffer, idx: number, color: RgbColor): number {
  const dr = data[idx]! - color.r;
  const dg = data[idx + 1]! - color.g;
  const db = data[idx + 2]! - color.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Multi-seeded, 4-connected flood fill from EVERY border pixel that already
 * reads as background.
 *
 * Seeding from all four edges (rather than the four corners, or one edge) is
 * what stops a single unusual pixel from defining the region, and 4- rather
 * than 8-connectivity is deliberate: diagonal connectivity lets a fill squeeze
 * through a one-pixel anti-aliased gap in an outline and flood the interior of
 * a design, which is the classic way this kind of tool eats artwork.
 */
export function computeExteriorMask(
  image: RgbaImage,
  options: ExteriorMaskOptions,
): ExteriorMaskResult {
  const { width, height, data } = image;
  const total = width * height;
  const mask = new Uint8Array(total);
  const queue = new Int32Array(total);
  let queueHead = 0;
  let queueTail = 0;

  const matches = (pixel: number): boolean => {
    const idx = pixel * 4;
    if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) return true;
    return channelDistance(data, idx, options.backgroundColor) <= options.tolerance;
  };

  const seed = (pixel: number): void => {
    if (mask[pixel] === 1 || !matches(pixel)) return;
    mask[pixel] = 1;
    queue[queueTail++] = pixel;
  };

  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (queueHead < queueTail) {
    const pixel = queue[queueHead++]!;
    const x = pixel % width;
    const y = (pixel - x) / width;

    if (x > 0) seed(pixel - 1);
    if (x < width - 1) seed(pixel + 1);
    if (y > 0) seed(pixel - width);
    if (y < height - 1) seed(pixel + width);
  }

  let exteriorCount = 0;
  let disconnectedMatchCount = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (mask[pixel] === 1) {
      exteriorCount += 1;
      continue;
    }

    const idx = pixel * 4;
    if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;

    if (channelDistance(data, idx, options.backgroundColor) <= options.tolerance) {
      disconnectedMatchCount += 1;
    }

    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }

  const bounds: ArtworkBounds | null =
    right < 0 || bottom < 0
      ? null
      : {
          left,
          top,
          right: right + 1,
          bottom: bottom + 1,
          width: right + 1 - left,
          height: bottom + 1 - top,
        };

  return { mask, exteriorCount, disconnectedMatchCount, bounds };
}

export interface BackgroundIsolationOptions {
  backgroundColor: RgbColor;
  tolerance: number;
  /** Pre-computed mask, when the caller already ran analysis. Recomputed when absent. */
  mask?: ExteriorMaskResult;
}

export interface BackgroundIsolationResult {
  image: RgbaImage;
  record: BackgroundPreparationRecord;
}

/**
 * Removes the edge-connected exterior background and cleans the boundary it
 * leaves behind. The source image is never modified — a new buffer is always
 * returned (the customer's upload is pixel-authoritative and immutable).
 *
 * Three passes, in order, each deliberately narrow:
 *
 *   1. EXTERIOR — every masked pixel goes to alpha 0. Nothing else is
 *      touched, so interior background-coloured line work survives untouched
 *      by construction.
 *   2. FRINGE — for pixels within `FRINGE_RADIUS_PX` of the removed region,
 *      recover the anti-aliasing that the original composite baked in. For a
 *      pixel `C` that is a blend of foreground `F` over background `B`,
 *      `C = a*F + (1-a)*B`, so `a ≈ |C-B| / |F-B|` and the uncontaminated
 *      colour is `B + (C-B)/a`. `F` is taken from a nearby genuinely-solid
 *      pixel. When no such reference exists, or the pixel is already
 *      essentially solid, it is PRESERVED UNCHANGED — artwork fidelity
 *      outranks cleanup, always.
 *   3. HALO GUARD — bleed retained RGB a short way into the transparent
 *      exterior so a later resample cannot pull the old background colour
 *      back in. Alpha stays 0; only the (invisible) colour changes.
 */
export function isolateBackground(
  image: RgbaImage,
  options: BackgroundIsolationOptions,
): BackgroundIsolationResult {
  const { width, height } = image;
  const maskResult =
    options.mask ??
    computeExteriorMask(image, {
      backgroundColor: options.backgroundColor,
      tolerance: options.tolerance,
    });
  const { mask } = maskResult;

  const output: RgbaImage = {
    width,
    height,
    data: Buffer.from(image.data),
  };

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (mask[pixel] === 1) output.data[pixel * 4 + 3] = 0;
  }

  const fringe = cleanFringe(image, output, mask, options.backgroundColor);
  const haloGuardPixels = bleedColorIntoTransparent(output, mask);

  return {
    image: output,
    record: {
      backgroundRemoved: true,
      backgroundColor: options.backgroundColor,
      tolerance: options.tolerance,
      exteriorPixelsRemoved: maskResult.exteriorCount,
      interiorBackgroundColoredPixelsPreserved: maskResult.disconnectedMatchCount,
      featheredEdgePixels: fringe.featheredEdgePixels,
      decontaminatedPixels: fringe.decontaminatedPixels,
      haloGuardPixels,
      outputWidthPx: width,
      outputHeightPx: height,
      aspectRatioPreserved: true,
    },
  };
}

interface FringeResult {
  featheredEdgePixels: number;
  decontaminatedPixels: number;
}

/**
 * Matte decontamination, applied ONLY within `FRINGE_RADIUS_PX` of the
 * removed exterior. Reads colours from `source` (the untouched original) and
 * writes to `target`, so one corrected pixel can never seed the correction of
 * the next — the pass is order-independent and therefore deterministic.
 */
function cleanFringe(
  source: RgbaImage,
  target: RgbaImage,
  mask: Uint8Array,
  background: RgbColor,
): FringeResult {
  const { width, height } = source;
  let featheredEdgePixels = 0;
  let decontaminatedPixels = 0;

  const distanceToExterior = computeDistanceToMask(mask, width, height, FRINGE_RADIUS_PX);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (mask[pixel] === 1) continue;
    const distance = distanceToExterior[pixel]!;
    if (distance === 0 || distance > FRINGE_RADIUS_PX) continue;

    const idx = pixel * 4;
    const originalAlpha = source.data[idx + 3]!;
    if (originalAlpha < VISIBLE_ALPHA_THRESHOLD) continue;

    const solid = findSolidReference(source, mask, pixel, background);
    if (!solid) continue;

    const pixelDistance = colorDistance(source.data, idx, background);
    if (pixelDistance >= solid.distance * FRINGE_PRESERVE_RATIO) continue;

    const coverage = clamp01(pixelDistance / solid.distance);
    if (coverage <= FRINGE_FULL_REMOVAL_RATIO) {
      target.data[idx + 3] = 0;
      featheredEdgePixels += 1;
      continue;
    }

    target.data[idx + 3] = Math.round(originalAlpha * coverage);
    featheredEdgePixels += 1;

    // Undo the background composite: B + (C - B) / coverage.
    for (let channel = 0; channel < 3; channel += 1) {
      const backgroundChannel = channelOf(background, channel);
      const observed = source.data[idx + channel]!;
      const recovered = backgroundChannel + (observed - backgroundChannel) / coverage;
      target.data[idx + channel] = clampByte(recovered);
    }
    decontaminatedPixels += 1;
  }

  return { featheredEdgePixels, decontaminatedPixels };
}

interface SolidReference {
  distance: number;
}

/**
 * The nearest genuinely-solid artwork colour around a fringe pixel — the `F`
 * in the composite equation. Returns `null` when the neighbourhood contains
 * nothing far enough from the background to reason about, which is the
 * "preserve the pixel" case.
 */
function findSolidReference(
  source: RgbaImage,
  mask: Uint8Array,
  pixel: number,
  background: RgbColor,
): SolidReference | null {
  const { width, height } = source;
  const x = pixel % width;
  const y = (pixel - x) / width;
  let best = 0;

  for (let dy = -SOLID_REFERENCE_SEARCH_RADIUS; dy <= SOLID_REFERENCE_SEARCH_RADIUS; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -SOLID_REFERENCE_SEARCH_RADIUS; dx <= SOLID_REFERENCE_SEARCH_RADIUS; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;

      const neighbor = ny * width + nx;
      if (mask[neighbor] === 1) continue;
      const idx = neighbor * 4;
      if (source.data[idx + 3]! < SOLID_REFERENCE_MIN_ALPHA) continue;

      const distance = colorDistance(source.data, idx, background);
      if (distance > best) best = distance;
    }
  }

  return best >= SOLID_REFERENCE_MIN_DISTANCE ? { distance: best } : null;
}

/**
 * 4-connected BFS distance from the mask, capped at `maxDistance`. `0` means
 * "is the mask"; anything beyond the cap is left at `maxDistance + 1`.
 */
function computeDistanceToMask(
  mask: Uint8Array,
  width: number,
  height: number,
  maxDistance: number,
): Uint8Array {
  const total = width * height;
  const distance = new Uint8Array(total).fill(maxDistance + 1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (mask[pixel] === 1) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  }

  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    if (next > maxDistance) continue;

    const x = pixel % width;
    const y = (pixel - x) / width;

    const visit = (neighbor: number): void => {
      if (distance[neighbor]! <= next) return;
      distance[neighbor] = next;
      queue[tail++] = neighbor;
    };

    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y < height - 1) visit(pixel + width);
  }

  return distance;
}

/**
 * Copies the colour of nearby retained pixels outward into the transparent
 * exterior (alpha untouched at 0). See `HALO_GUARD_RADIUS_PX` for why an
 * invisible colour still matters.
 */
function bleedColorIntoTransparent(image: RgbaImage, mask: Uint8Array): number {
  const { width, height, data } = image;
  const total = width * height;
  const source = Buffer.from(data);
  const distance = computeDistanceToMask(
    invertMask(mask),
    width,
    height,
    HALO_GUARD_RADIUS_PX,
  );

  let bled = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (mask[pixel] !== 1) continue;
    const step = distance[pixel]!;
    if (step === 0 || step > HALO_GUARD_RADIUS_PX) continue;

    const donor = findNearestOpaqueColorSource(source, mask, width, height, pixel, step);
    if (donor < 0) continue;

    const idx = pixel * 4;
    data[idx] = source[donor * 4]!;
    data[idx + 1] = source[donor * 4 + 1]!;
    data[idx + 2] = source[donor * 4 + 2]!;
    bled += 1;
  }

  return bled;
}

function invertMask(mask: Uint8Array): Uint8Array {
  const inverted = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) inverted[i] = mask[i] === 1 ? 0 : 1;
  return inverted;
}

/** Nearest non-masked pixel within `radius`, scanning in a stable order so the result is deterministic. */
function findNearestOpaqueColorSource(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  pixel: number,
  radius: number,
): number {
  const x = pixel % width;
  const y = (pixel - x) / width;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let dy = -radius; dy <= radius; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;

      const neighbor = ny * width + nx;
      if (mask[neighbor] === 1) continue;
      if (source[neighbor * 4 + 3]! === 0) continue;

      const manhattan = Math.abs(dx) + Math.abs(dy);
      if (manhattan < bestDistance) {
        bestDistance = manhattan;
        best = neighbor;
      }
    }
  }

  return best;
}

/**
 * The already-transparent path: the upload keeps its own alpha and is simply
 * re-encoded as a derived asset. No pixel is altered — the customer's
 * transparency IS the answer, and running a removal pass over it could only
 * damage it.
 */
export function passThroughTransparentArtwork(
  image: RgbaImage,
  backgroundColor: RgbColor,
  tolerance: number,
): BackgroundIsolationResult {
  return {
    image: { width: image.width, height: image.height, data: Buffer.from(image.data) },
    record: {
      backgroundRemoved: false,
      backgroundColor,
      tolerance,
      exteriorPixelsRemoved: 0,
      interiorBackgroundColoredPixelsPreserved: 0,
      featheredEdgePixels: 0,
      decontaminatedPixels: 0,
      haloGuardPixels: 0,
      outputWidthPx: image.width,
      outputHeightPx: image.height,
      aspectRatioPreserved: true,
    },
  };
}

function channelOf(color: RgbColor, channel: number): number {
  if (channel === 0) return color.r;
  if (channel === 1) return color.g;
  return color.b;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
