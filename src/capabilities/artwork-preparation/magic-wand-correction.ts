/**
 * Phase 27E — per-project correction session state for the graduated Magic
 * Wand correction workspace. This is the multi-project successor to Phase
 * 27C/27D's single-fixed-asset `lab-state.ts` — the algorithm calls and
 * replay discipline are IDENTICAL, only the scoping (one project per
 * session instead of one hardcoded file) and the source of the base image
 * (the project's CURRENT prepared asset, not a freshly recomputed
 * separation baseline) differ.
 *
 * CRITICAL INVARIANT (Phase 27E §2, restored): the session's "base" image is
 * exactly the bytes of whatever `preparedAssetId` pointed to when the
 * session started — falling back to the immutable original only when no
 * prepared asset exists yet (see `ensureCorrectionSession`'s doc comment in
 * `artwork-preparation-capability.ts`, the caller responsible for resolving
 * both images). This module never calls `computeRegionMap`/
 * `buildSeparationMaster` or any other automatic-removal logic itself — it
 * only holds whatever `base` it was given. Restoring still reads from the
 * immutable original; removing still reads from the evolving current
 * result — nothing here re-derives a removal decision.
 *
 * Sessions are held ONLY in server memory, keyed by projectId, and are
 * never persisted to the database. This is deliberate (Phase 27E §10): an
 * unfinished correction must never become authoritative merely by sitting
 * in memory — only `finalizeCorrection` (in the capability layer) writes
 * anything durable. A server restart silently and safely drops all
 * in-progress (not-yet-finalized) corrections, which is the same
 * conservative default `AcceptedOperation` persistence used in the lab.
 */
import {
  applyMagicWandCorrection,
  filterClicksContaining,
  floodFillSelect,
  renderSelectionOverlay,
  unionMasks,
  BROAD_SELECTION_CANVAS_FRACTION,
  DEFAULT_CONNECTIVITY,
  MAGIC_WAND_ALGORITHM_VERSION,
  type CorrectionAction,
  type Point,
  type RgbaImage,
  type ToleranceLevel,
} from "./magic-wand-algorithm";
import {
  BRUSH_ALGORITHM_VERSION,
  computeTransparentComponent,
  isEnclosedComponent,
  rasterizeStroke,
  FILL_ALGORITHM_VERSION,
} from "./correction-tools";

/**
 * Phase 27I: one operation is now one of FOUR tools, not just Magic Wand.
 * `tool` is the discriminant. Existing Magic Wand operations gain an
 * explicit `tool: "magic_wand"` field (previously implicit/only kind) --
 * this is an internal server-side representation only, never accepted
 * as-is from a client, so it carries no backward-compatibility burden.
 */
export interface MagicWandOperationRecord {
  tool: "magic_wand";
  operationId: string;
  algorithmVersion: string;
  clicks: Point[];
  mode: CorrectionAction;
  toleranceLevel: ToleranceLevel;
}
export interface RestoreFillOperationRecord {
  tool: "restore_fill";
  operationId: string;
  algorithmVersion: string;
  click: Point;
}
export interface RestoreBrushOperationRecord {
  tool: "restore_brush";
  operationId: string;
  algorithmVersion: string;
  points: Point[];
  radius: number;
}
export interface EraseBrushOperationRecord {
  tool: "erase_brush";
  operationId: string;
  algorithmVersion: string;
  points: Point[];
  radius: number;
}
export type CorrectionOperationRecord =
  | MagicWandOperationRecord
  | RestoreFillOperationRecord
  | RestoreBrushOperationRecord
  | EraseBrushOperationRecord;

interface CorrectionSession {
  projectId: string;
  original: RgbaImage;
  base: RgbaImage;
  /** The `preparedAssetId` this session's `base` image was loaded from — used to detect a stale/superseded session. */
  baseAssetId: string;
  operations: CorrectionOperationRecord[];
}

const sessions = new Map<string, CorrectionSession>();

/**
 * Returns the existing session for this project if it's still based on the
 * same prepared asset, otherwise starts a fresh one (zero operations) from
 * the given original/base images. Never re-derives `base` itself — the
 * caller (the capability layer) is responsible for downloading exactly the
 * current `preparedAssetId` bytes, unmodified.
 */
export function getOrCreateSession(projectId: string, original: RgbaImage, base: RgbaImage, baseAssetId: string): CorrectionSession {
  const existing = sessions.get(projectId);
  if (existing && existing.baseAssetId === baseAssetId) return existing;
  const fresh: CorrectionSession = { projectId, original, base, baseAssetId, operations: [] };
  sessions.set(projectId, fresh);
  return fresh;
}

