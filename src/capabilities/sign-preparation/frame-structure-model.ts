/**
 * Signs — Parametric Perimeter Frame Reconstruction Phase (Constitution
 * §16A.3 amendment 3.1's own bounded carve-out, extended within the same
 * admission: "perimeter structure may be reconstructed, but only from the
 * customer's own already-present, measured pixels... only on affirmative
 * deterministic evidence the perimeter pattern is simple and measurable,
 * never a guess... never by inferring a manufacturing specification").
 *
 * `perimeter-reconstruction.ts` answers "are the nearest rows/columns to
 * an edge each independently, affirmatively uniform enough to TILE
 * outward?" — the real cc6cfc4b-... acceptance sign correctly fails that
 * bar: its perimeter is not a repeating stripe, it is a STRUCTURED,
 * concentric BAND SEQUENCE (a coloured stroke, a gap, a second stroke,
 * then a flat fill) with an optional rounded-corner treatment and optional
 * repeated corner-hole indicators. This module measures EXACTLY that
 * structure — never anything else — from source pixels alone, and reports
 * either an affirmative, fully-measured model or "not present"/"ambiguous"
 * (this module never guesses; a caller sees only measured evidence).
 *
 * WHAT THIS MODULE NEVER DOES (Constitution §16A.3's own bounds, restated
 * here because this is the module a future change is most likely to be
 * tempted to weaken):
 *   - never infers a manufacturing specification (hole diameter, drill
 *     inset, corner radius) as anything other than an ARTWORK measurement
 *     — the numbers here describe pixels the customer's own file already
 *     contains, never a production/finishing fact;
 *   - never measures or reasons about anything other than the frame BAND
 *     SEQUENCE, its rounding, and its corner-hole indicators — it has no
 *     opinion about interior content beyond "everything inside the
 *     measured frame depth is protected, unconditionally";
 *   - never resolves a disagreement between corners, or between edges, by
 *     picking one, averaging away a real discrepancy, or lowering a
 *     tolerance to make a specific case pass. A model is either measured
 *     with real, checkable agreement, or reported absent/ambiguous.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { EDGE_BACKGROUND_TOLERANCE } from "./edge-inspection";
import type { SignEdge } from "./contracts";

export interface SignFrameBand {
  color: { r: number; g: number; b: number };
  thicknessPx: number;
}

export interface SignFrameHoleModel {
  ringColor: { r: number; g: number; b: number };
  interiorColor: { r: number; g: number; b: number };
  radiusPx: number;
  /** Centre offset from the TRUE canvas corner, along each axis (never a single diagonal distance — corners need not be symmetric between X and Y). */
  offsetFromCornerXPx: number;
  offsetFromCornerYPx: number;
}

export interface SignFrameStructuralModel {
  /** Outer -> inner, e.g. [outerStroke, gap, innerStroke]. Never includes the fill band — that is `fillColor`/`interior` below. */
  bands: SignFrameBand[];
  /** The flat colour immediately inside the band sequence — what the sign's own background/banner fill is, and what a newly added region (frame band aside) is drawn in. */
  fillColor: { r: number; g: number; b: number };
  /** The colour OUTSIDE the rounded-rect boundary at a true canvas corner (the small curved "background" pocket a rounded corner leaves) — `null` when the frame has no rounding (nothing to measure). */
  outerBackgroundColor: { r: number; g: number; b: number } | null;
  /** Sum of `bands[].thicknessPx` — the total measured frame depth. */
  frameDepthPx: number;
  /** `null` when the frame is square-cornered (no rounding evidenced). */
  cornerRadiusPx: number | null;
  /** `null` when no corner-hole indicator is evidenced (a valid, complete measurement — not every framed sign has one). */
  hole: SignFrameHoleModel | null;
  /** The conservative protected-interior rectangle: canvas inset by `frameDepthPx` on all four sides. */
  interior: { x: number; y: number; width: number; height: number };
  /** The image this model was measured against — every downstream pixel unit is relative to this. */
  sourceWidthPx: number;
  sourceHeightPx: number;
}

export type SignFrameStructuralModelResult =
  | { status: "measured"; model: SignFrameStructuralModel }
  /** No band-sequence structure at all — this module has nothing to say; the caller falls through to its existing (tiling / block) behaviour, unaffected. */
  | { status: "not_present" }
  /** Band-sequence structure IS present, but corner radius or hole evidence disagrees across corners beyond tolerance — never guessed, never averaged away. */
  | { status: "ambiguous"; reason: string };

