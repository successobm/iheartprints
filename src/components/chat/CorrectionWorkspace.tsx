"use client";

/**
 * Phase 27E — GRADUATED from the Phase 27C/27D experimental Magic Wand lab
 * (`src/experimental/magic-wand/page.tsx`). The Magic Wand INTERACTION
 * LOGIC is frozen and copied over unchanged per the Phase 27E mandate —
 * click/Shift+click/Alt+click, the Less/Default/More tolerance ladder,
 * Delete/Backspace, wheel-zoom-on-cursor, Spacebar-drag pan, and the
 * coordinate-conversion math are byte-for-byte the same as the approved
 * Phase 27D lab page. Only the endpoint URLs (now project-scoped) and the
 * addition of a "Done Editing" completion action are new there.
 *
 * Phase 27I — TOOLBOX V1. The prior top-level "Remove Background" /
 * "Restore Missing Artwork" MODE SWITCH is replaced by a compact TOOLBAR:
 * Wand / Fill / Brush / Eraser, with Undo always reachable. This is one
 * editor, not two workflows. Magic Wand's own interaction logic above is
 * UNTOUCHED by this change — it is simply presented as one of four tools
 * now, still defaulting to its "remove" sub-mode. Fill and Brush/Eraser are
 * NEW tools, added because Magic Wand's same-colour-region model cannot
 * safely restore legitimate artwork that shares one colour region with
 * unwanted background in the ORIGINAL image (the real INCREDI-BOWLS bowling-ball
 * black fill vs. the bowling-ball's own black background) — Fill reasons
 * about the CURRENT RESULT's transparency instead, and Brush is the
 * guaranteed direct-pixel-authority escape hatch when even that fails
 * (see `correction-tools.ts` and the Phase 27I report for why).
 *
 * Do NOT modify the frozen Magic Wand interaction logic here without a
 * demonstrated integration bug — see the Phase 27E report's frozen-surface
 * list. Fill/Brush/Eraser are NOT frozen; they are this phase's own new
 * surface.
 *
 * Operator-facing copy has no algorithm terminology, matching Phase 27D.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

type Point = { x: number; y: number };
type WandMode = "restore" | "remove";
type ToleranceLevel = "less" | "default" | "more";
type Tool = "magic_wand" | "restore_fill" | "restore_brush" | "erase_brush";
type BrushSizeLevel = "small" | "medium" | "large";

/** Mirrors `BRUSH_RADIUS_LEVELS` in `correction-tools.ts` (image-space pixels). Duplicated here — a tiny, easily-kept-in-sync constant — rather than importing server-side algorithm code into a client bundle. */
const BRUSH_RADIUS_LEVELS: Record<BrushSizeLevel, number> = { small: 6, medium: 14, large: 24 };

interface SelectionInfo {
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  touchesEdge: boolean;
  broad: boolean;
}

interface FillPreviewInfo {
  click: Point;
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  refusalReason: string | null;
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

const TOOLS: Array<{ tool: Tool; label: string; tooltip: string }> = [
  { tool: "magic_wand", label: "Wand", tooltip: "Select similar connected pixels." },
  { tool: "restore_fill", label: "Fill", tooltip: "Restore an enclosed missing area from your original." },
  { tool: "restore_brush", label: "Brush", tooltip: "Paint back pixels from your original." },
  { tool: "erase_brush", label: "Eraser", tooltip: "Erase pixels directly." },
];

export default function CorrectionWorkspace({ projectId, onDoneEditing, onCancel }: CorrectionWorkspaceProps) {
  const base = `/api/projects/${projectId}/artwork-preparation/correction`;
  const RESULT_URL = `${base}/result`;
  const ORIGINAL_URL = `${base}/original`;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [resultImg, setResultImg] = useState<HTMLImageElement | null>(null);
  const [resultNonce, setResultNonce] = useState(0);
  const [correctionCount, setCorrectionCount] = useState(0);

  // Phase 27I: the toolbar replaces the old top-level Remove/Restore mode
  // switch. Wand remains the default/primary tool (§A "Default: Wand").
  const [activeTool, setActiveTool] = useState<Tool>("magic_wand");

  // Phase 27G: Wand's own remove/restore sub-mode -- unchanged mechanism,
  // just no longer the top-level navigation. Remove is still the default
  // sub-mode (nothing is missing yet when a session starts).
  const [wandMode, setWandMode] = useState<WandMode>("remove");
  const [tolerance, setTolerance] = useState<ToleranceLevel>("default");
  const [pendingClicks, setPendingClicks] = useState<Point[]>([]);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [overlayImg, setOverlayImg] = useState<HTMLImageElement | null>(null);

  // Phase 27I §C: Fill's own preview state -- deliberately separate from
  // Wand's `selection`/`pendingClicks` so Delete/Backspace (Wand-only, see
  // §G) can never be misread as "apply the Fill preview".
  const [fillPreview, setFillPreview] = useState<FillPreviewInfo | null>(null);

  // Phase 27I §D/E: Brush/Eraser share one size control and one live stroke
  // path (`strokePointsRef`) -- rendered locally while dragging, sent to
  // the server as raw points + radius only on release.
  const [brushSize, setBrushSize] = useState<BrushSizeLevel>("medium");
  const strokePointsRef = useRef<Point[]>([]);

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
  const activeToolRef = useRef(activeTool);
  const wandModeRef = useRef(wandMode);
  const toleranceRef = useRef(tolerance);
  const brushSizeRef = useRef(brushSize);
  const busyRef = useRef(busy);
  const spaceHeldRef = useRef(false);
  const panModeToggleRef = useRef(panModeToggle);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number; moved: boolean; isPan: boolean } | null>(null);

