"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SignEdge, SignFitToProductionSummary } from "@/capabilities/sign-preparation";

import {
  canShowPixelPreview,
  resolveEffectiveViewMode,
  resolveMainImageSrc,
} from "./sign-correction-preview-view";
import { clampZoom, computeFitZoom } from "./sign-canvas-zoom";
import {
  resolveSignProductionFitPanelMode,
  resolveSignProductionFitState,
  SIGN_PRODUCTION_FIT_PANEL_COPY,
  type SignProductionFitState,
} from "./sign-production-fit-state";
import { computeDisplayPpi, deriveEdgeChips, deriveOverallFitLabel } from "./sign-workspace-status";

/**
 * Signs Normal Workstation Simplification Phase: this component IS the
 * operator's NORMAL production workstation for ordinary flattened sign
 * artwork. The real Get Hibachi acceptance established that an ordinary
 * safe-area violation is solved by ONE deterministic, whole-composition
 * action — "Fit artwork to safe area" (uniform scale, no stretch, no crop,
 * exact ordered canvas preserved, governed background extension to CUT) —
 * never by selecting or editing individual artwork. This screen therefore
 * shows exactly that: INSPECT (status bar + SAFE/CUT guide) -> DIAGNOSE
 * (the recommended-action panel) -> FIT (one click) -> PREVIEW (the real,
 * full-resolution proposed result on the main canvas, Show
 * original/preview) -> APPLY (the same governed re-plan + re-authorize +
 * prepare pipeline every other Signs plan change already uses) ->
 * authoritative PrintValidation, unchanged.
 *
 * Wand, rectangle-selection Move/Remove/Destination-X/Y, and "Advanced
 * pixel correction" are DELIBERATELY ABSENT from this screen — not merely
 * collapsed behind a link. The underlying capability (flood-fill
 * selection, `move_region`/`replace_region_with_background`/
 * `replace_masked_region_with_background`, edge-intent classification, the
 * `wand-select`/`correction-preview`/`correction-commit` routes, and every
 * test proving them) is UNCHANGED and fully intact for historical/
 * exceptional workflows — this is a product-surface cleanup, not an
 * engine removal. If production evidence later proves a genuine need for
 * a contextual classification interaction, that is a separate, deliberate
 * future design task (Section I) — this phase does not build it.
 *
 * Zero provider calls anywhere in this file — the Fit preview is one
 * same-origin, deterministic, in-memory round trip, never Topaz, never
 * OpenAI.
 */

interface PreviewEdge {
  edge: SignEdge;
  requiredProtectedInsetPx: number;
  requiredProtectedInsetIn: number;
  nearestProtectedContentPx: number | null;
  nearestProtectedContentIn: number | null;
  violatingPositionPx: number | null;
  protectedResult: "pass" | "fail" | "unknown";
  reason: string;
  edgeIntentPresent: boolean;
  edgeIntentNearestCutPx: number | null;
  edgeIntentAdvisory: boolean;
  unresolvedAmbiguousPresent: boolean;
}

/** Wire shape of `POST .../sign-artwork/safe-area-fit-preview` — mirrors `SignSafeAreaFitPreviewResult` in `sign-artwork-service.ts`. */
interface FitPreviewResponse {
  status: "no_candidate" | "unsupported_plan_shape" | "background_not_determinable" | "no_area" | "previewed";
  previewPngBase64: string | null;
  fitToProduction: { edges: PreviewEdge[]; overallResult: "pass" | "fail" | "unknown" } | null;
  insetPxX: number | null;
  insetPxY: number | null;
  /** The uniform scale actually applied (0.989 = 98.9%) — derived from the real plan, never fabricated. */
  scale: number | null;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const ZOOM_BOUNDS = { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };
const ALL_EDGES: readonly SignEdge[] = ["top", "right", "bottom", "left"];

export function SignFitToProductionCorrectionTool({
  projectId,
  fitToProduction,
  orderedWidthIn,
  orderedHeightIn,
  artworkWidthPx,
  artworkHeightPx,
}: {
  projectId: string;
  fitToProduction: SignFitToProductionSummary;
  orderedWidthIn: number;
  orderedHeightIn: number;
  artworkWidthPx: number;
  artworkHeightPx: number;
}) {
  const router = useRouter();
  const candidateUrl = `/api/internal/projects/${projectId}/sign-artwork/production-candidate`;

  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoomState] = useState(1);