function chebyshev(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}
function colorsMatch(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tolerance = EDGE_BACKGROUND_TOLERANCE,
): boolean {
  return chebyshev(a.r, a.g, a.b, b.r, b.g, b.b) <= tolerance;
}

function px(image: RgbaImage, x: number, y: number): { r: number; g: number; b: number } {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]! };
}

/** Whole-line dominant colour + coverage, identical bucket/tolerance discipline to `edge-inspection.ts`/`perimeter-reconstruction.ts`. */
function measureLine(
  image: RgbaImage,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  length: number,
): { color: { r: number; g: number; b: number }; coverage: number } {
  const bucketCount = new Map<number, number>();
  const bucketSum = new Map<number, [number, number, number]>();
  const BUCKET_SHIFT = 4;
  for (let k = 0; k < length; k++) {
    const { r, g, b } = px(image, x0 + k * dx, y0 + k * dy);
    const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT);
    bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
    const sums = bucketSum.get(key);
    if (sums) {
      sums[0] += r; sums[1] += g; sums[2] += b;
    } else {
      bucketSum.set(key, [r, g, b]);
    }
  }
  let bestKey = -1, bestN = 0;
  for (const [key, count] of bucketCount) if (count > bestN) { bestN = count; bestKey = key; }
  const sums = bucketSum.get(bestKey)!;
  const color = { r: Math.round(sums[0] / bestN), g: Math.round(sums[1] / bestN), b: Math.round(sums[2] / bestN) };
  let members = 0;
  for (let k = 0; k < length; k++) {
    const p = px(image, x0 + k * dx, y0 + k * dy);
    if (chebyshev(p.r, p.g, p.b, color.r, color.g, color.b) <= EDGE_BACKGROUND_TOLERANCE) members++;
  }
  return { color, coverage: length > 0 ? members / length : 0 };
}

/** A line is admitted as "one flat band row" only at essentially full coverage — mirrors `perimeter-reconstruction.ts`'s own `UNIFORM_MIN_COVERAGE` bar, never a looser one invented for this module. */
const BAND_LINE_MIN_COVERAGE = 0.985;
/** How many consecutive uniform lines of the SAME colour make one confirmed "fill" run. */
const MIN_FILL_RUN_PX = 20;
/** Minimum consecutive uniform lines for a run to count as a genuine structural band (stroke or gap) at all — short enough to admit thin strokes, long enough to reject a one-line fluke. */
const MIN_STROKE_RUN_PX = 3;
/** How many consecutive anti-aliased (just-below-uniform-coverage) lines are tolerated as ordinary blur BETWEEN two solid bands — a real photographic/text edge produces a long run of low coverage, not one or two blurred pixels. */
const MAX_TRANSITION_RUN_PX = 2;
/** Total depth this scan will discard on short (< MIN_STROKE_RUN_PX), high-self-coverage "runs" that are themselves anti-aliasing blends between two real bands (never counted as a band, never as fill) — bounded, so a genuinely unstable/noisy edge still fails outright. */
const MAX_DISCARDED_RUN_DEPTH = 6;
/** Absolute cap on how deep this module ever scans for the band sequence — a genuinely framed sign's band sequence is always a small fraction of the canvas; beyond this, treat as "no coherent sequence" rather than scanning forever. */
const MAX_SCAN_DEPTH_PX = 200;

/**
 * ONE candidate scan of `edge`'s band sequence, using a scan window
 * `[start, start+scanLength)` along the edge's own length. Returns the
 * ordered stroke/gap bands plus whatever colour the scan was sitting on
 * when it stopped — `fillConfident: true` only when that colour held for
 * a genuinely long run (>= `MIN_FILL_RUN_PX`), meaning the scan is
 * confident it reached the sign's own flat fill/background rather than
 * merely running out of clean lines before real content began. A short,
 * unconfident tail is still returned (never discarded) because the STROKE
 * portion itself — the only part cross-edge consistency actually checks —
 * was still genuinely, uniformly measured either way.
 */
