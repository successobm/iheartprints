/**
 * Existing Artwork → Print Ready Phase 1: the deterministic analyzer.
 *
 * Pure pixel math and arithmetic. No AI, no vision provider, no network, no
 * repository — `analyzeArtwork` is a function of its arguments and nothing
 * else, which is what makes both the classifier above it and the fixture
 * tests below it meaningful.
 *
 * The analyzer MEASURES; it never decides. "Is this safe to repair?" belongs
 * to `repairability.ts`, and "what do we tell the customer?" belongs to
 * `preparation-copy.ts`.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  classifyArtworkOrientation,
  orientedProductionBox,
  recommendProductionBox,
  sizingPolicyForProductionBox,
} from "@/capabilities/shared/garment-production-sizing";
import {
  resolveWidthConstrainedSizing,
  sizingPolicyForPlacement,
} from "@/capabilities/shared/print-placement-dimensions";
import type { PrintPlacement } from "@/lib/domain/types";

import {
  computeExteriorMask,
  resolveBackgroundTolerance,
  VISIBLE_ALPHA_THRESHOLD,
} from "./background-isolation";
import type {
  ArtworkAnalysis,
  EdgeStatistics,
  PixelSufficiency,
  RgbColor,
} from "./contracts";

/**
 * Bucket width used to find the dominant edge colour. Coarse enough that
 * encoder noise in a "solid" background lands in one bucket, fine enough that
 * two genuinely different background colours never do.
 */
const EDGE_COLOR_BUCKET_SIZE = 16;

/**
 * How close an edge pixel must be to the dominant colour to count toward
 * `dominantColorCoverage`. Independent of the fill tolerance on purpose: this
 * measures how uniform the border IS, and the fill tolerance is derived from
 * that measurement.
 */
const EDGE_COVERAGE_TOLERANCE = 24;

/**
 * Above this measured edge deviation the border is not one background — it is
 * a photograph, a gradient, or a busy scene. `repairability.ts` turns this
 * into `NEEDS_REVIEW` rather than a wider tolerance.
 */
export const MAX_SAFE_EDGE_STANDARD_DEVIATION = 24;

/** Below this share of the border matching one colour, "the background" is not a colour at all. */
export const MIN_EDGE_DOMINANT_COVERAGE = 0.85;

/** An exterior fill smaller than this is not a background — it is noise on the border. */
export const MIN_MEANINGFUL_MASK_FRACTION = 0.01;

/** An exterior fill this large has consumed the artwork, not the background. */
export const MAX_MEANINGFUL_MASK_FRACTION = 0.995;

export interface AnalyzeArtworkInput {
  image: RgbaImage;
  /** Always `"image/png"` in Phase 1. Recorded, never inferred from a filename. */
  format: string;
  byteSize: number;
  /** From the PNG header's colour type. A hint; transparency is still measured. */
  declaresAlphaChannel: boolean;
  /** `null` when the customer has not chosen a print location yet — never defaulted. */
  printPlacement: PrintPlacement | null;
  /** The customer's chosen production width, when they have expressed one. */
  intendedPrintWidthIn: number | null;
}

export function analyzeArtwork(input: AnalyzeArtworkInput): ArtworkAnalysis {
  const { image } = input;
  const alpha = measureAlpha(image);
  const edge = measureEdgeStatistics(image);
  const estimatedBackgroundColor = edge.dominantColor;
  const backgroundTolerance = resolveBackgroundTolerance(
    edge.maxChannelStandardDeviation,
  );

  const mask = computeExteriorMask(image, {
    backgroundColor: estimatedBackgroundColor,
    tolerance: backgroundTolerance,
  });

  const totalPixels = image.width * image.height;
  const exteriorMaskFraction = totalPixels === 0 ? 0 : mask.exteriorCount / totalPixels;
  const artworkArea = mask.bounds ? mask.bounds.width * mask.bounds.height : 0;
  const deadCanvasFraction = totalPixels === 0 ? 1 : 1 - artworkArea / totalPixels;

  const backgroundIsEdgeConnected =
    edge.dominantColorCoverage >= MIN_EDGE_DOMINANT_COVERAGE &&
    exteriorMaskFraction >= MIN_MEANINGFUL_MASK_FRACTION &&
    exteriorMaskFraction <= MAX_MEANINGFUL_MASK_FRACTION;

  return {
    widthPx: image.width,
    heightPx: image.height,
    format: input.format,
    byteSize: input.byteSize,
    declaresAlphaChannel: input.declaresAlphaChannel,
    hasTransparency: alpha.hasTransparency,
    fullyOpaque: alpha.fullyOpaque,
    fullyTransparent: alpha.fullyTransparent,
    edge,
    estimatedBackgroundColor,
    backgroundTolerance,
    exteriorMaskFraction,
    disconnectedBackgroundColoredPixels: mask.disconnectedMatchCount,
    backgroundIsEdgeConnected,
    artworkBounds: mask.bounds,
    deadCanvasFraction,
    backgroundConfidence: scoreBackgroundConfidence(edge),
    pixelSufficiency: measurePixelSufficiency(
      mask.bounds?.width ?? image.width,
      mask.bounds?.height ?? image.height,
      input.printPlacement,
      input.intendedPrintWidthIn,
    ),
  };
}

