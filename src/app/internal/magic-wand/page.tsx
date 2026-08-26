"use client";

/**
 * Phase 27C/27D — EXPERIMENTAL / LOCAL-ONLY human-usability harness.
 *
 * NOT wired into any production route, capability, or component. Never
 * reachable from the customer-facing app.
 *
 * Phase 27D adds a fast desktop correction workflow on top of Phase 27C's
 * proven single-click selection, WITHOUT touching the flood-fill algorithm,
 * tolerance ladder, or restore/remove invariants (those live entirely in
 * `magic-wand.ts`/`lab-state.ts` and are unchanged in spirit — only a pure
 * `unionMasks`/`filterClicksContaining` addition was made there):
 *  - Shift+click: additive selection (adds another disconnected region).
 *  - Alt/Option+click on a pending region: subtractive (drops that one
 *    click's region from the pending selection).
 *  - Delete/Backspace: applies the pending selection's mode-appropriate
 *    action in one keystroke (guarded against text-entry targets).
 *  - Real cursor-centered wheel zoom + Spacebar-drag pan, replacing the
 *    Fit/100%-only toggle with continuous zoom and a live indicator.
 *
 * Deliberately hides algorithm terminology from operator-facing copy.
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

const RESULT_URL = "/api/internal/magic-wand/result";
const ORIGINAL_URL = "/api/internal/magic-wand/original";
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

/** Delete/Backspace (and other shortcuts) must never fire while the user is typing somewhere. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export default function MagicWandLabPage() {
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

  // Refs mirror the latest state for use inside native event listeners
  // (wheel, keydown) so those handlers never read a stale closure without
  // needing to re-attach the listener on every render.
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
    loadImage(`${RESULT_URL}?v=${resultNonce}`).then(setResultImg).catch(() => setMessage("Could not load the artwork. Is the dev server running?"));
  }, [resultNonce]);

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

  // Center-on-fit exactly once, the first time the image loads (not on
  // every subsequent result refresh -- Section E requires the viewport to
  // stay put after Delete/Apply).
  const hasCenteredRef = useRef(false);
  useEffect(() => {
    if (!resultImg || hasCenteredRef.current) return;
    hasCenteredRef.current = true;
    zoomToFit(resultImg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultImg]);

  /** CSS-pixel click coordinate -> canvas-INTERNAL-pixel coordinate. Phase 27B/27C bug fix: the canvas's internal pixel buffer (1100x760) and its CSS-rendered size can differ (mobile, narrow containers) -- every click must be corrected by that ratio, or clicks land on the wrong source pixel whenever they differ. */
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
    const res = await fetch("/api/internal/magic-wand/select", {
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
      if (pendingClicksRef.current.length === 0) return; // nothing pending to subtract from
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

  // ---- Pointer handling: click vs. drag-to-pan disambiguation -------------
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
      panRef.current = newPan; // keep the ref current in case a click follows immediately after release
      setPan(newPan);
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.isPan || d.moved) return; // was a pan, or a drag beyond the click threshold
    const canvasPt = clientToCanvasInternal(e.clientX, e.clientY);
    const imgPt = canvasToImage(canvasPt);
    const img = resultImg;
    if (!img || imgPt.x < 0 || imgPt.x >= img.width || imgPt.y < 0 || imgPt.y >= img.height) return;
    handleClickAt(imgPt, e.shiftKey, e.altKey);
  }

  // ---- Wheel zoom, centered on the cursor ----------------------------------
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
      // Update the refs synchronously, not just via setState -- rapid
      // successive wheel events (fast scrolling) can otherwise fire again
      // before React re-renders and refreshes zoomRef/panRef from state,
      // causing each tick to zoom around a stale cursor-to-image mapping
      // and drift away from the actual cursor position. The refs are the
      // source of truth for the NEXT wheel tick; setState is only what
      // schedules the redraw.
      zoomRef.current = newZoom;
      panRef.current = newPan;
      setZoom(newZoom);
      setPan(newPan);
    }
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef.current]);

  // ---- Keyboard: Delete/Backspace applies; Space holds to pan; 0 fits -----
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
    const res = await fetch("/api/internal/magic-wand/apply", {
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
    // Deliberately NOT touching zoom/pan here (Section E): the operator
    // keeps working in the same zoomed-in spot after a correction.
  }

  async function undoLastCorrection() {
    setBusy(true);
    await fetch("/api/internal/magic-wand/undo", { method: "POST" });
    setBusy(false);
    setCorrectionCount((n) => Math.max(0, n - 1));
    setResultNonce((n) => n + 1);
  }

  async function startOver() {
    setBusy(true);
    await fetch("/api/internal/magic-wand/reset", { method: "POST" });
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
    <div style={{ maxWidth: 1300, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>
        Experimental local tool — not part of the iHeartPrints product. For evaluating the interaction only.
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{mode === "restore" ? "Restore Missing Artwork" : "Remove Background"}</h1>
      <p style={{ fontSize: 14, color: "#555", marginBottom: 12 }}>
        {instruction} Shift+click to add another area. Alt+click a highlighted area to remove it from the selection. Press Delete to apply.
      </p>

      <div role="group" aria-label="Mode" style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => changeMode("restore")} style={btnStyle(mode === "restore")} data-mode="restore">Restore Missing Artwork</button>
        <button onClick={() => changeMode("remove")} style={btnStyle(mode === "remove")} data-mode="remove">Remove Background</button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" }}>
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

      <div style={{ border: "2px solid #222", borderRadius: 8, overflow: "hidden", background: "#fafafa" }}>
        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-wand-canvas
          style={{ width: "100%", height: "auto", display: "block", cursor: panModeToggle || spaceHeld ? "grab" : "crosshair", touchAction: "none" }}
        />
      </div>

      {message ? (
        <div style={{ marginTop: 8, padding: "8px 12px", background: "#fee2e2", border: "1px solid #ef4444", borderRadius: 6, fontSize: 13 }} data-wand-message>
          {message}
        </div>
      ) : null}

      {selection ? (
        <div style={{ marginTop: 12 }} data-selection-panel>
          <p style={{ fontWeight: 600, marginBottom: 6 }}>
            Selection {pendingClicks.length > 1 ? `(${pendingClicks.length} areas)` : ""}
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button onClick={() => changeTolerance("less")} style={btnStyle(tolerance === "less")} disabled={busy} data-tolerance="less">Less</button>
            <button onClick={() => changeTolerance("default")} style={btnStyle(tolerance === "default")} disabled={busy} data-tolerance="default">Default</button>
            <button onClick={() => changeTolerance("more")} style={btnStyle(tolerance === "more")} disabled={busy} data-tolerance="more">More</button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={applyAction} disabled={busy} style={btnStylePrimary()} data-action="apply">{actionLabel}</button>
            <button onClick={clearSelection} disabled={busy} style={btnStyle(false)} data-action="clear-selection">Clear Selection</button>
          </div>
        </div>
      ) : null}

      {!selection ? (
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button onClick={undoLastCorrection} disabled={busy || correctionCount === 0} style={btnStyle(false)} data-action="undo-correction">Undo</button>
          <button onClick={startOver} disabled={busy} style={btnStyle(false)} data-action="start-over">Start Over</button>
        </div>
      ) : null}

      <details style={{ marginTop: 20, fontSize: 12, color: "#888" }}>
        <summary>Compare against the original upload</summary>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={ORIGINAL_URL} alt="Original uploaded artwork, unchanged" style={{ maxWidth: "100%", marginTop: 8, border: "1px solid #ddd", borderRadius: 6 }} />
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
