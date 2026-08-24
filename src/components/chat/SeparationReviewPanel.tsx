"use client";

import { useEffect, useRef, useState } from "react";

import {
  canStepRegion,
  computeAutoAdvanceTarget,
  computeRegionProgress,
  decisionForRegion,
  isFinalReviewReady,
  isRegionPending,
  regionPosition,
  selectInitialActiveRegionId,
  stepRegion,
  submitApproval,
  submitRegionDecision,
} from "./region-review-workspace";
import {
  hasInBoundsProposal,
  mapClickToSourcePixel,
  proposalNeedsDecision,
  selectPrimaryStep,
  submitProposalDecision,
  type ProposalDecision,
} from "./proposal-review-workspace";

/**
 * Intelligent Separation Phase 9: the INTERNAL OPERATOR's consequential-
 * region review surface (Goal 5).
 *
 * WHAT THIS COMPONENT DOES NOT DO. It never classifies a region itself, never
 * constructs a mask, and never decides which pixels change — every one of
 * those is server-side, deterministic, and re-verified on every write (see
 * `region-separation.ts` / `separation-review.ts`). This component is a thin
 * presentation layer over `SeparationReviewView`: it renders what the server
 * already decided and sends back only `{ regionId, intent }` pairs, or —
 * Phase 23 — `{ decision, rawTapX, rawTapY }` for the unified in-bounds
 * removal proposal. Every selection shown on screen is recomputed
 * server-side from raw coordinates; this component never sends a mask, a
 * pixel list, or a client-computed selection of any kind.
 *
 * SELF-CONTAINED BY DESIGN. Unlike `ProductionTreatmentPanel` (a prop-driven
 * slot inside the existing chat orchestration), this component fetches its
 * own state from the `separation` routes. That keeps the customer-facing
 * Existing Artwork flow (Goal 20) completely unaffected by this surface's
 * existence — nothing here is reachable unless something explicitly renders
 * it, and every route it calls independently re-enforces the internal-only
 * gate server-side (Goal 21/22) regardless of how this component got
 * mounted.
 *
 * Phase 15: WHY A FOCUSED WORKSPACE, NOT 18 CARDS. Phase 14 made each
 * region's own highlight unmistakable, but a long vertical list of 18 fully
 * expanded cards still left the operator unable to hold "where is this in
 * the whole design?" in mind while deciding — a semantic question, not a
 * geometric one. This component shows ONE region at a time (question +
 * decision), alongside a large, persistent view of the complete artwork with
 * that one region highlighted.
 *
 * Phase 23: WHY A PROPOSAL SCREEN IN FRONT OF THE REGION WORKSPACE. Phase 17
 * found that some in-bounds pixels were being silently, unconditionally
 * removed with no review surface at all (the exact "STRIKINGLY INCREDIBLE"
 * ribbon and bowling-pin defects). Those pixels are not consequential
 * REGIONS (Phase 9's isolated-interior-island concept) — they are part of
 * the border-connected exterior flood, just gated on being genuinely
 * in-bounds. The operator now sees and decides that whole area FIRST, as
 * ONE decision ("Looks Good" / "Keep All Highlighted" / "Preserve Part of
 * This"), with the pre-existing region-by-region workspace demoted to an
 * explicitly optional "Inspect individual areas" entry point — genuinely
 * optional (Phase 22B Issue 2: an undecided isolated region already retains
 * its pixels by default, so requiring an answer for every one of them
 * before approval was a workflow gate, not a pixel-safety rule).
 *
 * Navigation, progress, and the reload-resume rule all live in
 * `region-review-workspace.ts` / `proposal-review-workspace.ts` as pure
 * functions — nothing about region identity, proposal geometry, decision
 * meaning, or approval eligibility is recomputed here; every one of those
 * still comes from the server's own `SeparationReviewView` on every render.
 */

type RegionIntent = "substrate" | "ink" | "uncertain";

interface ConsequentialRegion {
  regionId: number;
  pixelCount: number;
  pctOfArtworkBounds: number;
  bounds: { left: number; top: number; width: number; height: number };
}

interface RegionDecision {
  regionId: number;
  intent: RegionIntent;
  source: "operator" | "semantic_suggestion" | "deterministic";
  decidedAt: string;
}

interface InBoundsProposal {
  proposalHash: string;
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number };
}

interface PreserveExceptionOperation {
  operationId: string;
  rawTapX: number;
  rawTapY: number;
  capRuleVersion: string;
  snapRuleVersion: string;
  decidedAt: string;
  source: "operator";
}

