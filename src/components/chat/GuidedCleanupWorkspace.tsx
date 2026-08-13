"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  GUIDED_CLEANUP_COPY,
  type ArtworkBounds,
  type GuidedCleanupTool,
} from "@/capabilities/artwork-preparation";
import {
  MAGIC_SELECT_DEFAULT_TOLERANCE,
  MAGIC_SELECT_TOLERANCE_MAX,
  MAGIC_SELECT_TOLERANCE_MIN,
  MAGIC_SELECT_TOLERANCE_STEP,
  clampMagicSelectTolerance,
} from "@/capabilities/artwork-preparation/magic-color-selection";
import {
  mapClickToImagePoint,
  mapImageBoundsToCssPercent,
  type ImagePoint,
} from "./artwork-click-mapping";
import { PreviewBackgroundControl } from "./PreviewBackgroundControl";
import {
  candidateHighlightFrameClassName,
  DEFAULT_PREVIEW_BACKGROUND,
  previewBackgroundSurfaceStyle,
  type PreviewBackground,
} from "./preview-background";
import {
  clampZoomFactor,
  fitDisplaySize,
  GUIDED_CLEANUP_ZOOM_MAX,
  GUIDED_CLEANUP_ZOOM_MIN,
  isWheelZoomModifier,
  nextZoomFromWheel,
  nextZoomIn,
  nextZoomOut,
  pointerCenteredScroll,
  zoomedDisplaySize,
  zoomPercentLabel,
} from "./guided-cleanup-zoom";
import {
  advanceGesture,
  beginGesture,
  isPanModifierKey,
  isPanModifierTarget,
  resolveArtworkCursorClassName,
  shouldSelectOnRelease,
  type GestureSession,
} from "./guided-cleanup-interaction";

/**
 * Existing Artwork → Print Ready Phase 1.4 / 1.7: the LARGE guided-cleanup
 * workspace.
 *
 * This is the canonical customer path for removing leftover background.
 * Compare's small tile is no longer the place customers are expected to
 * click; Enlarge stays a separate read-only viewer. Presentation only —
 * every preview/confirm/undo call is owned by the parent and uses the
 * existing Phase 1.3 / 1.7 server pipeline.
 *
 * Not an image editor: no brush, no lasso, no freehand mask. Fit / Zoom /
 * pan exist only so customers can inspect small details and click accurately.
 * Phase 1.7 adds Select Area vs Magic Select — still preview-then-confirm,
 * still no freehand editing.
 *
 * Zoom grows the rendered image content box inside a scrollable viewport
 * (never CSS `transform: scale`). Clicks use getBoundingClientRect +
 * mapClickToImagePoint. Confirm/undo remount the <img> via preparedRevision
 * but keep the current zoom factor; pan recenters on Fit only.
 *
 * Phase 1.5: Preview Background (White / Gray / Black) is presentation-only
 * CSS under the transparent PNG. Switching it never changes prepared bytes,
 * preparedRevision, candidate preview, zoom, or cleanup lifecycle.
 */

export interface GuidedCleanupHighlightView {
  bounds: ArtworkBounds;
  overlayDataUrl: string;
}

export interface GuidedCleanupSelectOptions {
  tool: GuidedCleanupTool;
  tolerance: number;
}

export interface GuidedCleanupWorkspaceProps {
  preparedImageUrl: string;
  /**
   * Opaque prepared derivation identity. Keys the base <img> so a new
   * confirm/undo cannot reuse a previously decoded bitmap for a superseded
   * revision. Preview must not change this.
   */
  preparedRevision: string;
  /** Intrinsic prepared size — used so the highlight can paint before onLoad. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  busy: boolean;
  removalCount: number;
  cleanupMessage: string | null;
  pendingHighlight: GuidedCleanupHighlightView | null;
  onSelectPoint: (
    point: ImagePoint,
    options: GuidedCleanupSelectOptions,
  ) => void;
  onConfirm: () => void;
  onCancelPreview: () => void;
  onUndo: () => void;
  /** Closes the workspace without approving prepared artwork. */
  onDone: () => void;
  /**
   * Optional first-paint QA background (defaults to White). Used by tests to
   * render Gray/Black without a browser click harness. Presentation only —
   * never persists and never mutates artwork.
   */
  initialPreviewBackground?: PreviewBackground;
}

/** SSR / first-paint fallback until ResizeObserver measures the viewport. */
const FALLBACK_VIEWPORT = { width: 720, height: 480 };

