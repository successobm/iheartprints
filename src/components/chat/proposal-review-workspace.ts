/**
 * Intelligent Separation Phase 23: pure state/geometry logic for the
 * unified in-bounds removal PROPOSAL workflow — "Check What Will Be
 * Removed" -> optional "Preserve Part of This" tap mode -> final review.
 * Extracted from `SeparationReviewPanel` for the same reason
 * `region-review-workspace.ts` was: this repo's test tooling is `node:test`
 * + `renderToString` (no DOM, no effects), so anything provable across a
 * sequence of interactions has to live somewhere a plain function call can
 * exercise it.
 *
 * NOTHING HERE RECOMPUTES SEPARATION STATE OR SELECTS PIXELS. The server's
 * `selectPreserveException` (snap + geodesic cap) is the ONLY place a tap
 * becomes a selection — this module's `mapClickToSourcePixel` does exactly
 * one thing: convert a click inside an `object-contain`-fit `<img>` element
 * into the SOURCE image's raw pixel coordinates, so the raw coordinates —
 * never a mask, never a selection — are what gets sent to the server.
 */

export interface ObjectContainRect {
  /** Where the image's actual (letterboxed) content starts within the element, in element-local CSS pixels. */
  contentX: number;
  contentY: number;
  /** The rendered size of the image content itself (excluding letterbox padding), in element-local CSS pixels. */
  contentWidth: number;
  contentHeight: number;
}

/**
 * The rectangle a `background-size: contain` / `object-fit: contain` image
 * actually occupies inside its element — i.e. where the letterboxing sits.
 * Pure geometry; matches the CSS spec's `contain` algorithm exactly (scale
 * by the smaller of the two axis ratios, center the remainder).
 */
export function computeObjectContainRect(
  elementWidth: number,
  elementHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): ObjectContainRect {
  if (elementWidth <= 0 || elementHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return { contentX: 0, contentY: 0, contentWidth: 0, contentHeight: 0 };
  }
  const scale = Math.min(elementWidth / naturalWidth, elementHeight / naturalHeight);
  const contentWidth = naturalWidth * scale;
  const contentHeight = naturalHeight * scale;
  return {
    contentX: (elementWidth - contentWidth) / 2,
    contentY: (elementHeight - contentHeight) / 2,
    contentWidth,
    contentHeight,
  };
}

export interface SourcePixel {
  x: number;
  y: number;
}

/**
 * Converts an element-local click position into the SOURCE image's raw
 * pixel coordinates — the exact `rawTapX`/`rawTapY` the proposal-decision
 * route expects. Returns `null` when the click landed in the letterbox
 * padding (outside the image content itself), so the caller can ignore it
 * rather than send a meaningless coordinate. Clamps into `[0, natural-1]`
 * so a click on the image's own edge never rounds outside its bounds.
 */
export function mapClickToSourcePixel(
  clickX: number,
  clickY: number,
  elementWidth: number,
  elementHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): SourcePixel | null {
  const rect = computeObjectContainRect(elementWidth, elementHeight, naturalWidth, naturalHeight);
  if (rect.contentWidth <= 0 || rect.contentHeight <= 0) return null;
  const relX = clickX - rect.contentX;
  const relY = clickY - rect.contentY;
  if (relX < 0 || relY < 0 || relX > rect.contentWidth || relY > rect.contentHeight) return null;
  const sx = Math.floor((relX / rect.contentWidth) * naturalWidth);
  const sy = Math.floor((relY / rect.contentHeight) * naturalHeight);
  return {
    x: Math.min(Math.max(sx, 0), naturalWidth - 1),
    y: Math.min(Math.max(sy, 0), naturalHeight - 1),
  };
}

/**
 * The inverse mapping, for placing a magnified-detail viewport centered on
 * a source pixel: element-local CSS coordinates for a given source pixel,
 * so a caller can position a zoomed crop without any additional geometry.
 */