interface SeparationReviewView {
  state:
    | "review_not_required"
    | "review_required"
    | "review_in_progress"
    | "review_complete"
    | "cannot_safely_automate";
  regionMap: {
    sourceAssetSha256: string;
    regionMapHash: string;
    consequentialRegions: ConsequentialRegion[];
    inBoundsProposal: InBoundsProposal | null;
  };
  decisions: RegionDecision[];
  pendingRegionIds: number[];
  postCheck: { orphanedLightInkPixels: number; passed: boolean; reasons: string[] } | null;
  approvedAt: string | null;
  isProductionAuthoritative: boolean;
  proposalDecision: ProposalDecision | null;
  proposalPreserveOps: PreserveExceptionOperation[];
  readyForFinalApproval: boolean;
}

export interface SeparationReviewPanelProps {
  projectId: string;
  /** The garment colour to preview against, as a hex string or a name `resolveGarmentColor` understands. Preview only — never pixel authority (Goal 6). */
  garmentColor: string;
  /**
   * Intelligent Separation Phase 10: fires whenever this panel's
   * authoritative state changes, including the initial load (`null` while
   * loading or when no review exists at all). This is the ONE piece of
   * separation state the surrounding Existing Artwork flow needs — whether
   * its own one-click "Use Prepared Artwork" control remains safe to offer —
   * and it is lifted rather than re-fetched, so this panel stays the single
   * place that reads or writes separation state (Goal 3).
   */
  onStateChange?: (state: SeparationReviewView["state"] | null) => void;
  /**
   * Fires after "Use This Preparation" succeeds. `approveSeparationMaster`
   * updates `preparedAssetId` and the project's status server-side, which
   * this self-contained panel has no reason to know how to re-fetch — the
   * parent already owns that refresh (the same one every other preparation
   * action triggers).
   */
  onApproved?: () => void;
}

const GARMENT_INSPECTION_SURFACES = [
  { key: "black", hex: "#000000", label: "Black" },
  { key: "white", hex: "#FFFFFF", label: "White" },
  { key: "red", hex: "#B22234", label: "Red" },
  { key: "gray", hex: "#C8C8C8", label: "Gray" },
] as const;

/** Phase 15 copy: neutral framing that does not presume every region is substrate. */
const QUESTION_COPY = "Should this highlighted area print?";

const INTENT_COPY: Record<RegionIntent, { label: string; helper: string }> = {
  substrate: {
    label: "Show Shirt",
    helper: "The garment should show through this area.",
  },
  ink: {
    label: "Print Ink",
    helper: "This area is part of the artwork and should be printed.",
  },
  uncertain: {
    label: "Not Sure",
    helper: "Keep it for review if you cannot confidently decide.",
  },
};

type ContextMode = "original" | "highlighted" | "result";

const CONTEXT_MODE_OPTIONS: Array<{ key: ContextMode; label: string }> = [
  { key: "original", label: "Original" },
  { key: "highlighted", label: "Highlighted" },
  { key: "result", label: "Result" },
];

type ProposalViewMode = "original" | "proposal" | "result";

const PROPOSAL_VIEW_MODE_OPTIONS: Array<{ key: ProposalViewMode; label: string }> = [
  { key: "original", label: "Original" },
  { key: "proposal", label: "Proposed Removal" },
  { key: "result", label: "Result" },
];

const PROPOSAL_MAGNIFIER_SIZE = 160;
const PROPOSAL_MAGNIFIER_ZOOM = 6;

