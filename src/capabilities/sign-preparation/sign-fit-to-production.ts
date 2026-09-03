/**
 * Signs Phase 3B (Fit to Production): the missing universal Signs
 * production-fit capability — CUT / SAFE / BLEED / PROTECTED, made
 * explicit and measured, for the actual prepared candidate (never merely
 * the original upload).
 *
 * Pure, deterministic, no I/O, no provider, no AI — mirrors `edge-
 * inspection.ts`'s own discipline exactly (dominant-colour + Chebyshev
 * tolerance membership, "unknown never becomes safe"), reused rather than
 * reinvented, but at PER-PIXEL depth granularity along each edge instead
 * of one whole-band verdict: `edge-inspection.ts` answers "may an
 * extension along this edge be automatic?"; this module answers "how
 * close does non-bleed content actually get to the physical cut edge, at
 * the single worst point along it?" — a different, finer question the
 * SAFE-inset gate needs.
 *
 * THE MODEL (Section D-G of the governing task):
 *   CUT       — the ordered physical canvas alone (`SignProductionTemplate`
 *               — never a pixel of artwork). Not this module's concern;
 *               this module operates ON a canvas whose CUT size the caller
 *               already knows.
 *   SAFE      — a fixed physical inset (`safeInsetIn`) from every CUT edge.
 *               Converted to pixels HERE, at analysis time, from the
 *               candidate's own achieved density — never stored as a bare
 *               pixel count anywhere upstream.
 *   BLEED     — background/colour fields affirmatively proven (dominant-
 *               colour + tolerance membership, exactly `edge-inspection
 *               .ts`'s own bar) to be the SAME flat colour as the true
 *               physical edge itself — permitted to reach CUT.
 *   PROTECTED / AMBIGUOUS — anything that is NOT proven BLEED. This module
 *               deliberately does not attempt to tell "genuinely meaningful
 *               content" apart from "an ambiguous decorative artifact" —
 *               that distinction is an OPERATOR judgment (Section E/H of
 *               the governing task); this module's own job is narrower and
 *               fail-closed: prove bleed affirmatively, or block. A hole
 *               graphic and a warning-triangle icon are treated identically
 *               here — both are "not proven bleed," both block SAFE — the
 *               operator decides, from the flagged evidence, whether to
 *               remove one (`replace_region_with_background`) or leave the
 *               composition as-is because the other is genuinely protected.
 *
 * PER-POSITION, WORST-CASE MEASUREMENT (not a whole-band average): for each
 * position along an edge (one column per x, for top/bottom; one row per y,
 * for left/right), the edge-adjacent pixel itself must match the edge's own
 * ONE globally-measured dominant colour, and scanning inward from it must
 * stay within tolerance for at least `requiredSafeInsetPx` — otherwise that
 * position's own clearance is short. `nearestNonBleedPx` for the whole edge
 * is the MINIMUM clearance across every position — the single worst point,
 * never an average — because a safety margin that most of an edge respects
 * is not "safe" if even one place (a corner hole, a stray mark) violates it.
 *
 * Deliberately ONE dominant colour per edge, never a per-position local
 * baseline or a run-length band segmenter — Section E's own instruction
 * ("a production tool, not perfect semantic segmentation… do not build a
 * new segmentation architecture"). The direct consequence: a genuinely
 * multi-coloured edge (e.g. a red band directly above a white content
 * field, both legitimately reaching the SAME left/right cut edge) reports
 * whichever colour is NOT dominant as a SAFE-inset violation at that
 * position — a conservative false alarm, not a false pass, and exactly
 * the fail-closed behaviour Section E asks for ("ambiguous content must
 * not silently receive bleed permission"). An operator reviewing that
 * finding sees a real, correctly-bounded rectangle to judge; nothing here
 * ever silently waves a second background colour through.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { SignEdge } from "./contracts";

/** Mirrors `edge-inspection.ts`'s own `EDGE_BACKGROUND_TOLERANCE` exactly — the same audited "genuinely one flat colour" bar, reused for consistency across every Signs deterministic classifier. */
export const FIT_TO_PRODUCTION_TOLERANCE = 12;

/** Below this dominant-colour coverage of the outermost line, no bleed baseline is trusted at all for that edge — `unknown`, never guessed. */
export const FIT_TO_PRODUCTION_MIN_EDGE_DOMINANT_COVERAGE = 0.5;

/** Hard cap on how far inward a single position is scanned — bounds cost; comfortably deep for any real sign's own safe-inset margins. */
const MAX_SCAN_DEPTH_PX = 500;

