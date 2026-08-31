/**
 * Signs Phase S3C: the pure "extend uniform background to the ordered
 * aspect ratio" geometry — the same math `sign-repair-planner.ts` uses
 * inline to PREDICT a plan's pad amounts from the content dimensions it
 * expects a resolution-stage step (reconstruction/downsample) to produce.
 *
 * Deliberately a SEPARATE function, not an extraction/refactor of the
 * planner's own inline computation (out of scope for S3C — "no planner
 * changes" — the planner is untouched, byte-for-byte, by this phase). This
 * module exists only so the EXECUTOR can honestly re-derive the same
 * semantic operation ("extend along the ordered-aspect-mismatched axis,
 * centered, in the approved fill colour") from whatever the reconstruction
 * step ACTUALLY produced, rather than trusting the plan's own prediction —
 * see `sign-transform-executor.ts`'s `adaptGeometryStepsToActualReconstruction`.
 *
 * The real S3B Ruth acceptance run is what this exists for: the plan
 * predicted a 2448x3672 reconstruction and pre-computed 153px/153px pad
 * amounts from that prediction; the provider (Topaz) actually, honestly,
 * returned 4096x6144 — 4.000x of the source, its own proven ceiling, not
 * the requested 2.390625x. `validateReconstructedGeometry` correctly
 * admits that response (sufficient + exactly proportional — Phase 28R's
 * "sufficiency, not exact sizing" contract), but the plan's baked-in
 * 153px/153px pad amounts silently stopped being the correct amounts to
 * reach the ordered 3:4 canvas the instant the input diverged from what the
 * plan assumed. Re-running THIS SAME formula against the actual 4096x6144
 * input reproduces exactly the phase's own audited numbers: axis
 * "horizontal", 4608px plate width, 256px leading, 256px trailing.
 */

export interface UniformBackgroundExtensionGeometry {
  /** False when `contentWidthPx`/`contentHeightPx` are already within tolerance of the ordered aspect — no extension needed. */
  needsExtension: boolean;
  axis: "horizontal" | "vertical" | null;
  plateWidthPx: number;
  plateHeightPx: number;
  /** 0/0 when `needsExtension` is false. */
  leadingPx: number;
  trailingPx: number;
}

/**
 * Mirrors `sign-inspection.ts`'s `SIGN_ASPECT_TOLERANCE` exactly (not
 * imported, to keep this module free of any dependency that could later
 * entangle it with inspection-report shapes it has no business knowing
 * about) — both must independently agree on what counts as "aspect
 * mismatch" for identical reasoning to apply at plan time and at execution
 * time. If that constant is ever revised, this one must be revised
 * alongside it — a fact this comment exists to make impossible to miss.
 */
const SIGN_ASPECT_TOLERANCE = 0.01;

/**
 * Derives the exact deterministic canvas + centered pad amounts needed to
 * extend `contentWidthPx`x`contentHeightPx` (opaque, uniform-background-
 * extendable content) to the ordered `orderedWidthIn`x`orderedHeightIn`
 * aspect ratio, along whichever single axis the mismatch requires. Pure,
 * no I/O, no randomness — the same inputs always produce the same output.
 *
 * Rounding: `Math.round` on the derived plate dimension (never floating
 * point carried through to the final raster), then `Math.floor`/remainder
 * for the leading/trailing split — the identical convention the planner's
 * own inline computation already uses and every existing sign fixture
 * already exercises. Never produces a negative pad amount: the axis
 * selection (`contentAspect < orderedAspect` extends width; otherwise
 * extends height) guarantees the derived plate dimension is always >= the
 * content dimension on the extended axis.
 */
export function deriveUniformBackgroundExtension(
  contentWidthPx: number,
  contentHeightPx: number,
  orderedWidthIn: number,
  orderedHeightIn: number,
): UniformBackgroundExtensionGeometry {
  const orderedAspect = orderedWidthIn / orderedHeightIn;
  const contentAspect = contentWidthPx / contentHeightPx;
  const aspectMismatch =
    Math.abs(contentAspect - orderedAspect) / orderedAspect > SIGN_ASPECT_TOLERANCE;

  if (!aspectMismatch) {
    return {
      needsExtension: false,
      axis: null,
      plateWidthPx: contentWidthPx,
      plateHeightPx: contentHeightPx,
      leadingPx: 0,
      trailingPx: 0,
    };
  }

  const heightBound = contentAspect < orderedAspect;
  let plateWidthPx: number;
  let plateHeightPx: number;
  let axis: "horizontal" | "vertical";
  if (heightBound) {
    plateHeightPx = contentHeightPx;
    plateWidthPx = Math.round(contentHeightPx * orderedAspect);
    axis = "horizontal";
  } else {
    plateWidthPx = contentWidthPx;
    plateHeightPx = Math.round(contentWidthPx / orderedAspect);
    axis = "vertical";
  }

  const totalPad = axis === "horizontal" ? plateWidthPx - contentWidthPx : plateHeightPx - contentHeightPx;
  const leadingPx = Math.floor(totalPad / 2);
  const trailingPx = totalPad - leadingPx;

  return { needsExtension: true, axis, plateWidthPx, plateHeightPx, leadingPx, trailingPx };
}