function scanBandSequenceWindow(
  image: RgbaImage,
  edge: SignEdge,
  start: number,
  scanLength: number,
  maxDepth: number,
): { bands: SignFrameBand[]; fillColor: { r: number; g: number; b: number }; fillConfident: boolean } | null {
  if (scanLength <= 0 || maxDepth <= 0) return null;

  function lineAt(depth: number): { color: { r: number; g: number; b: number }; coverage: number } {
    switch (edge) {
      case "top":
        return measureLine(image, start, depth, 1, 0, scanLength);
      case "bottom":
        return measureLine(image, start, image.height - 1 - depth, 1, 0, scanLength);
      case "left":
        return measureLine(image, depth, start, 0, 1, scanLength);
      case "right":
        return measureLine(image, image.width - 1 - depth, start, 0, 1, scanLength);
    }
  }

  const bands: SignFrameBand[] = [];
  let depth = 0;
  let currentColor: { r: number; g: number; b: number } | null = null;
  let currentThickness = 0;
  let transitionRun = 0;
  let discardedRunDepth = 0;

  /** Finishes the run in progress: succeeds only when at least one COMPLETED band already exists AND the in-progress run itself reached MIN_STROKE_RUN_PX — a flat, unbanded edge (bands.length === 0) is never this module's shape. */
  function finish(fillConfident: boolean): { bands: SignFrameBand[]; fillColor: { r: number; g: number; b: number }; fillConfident: boolean } | null {
    if (bands.length > 0 && currentColor && currentThickness >= MIN_STROKE_RUN_PX) {
      return { bands, fillColor: currentColor, fillConfident };
    }
    return null;
  }

  while (depth < maxDepth) {
    const { color, coverage } = lineAt(depth);
    if (coverage < BAND_LINE_MIN_COVERAGE) {
      transitionRun++;
      if (transitionRun > MAX_TRANSITION_RUN_PX) {
        // Real content intrusion (not mere anti-aliasing blur) — finish
        // with whatever run was genuinely, uniformly in progress.
        return finish(false);
      }
      depth++;
      continue; // tolerated transition blur — never resets or extends currentThickness.
    }
    transitionRun = 0;
    // A wider tolerance than `BAND_LINE_MIN_COVERAGE`'s own per-line
    // uniformity bar — the OUTERMOST line of a real exported design can
    // measure a slightly different (still fully self-uniform) shade of
    // the SAME stroke than the lines just inside it (export-time
    // anti-aliasing right at the canvas boundary, never a second colour a
    // human would perceive as different) — real cc6cfc4b-... evidence:
    // row 0 measured (18,18,17), rows 1-7 measured pure (0,0,0), both
    // 100% individually uniform. Continuity across depth is judged more
    // loosely than "is this ONE line uniform" on purpose.
    if (currentColor && colorsMatch(color, currentColor, EDGE_BACKGROUND_TOLERANCE * 2)) {
      currentThickness++;
    } else {
      if (currentColor) {
        if (currentThickness < MIN_STROKE_RUN_PX) {
          // The run in progress never reached a real band's minimum
          // length — discard it (never counted as a band, never as fill)
          // rather than failing outright, up to a bounded total budget.
          // Real evidence this is needed: a single transition ROW between
          // two solid bands can itself measure ~99% internally uniform
          // (nearly every pixel across it is a similar antialiased blend)
          // while its average colour matches NEITHER neighbour.
          discardedRunDepth += currentThickness;
          if (discardedRunDepth > MAX_DISCARDED_RUN_DEPTH) return null;
        } else {
          bands.push({ color: currentColor, thicknessPx: currentThickness });
        }
      }
      currentColor = color;
      currentThickness = 1;
      if (bands.length > 4) return null; // not this module's shape.
    }
    depth++;
    if (currentThickness >= MIN_FILL_RUN_PX) {
      if (bands.length === 0) return null; // a flat, unbanded edge — perimeter-reconstruction.ts's tiling covers that shape, not this module.
      return { bands, fillColor: currentColor, fillConfident: true };
    }
  }
  // Ran out of scan depth. Still a success (unconfirmed fill) if at least
  // one real band was found and the final run was itself genuine.
  return finish(false);
}

/**
 * Measures `edge`'s band sequence, trying several candidate scan windows
 * along the edge's own length and returning the first that succeeds —
 * necessary because real sign content is not evenly sparse: a design's
 * TOP/BOTTOM banners are typically clean well past the border, but its
 * LEFT/RIGHT mid-section can be dense with wrapped text almost immediately
 * past the border (the real cc6cfc4b-... acceptance sign is exactly this
 * shape). Preference order: the middle third of the edge (most likely to
 * be genuinely clear of any one corner's local content), then windows
 * anchored near each of the edge's two corners — never a wider or looser
 * uniformity bar, only a DIFFERENT place along the same edge to look for
 * the SAME affirmative evidence.
 */