  const [busyKind, setBusyKind] = useState<"fit-preview" | "fit-apply" | null>(null);
  const busy = busyKind !== null;
  const [error, setError] = useState<string | null>(null);
  const [fitPreview, setFitPreview] = useState<FitPreviewResponse | null>(null);
  // Section E/G: which artwork the MAIN canvas shows. Only ever actually
  // "preview" when a real Fit preview exists to show — see
  // `canShowPreview`/`effectiveViewMode` below, which force "original"
  // otherwise so this piece of state can never by itself imply a preview
  // that isn't really there.
  const [viewMode, setViewMode] = useState<"original" | "preview">("preview");
  const initialImageLoadRef = useRef(false);

  const setZoom = useCallback((z: number) => setZoomState(clampZoom(z, ZOOM_BOUNDS)), []);

  const displayWidth = naturalSize ? Math.round(naturalSize.width * zoom) : 0;
  const displayHeight = naturalSize ? Math.round(naturalSize.height * zoom) : 0;

  // Normalized into the shape the main-canvas preview machinery (accepted
  // in the prior phase) already expects — no changes needed to those
  // pure, already-tested functions.
  const normalizedFitPreview =
    fitPreview && fitPreview.status === "previewed" && fitPreview.previewPngBase64
      ? { status: "previewed" as const, appliedCount: 1, hasPixelChange: true, afterPngBase64: fitPreview.previewPngBase64 }
      : null;

  // The single current source of truth for the STATUS BAR and canvas SAFE
  // guide: the active preview's own recheck once one exists, otherwise the
  // plan's last authoritative evidence — informative "what would happen if
  // applied" during a preview, exactly as the real browser acceptance
  // already confirmed correct.
  const currentEdges: PreviewEdge[] = fitPreview?.fitToProduction?.edges ?? (fitToProduction.edges as PreviewEdge[]);
  const currentOverallStatus = fitPreview?.fitToProduction ? fitPreview.fitToProduction.overallResult : fitToProduction.status;

  const canShowPreview = canShowPixelPreview(normalizedFitPreview);
  const effectiveViewMode = resolveEffectiveViewMode(viewMode, normalizedFitPreview);
  const mainImageSrc = resolveMainImageSrc(effectiveViewMode, normalizedFitPreview, candidateUrl);

  // Section F/G (the real browser-acceptance copy-contradiction fix): the
  // RECOMMENDED-ACTION panel's content is decided by `resolveSign
  // ProductionFitPanelMode`, which checks the ACTIVE PREVIEW first and
  // consults `persistedFitState` (derived ONLY from the current, already-
  // persisted candidate's own evidence — never an unapplied preview) as
  // the fallback. A passing, unapplied Fit preview can therefore never
  // render as "Ready as supplied" — that copy is reachable only through
  // `persistedFitState`, which is never consulted while a preview exists.
  const persistedFitState: SignProductionFitState = resolveSignProductionFitState(fitToProduction.edges as PreviewEdge[]);
  const fitPanelMode = resolveSignProductionFitPanelMode(persistedFitState, fitPreview?.status ?? null);
  const canApplyFit = !busy && fitPreview !== null && fitPreview.status === "previewed";

  const edgeChips = useMemo(
    () =>
      deriveEdgeChips(
        currentEdges.map((e) => ({ edge: e.edge, protectedResult: e.protectedResult, edgeIntentPresent: e.edgeIntentPresent })),
      ),
    [currentEdges],
  );
  const overallFitLabel = deriveOverallFitLabel(currentOverallStatus);
  const displayPpi = computeDisplayPpi(fitToProduction.achievedPpiX, fitToProduction.achievedPpiY);
  // The status bar's pixel figure is the CANDIDATE's own real pixel size —
  // prefer the loaded image's actual naturalWidth/naturalHeight (the same
  // value the guide overlay math already trusts) over the plan's source-
  // artwork dimensions, which describe the pre-composition input artwork
  // and can carry a different aspect ratio entirely once a composition
  // plan has run.
  const displayArtworkWidthPx = naturalSize?.width ?? artworkWidthPx;
  const displayArtworkHeightPx = naturalSize?.height ?? artworkHeightPx;

