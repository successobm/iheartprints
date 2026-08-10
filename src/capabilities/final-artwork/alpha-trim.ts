/**
 * Print-Ready Normalization Phase 1: deterministic alpha-bound trimming for
 * transparent production artwork. Pure RGBA pixel math — no PNG codec, no
 * I/O, no provider — so the geometry is independently testable (mirrors
 * `raster-transform.ts`'s reason for existing).
 *
 * WHY this exists: the Print-Ready Production Output Audit found the live
 * production plate was a fixed 3600x4200 canvas whose visible artwork
 * occupied only ~2662x2861 of it — roughly half the deliverable was
 * transparent dead canvas, and "effective resolution" was being computed
 * against the padded canvas rather than the artwork. For apparel raster
 * output the artwork itself must define the canvas, so the first step of
 * production normalization is finding where the artwork actually is.
 *
 * The safety margin here belongs to the ARTWORK EDGE — a few pixels of
 * breathing room so a printer's own edge handling never clips an
 * anti-aliased or glowing outer pixel. It is deliberately tiny and
 * proportional, and it never reconstructs the large fixed transparent canvas
 * this module exists to eliminate.
 */

import type { RgbaImage } from "./raster-transform";

/**
 * Alpha at or above this value counts as meaningful artwork. Deliberately
 * low (not 128, not 255): soft glows, drop shadows, and anti-aliased outer
 * edges are real, printable artwork whose outermost pixels carry very little
 * alpha, and cropping them produces a visibly hard-edged plate. Anything
 * below this is treated as encoder/upscaler noise rather than content.
 */
export const DEFAULT_ALPHA_THRESHOLD = 8;

/** Absolute floor for the artwork-edge safety margin, in pixels. */
export const MIN_SAFETY_MARGIN_PX = 8;
/** Proportional component of the safety margin — a fraction of the alpha bounding box's longest side. */
export const SAFETY_MARGIN_FRACTION = 0.005;

export interface AlphaBoundingBox {
  left: number;
  top: number;
  /** Exclusive. */
  right: number;
  /** Exclusive. */
  bottom: number;
  width: number;
  height: number;
}

/** Per-edge applied margin, after clamping to what the source image actually contains. */
export interface AppliedMarginPx {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AlphaTrimMetadata {
  alphaThreshold: number;
  originalWidthPx: number;
  originalHeightPx: number;
  alphaBBox: AlphaBoundingBox;
  trimmedWidthPx: number;
  trimmedHeightPx: number;
  /** The margin the policy asked for, before clamping — always equal on all four edges. */
  requestedMarginPx: number;
  /** What was actually applied per edge once clamped to the available source pixels. */
  appliedMarginPx: AppliedMarginPx;
  /**
   * Fraction of the trimmed result covered by the alpha bounding box
   * (`bboxArea / trimmedArea`). `1` means a perfectly tight crop; the safety
   * margin is the only thing that ever pulls it below 1. This is the number
   * that makes "excessive transparent dead canvas" measurable rather than
   * assumed.
   */
  artworkOccupancy: number;
  /** `1 - artworkOccupancy` — transparent padding as a fraction of the trimmed result. */
  transparentPaddingFraction: number;
  /** True when the source had no sub-threshold pixel anywhere, so there was nothing to trim (see `trimToAlphaBounds`'s opaque-artwork contract). */
  sourceFullyOpaque: boolean;
  /** True when the alpha bounding box already touched all four source edges, so no margin could be applied. */
  alreadyTightToSourceEdges: boolean;
}

export type AlphaTrimOutcome =
  | { status: "trimmed"; image: RgbaImage; metadata: AlphaTrimMetadata }
  /**
   * Fails SAFELY rather than throwing or returning a 0x0 image: there is no
   * meaningful artwork to normalize, which is a truthful production verdict
   * for the caller to surface, never a crash to retry.
   */
  | { status: "no_visible_artwork"; reason: string };

export interface AlphaTrimOptions {
  alphaThreshold?: number;
  /** Overrides the derived margin (testing/diagnostics). Still clamped to the available source pixels. */
  safetyMarginPx?: number;
}

/**
 * Scans every pixel for the tightest box containing alpha >= `threshold`.
 * Returns `null` when no pixel qualifies (a fully transparent — or
 * entirely sub-threshold — image).
 */
export function computeAlphaBounds(
  image: RgbaImage,
  threshold: number = DEFAULT_ALPHA_THRESHOLD,
): AlphaBoundingBox | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * image.width * 4;
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[rowStart + x * 4 + 3] < threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0 || bottom < 0) return null;

  return {
    left,
    top,
    right: right + 1,
    bottom: bottom + 1,
    width: right + 1 - left,
    height: bottom + 1 - top,
  };
}

