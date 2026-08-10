/**
 * Print-Ready Normalization Phase 1: the single, provider-neutral definition
 * of what a production raster deliverable IS.
 *
 * Both `FinalArtworkProvider` implementations (local deterministic resample,
 * Topaz reconstruction) run their high-resolution raster through this exact
 * module, so "what the printer receives" is one auditable transform rather
 * than per-provider geometry:
 *
 *   high-resolution reconstructed artwork
 *     → alpha trim (artwork's own bounds)
 *     → small transparent safety margin at the artwork edge
 *     → target dimensions from physical print WIDTH x target PPI,
 *       height derived from the trimmed artwork's aspect ratio
 *     → proportional resample
 *     → PNG encode (+ pHYs density matching the target PPI)
 *
 * What it deliberately does NOT do: force a fixed rectangular canvas, centre
 * artwork inside transparent padding, stretch to fill a frame, crop meaningful
 * artwork, or alter colours, wording, layout, or composition. This is strictly
 * a production transformation of already-approved creative content.
 */

import { PNG } from "pngjs";

import {
  resolveWidthConstrainedSizing,
  type PlacementSizingPolicy,
  type PlacementSizingStrategy,
  type ProductionSizingResolution,
} from "@/capabilities/shared/print-placement-dimensions";

import {
  trimToAlphaBounds,
  type AlphaTrimMetadata,
  type AlphaTrimOptions,
} from "./alpha-trim";
import { hasAnyTransparentPixel, resampleExact, type RgbaImage } from "./raster-transform";
import { pixelsPerMetreForPpi, withPhysicalPixelDensity } from "./production-png";

/**
 * The production sizing request handed to a `FinalArtworkProvider` — the
 * placement policy, never pre-computed canvas pixels. A provider cannot know
 * the output height before the artwork has been trimmed, which is exactly why
 * the old `targetWidthPx`/`targetHeightPx` pair could only ever produce a
 * fixed canvas.
 */
export type ProductionSizingRequest = PlacementSizingPolicy;

/**
 * Everything needed to prove the production plate is what it claims to be:
 * where the artwork actually was, how much breathing room was added, the
 * physical size the pixels are intended to print at, and the density tag
 * written into the file. Persisted on the production asset and handed to
 * authoritative Print Validation — which recomputes rather than trusts.
 */
export interface ProductionNormalizationMetadata {
  strategy: PlacementSizingStrategy;
  /** Pixel dimensions of the reconstructed raster this normalization started from. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  alphaThreshold: number;
  alphaBBoxWidthPx: number;
  alphaBBoxHeightPx: number;
  trimmedWidthPx: number;
  trimmedHeightPx: number;
  requestedMarginPx: number;
  appliedMarginPx: AlphaTrimMetadata["appliedMarginPx"];
  /** Alpha-bbox area ÷ trimmed area — how much of the deliverable is actual artwork. */
  artworkOccupancy: number;
  transparentPaddingFraction: number;
  sourceFullyOpaque: boolean;
  /** Trimmed artwork aspect ratio (`width / height`) — the ratio the output must preserve. */
  trimmedAspectRatio: number;
  /** Produced output aspect ratio (`width / height`) — equal to `trimmedAspectRatio` to within one pixel of rounding. */
  outputAspectRatio: number;
  outputWidthPx: number;
  outputHeightPx: number;
  /** Policy target print width, in inches. */
  targetWidthIn: number;
  targetPpi: number;
  /** Intended physical print size of the produced pixels, in inches. */
  intendedWidthIn: number;
  intendedHeightIn: number;
  constrainedBy: ProductionSizingResolution["constrainedBy"];
  /** Effective resolution actually achieved — `pixels ÷ intended inches`, never read from the density tag. */
  effectivePpiWidth: number;
  effectivePpiHeight: number;
  /** The `pHYs` density written into the PNG, in pixels per metre. `null` when no density tag was written. */
  densityPixelsPerMetre: number | null;
  /**
   * `output width ÷ trimmed width`. `<= 1` means the trimmed artwork was only
   * shrunk (no fabricated detail); `> 1` means it had to be enlarged beyond
   * its own pixel density to reach the production size.
   */
  contentScale: number;
}

