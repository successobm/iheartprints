/**
 * Signs Phase 3B (Fit to Production) / Edge-Intent Correction Phase: the
 * universal Signs production-fit capability — CUT / SAFE / BLEED /
 * EDGE_INTENT_ARTWORK / PROTECTED_CONTENT / AMBIGUOUS_REVIEW, made explicit
 * and measured, for the actual prepared candidate (never merely the
 * original upload).
 *
 * Pure, deterministic, no I/O, no provider, no AI — mirrors `edge-
 * inspection.ts`'s own discipline exactly (dominant-colour + Chebyshev
 * tolerance membership, "unknown never becomes safe"), reused rather than
 * reinvented, but at PER-PIXEL depth granularity along each edge instead
 * of one whole-band verdict.
 *
 * THE MODEL (Edge-Intent Correction Phase, Section D):
 *   CUT                 — the ordered physical canvas alone. Not this
 *                          module's concern; it operates ON a canvas whose
 *                          CUT size the caller already knows.
 *   SAFE (0.125in) GUIDE — the required physical inset PROTECTED_CONTENT
 *                          must clear. It is NOT a blanket "no artwork"
 *                          zone — BLEED and (governed) EDGE_INTENT_ARTWORK
 *                          may legitimately exist inside it, or reach CUT.
 *   BLEED_BACKGROUND    — background/colour fields affirmatively proven
 *                          (dominant-colour + tolerance membership) to be
 *                          the SAME flat colour as the true physical edge
 *                          itself — may reach CUT, never blocks.
 *   EDGE_INTENT_ARTWORK — intentional artwork (a decorative border,
 *                          perimeter frame, edge stripe) whose design
 *                          purpose is to exist at or near CUT. NEVER
 *                          inferred from pixels alone — only from an
 *                          explicit, spatially-bounded, operator-governed
 *                          `SignEdgeIntentClassification` the caller
 *                          supplies (`sign-preparation-capability.ts`'s own
 *                          governance, never this module). Pixels inside a
 *                          classified region are exempt from PROTECTED
 *                          clearance measurement — scanning continues PAST
 *                          them to find the actual nearest protected/
 *                          ambiguous content — but the exemption is never
 *                          a bare PASS: `edgeIntentPresent`/
 *                          `edgeIntentAdvisory` still surface it.
 *   PROTECTED_CONTENT   — meaningful content (text, logos, icons, warning
 *                          triangles, customer-identifying artwork) that
 *                          MUST clear the required inset. Anything not
 *                          proven BLEED and not classified EDGE_INTENT
 *                          blocks — whether or not an operator has also
 *                          affirmatively acknowledged it as `"protected"`
 *                          (a `SignEdgeIntentClassification` of that kind
 *                          changes NO scan arithmetic; it only marks
 *                          `unresolvedAmbiguousPresent: false`, an audit
 *                          distinction between "known, acknowledged
 *                          protected content that is simply too close" and
 *                          "content nobody has looked at yet").
 *   AMBIGUOUS_REVIEW    — the DEFAULT state for any non-bleed, non-
 *                          edge-intent content nobody has classified
 *                          `"protected"` — a hole/circle graphic, an
 *                          unknown edge feature. Blocks exactly like
 *                          PROTECTED_CONTENT (this module never silently
 *                          waves it through), and is additionally surfaced
 *                          via `unresolvedAmbiguousPresent: true` so an
 *                          operator UI can say "this still needs a
 *                          decision", not merely "this failed".
 *
 * PER-POSITION, WORST-CASE MEASUREMENT (not a whole-band average): for each
 * position along an edge (one column per x, for top/bottom; one row per y,
 * for left/right), scanning inward from the physical edge classifies each
 * pixel as BLEED (matches the edge's own dominant colour — keep scanning),
 * EDGE_INTENT (inside a classified region for this edge — keep scanning,
 * but record the exemption), or neither (STOP — this position's own
 * protected/ambiguous clearance is this depth). `nearestProtectedContentPx`
 * for the whole edge is the MINIMUM clearance across every position — the
 * single worst point, never an average.
 *
 * Deliberately ONE dominant colour per edge, never a per-position local
 * baseline or a run-length band segmenter, and edge-intent regions are
 * NEVER inferred — both are Section N's own instruction ("a production
 * tool, not perfect semantic segmentation… do not build a new segmentation
 * architecture, a new AI classifier, or an automatic border/grommet
 * detector"). A genuinely multi-coloured edge with NO governing
 * classification still reports the non-dominant colour as a violation at
 * that position — a conservative false alarm, not a false pass.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { SignEdge } from "./contracts";

/** Mirrors `edge-inspection.ts`'s own `EDGE_BACKGROUND_TOLERANCE` exactly — the same audited "genuinely one flat colour" bar, reused for consistency across every Signs deterministic classifier. */
export const FIT_TO_PRODUCTION_TOLERANCE = 12;