  // Overlay: CUT boundary (implicit — the canvas edge itself), SAFE guide
  // per axis (from the SERVER's own already-computed
  // requiredProtectedInsetPx — never a client-side re-derivation), a
  // highlight band coloured by that edge's OWN protectedResult (never a
  // blanket "artwork present = violation" — pass is never highlighted),
  // and an accent marker at the edge's own worst evidence position
  // (`violatingPositionPx` — an evidence position, never an object
  // detection). No selection/wand overlay — there is no selection concept
  // in the normal workstation.
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const edgeByName = new Map(currentEdges.map((e) => [e.edge, e]));
    const top = edgeByName.get("top");
    const right = edgeByName.get("right");
    const bottom = edgeByName.get("bottom");
    const left = edgeByName.get("left");

    // SAFE guide — a thin dashed line inset from each edge by that edge's
    // own requiredProtectedInsetPx, scaled to the current display size.
    ctx.save();
    ctx.strokeStyle = "rgba(16, 185, 129, 0.9)"; // emerald
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    if (top) {
      const y = top.requiredProtectedInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    if (bottom) {
      const y = canvas.height - bottom.requiredProtectedInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    if (left) {
      const x = left.requiredProtectedInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    if (right) {
      const x = canvas.width - right.requiredProtectedInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    ctx.restore();

    // Violation highlight bands — the full required-inset-depth band along
    // each failing/unknown edge, coloured by WHY: red for unresolved
    // ambiguous review, orange for acknowledged protected content still
    // too close, amber for unknown (no provable bleed baseline). A PASS
    // edge (including one whose only near-cut content is governed
    // EDGE_INTENT_ARTWORK or BLEED_BACKGROUND) is never highlighted — the
    // guide is not a blanket no-artwork zone.
    ctx.save();
    ctx.setLineDash([]);
    for (const [edge, e] of [["top", top], ["right", right], ["bottom", bottom], ["left", left]] as const) {
      if (!e || e.protectedResult === "pass") continue;
      const bandColor =
        e.protectedResult === "unknown" ? "rgba(234, 179, 8, 0.18)"
        : e.unresolvedAmbiguousPresent ? "rgba(239, 68, 68, 0.18)"
        : "rgba(249, 115, 22, 0.18)"; // acknowledged protected, still too close
      const markerColor =
        e.protectedResult === "unknown" ? "rgba(161, 98, 7, 0.95)"
        : e.unresolvedAmbiguousPresent ? "rgba(185, 28, 28, 0.95)"
        : "rgba(194, 65, 12, 0.95)";
      ctx.fillStyle = bandColor;
      const depth = e.requiredProtectedInsetPx * zoom;
      if (edge === "top") ctx.fillRect(0, 0, canvas.width, depth);
      else if (edge === "bottom") ctx.fillRect(0, canvas.height - depth, canvas.width, depth);
      else if (edge === "left") ctx.fillRect(0, 0, depth, canvas.height);
      else ctx.fillRect(canvas.width - depth, 0, depth, canvas.height);

      // Worst-evidence-position marker — a short accent tick, never implied
      // to be an object outline.
      if (e.violatingPositionPx !== null) {
        const pos = e.violatingPositionPx * zoom;
        ctx.fillStyle = markerColor;
        const tick = 5;
        if (edge === "top") ctx.fillRect(pos - tick / 2, 0, tick, depth);
        else if (edge === "bottom") ctx.fillRect(pos - tick / 2, canvas.height - depth, tick, depth);
        else if (edge === "left") ctx.fillRect(0, pos - tick / 2, depth, tick);
        else ctx.fillRect(canvas.width - depth, pos - tick / 2, depth, tick);
      }
    }
    ctx.restore();
  }, [naturalSize, zoom, currentEdges]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return;
    canvas.width = displayWidth;
    canvas.height = displayHeight;
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resize only, redraw handled by drawOverlay effect above.
  }, [displayWidth, displayHeight, naturalSize]);

  function zoomFit() {
    const vp = viewportRef.current;
    if (!vp || !naturalSize) return;
    setZoom(computeFitZoom(naturalSize, { width: vp.clientWidth, height: vp.clientHeight }, ZOOM_BOUNDS));
  }

  async function runFitPreview() {
    setBusyKind("fit-preview");
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/safe-area-fit-preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json().catch(() => null)) as FitPreviewResponse | { error?: string } | null;
      if (!res.ok || !body || "error" in body) {
        setError((body as { error?: string } | null)?.error ?? "That didn't work. Please try again.");
        setBusyKind(null);
        return;
      }
      setFitPreview(body as FitPreviewResponse);
      setViewMode("preview");
      setBusyKind(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setBusyKind(null);
    }
  }