export function SeparationReviewPanel({
  projectId,
  garmentColor,
  onStateChange,
  onApproved,
}: SeparationReviewPanelProps) {
  const [view, setView] = useState<SeparationReviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewSurface, setPreviewSurface] = useState<string>(garmentColor);
  const [imageNonce, setImageNonce] = useState(0);
  // Which region the workspace is currently showing. `null` only before the
  // first load resolves, or while final review owns the screen.
  const [activeRegionId, setActiveRegionId] = useState<number | null>(null);
  const [contextMode, setContextMode] = useState<ContextMode>("highlighted");
  // Lets an operator step BACK from final review into the proposal or
  // region workspace to revisit a decision, without a second, competing
  // definition of "complete" — see the effect below that clears this for
  // proposal-less artwork the moment every region is decided again. For a
  // proposal-bearing artwork this is cleared only by an explicit
  // Continue/Done click (Phase 23) — resolving the proposal is a
  // deliberate action, never something that should silently sweep the
  // operator away mid-tap.
  const [forceShowWorkspace, setForceShowWorkspace] = useState(false);
  // Phase 23: which screen "forceShowWorkspace" (or the initial load, for a
  // proposal-bearing artwork not yet ready) actually shows — the proposal
  // screen itself, or the optional per-region workspace reached through
  // "Inspect individual areas" from it.
  const [inspectingRegions, setInspectingRegions] = useState(false);
  const [proposalViewMode, setProposalViewMode] = useState<ProposalViewMode>("proposal");
  const [proposalTapMode, setProposalTapMode] = useState(false);
  const [lastTap, setLastTap] = useState<{ x: number; y: number } | null>(null);
  const questionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const proposalImgRef = useRef<HTMLImageElement | null>(null);
  // The magnifier's zoom math needs the SOURCE image's natural pixel
  // dimensions. Reading `proposalImgRef.current?.naturalWidth` directly
  // during render doesn't work: a ref read is not reactive, so after a tap
  // swaps `src` (new nonce) the magnifier would render against whatever
  // dimensions happened to be on the DOM node at that exact render, before
  // the new image had actually finished loading — observed directly during
  // Phase 23 browser acceptance as a magnifier that silently failed to
  // appear right after the very first tap. Tracked in state instead, set
  // from the image's own `onLoad`, so the magnifier only ever measures a
  // fully loaded image and re-renders when a fresh one finishes loading.
  const [proposalImgNaturalSize, setProposalImgNaturalSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const hasInitializedActiveRegion = useRef(false);

  async function load() {
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-preparation/separation`);
      if (res.status === 404) {
        setView(null);
        return;
      }
      if (!res.ok) throw new Error("Failed to load the separation review");
      const data = (await res.json()) as SeparationReviewView;
      setView(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the separation review");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    onStateChange?.(view?.state ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.state]);

  // THE RELOAD-RESUME RULE (Goal G), applied exactly once per successful
  // load — never on every `view` update, which would otherwise fight manual
  // navigation and auto-advance every time a decision refreshes `view`.
  // Deferred via `setTimeout(...,0)`, the same pattern the mount-fetch
  // effect above and `FinalArtworkDeliveryCard` already use, so this stays
  // an external-system synchronization rather than a synchronous setState
  // cascade. Runs regardless of which primary step is showing — it only
  // seeds `activeRegionId` for whenever the region workspace is later
  // reached (directly, or through "Inspect individual areas").
  useEffect(() => {
    if (!view || hasInitializedActiveRegion.current) return;
    hasInitializedActiveRegion.current = true;
    const nextActiveRegionId = isFinalReviewReady(view) ? null : selectInitialActiveRegionId(view);
    const timer = setTimeout(() => setActiveRegionId(nextActiveRegionId), 0);
    return () => clearTimeout(timer);
  }, [view]);

  // Snap back to final review once every region is decided again — but
  // ONLY for proposal-less artwork (Phase 23: old behavior, completely
  // unchanged). When a proposal exists, leaving the workspace is always an
  // explicit Continue/Done click — see `continueToFinalReview` below —
  // never an automatic side effect of a decision changing underneath the
  // operator while they are actively tapping.
  useEffect(() => {
    if (!forceShowWorkspace || !view) return;
    if (hasInBoundsProposal(view)) return;
    if (!isFinalReviewReady(view)) return;
    const timer = setTimeout(() => setForceShowWorkspace(false), 0);
    return () => clearTimeout(timer);
  }, [forceShowWorkspace, view]);

  // Keyboard/screen-reader users land on the new question when the active
  // region changes, so stepping through 18 regions never silently leaves
  // focus behind on a control that scrolled out of view.
  useEffect(() => {
    questionHeadingRef.current?.focus();
  }, [activeRegionId]);

  async function decide(regionId: number, intent: RegionIntent) {
    if (!view) return;
    const wasPending = isRegionPending(view, regionId);
    setBusy(true);
    setError(null);
    const result = await submitRegionDecision<SeparationReviewView>(
      fetch,
      projectId,
      view.regionMap.sourceAssetSha256,
      view.regionMap.regionMapHash,
      regionId,
      intent,
    );
    // Persistence outcome is known BEFORE any navigation happens — the
    // `ok: false` branch never carries a `view`, so there is nothing for
    // `computeAutoAdvanceTarget` to navigate with even by mistake. The
    // operator is never advanced off a decision that did not actually save.
    if (result.ok) {
      setView(result.view);
      setImageNonce((n) => n + 1);
      // Only navigate when the pure function says to. `targetRegionId` is
      // `null` in BOTH the "advance to final review" case and the "stay put,
      // this was a revisit" case — collapsing those by navigating on
      // `targetRegionId` alone (instead of gating on `shouldAdvance`) would
      // silently bounce a revisit back to `regions[0]` via the render
      // fallback below, discarding the operator's position.
      const { shouldAdvance, targetRegionId } = computeAutoAdvanceTarget(wasPending, result.view);
      if (shouldAdvance) {
        setActiveRegionId(targetRegionId);
      }
      // A decision NEVER auto-finalizes anything (Goal 17) — reaching final
      // review here is a NAVIGATION (activeRegionId -> null, which the
      // final-review branch below renders), never an approval API call.
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  async function approve() {
    setBusy(true);
    setError(null);
    const result = await submitApproval<SeparationReviewView>(fetch, projectId);
    if (result.ok) {
      setView(result.view);
      onApproved?.();
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  // --- Phase 23: the unified in-bounds removal proposal --------------------

  async function decideProposal(decision: ProposalDecision) {
    if (!view?.regionMap.inBoundsProposal) return;
    setBusy(true);
    setError(null);
    const result = await submitProposalDecision<SeparationReviewView>(
      fetch,
      projectId,
      view.regionMap.sourceAssetSha256,
      view.regionMap.inBoundsProposal.proposalHash,
      decision,
    );
    if (result.ok) {
      setView(result.view);
      setImageNonce((n) => n + 1);
      // "Looks Good" / "Keep All Highlighted" are complete decisions —
      // leave the workspace immediately so the router advances to final
      // review (Phase 23's fast path: one click, done).
      setForceShowWorkspace(false);
      setProposalTapMode(false);
      setInspectingRegions(false);
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  function beginPreservePart() {
    setForceShowWorkspace(true);
    setProposalTapMode(true);
    setProposalViewMode("proposal");
    setInspectingRegions(false);
  }

  async function handleProposalTap(sourceX: number, sourceY: number) {
    if (!view?.regionMap.inBoundsProposal) return;
    setBusy(true);
    setError(null);
    const result = await submitProposalDecision<SeparationReviewView>(
      fetch,
      projectId,
      view.regionMap.sourceAssetSha256,
      view.regionMap.inBoundsProposal.proposalHash,
      "remove_with_exceptions",
      [{ rawTapX: sourceX, rawTapY: sourceY }],
    );
    if (result.ok) {
      setView(result.view);
      setImageNonce((n) => n + 1);
      setLastTap({ x: sourceX, y: sourceY });
      setProposalViewMode("proposal");
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  async function undoPreserveOp(operationId: string) {
    if (!view?.regionMap.inBoundsProposal) return;
    setBusy(true);
    setError(null);
    const result = await submitProposalDecision<SeparationReviewView>(
      fetch,
      projectId,
      view.regionMap.sourceAssetSha256,
      view.regionMap.inBoundsProposal.proposalHash,
      view.proposalDecision === "preserve_all" ? "preserve_all" : "remove_with_exceptions",
      undefined,
      [operationId],
    );
    if (result.ok) {
      setView(result.view);
      setImageNonce((n) => n + 1);
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  async function clearAllPreserveOps() {
    if (!view?.regionMap.inBoundsProposal || view.proposalPreserveOps.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await submitProposalDecision<SeparationReviewView>(
      fetch,
      projectId,
      view.regionMap.sourceAssetSha256,
      view.regionMap.inBoundsProposal.proposalHash,
      view.proposalDecision === "preserve_all" ? "preserve_all" : "remove_with_exceptions",
      undefined,
      view.proposalPreserveOps.map((op) => op.operationId),
    );
    if (result.ok) {
      setView(result.view);
      setImageNonce((n) => n + 1);
      setLastTap(null);
    } else {
      setError(result.error);
    }
    setBusy(false);
  }

  function continueFromProposal() {
    setForceShowWorkspace(false);
    setProposalTapMode(false);
    setInspectingRegions(false);
  }

  /**
   * Phase 23 browser-acceptance finding: `proposalTapMode` is local UI
   * state, so returning to this screen via "Review decisions again" (or any
   * fresh mount) after previously using "Preserve Part of This" left the
   * kept-spots panel hidden even though the taps themselves had persisted
   * correctly — the operator had no visible confirmation their spots were
   * still there without re-clicking "Preserve Part of This" first. The
   * panel now also shows itself whenever the SERVER's own state already
   * reflects an exceptions-based decision with at least one stored tap,
   * regardless of whether the local toggle was ever flipped this session.
   */
  function showPreserveMode(): boolean {
    if (proposalTapMode) return true;
    return view?.proposalDecision === "remove_with_exceptions" && view.proposalPreserveOps.length > 0;
  }

  function handleProposalImageClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!showPreserveMode() || busy) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const pixel = mapClickToSourcePixel(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      img.naturalWidth,
      img.naturalHeight,
    );
    if (!pixel) return; // Clicked in the letterbox padding — not on the image itself.
    void handleProposalTap(pixel.x, pixel.y);
  }

  if (loading) {
    return <p className="text-sm text-muted">Checking whether this artwork needs a separation review…</p>;
  }
  if (!view || view.state === "review_not_required") {
    // Goal 20 / Phase 15 easy-artwork regression: no consequential regions
    // and no in-bounds proposal (Phase 23) — this artwork needs nothing
    // from this surface, and the existing Existing Artwork workflow is
    // untouched. No extra round trip beyond the one GET this component
    // always makes on mount.
    return null;
  }

  const staleOrBroken = view.state === "cannot_safely_automate";
  const regions = view.regionMap.consequentialRegions;
  const progress = computeRegionProgress(view);

  const errorBanner = error ? (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" role="alert">
      {error}
    </p>
  ) : null;

  if (staleOrBroken) {
    return (
      <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-separation-review-state={view.state}>
        <p className="text-sm font-semibold text-ink">Review the artwork&rsquo;s dark areas</p>
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="alert">
          This review is out of date — reload before continuing.
        </p>
        {errorBanner}
      </div>
    );
  }

  // THE PRIMARY-STEP ROUTER (Phase 23). Pure, and re-evaluated on every
  // render from the server's own `view` plus one piece of local UI state —
  // never a second, hand-rolled definition of "complete" living here.
  const primaryStep = selectPrimaryStep(view, forceShowWorkspace);

  if (primaryStep === "final-review") {
    return (
      <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-separation-review-state={view.state} data-final-review>
        <p className="text-sm font-semibold text-ink">Review your artwork before continuing.</p>
        <p className="mt-1 text-sm text-muted">
          Every highlighted area has a decision. Check the complete result below on a few garment colours before using it.
        </p>
        {errorBanner}

        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Preview garment colour">
          {GARMENT_INSPECTION_SURFACES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setPreviewSurface(s.hex)}
              aria-pressed={previewSurface === s.hex}
              className={
                previewSurface === s.hex
                  ? "rounded-full border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-white"
                  : "rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
              }
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink">Original</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=original`}
              alt="Original artwork, untouched"
              className="mt-1 h-[280px] w-full rounded-lg border border-black/8 object-contain sm:h-[360px]"
            />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink">Prepared</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=master-preview&garment=${encodeURIComponent(previewSurface)}&v=${imageNonce}`}
              alt="Resulting prepared artwork on the selected garment colour"
              className="mt-1 h-[280px] w-full rounded-lg border border-black/8 object-contain sm:h-[360px]"
              style={{ backgroundColor: previewSurface }}
            />
          </div>
        </div>

        {view.postCheck && view.postCheck.orphanedLightInkPixels > 0 ? (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            Some light-coloured artwork near a &ldquo;Show Shirt&rdquo; area may lose contrast on light garments. Check the
            White and Gray previews above before continuing.
          </p>
        ) : null}

        <p className="mt-2 text-xs text-muted" data-original-safety-copy>
          Your original upload is saved and unchanged.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={approve}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
          >
            Use This Preparation
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setForceShowWorkspace(true);
              setActiveRegionId(regions[0]?.regionId ?? null);
            }}
            className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Review decisions again
          </button>
        </div>

        {view.isProductionAuthoritative ? (
          <p className="mt-3 text-xs text-ink" data-production-authoritative>
            This preparation is approved and in use.
          </p>
        ) : null}
      </div>
    );
  }

  // --- Phase 23: "Check what will be removed" — the primary proposal screen,
  //     with the optional per-region workspace reachable from inside it. ---
  if (primaryStep === "proposal-review" || (primaryStep === "proposal-preserve" && !inspectingRegions)) {
    const proposal = view.regionMap.inBoundsProposal!;
    const needsDecision = proposalNeedsDecision(view);
    const decision = view.proposalDecision;
    const canContinue = !needsDecision;

    const proposalImageUrl =
      proposalViewMode === "original"
        ? `/api/projects/${projectId}/artwork-preparation/separation/image?mode=original`
        : proposalViewMode === "proposal"
          ? `/api/projects/${projectId}/artwork-preparation/separation/image?mode=proposal-highlight&v=${imageNonce}`
          : `/api/projects/${projectId}/artwork-preparation/separation/image?mode=master-preview&garment=${encodeURIComponent(previewSurface)}&v=${imageNonce}`;

    const magnifierUrl = `/api/projects/${projectId}/artwork-preparation/separation/image?mode=proposal-highlight&v=${imageNonce}`;
    const naturalWidth = proposalImgNaturalSize.width;
    const naturalHeight = proposalImgNaturalSize.height;

    return (
      <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-separation-review-state={view.state} data-proposal-review>
        <p className="text-sm font-semibold text-ink">Check what will be removed</p>
        <p className="mt-1 text-sm text-muted">
          The highlighted area is connected to the background and would normally show the shirt through. Tell us what to
          do with it — or keep specific spots if only part of it matters.
        </p>
        {errorBanner}

        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Inspection mode">
          {PROPOSAL_VIEW_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setProposalViewMode(opt.key)}
              aria-pressed={proposalViewMode === opt.key}
              data-proposal-mode-button={opt.key}
              className={
                proposalViewMode === opt.key
                  ? "rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white"
                  : "rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
              }
            >
              {opt.label}
            </button>
          ))}
        </div>

        {proposalViewMode === "result" ? (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Preview garment colour">
            {GARMENT_INSPECTION_SURFACES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setPreviewSurface(s.hex)}
                aria-pressed={previewSurface === s.hex}
                className={
                  previewSurface === s.hex
                    ? "rounded-full border border-ink bg-ink px-3 py-1 text-xs font-medium text-white"
                    : "rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
                }
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={proposalImgRef}
          src={proposalImageUrl}
          alt={
            proposalViewMode === "proposal"
              ? "The artwork with the proposed removal highlighted, and any spots you've chosen to keep tinted differently"
              : proposalViewMode === "result"
                ? "The resulting artwork on the selected garment colour"
                : "The original artwork, untouched"
          }
          onClick={showPreserveMode() && proposalViewMode === "proposal" ? handleProposalImageClick : undefined}
          onLoad={(e) => {
            const img = e.currentTarget;
            setProposalImgNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
          }}
          className={
            "mt-2 h-[320px] w-full rounded-xl border border-black/8 object-contain sm:h-[420px] lg:h-[520px]" +
            (showPreserveMode() && proposalViewMode === "proposal" ? " cursor-crosshair" : "")
          }
          style={proposalViewMode === "result" ? { backgroundColor: previewSurface } : undefined}
          data-proposal-image
        />

        {showPreserveMode() ? (
          <div className="mt-3 rounded-xl border border-black/8 bg-black/[0.02] p-3" data-preserve-mode>
            <p className="text-xs font-semibold text-ink">Preserve part of this</p>
            <p className="mt-1 text-xs text-muted">
              Tap anywhere in the highlighted area above that you want to keep. We&rsquo;ll keep a small area around your
              tap and remove the rest.
            </p>
            {proposalViewMode !== "proposal" ? (
              <p className="mt-1 text-xs text-amber-900">Switch to &ldquo;Proposed Removal&rdquo; above to tap.</p>
            ) : null}

            {lastTap && naturalWidth > 0 && naturalHeight > 0 ? (
              <div className="mt-2">
                <p className="text-xs font-medium text-ink">Close-up of your last tap</p>
                <div
                  className="mt-1 overflow-hidden rounded-lg border-2 border-ink/15"
                  style={{
                    width: PROPOSAL_MAGNIFIER_SIZE,
                    height: PROPOSAL_MAGNIFIER_SIZE,
                    backgroundImage: `url(${magnifierUrl})`,
                    backgroundRepeat: "no-repeat",
                    backgroundSize: `${naturalWidth * PROPOSAL_MAGNIFIER_ZOOM}px ${naturalHeight * PROPOSAL_MAGNIFIER_ZOOM}px`,
                    backgroundPosition: `${-(lastTap.x * PROPOSAL_MAGNIFIER_ZOOM - PROPOSAL_MAGNIFIER_SIZE / 2)}px ${-(lastTap.y * PROPOSAL_MAGNIFIER_ZOOM - PROPOSAL_MAGNIFIER_SIZE / 2)}px`,
                  }}
                  data-preserve-magnifier
                />
                <p className="mt-1 text-xs text-muted">
                  If the spot you tapped still looks highlighted here, it was too far from the removed area to keep — try
                  tapping closer to its center.
                </p>
              </div>
            ) : null}

            {view.proposalPreserveOps.length > 0 ? (
              <div className="mt-3" data-preserve-op-list>
                <p className="text-xs font-medium text-ink">Kept spots ({view.proposalPreserveOps.length})</p>
                <ul className="mt-1 space-y-1">
                  {view.proposalPreserveOps.map((op, i) => (
                    <li key={op.operationId} className="flex items-center justify-between gap-2 text-xs text-muted" data-preserve-op={op.operationId}>
                      <span>Spot {i + 1}</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void undoPreserveOp(op.operationId)}
                        className="text-xs text-ink underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Undo
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void clearAllPreserveOps()}
                  className="mt-1 text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clear all kept spots
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="mt-3 text-xs text-muted" data-original-safety-copy>
          Your original upload is saved and unchanged.
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-3" role="group" aria-label="What to do with the highlighted area">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decideProposal("remove_with_exceptions")}
            aria-pressed={decision === "remove_with_exceptions" && view.proposalPreserveOps.length === 0}
            data-proposal-action="looks_good"
            className={
              decision === "remove_with_exceptions" && view.proposalPreserveOps.length === 0
                ? "rounded-xl border-2 border-ink bg-ink px-4 py-3 text-sm font-semibold text-white"
                : "rounded-xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-ink transition enabled:hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
            }
          >
            Looks Good
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decideProposal("preserve_all")}
            aria-pressed={decision === "preserve_all"}
            data-proposal-action="keep_all"
            className={
              decision === "preserve_all"
                ? "rounded-xl border-2 border-ink bg-ink px-4 py-3 text-sm font-semibold text-white"
                : "rounded-xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-ink transition enabled:hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
            }
          >
            Keep All Highlighted
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={beginPreservePart}
            aria-pressed={showPreserveMode()}
            data-proposal-action="preserve_part"
            className={
              showPreserveMode()
                ? "rounded-xl border-2 border-ink bg-ink px-4 py-3 text-sm font-semibold text-white"
                : "rounded-xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-ink transition enabled:hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
            }
          >
            Preserve Part of This
          </button>
        </div>
        <dl className="mt-2 space-y-1 text-xs text-muted">
          <div className="flex gap-1.5">
            <dt className="font-medium text-ink">Looks Good:</dt>
            <dd>Remove the highlighted area, exactly as shown.</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-medium text-ink">Keep All Highlighted:</dt>
            <dd>Keep the highlighted area instead of removing it.</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-medium text-ink">Preserve Part of This:</dt>
            <dd>Tap specific spots you want to keep, and remove the rest.</dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            disabled={busy || !canContinue}
            onClick={continueFromProposal}
            data-proposal-continue
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
          >
            Continue
          </button>
          {regions.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setForceShowWorkspace(true);
                setInspectingRegions(true);
                if (activeRegionId === null) setActiveRegionId(regions[0]?.regionId ?? null);
              }}
              className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              data-inspect-individual-areas
            >
              Inspect individual areas
            </button>
          ) : null}
        </div>
        {proposal.pixelCount === 0 ? null : null}
      </div>
    );
  }

  // --- The region-by-region workspace -------------------------------------
  const activeId = activeRegionId ?? regions[0]?.regionId ?? null;
  if (activeId === null) return null; // Unreachable: `regions.length > 0` whenever this branch renders.
  const currentIntent = decisionForRegion(view, activeId);
  const position = regionPosition(view, activeId);
  const canGoPrevious = canStepRegion(regions, activeId, "previous");
  const canGoNext = canStepRegion(regions, activeId, "next");

  const contextImageUrl =
    contextMode === "original"
      ? `/api/projects/${projectId}/artwork-preparation/separation/image?mode=original`
      : contextMode === "highlighted"
        ? `/api/projects/${projectId}/artwork-preparation/separation/image?mode=region-context&region=${activeId}&v=${imageNonce}`
        : `/api/projects/${projectId}/artwork-preparation/separation/image?mode=master-preview&garment=${encodeURIComponent(previewSurface)}&v=${imageNonce}`;

  return (
    <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-separation-review-state={view.state}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Review the artwork&rsquo;s dark areas</p>
        <p className="text-xs text-muted" role="status" data-progress>
          Area {position} of {progress.totalRegions} · {progress.reviewedCount} of {progress.totalRegions} reviewed
        </p>
      </div>

      {errorBanner}

      {hasInBoundsProposal(view) ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setInspectingRegions(false)}
          className="mt-2 text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          data-back-to-proposal
        >
          ← Back to removal review
        </button>
      ) : null}

      {/* Compact region navigator (Goal: "do NOT recreate the giant 18-card
          list") — one small chip per region, current/reviewed/pending state
          conveyed by both fill AND a label, never colour alone. */}
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Jump to a specific area" data-region-navigator>
        {regions.map((region) => {
          const reviewed = !isRegionPending(view, region.regionId);
          const isActive = region.regionId === activeId;
          return (
            <button
              key={region.regionId}
              type="button"
              disabled={busy}
              onClick={() => setActiveRegionId(region.regionId)}
              aria-current={isActive ? "step" : undefined}
              aria-label={`Area ${regionPosition(view, region.regionId)}${reviewed ? ", reviewed" : ", not yet reviewed"}`}
              data-region-chip={region.regionId}
              data-region-chip-reviewed={reviewed}
              className={
                isActive
                  ? "flex h-8 w-8 items-center justify-center rounded-full border-2 border-ink bg-ink text-xs font-semibold text-white"
                  : reviewed
                    ? "flex h-8 w-8 items-center justify-center rounded-full border border-ink/30 bg-black/[0.04] text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
                    : "flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-black/20 text-xs text-muted focus-visible:ring-2 focus-visible:ring-ink/40"
              }
            >
              {regionPosition(view, region.regionId)}
            </button>
          );
        })}
      </div>

      {/* Two-pane at lg+, single column (context first) below it. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        {/* CONTEXT PANE — sticky only at lg+; a sticky panel on a phone would
            just eat the viewport the close-up and controls need. */}
        <div className="lg:sticky lg:top-4" data-context-pane>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1.5" role="group" aria-label="Inspection mode">
              {CONTEXT_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setContextMode(opt.key)}
                  aria-pressed={contextMode === opt.key}
                  data-context-mode-button={opt.key}
                  className={
                    contextMode === opt.key
                      ? "rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white"
                      : "rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {contextMode === "result" ? (
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Preview garment colour">
              {GARMENT_INSPECTION_SURFACES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setPreviewSurface(s.hex)}
                  aria-pressed={previewSurface === s.hex}
                  className={
                    previewSurface === s.hex
                      ? "rounded-full border border-ink bg-ink px-3 py-1 text-xs font-medium text-white"
                      : "rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={contextImageUrl}
            alt="The complete artwork, with the area currently being reviewed highlighted"
            className="mt-2 h-[300px] w-full rounded-xl border border-black/8 object-contain sm:h-[380px] lg:h-[440px]"
            style={contextMode === "result" ? { backgroundColor: previewSurface } : undefined}
            data-context-image
          />
          <p className="mt-1.5 text-xs text-muted">Where this area sits in the complete design.</p>
        </div>

        {/* DECISION PANE */}
        <div data-decision-pane>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/projects/${projectId}/artwork-preparation/separation/image?mode=region-crop&region=${activeId}&v=${imageNonce}`}
            alt={`Close-up of the current area, area ${position} of ${progress.totalRegions}`}
            className="h-[220px] w-full rounded-xl border-2 border-ink/15 object-contain sm:h-[260px]"
            data-region-detail
          />

          <h3
            ref={questionHeadingRef}
            tabIndex={-1}
            className="mt-3 text-base font-semibold text-ink outline-none"
            data-region-question
          >
            {QUESTION_COPY}
          </h3>

          <div className="mt-3 grid gap-2 sm:grid-cols-3" role="group" aria-label={`Decision for area ${position}`}>
            {(["substrate", "ink", "uncertain"] as const).map((intent) => (
              <button
                key={intent}
                type="button"
                disabled={busy}
                onClick={() => decide(activeId, intent)}
                aria-pressed={currentIntent === intent}
                data-intent-button={intent}
                className={
                  currentIntent === intent
                    ? "rounded-xl border-2 border-ink bg-ink px-4 py-3 text-sm font-semibold text-white"
                    : "rounded-xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-ink transition enabled:hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
                }
              >
                {INTENT_COPY[intent].label}
              </button>
            ))}
          </div>
          <dl className="mt-2 space-y-1 text-xs text-muted">
            {(["substrate", "ink", "uncertain"] as const).map((intent) => (
              <div key={intent} className="flex gap-1.5">
                <dt className="font-medium text-ink">{INTENT_COPY[intent].label}:</dt>
                <dd>{INTENT_COPY[intent].helper}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 text-xs text-muted" data-original-safety-copy>
            Your original upload is saved and unchanged.
          </p>

          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={busy || !canGoPrevious}
              onClick={() => setActiveRegionId(stepRegion(regions, activeId, "previous"))}
              className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
              data-nav="previous"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={busy || !canGoNext}
              onClick={() => setActiveRegionId(stepRegion(regions, activeId, "next"))}
              className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ink/40"
              data-nav="next"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