interface AlphaMeasurement {
  hasTransparency: boolean;
  fullyOpaque: boolean;
  fullyTransparent: boolean;
}

function measureAlpha(image: RgbaImage): AlphaMeasurement {
  let anyBelowOpaque = false;
  let anyVisible = false;

  for (let i = 3; i < image.data.length; i += 4) {
    const value = image.data[i]!;
    if (value < 255) anyBelowOpaque = true;
    if (value >= VISIBLE_ALPHA_THRESHOLD) anyVisible = true;
    if (anyBelowOpaque && anyVisible) break;
  }

  return {
    hasTransparency: anyBelowOpaque,
    fullyOpaque: !anyBelowOpaque,
    fullyTransparent: !anyVisible,
  };
}

/**
 * Whether the image contains at least one pixel with alpha < 255.
 *
 * This is the preparation-side reading of the same fact
 * `hasAnyTransparentPixel` / `encodeProductionPng` record on production
 * assets: actual transparent (or partial-alpha) content, never "PNG declares
 * an alpha channel" and never "this workflow conceptually supports
 * transparency." Callers that persist `AssetRecord.hasTransparency` for a
 * derived preparation output must use this (or an equivalent pixel scan),
 * not a hardcoded `true`.
 */
export function artworkHasTransparency(image: RgbaImage): boolean {
  return measureAlpha(image).hasTransparency;
}

/**
 * Statistics over the outermost one-pixel ring. The ring — not a corner
 * sample, not a single edge — because a background that touches all four
 * edges is exactly the case this pipeline is built for, and a background that
 * does not is exactly the case it must refuse.
 */
