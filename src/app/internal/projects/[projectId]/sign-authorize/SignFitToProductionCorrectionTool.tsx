"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SignEdge, SignFitToProductionSummary } from "@/capabilities/sign-preparation";

import { mapDisplayPointToSourcePx, normalizeSelection } from "./correction-coordinate-mapping";
import { clampZoom, computeFitZoom } from "./sign-canvas-zoom";
import { computeDisplayPpi, deriveEdgeChips, deriveOverallFitLabel } from "./sign-workspace-status";

/**
 * Production Workspace Phase: this component IS the operator's production
 * workstation — one authoritative working canvas, a compact status bar
 * above it, a small tool rail beside it, and a contextual action panel that
 * shows only what applies to the current selection. It replaces the
 * earlier stacked-preview layout entirely; nothing here is a second
 * artwork-intelligence implementation, only a recomposition of the
 * capabilities the Operator Production Correction UX and Edge-Intent
 * Correction phases already built (Sections A/F/M).
 *
 * Fit to Production identifies a violation, the operator zooms in, selects
 * the exact offending artwork with a rectangle, and either previews a
 * deterministic correction (Smart Remove, the existing Move capability) or
 * GOVERNS a classification (Mark as Edge Artwork / Border, Mark as
 * Protected). Applies either as a governed action. Deliberately NOT
 * Photoshop (Section C/M): one rectangular selection tool, a small closed
 * set of actions, a before/after preview, nothing else.
 *
 * Coordinate discipline (unchanged): every selection is tracked and sent in
 * the production candidate's own NATIVE pixel space. The on-screen canvas
 * may be zoomed to any CSS size; every pointer event is converted via
 * `naturalWidth / canvas.getBoundingClientRect().width` at THAT moment,
 * never a cached scale — so a selection made at any zoom level maps to the
 * identical source pixels (`correction-coordinate-mapping.ts`, untouched
 * this phase). "Fit" zoom is likewise a pure, testable computation
 * (`sign-canvas-zoom.ts`) over the actual viewport container size, never a
 * value guessed for one particular sign.
 *
 * Preview/execution equivalence (unchanged): `/correction-preview` runs the
 * SAME `measureUniformSurroundingBackground`/`applyCorrectionsToCanvas`/
 * `analyzeSignFitToProduction` primitives real commit/execution use — this
 * component never computes pixel colours, applies a correction, or measures
 * safe-inset clearance itself; it only sends the operator's selection and
 * renders back what the server actually did.
 *
 * The 0.125in SAFE guide is drawn from the SERVER's own already-computed
 * `requiredProtectedInsetPx` per edge — it is a guide for where PROTECTED
 * content must stay, never a blanket "no artwork" zone: BLEED_BACKGROUND
 * and governed EDGE_INTENT_ARTWORK may legitimately sit inside it or reach
 * CUT (Section J).
 */

type Tool = "select" | "move" | "remove" | "edge_intent" | "protected";
type ClassificationKind = "edge_intent" | "protected";

interface Rect {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

type PendingCorrection =
  | { kind: "remove"; xPx: number; yPx: number; widthPx: number; heightPx: number; contextDepthPx: number }
  | { kind: "move"; sourceStartYPx: number; heightPx: number; destStartYPx: number }
  | { kind: "classify"; classificationKind: ClassificationKind; edges: SignEdge[]; xPx: number; yPx: number; widthPx: number; heightPx: number };

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

interface PreviewResponse {
  status: "no_candidate" | "refused" | "previewed";
  appliedCount: number;
  measuredColors: ({ r: number; g: number; b: number } | null)[];
  failingIndex: number | null;
  failingDetail: string | null;
  beforeCropPngBase64: string | null;
  afterCropPngBase64: string | null;
  cropBounds: Rect | null;
  fitToProduction: { edges: PreviewEdge[]; overallResult: "pass" | "fail" | "unknown" } | null;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const ZOOM_BOUNDS = { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };
const DEFAULT_CONTEXT_DEPTH_PX = 24;
const ALL_EDGES: readonly SignEdge[] = ["top", "right", "bottom", "left"];

const TOOL_LABEL: Record<Tool, string> = {
  select: "Select",
  move: "Move",
  remove: "Remove",
  edge_intent: "Edge Artwork / Border",
  protected: "Protected",
};

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
  const [selection, setSelection] = useState<Rect | null>(null);
  const draggingRef = useRef<{ startXPx: number; startYPx: number } | null>(null);