export interface SignFitToProductionEdgeResult {
  edge: SignEdge;
  requiredSafeInsetIn: number;
  requiredSafeInsetPx: number;
  /** The edge's own globally-measured dominant colour — `null` only when `result === "unknown"`. */
  bleedColor: { r: number; g: number; b: number } | null;
  /** Distance (px) from the physical edge to the nearest non-bleed pixel, at the single worst position along the edge — `null` when no violation was found within `MAX_SCAN_DEPTH_PX`. */
  nearestNonBleedPx: number | null;
  nearestNonBleedIn: number | null;
  result: "pass" | "fail" | "unknown";
  reason: string;
  /**
   * Operator Production Correction UX: the along-edge position (column
   * index for top/bottom, row index for left/right) at which
   * `nearestNonBleedPx` was measured — i.e. WHERE along the edge the worst
   * clearance occurs, never WHAT is there (this module still proves no
   * object identity — see the module doc). `null` whenever `nearestNonBleedPx`
   * is `null` (pass-by-absence, or `unknown`). Exists solely so an operator
   * UI can point a highlight at the actionable region of an edge instead of
   * the edge's entire length — actionable production evidence, not
   * semantic segmentation.
   */
  violatingPositionPx: number | null;
}

export interface SignFitToProductionResult {
  orderedWidthIn: number;
  orderedHeightIn: number;
  widthPx: number;
  heightPx: number;
  achievedPpiX: number;
  achievedPpiY: number;
  safeInsetIn: number;
  edges: SignFitToProductionEdgeResult[];
  overallResult: "pass" | "fail" | "unknown";
}

function chebyshev(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}

/**
 * Physical inset (inches) -> pixels, for ONE axis, at the candidate's own
 * ACTUAL achieved density — never a fixed/assumed PPI. Rounds UP: the
 * minimum physical safe inset must never shrink because of pixel rounding.
 */
export function signSafeInsetPxForAxis(safeInsetIn: number, achievedPpi: number): number {
  if (!Number.isFinite(safeInsetIn) || safeInsetIn <= 0 || !Number.isFinite(achievedPpi) || achievedPpi <= 0) {
    return 0;
  }
  return Math.ceil(safeInsetIn * achievedPpi);
}

/** Dominant colour + its coverage fraction of the outermost line for one edge, mirroring `edge-inspection.ts`'s own bucket-vote technique. */
function measureOutermostDominantColor(
  image: RgbaImage,
  edge: SignEdge,
): { color: { r: number; g: number; b: number } | null; coverage: number } {
  const length = edge === "top" || edge === "bottom" ? image.width : image.height;
  const BUCKET_SHIFT = 4;
  const bucketCount = new Map<number, number>();
  const bucketSum = new Map<number, [number, number, number]>();
  for (let k = 0; k < length; k++) {
    const [x, y] =
      edge === "top" ? [k, 0]
      : edge === "bottom" ? [k, image.height - 1]
      : edge === "left" ? [0, k]
      : [image.width - 1, k];
    const i = (y * image.width + x) * 4;
    const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!;
    const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT);
    bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
    const sums = bucketSum.get(key);
    if (sums) { sums[0] += r; sums[1] += g; sums[2] += b; } else bucketSum.set(key, [r, g, b]);
  }
  let dominantKey: number | null = null;
  let dominantN = 0;
  for (const [key, count] of bucketCount) {
    if (count > dominantN) { dominantN = count; dominantKey = key; }
  }
  if (dominantKey === null || length === 0) return { color: null, coverage: 0 };
  const sums = bucketSum.get(dominantKey)!;
  return {
    color: { r: Math.round(sums[0] / dominantN), g: Math.round(sums[1] / dominantN), b: Math.round(sums[2] / dominantN) },
    coverage: dominantN / length,
  };
}

/** Reads the pixel at scan-depth `d` from `edge`, at along-edge position `i`. */
function pixelAtDepth(image: RgbaImage, edge: SignEdge, i: number, d: number): [number, number, number] {
  const [x, y] =
    edge === "top" ? [i, d]
    : edge === "bottom" ? [i, image.height - 1 - d]
    : edge === "left" ? [d, i]
    : [image.width - 1 - d, i];
  const idx = (y * image.width + x) * 4;
  return [image.data[idx]!, image.data[idx + 1]!, image.data[idx + 2]!];
}