  function cancelFitPreview() {
    setFitPreview(null);
    setError(null);
  }

  async function applyFitToSafeArea() {
    if (!canApplyFit) return;
    setBusyKind("fit-apply");
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/safe-area-fit-apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setBusyKind(null);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setBusyKind(null);
    }
  }

  return (
    <section className="flex flex-col gap-3" data-sign-correction-tool>
      {/* Compact production status bar: the operator should understand
          production state in seconds, without reading a paragraph
          elsewhere on the page. */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink/15 bg-card px-3 py-2 text-sm"
        data-sign-workspace-status
      >
        <span className="font-semibold text-ink">Sign Production</span>
        <span className="text-ink">{orderedWidthIn}&quot; × {orderedHeightIn}&quot;</span>
        <span className="text-ink">{displayArtworkWidthPx} × {displayArtworkHeightPx} px</span>
        {displayPpi !== null ? <span className="text-ink">{displayPpi} PPI</span> : null}
        <span
          className={`font-semibold ${overallFitLabel === "READY" ? "text-emerald-700" : "text-red-700"}`}
          data-sign-workspace-fit-label
        >
          FIT: {overallFitLabel}
        </span>
        <span className="flex flex-wrap gap-3 text-xs sm:ml-auto" data-sign-workspace-edge-chips>
          {edgeChips.map((c) => (
            <span key={c.edge} className={c.pass ? "text-emerald-700" : "text-red-700"}>
              {c.edge.toUpperCase()} {c.label}
              {c.edgeIntent ? " · edge artwork" : ""}
            </span>
          ))}
        </span>
      </div>

      {/* Canvas | recommended-action panel. No tool rail — there is no
          normal editing workflow to select a tool for. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm" data-sign-zoom-controls>
            <button
              type="button"
              onClick={() => setZoom(zoom - ZOOM_STEP)}
              className="rounded border border-ink/20 px-2 py-1 text-ink"
              aria-label="Zoom out"
              data-testid="sign-correction-zoom-out"
            >
              −
            </button>
            <span className="w-12 text-center text-xs text-muted" data-testid="sign-correction-zoom-pct">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom(zoom + ZOOM_STEP)}
              className="rounded border border-ink/20 px-2 py-1 text-ink"
              aria-label="Zoom in"
              data-testid="sign-correction-zoom-in"
            >
              +
            </button>
            <button
              type="button"
              onClick={zoomFit}
              className="rounded border border-ink/20 px-2.5 py-1 text-ink"
              data-testid="sign-correction-zoom-fit"
            >
              Fit
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="rounded border border-ink/20 px-2.5 py-1 text-ink"
              data-testid="sign-correction-zoom-100"
            >
              100%
            </button>
          </div>

          {/* Original/Preview comparison — visible only while a real Fit
              preview exists to compare against. */}
          {canShowPreview ? (
            <div className="flex flex-wrap items-center gap-3 text-xs" data-sign-correction-canvas-status>
              <div
                className="flex items-center gap-1 rounded-full border border-ink/20 p-0.5"
                role="tablist"
                aria-label="Compare original artwork and proposed fit"
                data-sign-correction-view-toggle
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveViewMode === "original"}
                  onClick={() => setViewMode("original")}
                  className={`rounded-full px-2.5 py-1 font-medium transition ${
                    effectiveViewMode === "original" ? "bg-ink text-white" : "text-ink hover:bg-ink/10"
                  }`}
                  data-testid="sign-correction-view-original"
                >
                  Show original
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveViewMode === "preview"}
                  onClick={() => setViewMode("preview")}
                  className={`rounded-full px-2.5 py-1 font-medium transition ${
                    effectiveViewMode === "preview" ? "bg-ink text-white" : "text-ink hover:bg-ink/10"
                  }`}
                  data-testid="sign-correction-view-preview"
                >
                  Show preview
                </button>
              </div>
            </div>
          ) : null}

          <div
            ref={viewportRef}
            className="relative h-[72vh] min-h-[420px] overflow-auto rounded border border-ink/10 bg-ink/5"
          >
            <div style={{ position: "relative", width: displayWidth || undefined, height: displayHeight || undefined }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool, not the customer image pipeline */}
              <img
                ref={imgRef}
                src={mainImageSrc}
                alt={
                  effectiveViewMode === "preview"
                    ? "Proposed fitted result"
                    : "Current production candidate"
                }
                style={{ width: displayWidth || undefined, height: displayHeight || undefined, display: "block" }}
                data-sign-correction-canvas-mode={effectiveViewMode}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  const natural = { width: el.naturalWidth, height: el.naturalHeight };
                  setNaturalSize(natural);
                  // Auto-fit only the very first time an image loads —
                  // toggling Original/Preview must never yank the
                  // operator's own zoom back to Fit.
                  if (!initialImageLoadRef.current) {
                    initialImageLoadRef.current = true;
                    const vp = viewportRef.current;
                    if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
                      setZoom(computeFitZoom(natural, { width: vp.clientWidth, height: vp.clientHeight }, ZOOM_BOUNDS));
                    }
                  }
                }}
              />
              <canvas
                ref={canvasRef}
                style={{ position: "absolute", left: 0, top: 0 }}
                data-testid="sign-correction-canvas"
              />
              {busyKind === "fit-preview" ? (
                <div
                  className="absolute inset-0 flex items-center justify-center bg-white/70"
                  role="status"
                  aria-live="polite"
                  data-sign-correction-preview-loading
                >
                  <span className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white">
                    Generating preview…
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted">
            <span className="font-medium text-emerald-700">Dashed guide</span> = 0.125&quot; SAFE area for important
            content. Background and bleed may extend to the cut edge.
          </p>
        </div>

        <div className="flex flex-col gap-3" data-sign-context-panel>
          <ProductionFitPanel
            edges={currentEdges}
            fitPanelMode={fitPanelMode}
            persistedFitState={persistedFitState}
            fitPreview={fitPreview}
            busyKind={busyKind}
            canApplyFit={canApplyFit}
            runFitPreview={runFitPreview}
            cancelFitPreview={cancelFitPreview}
            applyFitToSafeArea={applyFitToSafeArea}
          />

          {error ? (
            <p className="text-sm text-red-600" role="alert" data-sign-correction-error>
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const PERSISTED_STATE_LABEL: Record<SignProductionFitState, string> = {
  ready_as_supplied: "ready as supplied (already passes)",
  fit_adjustment_required: "needs Fit (not yet applied)",
  edge_classification_needed: "needs production review",
};

/**
 * Signs Normal Workstation Simplification Phase (Section E/F/G): the
 * workstation's ONLY right-rail panel — "Production Fit." Shows the
 * CURRENT, persisted candidate's own recommended action by default (Ready
 * as supplied / Fit artwork to safe area / Edge content needs production
 * review — Section I: no Wand offered here, ever), and — the moment a Fit
 * preview exists — switches EXCLUSIVELY to "Fit preview ready" (or one of
 * the fail-closed review states), with an explicit CURRENT-vs-PREVIEW
 * status line so the two are never conflated (Section G).
 */
function ProductionFitPanel({
  edges,
  fitPanelMode,
  persistedFitState,
  fitPreview,
  busyKind,
  canApplyFit,
  runFitPreview,
  cancelFitPreview,
  applyFitToSafeArea,
}: {
  edges: PreviewEdge[];
  fitPanelMode: ReturnType<typeof resolveSignProductionFitPanelMode>;
  persistedFitState: SignProductionFitState;
  fitPreview: FitPreviewResponse | null;
  busyKind: "fit-preview" | "fit-apply" | null;
  canApplyFit: boolean;
  runFitPreview: () => void;
  cancelFitPreview: () => void;
  applyFitToSafeArea: () => void;
}) {
  const byEdge = new Map(edges.map((e) => [e.edge, e]));
  const copy = SIGN_PRODUCTION_FIT_PANEL_COPY[fitPanelMode];
  const fitBusy = busyKind === "fit-preview" || busyKind === "fit-apply";
  const isPreviewMode = fitPanelMode.startsWith("fit_preview_");

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3"
      data-sign-production-fit-panel
      data-sign-production-fit-mode={fitPanelMode}
    >
      <div>
        <h2 className="text-sm font-semibold text-ink" data-sign-production-fit-status>
          {copy.status}
        </h2>
        <p className="mt-1 text-sm text-ink">{copy.detail}</p>
        {fitPanelMode === "fit_preview_ready" && fitPreview?.scale !== null && fitPreview !== null ? (
          <p className="mt-1 text-sm font-medium text-ink" data-sign-fit-preview-scale>
            Artwork will be reduced to {(fitPreview.scale! * 100).toFixed(1)}%.
          </p>
        ) : null}
      </div>

      {fitPanelMode === "fit_adjustment_required" ? (
        <button
          type="button"
          onClick={runFitPreview}
          disabled={fitBusy}
          className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-fit-safe-area-preview"
        >
          {busyKind === "fit-preview" ? "Generating preview…" : "Fit artwork to safe area"}
        </button>
      ) : null}

      {isPreviewMode ? (
        <div className="flex flex-col gap-3 border-t border-ink/10 pt-3">
          {/* Section G: the preview is proposed artwork, never the already-
              persisted production candidate — this line keeps that
              distinction explicit and visible at all times while a preview
              is showing. */}
          <p className="text-xs font-medium text-amber-700" data-sign-fit-current-status>
            Current production candidate: {PERSISTED_STATE_LABEL[persistedFitState]}
          </p>

          {fitPanelMode === "fit_preview_ready" ? (
            <>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={applyFitToSafeArea}
                  disabled={!canApplyFit}
                  className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="sign-fit-safe-area-apply"
                >
                  {busyKind === "fit-apply" ? "Applying…" : "Apply fit to safe area"}
                </button>
                <button
                  type="button"
                  onClick={cancelFitPreview}
                  disabled={busyKind === "fit-apply"}
                  className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="sign-fit-safe-area-cancel"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-muted">
                Applying builds a new production plan from your original artwork and requires re-authorization
                before it can be prepared again — the same as any other production plan change. Preview bytes are
                never persisted or treated as Print Ready on their own.
              </p>
            </>
          ) : (
            <button
              type="button"
              onClick={cancelFitPreview}
              className="text-sm text-ink/60 underline"
              data-testid="sign-fit-safe-area-cancel"
            >
              Dismiss
            </button>
          )}
        </div>
      ) : null}

      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">Edge-by-edge detail</summary>
        <div className="mt-2 flex flex-col gap-2">
          {ALL_EDGES.map((edge) => {
            const e = byEdge.get(edge);
            if (!e) {
              return (
                <p key={edge} className="text-xs text-muted">
                  {edge.toUpperCase()}: no evidence yet.
                </p>
              );
            }
            const pass = e.protectedResult === "pass";
            return (
              <div key={edge} className="border-t border-ink/10 pt-2 first:border-t-0 first:pt-0">
                <p className={`text-sm font-medium ${pass ? "text-emerald-700" : "text-red-700"}`}>
                  {edge.toUpperCase()}: {e.protectedResult.toUpperCase()}
                  {e.edgeIntentPresent ? " (edge artwork present)" : ""}
                </p>
                <p className="text-xs text-muted">
                  Requires {e.requiredProtectedInsetIn}in ({e.requiredProtectedInsetPx}px) clear.{" "}
                  {e.nearestProtectedContentIn !== null
                    ? `Nearest protected content: ${e.nearestProtectedContentIn}in (${e.nearestProtectedContentPx}px).`
                    : "No protected content measured."}
                </p>
                <p className="text-xs text-muted">{e.reason}</p>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