  const [tool, setTool] = useState<Tool>("select");
  const [contextDepthPx, setContextDepthPx] = useState(DEFAULT_CONTEXT_DEPTH_PX);
  const [moveDestStartYPx, setMoveDestStartYPx] = useState("");
  const [classificationEdges, setClassificationEdges] = useState<Set<SignEdge>>(new Set());

  const [queue, setQueue] = useState<PendingCorrection[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setZoom = useCallback((z: number) => setZoomState(clampZoom(z, ZOOM_BOUNDS)), []);

  const displayWidth = naturalSize ? Math.round(naturalSize.width * zoom) : 0;
  const displayHeight = naturalSize ? Math.round(naturalSize.height * zoom) : 0;

  // The single current source of truth for Fit to Production evidence: the
  // latest queued preview's recheck once one exists, otherwise the plan's
  // last authoritative evidence — the SAME precedence the status bar, the
  // canvas overlay, and the context panel all read, so they never disagree
  // with each other mid-correction.
  const currentEdges: PreviewEdge[] = preview?.fitToProduction?.edges ?? (fitToProduction.edges as PreviewEdge[]);
  const currentOverallStatus = preview?.fitToProduction ? preview.fitToProduction.overallResult : fitToProduction.status;

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
  // value this component's own coordinate math already trusts) over the
  // plan's source-artwork dimensions, which describe the pre-composition
  // input artwork and can carry a different aspect ratio entirely once a
  // composition plan has run.
  const displayArtworkWidthPx = naturalSize?.width ?? artworkWidthPx;
  const displayArtworkHeightPx = naturalSize?.height ?? artworkHeightPx;

  // Overlay: CUT boundary (implicit — the canvas edge itself), SAFE guide
  // per axis (from the SERVER's own already-computed
  // requiredProtectedInsetPx — never a client-side re-derivation), a
  // highlight band coloured by that edge's OWN protectedResult (never a
  // blanket "artwork present = violation" — pass is never highlighted), an
  // accent marker at the edge's own worst evidence position
  // (`violatingPositionPx` — an evidence position, never an object
  // detection), and the current selection.
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
    // guide is not a blanket no-artwork zone (Section J).
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
      // to be an object outline (Section K).
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

    // Current selection rectangle.
    if (selection) {
      ctx.save();
      ctx.strokeStyle = "rgba(37, 99, 235, 0.95)"; // blue
      ctx.lineWidth = 2;
      ctx.strokeRect(selection.xPx * zoom, selection.yPx * zoom, selection.widthPx * zoom, selection.heightPx * zoom);
      ctx.restore();
    }
  }, [naturalSize, zoom, selection, currentEdges]);

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

