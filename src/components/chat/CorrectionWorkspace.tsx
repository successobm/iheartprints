"use client";

/**
 * Phase 27E — GRADUATED from the Phase 27C/27D experimental Magic Wand lab
 * (`src/experimental/magic-wand/page.tsx`). This component's INTERACTION
 * LOGIC is frozen and copied over unchanged per the Phase 27E mandate —
 * click/Shift+click/Alt+click, the Less/Default/More tolerance ladder,
 * Delete/Backspace, wheel-zoom-on-cursor, Spacebar-drag pan, and the
 * coordinate-conversion math are byte-for-byte the same as the approved
 * Phase 27D lab page. Only the endpoint URLs (now project-scoped) and the
 * addition of a "Done Editing" completion action are new.
 *
 * Do NOT modify the interaction logic here without a demonstrated
 * integration bug — see the Phase 27E report's frozen-surface list.
 *
 * Operator-facing copy has no algorithm terminology, matching Phase 27D.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

type Point = { x: number; y: number };
type Mode = "restore" | "remove";
type ToleranceLevel = "less" | "default" | "more";

interface SelectionInfo {
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  touchesEdge: boolean;
  broad: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD_PX = 4;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export interface CorrectionWorkspaceProps {
  projectId: string;
  /** Called when the operator clicks "Done Editing" — moves to Final Review. Does not persist anything. */
  onDoneEditing: () => void;
  /** Called when the operator wants to leave the workspace entirely without finalizing (e.g. a "Cancel"/back link the host page provides). */
  onCancel?: () => void;
}

