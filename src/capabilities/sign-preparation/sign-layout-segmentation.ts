/**
 * Structural Layout Reflow Phase 1 (Foundations): deterministic,
 * source-derived STRUCTURAL REGION segmentation for banner-style rigid
 * sign artwork — the measurement layer a future `reflow_structural_layout`
 * planner/executor pair will consume, exactly like `frame-structure-model
 * .ts` is the measurement layer `reconstruct_parametric_frame` consumes.
 * This module measures only; it never plans, never executes, never
 * touches a pixel of the output, and is not wired into the planner or the
 * executor in this phase.
 *
 * WHAT THIS MEASURES: a full-width, row-by-row scan classifies every row
 * as either affirmatively UNIFORM (a single dominant colour covering the
 * SAME `UNIFORM_MIN_COVERAGE`/`EDGE_BACKGROUND_TOLERANCE` bar
 * `edge-inspection.ts`/`perimeter-reconstruction.ts` already use for a
 * background verdict — no new, unaudited threshold) or CONTENT (anything
 * else: text, numerals, logos, icons, illustrations, meaningful line art —
 * this module never tries to name WHAT the content is, only that it is
 * not a provable flat fill). Consecutive same-classification rows merge
 * into RUNS; consecutive same-colour fill runs merge further. The ordered
 * run sequence becomes structural regions and the gaps between them —
 * see `segmentStructuralLayout`'s own doc for the exact grouping rule.
 *
 * WHY THIS IS SAFE: every fact recorded is either a measured colour
 * (never invented) or a row index (never inferred from anything but the
 * measurement itself). A row this module cannot prove is fill is always
 * treated as content — never assumed to be safely extendable background.
 * Two adjacent fill runs of genuinely different measured colours with no
 * content between them (which color represents "the gap"?) is exactly
 * the sort of thing this module refuses to guess about — see `"ambiguous"`
 * below.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { EDGE_BACKGROUND_TOLERANCE, UNIFORM_MIN_COVERAGE } from "./edge-inspection";
import { measureLine, type SignPerimeterBandRow } from "./perimeter-reconstruction";

export type SignStructuralRegionRole = "top_anchor" | "bottom_anchor" | "middle";

/** A vertical (row) span, in SOURCE image pixel coordinates — full image width, never a 2D rectangle: this phase's segmentation is vertical-axis only (see the module's own doc). */
export interface SignVerticalSpan {
  startYPx: number;
  heightPx: number;
}

/**
 * One structural region. `sourceBounds` is the region's FULL span,
 * including any of its own edge-touching fill (anchors only — see
 * `fillEdgeReaching`); `contentBounds` is always the narrower, purely
 * meaningful sub-span within it. For a `middle` region in V1,
 * `sourceBounds` and `contentBounds` are identical (a middle region owns
 * no fill of its own — any fill flanking it that does not touch an outer
 * canvas edge is recorded as a `SignStructuralGap` instead, never merged
 * into a region).
 */
export interface SignStructuralRegion {
  id: string;
  sourceBounds: SignVerticalSpan;
  contentBounds: SignVerticalSpan;
  role: SignStructuralRegionRole;
  /** This region's own measured, affirmatively uniform fill colour — `null` when the region owns no fill (every `middle` region in V1; an anchor whose own content starts at row 0/height with no separate fill run touching that edge). */
  fillColor: { r: number; g: number; b: number } | null;
  /** True only when `fillColor` is non-null AND that fill run touches the true outer canvas edge (`sourceBounds.startYPx === 0` for `top_anchor`, or the region's bottom edge === image height for `bottom_anchor`) — the ONLY case a fill is authorized to reach the physical cut in a later reflow. */
  fillEdgeReaching: boolean;
  /** Derived, never hardcoded per role: true iff `fillEdgeReaching` — only an edge-reaching fill band may grow; meaningful content is never a candidate for expansion. */
  expandable: boolean;
}

/** One measured gap between two consecutive regions — always a single, affirmatively uniform colour in a `"measured"` result (see `segmentStructuralLayout`'s ambiguity rule). */
export interface SignStructuralGap {
  sourceHeightPx: number;
  fillColor: { r: number; g: number; b: number };
}

