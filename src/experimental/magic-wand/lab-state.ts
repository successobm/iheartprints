/**
 * Phase 27C/27D — EXPERIMENTAL / LOCAL-ONLY server-side state for the
 * magic wand correction lab. Simple in-memory module singleton for ONE
 * fixed real asset. Resets on dev server restart. Never touches a
 * database or production.
 *
 * Persists only raw operator intent — a LIST of click points (Phase 27D
 * additive selection), mode, tolerance level, algorithm version — never a
 * snapped mask. Every read recomputes the mask fresh, exactly like Phase
 * 27C. See `magic-wand.ts` for why this matters.
 *
 * RESTORE vs REMOVE use DIFFERENT selection authority images (unchanged
 * from Phase 27C, see that phase's report §8/§9):
 *  - Restore Missing Artwork: flood-fills against the IMMUTABLE ORIGINAL.
 *  - Remove Background: flood-fills against the CURRENT result (as of
 *    that point in the operation history).
 *
 * Phase 27D adds: an operation now carries a LIST of clicks (additive
 * selection), unioned via `unionMasks` (a pure addition to magic-wand.ts,
 * not a change to `floodFillSelect` itself) before being applied as ONE
 * correction. Subtractive (Alt+click) removal is resolved via
 * `filterClicksContaining` — also a pure addition — during the read-only
 * preview step, never by trusting a client-supplied mask.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

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
} from "./magic-wand";
import { computeRegionMap, buildSeparationMaster } from "@/capabilities/artwork-preparation/region-separation";
import { decodePngUpload } from "@/capabilities/artwork-preparation/image-decode";
import { analyzeArtwork } from "@/capabilities/artwork-preparation/image-analysis";

export interface AcceptedOperation {
  operationId: string;
  algorithmVersion: string;
  clicks: Point[];
  mode: CorrectionAction;
  toleranceLevel: ToleranceLevel;
}

interface LabState {
  original: RgbaImage;
  damaged: RgbaImage;
  operations: AcceptedOperation[];
}

let state: LabState | null = null;

function loadOriginal(): RgbaImage {
  const assetPath = path.resolve(process.cwd(), ".local-lab-assets/incredi-bowls.png");
  const bytes = readFileSync(assetPath);
  const { image } = decodePngUpload(bytes);
  return image;
}

function computeDamagedBaseline(original: RgbaImage): RgbaImage {
  const analysis = analyzeArtwork({
    image: original,
    format: "image/png",
    byteSize: original.data.length,
    declaresAlphaChannel: true,
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
  });
  const computation = computeRegionMap(original, "lab-fixed-asset", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
  return buildSeparationMaster(original, computation, []);
}

export function getLabState(): LabState {
  if (state) return state;
  const original = loadOriginal();
  const damaged = computeDamagedBaseline(original);
  state = { original, damaged, operations: [] };
  return state;
}

function authorityImageFor(mode: CorrectionAction, original: RgbaImage, current: RgbaImage): RgbaImage {
  return mode === "restore" ? original : current;
}

/** Unions the flood-fill selections of every click in one operation against a single authority image. Empty `clicks` is invalid and never reached in practice (validated at the API layer). */
function computeUnionMask(authority: RgbaImage, clicks: readonly Point[], toleranceLevel: ToleranceLevel): Uint8Array {
  const masks = clicks.map((click) => floodFillSelect(authority, click, toleranceLevel, DEFAULT_CONNECTIVITY).mask);
  return unionMasks(masks);
}

/** Recomputes the current authoritative result by replaying every accepted operation, in order, from the immutable original + damaged baseline. Never reads a cached mask. */
export function computeCurrentResult(): RgbaImage {
  const s = getLabState();
  let current = s.damaged;
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

/**
 * Read-only: computes what a candidate (not-yet-accepted) list of clicks
 * would select and render, against the CURRENT authoritative result —
 * never mutates state, never trusts a client-supplied mask.
 *
 * If `removeAt` is provided (Alt/Option+click), any click whose OWN
 * individually recomputed selection contains that pixel is dropped first
 * (Phase 27D subtractive selection) — `effectiveClicks` reports the
 * surviving list so the client's local raw-intent state stays in sync
 * with what the server actually used.
 */
export function computeSelectionPreview(
  clicks: readonly Point[],
  mode: CorrectionAction,
  toleranceLevel: ToleranceLevel,
  removeAt?: Point,
): PreviewResult {
  const s = getLabState();
  const current = computeCurrentResult();
  const authority = authorityImageFor(mode, s.original, current);

  const effectiveClicks = removeAt
    ? filterClicksContaining(authority, clicks, toleranceLevel, DEFAULT_CONNECTIVITY, removeAt)
    : [...clicks];

  if (effectiveClicks.length === 0) {
    return {
      selection: { pixelCount: 0, bounds: null, touchesEdge: false, broad: false },
      overlay: current,
      effectiveClicks,
    };
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

export function acceptOperation(clicks: Point[], mode: CorrectionAction, toleranceLevel: ToleranceLevel): AcceptedOperation {
  const s = getLabState();
  const op: AcceptedOperation = {
    operationId: `op-${s.operations.length}-${Date.now()}`,
    algorithmVersion: MAGIC_WAND_ALGORITHM_VERSION,
    clicks,
    mode,
    toleranceLevel,
  };
  s.operations.push(op);
  return op;
}

export function undoLastOperation(): void {
  const s = getLabState();
  s.operations.pop();
}

export function resetOperations(): void {
  if (state) state.operations = [];
}

export function encodePngResponse(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}