/**
 * The audited safety-margin policy: `max(8px, 0.5% of the alpha bounding
 * box's longest side)`. Deterministic, and scale-aware so a 3200px
 * reconstruction gets proportionally the same breathing room as a 400px one.
 */
export function safetyMarginPxFor(bbox: AlphaBoundingBox): number {
  const longestSide = Math.max(bbox.width, bbox.height);
  return Math.max(
    MIN_SAFETY_MARGIN_PX,
    Math.ceil(longestSide * SAFETY_MARGIN_FRACTION),
  );
}

/**
 * Crops `image` to its alpha bounds plus a small artwork-edge safety margin.
 *
 * Contract:
 *   - Every pixel with alpha >= threshold is preserved. The crop box is the
 *     bounding box of those pixels, then grown by the safety margin, so
 *     anti-aliased/glowing edge pixels BELOW the threshold that sit just
 *     outside the box survive too.
 *   - The margin is clamped to the pixels the source actually has. It never
 *     invents new canvas, which is what keeps this from re-creating the
 *     fixed transparent plate it replaces.
 *   - FULLY TRANSPARENT (or entirely sub-threshold) input fails safely with
 *     `"no_visible_artwork"` — never a 0x0 image, never a throw.
 *   - FULLY OPAQUE input is deterministic and intentional: the bounding box
 *     is the whole image, so nothing is cropped, no margin can be applied
 *     (the box already touches every edge), and the image passes through
 *     geometrically unchanged with `sourceFullyOpaque: true`. Transparency
 *     is a separate, independently-enforced production requirement — this
 *     function never fabricates it by padding.
 */
export function trimToAlphaBounds(
  image: RgbaImage,
  options: AlphaTrimOptions = {},
): AlphaTrimOutcome {
  if (image.width <= 0 || image.height <= 0) {
    return {
      status: "no_visible_artwork",
      reason: "Artwork has no pixels to normalize.",
    };
  }

  const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const bbox = computeAlphaBounds(image, alphaThreshold);
  if (!bbox) {
    return {
      status: "no_visible_artwork",
      reason: `Artwork contains no pixels at or above the minimum alpha threshold (${alphaThreshold}); there is no visible artwork to prepare for production.`,
    };
  }

  const requestedMarginPx = options.safetyMarginPx ?? safetyMarginPxFor(bbox);
  const appliedMarginPx: AppliedMarginPx = {
    left: Math.min(requestedMarginPx, bbox.left),
    top: Math.min(requestedMarginPx, bbox.top),
    right: Math.min(requestedMarginPx, image.width - bbox.right),
    bottom: Math.min(requestedMarginPx, image.height - bbox.bottom),
  };

  const cropLeft = bbox.left - appliedMarginPx.left;
  const cropTop = bbox.top - appliedMarginPx.top;
  const trimmedWidthPx = bbox.width + appliedMarginPx.left + appliedMarginPx.right;
  const trimmedHeightPx = bbox.height + appliedMarginPx.top + appliedMarginPx.bottom;

  const data = Buffer.alloc(trimmedWidthPx * trimmedHeightPx * 4);
  for (let y = 0; y < trimmedHeightPx; y += 1) {
    const sourceStart = ((cropTop + y) * image.width + cropLeft) * 4;
    image.data.copy(
      data,
      y * trimmedWidthPx * 4,
      sourceStart,
      sourceStart + trimmedWidthPx * 4,
    );
  }

  const artworkOccupancy =
    (bbox.width * bbox.height) / (trimmedWidthPx * trimmedHeightPx);

  return {
    status: "trimmed",
    image: { width: trimmedWidthPx, height: trimmedHeightPx, data },
    metadata: {
      alphaThreshold,
      originalWidthPx: image.width,
      originalHeightPx: image.height,
      alphaBBox: bbox,
      trimmedWidthPx,
      trimmedHeightPx,
      requestedMarginPx,
      appliedMarginPx,
      artworkOccupancy,
      transparentPaddingFraction: 1 - artworkOccupancy,
      sourceFullyOpaque: !hasAnySubThresholdPixel(image, alphaThreshold),
      alreadyTightToSourceEdges:
        bbox.left === 0 &&
        bbox.top === 0 &&
        bbox.right === image.width &&
        bbox.bottom === image.height,
    },
  };
}

function hasAnySubThresholdPixel(image: RgbaImage, threshold: number): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] < threshold) return true;
  }
  return false;
}
