/**
 * Existing Artwork → Print Ready Phase 1.4: Fit / Zoom In / Zoom Out math for
 * the guided-cleanup workspace.
 *
 * Zoom multiplies the Fit display size. Fit (1×) shows the whole artwork
 * inside the viewport with aspect ratio preserved. Larger factors grow the
 * rendered content box inside a scrollable viewport — never a CSS
 * `transform: scale(...)` — so `getBoundingClientRect` + `mapClickToImagePoint`
 * stay authoritative.
 *
 * Bounded range (relative to Fit):
 * - min 1.00 (Fit) — never smaller than fitted
 * - step 0.25 → 100%, 125%, 150%, …
 * - max 4.00 (400%) — enough for small counters / taglines
 */

export const GUIDED_CLEANUP_ZOOM_MIN = 1;
export const GUIDED_CLEANUP_ZOOM_MAX = 4;
export const GUIDED_CLEANUP_ZOOM_STEP = 0.25;
/** Pointer travel (CSS px) before a gesture counts as pan, not a cleanup click. */
export const GUIDED_CLEANUP_PAN_THRESHOLD_PX = 6;

export interface DisplaySize {
  width: number;
  height: number;
  /** Natural→Fit scale (before the customer's zoom factor). */
  fitScale: number;
}

/**
 * Largest size that fits the natural artwork inside the viewport without
 * cropping or changing aspect ratio.
 */
export function fitDisplaySize(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): DisplaySize | null {
  if (
    !isPositive(naturalWidth) ||
    !isPositive(naturalHeight) ||
    !isPositive(viewportWidth) ||
    !isPositive(viewportHeight)
  ) {
    return null;
  }

  const fitScale = Math.min(
    viewportWidth / naturalWidth,
    viewportHeight / naturalHeight,
  );
  return {
    width: naturalWidth * fitScale,
    height: naturalHeight * fitScale,
    fitScale,
  };
}

export function clampZoomFactor(factor: number): number {
  if (!Number.isFinite(factor)) return GUIDED_CLEANUP_ZOOM_MIN;
  const stepped =
    Math.round(factor / GUIDED_CLEANUP_ZOOM_STEP) * GUIDED_CLEANUP_ZOOM_STEP;
  return Math.min(
    GUIDED_CLEANUP_ZOOM_MAX,
    Math.max(GUIDED_CLEANUP_ZOOM_MIN, Number(stepped.toFixed(2))),
  );
}

export function nextZoomIn(factor: number): number {
  return clampZoomFactor(factor + GUIDED_CLEANUP_ZOOM_STEP);
}

export function nextZoomOut(factor: number): number {
  return clampZoomFactor(factor - GUIDED_CLEANUP_ZOOM_STEP);
}

export function zoomedDisplaySize(
  fit: DisplaySize,
  zoomFactor: number,
): { width: number; height: number } {
  const factor = clampZoomFactor(zoomFactor);
  return {
    width: fit.width * factor,
    height: fit.height * factor,
  };
}

/** Customer-facing percent label, e.g. `125%`. */
export function zoomPercentLabel(factor: number): string {
  return `${Math.round(clampZoomFactor(factor) * 100)}%`;
}

export function isPanGesture(
  deltaX: number,
  deltaY: number,
  thresholdPx: number = GUIDED_CLEANUP_PAN_THRESHOLD_PX,
): boolean {
  return Math.hypot(deltaX, deltaY) >= thresholdPx;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