function measureEdgeBandSequence(
  image: RgbaImage,
  edge: SignEdge,
): { bands: SignFrameBand[]; fillColor: { r: number; g: number; b: number }; fillConfident: boolean } | null {
  const horizontal = edge === "top" || edge === "bottom";
  const edgeLengthPx = horizontal ? image.width : image.height;
  const crossLengthPx = horizontal ? image.height : image.width;
  const maxDepth = Math.min(MAX_SCAN_DEPTH_PX, Math.floor(crossLengthPx / 2) - 1);
  if (maxDepth <= 0 || edgeLengthPx <= 0) return null;

  const shortWindow = Math.max(1, Math.min(100, Math.floor(edgeLengthPx / 4)));
  const candidates: { start: number; scanLength: number }[] = [
    { start: Math.floor(edgeLengthPx / 3), scanLength: Math.floor(edgeLengthPx / 3) },
    { start: Math.round(edgeLengthPx * 0.12), scanLength: shortWindow },
    { start: Math.max(0, edgeLengthPx - Math.round(edgeLengthPx * 0.12) - shortWindow), scanLength: shortWindow },
  ];

  for (const candidate of candidates) {
    const result = scanBandSequenceWindow(image, edge, candidate.start, candidate.scanLength, maxDepth);
    if (result) return result;
  }
  return null;
}

/** True iff two band sequences are the SAME sequence within tolerance (same length, matching colours, thicknesses within a couple of pixels). */
function bandSequencesAgree(a: SignFrameBand[], b: SignFrameBand[]): boolean {
  if (a.length !== b.length) return false;
  // Same widened tolerance as within-edge depth continuity (see its own
  // comment) — a thin stroke's precise average colour is measurably
  // sensitive to exactly which anti-aliased/discarded lines fell on which
  // side of the scan on each independent edge, never a second colour a
  // human would perceive as different.
  return a.every(
    (band, i) =>
      colorsMatch(band.color, b[i]!.color, EDGE_BACKGROUND_TOLERANCE * 2) &&
      Math.abs(band.thicknessPx - b[i]!.thicknessPx) <= 3,
  );
}

function averageBandSequences(sequences: SignFrameBand[][]): SignFrameBand[] {
  const length = sequences[0]!.length;
  const result: SignFrameBand[] = [];
  for (let i = 0; i < length; i++) {
    let r = 0, g = 0, b = 0, thickness = 0;
    for (const seq of sequences) {
      r += seq[i]!.color.r; g += seq[i]!.color.g; b += seq[i]!.color.b; thickness += seq[i]!.thicknessPx;
    }
    result.push({
      color: { r: Math.round(r / sequences.length), g: Math.round(g / sequences.length), b: Math.round(b / sequences.length) },
      thicknessPx: Math.round(thickness / sequences.length),
    });
  }
  return result;
}

/**
 * Walks the diagonal from a TRUE canvas corner inward, and returns the
 * distance at which the OUTER band's own colour first stops holding (the
 * outer edge of the rounded arc) — `null` when the outer band's colour
 * already holds at distance 0 for a good run (a SQUARE corner: the band
 * sequence meets the true corner directly, no rounding).
 */
function measureCornerRadius(
  image: RgbaImage,
  cornerX: number,
  cornerY: number,
  signX: 1 | -1,
  signY: 1 | -1,
  outerBandColor: { r: number; g: number; b: number },
  maxRadius: number,
): number | null {
  // If the true corner pixel itself is already the outer band colour, the
  // frame runs flush into the corner — no rounding to measure.
  if (colorsMatch(px(image, cornerX, cornerY), outerBandColor)) return null;
  for (let d = 1; d <= maxRadius; d++) {
    const x = cornerX + signX * d;
    const y = cornerY + signY * d;
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    if (colorsMatch(px(image, x, y), outerBandColor)) {
      // At diagonal step `d` (corner-local coords (d,d)), the rounded-rect
      // boundary (centred at (R,R), radius R) is crossed when
      // distance-to-centre == R: (R-d)*sqrt(2) == R, i.e.
      // d == R * (1 - 1/sqrt(2)). Solve back for R from the observed `d`.
      return Math.round(d / (1 - 1 / Math.SQRT2));
    }
  }
  return null; // never reached the outer band colour within bounds — treat as unmeasurable, never a guess.
}