export function GuidedCleanupWorkspace({
  preparedImageUrl,
  preparedRevision,
  sourceWidthPx,
  sourceHeightPx,
  busy,
  removalCount,
  cleanupMessage,
  pendingHighlight,
  onSelectPoint,
  onConfirm,
  onCancelPreview,
  onUndo,
  onDone,
  initialPreviewBackground = DEFAULT_PREVIEW_BACKGROUND,
}: GuidedCleanupWorkspaceProps) {
  const pendingConfirmation = pendingHighlight !== null;
  const [cleanupTool, setCleanupTool] = useState<GuidedCleanupTool>("region");
  const [tolerance, setTolerance] = useState(MAGIC_SELECT_DEFAULT_TOLERANCE);
  const lastSelectPointRef = useRef<ImagePoint | null>(null);
  const [loadedForUrl, setLoadedForUrl] = useState<{
    url: string;
    revision: string;
    width: number;
    height: number;
  } | null>(null);
  const loadedSize =
    loadedForUrl?.url === preparedImageUrl &&
    loadedForUrl.revision === preparedRevision
      ? loadedForUrl
      : null;
  // Prefer measured natural size after load; fall back to preparation dims so
  // the authoritative highlight can paint immediately (and under SSR tests).
  const naturalWidth = loadedSize?.width ?? sourceWidthPx;
  const naturalHeight = loadedSize?.height ?? sourceHeightPx;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState(FALLBACK_VIEWPORT);
  /** 1 = Fit. Preserved across preparedRevision remounts. */
  const [zoomFactor, setZoomFactor] = useState(GUIDED_CLEANUP_ZOOM_MIN);
  /** QA inspection surface only — never persisted, never sent to the server. */
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>(
    initialPreviewBackground,
  );
  // Phase 1.5: solid QA surface from preview-background.ts only — never the
  // legacy ArtworkPreviewModal checkerboard helper (a stale Turbopack chunk
  // once called that helper as a bare identifier and crashed Clean Up Background).
  const artworkSurfaceStyle = previewBackgroundSurfaceStyle(previewBackground);
  const panSession = useRef<GestureSession | null>(null);
  const zoomFactorRef = useRef(zoomFactor);
  const displayRef = useRef({ width: 0, height: 0 });
  const fitRef = useRef<ReturnType<typeof fitDisplaySize>>(null);
  const busyRef = useRef(busy);
  const pendingScrollRef = useRef<{ scrollLeft: number; scrollTop: number } | null>(
    null,
  );
  /**
   * Phase 1.6B: the explicit pan modifier. Selection is the default gesture at
   * every zoom level, so panning has to be asked for.
   */
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (pendingConfirmation) {
          onCancelPreview();
          return;
        }
        onDone();
        return;
      }
      if (!isPanModifierKey(event.key)) return;
      if (!isPanModifierTarget(event.target)) return;
      // Space would otherwise scroll the viewport out from under the artwork.
      event.preventDefault();
      setSpaceHeld(true);
    }
    function handleKeyUp(event: KeyboardEvent) {
      if (!isPanModifierKey(event.key)) return;
      setSpaceHeld(false);
    }
    /** A tab-away must not leave the workspace stuck in pan mode. */
    function handleBlur() {
      setSpaceHeld(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [pendingConfirmation, onCancelPreview, onDone]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setViewportSize({ width, height });
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fit = fitDisplaySize(
    naturalWidth,
    naturalHeight,
    viewportSize.width,
    viewportSize.height,
  );
  const display = fit
    ? zoomedDisplaySize(fit, zoomFactor)
    : { width: 0, height: 0 };
  const atMinZoom = zoomFactor <= GUIDED_CLEANUP_ZOOM_MIN;
  const atMaxZoom = zoomFactor >= GUIDED_CLEANUP_ZOOM_MAX;

  useLayoutEffect(() => {
    const liveFit = fitDisplaySize(
      naturalWidth,
      naturalHeight,
      viewportSize.width,
      viewportSize.height,
    );
    const liveDisplay = liveFit
      ? zoomedDisplaySize(liveFit, zoomFactor)
      : { width: 0, height: 0 };
    zoomFactorRef.current = zoomFactor;
    displayRef.current = liveDisplay;
    fitRef.current = liveFit;
    busyRef.current = busy;

    const pending = pendingScrollRef.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    pendingScrollRef.current = null;
    viewport.scrollLeft = pending.scrollLeft;
    viewport.scrollTop = pending.scrollTop;
  }, [
    zoomFactor,
    naturalWidth,
    naturalHeight,
    viewportSize.width,
    viewportSize.height,
    busy,
  ]);

  useEffect(() => {
    const attached = viewportRef.current;
    if (!attached) return;
    const viewportNode: HTMLDivElement = attached;

    function onWheel(event: WheelEvent) {
      if (busyRef.current) return;
      if (!isWheelZoomModifier(event)) return;
      event.preventDefault();

      const currentFit = fitRef.current;
      if (!currentFit) return;
      const current = zoomFactorRef.current;
      const next = nextZoomFromWheel(current, event.deltaY);
      if (next === current) return;

      const rect = viewportNode.getBoundingClientRect();
      pendingScrollRef.current = pointerCenteredScroll({
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        pointerXInViewport: event.clientX - rect.left,
        pointerYInViewport: event.clientY - rect.top,
        scrollLeft: viewportNode.scrollLeft,
        scrollTop: viewportNode.scrollTop,
        oldDisplay: displayRef.current,
        newDisplay: zoomedDisplaySize(currentFit, next),
      });
      setZoomFactor(next);
    }

    viewportNode.addEventListener("wheel", onWheel, { passive: false });
    return () => viewportNode.removeEventListener("wheel", onWheel);
  }, []);

  function resetToFit() {
    setZoomFactor(GUIDED_CLEANUP_ZOOM_MIN);
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    // Closing via backdrop never approves; clear any pending preview first.
    if (event.target !== event.currentTarget) return;
    if (pendingConfirmation) onCancelPreview();
    onDone();
  }

  function selectPointFromClient(clientX: number, clientY: number) {
    const target = viewportRef.current?.querySelector(
      "img[data-cleanup-artwork]",
    ) as HTMLImageElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const point = mapClickToImagePoint(
      {
        width: rect.width,
        height: rect.height,
        naturalWidth: target.naturalWidth || naturalWidth,
        naturalHeight: target.naturalHeight || naturalHeight,
      },
      clientX - rect.left,
      clientY - rect.top,
    );
    if (!point) return;
    lastSelectPointRef.current = point;
    onSelectPoint(point, {
      tool: cleanupTool,
      tolerance: clampMagicSelectTolerance(tolerance),
    });
  }

  function changeTool(next: GuidedCleanupTool) {
    if (next === cleanupTool) return;
    if (pendingConfirmation) onCancelPreview();
    lastSelectPointRef.current = null;
    setCleanupTool(next);
  }

  function adjustTolerance(delta: number) {
    const next = clampMagicSelectTolerance(tolerance + delta);
    if (next === tolerance) return;
    setTolerance(next);
    if (
      cleanupTool === "magic_select" &&
      pendingConfirmation &&
      lastSelectPointRef.current
    ) {
      onSelectPoint(lastSelectPointRef.current, {
        tool: "magic_select",
        tolerance: next,
      });
    }
  }

  const hintText = pendingConfirmation
    ? cleanupTool === "magic_select"
      ? GUIDED_CLEANUP_COPY.magicSelectConfirmPrompt
      : GUIDED_CLEANUP_COPY.confirmPrompt
    : cleanupTool === "magic_select"
      ? GUIDED_CLEANUP_COPY.magicSelectHint
      : GUIDED_CLEANUP_COPY.activeHint;

  const confirmLabel =
    cleanupTool === "magic_select"
      ? GUIDED_CLEANUP_COPY.magicSelectConfirmActionLabel
      : GUIDED_CLEANUP_COPY.confirmActionLabel;

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const session = beginGesture(
      {
        pointerType: event.pointerType,
        button: event.button,
        spaceHeld,
        busy,
      },
      { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY },
      { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop },
    );
    if (!session) return;

    panSession.current = session;
    // Middle-button drag otherwise starts the browser's own autoscroll.
    if (event.button === 1) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const session = panSession.current;
    const viewport = viewportRef.current;
    if (!session || session.pointerId !== event.pointerId || !viewport) return;

    const scroll = advanceGesture(
      session,
      { clientX: event.clientX, clientY: event.clientY },
      zoomFactor,
    );
    if (!scroll) return;

    viewport.scrollLeft = scroll.scrollLeft;
    viewport.scrollTop = scroll.scrollTop;
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const session = panSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    panSession.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released.
    }

    if (!shouldSelectOnRelease(session, busy)) return;
    selectPointFromClient(event.clientX, event.clientY);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    if (panSession.current?.pointerId === event.pointerId) {
      panSession.current = null;
    }
  }

  const highlightStyle =
    pendingHighlight && naturalWidth > 0 && naturalHeight > 0
      ? mapImageBoundsToCssPercent(
          pendingHighlight.bounds,
          naturalWidth,
          naturalHeight,
        )
      : null;

  const contentWidth = Math.max(viewportSize.width, display.width);
  const contentHeight = Math.max(viewportSize.height, display.height);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={GUIDED_CLEANUP_COPY.workspaceTitle}
        className="relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/8 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              {GUIDED_CLEANUP_COPY.workspaceTitle}
            </p>
            <p className="mt-0.5 text-xs text-muted">{hintText}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (pendingConfirmation) onCancelPreview();
              onDone();
            }}
            aria-label="Done cleaning up"
            className="shrink-0 rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-muted transition hover:border-ink/30 hover:text-ink"
          >
            {GUIDED_CLEANUP_COPY.exitActionLabel}
          </button>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-black/8 px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label={GUIDED_CLEANUP_COPY.toolGroupLabel}
              data-cleanup-tool={cleanupTool}
            >
              <span className="text-xs font-medium text-ink">
                {GUIDED_CLEANUP_COPY.toolGroupLabel}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-pressed={cleanupTool === "region"}
                onClick={() => changeTool("region")}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  cleanupTool === "region"
                    ? "border-ink bg-ink text-white"
                    : "border-black/10 text-ink enabled:hover:border-ink/30"
                }`}
              >
                {GUIDED_CLEANUP_COPY.selectAreaToolLabel}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-pressed={cleanupTool === "magic_select"}
                onClick={() => changeTool("magic_select")}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  cleanupTool === "magic_select"
                    ? "border-ink bg-ink text-white"
                    : "border-black/10 text-ink enabled:hover:border-ink/30"
                }`}
              >
                {GUIDED_CLEANUP_COPY.magicSelectToolLabel}
              </button>
            </div>

            {cleanupTool === "magic_select" ? (
              <div
                className="flex flex-wrap items-center gap-2"
                data-magic-tolerance={tolerance}
              >
                <span className="text-xs font-medium text-ink">
                  {GUIDED_CLEANUP_COPY.toleranceLabel}
                </span>
                <button
                  type="button"
                  disabled={busy || tolerance <= MAGIC_SELECT_TOLERANCE_MIN}
                  aria-label="Decrease tolerance"
                  onClick={() => adjustTolerance(-MAGIC_SELECT_TOLERANCE_STEP)}
                  className="min-h-9 min-w-9 rounded-full border border-black/10 text-sm font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  −
                </button>
                <span
                  className="min-w-8 text-center text-xs tabular-nums text-ink"
                  aria-live="polite"
                >
                  {tolerance}
                </span>
                <button
                  type="button"
                  disabled={busy || tolerance >= MAGIC_SELECT_TOLERANCE_MAX}
                  aria-label="Increase tolerance"
                  onClick={() => adjustTolerance(MAGIC_SELECT_TOLERANCE_STEP)}
                  className="min-h-9 min-w-9 rounded-full border border-black/10 text-sm font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  +
                </button>
                <span className="text-xs text-muted">
                  {GUIDED_CLEANUP_COPY.toleranceHelp}
                </span>
              </div>
            ) : null}

            <div
              className="flex flex-wrap items-center gap-2"
              role="toolbar"
              aria-label="Artwork zoom"
            >
              <button
                type="button"
                disabled={busy}
                onClick={resetToFit}
                aria-label={GUIDED_CLEANUP_COPY.fitActionLabel}
                className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {GUIDED_CLEANUP_COPY.fitActionLabel}
              </button>
              <button
                type="button"
                disabled={busy || atMinZoom}
                onClick={() => setZoomFactor((current) => nextZoomOut(current))}
                aria-label={GUIDED_CLEANUP_COPY.zoomOutActionLabel}
                className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {GUIDED_CLEANUP_COPY.zoomOutActionLabel}
              </button>
              <button
                type="button"
                disabled={busy || atMaxZoom}
                onClick={() => setZoomFactor((current) => nextZoomIn(current))}
                aria-label={GUIDED_CLEANUP_COPY.zoomInActionLabel}
                className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {GUIDED_CLEANUP_COPY.zoomInActionLabel}
              </button>
              <span
                className="text-xs tabular-nums text-muted"
                data-zoom-percent={zoomPercentLabel(zoomFactor)}
                aria-live="polite"
              >
                {zoomPercentLabel(zoomFactor)}
              </span>
              <span className="text-xs text-muted" data-wheel-zoom-hint>
                {GUIDED_CLEANUP_COPY.wheelZoomHint}
              </span>
              {!atMinZoom ? (
                <span className="text-xs text-muted" data-pan-hint>
                  {GUIDED_CLEANUP_COPY.panHint}
                </span>
              ) : null}
            </div>
          </div>
          <PreviewBackgroundControl
            idPrefix="guided-cleanup-preview-bg"
            value={previewBackground}
            onChange={setPreviewBackground}
            disabled={busy}
          />
        </div>

        <div
          ref={viewportRef}
          data-cleanup-viewport
          data-zoom-factor={clampZoomFactor(zoomFactor)}
          data-wheel-zoom="ctrl-meta"
          data-preview-background={previewBackground}
          data-qa-surface="preview-background"
          className="min-h-[50vh] flex-1 overflow-auto overscroll-contain"
          style={artworkSurfaceStyle}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: contentWidth,
              height: contentHeight,
              minWidth: "100%",
              minHeight: "100%",
            }}
          >
            <div
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-label="Click background to preview removing it"
              aria-disabled={busy}
              data-zoom-display-width={Math.round(display.width)}
              data-zoom-display-height={Math.round(display.height)}
              data-pan-modifier={spaceHeld ? "space" : "none"}
              data-primary-gesture={busy ? "busy" : spaceHeld ? "pan" : "select"}
              className={`relative touch-none outline-none focus-visible:ring-2 focus-visible:ring-ink/40 ${resolveArtworkCursorClassName(
                { busy, spaceHeld },
              )}`}
              style={{
                width: display.width || undefined,
                height: display.height || undefined,
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onKeyDown={(event) => {
                if (busy) return;
                // Enter only. Space is the pan modifier now, and a key cannot
                // mean "pan" and "select the centre" at the same time.
                if (event.key !== "Enter") return;
                event.preventDefault();
                // Keyboard activation inspects the artwork centre — not a
                // substitute for precise pointing, but keeps the control operable.
                const target = event.currentTarget.querySelector(
                  "img[data-cleanup-artwork]",
                ) as HTMLImageElement | null;
                if (!target) return;
                const rect = target.getBoundingClientRect();
                selectPointFromClient(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2,
                );
              }}
            >
              <span
                className="relative block"
                style={{
                  width: display.width || undefined,
                  height: display.height || undefined,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={preparedRevision}
                  data-cleanup-artwork
                  data-prepared-revision={preparedRevision}
                  src={preparedImageUrl}
                  alt="Prepared artwork"
                  draggable={false}
                  className="pointer-events-none block max-w-none select-none"
                  style={{
                    width: display.width || undefined,
                    height: display.height || undefined,
                  }}
                  onLoad={(event) => {
                    setLoadedForUrl({
                      url: preparedImageUrl,
                      revision: preparedRevision,
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                  }}
                />
                {pendingHighlight && highlightStyle ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={pendingHighlight.overlayDataUrl}
                      alt=""
                      aria-hidden
                      className="pointer-events-none absolute"
                      style={highlightStyle}
                    />
                    <span
                      aria-hidden
                      data-candidate-highlight-frame
                      className={candidateHighlightFrameClassName()}
                      style={highlightStyle}
                    />
                  </>
                ) : null}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-3 border-t border-black/8 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {pendingConfirmation ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onConfirm}
                  className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {confirmLabel}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancelPreview}
                  className="rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-muted transition enabled:hover:border-ink/30 enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {GUIDED_CLEANUP_COPY.cancelActionLabel}
                </button>
              </>
            ) : null}

            {!pendingConfirmation && removalCount > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={onUndo}
                className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                {GUIDED_CLEANUP_COPY.undoActionLabel}
              </button>
            ) : null}

            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (pendingConfirmation) onCancelPreview();
                onDone();
              }}
              className="ml-auto rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {GUIDED_CLEANUP_COPY.exitActionLabel}
            </button>
          </div>

          {cleanupMessage ? (
            <p className="text-xs text-ink" role="status">
              {cleanupMessage}
            </p>
          ) : null}
          {pendingConfirmation ? (
            <p className="sr-only" role="status" aria-live="polite">
              {cleanupTool === "magic_select"
                ? GUIDED_CLEANUP_COPY.magicSelectConfirmPrompt
                : GUIDED_CLEANUP_COPY.confirmPrompt}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