export type SignStructuralLayoutSegmentationResult =
  | {
      status: "measured";
      /** Ordered top-to-bottom. Always at least one region in a `"measured"` result. */
      regions: SignStructuralRegion[];
      /** `gaps.length === regions.length - 1`; `gaps[i]` sits between `regions[i]` and `regions[i + 1]`. */
      gaps: SignStructuralGap[];
    }
  /** No content run anywhere — the whole image is one uniform fill (or, degenerately, zero-height). Nothing to segment; a future caller falls through to its existing behaviour, unaffected, exactly like `frame-structure-model.ts`'s own `"not_present"`. */
  | { status: "not_present" }
  /** A genuine ambiguity this module refuses to resolve by guessing — see `reason`. */
  | { status: "ambiguous"; reason: string };

function colorsMatch(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): boolean {
  return (
    Math.abs(a.r - b.r) <= EDGE_BACKGROUND_TOLERANCE &&
    Math.abs(a.g - b.g) <= EDGE_BACKGROUND_TOLERANCE &&
    Math.abs(a.b - b.b) <= EDGE_BACKGROUND_TOLERANCE
  );
}

type RowClassification =
  | { kind: "fill"; color: SignPerimeterBandRow }
  | { kind: "content" };

/** One row's own classification — reuses `measureLine`'s exact membership/coverage measurement across the row's FULL width (x0=0, dx=1, length=image.width), never a narrower sample. */
function classifyRow(image: RgbaImage, y: number): RowClassification {
  const line = measureLine(image, 0, y, 1, 0, image.width);
  if (
    line.dominantColor &&
    line.coverage >= UNIFORM_MIN_COVERAGE &&
    line.transparentFraction === 0
  ) {
    return { kind: "fill", color: line.dominantColor };
  }
  return { kind: "content" };
}

interface RunSegment {
  kind: "fill" | "content";
  startYPx: number;
  heightPx: number;
  /** Only present for `kind: "fill"` — the run's own single measured colour (rows within a run are already guaranteed to share one colour by the merge step below). */
  color: { r: number; g: number; b: number } | null;
}

/** Run-length-encodes the full row classification sequence, merging consecutive same-colour fill rows into one run (consecutive content rows always merge regardless of what specifically makes each non-uniform). */
function runLengthEncode(image: RgbaImage): RunSegment[] {
  const runs: RunSegment[] = [];
  for (let y = 0; y < image.height; y++) {
    const classification = classifyRow(image, y);
    const last = runs[runs.length - 1];
    if (
      last &&
      last.kind === classification.kind &&
      (classification.kind === "content" || (last.color && colorsMatch(last.color, classification.color)))
    ) {
      last.heightPx += 1;
      continue;
    }
    runs.push({
      kind: classification.kind,
      startYPx: y,
      heightPx: 1,
      color: classification.kind === "fill" ? classification.color : null,
    });
  }
  return runs;
}

let regionIdCounter = 0;
function nextRegionId(): string {
  regionIdCounter += 1;
  return `region-${regionIdCounter}`;
}

/**
 * Segments `image` into structural regions and the gaps between them —
 * see the module's own doc for the measurement rule. Deliberately
 * position-based, never wording/content-based: `regions[0]` is always
 * `top_anchor` and the last region is always `bottom_anchor` (identical
 * when there is exactly one region — see below), regardless of whether
 * either happens to own edge-reaching fill. No customer text, layout
 * count, or specific artwork is ever referenced — this runs identically
 * against any banner-shaped source.
 *
 * GROUPING RULE (deliberately the simplest rule that is still correct and
 * fully general, not an attempt to solve every conceivable layout):
 *
 *   - If the FIRST run touches the top edge (`startYPx === 0`) and is a
 *     FILL run, it merges into the first CONTENT run that follows it to
 *     form the `top_anchor` region (`sourceBounds` spans both;
 *     `contentBounds` is the content run alone; `fillEdgeReaching: true`).
 *     If the first run is already CONTENT, that run alone is `top_anchor`
 *     with no fill (`fillColor: null`, `fillEdgeReaching: false`).
 *   - The symmetric rule applies to the LAST run / `bottom_anchor`.
 *   - Every OTHER content run becomes a `middle` region, owning no fill.
 *   - Every OTHER fill run (touching neither outer edge, or sitting
 *     between two content runs) is a `SignStructuralGap` — UNLESS two
 *     fill runs are directly adjacent in the run sequence (only possible
 *     when they measured genuinely different colours, since same-colour
 *     adjacent fill rows already merged) — there is then no single colour
 *     to call "the gap", which is exactly the ambiguity this function
 *     fails closed on.
 */