  zoomRef.current = zoom;
  panRef.current = pan;
  pendingClicksRef.current = pendingClicks;
  selectionRef.current = selection;
  activeToolRef.current = activeTool;
  wandModeRef.current = wandMode;
  toleranceRef.current = tolerance;
  brushSizeRef.current = brushSize;
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

    if (fillPreview) {
      const c = imageToCanvas(fillPreview.click);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = fillPreview.refusalReason ? "#dc2626" : "#2563eb";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Phase 27K §2: a pending Wand selection must never read as an already-
    // completed removal. The server-rendered overlay (translucent tint +
    // marching-ants boundary, `renderSelectionOverlay` -- frozen, untouched
    // by this phase) already marks the selected pixels, but that alone can
    // read ambiguously against dark/small artwork. This adds an UNMISTAKABLE,
    // client-side-only "still just a selection" cue: a dashed amber
    // marquee around the selection's bounding box, in a colour this app
    // never uses for anything else (pending clicks are blue, the frozen
    // overlay's own boundary is magenta/cyan). Purely additive drawing --
    // never touches the selection mask, the overlay image, or anything
    // sent to the server.
    if (activeTool === "magic_wand" && selection?.bounds) {
      const topLeft = imageToCanvas({ x: selection.bounds.left, y: selection.bounds.top });
      const bottomRight = imageToCanvas({
        x: selection.bounds.left + selection.bounds.width,
        y: selection.bounds.top + selection.bounds.height,
      });
      ctx.save();
      ctx.strokeStyle = "#F59E0B";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.restore();
    }

    // Phase 27I §D/E: live client-side stroke preview while dragging --
    // visual only, never sent anywhere; the authoritative mask is always
    // recomputed server-side from the raw points on release.
    if (strokePointsRef.current.length > 0) {
      const radius = BRUSH_RADIUS_LEVELS[brushSizeRef.current] * zoomRef.current;
      ctx.fillStyle = activeToolRef.current === "erase_brush" ? "rgba(220,38,38,0.35)" : "rgba(37,99,235,0.35)";
      for (const p of strokePointsRef.current) {
        const c = imageToCanvas(p);
        ctx.beginPath();
        ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultImg, overlayImg, pendingClicks, fillPreview, selection, activeTool, pan, zoom]);

  useEffect(() => { draw(); }, [draw]);

  async function runSelection(clicks: Point[], m: WandMode, t: ToleranceLevel, removeAt?: Point) {
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

  function handleWandClickAt(imgPt: Point, shiftKey: boolean, altKey: boolean) {
    if (busyRef.current) return;
    if (altKey) {
      if (pendingClicksRef.current.length === 0) return;
      void runSelection(pendingClicksRef.current, wandModeRef.current, toleranceRef.current, imgPt);
      return;
    }
    if (shiftKey && pendingClicksRef.current.length > 0) {
      const next = [...pendingClicksRef.current, imgPt];
      setPendingClicks(next);
      void runSelection(next, wandModeRef.current, toleranceRef.current);
      return;
    }
    const next = [imgPt];
    setPendingClicks(next);
    void runSelection(next, wandModeRef.current, toleranceRef.current);
  }

  // Phase 27I §C: single click, no Shift/Alt semantics (V1 scope -- Fill is
  // not another graduated wand; see `correction-tools.ts`'s doc comment).
  async function runFillPreview(imgPt: Point) {
    setBusy(true);
    setMessage(null);
    const res = await fetch(`${base}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "restore_fill", click: imgPt }),
    });
    setBusy(false);
    if (!res.ok) {
      setFillPreview(null);
      setOverlayImg(null);
      setMessage("Could not check that area. Try clicking somewhere else.");
      return;
    }
    const body = (await res.json()) as {
      pixelCount: number;
      bounds: FillPreviewInfo["bounds"];
      overlayDataUrl: string | null;
      refused: boolean;
      refusalReason: string | null;
    };
    if (body.pixelCount === 0) {
      setFillPreview(null);
      setOverlayImg(null);
      setMessage("There's nothing missing at that point to restore.");
      return;
    }
    setFillPreview({ click: imgPt, pixelCount: body.pixelCount, bounds: body.bounds, refusalReason: body.refusalReason });
    if (body.overlayDataUrl) setOverlayImg(await loadImage(body.overlayDataUrl));
  }

  async function applyFill() {
    if (!fillPreview || fillPreview.refusalReason) return;
    setBusy(true);
    const res = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "restore_fill", click: fillPreview.click }),
    });
    setBusy(false);
    if (!res.ok) { setMessage("Could not restore that area. Try again."); return; }
    setFillPreview(null);
    setOverlayImg(null);
    setCorrectionCount((n) => n + 1);
    setResultNonce((n) => n + 1);
  }

  function clearFillPreview() {
    setFillPreview(null);
    setOverlayImg(null);
    setMessage(null);
  }

  async function submitStroke(points: Point[]) {
    if (points.length === 0) return;
    const tool = activeToolRef.current === "erase_brush" ? "erase_brush" : "restore_brush";
    setBusy(true);
    const res = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, points, radius: BRUSH_RADIUS_LEVELS[brushSizeRef.current] }),
    });
    setBusy(false);
    if (!res.ok) { setMessage("Could not apply that stroke. Try again."); return; }
    setCorrectionCount((n) => n + 1);
    setResultNonce((n) => n + 1);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (busyRef.current) return;
    const isPan = spaceHeldRef.current || panModeToggleRef.current || e.button === 1;
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: panRef.current.x, panY: panRef.current.y, moved: false, isPan };
    if (isPan) return;
    const tool = activeToolRef.current;
    if (tool === "restore_brush" || tool === "erase_brush") {
      const canvasPt = clientToCanvasInternal(e.clientX, e.clientY);
      const imgPt = canvasToImage(canvasPt);
      const img = resultImg;
      if (!img || imgPt.x < 0 || imgPt.x >= img.width || imgPt.y < 0 || imgPt.y >= img.height) return;
      strokePointsRef.current = [imgPt];
      draw();
    }
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
      return;
    }
    if (strokePointsRef.current.length > 0) {
      const canvasPt = clientToCanvasInternal(e.clientX, e.clientY);
      const imgPt = canvasToImage(canvasPt);
      const img = resultImg;
      if (img && imgPt.x >= 0 && imgPt.x < img.width && imgPt.y >= 0 && imgPt.y < img.height) {
        const last = strokePointsRef.current[strokePointsRef.current.length - 1];
        if (!last || last.x !== imgPt.x || last.y !== imgPt.y) {
          strokePointsRef.current = [...strokePointsRef.current, imgPt];
          draw();
        }
      }
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    dragRef.current = null;

    if (strokePointsRef.current.length > 0) {
      const points = strokePointsRef.current;
      strokePointsRef.current = [];
      void submitStroke(points);
      return;
    }

    if (!d || d.isPan || d.moved) return;
    const canvasPt = clientToCanvasInternal(e.clientX, e.clientY);
    const imgPt = canvasToImage(canvasPt);
    const img = resultImg;
    if (!img || imgPt.x < 0 || imgPt.x >= img.width || imgPt.y < 0 || imgPt.y >= img.height) return;

    const tool = activeToolRef.current;
    if (tool === "magic_wand") {
      handleWandClickAt(imgPt, e.shiftKey, e.altKey);
    } else if (tool === "restore_fill") {
      void runFillPreview(imgPt);
    }
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
        // Phase 27I §G: Delete/Backspace applies a pending WAND selection
        // ONLY -- never Fill (its own explicit "Restore This Area" button),
        // and never Brush/Eraser (direct stroke-driven tools with no
        // pending-selection concept at all). This is what keeps Delete from
        // ever "unexpectedly erasing under the cursor" for those tools.
        if (activeToolRef.current === "magic_wand" && selectionRef.current && pendingClicksRef.current.length > 0 && !busyRef.current) {
          e.preventDefault();
          void applyWandSelection();
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
    if (pendingClicks.length > 0) void runSelection(pendingClicks, wandMode, t);
  }

  function changeWandMode(m: WandMode) {
    setWandMode(m);
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
  }

  /**
   * Phase 27I §C/§G: switching tools is always non-destructive. Any pending
   * Wand selection or Fill preview is CLEARED, never silently applied --
   * "no hidden destructive action" applies just as much to a tool switch as
   * it does to Delete.
   */
  function selectTool(tool: Tool) {
    setActiveTool(tool);
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
    setFillPreview(null);
    setMessage(null);
    strokePointsRef.current = [];
  }

  function clearWandSelection() {
    setPendingClicks([]);
    setSelection(null);
    setOverlayImg(null);
    setMessage(null);
  }

  async function applyWandSelection() {
    if (pendingClicksRef.current.length === 0) return;
    setBusy(true);
    const t0 = performance.now();
    const res = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clicks: pendingClicksRef.current, mode: wandModeRef.current, toleranceLevel: toleranceRef.current }),
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
    setFillPreview(null);
    setCorrectionCount(0);
    setResultNonce((n) => n + 1);
  }

  const activeToolInfo = TOOLS.find((t) => t.tool === activeTool)!;
  // Phase 27K §2/§3: human testing traced the D/B/R "regression" to UX
  // confusion, not a composition bug -- a pending Wand selection read as
  // an already-completed removal. The fix is a short, STATE-DEPENDENT
  // instruction: "select" language before a selection exists, "ready to
  // apply" language once one does, so the operator always knows which
  // side of "selected" vs. "removed" they're on. Deliberately short --
  // the previous longer paragraph explaining how the selection grows is
  // dropped here per §3 ("do not overload the workspace with explanatory
  // text"); Shift/Alt/Delete guidance remains as its own secondary line.
  const wandInstruction = selection
    ? wandMode === "restore"
      ? "Selection ready — adjust if needed, then restore it."
      : "Selection ready — adjust if needed, then remove it."
    : wandMode === "restore"
      ? "Click the missing area to select it."
      : "Click an area to select it.";
  const instruction =
    activeTool === "magic_wand"
      ? wandInstruction
      : activeTool === "restore_fill"
        ? "Click inside a missing area you want to restore."
        : activeTool === "restore_brush"
          ? "Press and drag to paint back your original artwork."
          : "Press and drag to erase pixels.";
  const zoomPct = Math.round(zoom * 100);
  const canvasCursor = panModeToggle || spaceHeld ? "grab" : activeTool === "restore_brush" || activeTool === "erase_brush" ? "cell" : "crosshair";

  return (
    <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-correction-workspace>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Clean Up Your Artwork</h2>
          <p className="mt-1 text-sm text-muted">{instruction}</p>
          {activeTool === "magic_wand" ? (
            <p className="mt-1 text-xs text-muted">
              Shift+click to add another area. Alt+click a highlighted area to remove it from the selection. Press Delete to apply.
            </p>
          ) : null}
        </div>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="shrink-0 text-xs text-muted underline-offset-2 hover:text-ink hover:underline" data-action="cancel-workspace">
            Cancel
          </button>
        ) : null}
      </div>

      {/* Phase 27I §A: the compact TOOLBAR. Wand is the default/primary
          tool; Fill/Brush/Eraser are siblings, not a second workflow. */}
      <div className="mt-3" role="group" aria-label="Tools" data-toolbar>
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              onClick={() => selectTool(t.tool)}
              style={btnStyle(activeTool === t.tool)}
              title={t.tooltip}
              data-tool={t.tool}
              aria-pressed={activeTool === t.tool}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={undoLastCorrection}
            disabled={busy || correctionCount === 0}
            style={btnStyle(false)}
            data-action="undo-correction"
          >
            Undo
          </button>
        </div>
        <p className="mt-1.5 text-xs text-muted" data-tool-tooltip>{activeToolInfo.tooltip}</p>
      </div>

      {activeTool === "magic_wand" ? (
        <div role="group" aria-label="Wand mode" className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => changeWandMode("remove")} style={btnStyle(wandMode === "remove")} data-mode="remove">Remove Background</button>
          <button onClick={() => changeWandMode("restore")} style={btnStyle(wandMode === "restore")} data-mode="restore">Restore Missing Artwork</button>
        </div>
      ) : null}

      {activeTool === "restore_brush" || activeTool === "erase_brush" ? (
        <div role="group" aria-label="Brush size" className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => setBrushSize("small")} style={btnStyle(brushSize === "small")} data-brush-size="small">Small</button>
          <button onClick={() => setBrushSize("medium")} style={btnStyle(brushSize === "medium")} data-brush-size="medium">Medium</button>
          <button onClick={() => setBrushSize("large")} style={btnStyle(brushSize === "large")} data-brush-size="large">Large</button>
        </div>
      ) : null}

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
          style={{ width: "100%", height: "auto", display: "block", cursor: canvasCursor, touchAction: "none" }}
        />
      </div>

      {message ? (
        <div className="mt-2 rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-900" data-correction-message>
          {message}
        </div>
      ) : null}

      {activeTool === "magic_wand" && selection ? (
        <div className="mt-3" data-selection-panel>
          <p className="mb-1.5 text-sm font-semibold text-ink">
            Selection {pendingClicks.length > 1 ? `(${pendingClicks.length} areas)` : ""}
          </p>
          <div className="mb-2 flex flex-wrap gap-2">
            <button onClick={() => changeTolerance("less")} style={btnStyle(tolerance === "less")} disabled={busy} data-tolerance="less">Less</button>
            <button onClick={() => changeTolerance("default")} style={btnStyle(tolerance === "default")} disabled={busy} data-tolerance="default">Default</button>
            <button onClick={() => changeTolerance("more")} style={btnStyle(tolerance === "more")} disabled={busy} data-tolerance="more">More</button>
          </div>
          {/* Phase 27K §12: "Remove Selected Area"/"Restore Selected Area"
              are longer than the labels this row previously held --
              flex-wrap (not present before) keeps this row from forcing
              horizontal overflow at 320px now that the primary label is
              longer. */}
          <div className="flex flex-wrap gap-2">
            {/* Phase 27K §4: "Remove Selected Area" (not "Remove Background")
                specifically communicates that only the selected region is
                affected and that the current preview is not yet committed
                -- the exact distinction human testing found missing. */}
            <button onClick={applyWandSelection} disabled={busy} style={btnStylePrimary()} data-action="apply">
              {wandMode === "restore" ? "Restore Selected Area" : "Remove Selected Area"}
            </button>
            <button onClick={clearWandSelection} disabled={busy} style={btnStyle(false)} data-action="clear-selection">Clear Selection</button>
          </div>
        </div>
      ) : null}

      {activeTool === "restore_fill" && fillPreview ? (
        <div className="mt-3" data-fill-panel>
          {fillPreview.refusalReason ? (
            <p className="mb-2 text-sm text-red-900" data-fill-refusal>{fillPreview.refusalReason}</p>
          ) : (
            <p className="mb-2 text-sm font-semibold text-ink">Missing area found ({fillPreview.pixelCount} pixels)</p>
          )}
          <div className="flex gap-2">
            {!fillPreview.refusalReason ? (
              <button onClick={applyFill} disabled={busy} style={btnStylePrimary()} data-action="apply-fill">Restore This Area</button>
            ) : null}
            <button onClick={clearFillPreview} disabled={busy} style={btnStyle(false)} data-action="clear-fill">
              {fillPreview.refusalReason ? "OK" : "Clear"}
            </button>
          </div>
        </div>
      ) : null}

      {!(activeTool === "magic_wand" && selection) && !(activeTool === "restore_fill" && fillPreview) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