/** Depth (px) into a rounded-rect frame whose OUTER boundary is flush with the canvas edges except for `radius`-rounded corners — `null` outside the rounded rect (the true corner-cut background pocket). Shared by hole-anomaly detection here and by the executor's own frame redraw (deliberately duplicated there, never imported, the same independent-resolution discipline every sign-preservation check already follows). */
/**
 * Exported for `sign-transform-executor.ts`'s own frame redraw — the
 * IDENTICAL rounded-rect geometry model measurement and execution must
 * agree on, so this is the one shared, imported copy rather than a
 * duplicated formula (unlike the cross-CAPABILITY duplication discipline
 * `sign-preservation`/`print-validation` follow, planner and executor
 * WITHIN `sign-preparation` already share modules like
 * `perimeter-reconstruction.ts` directly).
 */
export function frameDepthAt(x: number, y: number, w: number, h: number, radius: number): number | null {
  const inCornerX = x < radius ? radius - x : x > w - 1 - radius ? x - (w - 1 - radius) : 0;
  const inCornerY = y < radius ? radius - y : y > h - 1 - radius ? y - (h - 1 - radius) : 0;
  if (inCornerX > 0 && inCornerY > 0) {
    const dist = Math.sqrt(inCornerX * inCornerX + inCornerY * inCornerY);
    return dist > radius ? null : radius - dist;
  }
  return Math.min(x, y, w - 1 - x, h - 1 - y);
}

export function bandColorAtDepth(
  depth: number | null,
  bands: SignFrameBand[],
  fillColor: { r: number; g: number; b: number },
  outerBackgroundColor: { r: number; g: number; b: number } | null,
): { r: number; g: number; b: number } {
  if (depth === null) return outerBackgroundColor ?? fillColor;
  let acc = 0;
  for (const band of bands) {
    if (depth < acc + band.thicknessPx) return band.color;
    acc += band.thicknessPx;
  }
  return fillColor;
}

const HOLE_SEARCH_MARGIN = 45;
const HOLE_ANOMALY_TOLERANCE = EDGE_BACKGROUND_TOLERANCE * 2;

/**
 * Looks for a compact, roughly-circular ANOMALY near ONE corner — pixels
 * whose actual colour disagrees with what the pure measured frame model
 * (band sequence + corner radius, no hole) would predict there. A
 * mounting-hole/corner indicator is exactly this: a local deviation from
 * the frame's own otherwise-uniform band territory. Deliberately NOT a
 * raw same-colour flood fill: a hole whose interior colour happens to
 * equal the surrounding gap band's own colour (the real cc6cfc4b-...
 * shape) would flood-fill straight through the ring into the whole
 * gap — comparing against the MODEL's own expected colour at each pixel,
 * not against a same-colour neighbourhood, is what keeps the anomaly
 * confined to the ring itself regardless of what colour its interior
 * happens to share with its surroundings. Restricted to a small window
 * (frame depth + search margin) so it can never mistake broad interior
 * content for a hole. Returns `null` when no such compact structure is
 * found (a valid "this corner has no hole" answer, not a failure).
 */
