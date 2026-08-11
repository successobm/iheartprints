/**
 * Existing Artwork → Print Ready Phase 1.2: where on the customer's ARTWORK
 * did they just click?
 *
 * The prepared preview is rendered with `object-contain`, so the drawn image
 * is scaled down to fit its box and letterboxed inside it. A click therefore
 * has to be converted twice — out of the box's padding, then out of the
 * display scale — before it means anything in source pixels. Getting either
 * wrong removes a region the customer did not point at, which is the one
 * outcome this whole feature exists to avoid.
 *
 * Extracted as a pure function for the same reason `uploaded-artwork-flow.ts`
 * was: this repo's test tooling is `node:test` + `renderToString`, with no DOM
 * and no layout engine, so arithmetic embedded in an event handler would be
 * untestable and would only ever be verified by clicking around.
 */

export interface RenderedImageBox {
  /** The <img> element's box, in CSS pixels (its `getBoundingClientRect`). */
  width: number;
  height: number;
  /** The image's intrinsic size — `naturalWidth`/`naturalHeight`. */
  naturalWidth: number;
  naturalHeight: number;
}

/** A point in SOURCE IMAGE pixels. */
export interface ImagePoint {
  x: number;
  y: number;
}

/**
 * Maps a click at (`offsetX`, `offsetY`) within the element box to source
 * image pixels, or `null` when the click landed on the letterboxing rather
 * than on the artwork.
 *
 * Returning `null` for the letterbox matters: those pixels are the panel's
 * background, not transparent artwork, and treating them as (0,0) would let a
 * click in the margin resolve to whatever happens to be in the image's top-left
 * corner.
 */
export function mapClickToImagePoint(
  box: RenderedImageBox,
  offsetX: number,
  offsetY: number,
): ImagePoint | null {
  const { width, height, naturalWidth, naturalHeight } = box;
  if (
    !isPositive(width) ||
    !isPositive(height) ||
    !isPositive(naturalWidth) ||
    !isPositive(naturalHeight)
  ) {
    return null;
  }

  // `object-contain`: one scale for both axes, whichever fits.
  const scale = Math.min(width / naturalWidth, height / naturalHeight);
  const drawnWidth = naturalWidth * scale;
  const drawnHeight = naturalHeight * scale;
  const insetX = (width - drawnWidth) / 2;
  const insetY = (height - drawnHeight) / 2;

  const withinX = offsetX - insetX;
  const withinY = offsetY - insetY;
  if (withinX < 0 || withinY < 0 || withinX >= drawnWidth || withinY >= drawnHeight) {
    return null;
  }

  // Clamped as well as floored: a click exactly on the trailing edge would
  // otherwise round to `naturalWidth`, one pixel outside the image.
  return {
    x: Math.min(naturalWidth - 1, Math.floor(withinX / scale)),
    y: Math.min(naturalHeight - 1, Math.floor(withinY / scale)),
  };
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