/** Below this dominant-colour coverage of the outermost line, no bleed baseline is trusted at all for that edge — `unknown`, never guessed. */
export const FIT_TO_PRODUCTION_MIN_EDGE_DOMINANT_COVERAGE = 0.5;

/**
 * Hard cap on how far inward a single position is scanned — bounds cost.
 * Deliberately deeper than the pre-Edge-Intent-Phase 500px: scanning must
 * now continue PAST a governed edge-intent region to find the actual
 * nearest protected/ambiguous content, which may legitimately sit well
 * beyond the region itself.
 */
const MAX_SCAN_DEPTH_PX = 1000;

/**
 * Edge-Intent Correction Phase: a single governed, spatially-bounded
 * classification this module's caller supplies — never inferred here. Pure
 * geometry + a fixed-vocabulary `kind`, deliberately NOT a free-text
 * override (Section F: "Do not use a free-text override").
 *
 *   `"edge_intent"` — pixels inside `[xPx,yPx,widthPx,heightPx]`, on any
 *     edge named in `edges`, are exempt from PROTECTED clearance
 *     measurement for THOSE edges only (Section G: the exemption is
 *     spatially bounded — an adjacent, unclassified pixel one column over
 *     is never exempt merely because it is near a classified region).
 *   `"protected"` — an explicit operator acknowledgment that content in
 *     this region IS meaningful protected content. Changes no scan
 *     arithmetic (it still blocks if too close) — only marks a resulting
 *     violation there as "acknowledged", not "unresolved ambiguous".
 *
 * The durable, audit-bound version of this record (id, candidate/plan
 * identity, timestamp, operator) lives in `sign-preparation-capability.ts`
 * governance — this module only ever sees the plain geometry + kind at
 * analysis time, the same "caller resolves identity, this module only
 * measures" discipline every function here already follows.
 */