function findHoleNearCorner(
  image: RgbaImage,
  cornerX: number,
  cornerY: number,
  signX: 1 | -1,
  signY: 1 | -1,
  frameDepthPx: number,
  bands: SignFrameBand[],
  fillColor: { r: number; g: number; b: number },
  outerBackgroundColor: { r: number; g: number; b: number } | null,
  cornerRadiusPx: number | null,
): { ringColor: { r: number; g: number; b: number }; interiorColor: { r: number; g: number; b: number }; radiusPx: number; centerXPx: number; centerYPx: number } | null {
  const win = frameDepthPx + HOLE_SEARCH_MARGIN;
  // Inclusive [x0, x1] / [y0, y1] window anchored EXACTLY on the true
  // corner pixel on the corner's own side, extending `win` px inward.
  const x0 = signX === 1 ? cornerX : Math.max(0, cornerX - win + 1);
  const x1 = signX === 1 ? Math.min(image.width - 1, cornerX + win - 1) : cornerX;
  const y0 = signY === 1 ? cornerY : Math.max(0, cornerY - win + 1);
  const y1 = signY === 1 ? Math.min(image.height - 1, cornerY + win - 1) : cornerY;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return null;
  const radius = cornerRadiusPx ?? 0;

  function expectedColorAt(x: number, y: number): { r: number; g: number; b: number } {
    const depth = frameDepthAt(x, y, image.width, image.height, radius);
    return bandColorAtDepth(depth, bands, fillColor, outerBackgroundColor);
  }
  function isAnomalous(x: number, y: number): boolean {
    const actual = px(image, x, y);
    const expected = expectedColorAt(x, y);
    return chebyshev(actual.r, actual.g, actual.b, expected.r, expected.g, expected.b) > HOLE_ANOMALY_TOLERANCE;
  }

  const visited = new Uint8Array(w * h);
  let best: { x0: number; y0: number; x1: number; y1: number; count: number } | null = null;

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      if (visited[sy * w + sx]) continue;
      if (!isAnomalous(x0 + sx, y0 + sy)) { visited[sy * w + sx] = 1; continue; }
      const stack: [number, number][] = [[sx, sy]];
      visited[sy * w + sx] = 1;
      let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy, count = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        count++;
        bx0 = Math.min(bx0, cx); bx1 = Math.max(bx1, cx);
        by0 = Math.min(by0, cy); by1 = Math.max(by1, cy);
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || visited[ny * w + nx]) continue;
          visited[ny * w + nx] = 1;
          if (isAnomalous(x0 + nx, y0 + ny)) stack.push([nx, ny]);
        }
      }
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      // A hole's RING anomaly: small, roughly square bbox (a ring's own
      // bounding box is square even though the ring itself is hollow),
      // fully enclosed by the window (never touching its border — a real
      // interior anomaly region, e.g. actual content, typically does).
      if (count < 6 || bw > frameDepthPx * 2 || bh > frameDepthPx * 2 || Math.abs(bw - bh) > Math.max(2, Math.round(0.3 * Math.max(bw, bh)))) continue;
      if (bx0 === 0 || by0 === 0 || bx1 === w - 1 || by1 === h - 1) continue;
      if (!best || count > best.count) best = { x0: bx0, y0: by0, x1: bx1, y1: by1, count };
    }
  }
  if (!best) return null;

  const radiusPx = Math.round(Math.max(best.x1 - best.x0, best.y1 - best.y0) / 2);
  const centerXPx = x0 + (best.x0 + best.x1) / 2;
  const centerYPx = y0 + (best.y0 + best.y1) / 2;
  // The anomalous BLOB itself may be only the interior (a ring drawn in
  // whatever colour the pure frame model already expected there, so the
  // ring itself never registers as anomalous — the real cc6cfc4b-...
  // shape) or only the ring (an interior that happens to match the local
  // expected colour). Sample the CENTRE (candidate interior) and a point
  // just OUTSIDE the blob's own radius (candidate ring) — never a point
  // still inside the blob, which would just resample the interior again.
  const interiorColor = px(image, Math.round(centerXPx), Math.round(centerYPx));
  // The ring itself is not independently re-sampled from nearby pixels —
  // a fixed search offset is fragile against exactly how far the true
  // ring extends and what sits just beyond it (the real cc6cfc4b-...
  // sign's hole sits close enough to its own red banner fill that a
  // naive "sample just outside the blob" search can land on the fill
  // instead of the ring). Constitution §16A.3's own admission already
  // establishes the assumption this module relies on instead: a
  // mounting-hole indicator is drawn in the SAME ink as the frame's own
  // stroke — so the ring colour is simply the frame's own already
  // independently measured innermost stroke colour, never re-derived
  // from a single fragile pixel sample. Only the geometry (radius,
  // centre offset) and the INTERIOR colour come from this blob search.
  const ringColor = bands[bands.length - 1]!.color;
  if (colorsMatch(ringColor, interiorColor)) return null; // no real ring/interior contrast — a coincidental anomaly, not a hole.

  return { ringColor, interiorColor, radiusPx, centerXPx, centerYPx };
}

const HOLE_RADIUS_TOLERANCE_PX = 4;
const HOLE_OFFSET_TOLERANCE_PX = 6;
const CORNER_RADIUS_TOLERANCE_PX = 6;

/**
 * Height/Redistribution Policy: how much genuinely CLEAN (affirmatively
 * uniform, per-line) space exists past the frame's own measured band
 * depth on `edge`, before real content intrudes — the "breathing room" a
 * neutral, deterministic redistribution rule can measure without asking
 * an operator to type a number. Scans the SAME middle-third window
 * `measureEdgeBandSequence` itself prefers (deliberately away from
 * corners). Returns 0 (never negative, never a guess) when content
 * begins immediately past the frame — a fully valid, meaningful answer,
 * not a failure.
 */
