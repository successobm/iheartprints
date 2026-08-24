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

/**
 * Intelligent Separation Phase 9: the INTERNAL OPERATOR's consequential-
 * region review surface (Goal 5).
 *
 * WHAT THIS COMPONENT DOES NOT DO. It never classifies a region itself, never
 * constructs a mask, and never decides which pixels change — every one of
 * those is server-side, deterministic, and re-verified on every write (see
 * `region-separation.ts` / `separation-review.ts`). This component is a thin
 * presentation layer over `SeparationReviewView`: it renders what the server
 * already decided and sends back only `{ regionId, intent }` pairs.
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
 * geometric one. This component now shows ONE region at a time (question +
 * decision), alongside a large, persistent view of the complete artwork with
 * that one region highlighted. Navigation, progress, and the reload-resume
 * rule all live in `region-review-workspace.ts` as pure functions — nothing
 * about region identity, decision meaning, or approval eligibility is
 * recomputed here; every one of those still comes from the server's own
 * `SeparationReviewView` on every render.
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
  };
  decisions: RegionDecision[];
  pendingRegionIds: number[];
  postCheck: { orphanedLightInkPixels: number; passed: boolean; reasons: string[] } | null;
  approvedAt: string | null;
  isProductionAuthoritative: boolean;
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
  // Lets an operator step BACK from final review into the region workspace
  // to revisit a decision, without a second, competing definition of
  // "complete" — see the effect below that clears this the moment the
  // server's own state says every region is decided again.
  const [forceShowWorkspace, setForceShowWorkspace] = useState(false);
  const questionHeadingRef = useRef<HTMLHeadingElement | null>(null);
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
  // cascade.
  useEffect(() => {
    if (!view || hasInitializedActiveRegion.current) return;
    hasInitializedActiveRegion.current = true;
    const nextActiveRegionId = isFinalReviewReady(view) ? null : selectInitialActiveRegionId(view);
    const timer = setTimeout(() => setActiveRegionId(nextActiveRegionId), 0);
    return () => clearTimeout(timer);
  }, [view]);

  // Snap back to final review once every region is decided again — the
  // natural end of "revisit a decision from final review", without a
  // second, hand-rolled definition of "complete" living in this component.
  useEffect(() => {
    if (!forceShowWorkspace || !view || !isFinalReviewReady(view)) return;
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

  if (loading) {
    return <p className="text-sm text-muted">Checking whether this artwork needs a separation review…</p>;
  }
  if (!view || view.state === "review_not_required") {
    // Goal 20 / Phase 15 easy-artwork regression: no consequential regions —
    // this artwork needs nothing from this surface, and the existing
    // Existing Artwork workflow is untouched. No extra round trip beyond
    // the one GET this component always makes on mount.
    return null;
  }

  const staleOrBroken = view.state === "cannot_safely_automate";
  const regions = view.regionMap.consequentialRegions;
  const progress = computeRegionProgress(view);
  const showFinalReview = isFinalReviewReady(view) && !forceShowWorkspace;

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

  if (showFinalReview) {
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

  // --- The region-by-region workspace -------------------------------------
  const activeId = activeRegionId ?? regions[0]?.regionId ?? null;
  if (activeId === null) return null; // Unreachable: `regions.length > 0` whenever review is required.
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
