"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SignFitToProductionSummary } from "@/capabilities/sign-preparation";

import { mapDisplayPointToSourcePx, normalizeSelection } from "./correction-coordinate-mapping";

/**
 * Operator Production Correction UX: the interactive canvas correction tool
 * — Fit to Production identifies a violation, the operator zooms in, selects
 * the exact offending artwork with a rectangle, previews a deterministic
 * correction (Smart Remove, or the existing Move capability), and applies it
 * as a governed plan operation. Deliberately NOT Photoshop (Section D): one
 * rectangular selection tool, two operations (remove/move), a before/after
 * preview, nothing else — no brushes, no freehand masks, no polygons, no
 * generative fill.
 *
 * Coordinate discipline (Section G/L): every selection is tracked and sent
 * in the production candidate's own NATIVE pixel space. The on-screen
 * canvas may be zoomed to any CSS size; every pointer event is converted via
 * `naturalWidth / canvas.getBoundingClientRect().width` at THAT moment,
 * never a cached scale — so a selection made at any zoom level maps to the
 * identical source pixels.
 *
 * Preview/execution equivalence (Section L): `/correction-preview` runs the
 * SAME `measureUniformSurroundingBackground`/`applyCorrectionsToCanvas`
 * primitives real commit/execution uses — this component never computes
 * pixel colours or applies a correction itself, it only sends the operator's
 * selection and renders back what the server actually did.
 */

type Mode = "remove" | "move";