export function hasFreshSession(projectId: string, baseAssetId: string): boolean {
  const s = sessions.get(projectId);
  return !!s && s.baseAssetId === baseAssetId;
}

export function getSession(projectId: string): CorrectionSession | null {
  return sessions.get(projectId) ?? null;
}

export function clearSession(projectId: string): void {
  sessions.delete(projectId);
}

export function resetSessionOperations(projectId: string): void {
  const s = sessions.get(projectId);
  if (s) s.operations = [];
}

export function undoLastSessionOperation(projectId: string): void {
  const s = sessions.get(projectId);
  if (s) s.operations.pop();
}

function nextOperationId(s: CorrectionSession): string {
  return `op-${s.operations.length}-${Date.now()}`;
}

export function acceptSessionOperation(
  projectId: string,
  clicks: Point[],
  mode: CorrectionAction,
  toleranceLevel: ToleranceLevel,
): MagicWandOperationRecord {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  const op: MagicWandOperationRecord = {
    tool: "magic_wand",
    operationId: nextOperationId(s),
    algorithmVersion: MAGIC_WAND_ALGORITHM_VERSION,
    clicks,
    mode,
    toleranceLevel,
  };
  s.operations.push(op);
  return op;
}

/**
 * Phase 27I §C — accepts a Restore Fill operation. Re-validates the safety
 * gate here too (not just in the preview the UI already showed) -- "the
 * gate is here, not just in the UI" is this codebase's established pattern
 * for every other server-enforced refusal.
 */
export function acceptFillOperation(projectId: string, click: Point): RestoreFillOperationRecord {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  const current = computeCurrentResult(projectId);
  const component = computeTransparentComponent(current, click, DEFAULT_CONNECTIVITY);
  if (component.pixelCount === 0) {
    throw new Error("There is nothing missing at that point to restore.");
  }
  if (!isEnclosedComponent(component)) {
    throw new Error("This area isn't enclosed. Use the Brush to restore it.");
  }
  const op: RestoreFillOperationRecord = {
    tool: "restore_fill",
    operationId: nextOperationId(s),
    algorithmVersion: FILL_ALGORITHM_VERSION,
    click,
  };
  s.operations.push(op);
  return op;
}

export function acceptBrushOperation(
  projectId: string,
  tool: "restore_brush" | "erase_brush",
  points: Point[],
  radius: number,
): RestoreBrushOperationRecord | EraseBrushOperationRecord {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  if (points.length === 0) throw new Error("A stroke needs at least one point.");
  if (!(radius > 0)) throw new Error("A stroke needs a positive radius.");
  const op = {
    tool,
    operationId: nextOperationId(s),
    algorithmVersion: BRUSH_ALGORITHM_VERSION,
    points,
    radius,
  } as RestoreBrushOperationRecord | EraseBrushOperationRecord;
  s.operations.push(op);
  return op;
}

function authorityImageFor(mode: CorrectionAction, original: RgbaImage, current: RgbaImage): RgbaImage {
  return mode === "restore" ? original : current;
}

function computeUnionMask(authority: RgbaImage, clicks: readonly Point[], toleranceLevel: ToleranceLevel): Uint8Array {
  const masks = clicks.map((click) => floodFillSelect(authority, click, toleranceLevel, DEFAULT_CONNECTIVITY).mask);
  return unionMasks(masks);
}

/**
 * Replays every accepted operation, in order, from the session's base
 * image. Never reads a cached mask — every tool's mask is recomputed fresh
 * on every call, from the CURRENT replayed state at that point plus the
 * immutable original, exactly like Magic Wand already did (Phase 27I §F:
 * "reuse the existing... replay... architecture", not a parallel model).
 *
 * Fill and Brush/Eraser masks are pure functions of, respectively, (current
 * state, click) and (points, radius, dimensions) -- since replay always
 * reaches operation N with the exact same preceding state it had when
 * operation N was first accepted, recomputing here is guaranteed to
 * reproduce the exact same mask, with no need to persist one.
 */