export function measureCleanFillRunPx(image: RgbaImage, edge: SignEdge, frameDepthPx: number): number {
  const horizontal = edge === "top" || edge === "bottom";
  const edgeLengthPx = horizontal ? image.width : image.height;
  const crossLengthPx = horizontal ? image.height : image.width;
  const start = Math.floor(edgeLengthPx / 3);
  const scanLength = Math.floor(edgeLengthPx / 3);
  const maxDepth = Math.min(MAX_SCAN_DEPTH_PX * 2, crossLengthPx - frameDepthPx - 1);
  if (scanLength <= 0 || maxDepth <= 0) return 0;

  function lineAt(depth: number): { coverage: number } {
    switch (edge) {
      case "top":
        return measureLine(image, start, depth, 1, 0, scanLength);
      case "bottom":
        return measureLine(image, start, image.height - 1 - depth, 1, 0, scanLength);
      case "left":
        return measureLine(image, depth, start, 0, 1, scanLength);
      case "right":
        return measureLine(image, image.width - 1 - depth, start, 0, 1, scanLength);
    }
  }

  let run = 0;
  for (let d = frameDepthPx; d < frameDepthPx + maxDepth; d++) {
    if (lineAt(d).coverage < BAND_LINE_MIN_COVERAGE) break;
    run++;
  }
  return run;
}

/**
 * Measures the full frame structural model from `image` alone. Pure,
 * deterministic, replayable from the immutable source at any time — never
 * persisted itself (the PLAN persists the measured numbers it used, the
 * same discipline `perimeterBands` already follows).
 */