export function mapSourcePixelToDisplay(
  sourceX: number,
  sourceY: number,
  elementWidth: number,
  elementHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number } {
  const rect = computeObjectContainRect(elementWidth, elementHeight, naturalWidth, naturalHeight);
  if (rect.contentWidth <= 0 || rect.contentHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return { x: elementWidth / 2, y: elementHeight / 2 };
  }
  return {
    x: rect.contentX + (sourceX / naturalWidth) * rect.contentWidth,
    y: rect.contentY + (sourceY / naturalHeight) * rect.contentHeight,
  };
}

// ---------------------------------------------------------------------------
// Proposal-decision view shape + navigation helpers.
// ---------------------------------------------------------------------------

export type ProposalDecision = "pending" | "remove_with_exceptions" | "preserve_all";

export interface PreserveOpLike {
  operationId: string;
  rawTapX: number;
  rawTapY: number;
}

export interface ProposalViewLike {
  regionMap: { inBoundsProposal: { proposalHash: string } | null };
  proposalDecision: ProposalDecision | null;
  proposalPreserveOps: readonly PreserveOpLike[];
  readyForFinalApproval: boolean;
}

/** Whether this artwork has anything for the proposal workflow to show at all — the Goal 20/22 easy-artwork short-circuit. */
export function hasInBoundsProposal(view: ProposalViewLike): boolean {
  return view.regionMap.inBoundsProposal !== null;
}

/**
 * Whether the operator still needs to make the top-level proposal call
 * ("Looks Good" / "Keep All Highlighted" / "Preserve Part of This") before
 * anything else in the workflow is reachable. `null`/missing decisions and
 * `"pending"` are the same thing here — both mean "not yet decided",
 * matching the server's own fail-closed `effectiveProposalDecision`.
 */
export function proposalNeedsDecision(view: ProposalViewLike): boolean {
  if (!hasInBoundsProposal(view)) return false;
  return view.proposalDecision === "pending" || view.proposalDecision === null;
}

/**
 * THE PRIMARY-STEP ROUTER. Three steps, in this priority order:
 *   1. "proposal-review"   the proposal exists and is still pending
 *   2. "final-review"      everything required for approval is satisfied
 *   3. "proposal-preserve" the proposal was decided `remove_with_exceptions`
 *                           and the operator is refining exceptions, OR
 *                           there is no proposal at all and the existing
 *                           region-by-region workspace remains primary
 *                           (Goal 20/22: this function never changes what
 *                           happens when `inBoundsProposal === null`).
 */
export type PrimaryStep = "proposal-review" | "proposal-preserve" | "region-workspace" | "final-review";

export function selectPrimaryStep(view: ProposalViewLike, forceShowWorkspace: boolean): PrimaryStep {
  if (view.readyForFinalApproval && !forceShowWorkspace) return "final-review";
  if (proposalNeedsDecision(view)) return "proposal-review";
  if (hasInBoundsProposal(view)) return "proposal-preserve";
  return "region-workspace";
}

// ---------------------------------------------------------------------------
// Fetch-wrapping helper, parameterized by an injectable `fetch`-like
// function — mirrors `region-review-workspace.ts`'s `submitRegionDecision`
// exactly, so persistence success is provable without a DOM the same way.
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

export type ProposalSubmissionResult<TView> = { ok: true; view: TView } | { ok: false; error: string };

export async function submitProposalDecision<TView>(
  fetcher: FetchLike,
  projectId: string,
  sourceAssetSha256: string,
  proposalHash: string,
  decision: ProposalDecision,
  addPreserveTaps?: Array<{ rawTapX: number; rawTapY: number }>,
  removePreserveOperationIds?: string[],
): Promise<ProposalSubmissionResult<TView>> {
  try {
    const res = await fetcher(`/api/projects/${projectId}/artwork-preparation/separation/decisions/proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceAssetSha256,
        proposalHash,
        decision,
        addPreserveTaps: addPreserveTaps ?? [],
        removePreserveOperationIds: removePreserveOperationIds ?? [],
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? "That could not be saved" };
    }
    const view = (await res.json()) as TView;
    return { ok: true, view };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "That could not be saved" };
  }
}