interface Rect {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

type PendingCorrection =
  | { kind: "remove"; xPx: number; yPx: number; widthPx: number; heightPx: number; contextDepthPx: number }
  | { kind: "move"; sourceStartYPx: number; heightPx: number; destStartYPx: number };

interface PreviewEdge {
  edge: "top" | "right" | "bottom" | "left";
  requiredSafeInsetPx: number;
  requiredSafeInsetIn: number;
  nearestNonBleedPx: number | null;
  nearestNonBleedIn: number | null;
  result: "pass" | "fail" | "unknown";
  reason: string;
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
const DEFAULT_CONTEXT_DEPTH_PX = 24;

export function SignFitToProductionCorrectionTool({
  projectId,
  fitToProduction,
}: {
  projectId: string;
  fitToProduction: SignFitToProductionSummary;
}) {
  const router = useRouter();
  const candidateUrl = `/api/internal/projects/${projectId}/sign-artwork/production-candidate`;

  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<Rect | null>(null);
  const draggingRef = useRef<{ startXPx: number; startYPx: number } | null>(null);

  const [mode, setMode] = useState<Mode>("remove");
  const [contextDepthPx, setContextDepthPx] = useState(DEFAULT_CONTEXT_DEPTH_PX);
  const [moveDestStartYPx, setMoveDestStartYPx] = useState("");

  const [queue, setQueue] = useState<PendingCorrection[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayWidth = naturalSize ? Math.round(naturalSize.width * zoom) : 0;
  const displayHeight = naturalSize ? Math.round(naturalSize.height * zoom) : 0;

  // Overlay: CUT boundary (implicit — the canvas edge itself), SAFE guide
  // per axis (from the SERVER's own already-computed requiredSafeInsetPx —
  // never a client-side re-derivation of the 0.125in conversion), a
  // highlight band for each failing/unknown edge, and the current selection.
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const edgeByName = new Map(fitToProduction.edges.map((e) => [e.edge, e]));
    const top = edgeByName.get("top");
    const right = edgeByName.get("right");
    const bottom = edgeByName.get("bottom");
    const left = edgeByName.get("left");

    // SAFE guide — a thin dashed line inset from each edge by that edge's
    // own requiredSafeInsetPx, scaled to the current display size.
    ctx.save();
    ctx.strokeStyle = "rgba(16, 185, 129, 0.9)"; // emerald
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    if (top) {
      const y = top.requiredSafeInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    if (bottom) {
      const y = canvas.height - bottom.requiredSafeInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    if (left) {
      const x = left.requiredSafeInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    if (right) {
      const x = canvas.width - right.requiredSafeInsetPx * zoom;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    ctx.restore();

    // Violation highlight bands — the full unsafe-depth band along each
    // failing/unknown edge (never a claim of exact object identity — see
    // Section F: "actionable production evidence", not segmentation).
    ctx.save();
    ctx.setLineDash([]);
    for (const [edge, e] of [["top", top], ["right", right], ["bottom", bottom], ["left", left]] as const) {
      if (!e || e.result === "pass") continue;
      ctx.fillStyle = e.result === "unknown" ? "rgba(234, 179, 8, 0.18)" : "rgba(239, 68, 68, 0.18)";
      const depth = e.requiredSafeInsetPx * zoom;
      if (edge === "top") ctx.fillRect(0, 0, canvas.width, depth);
      else if (edge === "bottom") ctx.fillRect(0, canvas.height - depth, canvas.width, depth);
      else if (edge === "left") ctx.fillRect(0, 0, depth, canvas.height);
      else ctx.fillRect(canvas.width - depth, 0, depth, canvas.height);
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
  }, [naturalSize, zoom, selection, fitToProduction]);

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

  const edgeStatusLine = useMemo(() => {
    const source = preview?.fitToProduction?.edges ?? fitToProduction.edges;
    if (source.length === 0) return null;
    return (["top", "right", "bottom", "left"] as const).map((edge) => {
      const e = source.find((x) => x.edge === edge);
      const label = e ? e.result.toUpperCase() : "—";
      return { edge, label, pass: e?.result === "pass" };
    });
  }, [preview, fitToProduction]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3" data-sign-correction-tool>
      <div>
        <h2 className="text-sm font-semibold text-ink">Fix production violations</h2>
        <p className="text-xs text-muted">
          Zoom in, drag a rectangle around the exact unwanted artwork, then Remove or Move it. Nothing here changes
          production artwork until you click &quot;Apply to production plan&quot; below — corrections preview
          instantly, with zero Topaz calls.
        </p>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium text-ink/60">Zoom</span>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          data-testid="sign-correction-zoom"
        />
        <span className="text-xs text-muted">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="max-h-[70vh] overflow-auto rounded border border-ink/10 bg-ink/5">
        <div style={{ position: "relative", width: displayWidth || undefined, height: displayHeight || undefined }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool, not the customer image pipeline */}
          <img
            ref={imgRef}
            src={candidateUrl}
            alt="Current production candidate — select artwork to correct"
            style={{ width: displayWidth || undefined, height: displayHeight || undefined, display: "block" }}
            onLoad={(e) => {
              const el = e.currentTarget;
              setNaturalSize({ width: el.naturalWidth, height: el.naturalHeight });
              // Fit an initial zoom so the full candidate is visible in a
              // reasonable viewport on first load — a starting point only;
              // the operator controls zoom from here via the slider.
              const target = Math.min(1, 900 / el.naturalWidth);
              if (target > 0 && target < 1) setZoom(Math.max(MIN_ZOOM, target));
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

      <div className="flex flex-wrap items-center gap-3 rounded border border-ink/10 p-2 text-sm">
        <span className="font-medium text-ink/60">Selection (candidate pixels)</span>
        <label className="flex items-center gap-1">
          x
          <input
            className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
            value={selection?.xPx ?? ""}
            onChange={(e) => setSelection((s) => ({ xPx: Number(e.target.value) || 0, yPx: s?.yPx ?? 0, widthPx: s?.widthPx ?? 0, heightPx: s?.heightPx ?? 0 }))}
            data-testid="sign-correction-selection-x"
          />
        </label>
        <label className="flex items-center gap-1">
          y
          <input
            className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
            value={selection?.yPx ?? ""}
            onChange={(e) => setSelection((s) => ({ xPx: s?.xPx ?? 0, yPx: Number(e.target.value) || 0, widthPx: s?.widthPx ?? 0, heightPx: s?.heightPx ?? 0 }))}
            data-testid="sign-correction-selection-y"
          />
        </label>
        <label className="flex items-center gap-1">
          w
          <input
            className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
            value={selection?.widthPx ?? ""}
            onChange={(e) => setSelection((s) => ({ xPx: s?.xPx ?? 0, yPx: s?.yPx ?? 0, widthPx: Number(e.target.value) || 0, heightPx: s?.heightPx ?? 0 }))}
            data-testid="sign-correction-selection-w"
          />
        </label>
        <label className="flex items-center gap-1">
          h
          <input
            className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
            value={selection?.heightPx ?? ""}
            onChange={(e) => setSelection((s) => ({ xPx: s?.xPx ?? 0, yPx: s?.yPx ?? 0, widthPx: s?.widthPx ?? 0, heightPx: Number(e.target.value) || 0 }))}
            data-testid="sign-correction-selection-h"
          />
        </label>
        <button type="button" onClick={() => setSelection(null)} className="text-xs text-ink/60 underline">
          clear selection
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded border border-ink/10 p-2 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "remove"} onChange={() => setMode("remove")} /> Remove Artifact
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "move"} onChange={() => setMode("move")} /> Move (existing capability)
        </label>

        {mode === "remove" ? (
          <>
            <label className="flex items-center gap-1">
              context depth px
              <input
                className="w-16 rounded border border-ink/20 px-1.5 py-0.5"
                value={contextDepthPx}
                onChange={(e) => setContextDepthPx(Number(e.target.value) || DEFAULT_CONTEXT_DEPTH_PX)}
                data-testid="sign-correction-context-depth"
              />
            </label>
            <button
              type="button"
              onClick={queueRemove}
              disabled={!selectionValid || busy}
              className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="sign-correction-remove"
            >
              Remove Artifact
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted">source y {selection?.yPx ?? "—"}, height {selection?.heightPx ?? "—"}</span>
            <label className="flex items-center gap-1">
              destination y
              <input
                className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
                value={moveDestStartYPx}
                onChange={(e) => setMoveDestStartYPx(e.target.value)}
                data-testid="sign-correction-move-dest-y"
              />
            </label>
            <button
              type="button"
              onClick={queueMove}
              disabled={!selectionValid || busy}
              className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="sign-correction-move"
            >
              Preview move
            </button>
          </>
        )}
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-correction-error>
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-3 rounded border border-ink/10 p-3">
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
                  className="max-w-xs rounded border border-ink/10"
                  data-testid="sign-correction-before"
                />
              </div>
              <div>
                <p className="text-xs font-medium text-ink/60">After</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool preview crop */}
                <img
                  src={`data:image/png;base64,${preview.afterCropPngBase64}`}
                  alt="After correction"
                  className="max-w-xs rounded border border-ink/10"
                  data-testid="sign-correction-after"
                />
              </div>
            </div>
          ) : null}

          {edgeStatusLine ? (
            <div className="flex flex-wrap gap-3 text-sm" data-sign-correction-fit-recheck>
              {edgeStatusLine.map(({ edge, label, pass }) => (
                <span key={edge} className={pass ? "text-emerald-700" : "text-red-700"}>
                  {edge.toUpperCase()}: {label}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button type="button" onClick={undoLast} className="text-sm text-ink/60 underline" data-testid="sign-correction-undo">
              Undo last
            </button>
            <button type="button" onClick={clearAll} className="text-sm text-ink/60 underline" data-testid="sign-correction-cancel">
              Cancel all
            </button>
            <button
              type="button"
              onClick={applyToProduction}
              disabled={busy || queue.length === 0}
              className="ml-auto rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="sign-correction-apply"
            >
              {busy ? "Applying…" : "Apply to production plan"}
            </button>
          </div>
          <p className="text-xs text-muted">
            Applying builds a new production plan from these corrections and requires re-authorization before it can
            be prepared again — the previous authorization no longer applies.
          </p>
        </div>
      ) : null}
    </section>
  );
}