export function measureEdgeStatistics(image: RgbaImage): EdgeStatistics {
  const { width, height, data } = image;
  const pixels = collectEdgePixels(width, height);

  if (pixels.length === 0) {
    const black: RgbColor = { r: 0, g: 0, b: 0 };
    return {
      sampleCount: 0,
      meanColor: black,
      standardDeviation: black,
      maxChannelStandardDeviation: 0,
      dominantColor: black,
      dominantColorCoverage: 0,
      transparentFraction: 0,
    };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let transparent = 0;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (const pixel of pixels) {
    const idx = pixel * 4;
    const r = data[idx]!;
    const g = data[idx + 1]!;
    const b = data[idx + 2]!;
    sumR += r;
    sumG += g;
    sumB += b;
    if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) transparent += 1;

    const key = bucketKey(r, g, b);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  const count = pixels.length;
  const meanColor: RgbColor = {
    r: sumR / count,
    g: sumG / count,
    b: sumB / count,
  };

  let varianceR = 0;
  let varianceG = 0;
  let varianceB = 0;
  for (const pixel of pixels) {
    const idx = pixel * 4;
    varianceR += (data[idx]! - meanColor.r) ** 2;
    varianceG += (data[idx + 1]! - meanColor.g) ** 2;
    varianceB += (data[idx + 2]! - meanColor.b) ** 2;
  }

  const standardDeviation: RgbColor = {
    r: Math.sqrt(varianceR / count),
    g: Math.sqrt(varianceG / count),
    b: Math.sqrt(varianceB / count),
  };

  // The dominant bucket's own MEAN, not its bucket centre: quantization is
  // only used to find which colour dominates, never to round the answer.
  const dominantBucket = pickDominantBucket(buckets);
  const dominantColor: RgbColor = {
    r: Math.round(dominantBucket.r / dominantBucket.count),
    g: Math.round(dominantBucket.g / dominantBucket.count),
    b: Math.round(dominantBucket.b / dominantBucket.count),
  };

  let withinTolerance = 0;
  for (const pixel of pixels) {
    const idx = pixel * 4;
    const distance = Math.max(
      Math.abs(data[idx]! - dominantColor.r),
      Math.abs(data[idx + 1]! - dominantColor.g),
      Math.abs(data[idx + 2]! - dominantColor.b),
    );
    if (distance <= EDGE_COVERAGE_TOLERANCE) withinTolerance += 1;
  }

  return {
    sampleCount: count,
    meanColor,
    standardDeviation,
    maxChannelStandardDeviation: Math.max(
      standardDeviation.r,
      standardDeviation.g,
      standardDeviation.b,
    ),
    dominantColor,
    dominantColorCoverage: withinTolerance / count,
    transparentFraction: transparent / count,
  };
}

function collectEdgePixels(width: number, height: number): number[] {
  const pixels: number[] = [];
  if (width <= 0 || height <= 0) return pixels;

  for (let x = 0; x < width; x += 1) {
    pixels.push(x);
    if (height > 1) pixels.push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    pixels.push(y * width);
    if (width > 1) pixels.push(y * width + width - 1);
  }
  return pixels;
}

function bucketKey(r: number, g: number, b: number): number {
  const qr = Math.floor(r / EDGE_COLOR_BUCKET_SIZE);
  const qg = Math.floor(g / EDGE_COLOR_BUCKET_SIZE);
  const qb = Math.floor(b / EDGE_COLOR_BUCKET_SIZE);
  return (qr << 16) | (qg << 8) | qb;
}

/** Highest count wins; ties break on the lowest bucket key so the result never depends on Map order. */
function pickDominantBucket(
  buckets: Map<number, { count: number; r: number; g: number; b: number }>,
): { count: number; r: number; g: number; b: number } {
  let bestKey = Number.POSITIVE_INFINITY;
  let best: { count: number; r: number; g: number; b: number } | null = null;

  for (const [key, bucket] of buckets) {
    if (!best || bucket.count > best.count || (bucket.count === best.count && key < bestKey)) {
      best = bucket;
      bestKey = key;
    }
  }

  return best!;
}

/**
 * 0–1 confidence that an automatic exterior removal is safe. Half from how
 * uniform the border is, half from how much of it agrees on one colour —
 * the two independent ways "this is a solid background" can be false.
 */
function scoreBackgroundConfidence(edge: EdgeStatistics): number {
  const uniformity = clamp01(
    1 - edge.maxChannelStandardDeviation / MAX_SAFE_EDGE_STANDARD_DEVIATION,
  );
  const coverage = clamp01((edge.dominantColorCoverage - 0.5) / 0.5);
  return Number((0.5 * uniformity + 0.5 * coverage).toFixed(4));
}

/**
 * Whether the VISIBLE artwork carries enough pixels for the placement's
 * production target. Reads the one shared placement policy table — this
 * module never restates a print-sizing rule (Goal: "do not duplicate print-
 * sizing rules in artwork preparation").
 *
 * Measured against the artwork's own width AND height, not the canvas
 * dimensions: transparent padding is not resolution.
 *
 * Phase 28C: when nobody has expressed an explicit print width yet
 * (`intendedPrintWidthIn === null` — the ordinary case at upload time, before
 * any garment size is even chosen), the required width is CONTAINED against
 * the artwork's own aspect ratio inside the best-available garment
 * recommendation (`recommendProductionBox`'s assumed `adult_standard` box,
 * the same assumption every other recommendation surface uses and reports as
 * assumed). Before this, a tall/portrait upload was always compared against
 * the placement's flat default width (10.5in for a full front, regardless of
 * the artwork's own proportions) — overstating how many source pixels a
 * design that will actually print considerably narrower than 10.5in (because
 * its height controls once correctly contained) genuinely needs, and
 * producing the misleading "smaller than the recommended print resolution
 * for a 10.5"-wide print" message for artwork that was never going to print
 * 10.5in wide in the first place.
 *
 * Once a customer HAS expressed an explicit width, that choice is honoured
 * exactly as before (no box substituted for it) — this containment only ever
 * narrows the DEFAULT case, never a stated one.
 */
export function measurePixelSufficiency(
  artworkWidthPx: number,
  artworkHeightPx: number,
  placement: PrintPlacement | null,
  intendedPrintWidthIn: number | null,
): PixelSufficiency | null {
  const policy = sizingPolicyForPlacement(placement, intendedPrintWidthIn);
  if (!policy || !placement) return null;

  const recommendation =
    intendedPrintWidthIn === null
      ? recommendProductionBox({ placement, garmentSizeClass: null })
      : null;
  // Phase 28S: orientation-aware, from these same visible bounds — a
  // portrait design's sufficiency message must not be computed against a
  // flat box height that was never meant to be its ceiling (see
  // `orientedProductionBox`'s doc comment).
  const orientedBox = recommendation?.box
    ? orientedProductionBox(
        recommendation.box,
        classifyArtworkOrientation(artworkWidthPx, artworkHeightPx),
        policy.maxHeightIn,
      )
    : null;
  const containmentPolicy = orientedBox
    ? sizingPolicyForProductionBox(policy, policy.targetWidthIn, orientedBox.maxHeightIn)
    : policy;

  const contained = resolveWidthConstrainedSizing(
    containmentPolicy,
    artworkWidthPx,
    artworkHeightPx,
  );
  const requiredWidthPx = Math.round(contained.widthIn * policy.targetPpi);
  const coverageRatio =
    requiredWidthPx === 0 ? 0 : Math.min(99, artworkWidthPx / requiredWidthPx);

  return {
    placement,
    targetWidthIn: contained.widthIn,
    targetPpi: policy.targetPpi,
    requiredWidthPx,
    availableWidthPx: artworkWidthPx,
    sufficient: artworkWidthPx >= requiredWidthPx,
    coverageRatio: Number(coverageRatio.toFixed(4)),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
