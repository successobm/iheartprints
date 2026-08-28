/**
 * Phase 28G Defect D: pure state machine behind `GarmentPreviewImage`
 * (`SeparationReviewPanel.tsx`) — extracted for the same reason
 * `region-review-workspace.ts` / `proposal-review-workspace.ts` were: this
 * repo's test tooling is `node:test` + `renderToString` (no DOM, no
 * effects, no real network), so the actual race behavior this defect is
 * about has to live somewhere a plain function call can exercise it
 * deterministically.
 *
 * THE DEFECT. The final side-by-side review's garment-colour preview bound
 * a plain `<img src>` directly to `previewSurface` state, and the
 * container's `backgroundColor` inline style to the same value. Both
 * updated the instant a colour button was clicked — before the browser had
 * actually fetched/decoded the new bitmap — so the visible frame showed
 * the NEW background colour behind the OLD artwork bitmap until the new
 * image finished loading, and a second click before the first request
 * settled had no ordering guarantee at all.
 *
 * THE FIX. Separate "what was requested" (immediate — drives button
 * selection) from "what is committed/painted" (the src + backgroundColor
 * pair actually shown, which only ever changes atomically, together, once
 * a load for that exact pair has completed). A monotonically increasing
 * generation number is minted per request; a resolution only commits if
 * its generation is still the most recent one requested — a later request
 * always wins over an earlier one that resolves after it, regardless of
 * network arrival order (Section 11's "latest requested state wins").
 *
 * This is a plain reducer over an opaque `PreviewCommitState` value —
 * nothing here touches `Image`, `fetch`, timers, or the DOM. The React
 * wrapper (`GarmentPreviewImage`) owns exactly three responsibilities: (1)
 * noticing a new `(src, backgroundColor)` request, (2) preloading it
 * off-screen, and (3) calling the resolve functions below when that
 * preload settles.
 */

export interface CommittedPreview {
  src: string;
  backgroundColor: string;
}

export interface PreviewCommitState {
  /** The last (src, backgroundColor) pair actually shown, or `null` before the very first load ever completes. */
  committed: CommittedPreview | null;
  /** True while a requested pair has not yet resolved (success or failure). */
  switching: boolean;
  /** True when the MOST RECENT request's own resolution failed — cleared the instant a newer request begins. */
  failed: boolean;
  /** Monotonically increasing; the generation the next `resolve*` call must match to take effect. */
  generation: number;
}

export function initialPreviewCommitState(): PreviewCommitState {
  return { committed: null, switching: true, failed: false, generation: 0 };
}

/**
 * A new (src, backgroundColor) pair was requested (props changed, or the
 * very first render). Returns the updated state AND the generation number
 * the caller must pass back into `resolvePreviewCommitSuccess` /
 * `resolvePreviewCommitFailure` once the corresponding preload settles.
 *
 * Callers should only invoke this when the requested pair genuinely
 * differs from what is already committed or already in flight (Section
 * 13: "Prevent rapid repeated requests for the SAME background while it is
 * already loading") — see `shouldRequestPreviewCommit`.
 */
export function requestPreviewCommit(
  state: PreviewCommitState,
): { state: PreviewCommitState; generation: number } {
  const generation = state.generation + 1;
  return {
    state: { ...state, switching: true, failed: false, generation },
    generation,
  };
}

/** Whether a freshly-requested (src, backgroundColor) pair is actually new work, not a repeat of what is committed or already in flight for. */
export function shouldRequestPreviewCommit(
  state: PreviewCommitState,
  requested: CommittedPreview,
  lastRequested: CommittedPreview | null,
): boolean {
  if (lastRequested && lastRequested.src === requested.src && lastRequested.backgroundColor === requested.backgroundColor) {
    return false;
  }
  if (state.committed && state.committed.src === requested.src && state.committed.backgroundColor === requested.backgroundColor) {
    return false;
  }
  return true;
}

/**
 * The preload for `generation` finished loading successfully. Ignored
 * entirely if a newer request has since been issued (`generation` is
 * stale) — the stale response is discarded, never painted, and never
 * flips `failed` either way. This is the whole of the "latest requested
 * state wins" guarantee: Gray -> Red -> Black, Red resolving after Black
 * was requested, Red is silently dropped here.
 */
export function resolvePreviewCommitSuccess(
  state: PreviewCommitState,
  generation: number,
  result: CommittedPreview,
): PreviewCommitState {
  if (generation !== state.generation) return state;
  return { ...state, committed: result, switching: false, failed: false };
}

/**
 * The preload for `generation` failed. Also ignored if stale. On a real
 * (non-stale) failure, the previous `committed` frame is left completely
 * untouched (Section 20.H: "failure leaves last valid completed preview
 * intact") — only `switching`/`failed` change.
 */
export function resolvePreviewCommitFailure(
  state: PreviewCommitState,
  generation: number,
): PreviewCommitState {
  if (generation !== state.generation) return state;
  return { ...state, switching: false, failed: true };
}