export function measureFrameStructuralModel(image: RgbaImage): SignFrameStructuralModelResult {
  const edges: SignEdge[] = ["top", "right", "bottom", "left"];
  const sequences: { edge: SignEdge; bands: SignFrameBand[]; fillColor: { r: number; g: number; b: number }; fillConfident: boolean }[] = [];
  for (const edge of edges) {
    const measured = measureEdgeBandSequence(image, edge);
    if (!measured) return { status: "not_present" };
    sequences.push({ edge, ...measured });
  }
  const [first, ...rest] = sequences;
  for (const seq of rest) {
    if (!bandSequencesAgree(first!.bands, seq.bands)) {
      return {
        status: "ambiguous",
        reason: `The "${first!.edge}" and "${seq.edge}" edges show different band sequences — a frame's band structure must agree on all four sides.`,
      };
    }
  }
  // `fillColor` is deliberately NOT required to agree across all four
  // edges — a real design's immediate fill past the border can genuinely
  // differ by side (e.g. a top/bottom banner colour vs. a plain body
  // colour along the left/right mid-section); only the STROKE sequence
  // itself (the actual frame geometry) needs cross-edge agreement. Prefer
  // whichever edge measured its fill with a long, CONFIDENT run; fall
  // back to the first edge's own (still measured, never invented) colour
  // when none reached that confidence.
  const confident = sequences.find((s) => s.fillConfident);
  const fillColor = (confident ?? first!).fillColor;
  const bands = averageBandSequences(sequences.map((s) => s.bands));
  const frameDepthPx = bands.reduce((sum, b) => sum + b.thicknessPx, 0);

  const outerBandColor = bands[0]!.color;
  const corners: { x: number; y: number; sx: 1 | -1; sy: 1 | -1 }[] = [
    { x: 0, y: 0, sx: 1, sy: 1 },
    { x: image.width - 1, y: 0, sx: -1, sy: 1 },
    { x: 0, y: image.height - 1, sx: 1, sy: -1 },
    { x: image.width - 1, y: image.height - 1, sx: -1, sy: -1 },
  ];
  const maxRadius = Math.min(MAX_SCAN_DEPTH_PX, Math.floor(Math.min(image.width, image.height) / 2));
  const radii: (number | null)[] = corners.map((c) => measureCornerRadius(image, c.x, c.y, c.sx, c.sy, outerBandColor, maxRadius));

  let cornerRadiusPx: number | null;
  const measuredRadii = radii.filter((r): r is number => r !== null);
  if (measuredRadii.length === 0) {
    cornerRadiusPx = null; // square-cornered frame — a valid, complete answer.
  } else if (measuredRadii.length !== 4) {
    return {
      status: "ambiguous",
      reason: "Some corners show a rounded frame treatment and others do not — corner rounding must be consistent on all four corners.",
    };
  } else {
    const avg = measuredRadii.reduce((s, r) => s + r, 0) / measuredRadii.length;
    if (measuredRadii.some((r) => Math.abs(r - avg) > CORNER_RADIUS_TOLERANCE_PX)) {
      return {
        status: "ambiguous",
        reason: `Measured corner radii disagree beyond tolerance (${measuredRadii.join(", ")}px) — corner rounding must be consistent.`,
      };
    }
    cornerRadiusPx = Math.round(avg);
  }

  let outerBackgroundColor: { r: number; g: number; b: number } | null = null;
  if (cornerRadiusPx !== null) {
    outerBackgroundColor = px(image, 0, 0);
  }

  const holes = corners.map((c) =>
    findHoleNearCorner(image, c.x, c.y, c.sx, c.sy, frameDepthPx, bands, fillColor, outerBackgroundColor, cornerRadiusPx),
  );
  const foundHoles = holes.filter((h): h is NonNullable<(typeof holes)[number]> => h !== null);
  let hole: SignFrameHoleModel | null = null;
  if (foundHoles.length === 0) {
    hole = null; // no corner-hole indicator anywhere — a valid, complete answer.
  } else if (foundHoles.length !== 4) {
    return {
      status: "ambiguous",
      reason: `A corner-hole indicator was found at ${foundHoles.length} of 4 corners, not all four — a partial/ambiguous corner-hole pattern is never reconstructed.`,
    };
  } else {
    const avgRadius = foundHoles.reduce((s, h) => s + h.radiusPx, 0) / 4;
    if (foundHoles.some((h) => Math.abs(h.radiusPx - avgRadius) > HOLE_RADIUS_TOLERANCE_PX)) {
      return { status: "ambiguous", reason: "Corner-hole indicators disagree on radius beyond tolerance across the four corners." };
    }
    const offsets = corners.map((c, i) => ({
      x: Math.abs(foundHoles[i]!.centerXPx - c.x),
      y: Math.abs(foundHoles[i]!.centerYPx - c.y),
    }));
    const avgOffsetX = offsets.reduce((s, o) => s + o.x, 0) / 4;
    const avgOffsetY = offsets.reduce((s, o) => s + o.y, 0) / 4;
    if (offsets.some((o) => Math.abs(o.x - avgOffsetX) > HOLE_OFFSET_TOLERANCE_PX || Math.abs(o.y - avgOffsetY) > HOLE_OFFSET_TOLERANCE_PX)) {
      return { status: "ambiguous", reason: "Corner-hole indicators disagree on their offset from the corner beyond tolerance across the four corners." };
    }
    const ringR = Math.round(foundHoles.reduce((s, h) => s + h.ringColor.r, 0) / 4);
    const ringG = Math.round(foundHoles.reduce((s, h) => s + h.ringColor.g, 0) / 4);
    const ringB = Math.round(foundHoles.reduce((s, h) => s + h.ringColor.b, 0) / 4);
    const intR = Math.round(foundHoles.reduce((s, h) => s + h.interiorColor.r, 0) / 4);
    const intG = Math.round(foundHoles.reduce((s, h) => s + h.interiorColor.g, 0) / 4);
    const intB = Math.round(foundHoles.reduce((s, h) => s + h.interiorColor.b, 0) / 4);
    hole = {
      ringColor: { r: ringR, g: ringG, b: ringB },
      interiorColor: { r: intR, g: intG, b: intB },
      radiusPx: Math.round(avgRadius),
      offsetFromCornerXPx: Math.round(avgOffsetX),
      offsetFromCornerYPx: Math.round(avgOffsetY),
    };
  }

  const interior = {
    x: frameDepthPx,
    y: frameDepthPx,
    width: image.width - 2 * frameDepthPx,
    height: image.height - 2 * frameDepthPx,
  };
  if (interior.width <= 0 || interior.height <= 0) {
    return { status: "ambiguous", reason: "The measured frame depth leaves no positive-area protected interior — refusing rather than reconstructing over the whole canvas." };
  }

  return {
    status: "measured",
    model: {
      bands,
      fillColor,
      outerBackgroundColor,
      frameDepthPx,
      cornerRadiusPx,
      hole,
      interior,
      sourceWidthPx: image.width,
      sourceHeightPx: image.height,
    },
  };
}
