/**
 * Phase 28G Defect C: pure state machine behind `CorrectionWorkspace`'s
 * editable-artwork load — extracted for the same reason
 * `preview-image-commit.ts` was: this repo's test tooling is `node:test` +
 * `renderToString` (no DOM, no effects, no real network, no `Image`), so
 * the stale-response guarantee this defect depends on has to live
 * somewhere a plain function call can exercise it deterministically.
 *
 * THE DEFECT. `CorrectionWorkspace` opened its shell immediately (correct),
 * but its canvas stayed genuinely blank — no loading state at all — until
 * `GET .../correction/result` resolved, which human acceptance measured at
 * roughly 20 seconds against the real Chili & Salsa project. A customer
 * watching a blank canvas for 20 seconds reasonably concluded the editor
 * was broken.
 *
 * THE FIX. `CorrectionWorkspace` now renders an explicit `"loading"` state
 * over the canvas area until the image resolves, keeps every image-
 * dependent tool disabled meanwhile, and shows a recoverable `"error"`
 * state with Try Again / Cancel if the load fails outright — never an
 * infinite spinner. This module is the reducer underneath: a monotonic
 * generation number per load attempt means a resolution can only take
 * effect if it is still answering the MOST RECENT attempt, so a stale
 * response from an earlier attempt (e.g. a slow initial load, followed by
 * an explicit Try Again) can never overwrite what a later attempt already
 * committed.
 *
 * `CorrectionWorkspace` mounting fresh on every "Edit Artwork" click (its
 * parent conditionally renders it as a completely different branch of the
 * tree, not a persistently-keyed sibling — see `UploadedArtworkPanel.tsx`)
 * already means a rapid Edit -> Cancel -> Edit sequence tears the old
 * instance down and constructs a genuinely new one with its own fresh
 * state; a promise still in flight from the torn-down instance resolving
 * late has no state setter left that could reach the new instance. The
 * generation guard here is the SAME safety net applied one level down, for
 * the load attempts belonging to ONE mounted instance's own lifetime (its
 * initial load, and any explicit Try Again after a failure).
 */

export type ImageLoadStatus = "loading" | "ready" | "error";

export interface ImageLoadState<T> {
  status: ImageLoadStatus;
  /** The successfully loaded value, or `null` before the first success. Never cleared by a later failure — Section 8/20.H's "failure leaves last valid state intact" (mirrored from Defect D's identical requirement). */
  value: T | null;
  generation: number;
}

export function initialImageLoadState<T>(): ImageLoadState<T> {
  return { status: "loading", value: null, generation: 0 };
}

/** A new load attempt is starting (initial mount, or an explicit Try Again). Returns the updated state and the generation the caller must pass back to the resolve functions below. */
export function beginImageLoad<T>(
  state: ImageLoadState<T>,
): { state: ImageLoadState<T>; generation: number } {
  const generation = state.generation + 1;
  return { state: { ...state, status: "loading", generation }, generation };
}

/** The attempt for `generation` succeeded. Ignored if a newer attempt has since started. */
export function resolveImageLoadSuccess<T>(
  state: ImageLoadState<T>,
  generation: number,
  value: T,
): ImageLoadState<T> {
  if (generation !== state.generation) return state;
  return { ...state, status: "ready", value };
}

/** The attempt for `generation` failed. Ignored if a newer attempt has since started; on a genuine (non-stale) failure, any previously-loaded `value` is left untouched. */
export function resolveImageLoadFailure<T>(
  state: ImageLoadState<T>,
  generation: number,
): ImageLoadState<T> {
  if (generation !== state.generation) return state;
  return { ...state, status: "error" };
}