export interface NormalizedProductionRaster {
  image: RgbaImage;
  metadata: ProductionNormalizationMetadata;
}

export type NormalizeProductionRasterOutcome =
  | { status: "normalized"; result: NormalizedProductionRaster }
  /** Fails safely — a truthful "there is nothing printable here" verdict, never a crash. */
  | { status: "no_visible_artwork"; reason: string };

/** Alpha-trim tuning, exposed for tests/diagnostics — production always uses the audited defaults. */
export type NormalizeProductionRasterOptions = AlphaTrimOptions;

/**
 * Runs the full production transform over an already-reconstructed
 * high-resolution raster. Pure: no I/O, no provider, no repository.
 */
export function normalizeProductionRaster(
  source: RgbaImage,
  sizing: ProductionSizingRequest,
  options: NormalizeProductionRasterOptions = {},
): NormalizeProductionRasterOutcome {
  const trim = trimToAlphaBounds(source, options);
  if (trim.status === "no_visible_artwork") {
    return { status: "no_visible_artwork", reason: trim.reason };
  }

  const resolution = resolveWidthConstrainedSizing(
    sizing,
    trim.metadata.trimmedWidthPx,
    trim.metadata.trimmedHeightPx,
  );

  const resampled = resampleExact(trim.image, resolution.widthPx, resolution.heightPx);

  return {
    status: "normalized",
    result: {
      image: resampled.image,
      metadata: {
        strategy: resolution.strategy,
        sourceWidthPx: trim.metadata.originalWidthPx,
        sourceHeightPx: trim.metadata.originalHeightPx,
        alphaThreshold: trim.metadata.alphaThreshold,
        alphaBBoxWidthPx: trim.metadata.alphaBBox.width,
        alphaBBoxHeightPx: trim.metadata.alphaBBox.height,
        trimmedWidthPx: trim.metadata.trimmedWidthPx,
        trimmedHeightPx: trim.metadata.trimmedHeightPx,
        requestedMarginPx: trim.metadata.requestedMarginPx,
        appliedMarginPx: trim.metadata.appliedMarginPx,
        artworkOccupancy: trim.metadata.artworkOccupancy,
        transparentPaddingFraction: trim.metadata.transparentPaddingFraction,
        sourceFullyOpaque: trim.metadata.sourceFullyOpaque,
        trimmedAspectRatio: trim.metadata.trimmedWidthPx / trim.metadata.trimmedHeightPx,
        outputAspectRatio: resolution.widthPx / resolution.heightPx,
        outputWidthPx: resolution.widthPx,
        outputHeightPx: resolution.heightPx,
        targetWidthIn: resolution.targetWidthIn,
        targetPpi: resolution.targetPpi,
        intendedWidthIn: resolution.widthIn,
        intendedHeightIn: resolution.heightIn,
        constrainedBy: resolution.constrainedBy,
        effectivePpiWidth: resolution.widthPx / resolution.widthIn,
        effectivePpiHeight: resolution.heightPx / resolution.heightIn,
        densityPixelsPerMetre: pixelsPerMetreForPpi(resolution.targetPpi),
        contentScale: resampled.contentScale,
      },
    },
  };
}

export interface EncodedProductionPng {
  bytes: Buffer;
  hasTransparency: boolean;
}

/**
 * Encodes a normalized production raster as a PNG carrying the physical
 * density its metadata declares, and verifies the alpha channel by actually
 * scanning it rather than assuming intent.
 */
export function encodeProductionPng(
  normalized: NormalizedProductionRaster,
): EncodedProductionPng {
  const png = new PNG({
    width: normalized.image.width,
    height: normalized.image.height,
  });
  normalized.image.data.copy(png.data);
  const encoded = PNG.sync.write(png);

  return {
    bytes: normalized.metadata.densityPixelsPerMetre
      ? withPhysicalPixelDensity(encoded, normalized.metadata.densityPixelsPerMetre)
      : encoded,
    hasTransparency: hasAnyTransparentPixel(normalized.image),
  };
}
