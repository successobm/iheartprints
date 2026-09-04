"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SignEdge, SignFitToProductionSummary } from "@/capabilities/sign-preparation";
import type { ToleranceLevel } from "@/capabilities/shared/flood-fill-selection";

import { mapDisplayPointToSourcePx, normalizeSelection } from "./correction-coordinate-mapping";
import {
  canApplyCorrectionQueue,
  canShowPixelPreview,
  isClassificationOnlyQueue,
  resolveEffectiveViewMode,
  resolveMainImageSrc,
} from "./sign-correction-preview-view";
import { clampZoom, computeFitZoom } from "./sign-canvas-zoom";
import { resolveSignProductionFitState, SIGN_PRODUCTION_FIT_COPY } from "./sign-production-fit-state";
import { computeDisplayPpi, deriveEdgeChips, deriveOverallFitLabel } from "./sign-workspace-status";

/**
 * Production Workspace Phase / Wand-First Correction UX Phase: this
 * component IS the operator's production workstation. The PRIMARY,
 * default interaction is a wand: click the suspicious artwork, see exactly
 * what got selected, then Delete / Move / Keep — the same click-select-act
 * model DTF's own proven Magic Wand already uses (Section A/F), built on
 * the IDENTICAL flood-fill algorithm (`@/capabilities/shared/flood-fill-
 * selection`, extracted from DTF's own `magic-wand-algorithm.ts` this
 * phase — see that module's own doc for the reuse boundary). The earlier
 * rectangle-drag toolbox (Select/Move/Remove/Edge Artwork/Protected/
 * Review, precise X/Y/W/H) still exists, unchanged in behavior, one click
 * away under "Advanced tools" — never the default, never required for the
 * ordinary case.
 *
 * The operator never needs to think in terms of EDGE_INTENT_ARTWORK,
 * PROTECTED_CONTENT, replace_region_with_background, or pixel coordinates
 * to use the wand: "Delete" means "this shouldn't be here," "Keep" means
 * "this is intentional," and the governed semantics happen underneath
 * (Section B/N). "Delete" is NEVER DTF's alpha-zero transparency — Signs
 * has no meaningful transparent production state; it is a masked,
 * deterministic background replacement restricted to the EXACT selected
 * pixels, gated by the SAME surrounding-context proof the rectangle tool
 * already required (`replace_masked_region_with_background`, Section J/K).
 * "Keep" only ever becomes a governed EDGE_INTENT_ARTWORK classification
 * when the selection's own bounding rectangle is PROVABLY identical to
 * what was actually selected (`rectExact` — Section N); otherwise Keep is
 * refused, with the operator directed to Advanced, rather than risk
 * silently exempting neighboring content the operator never looked at.
 *
 * Coordinate discipline (unchanged): every selection/click is converted via
 * `naturalWidth / canvas.getBoundingClientRect().width` at THAT moment,
 * never a cached scale (`correction-coordinate-mapping.ts`). Zero provider
 * calls anywhere in this file — wand selection is one same-origin server
 * round trip per click (mirroring DTF's own proven request pattern, never
 * per pointer-move), never Topaz, never OpenAI.
 */

type Tool = "select" | "move" | "remove" | "edge_intent" | "protected";
type ClassificationKind = "edge_intent" | "protected";
type InteractionMode = "wand" | "advanced";

interface Rect {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

type PendingCorrection =
  | { kind: "remove"; xPx: number; yPx: number; widthPx: number; heightPx: number; contextDepthPx: number }
  | { kind: "move"; sourceStartYPx: number; heightPx: number; destStartYPx: number }
  | { kind: "classify"; classificationKind: ClassificationKind; edges: SignEdge[]; xPx: number; yPx: number; widthPx: number; heightPx: number }
  | { kind: "wand_delete"; xPx: number; yPx: number; widthPx: number; heightPx: number; maskBase64: string; contextDepthPx: number };

/** Wire shape of `POST .../sign-artwork/wand-select` — mirrors `SignWandSelectionPreview` in `sign-artwork-service.ts` without importing that server-only module client-side (same pattern `PreviewResponse`/`PreviewEdge` below already use for `/correction-preview`). */
interface WandSelectionResponse {
  status: "no_candidate" | "out_of_bounds" | "selected";
  pixelCount: number;
  bounds: Rect | null;
  touchesEdge: boolean;
  broad: boolean;
  rectExact: boolean;
  eligibleForMaskedDelete: boolean;
  touchedCanvasEdges: SignEdge[];
  overlayPngBase64: string | null;
  maskBase64: string | null;
}

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
  /** `false` for a classification-only (or empty) queue — nothing pixel-visible to compare. */
  hasPixelChange: boolean;
  /** Full-canvas corrected candidate, for the main workstation canvas — see `SignCorrectionPreviewResult`'s own doc. `null` whenever `hasPixelChange` is `false`. */
  afterPngBase64: string | null;
  fitToProduction: { edges: PreviewEdge[]; overallResult: "pass" | "fail" | "unknown" } | null;
}

