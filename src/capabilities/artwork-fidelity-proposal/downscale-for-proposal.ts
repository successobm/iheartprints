/**
 * Universal Raster Reconstruction Phase R4A: bounds a customer-uploaded PNG
 * (up to `MAX_UPLOAD_BYTES` = 50MB, `MAX_IMAGE_DIMENSION_PX` = 12000px —
 * `artwork-preparation/upload-limits.ts`) down to a size safe to send
 * inline (base64 data URI) to the Responses API in one small request,
 * mirroring `PngThumbnailGenerator`'s own nearest-neighbor downscale
 * algorithm (`assets/png-thumbnail-generator.ts`) but with a materially
 * larger target dimension — a 256px thumbnail is too small to read fine
 * secondary wording; `MAX_PROPOSAL_DIMENSION_PX` is chosen to keep small
 * text legible to a vision model while keeping the request payload small
 * and cheap. NEVER upscales a smaller source image.
 *
 * Deliberately NOT `sign-preservation-image-derivation.ts`'s heavier
 * multi-crop machinery (built for a 14-image comparison dispatch) — this is
 * a single image, single call, advisory-only extraction; one bounded
 * downscale is the whole job.
 */

import { PNG } from "pngjs";

/** Longer edge, in pixels, of the image actually sent to the proposal provider. */
export const MAX_PROPOSAL_DIMENSION_PX = 1600;

export interface DownscaledProposalImage {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
}

/** `null` when `bytes` does not decode as a PNG — the caller treats this as "no proposal possible", never a hard failure. */
export function downscaleForProposal(
  bytes: Buffer,
  maxDimensionPx: number = MAX_PROPOSAL_DIMENSION_PX,
): DownscaledProposalImage | null {
  let source: PNG;
  try {
    source = PNG.sync.read(bytes);
  } catch {
    return null;
  }

  const scale = Math.min(1, maxDimensionPx / Math.max(source.width, source.height));
  if (scale >= 1) {
    return { bytes: PNG.sync.write(source), widthPx: source.width, heightPx: source.height };
  }

  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const output = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
      const sourceIdx = (source.width * sourceY + sourceX) << 2;
      const destIdx = (width * y + x) << 2;
      source.data.copy(output.data, destIdx, sourceIdx, sourceIdx + 4);
    }
  }

  return { bytes: PNG.sync.write(output), widthPx: width, heightPx: height };
}