function analyzeEdge(
  image: RgbaImage,
  edge: SignEdge,
  safeInsetIn: number,
  achievedPpi: number,
): SignFitToProductionEdgeResult {
  const requiredSafeInsetPx = signSafeInsetPxForAxis(safeInsetIn, achievedPpi);
  const length = edge === "top" || edge === "bottom" ? image.width : image.height;
  const perpendicular = edge === "top" || edge === "bottom" ? image.height : image.width;
  const maxDepth = Math.min(MAX_SCAN_DEPTH_PX, perpendicular);

  const { color: bleedColor, coverage } = measureOutermostDominantColor(image, edge);
  if (!bleedColor || coverage < FIT_TO_PRODUCTION_MIN_EDGE_DOMINANT_COVERAGE) {
    return {
      edge, requiredSafeInsetIn: safeInsetIn, requiredSafeInsetPx,
      bleedColor: null, nearestNonBleedPx: null, nearestNonBleedIn: null,
      result: "unknown", violatingPositionPx: null,
      reason: `No provable bleed colour along this edge (dominant-colour coverage ${coverage.toFixed(3)}, below the ${FIT_TO_PRODUCTION_MIN_EDGE_DOMINANT_COVERAGE} minimum) — unknown never becomes safe.`,
    };
  }

  let worstClearancePx: number | null = null;
  let worstPosition: number | null = null;
  for (let i = 0; i < length; i++) {
    const [r0, g0, b0] = pixelAtDepth(image, edge, i, 0);
    if (chebyshev(r0, g0, b0, bleedColor.r, bleedColor.g, bleedColor.b) > FIT_TO_PRODUCTION_TOLERANCE) {
      worstClearancePx = 0;
      worstPosition = i;
      break; // Already the worst possible clearance — no need to scan further.
    }
    let clearance: number | null = null;
    for (let d = 1; d < maxDepth; d++) {
      const [r, g, b] = pixelAtDepth(image, edge, i, d);
      if (chebyshev(r, g, b, bleedColor.r, bleedColor.g, bleedColor.b) > FIT_TO_PRODUCTION_TOLERANCE) {
        clearance = d;
        break;
      }
    }
    if (clearance !== null && (worstClearancePx === null || clearance < worstClearancePx)) {
      worstClearancePx = clearance;
      worstPosition = i;
      if (worstClearancePx === 0) break;
    }
  }

  const nearestNonBleedPx = worstClearancePx;
  const nearestNonBleedIn = nearestNonBleedPx === null ? null : nearestNonBleedPx / achievedPpi;
  const violatingPositionPx = nearestNonBleedPx === null ? null : worstPosition;
  const result: SignFitToProductionEdgeResult["result"] =
    nearestNonBleedPx === null || nearestNonBleedPx >= requiredSafeInsetPx ? "pass" : "fail";
  const reason =
    nearestNonBleedPx === null
      ? `Bleed colour rgb(${bleedColor.r},${bleedColor.g},${bleedColor.b}) holds uniformly for at least ${maxDepth}px inward at every position along this edge — no non-bleed content found within the scanned depth.`
      : result === "pass"
        ? `Nearest non-bleed content is ${nearestNonBleedPx}px (${nearestNonBleedIn!.toFixed(3)}in) from the cut edge, at or beyond the required ${requiredSafeInsetPx}px (${safeInsetIn}in) safe inset.`
        : `Nearest non-bleed content is only ${nearestNonBleedPx}px (${nearestNonBleedIn!.toFixed(3)}in) from the cut edge, short of the required ${requiredSafeInsetPx}px (${safeInsetIn}in) safe inset.`;

  return { edge, requiredSafeInsetIn: safeInsetIn, requiredSafeInsetPx, bleedColor, nearestNonBleedPx, nearestNonBleedIn, violatingPositionPx, result, reason };
}

/**
 * The full Fit to Production analysis for one produced candidate image.
 * `orderedWidthIn`/`orderedHeightIn` are the authoritative CUT size (from
 * `SignProductionTemplate`/the confirmed spec — never re-derived from the
 * image); `image.width`/`image.height` are the candidate's own actual
 * pixel dimensions, from which achieved density is honestly computed.
 */
export function analyzeSignFitToProduction(
  image: RgbaImage,
  orderedWidthIn: number,
  orderedHeightIn: number,
  safeInsetIn: number,
): SignFitToProductionResult {
  const achievedPpiX = image.width / orderedWidthIn;
  const achievedPpiY = image.height / orderedHeightIn;
  const edges: SignFitToProductionEdgeResult[] = [
    analyzeEdge(image, "top", safeInsetIn, achievedPpiY),
    analyzeEdge(image, "right", safeInsetIn, achievedPpiX),
    analyzeEdge(image, "bottom", safeInsetIn, achievedPpiY),
    analyzeEdge(image, "left", safeInsetIn, achievedPpiX),
  ];
  const overallResult: SignFitToProductionResult["overallResult"] = edges.some((e) => e.result === "fail")
    ? "fail"
    : edges.some((e) => e.result === "unknown")
      ? "unknown"
      : "pass";
  return { orderedWidthIn, orderedHeightIn, widthPx: image.width, heightPx: image.height, achievedPpiX, achievedPpiY, safeInsetIn, edges, overallResult };
}
