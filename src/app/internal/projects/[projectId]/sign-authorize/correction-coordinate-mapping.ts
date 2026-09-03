/**
 * Operator Production Correction UX (Section G/L): the coordinate mapping
 * `SignFitToProductionCorrectionTool.tsx` uses to convert a pointer event's
 * on-screen (CSS/display) position into the production candidate's own
 * NATIVE pixel coordinate space — pulled out as a pure, DOM-free function
 * so it is directly testable, and so the component itself can never drift
 * from what is actually tested.
 *
 * The mapping is deliberately recomputed from the CURRENT rendered
 * width/height every call (never a cached scale factor captured once at a
 * particular zoom level) — this is what makes a selection made at ANY zoom
 * level map to the identical source pixels: `scale = natural / rendered`,
 * evaluated fresh each time.
 */

export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NaturalSize {
  width: number;
  height: number;
}

export interface SourcePixel {
  xPx: number;
  yPx: number;
}

/**
 * Converts one client (viewport) point into native candidate pixel
 * coordinates, clamped to `[0, naturalWidth]` / `[0, naturalHeight]`.
 * `null` when the display rect has no measurable size (nothing rendered
 * yet) — never divides by zero, never extrapolates.
 */
export function mapDisplayPointToSourcePx(
  clientX: number,
  clientY: number,
  displayRect: DisplayRect,
  natural: NaturalSize,
): SourcePixel | null {
  if (displayRect.width <= 0 || displayRect.height <= 0) return null;
  const scaleX = natural.width / displayRect.width;
  const scaleY = natural.height / displayRect.height;
  const xPx = Math.round((clientX - displayRect.left) * scaleX);
  const yPx = Math.round((clientY - displayRect.top) * scaleY);
  return {
    xPx: Math.min(Math.max(0, xPx), natural.width),
    yPx: Math.min(Math.max(0, yPx), natural.height),
  };
}

export interface SelectionRect {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

/** Normalizes two dragged corners (in either order) into a positive-area rect, or `null` for a zero-area drag. */
export function normalizeSelection(a: SourcePixel, b: SourcePixel): SelectionRect | null {
  const xPx = Math.min(a.xPx, b.xPx);
  const yPx = Math.min(a.yPx, b.yPx);
  const widthPx = Math.abs(b.xPx - a.xPx);
  const heightPx = Math.abs(b.yPx - a.yPx);
  if (widthPx <= 0 || heightPx <= 0) return null;
  return { xPx, yPx, widthPx, heightPx };
}

/** True iff `rect` lies entirely within `[0,0]..[natural.width,natural.height]` and has positive area. */
export function isSelectionInBounds(rect: SelectionRect, natural: NaturalSize): boolean {
  return (
    rect.widthPx > 0 &&
    rect.heightPx > 0 &&
    rect.xPx >= 0 &&
    rect.yPx >= 0 &&
    rect.xPx + rect.widthPx <= natural.width &&
    rect.yPx + rect.heightPx <= natural.height
  );
}
