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

/**
 * Phase 1.7 UX: Ctrl (Windows/Linux) or Cmd/Ctrl (macOS) + wheel zooms.
 * A plain wheel must keep native viewport scrolling — never hijack it.
 */
export function isWheelZoomModifier(keys: {
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return keys.ctrlKey === true || keys.metaKey === true;
}

/**
 * Wheel up (negative deltaY) zooms in; wheel down zooms out.
 * Returns the next clamped factor, or the current one at the bounds.
 */
export function nextZoomFromWheel(factor: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoomFactor(factor);
  return deltaY < 0 ? nextZoomIn(factor) : nextZoomOut(factor);
}

export interface PointerCenteredScrollInput {
  viewportWidth: number;
  viewportHeight: number;
  /** Pointer position relative to the viewport's client box. */
  pointerXInViewport: number;
  pointerYInViewport: number;
  scrollLeft: number;
  scrollTop: number;
  oldDisplay: { width: number; height: number };
  newDisplay: { width: number; height: number };
}

/**
 * Scroll offsets that keep the same artwork point under the pointer after
 * the content box grows or shrinks. The workspace centers the image in a
 * content box of `max(viewport, display)`; pan is scroll, not a transform.
 *
 * When the zoomed image still fits the viewport, scroll cannot move it —
 * the image stays centered and the pointer-lock is approximate.
 */
export function pointerCenteredScroll(
  input: PointerCenteredScrollInput,
): { scrollLeft: number; scrollTop: number } {
  const oldContentWidth = Math.max(input.viewportWidth, input.oldDisplay.width);
  const oldContentHeight = Math.max(
    input.viewportHeight,
    input.oldDisplay.height,
  );
  const newContentWidth = Math.max(input.viewportWidth, input.newDisplay.width);
  const newContentHeight = Math.max(
    input.viewportHeight,
    input.newDisplay.height,
  );

  const oldImageLeft = (oldContentWidth - input.oldDisplay.width) / 2;
  const oldImageTop = (oldContentHeight - input.oldDisplay.height) / 2;
  const newImageLeft = (newContentWidth - input.newDisplay.width) / 2;
  const newImageTop = (newContentHeight - input.newDisplay.height) / 2;

  const contentX = input.scrollLeft + input.pointerXInViewport;
  const contentY = input.scrollTop + input.pointerYInViewport;

  const fx =
    input.oldDisplay.width > 0
      ? (contentX - oldImageLeft) / input.oldDisplay.width
      : 0.5;
  const fy =
    input.oldDisplay.height > 0
      ? (contentY - oldImageTop) / input.oldDisplay.height
      : 0.5;

  const unclampedLeft =
    newImageLeft + fx * input.newDisplay.width - input.pointerXInViewport;
  const unclampedTop =
    newImageTop + fy * input.newDisplay.height - input.pointerYInViewport;

  const maxLeft = Math.max(0, newContentWidth - input.viewportWidth);
  const maxTop = Math.max(0, newContentHeight - input.viewportHeight);

  return {
    scrollLeft: clampScroll(unclampedLeft, maxLeft),
    scrollTop: clampScroll(unclampedTop, maxTop),
  };
}

function clampScroll(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, value));
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