export function segmentStructuralLayout(image: RgbaImage): SignStructuralLayoutSegmentationResult {
  if (image.width <= 0 || image.height <= 0) return { status: "not_present" };

  const runs = runLengthEncode(image);

  for (let i = 0; i < runs.length - 1; i++) {
    if (runs[i]!.kind === "fill" && runs[i + 1]!.kind === "fill") {
      return {
        status: "ambiguous",
        reason:
          `two directly adjacent fill runs (rows ${runs[i]!.startYPx}-${runs[i]!.startYPx + runs[i]!.heightPx - 1} ` +
          `and ${runs[i + 1]!.startYPx}-${runs[i + 1]!.startYPx + runs[i + 1]!.heightPx - 1}) measured genuinely ` +
          "different colours with no content between them — no single colour can represent this gap.",
      };
    }
  }

  const contentRunIndices = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => run.kind === "content")
    .map(({ index }) => index);

  if (contentRunIndices.length === 0) {
    // Every run is fill (and by the ambiguity check above, all runs
    // collapsed to exactly one, since adjacent differing fills would have
    // already refused) — a solid-colour sign. Nothing to segment.
    return { status: "not_present" };
  }

  const regions: SignStructuralRegion[] = [];
  const gaps: SignStructuralGap[] = [];
  const firstContentIdx = contentRunIndices[0]!;
  const lastContentIdx = contentRunIndices[contentRunIndices.length - 1]!;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.kind === "fill") continue; // handled by whichever adjacent content region owns it, or recorded as a gap below.

    const isFirstContent = i === firstContentIdx;
    const isLastContent = i === lastContentIdx;
    const owningFillBefore = isFirstContent && i > 0 && runs[i - 1]!.kind === "fill" && runs[i - 1]!.startYPx === 0
      ? runs[i - 1]!
      : null;
    const imageBottomYPx = image.height;
    const owningFillAfter =
      isLastContent &&
      i < runs.length - 1 &&
      runs[i + 1]!.kind === "fill" &&
      runs[i + 1]!.startYPx + runs[i + 1]!.heightPx === imageBottomYPx
        ? runs[i + 1]!
        : null;

    const contentBounds: SignVerticalSpan = { startYPx: run.startYPx, heightPx: run.heightPx };
    const owningFill = owningFillBefore ?? owningFillAfter;
    const sourceBounds: SignVerticalSpan = owningFill
      ? {
          startYPx: Math.min(contentBounds.startYPx, owningFill.startYPx),
          heightPx:
            Math.max(
              contentBounds.startYPx + contentBounds.heightPx,
              owningFill.startYPx + owningFill.heightPx,
            ) - Math.min(contentBounds.startYPx, owningFill.startYPx),
        }
      : contentBounds;
    const fillColor = owningFill ? owningFill.color : null;
    const fillEdgeReaching = owningFill !== null;

    const role: SignStructuralRegionRole = isFirstContent ? "top_anchor" : isLastContent ? "bottom_anchor" : "middle";

    regions.push({
      id: nextRegionId(),
      sourceBounds,
      contentBounds,
      role,
      fillColor,
      fillEdgeReaching,
      expandable: fillEdgeReaching,
    });

    // A fill run BEFORE this content run that was NOT absorbed as this
    // region's own edge-reaching fill is a gap before it — provided it
    // wasn't already the previous region's own trailing gap accounting
    // (each fill run is visited exactly once, from whichever content run
    // follows it, so no double-counting).
    if (i > 0 && runs[i - 1]!.kind === "fill" && !owningFillBefore) {
      const gapRun = runs[i - 1]!;
      gaps.push({ sourceHeightPx: gapRun.heightPx, fillColor: gapRun.color! });
    }
  }

  // A trailing fill run after the LAST content run that was not absorbed
  // as `bottom_anchor`'s own edge-reaching fill (e.g. it doesn't touch the
  // bottom edge — content is followed by fill, then something else is
  // structurally impossible after the last content run other than one
  // final fill run, since runs strictly alternate kind).
  const lastRun = runs[runs.length - 1]!;
  if (lastRun.kind === "fill" && lastRun.startYPx > runs[lastContentIdx]!.startYPx) {
    const alreadyOwned = regions[regions.length - 1]!.sourceBounds.startYPx <= lastRun.startYPx &&
      regions[regions.length - 1]!.sourceBounds.startYPx + regions[regions.length - 1]!.sourceBounds.heightPx >=
        lastRun.startYPx + lastRun.heightPx;
    if (!alreadyOwned) {
      gaps.push({ sourceHeightPx: lastRun.heightPx, fillColor: lastRun.color! });
    }
  }

  return { status: "measured", regions, gaps };
}
