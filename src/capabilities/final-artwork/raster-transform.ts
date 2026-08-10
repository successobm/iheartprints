/**
 * Sprint 2M Phase 2C: pure, dependency-light RGBA raster math — no I/O, no
 * PNG codec. `production-normalization.ts` is the only caller; the providers
 * own decode/encode (pngjs) and normalization calls this module for the
 * actual pixel transformation, keeping the geometry testable in isolation.
 *
 * Deliberately simple bilinear resampling — an honest, ordinary
 * interpolation, not an ML/AI upscaler. See ARCHITECTURE.md's "Upscaling
 * Truthfulness" section: this module's whole reason for existing is to be
 * transparent about what it is (geometric resampling, never a source of new
 * detail), which is why it also reports `contentScale` so the caller can
 * record honest resolution provenance rather than let a caller infer
 * quality from pixel count alone.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major — the same layout `pngjs` uses. */
  data: Buffer;
}

export interface ResampleResult {
  image: RgbaImage;
  /**
   * `destWidth ÷ source width` (equal to the height ratio to within
   * rounding, since callers only ever resample to the source's own aspect
   * ratio). `<= 1` means the source was only ever shrunk or kept 1:1 (no
   * fabricated detail); `> 1` means the source had to be stretched beyond
   * its native pixel density (fabricated detail — an honest caller must
   * record this as `"interpolated_upscale"` provenance).
   */
  contentScale: number;
}

/**
 * Resamples `source` to exactly `destWidth`x`destHeight`.
 *
 * Print-Ready Normalization Phase 1: this deliberately does NOT centre,
 * pad, or fit-into-a-frame. The production canvas IS the artwork, so the
 * caller (`production-normalization.ts`) computes destination dimensions
 * from the trimmed artwork's own aspect ratio and this function simply
 * resamples to them — no transparent dead canvas is ever introduced here.
 * Distortion is prevented by the caller deriving the destination from the
 * source aspect ratio, and asserted independently by production validation's
 * `aspect_ratio_preserved` check.
 */
export function resampleExact(
  source: RgbaImage,
  destWidth: number,
  destHeight: number,
): ResampleResult {
  if (destWidth <= 0 || destHeight <= 0) {
    throw new Error("Target dimensions must be positive.");
  }
  if (source.width <= 0 || source.height <= 0) {
    throw new Error("Source dimensions must be positive.");
  }

  return {
    image: {
      width: destWidth,
      height: destHeight,
      data: bilinearResample(source, destWidth, destHeight),
    },
    contentScale: destWidth / source.width,
  };
}

/** Standard bilinear resample of an RGBA buffer (each channel, including alpha, interpolated independently). */
function bilinearResample(
  source: RgbaImage,
  destWidth: number,
  destHeight: number,
): Buffer {
  const dest = Buffer.alloc(destWidth * destHeight * 4);
  const scaleX = source.width / destWidth;
  const scaleY = source.height / destHeight;

  for (let destY = 0; destY < destHeight; destY += 1) {
    const srcYf = Math.min(source.height - 1, Math.max(0, (destY + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(srcYf);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const yFrac = srcYf - y0;

    for (let destX = 0; destX < destWidth; destX += 1) {
      const srcXf = Math.min(source.width - 1, Math.max(0, (destX + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(srcXf);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const xFrac = srcXf - x0;

      const destIdx = (destY * destWidth + destX) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = source.data[(y0 * source.width + x0) * 4 + channel];
        const p10 = source.data[(y0 * source.width + x1) * 4 + channel];
        const p01 = source.data[(y1 * source.width + x0) * 4 + channel];
        const p11 = source.data[(y1 * source.width + x1) * 4 + channel];
        const top = p00 * (1 - xFrac) + p10 * xFrac;
        const bottom = p01 * (1 - xFrac) + p11 * xFrac;
        dest[destIdx + channel] = Math.round(top * (1 - yFrac) + bottom * yFrac);
      }
    }
  }

  return dest;
}

/** Scans the whole image for any pixel with alpha < 255 — actual verification, never assumed intent (Goal 9). */
export function hasAnyTransparentPixel(image: RgbaImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] < 255) return true;
  }
  return false;
}
