/**
 * Phase 27E — per-project correction session state for the graduated Magic
 * Wand correction workspace. This is the multi-project successor to Phase
 * 27C/27D's single-fixed-asset `lab-state.ts` — the algorithm calls and
 * replay discipline are IDENTICAL, only the scoping (one project per
 * session instead of one hardcoded file) and the source of the base image
 * (the project's CURRENT prepared asset, not a freshly recomputed
 * separation baseline) differ.
 *
 * CRITICAL INVARIANT (Phase 27E §2): the session's "base" image is exactly
 * the bytes of whatever `preparedAssetId` pointed to when the session
 * started — this module never calls `computeRegionMap`/
 * `buildSeparationMaster` or any other automatic-removal logic. Restoring
 * still reads from the immutable original; removing still reads from the
 * evolving current result — nothing here re-derives a removal decision.
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

export interface CorrectionOperationRecord {
  operationId: string;
  algorithmVersion: string;
  clicks: Point[];
  mode: CorrectionAction;
  toleranceLevel: ToleranceLevel;
}

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

export function acceptSessionOperation(
  projectId: string,
  clicks: Point[],
  mode: CorrectionAction,
  toleranceLevel: ToleranceLevel,
): CorrectionOperationRecord {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  const op: CorrectionOperationRecord = {
    operationId: `op-${s.operations.length}-${Date.now()}`,
    algorithmVersion: MAGIC_WAND_ALGORITHM_VERSION,
    clicks,
    mode,
    toleranceLevel,
  };
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

/** Replays every accepted operation, in order, from the session's base image. Never reads a cached mask — recomputed fresh on every call. */
export function computeCurrentResult(projectId: string): RgbaImage {
  const s = sessions.get(projectId);
  if (!s) throw new Error("No active correction session for this project.");
  let current = s.base;
  for (const op of s.operations) {
    const authority = authorityImageFor(op.mode, s.original, current);
    const mask = computeUnionMask(authority, op.clicks, op.toleranceLevel);
    current = applyMagicWandCorrection(current, s.original, mask, op.mode);
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
