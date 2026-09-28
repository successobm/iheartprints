/**
 * Memory-Bounded Oversized Provider Result Finalization (Repair #2).
 *
 * `normalizeProductionRaster` takes an already-decoded `RgbaImage`, which
 * for a 4x Topaz result means ~800 MiB resident before it is even called.
 * This module produces the SAME outcome straight from the provider's PNG
 * bytes, holding only the destination raster and two source rows.
 *
 * It is deliberately a re-ordering, not a re-implementation:
 *
 *   - the alpha bbox comes from `scanPngAlphaBounds`, whose comparison and
 *     exclusive-bound semantics mirror `computeAlphaBounds` exactly;
 *   - the safety margin, crop window and trimmed dimensions are computed
 *     with the SAME arithmetic `trimToAlphaBounds` uses;
 *   - the target geometry comes from the SAME `resolveWidthConstrainedSizing`
 *     call with the SAME inputs, so output dimensions cannot drift;
 *   - the pixels come from `resamplePngRegionStreaming`, which reproduces
 *     `bilinearResample` arithmetic verbatim;
 *   - the metadata comes from the SAME `buildNormalizedOutcome` helper the
 *     in-memory path uses.
 *
 * `production-normalization-streaming.test.ts` asserts the result is
 * byte-for-byte identical to `normalizeProductionRaster` on the same input,
 * which is the property that makes this safe to put in the production path.
 */

import { resolveWidthConstrainedSizing } from "@/capabilities/shared/print-placement-dimensions";

import {
  DEFAULT_ALPHA_THRESHOLD,
  safetyMarginPxFor,
  type AlphaTrimMetadata,
  type AlphaTrimOptions,
} from "./alpha-trim";
import { resamplePngRegionStreaming, scanPngAlphaBounds } from "./png-stream";
import {
  buildNormalizedOutcome,
  type NormalizeProductionRasterOutcome,
  type ProductionSizingRequest,
} from "./production-normalization";

/**
 * Streaming counterpart of `normalizeProductionRaster`. Same outcome shape,
 * same failure modes, O(destination + row) memory instead of O(source).
 */
export type StreamingTrimGeometry =
  | { status: "trimmed"; trimMetadata: AlphaTrimMetadata; cropLeft: number; cropTop: number }
  | { status: "no_visible_artwork"; reason: string };

/**
 * The trim arithmetic of `trimToAlphaBounds`, minus the raster copy — shared
 * by streaming normalization and by two-pass pass-2 planning so the two can
 * never disagree about a pass-1 result's geometry.
 */
export async function deriveStreamingTrimGeometry(
  bytes: Buffer,
  options: AlphaTrimOptions = {},
): Promise<StreamingTrimGeometry> {
  const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const scan = await scanPngAlphaBounds(bytes, alphaThreshold);
  const { widthPx: originalWidthPx, heightPx: originalHeightPx } = scan.header;

  if (originalWidthPx <= 0 || originalHeightPx <= 0) {
    return { status: "no_visible_artwork", reason: "Artwork has no pixels to normalize." };
  }
  if (!scan.bbox) {
    // Word-for-word the reason `trimToAlphaBounds` produces, so nothing
    // downstream can tell the two paths apart.
    return {
      status: "no_visible_artwork",
      reason: `Artwork contains no pixels at or above the minimum alpha threshold (${alphaThreshold}); there is no visible artwork to prepare for production.`,
    };
  }

  const bbox = scan.bbox;
  const requestedMarginPx = options.safetyMarginPx ?? safetyMarginPxFor(bbox);
  const appliedMarginPx = {
    left: Math.min(requestedMarginPx, bbox.left),
    top: Math.min(requestedMarginPx, bbox.top),
    right: Math.min(requestedMarginPx, originalWidthPx - bbox.right),
    bottom: Math.min(requestedMarginPx, originalHeightPx - bbox.bottom),
  };
  const cropLeft = bbox.left - appliedMarginPx.left;
  const cropTop = bbox.top - appliedMarginPx.top;
  const trimmedWidthPx = bbox.width + appliedMarginPx.left + appliedMarginPx.right;
  const trimmedHeightPx = bbox.height + appliedMarginPx.top + appliedMarginPx.bottom;
  const artworkOccupancy = (bbox.width * bbox.height) / (trimmedWidthPx * trimmedHeightPx);

  const trimMetadata: AlphaTrimMetadata = {
    alphaThreshold,
    originalWidthPx,
    originalHeightPx,
    alphaBBox: bbox,
    trimmedWidthPx,
    trimmedHeightPx,
    requestedMarginPx,
    appliedMarginPx,
    artworkOccupancy,
    transparentPaddingFraction: 1 - artworkOccupancy,
    sourceFullyOpaque: !scan.hasAnySubThresholdPixel,
    alreadyTightToSourceEdges:
      bbox.left === 0 &&
      bbox.top === 0 &&
      bbox.right === originalWidthPx &&
      bbox.bottom === originalHeightPx,
  };

  return { status: "trimmed", trimMetadata, cropLeft, cropTop };
}

/**
 * Streaming counterpart of `normalizeProductionRaster`. Same outcome shape,
 * same failure modes, O(destination + row) memory instead of O(source).
 */
export async function normalizeProductionRasterFromPngBytes(
  bytes: Buffer,
  sizing: ProductionSizingRequest,
  options: AlphaTrimOptions = {},
): Promise<NormalizeProductionRasterOutcome> {
  const geometry = await deriveStreamingTrimGeometry(bytes, options);
  if (geometry.status === "no_visible_artwork") {
    return { status: "no_visible_artwork", reason: geometry.reason };
  }
  const { trimMetadata, cropLeft, cropTop } = geometry;
  const { trimmedWidthPx, trimmedHeightPx } = trimMetadata;

  // IDENTICAL inputs to the in-memory path — this is what guarantees the
  // production plate's dimensions cannot change.
  const resolution = resolveWidthConstrainedSizing(sizing, trimmedWidthPx, trimmedHeightPx);

  const data = await resamplePngRegionStreaming(bytes, {
    cropLeft,
    cropTop,
    cropWidth: trimmedWidthPx,
    cropHeight: trimmedHeightPx,
    destWidth: resolution.widthPx,
    destHeight: resolution.heightPx,
  });

  return buildNormalizedOutcome(
    trimMetadata,
    resolution,
    { width: resolution.widthPx, height: resolution.heightPx, data },
    // `resampleExact` reports destWidth / source.width, where `source` is
    // the TRIMMED image — reproduced exactly.
    resolution.widthPx / trimmedWidthPx,
  );
}
