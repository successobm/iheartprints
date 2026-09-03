/**
 * Production Workspace Phase (Section G/H): pure zoom math for the
 * operator's working canvas — pulled out of the component exactly like
 * `correction-coordinate-mapping.ts` was, so "Fit" is a deterministic,
 * directly testable computation rather than something only provable by
 * eyeballing the real browser.
 *
 * "Fit" means: the largest zoom, clamped to `[minZoom, maxZoom]`, at which
 * the FULL natural image fits inside the available viewport on both axes —
 * `Math.min` of the two axis ratios, never a single-axis fit that would
 * crop the sign on the other axis. Landscape, portrait, and near-square
 * artwork all fall out of the same formula; nothing here is sized for one
 * particular sign.
 */

export interface NaturalSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ZoomBounds {
  minZoom: number;
  maxZoom: number;
}

/**
 * Degenerate input (a zero/negative natural or viewport dimension — nothing
 * decoded yet, or a not-yet-laid-out container) returns `1` rather than
 * dividing by zero or producing `NaN`/`Infinity`; the caller already treats
 * `naturalSize === null` as "nothing to fit yet" and won't render this
 * value in that state.
 */
export function computeFitZoom(natural: NaturalSize, viewport: ViewportSize, bounds: ZoomBounds): number {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1;
  }
  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  return clampZoom(scale, bounds);
}

export function clampZoom(zoom: number, bounds: ZoomBounds): number {
  if (!Number.isFinite(zoom)) return bounds.minZoom;
  return Math.min(bounds.maxZoom, Math.max(bounds.minZoom, zoom));
}