export default function CorrectionWorkspace({ projectId, onDoneEditing, onCancel }: CorrectionWorkspaceProps) {
  const base = `/api/projects/${projectId}/artwork-preparation/correction`;
  const RESULT_URL = `${base}/result`;
  const ORIGINAL_URL = `${base}/original`;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [resultImg, setResultImg] = useState<HTMLImageElement | null>(null);
  const [resultNonce, setResultNonce] = useState(0);
  const [correctionCount, setCorrectionCount] = useState(0);

  const [mode, setMode] = useState<Mode>("restore");
  const [tolerance, setTolerance] = useState<ToleranceLevel>("default");
  const [pendingClicks, setPendingClicks] = useState<Point[]>([]);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [overlayImg, setOverlayImg] = useState<HTMLImageElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panModeToggle, setPanModeToggle] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const pendingClicksRef = useRef(pendingClicks);
  const selectionRef = useRef(selection);
  const modeRef = useRef(mode);
  const toleranceRef = useRef(tolerance);
  const busyRef = useRef(busy);
  const spaceHeldRef = useRef(false);
  const panModeToggleRef = useRef(panModeToggle);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number; moved: boolean; isPan: boolean } | null>(null);

  zoomRef.current = zoom;
  panRef.current = pan;
  pendingClicksRef.current = pendingClicks;
  selectionRef.current = selection;
  modeRef.current = mode;
  toleranceRef.current = tolerance;
  busyRef.current = busy;
  panModeToggleRef.current = panModeToggle;

  const canvasSize = { width: 1100, height: 760 };

  useEffect(() => {
    loadImage(`${RESULT_URL}?v=${resultNonce}`).then(setResultImg).catch(() => setMessage("Could not load the artwork. Please try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultNonce]);

  // Phase 27E: seed the "Corrections applied" counter from server truth on
  // mount -- this component can remount (e.g. "Back to Editing" returning
  // from Final Review) while the underlying session's operations survive
  // untouched; a client-only counter starting at 0 would misreport that as
  // "no corrections", even though nothing was actually lost.
  const hasFetchedStatusRef = useRef(false);
  useEffect(() => {
    if (hasFetchedStatusRef.current) return;
    hasFetchedStatusRef.current = true;
    fetch(`${base}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { operationCount?: number } | null) => {
        if (data && typeof data.operationCount === "number") setCorrectionCount(data.operationCount);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fitScale(img: { width: number; height: number }): number {
    return Math.min(canvasSize.width / img.width, canvasSize.height / img.height);
  }

  function zoomToFit(img?: HTMLImageElement | null) {
    const target = img ?? resultImg;
    if (!target) return;
    const scale = fitScale(target);
    const newPan = { x: (canvasSize.width - target.width * scale) / 2, y: (canvasSize.height - target.height * scale) / 2 };
    zoomRef.current = scale;
    panRef.current = newPan;
    setZoom(scale);
    setPan(newPan);
  }

  const hasCenteredRef = useRef(false);
  useEffect(() => {
    if (!resultImg || hasCenteredRef.current) return;
    hasCenteredRef.current = true;
    zoomToFit(resultImg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultImg]);

  function clientToCanvasInternal(clientX: number, clientY: number): Point {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }
  function canvasToImage(p: Point): Point {
    return { x: Math.round((p.x - panRef.current.x) / zoomRef.current), y: Math.round((p.y - panRef.current.y) / zoomRef.current) };
  }
  function imageToCanvas(p: Point): Point {
    return { x: p.x * zoomRef.current + panRef.current.x, y: p.y * zoomRef.current + panRef.current.y };
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const displayImg = overlayImg ?? resultImg;
    if (!canvas || !displayImg) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
    const cell = 12;
    for (let y = 0; y < canvasSize.height; y += cell) {
      for (let x = 0; x < canvasSize.width; x += cell) {
        ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? "#e5e5e5" : "#f5f5f5";
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.drawImage(displayImg, pan.x, pan.y, displayImg.width * zoom, displayImg.height * zoom);

    for (const p of pendingClicks) {
      const c = imageToCanvas(p);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#2563eb";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultImg, overlayImg, pendingClicks, pan, zoom]);

  useEffect(() => { draw(); }, [draw]);

  async function runSelection(clicks: Point[], m: Mode, t: ToleranceLevel, removeAt?: Point) {
    setBusy(true);
    setMessage(null);
    const t0 = performance.now();
    const res = await fetch(`${base}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clicks, mode: m, toleranceLevel: t, removeAt }),
    });
    setLatencyMs(Math.round(performance.now() - t0));
    setBusy(false);
    if (!res.ok) {
      setMessage("Could not find a selection there. Try clicking somewhere else.");
      return;
    }
    const body = (await res.json()) as SelectionInfo & { overlayDataUrl: string | null; effectiveClicks: Point[] };
    setPendingClicks(body.effectiveClicks);
    if (body.pixelCount === 0) {
      setSelection(null);
      setOverlayImg(null);
      return;
    }
    setSelection({ pixelCount: body.pixelCount, bounds: body.bounds, touchesEdge: body.touchesEdge, broad: body.broad });
    if (body.overlayDataUrl) {
      const img = await loadImage(body.overlayDataUrl);
      setOverlayImg(img);
    }
    if (body.broad) setMessage("This selection covers a large area — take a look before continuing.");
  }

  function handleClickAt(imgPt: Point, shiftKey: boolean, altKey: boolean) {
    if (busyRef.current) return;
    if (altKey) {
      if (pendingClicksRef.current.length === 0) return;
      void runSelection(pendingClicksRef.current, modeRef.current, toleranceRef.current, imgPt);
      return;
    }
    if (shiftKey && pendingClicksRef.current.length > 0) {
      const next = [...pendingClicksRef.current, imgPt];
      setPendingClicks(next);
      void runSelection(next, modeRef.current, toleranceRef.current);
      return;
    }
    const next = [imgPt];
    setPendingClicks(next);
    void runSelection(next, modeRef.current, toleranceRef.current);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (busyRef.current) return;
    const isPan = spaceHeldRef.current || panModeToggleRef.current || e.button === 1;
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: panRef.current.x, panY: panRef.current.y, moved: false, isPan };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) d.moved = true;
    if (d.isPan) {
      const newPan = { x: d.panX + dx, y: d.panY + dy };
      panRef.current = newPan;
      setPan(newPan);
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.isPan || d.moved) return;
    const canvasPt = clientToCanvasInternal(e.clientX, e.clientY);
    const imgPt = canvasToImage(canvasPt);
    const img = resultImg;
    if (!img || imgPt.x < 0 || imgPt.x >= img.width || imgPt.y < 0 || imgPt.y >= img.height) return;
    handleClickAt(imgPt, e.shiftKey, e.altKey);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const canvasPt = clientToCanvasInternal(e.clientX, e.clientY);
      const imgPtUnderCursor = canvasToImage(canvasPt);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM);
      const newPan = { x: canvasPt.x - imgPtUnderCursor.x * newZoom, y: canvasPt.y - imgPtUnderCursor.y * newZoom };
      zoomRef.current = newZoom;
      panRef.current = newPan;
      setZoom(newZoom);
      setPan(newPan);
    }
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef.current]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTextEntryTarget(e.target)) return;
      if (e.code === "Space") {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectionRef.current && pendingClicksRef.current.length > 0 && !busyRef.current) {
          e.preventDefault();
          void applyAction();
        }
        return;
      }
      if (e.key === "0") { zoomToFit(); return; }
      if (e.key === "1") { setZoomKeepingCenter(1); return; }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") { spaceHeldRef.current = false; setSpaceHeld(false); }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setZoomKeepingCenter(newZoomValue: number) {
    const centerCanvas = { x: canvasSize.width / 2, y: canvasSize.height / 2 };
    const imgPtAtCenter = canvasToImage(centerCanvas);
    const newZoom = clamp(newZoomValue, MIN_ZOOM, MAX_ZOOM);
    const newPan = { x: centerCanvas.x - imgPtAtCenter.x * newZoom, y: centerCanvas.y - imgPtAtCenter.y * newZoom };
    zoomRef.current = newZoom;
    panRef.current = newPan;
    setZoom(newZoom);
    setPan(newPan);
  }

  function changeTolerance(t: ToleranceLevel) {
    setTolerance(t);
    if (pendingClicks.length > 0) void runSelection(pendingClicks, mode, t);
  }

  function changeMode(m: Mode) {
    setMode(m);
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
  }

  function clearSelection() {
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
    setMessage(null);
  }

  async function applyAction() {
    if (pendingClicksRef.current.length === 0) return;
    setBusy(true);
    const t0 = performance.now();
    const res = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clicks: pendingClicksRef.current, mode: modeRef.current, toleranceLevel: toleranceRef.current }),
    });
    setLatencyMs(Math.round(performance.now() - t0));
    setBusy(false);
    if (!res.ok) { setMessage("Could not apply that. Try again."); return; }
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
    setCorrectionCount((n) => n + 1);
    setResultNonce((n) => n + 1);
    // Deliberately NOT touching zoom/pan (Phase 27D §E): keep working the
    // same zoomed-in spot after a correction.
  }

  async function undoLastCorrection() {
    setBusy(true);
    await fetch(`${base}/undo`, { method: "POST" });
    setBusy(false);
    setCorrectionCount((n) => Math.max(0, n - 1));
    setResultNonce((n) => n + 1);
  }

  async function startOver() {
    setBusy(true);
    await fetch(`${base}/reset`, { method: "POST" });
    setBusy(false);
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
    setCorrectionCount(0);
    setResultNonce((n) => n + 1);
  }

  const instruction = mode === "restore" ? "Click the missing area." : "Click the area you want to remove.";
  const actionLabel = mode === "restore" ? "Restore Artwork" : "Remove Background";
  const zoomPct = Math.round(zoom * 100);

  return (
    <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-correction-workspace>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{mode === "restore" ? "Restore Missing Artwork" : "Clean Up Background"}</h2>
          <p className="mt-1 text-sm text-muted">
            {instruction} Shift+click to add another area. Alt+click a highlighted area to remove it from the selection. Press Delete to apply.
          </p>
        </div>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="shrink-0 text-xs text-muted underline-offset-2 hover:text-ink hover:underline" data-action="cancel-workspace">
            Cancel
          </button>
        ) : null}
      </div>

      <div role="group" aria-label="Mode" className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => changeMode("restore")} style={btnStyle(mode === "restore")} data-mode="restore">Restore Missing Artwork</button>
        <button onClick={() => changeMode("remove")} style={btnStyle(mode === "remove")} data-mode="remove">Remove Background</button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Zoom" style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button onClick={() => zoomToFit()} style={btnStyle(false)} data-action="zoom-fit">Fit</button>
          <button onClick={() => setZoomKeepingCenter(1)} style={btnStyle(false)} data-action="zoom-100">100%</button>
          <button onClick={() => setZoomKeepingCenter(zoom / 1.4)} style={btnStyle(false)} data-action="zoom-out">−</button>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: "center" }} data-zoom-indicator>{zoomPct}%</span>
          <button onClick={() => setZoomKeepingCenter(zoom * 1.4)} style={btnStyle(false)} data-action="zoom-in">+</button>
        </div>
        <button onClick={() => setPanModeToggle((p) => !p)} style={btnStyle(panModeToggle || spaceHeld)} data-pan-toggle>
          {panModeToggle || spaceHeld ? "Pan: ON (drag to move)" : "Pan: off (or hold Space)"}
        </button>
        <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>
          Corrections applied: {correctionCount}
          {latencyMs !== null ? ` · last check: ${latencyMs}ms` : ""}
        </span>
      </div>

      <div className="mt-2" style={{ border: "2px solid #222", borderRadius: 8, overflow: "hidden", background: "#fafafa" }}>
        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-correction-canvas
          style={{ width: "100%", height: "auto", display: "block", cursor: panModeToggle || spaceHeld ? "grab" : "crosshair", touchAction: "none" }}
        />
      </div>

      {message ? (
        <div className="mt-2 rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-900" data-correction-message>
          {message}
        </div>
      ) : null}

      {selection ? (
        <div className="mt-3" data-selection-panel>
          <p className="mb-1.5 text-sm font-semibold text-ink">
            Selection {pendingClicks.length > 1 ? `(${pendingClicks.length} areas)` : ""}
          </p>
          <div className="mb-2 flex gap-2">
            <button onClick={() => changeTolerance("less")} style={btnStyle(tolerance === "less")} disabled={busy} data-tolerance="less">Less</button>
            <button onClick={() => changeTolerance("default")} style={btnStyle(tolerance === "default")} disabled={busy} data-tolerance="default">Default</button>
            <button onClick={() => changeTolerance("more")} style={btnStyle(tolerance === "more")} disabled={busy} data-tolerance="more">More</button>
          </div>
          <div className="flex gap-2">
            <button onClick={applyAction} disabled={busy} style={btnStylePrimary()} data-action="apply">{actionLabel}</button>
            <button onClick={clearSelection} disabled={busy} style={btnStyle(false)} data-action="clear-selection">Clear Selection</button>
          </div>
        </div>
      ) : null}

      {!selection ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={undoLastCorrection} disabled={busy || correctionCount === 0} style={btnStyle(false)} data-action="undo-correction">Undo</button>
          <button onClick={startOver} disabled={busy} style={btnStyle(false)} data-action="start-over">Start Over</button>
          <button onClick={onDoneEditing} disabled={busy} style={btnStyleDone()} data-action="done-editing">Done Editing</button>
        </div>
      ) : null}

      <details className="mt-4 text-xs text-muted">
        <summary>Compare against the original upload</summary>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={ORIGINAL_URL} alt="Original uploaded artwork, unchanged" className="mt-2 max-w-full rounded-lg border border-black/10" />
      </details>
    </div>
  );
}

function btnStyle(active: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 999,
    border: active ? "2px solid #111" : "1px solid #ccc",
    background: active ? "#111" : "white",
    color: active ? "white" : "#111",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  };
}
function btnStylePrimary(): CSSProperties {
  return {
    padding: "10px 18px",
    borderRadius: 999,
    border: "none",
    background: "#111",
    color: "white",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  };
}
function btnStyleDone(): CSSProperties {
  return {
    padding: "10px 18px",
    borderRadius: 999,
    border: "none",
    background: "#173F35",
    color: "white",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginLeft: "auto",
  };
}