  function toSourcePx(clientX: number, clientY: number): { xPx: number; yPx: number } | null {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return null;
    return mapDisplayPointToSourcePx(clientX, clientY, canvas.getBoundingClientRect(), naturalSize);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toSourcePx(e.clientX, e.clientY);
    if (!p) return;
    draggingRef.current = { startXPx: p.xPx, startYPx: p.yPx };
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!draggingRef.current) return;
    const p = toSourcePx(e.clientX, e.clientY);
    if (!p) return;
    const { startXPx, startYPx } = draggingRef.current;
    setSelection(normalizeSelection({ xPx: startXPx, yPx: startYPx }, p));
  }

  function handlePointerUp() {
    draggingRef.current = null;
    setSelection((current) => (current && current.widthPx > 0 && current.heightPx > 0 ? current : null));
  }

  const selectionValid = selection !== null && selection.widthPx > 0 && selection.heightPx > 0;

  function zoomFit() {
    const vp = viewportRef.current;
    if (!vp || !naturalSize) return;
    setZoom(computeFitZoom(naturalSize, { width: vp.clientWidth, height: vp.clientHeight }, ZOOM_BOUNDS));
  }

  async function runPreview(nextQueue: PendingCorrection[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/correction-preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextQueue),
      });
      const body = (await res.json().catch(() => null)) as PreviewResponse | { error?: string } | null;
      if (!res.ok || !body || "error" in body) {
        setError((body as { error?: string } | null)?.error ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      setPreview(body as PreviewResponse);
      setQueue(nextQueue);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setBusy(false);
    }
  }

  function queueRemove() {
    if (!selection || !selectionValid) return;
    const correction: PendingCorrection = {
      kind: "remove",
      xPx: selection.xPx, yPx: selection.yPx, widthPx: selection.widthPx, heightPx: selection.heightPx,
      contextDepthPx,
    };
    void runPreview([...queue, correction]);
  }

  function queueMove() {
    if (!selection || !selectionValid) return;
    const destStartYPx = Number(moveDestStartYPx);
    if (!Number.isFinite(destStartYPx)) {
      setError("Enter a valid destination Y position for the move.");
      return;
    }
    const correction: PendingCorrection = {
      kind: "move",
      sourceStartYPx: selection.yPx, heightPx: selection.heightPx, destStartYPx,
    };
    void runPreview([...queue, correction]);
  }

  function queueClassify(classificationKind: ClassificationKind) {
    if (!selection || !selectionValid) return;
    if (classificationEdges.size === 0) {
      setError("Choose at least one edge this classification applies to.");
      return;
    }
    const correction: PendingCorrection = {
      kind: "classify",
      classificationKind,
      edges: Array.from(classificationEdges),
      xPx: selection.xPx, yPx: selection.yPx, widthPx: selection.widthPx, heightPx: selection.heightPx,
    };
    void runPreview([...queue, correction]);
  }

  function toggleClassificationEdge(edge: SignEdge) {
    setClassificationEdges((prev) => {
      const next = new Set(prev);
      if (next.has(edge)) next.delete(edge);
      else next.add(edge);
      return next;
    });
  }

  function undoLast() {
    const next = queue.slice(0, -1);
    if (next.length === 0) {
      setQueue([]);
      setPreview(null);
      return;
    }
    void runPreview(next);
  }

  function clearAll() {
    setQueue([]);
    setPreview(null);
    setSelection(null);
    setError(null);
  }

  function cancelSelection() {
    setSelection(null);
    setTool("select");
    setError(null);
  }

  async function applyToProduction() {
    if (queue.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/correction-commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(queue),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" data-sign-correction-tool>
      {/* Compact production status bar (Section L): the operator should
          understand production state in seconds, without reading a
          paragraph elsewhere on the page. */}
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

      {/* Tool rail | canvas | context panel */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[152px_minmax(0,1fr)_300px]">
        <div
          className="flex flex-row gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible"
          role="toolbar"
          aria-label="Correction tools"
          data-sign-tool-rail
        >
          {(["select", "move", "remove", "edge_intent", "protected"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTool(t)}
              aria-pressed={tool === t}
              className={`shrink-0 rounded-md border px-2.5 py-1.5 text-left text-sm font-medium transition ${
                tool === t ? "border-ink bg-ink text-white" : "border-ink/15 text-ink hover:border-ink/40"
              }`}
              data-testid={`sign-tool-${t}`}
            >
              {TOOL_LABEL[t]}
            </button>
          ))}
          <button
            type="button"
            onClick={cancelSelection}
            className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1.5 text-left text-sm font-medium text-ink transition hover:border-ink/40"
            data-testid="sign-tool-review"
          >
            Review
          </button>
        </div>

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

          <div
            ref={viewportRef}
            className="relative h-[72vh] min-h-[420px] overflow-auto rounded border border-ink/10 bg-ink/5"
          >
            <div style={{ position: "relative", width: displayWidth || undefined, height: displayHeight || undefined }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool, not the customer image pipeline */}
              <img
                ref={imgRef}
                src={candidateUrl}
                alt="Current production candidate — select artwork to correct"
                style={{ width: displayWidth || undefined, height: displayHeight || undefined, display: "block" }}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  const natural = { width: el.naturalWidth, height: el.naturalHeight };
                  setNaturalSize(natural);
                  const vp = viewportRef.current;
                  if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
                    setZoom(computeFitZoom(natural, { width: vp.clientWidth, height: vp.clientHeight }, ZOOM_BOUNDS));
                  }
                }}
              />
              <canvas
                ref={canvasRef}
                style={{ position: "absolute", left: 0, top: 0, touchAction: "none", cursor: "crosshair" }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                data-testid="sign-correction-canvas"
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            <span className="font-medium text-emerald-700">Dashed guide</span> — where PROTECTED content must stay
            clear of CUT. Not a no-artwork zone: BLEED backgrounds and governed EDGE ARTWORK may cross it or reach
            CUT. Colored bands mark edges that still need attention; the bright tick marks the worst-measured point
            on that edge, not a detected object.
          </p>
        </div>

        <div className="flex flex-col gap-3" data-sign-context-panel>
          {selectionValid && selection ? (
            <ActionPanel
              tool={tool}
              selection={selection}
              contextDepthPx={contextDepthPx}
              setContextDepthPx={setContextDepthPx}
              moveDestStartYPx={moveDestStartYPx}
              setMoveDestStartYPx={setMoveDestStartYPx}
              classificationEdges={classificationEdges}
              toggleClassificationEdge={toggleClassificationEdge}
              busy={busy}
              queueRemove={queueRemove}
              queueMove={queueMove}
              queueClassify={queueClassify}
              cancelSelection={cancelSelection}
              setSelection={setSelection}
            />
          ) : (
            <FitGuidancePanel edges={currentEdges} />
          )}

          {error ? (
            <p className="text-sm text-red-600" role="alert" data-sign-correction-error>
              {error}
            </p>
          ) : null}

          {preview ? (
            <PreviewPanel
              preview={preview}
              undoLast={undoLast}
              clearAll={clearAll}
              applyToProduction={applyToProduction}
              busy={busy}
              queueLength={queue.length}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The right-rail contextual action panel (Section O): shows ONLY the
 * controls relevant to the currently selected tool, for the artwork the
 * operator already selected on the canvas. Numeric X/Y/W/H remain available
 * as a secondary, collapsed precision fallback — never the primary way to
 * make a selection.
 */
function ActionPanel({
  tool,
  selection,
  contextDepthPx,
  setContextDepthPx,
  moveDestStartYPx,
  setMoveDestStartYPx,
  classificationEdges,
  toggleClassificationEdge,
  busy,
  queueRemove,
  queueMove,
  queueClassify,
  cancelSelection,
  setSelection,
}: {
  tool: Tool;
  selection: Rect;
  contextDepthPx: number;
  setContextDepthPx: (n: number) => void;
  moveDestStartYPx: string;
  setMoveDestStartYPx: (s: string) => void;
  classificationEdges: Set<SignEdge>;
  toggleClassificationEdge: (edge: SignEdge) => void;
  busy: boolean;
  queueRemove: () => void;
  queueMove: () => void;
  queueClassify: (kind: ClassificationKind) => void;
  cancelSelection: () => void;
  setSelection: (updater: (s: Rect | null) => Rect | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3" data-sign-action-panel>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Selection</h2>
        <button type="button" onClick={cancelSelection} className="text-xs text-ink/60 underline" data-testid="sign-correction-cancel-selection">
          Cancel selection
        </button>
      </div>

      {tool === "select" ? (
        <p className="text-sm text-muted">
          Choose a production action for this selection: Move, Remove, Edge Artwork / Border, or Protected.
        </p>
      ) : tool === "remove" ? (
        <>
          <p className="text-sm text-muted">
            Removes this selection and fills it from the surrounding background — the same background colour the
            server measures, never guessed.
          </p>
          <label className="flex items-center gap-2 text-sm text-ink">
            Context depth (px)
            <input
              className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
              value={contextDepthPx}
              onChange={(e) => setContextDepthPx(Number(e.target.value) || DEFAULT_CONTEXT_DEPTH_PX)}
              data-testid="sign-correction-context-depth"
            />
          </label>
          <button
            type="button"
            onClick={queueRemove}
            disabled={busy}
            className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-correction-remove"
          >
            Remove artifact
          </button>
        </>
      ) : tool === "move" ? (
        <>
          <p className="text-xs text-muted">source y {selection.yPx}, height {selection.heightPx}</p>
          <label className="flex items-center gap-2 text-sm text-ink">
            Destination y
            <input
              className="w-24 rounded border border-ink/20 px-1.5 py-0.5"
              value={moveDestStartYPx}
              onChange={(e) => setMoveDestStartYPx(e.target.value)}
              data-testid="sign-correction-move-dest-y"
            />
          </label>
          <button
            type="button"
            onClick={queueMove}
            disabled={busy}
            className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-correction-move"
          >
            Preview move
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            {tool === "edge_intent"
              ? "Marks this selection as intentional border/frame artwork on the checked edges — Fit to Production keeps scanning past it for genuinely protected or ambiguous content. Never inferred automatically."
              : "Marks this selection as protected content that must clear the safe margin on the checked edges."}
          </p>
          <div className="flex flex-wrap gap-2 text-sm" data-testid="sign-correction-classify-edges">
            {ALL_EDGES.map((edge) => (
              <label key={edge} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={classificationEdges.has(edge)}
                  onChange={() => toggleClassificationEdge(edge)}
                  data-testid={`sign-correction-classify-edge-${edge}`}
                />
                {edge}
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => queueClassify(tool)}
            disabled={busy || classificationEdges.size === 0}
            className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-correction-classify"
          >
            {tool === "edge_intent" ? "Mark as Edge Artwork / Border" : "Mark as Protected"}
          </button>
        </>
      )}

      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">Precise coordinates</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            x
            <input
              className="w-16 rounded border border-ink/20 px-1.5 py-0.5"
              value={selection.xPx}
              onChange={(e) => setSelection((s) => ({ xPx: Number(e.target.value) || 0, yPx: s?.yPx ?? 0, widthPx: s?.widthPx ?? 0, heightPx: s?.heightPx ?? 0 }))}
              data-testid="sign-correction-selection-x"
            />
          </label>
          <label className="flex items-center gap-1">
            y
            <input
              className="w-16 rounded border border-ink/20 px-1.5 py-0.5"
              value={selection.yPx}
              onChange={(e) => setSelection((s) => ({ xPx: s?.xPx ?? 0, yPx: Number(e.target.value) || 0, widthPx: s?.widthPx ?? 0, heightPx: s?.heightPx ?? 0 }))}
              data-testid="sign-correction-selection-y"
            />
          </label>
          <label className="flex items-center gap-1">
            w
            <input
              className="w-16 rounded border border-ink/20 px-1.5 py-0.5"
              value={selection.widthPx}
              onChange={(e) => setSelection((s) => ({ xPx: s?.xPx ?? 0, yPx: s?.yPx ?? 0, widthPx: Number(e.target.value) || 0, heightPx: s?.heightPx ?? 0 }))}
              data-testid="sign-correction-selection-w"
            />
          </label>
          <label className="flex items-center gap-1">
            h
            <input
              className="w-16 rounded border border-ink/20 px-1.5 py-0.5"
              value={selection.heightPx}
              onChange={(e) => setSelection((s) => ({ xPx: s?.xPx ?? 0, yPx: s?.yPx ?? 0, widthPx: s?.widthPx ?? 0, heightPx: Number(e.target.value) || 0 }))}
              data-testid="sign-correction-selection-h"
            />
          </label>
        </div>
      </details>
    </div>
  );
}

/**
 * The right-rail default state (Section K/L): concise Fit guidance per
 * edge, shown whenever nothing is selected. Replaces the old page-level
 * `FitToProductionSummary` block — the evidence now lives directly beside
 * the artwork it describes instead of being separated from it.
 */
function FitGuidancePanel({ edges }: { edges: PreviewEdge[] }) {
  const byEdge = new Map(edges.map((e) => [e.edge, e]));
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink/15 p-3" data-sign-fit-guidance>
      <h2 className="text-sm font-semibold text-ink">Fit to Production</h2>
      <p className="text-xs text-muted">
        Drag a rectangle on the canvas, then pick a tool from the rail to act on it.
      </p>
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
  );
}

function PreviewPanel({
  preview,
  undoLast,
  clearAll,
  applyToProduction,
  busy,
  queueLength,
}: {
  preview: PreviewResponse;
  undoLast: () => void;
  clearAll: () => void;
  applyToProduction: () => void;
  busy: boolean;
  queueLength: number;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3">
      <p className="text-sm text-ink" data-sign-correction-preview-status>
        {preview.status === "refused"
          ? `Correction ${preview.failingIndex! + 1} was refused: ${preview.failingDetail}`
          : `Preview reflects ${preview.appliedCount} queued correction(s).`}
      </p>

      {preview.beforeCropPngBase64 && preview.afterCropPngBase64 ? (
        <div className="flex flex-wrap gap-3">
          <div>
            <p className="text-xs font-medium text-ink/60">Before</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool preview crop */}
            <img
              src={`data:image/png;base64,${preview.beforeCropPngBase64}`}
              alt="Before correction"
              className="max-w-[140px] rounded border border-ink/10"
              data-testid="sign-correction-before"
            />
          </div>
          <div>
            <p className="text-xs font-medium text-ink/60">After</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool preview crop */}
            <img
              src={`data:image/png;base64,${preview.afterCropPngBase64}`}
              alt="After correction"
              className="max-w-[140px] rounded border border-ink/10"
              data-testid="sign-correction-after"
            />
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="button" onClick={undoLast} className="text-sm text-ink/60 underline" data-testid="sign-correction-undo">
          Undo last
        </button>
        <button type="button" onClick={clearAll} className="text-sm text-ink/60 underline" data-testid="sign-correction-cancel">
          Cancel all
        </button>
      </div>
      <button
        type="button"
        onClick={applyToProduction}
        disabled={busy || queueLength === 0}
        className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="sign-correction-apply"
      >
        {busy ? "Applying…" : "Apply to production plan"}
      </button>
      <p className="text-xs text-muted">
        Applying a Remove/Move builds a new production plan and requires re-authorization before it can be prepared
        again. Applying a Classification records a governed decision bound to this exact candidate — it never
        authorizes anything on its own, and a Remove/Move in the SAME batch will make it stale for the plan that
        produces.
      </p>
    </div>
  );
}