/** Wire shape of `POST .../sign-artwork/safe-area-fit-preview` — mirrors `SignSafeAreaFitPreviewResult` in `sign-artwork-service.ts`, same pattern `PreviewResponse` above already uses. */
interface FitPreviewResponse {
  status: "no_candidate" | "no_area" | "previewed";
  previewPngBase64: string | null;
  fitToProduction: { edges: PreviewEdge[]; overallResult: "pass" | "fail" | "unknown" } | null;
  insetPxX: number | null;
  insetPxY: number | null;
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

const TOLERANCE_LABEL: Record<ToleranceLevel, string> = { less: "Less", default: "Normal", more: "More" };
/** A tap/click that moved less than this many CSS px is a wand click, not a drag/pan gesture. */
const WAND_CLICK_MOVE_TOLERANCE_PX = 6;

/** Same pattern `CorrectionWorkspace.tsx` (DTF's own wand client) already uses — image decode happens as part of the triggering async action, never inside a `useEffect`. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

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

  // Wand-First Correction UX Phase: WAND is the default interaction mode
  // (Section F) — the rectangle-drag toolbox above remains fully intact,
  // reachable via "Advanced tools", never the starting experience.
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("wand");
  const [wandTolerance, setWandTolerance] = useState<ToleranceLevel>("default");
  const [wandSelection, setWandSelection] = useState<WandSelectionResponse | null>(null);
  const [wandSeed, setWandSeed] = useState<{ xPx: number; yPx: number } | null>(null);
  const [wandOverlayImg, setWandOverlayImg] = useState<HTMLImageElement | null>(null);
  const [wandBusy, setWandBusy] = useState(false);
  const [wandError, setWandError] = useState<string | null>(null);
  const [wandMoreOpen, setWandMoreOpen] = useState(false);
  const wandClickStartRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const [queue, setQueue] = useState<PendingCorrection[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  // Signs Workstation Visual Correction UX Phase: distinguishes WHAT is
  // in flight so the canvas loading overlay (Section M) can say something
  // accurate, without adding a second source of truth for "is something
  // happening" — every existing `busy` check below keeps working unchanged
  // against the derived boolean immediately below.
  const [busyKind, setBusyKind] = useState<"preview" | "apply" | "fit-preview" | "fit-apply" | null>(null);
  const busy = busyKind !== null;
  const [error, setError] = useState<string | null>(null);
  // Signs Flat-Raster Production Workflow Correction: the whole-composition
  // "Fit artwork to safe area" preview — a SEPARATE family from the
  // pixel-correction `queue`/`preview` above (Section G: this is the
  // PRIMARY normal action; region corrections are secondary/Advanced).
  // Mutually exclusive with `queue` by construction — see `canOfferFit`.
  const [fitPreview, setFitPreview] = useState<FitPreviewResponse | null>(null);
  // Section E/G: which artwork the MAIN canvas shows. Only ever actually
  // "preview" when a real, pixel-changing preview exists to show — see
  // `canShowPreview`/`effectiveViewMode` below, which force "original"
  // otherwise so this piece of state can never by itself imply a preview
  // that isn't really there.
  const [viewMode, setViewMode] = useState<"original" | "preview">("preview");
  const initialImageLoadRef = useRef(false);

  const setZoom = useCallback((z: number) => setZoomState(clampZoom(z, ZOOM_BOUNDS)), []);

  const displayWidth = naturalSize ? Math.round(naturalSize.width * zoom) : 0;
  const displayHeight = naturalSize ? Math.round(naturalSize.height * zoom) : 0;

  // Signs Flat-Raster Production Workflow Correction: the whole-composition
  // Fit preview, normalized into the SAME shape the pixel-correction
  // `preview` already uses — lets the main canvas reuse the identical,
  // already-tested `canShowPixelPreview`/`resolveEffectiveViewMode`/
  // `resolveMainImageSrc` functions for BOTH preview families, with no
  // changes to those pure functions themselves.
  const normalizedFitPreview =
    fitPreview && fitPreview.status === "previewed" && fitPreview.previewPngBase64
      ? { status: "previewed" as const, appliedCount: 1, hasPixelChange: true, afterPngBase64: fitPreview.previewPngBase64 }
      : null;
  // `queue`/`preview` (region corrections) and `fitPreview` (whole-
  // composition) are mutually exclusive by construction (Section G/O — see
  // `canOfferFit` below); at most one is ever non-null at a time, so
  // precedence between them never actually matters in practice.
  const effectivePreviewForCanvas = preview ?? normalizedFitPreview;

  // The single current source of truth for Fit to Production evidence: the
  // latest queued preview's recheck once one exists, otherwise the plan's
  // last authoritative evidence — the SAME precedence the status bar, the
  // canvas overlay, and the context panel all read, so they never disagree
  // with each other mid-correction.
  const currentEdges: PreviewEdge[] =
    preview?.fitToProduction?.edges ?? fitPreview?.fitToProduction?.edges ?? (fitToProduction.edges as PreviewEdge[]);
  const currentOverallStatus = preview?.fitToProduction
    ? preview.fitToProduction.overallResult
    : fitPreview?.fitToProduction
      ? fitPreview.fitToProduction.overallResult
      : fitToProduction.status;

  // Section E/F/G: the MAIN canvas is the correction preview. There is a
  // real, pixel-changing result to show only when the current preview
  // actually changed pixels (never true for a classification-only queue —
  // Section K) and the server actually returned the full-canvas bytes for
  // it. `effectiveViewMode` is what the canvas and toggle controls
  // ACTUALLY use — it can never claim "preview" when there is nothing real
  // to show, regardless of what `viewMode` itself remembers.
  const canShowPreview = canShowPixelPreview(effectivePreviewForCanvas);
  const effectiveViewMode = resolveEffectiveViewMode(viewMode, effectivePreviewForCanvas);
  const mainImageSrc = resolveMainImageSrc(effectiveViewMode, effectivePreviewForCanvas, candidateUrl);
  const classificationOnlyQueue = isClassificationOnlyQueue(preview, queue.length);
  const canApply = canApplyCorrectionQueue({ busy, queueLength: queue.length, preview });
  // Section G/O: the whole-composition Fit action is the PRIMARY normal
  // path — offered only while no region-correction queue is pending (the
  // two families never run concurrently) and no wand selection is active.
  const canOfferFit = queue.length === 0 && wandSelection === null;
  const fitProductionState = resolveSignProductionFitState(currentEdges);
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

    // Current selection rectangle (Advanced/rectangle-drag mode).
    if (selection) {
      ctx.save();
      ctx.strokeStyle = "rgba(37, 99, 235, 0.95)"; // blue
      ctx.lineWidth = 2;
      ctx.strokeRect(selection.xPx * zoom, selection.yPx * zoom, selection.widthPx * zoom, selection.heightPx * zoom);
      ctx.restore();
    }

    // Wand selection overlay — the REAL selected mask shape (translucent
    // fill + marching-ants boundary), never a bounding-rectangle stand-in
    // (Section H). Cropped to the selection's own bounding rect for
    // transport; drawn here at that exact offset/scale. For a selection too
    // large to safely offer Delete on (`eligibleForMaskedDelete: false` —
    // the server never renders/transports a pixel-accurate overlay for
    // those; see `previewSignWandSelection`'s own doc), fall back to an
    // honest dashed OUTLINE of the real, server-computed bounding box —
    // never a fabricated or silently different shape, and the operator can
    // still see exactly where the selection sits.
    if (wandSelection?.status === "selected" && wandSelection.bounds) {
      const b = wandSelection.bounds;
      if (wandOverlayImg) {
        ctx.drawImage(wandOverlayImg, b.xPx * zoom, b.yPx * zoom, b.widthPx * zoom, b.heightPx * zoom);
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 255, 255, 0.9)"; // cyan, matching the real overlay's own boundary colour
        ctx.setLineDash([8, 5]);
        ctx.lineWidth = 2;
        ctx.strokeRect(b.xPx * zoom, b.yPx * zoom, b.widthPx * zoom, b.heightPx * zoom);
        ctx.restore();
      }
    }
  }, [naturalSize, zoom, selection, currentEdges, wandOverlayImg, wandSelection]);

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
    if (interactionMode === "wand") {
      wandClickStartRef.current = { clientX: e.clientX, clientY: e.clientY };
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }
    const p = toSourcePx(e.clientX, e.clientY);
    if (!p) return;
    draggingRef.current = { startXPx: p.xPx, startYPx: p.yPx };
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (interactionMode === "wand") return; // wand mode is click-only, no drag preview
    if (!draggingRef.current) return;
    const p = toSourcePx(e.clientX, e.clientY);
    if (!p) return;
    const { startXPx, startYPx } = draggingRef.current;
    setSelection(normalizeSelection({ xPx: startXPx, yPx: startYPx }, p));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (interactionMode === "wand") {
      const start = wandClickStartRef.current;
      wandClickStartRef.current = null;
      if (!start) return;
      const movedPx = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY);
      if (movedPx > WAND_CLICK_MOVE_TOLERANCE_PX) return; // a drag/pan gesture, not a click — ignore
      const p = toSourcePx(e.clientX, e.clientY);
      if (!p) return;
      void runWandSelect(p.xPx, p.yPx, wandTolerance);
      return;
    }
    draggingRef.current = null;
    setSelection((current) => (current && current.widthPx > 0 && current.heightPx > 0 ? current : null));
  }

  const selectionValid = selection !== null && selection.widthPx > 0 && selection.heightPx > 0;

  function zoomFit() {
    const vp = viewportRef.current;
    if (!vp || !naturalSize) return;
    setZoom(computeFitZoom(naturalSize, { width: vp.clientWidth, height: vp.clientHeight }, ZOOM_BOUNDS));
  }

  async function runWandSelect(xPx: number, yPx: number, toleranceLevel: ToleranceLevel) {
    setWandBusy(true);
    setWandError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/wand-select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ xPx, yPx, toleranceLevel }),
      });
      const body = (await res.json().catch(() => null)) as WandSelectionResponse | { error?: string } | null;
      if (!res.ok || !body || "error" in body) {
        setWandError((body as { error?: string } | null)?.error ?? "That didn't work. Please try again.");
        setWandBusy(false);
        return;
      }
      const result = body as WandSelectionResponse;
      if (result.status !== "selected") {
        setWandSelection(null);
        setWandSeed(null);
        setWandOverlayImg(null);
        setWandError(
          result.status === "out_of_bounds"
            ? "That point is outside the artwork — click directly on the candidate image."
            : "There's no current production candidate to select from.",
        );
        setWandBusy(false);
        return;
      }
      setWandSelection(result);
      setWandSeed({ xPx, yPx });
      setWandMoreOpen(false);
      if (result.overlayPngBase64) {
        try {
          const img = await loadImage(`data:image/png;base64,${result.overlayPngBase64}`);
          setWandOverlayImg(img);
        } catch {
          setWandOverlayImg(null); // overlay decode failure — selection stats/actions still work, just no visual overlay
        }
      } else {
        setWandOverlayImg(null);
      }
      setWandBusy(false);
    } catch (err) {
      setWandError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setWandBusy(false);
    }
  }

  function changeWandTolerance(level: ToleranceLevel) {
    setWandTolerance(level);
    if (wandSeed) void runWandSelect(wandSeed.xPx, wandSeed.yPx, level);
  }

  function clearWandSelection() {
    setWandSelection(null);
    setWandSeed(null);
    setWandOverlayImg(null);
    setWandError(null);
    setWandMoreOpen(false);
  }

  function queueWandDelete() {
    if (!wandSelection || wandSelection.status !== "selected" || !wandSelection.bounds || !wandSelection.maskBase64) return;
    if (!wandSelection.eligibleForMaskedDelete) return;
    const correction: PendingCorrection = {
      kind: "wand_delete",
      xPx: wandSelection.bounds.xPx, yPx: wandSelection.bounds.yPx,
      widthPx: wandSelection.bounds.widthPx, heightPx: wandSelection.bounds.heightPx,
      maskBase64: wandSelection.maskBase64,
      contextDepthPx: DEFAULT_CONTEXT_DEPTH_PX,
    };
    void runPreview([...queue, correction]);
  }

  /**
   * "Keep" (Section M): governed EDGE_INTENT_ARTWORK/PROTECTED
   * classification from a wand selection. Edges are auto-derived from
   * which canvas boundaries the selection's own bounding rectangle
   * geometrically touches (`touchedCanvasEdges` — never inferred from
   * pixel content) — the operator never checks edge boxes by hand for this
   * path. Only offered (see `WandActionPanel` below) when `rectExact` is
   * true and at least one edge is touched (Section N).
   */
  function queueWandKeep(classificationKind: ClassificationKind) {
    if (!wandSelection || wandSelection.status !== "selected" || !wandSelection.bounds) return;
    if (!wandSelection.rectExact || wandSelection.touchedCanvasEdges.length === 0) return;
    const correction: PendingCorrection = {
      kind: "classify",
      classificationKind,
      edges: wandSelection.touchedCanvasEdges,
      xPx: wandSelection.bounds.xPx, yPx: wandSelection.bounds.yPx,
      widthPx: wandSelection.bounds.widthPx, heightPx: wandSelection.bounds.heightPx,
    };
    void runPreview([...queue, correction]);
  }