export function computeCurrentResult(projectId: string): RgbaImage {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  let current = s.base;
  for (const op of s.operations) {
    switch (op.tool) {
      case "magic_wand": {
        const authority = authorityImageFor(op.mode, s.original, current);
        const mask = computeUnionMask(authority, op.clicks, op.toleranceLevel);
        current = applyMagicWandCorrection(current, s.original, mask, op.mode);
        break;
      }
      case "restore_fill": {
        const component = computeTransparentComponent(current, op.click, DEFAULT_CONNECTIVITY);
        current = applyMagicWandCorrection(current, s.original, component.mask, "restore");
        break;
      }
      case "restore_brush": {
        const raster = rasterizeStroke(op.points, op.radius, current.width, current.height);
        current = applyMagicWandCorrection(current, s.original, raster.mask, "restore");
        break;
      }
      case "erase_brush": {
        const raster = rasterizeStroke(op.points, op.radius, current.width, current.height);
        current = applyMagicWandCorrection(current, s.original, raster.mask, "remove");
        break;
      }
    }
  }
  return current;
}

export interface SelectionStats {
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  touchesEdge: boolean;
  broad: boolean;
}

export interface PreviewResult {
  selection: SelectionStats;
  overlay: RgbaImage;
  effectiveClicks: Point[];
}

/** Read-only: never mutates the session. Identical selection algorithm to Phase 27C/27D — see `magic-wand-algorithm.ts`. */
export function computeSelectionPreview(
  projectId: string,
  clicks: readonly Point[],
  mode: CorrectionAction,
  toleranceLevel: ToleranceLevel,
  removeAt?: Point,
): PreviewResult {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  const current = computeCurrentResult(projectId);
  const authority = authorityImageFor(mode, s.original, current);

  const effectiveClicks = removeAt
    ? filterClicksContaining(authority, clicks, toleranceLevel, DEFAULT_CONNECTIVITY, removeAt)
    : [...clicks];

  if (effectiveClicks.length === 0) {
    return { selection: { pixelCount: 0, bounds: null, touchesEdge: false, broad: false }, overlay: current, effectiveClicks };
  }

  const masks = effectiveClicks.map((click) => floodFillSelect(authority, click, toleranceLevel, DEFAULT_CONNECTIVITY));
  const unionMask = unionMasks(masks.map((m) => m.mask));

  let pixelCount = 0;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let touchesEdge = false;
  for (let y = 0; y < authority.height; y += 1) {
    for (let x = 0; x < authority.width; x += 1) {
      if (!unionMask[y * authority.width + x]) continue;
      pixelCount += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x === 0 || y === 0 || x === authority.width - 1 || y === authority.height - 1) touchesEdge = true;
    }
  }
  const bounds = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const broad = pixelCount / (authority.width * authority.height) > BROAD_SELECTION_CANVAS_FRACTION;

  const overlay = renderSelectionOverlay(current, unionMask);
  return { selection: { pixelCount, bounds, touchesEdge, broad }, overlay, effectiveClicks };
}

export interface FillPreviewResult {
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  /** True when the clicked transparent component is safe to restore in one click (fully enclosed — see `isEnclosedComponent`). */
  safe: boolean;
  overlay: RgbaImage;
}

/**
 * Phase 27I §C — Restore Fill's read-only preview. Reasons about the
 * CURRENT replayed result's transparency (never the original's colour
 * connectivity, never a cached mask) — see `computeTransparentComponent`'s
 * doc comment for why that distinction is the whole point of this tool.
 * Always returns an overlay (even when refusing) so the UI can show
 * exactly what was found before explaining why it can't be applied.
 */
export function computeFillPreview(projectId: string, click: Point): FillPreviewResult {
  const current = computeCurrentResult(projectId);
  const component = computeTransparentComponent(current, click, DEFAULT_CONNECTIVITY);
  if (component.pixelCount === 0) {
    return { pixelCount: 0, bounds: null, safe: false, overlay: current };
  }
  const overlay = renderSelectionOverlay(current, component.mask);
  return { pixelCount: component.pixelCount, bounds: component.bounds, safe: isEnclosedComponent(component), overlay };
}

export interface BrushPreviewResult {
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  overlay: RgbaImage;
}

/** Phase 27I §D/E — read-only stroke preview, shared by Restore Brush and Eraser (both are pure geometry, independent of tool). */
export function computeBrushPreview(projectId: string, points: readonly Point[], radius: number): BrushPreviewResult {
  const current = computeCurrentResult(projectId);
  const raster = rasterizeStroke(points, radius, current.width, current.height);
  const overlay = raster.pixelCount > 0 ? renderSelectionOverlay(current, raster.mask) : current;
  return { pixelCount: raster.pixelCount, bounds: raster.bounds, overlay };
}
