/**
 * Sprint 2M Phase 2C: pure, dependency-light RGBA raster math — no I/O, no
 * PNG codec. `local-raster-provider.ts` is the only caller; it owns
 * decode/encode (pngjs) and calls this module for the actual pixel
 * transformation, keeping the geometry testable in isolation.
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

export interface ContainResampleResult {
  image: RgbaImage;
  /**
   * `contentWidth (or height) ÷ source width (or height)` — the smaller of
   * the two axis scales actually used (uniform "contain" fit). `<= 1` means
   * the source was only ever shrunk or kept 1:1 (no fabricated detail);
   * `> 1` means the source had to be stretched beyond its native pixel
   * density to fill the frame (fabricated detail — an honest caller must
   * record this as `"interpolated_upscale"` provenance).
   */
  contentScale: number;
  /** Pixel dimensions of the resampled content region, before centering/padding. */
  contentWidthPx: number;
  contentHeightPx: number;
}

/**
 * Resamples `source` to fit ("contain" — preserve aspect ratio, never crop)
 * within a `targetWidth`x`targetHeight` canvas, inset by `marginFraction` on
 * every edge, centered, and padded with fully transparent pixels
 * (`alpha = 0`) everywhere the content doesn't reach. Never distorts aspect
 * ratio and never crops source content — the whole approved design is
 * always preserved (Goal 7).
 */
export function resampleContainWithTransparentPadding(
  source: RgbaImage,
  targetWidth: number,
  targetHeight: number,
  marginFraction: number,
): ContainResampleResult {
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new Error("Target dimensions must be positive.");
  }
  if (source.width <= 0 || source.height <= 0) {
    throw new Error("Source dimensions must be positive.");
  }

  const clampedMargin = Math.min(Math.max(marginFraction, 0), 0.45);
  const availableWidth = Math.max(1, Math.round(targetWidth * (1 - 2 * clampedMargin)));
  const availableHeight = Math.max(1, Math.round(targetHeight * (1 - 2 * clampedMargin)));

  const scaleX = availableWidth / source.width;
  const scaleY = availableHeight / source.height;
  const contentScale = Math.min(scaleX, scaleY);

  const contentWidthPx = Math.max(1, Math.round(source.width * contentScale));
  const contentHeightPx = Math.max(1, Math.round(source.height * contentScale));

  const resampledContent = bilinearResample(source, contentWidthPx, contentHeightPx);

  const canvas = Buffer.alloc(targetWidth * targetHeight * 4, 0); // fully transparent
  const offsetX = Math.floor((targetWidth - contentWidthPx) / 2);
  const offsetY = Math.floor((targetHeight - contentHeightPx) / 2);

  for (let y = 0; y < contentHeightPx; y += 1) {
    const destY = offsetY + y;
    if (destY < 0 || destY >= targetHeight) continue;
    for (let x = 0; x < contentWidthPx; x += 1) {
      const destX = offsetX + x;
      if (destX < 0 || destX >= targetWidth) continue;
      const srcIdx = (y * contentWidthPx + x) * 4;
      const destIdx = (destY * targetWidth + destX) * 4;
      resampledContent.copy(canvas, destIdx, srcIdx, srcIdx + 4);
    }
  }

  return {
    image: { width: targetWidth, height: targetHeight, data: canvas },
    contentScale,
    contentWidthPx,
    contentHeightPx,
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