export interface SignEdgeIntentClassification {
  kind: "edge_intent" | "protected";
  /** Which edge(s) this EXACT region's classification applies to — never inferred from proximity. */
  edges: SignEdge[];
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

export interface SignFitToProductionEdgeResult {
  edge: SignEdge;
  requiredProtectedInsetIn: number;
  requiredProtectedInsetPx: number;
  /** The edge's own globally-measured dominant (BLEED_BACKGROUND) colour — `null` only when `protectedResult === "unknown"`. */
  bleedColor: { r: number; g: number; b: number } | null;
  /** Distance (px) from the physical edge to the nearest PROTECTED/AMBIGUOUS (non-bleed, non-edge-intent-exempt) pixel, at the single worst position along the edge — `null` when none was found within `MAX_SCAN_DEPTH_PX`. */
  nearestProtectedContentPx: number | null;
  nearestProtectedContentIn: number | null;
  protectedResult: "pass" | "fail" | "unknown";
  reason: string;
  /**
   * Operator Production Correction UX: the along-edge position (column
   * index for top/bottom, row index for left/right) at which
   * `nearestProtectedContentPx` was measured — WHERE along the edge the
   * worst clearance occurs, never WHAT is there. `null` whenever
   * `nearestProtectedContentPx` is `null`.
   */
  violatingPositionPx: number | null;
  /** True iff at least one `"edge_intent"`-classified region (applicable to this edge) was encountered anywhere along it during the scan. */
  edgeIntentPresent: boolean;
  /** Nearest point (px from the physical edge) any edge-intent-exempt pixel was found at, across the whole edge — `null` when `edgeIntentPresent` is `false`. Informational only. */
  edgeIntentNearestCutPx: number | null;
  /**
   * Non-blocking production advisory: true whenever `edgeIntentPresent` is
   * true — "intentional edge artwork is within the cutting tolerance area
   * and may vary slightly after trimming." Never itself a reason to fail;
   * `protectedResult` alone determines pass/fail.
   */
  edgeIntentAdvisory: boolean;
  /**
   * True when `protectedResult !== "pass"` AND the worst violation's own
   * position was NOT covered by an explicit `"protected"` classification —
   * i.e. genuinely unresolved AMBIGUOUS_REVIEW content nobody has looked
   * at, as distinct from acknowledged PROTECTED_CONTENT that is simply too
   * close. Always `false` when `protectedResult === "pass"`.
   */
  unresolvedAmbiguousPresent: boolean;
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
  const [x, y] = positionAtDepth(image, edge, i, d);
  const idx = (y * image.width + x) * 4;
  return [image.data[idx]!, image.data[idx + 1]!, image.data[idx + 2]!];
}

/** The actual canvas [x,y] at scan-depth `d` from `edge`, at along-edge position `i` — the same coordinate mapping `pixelAtDepth` uses, exposed separately for spatial classification lookups. */
function positionAtDepth(image: RgbaImage, edge: SignEdge, i: number, d: number): [number, number] {
  return edge === "top" ? [i, d]
    : edge === "bottom" ? [i, image.height - 1 - d]
    : edge === "left" ? [d, i]
    : [image.width - 1 - d, i];
}

/** True iff `(x,y)` falls inside a region classified `kind`, applicable to `edge`. Spatially exact — never widened, never inferred from proximity (Section G). */
function isClassified(
  kind: SignEdgeIntentClassification["kind"],
  edge: SignEdge,
  x: number,
  y: number,
  classifications: SignEdgeIntentClassification[],
): boolean {
  for (const c of classifications) {
    if (c.kind !== kind) continue;
    if (!c.edges.includes(edge)) continue;
    if (x >= c.xPx && x < c.xPx + c.widthPx && y >= c.yPx && y < c.yPx + c.heightPx) return true;
  }
  return false;
}

function analyzeEdge(
  image: RgbaImage,
  edge: SignEdge,
  safeInsetIn: number,
  achievedPpi: number,
  classifications: SignEdgeIntentClassification[],
): SignFitToProductionEdgeResult {
  const requiredProtectedInsetPx = signSafeInsetPxForAxis(safeInsetIn, achievedPpi);
  const length = edge === "top" || edge === "bottom" ? image.width : image.height;
  const perpendicular = edge === "top" || edge === "bottom" ? image.height : image.width;
  const maxDepth = Math.min(MAX_SCAN_DEPTH_PX, perpendicular);

  const { color: bleedColor, coverage } = measureOutermostDominantColor(image, edge);
  if (!bleedColor || coverage < FIT_TO_PRODUCTION_MIN_EDGE_DOMINANT_COVERAGE) {
    return {
      edge, requiredProtectedInsetIn: safeInsetIn, requiredProtectedInsetPx,
      bleedColor: null, nearestProtectedContentPx: null, nearestProtectedContentIn: null,
      protectedResult: "unknown", violatingPositionPx: null,
      edgeIntentPresent: false, edgeIntentNearestCutPx: null, edgeIntentAdvisory: false,
      unresolvedAmbiguousPresent: false,
      reason: `No provable bleed colour along this edge (dominant-colour coverage ${coverage.toFixed(3)}, below the ${FIT_TO_PRODUCTION_MIN_EDGE_DOMINANT_COVERAGE} minimum) — unknown never becomes safe.`,
    };
  }

  let worstClearancePx: number | null = null;
  let worstPosition: number | null = null;
  let worstAcknowledgedProtected = false;
  let edgeIntentPresent = false;
  let edgeIntentNearestCutPx: number | null = null;

  for (let i = 0; i < length; i++) {
    let violationDepth: number | null = null;
    for (let d = 0; d < maxDepth; d++) {
      const [r, g, b] = pixelAtDepth(image, edge, i, d);
      if (chebyshev(r, g, b, bleedColor.r, bleedColor.g, bleedColor.b) <= FIT_TO_PRODUCTION_TOLERANCE) {
        continue; // BLEED_BACKGROUND — keep scanning inward.
      }
      const [x, y] = positionAtDepth(image, edge, i, d);
      if (isClassified("edge_intent", edge, x, y, classifications)) {
        edgeIntentPresent = true;
        if (edgeIntentNearestCutPx === null || d < edgeIntentNearestCutPx) edgeIntentNearestCutPx = d;
        continue; // EDGE_INTENT_ARTWORK — exempt, keep scanning inward past it.
      }
      violationDepth = d;
      break; // PROTECTED_CONTENT or AMBIGUOUS_REVIEW — this position's own clearance.
    }
    if (violationDepth !== null && (worstClearancePx === null || violationDepth < worstClearancePx)) {
      worstClearancePx = violationDepth;
      worstPosition = i;
      const [x, y] = positionAtDepth(image, edge, i, violationDepth);
      worstAcknowledgedProtected = isClassified("protected", edge, x, y, classifications);
      if (worstClearancePx === 0) break; // Already the worst possible clearance — no need to scan further.
    }
  }

  const nearestProtectedContentPx = worstClearancePx;
  const nearestProtectedContentIn = nearestProtectedContentPx === null ? null : nearestProtectedContentPx / achievedPpi;
  const violatingPositionPx = nearestProtectedContentPx === null ? null : worstPosition;
  const protectedResult: SignFitToProductionEdgeResult["protectedResult"] =
    nearestProtectedContentPx === null || nearestProtectedContentPx >= requiredProtectedInsetPx ? "pass" : "fail";
  const unresolvedAmbiguousPresent = protectedResult === "fail" && !worstAcknowledgedProtected;
  const edgeIntentAdvisory = edgeIntentPresent;
  const reason =
    nearestProtectedContentPx === null
      ? `Bleed colour rgb(${bleedColor.r},${bleedColor.g},${bleedColor.b}) (and any classified edge-intent artwork) holds for at least ${maxDepth}px inward at every position along this edge — no protected/ambiguous content found within the scanned depth.${edgeIntentPresent ? ` Edge-intent artwork was present, nearest ${edgeIntentNearestCutPx}px from the cut edge.` : ""}`
      : protectedResult === "pass"
        ? `Nearest protected/ambiguous content is ${nearestProtectedContentPx}px (${nearestProtectedContentIn!.toFixed(3)}in) from the cut edge, at or beyond the required ${requiredProtectedInsetPx}px (${safeInsetIn}in) inset.${edgeIntentPresent ? ` Edge-intent artwork was present nearer the edge, nearest ${edgeIntentNearestCutPx}px from the cut edge — excluded from this measurement.` : ""}`
        : `Nearest ${unresolvedAmbiguousPresent ? "unresolved ambiguous" : "acknowledged protected"} content is only ${nearestProtectedContentPx}px (${nearestProtectedContentIn!.toFixed(3)}in) from the cut edge, short of the required ${requiredProtectedInsetPx}px (${safeInsetIn}in) inset.${edgeIntentPresent ? ` Edge-intent artwork was also present, nearest ${edgeIntentNearestCutPx}px from the cut edge — excluded from this measurement.` : ""}`;

  return {
    edge, requiredProtectedInsetIn: safeInsetIn, requiredProtectedInsetPx, bleedColor,
    nearestProtectedContentPx, nearestProtectedContentIn, protectedResult, violatingPositionPx,
    edgeIntentPresent, edgeIntentNearestCutPx, edgeIntentAdvisory, unresolvedAmbiguousPresent, reason,
  };
}

/**
 * The full Fit to Production analysis for one produced candidate image.
 * `orderedWidthIn`/`orderedHeightIn` are the authoritative CUT size (from
 * `SignProductionTemplate`/the confirmed spec — never re-derived from the
 * image); `image.width`/`image.height` are the candidate's own actual
 * pixel dimensions, from which achieved density is honestly computed.
 * `classifications` — governed `SignEdgeIntentClassification[]` the caller
 * resolves and validates against the current candidate/plan identity
 * BEFORE calling this (this module trusts geometry only, never identity —
 * see `SignEdgeIntentClassification`'s own doc). Defaults to `[]` for a
 * candidate with no governed classifications yet.
 */
export function analyzeSignFitToProduction(
  image: RgbaImage,
  orderedWidthIn: number,
  orderedHeightIn: number,
  safeInsetIn: number,
  classifications: SignEdgeIntentClassification[] = [],
): SignFitToProductionResult {
  const achievedPpiX = image.width / orderedWidthIn;
  const achievedPpiY = image.height / orderedHeightIn;
  const edges: SignFitToProductionEdgeResult[] = [
    analyzeEdge(image, "top", safeInsetIn, achievedPpiY, classifications),
    analyzeEdge(image, "right", safeInsetIn, achievedPpiX, classifications),
    analyzeEdge(image, "bottom", safeInsetIn, achievedPpiY, classifications),
    analyzeEdge(image, "left", safeInsetIn, achievedPpiX, classifications),
  ];
  const overallResult: SignFitToProductionResult["overallResult"] = edges.some((e) => e.protectedResult === "fail")
    ? "fail"
    : edges.some((e) => e.protectedResult === "unknown")
      ? "unknown"
      : "pass";
  return { orderedWidthIn, orderedHeightIn, widthPx: image.width, heightPx: image.height, achievedPpiX, achievedPpiY, safeInsetIn, edges, overallResult };
}
