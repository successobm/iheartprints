/**
 * Intelligent Separation Phase 15: pure state/navigation logic for the
 * region-by-region review workspace, extracted from `SeparationReviewPanel`
 * for the same reason `uploaded-artwork-flow.ts`'s `deriveUploadedArtworkStep`
 * was extracted from its own panel — this repo's test tooling is
 * `node:test` + `renderToString` (no DOM, no effects), so anything that
 * needs to be proven across a sequence of interactions (navigate, decide,
 * auto-advance, reload) has to live somewhere a plain function call can
 * exercise it.
 *
 * NOTHING HERE RECOMPUTES SEPARATION STATE. Every function takes the
 * server's own `SeparationReviewView` (or the region/decision arrays inside
 * it) and answers a UI-navigation question — which region is active,
 * whether a decision counts as "reviewed", where Next/Previous land. The
 * server's `state` field (`review_required` / `review_complete` / ...) and
 * `pendingRegionIds` remain the ONLY authority on completeness and
 * approval eligibility; this module never redefines them.
 */

export interface WorkspaceRegion {
  regionId: number;
}

export interface WorkspaceDecision {
  regionId: number;
  intent: "substrate" | "ink" | "uncertain";
}

export interface WorkspaceViewLike {
  state: "review_not_required" | "review_required" | "review_in_progress" | "review_complete" | "cannot_safely_automate";
  regionMap: { consequentialRegions: readonly WorkspaceRegion[] };
  decisions: readonly WorkspaceDecision[];
  pendingRegionIds: readonly number[];
}

export interface RegionProgress {
  totalRegions: number;
  /** Regions with a recorded substrate/ink decision — matches the server's own `pendingRegionIds` semantics exactly; a region marked "Not Sure" is NOT counted as reviewed, because it is not counted as decided anywhere else in this system either (Phase 9's "K/L"). */
  reviewedCount: number;
}

export function computeRegionProgress(view: WorkspaceViewLike): RegionProgress {
  const totalRegions = view.regionMap.consequentialRegions.length;
  return {
    totalRegions,
    reviewedCount: totalRegions - view.pendingRegionIds.length,
  };
}

/**
 * Whether every consequential region has a decision — i.e., whether the
 * workspace should show the FINAL REVIEW state instead of a specific
 * region. Deliberately just `view.state === "review_complete"`: the server
 * already computed this (Phase 9's `assessSeparationReviewState`), and an
 * approved preparation (`isProductionAuthoritative`) still reports
 * `review_complete`, so both "ready to approve" and "already approved" land
 * here — exactly the reload requirement ("If preparation is already
 * approved: preserve existing approved behavior").
 */
export function isFinalReviewReady(view: WorkspaceViewLike): boolean {
  return view.state === "review_complete";
}

/**
 * THE RELOAD-RESUME RULE (Goal G). Which region the workspace should open
 * on for a workflow that isn't finished yet: the first PENDING region, in
 * the same order the server lists consequential regions — never region 1
 * unconditionally, never an arbitrary region. Returns `null` only when there
 * is nothing pending (the caller should show final review in that case,
 * decided by `isFinalReviewReady` separately).
 */
export function selectInitialActiveRegionId(view: WorkspaceViewLike): number | null {
  if (isFinalReviewReady(view)) return null;
  const pending = new Set(view.pendingRegionIds);
  const first = view.regionMap.consequentialRegions.find((r) => pending.has(r.regionId));
  return first?.regionId ?? view.regionMap.consequentialRegions[0]?.regionId ?? null;
}

/**
 * Previous/Next navigation (Goal D) — walks the FULL ordered region list
 * (not just pending ones, since "already-decided regions can be revisited
 * and changed"), clamped at both ends rather than wrapping. Returns the
 * same id if there is nowhere to go, so callers can disable the control
 * instead of navigating nowhere silently.
 */
export function stepRegion(
  regions: readonly WorkspaceRegion[],
  currentRegionId: number,
  direction: "previous" | "next",
): number {
  const index = regions.findIndex((r) => r.regionId === currentRegionId);
  if (index === -1) return currentRegionId;
  const nextIndex = direction === "next" ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= regions.length) return currentRegionId;
  return regions[nextIndex]!.regionId;
}

export function canStepRegion(
  regions: readonly WorkspaceRegion[],
  currentRegionId: number,
  direction: "previous" | "next",
): boolean {
  return stepRegion(regions, currentRegionId, direction) !== currentRegionId;
}

/**
 * AUTO-ADVANCE (Goal E). Only advances the operator forward when they were
 * resolving genuinely new territory — deciding a region that was PENDING
 * before this decision. Revisiting an already-decided region to change it
 * does not yank the operator away from where they chose to be; they stay,
 * seeing their updated selection.
 *
 * The target itself is the standard reload-resume rule applied to the
 * FRESH view the decision endpoint returned — the first still-pending
 * region, or `null` (final review) once nothing is left. This is the exact
 * function `selectInitialActiveRegionId` computes for reload, applied here
 * to a live in-session state transition instead — one rule, two call sites.
 */
export function computeAutoAdvanceTarget(
  regionWasPendingBeforeDecision: boolean,
  freshView: WorkspaceViewLike,
): { shouldAdvance: boolean; targetRegionId: number | null } {
  if (!regionWasPendingBeforeDecision) {
    return { shouldAdvance: false, targetRegionId: null };
  }
  return { shouldAdvance: true, targetRegionId: selectInitialActiveRegionId(freshView) };
}

export function isRegionPending(view: WorkspaceViewLike, regionId: number): boolean {
  return view.pendingRegionIds.includes(regionId);
}

export function decisionForRegion(view: WorkspaceViewLike, regionId: number): WorkspaceDecision["intent"] | null {
  return view.decisions.find((d) => d.regionId === regionId)?.intent ?? null;
}

/** 1-based position of a region within the server's own ordering, for "Area X of N" — never recomputed from anything but that same order. */
export function regionPosition(view: WorkspaceViewLike, regionId: number): number {
  return view.regionMap.consequentialRegions.findIndex((r) => r.regionId === regionId) + 1;
}

// ---------------------------------------------------------------------------
// Fetch-wrapping helpers, parameterized by an injectable `fetch`-like
// function. Extracted from `SeparationReviewPanel` so the property Goal E/F
// actually require — that navigation is IMPOSSIBLE without a successful
// persisted write reaching this code — is provable directly, without a DOM:
// a failing fetcher structurally cannot produce a `view` for the caller to
// navigate with, because the `ok: false` branch never includes one.
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export type DecisionSubmissionResult<TView> =
  | { ok: true; view: TView }
  | { ok: false; error: string };

export async function submitRegionDecision<TView>(
  fetcher: FetchLike,
  projectId: string,
  sourceAssetSha256: string,
  regionMapHash: string,
  regionId: number,
  intent: WorkspaceDecision["intent"],
): Promise<DecisionSubmissionResult<TView>> {
  try {
    const res = await fetcher(`/api/projects/${projectId}/artwork-preparation/separation/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAssetSha256, regionMapHash, decisions: [{ regionId, intent }] }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? "That decision could not be saved" };
    }
    const view = (await res.json()) as TView;
    return { ok: true, view };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "That decision could not be saved" };
  }
}

export async function submitApproval<TView>(fetcher: FetchLike, projectId: string): Promise<DecisionSubmissionResult<TView>> {
  try {
    const res = await fetcher(`/api/projects/${projectId}/artwork-preparation/separation/approve`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? "This preparation could not be approved" };
    }
    const view = (await res.json()) as TView;
    return { ok: true, view };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "This preparation could not be approved" };
  }
}