  /**
   * "Move" from a wand selection (Section L): arbitrary mask movement would
   * need a new compositor this phase deliberately does not build — Move
   * remains the EXISTING rectangle-band primitive, started here with the
   * wand selection's own bounding rectangle as a precise starting point the
   * operator can still adjust under Advanced tools.
   */
  function startWandMove() {
    if (!wandSelection || wandSelection.status !== "selected" || !wandSelection.bounds) return;
    setSelection({ xPx: wandSelection.bounds.xPx, yPx: wandSelection.bounds.yPx, widthPx: wandSelection.bounds.widthPx, heightPx: wandSelection.bounds.heightPx });
    setTool("move");
    setInteractionMode("advanced");
    clearWandSelection();
  }

  async function runPreview(nextQueue: PendingCorrection[]) {
    setBusyKind("preview");
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
        setBusyKind(null);
        return;
      }
      setPreview(body as PreviewResponse);
      setQueue(nextQueue);
      // Section E: the canvas leads with the just-computed proposed result
      // by default. The operator can still switch to "Show original" at
      // any time — this only decides what a NEW preview lands on.
      setViewMode("preview");
      setBusyKind(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setBusyKind(null);
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
    clearWandSelection();
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

  function cancelSelection() {
    setSelection(null);
    setTool("select");
    setError(null);
  }

  function switchToAdvanced() {
    clearWandSelection();
    setInteractionMode("advanced");
  }

  function switchToWand() {
    setSelection(null);
    setTool("select");
    setInteractionMode("wand");
  }

  async function applyToProduction() {
    if (!canApply) return;
    setBusyKind("apply");
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

      {interactionMode === "advanced" ? (
        // Section O: advanced pixel correction is never the recommended
        // path for ordinary flattened sign artwork — a customer's supplied
        // sign is one composited raster, not separable layers/objects.
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="note" data-sign-advanced-warning>
          Advanced pixel correction — this changes pixels in a flattened image directly and is intended for
          exceptional production cleanup, not everyday use. For ordinary artwork, use Fit artwork to safe area or
          classify edge content instead.
        </p>
      ) : null}

      {/* Tool rail | canvas | context panel */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[152px_minmax(0,1fr)_300px]">
        {interactionMode === "wand" ? (
          <div
            className="flex flex-row items-start gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible"
            role="toolbar"
            aria-label="Correction tools"
            data-sign-tool-rail
            data-sign-interaction-mode="wand"
          >
            <div className="shrink-0 rounded-md border border-ink bg-ink px-2.5 py-1.5 text-left text-sm font-medium text-white" data-testid="sign-tool-wand">
              Wand
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <span className="text-xs font-medium text-ink/60">Tolerance</span>
              <div className="flex gap-1">
                {(["less", "default", "more"] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => changeWandTolerance(level)}
                    aria-pressed={wandTolerance === level}
                    className={`rounded border px-2 py-1 text-xs font-medium transition ${
                      wandTolerance === level ? "border-ink bg-ink text-white" : "border-ink/15 text-ink hover:border-ink/40"
                    }`}
                    data-testid={`sign-wand-tolerance-${level}`}
                  >
                    {TOLERANCE_LABEL[level]}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={switchToAdvanced}
              className="mt-1 shrink-0 text-left text-xs text-ink/60 underline"
              data-testid="sign-switch-to-advanced"
              title="Advanced pixel correction — changes pixels in this flattened image directly and is intended for exceptional production cleanup, not the normal fit/classify workflow."
            >
              Advanced pixel correction →
            </button>
          </div>
        ) : (
          <div
            className="flex flex-row gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible"
            role="toolbar"
            aria-label="Correction tools"
            data-sign-tool-rail
            data-sign-interaction-mode="advanced"
          >
            <button
              type="button"
              onClick={switchToWand}
              className="shrink-0 text-left text-xs text-ink/60 underline"
              data-testid="sign-switch-to-wand"
            >
              ← Back to Wand
            </button>
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
        )}

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

          {/* Section G/H: the comparison control and queued-correction
              notice live directly above the canvas — never buried in the
              sidebar, never the sole way to tell a preview is showing. */}
          <div className="flex flex-wrap items-center gap-3 text-xs" data-sign-correction-canvas-status>
            {canShowPreview ? (
              <div
                className="flex items-center gap-1 rounded-full border border-ink/20 p-0.5"
                role="tablist"
                aria-label="Compare original artwork and proposed correction"
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
            ) : classificationOnlyQueue ? (
              <p className="text-ink/60" data-sign-correction-classification-only>
                Classification only — artwork pixels are unchanged.
              </p>
            ) : null}
            {queue.length > 0 ? (
              <p className="text-ink/60" data-sign-correction-queue-status>
                Previewing {queue.length} pending correction{queue.length === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>

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
                    ? "Proposed result with pending corrections applied"
                    : "Current production candidate — select artwork to correct"
                }
                style={{ width: displayWidth || undefined, height: displayHeight || undefined, display: "block" }}
                data-sign-correction-canvas-mode={effectiveViewMode}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  const natural = { width: el.naturalWidth, height: el.naturalHeight };
                  setNaturalSize(natural);
                  // Auto-fit only the very first time an image loads.
                  // Toggling Original/Preview, or a new preview arriving
                  // after Undo/a new correction, must never yank the
                  // operator's own zoom back to Fit — the same
                  // preserve-the-viewport convention `CorrectionWorkspace.tsx`
                  // (DTF's wand workstation) already documents for a result
                  // refresh.
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
                style={{ position: "absolute", left: 0, top: 0, touchAction: "none", cursor: "crosshair" }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                data-testid="sign-correction-canvas"
              />
              {busyKind === "preview" || busyKind === "fit-preview" ? (
                <div
                  className="absolute inset-0 flex items-center justify-center bg-white/70"
                  role="status"
                  aria-live="polite"
                  data-sign-correction-preview-loading
                >
                  <span className="rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white">
                    {effectivePreviewForCanvas === null ? "Generating preview…" : "Updating preview…"}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted">
            {interactionMode === "wand" ? (
              <>Click directly on the artwork to select it — the exact connected shape, not just a box around it.</>
            ) : (
              <>Drag a rectangle on the canvas, then pick a tool from the rail to act on it.</>
            )}{" "}
            <span className="font-medium text-emerald-700">Dashed guide</span> — where PROTECTED content must stay
            clear of CUT. Not a no-artwork zone: BLEED backgrounds and governed EDGE ARTWORK may cross it or reach
            CUT. Colored bands mark edges that still need attention; the bright tick marks the worst-measured point
            on that edge, not a detected object.
          </p>
        </div>

        <div className="flex flex-col gap-3" data-sign-context-panel>
          {interactionMode === "wand" ? (
            wandBusy && wandSelection?.status !== "selected" ? (
              // Section N: a small, honest, non-blocking "still working"
              // state — never a fake highlight, never freezing the page,
              // and the operator can never reach Delete/Move/Keep (which
              // all require `wandSelection?.status === "selected"`) until
              // the real, authoritative selection has actually arrived.
              <div className="flex items-center gap-2 rounded-lg border border-ink/15 p-3 text-sm text-muted" data-sign-wand-selecting role="status" aria-live="polite">
                <span className="h-3 w-3 animate-pulse rounded-full bg-ink/40" aria-hidden="true" />
                Selecting…
              </div>
            ) : wandSelection?.status === "selected" ? (
              <WandActionPanel
                selection={wandSelection}
                busy={wandBusy || busy}
                moreOpen={wandMoreOpen}
                setMoreOpen={setWandMoreOpen}
                queueDelete={queueWandDelete}
                startMove={startWandMove}
                queueKeep={queueWandKeep}
                clearSelection={clearWandSelection}
              />
            ) : (
              <ProductionFitPanel
                edges={currentEdges}
                fitState={fitProductionState}
                canOfferFit={canOfferFit}
                fitPreview={fitPreview}
                busyKind={busyKind}
                canApplyFit={canApplyFit}
                runFitPreview={runFitPreview}
                cancelFitPreview={cancelFitPreview}
                applyFitToSafeArea={applyFitToSafeArea}
              />
            )
          ) : selectionValid && selection ? (
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
            <ProductionFitPanel
              edges={currentEdges}
              fitState={fitProductionState}
              canOfferFit={canOfferFit}
              fitPreview={fitPreview}
              busyKind={busyKind}
              canApplyFit={canApplyFit}
              runFitPreview={runFitPreview}
              cancelFitPreview={cancelFitPreview}
              applyFitToSafeArea={applyFitToSafeArea}
            />
          )}

          {interactionMode === "wand" && wandError ? (
            <p className="text-sm text-red-600" role="alert" data-sign-wand-error>
              {wandError}
            </p>
          ) : null}

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
              applying={busyKind === "apply"}
              canApply={canApply}
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
 * The right-rail contextual action panel for a WAND selection (Section
 * I/J/M): a small DELETE/MOVE/KEEP bar, never the six competing modes the
 * rectangle toolbox exposes. Delete and Keep are only enabled when the
 * selection actually qualifies (`eligibleForMaskedDelete`/`rectExact` +
 * touching an edge) — disabled with a plain-language reason otherwise,
 * never silently allowed to produce an unsafe correction. "Protected" and
 * "Leave for review" live under MORE (Section O), never competing for
 * primary attention.
 */
function WandActionPanel({
  selection,
  busy,
  moreOpen,
  setMoreOpen,
  queueDelete,
  startMove,
  queueKeep,
  clearSelection,
}: {
  selection: WandSelectionResponse;
  busy: boolean;
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
  queueDelete: () => void;
  startMove: () => void;
  queueKeep: (kind: ClassificationKind) => void;
  clearSelection: () => void;
}) {
  const canKeep = selection.rectExact && selection.touchedCanvasEdges.length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3" data-sign-wand-action-panel>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Selected edge content</h2>
        <button type="button" onClick={clearSelection} className="text-xs text-ink/60 underline" data-testid="sign-wand-clear">
          Clear selection
        </button>
      </div>

      <p className="text-xs text-muted" data-sign-wand-selection-stats>
        {selection.pixelCount.toLocaleString()} px selected
      </p>

      {/* Signs Flat-Raster Production Workflow Correction (Section H): the
          wand's job for ordinary flattened sign artwork is answering "is
          this intentional edge/background artwork, or protected content
          that needs to stay clear of CUT?" — never "you selected an
          object, now move or delete it." These three ARE the normal
          actions. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => queueKeep("edge_intent")}
          disabled={busy || !canKeep}
          title={canKeep ? undefined : "This selection isn't rectangular enough (or doesn't reach an edge) to classify here — try Advanced pixel correction."}
          className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-wand-keep"
        >
          Allow at edge
        </button>
        <button
          type="button"
          onClick={() => queueKeep("protected")}
          disabled={busy || !canKeep}
          title={canKeep ? undefined : "This selection isn't rectangular enough (or doesn't reach an edge) to classify here — try Advanced pixel correction."}
          className="rounded-full border border-ink/20 px-3.5 py-2 text-sm font-medium text-ink transition enabled:hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-wand-protected"
        >
          Keep inside safe area
        </button>
        <button
          type="button"
          onClick={clearSelection}
          className="rounded-full border border-ink/20 px-3.5 py-2 text-sm font-medium text-ink transition hover:border-ink/40"
          data-testid="sign-wand-leave-for-review"
        >
          Review
        </button>
        <button
          type="button"
          onClick={() => setMoreOpen(!moreOpen)}
          aria-expanded={moreOpen}
          className="rounded-full border border-ink/20 px-3.5 py-2 text-sm font-medium text-ink/60 transition hover:border-ink/40"
          data-testid="sign-wand-more"
        >
          Advanced
        </button>
      </div>

      <p className="text-xs text-muted">
        <span className="font-medium">Allow at edge</span> — this is intentional edge/background artwork; Fit to
        Production keeps scanning past it. <span className="font-medium">Keep inside safe area</span> — this is
        protected content that must clear the safe margin.
      </p>

      {moreOpen ? (
        <div className="flex flex-col gap-2 border-t border-ink/10 pt-2">
          <p className="text-xs text-muted">
            Advanced: performs a pixel-region correction on this flattened artwork directly, for exceptional
            production cleanup — not the normal fit/classify workflow.
          </p>
          <button
            type="button"
            onClick={queueDelete}
            disabled={busy || !selection.eligibleForMaskedDelete}
            title={selection.eligibleForMaskedDelete ? undefined : "This selection is too large to safely delete here — try a smaller area, or use Advanced pixel correction."}
            className="rounded-md border border-red-200 px-3 py-1.5 text-left text-sm text-red-700 transition enabled:hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-wand-delete"
          >
            Delete this selection
          </button>
          {!selection.eligibleForMaskedDelete ? (
            <p className="text-xs text-muted">
              This selection is too large for Delete here — try a smaller area, or use Advanced pixel correction.
              Showing its outline only, not the exact shape, to keep this responsive.
            </p>
          ) : null}
          <button
            type="button"
            onClick={startMove}
            disabled={busy}
            className="rounded-md border border-ink/20 px-3 py-1.5 text-left text-sm text-ink transition enabled:hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-wand-move"
          >
            Move this selection
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Signs Flat-Raster Production Workflow Correction (Section E/F/M): the
 * workstation's PRIMARY panel — "Production Fit". Leads with the operator
 * state (Ready as supplied / Protected content needs more clearance / Edge
 * content needs classification — `resolveSignProductionFitState`'s own
 * doc), offers "Fit artwork to safe area" as the ONE normal remedy for a
 * whole flattened composition (never per-object Move/Remove), and — once a
 * preview exists — the SAME Undo/Cancel/Apply shape `PreviewPanel` already
 * uses for region corrections, so the operator experience is consistent
 * across both correction families.
 */
function ProductionFitPanel({
  edges,
  fitState,
  canOfferFit,
  fitPreview,
  busyKind,
  canApplyFit,
  runFitPreview,
  cancelFitPreview,
  applyFitToSafeArea,
}: {
  edges: PreviewEdge[];
  fitState: ReturnType<typeof resolveSignProductionFitState>;
  canOfferFit: boolean;
  fitPreview: FitPreviewResponse | null;
  busyKind: "preview" | "apply" | "fit-preview" | "fit-apply" | null;
  canApplyFit: boolean;
  runFitPreview: () => void;
  cancelFitPreview: () => void;
  applyFitToSafeArea: () => void;
}) {
  const byEdge = new Map(edges.map((e) => [e.edge, e]));
  const copy = SIGN_PRODUCTION_FIT_COPY[fitState];
  const fitBusy = busyKind === "fit-preview" || busyKind === "fit-apply";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3" data-sign-production-fit-panel>
      <div>
        <h2 className="text-sm font-semibold text-ink" data-sign-production-fit-status>
          {copy.status}
        </h2>
        <p className="mt-1 text-sm text-ink">{copy.detail}</p>
      </div>

      {fitState === "fit_adjustment_required" && !fitPreview ? (
        canOfferFit ? (
          <button
            type="button"
            onClick={runFitPreview}
            disabled={fitBusy}
            className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-fit-safe-area-preview"
          >
            {busyKind === "fit-preview" ? "Generating preview…" : "Fit artwork to safe area"}
          </button>
        ) : (
          <p className="text-xs text-muted">
            Cancel your pending region correction(s) below to use Fit artwork to safe area.
          </p>
        )
      ) : null}

      {fitPreview && fitPreview.status === "previewed" ? (
        <div className="flex flex-col gap-3 border-t border-ink/10 pt-3">
          <p className="text-sm text-ink" data-sign-fit-preview-status>
            Previewing the whole composition fit to safe area.
          </p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={cancelFitPreview} disabled={busyKind === "fit-apply"} className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-40" data-testid="sign-fit-safe-area-cancel">
              Cancel
            </button>
          </div>
          <button
            type="button"
            onClick={applyFitToSafeArea}
            disabled={!canApplyFit}
            className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-fit-safe-area-apply"
          >
            {busyKind === "fit-apply" ? "Applying…" : "Apply fit to safe area"}
          </button>
          <p className="text-xs text-muted">
            Applying builds a new production plan from your original artwork and requires re-authorization before it
            can be prepared again — the same as any other production plan change.
          </p>
        </div>
      ) : fitPreview && fitPreview.status === "no_area" ? (
        <p className="text-sm text-red-600" role="alert">
          The safe-area inset would consume the entire canvas — this needs human review, not an automatic fit.
        </p>
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

function PreviewPanel({
  preview,
  undoLast,
  clearAll,
  applyToProduction,
  applying,
  canApply,
}: {
  preview: PreviewResponse;
  undoLast: () => void;
  clearAll: () => void;
  applyToProduction: () => void;
  applying: boolean;
  canApply: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3">
      <p className="text-sm text-ink" data-sign-correction-preview-status>
        {preview.status === "refused"
          ? `Correction ${preview.failingIndex! + 1} was refused: ${preview.failingDetail}`
          : `Preview reflects ${preview.appliedCount} queued correction(s).`}
      </p>

      {/* Secondary navigation aid only (Section G) — the main canvas above
          is the primary way to inspect the result. Never shown for a
          classification-only queue, where before/after would be pixel-
          identical and imply a change that never happened (Section K). */}
      {preview.hasPixelChange && preview.beforeCropPngBase64 && preview.afterCropPngBase64 ? (
        <div className="flex flex-wrap gap-3">
          <div>
            <p className="text-xs font-medium text-ink/60">Before (small)</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool preview crop */}
            <img
              src={`data:image/png;base64,${preview.beforeCropPngBase64}`}
              alt="Before correction"
              className="max-w-[140px] rounded border border-ink/10"
              data-testid="sign-correction-before"
            />
          </div>
          <div>
            <p className="text-xs font-medium text-ink/60">After (small)</p>
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
        <button
          type="button"
          onClick={undoLast}
          disabled={applying}
          className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-correction-undo"
        >
          Undo last
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={applying}
          className="text-sm text-ink/60 underline disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-correction-cancel"
        >
          Cancel all
        </button>
      </div>
      <button
        type="button"
        onClick={applyToProduction}
        disabled={!canApply}
        className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="sign-correction-apply"
      >
        {applying ? "Applying…" : "Apply to production plan"}
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
