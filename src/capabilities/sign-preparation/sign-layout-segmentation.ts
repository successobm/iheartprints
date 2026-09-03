/**
 * Structural Layout Reflow Phase 1 (Foundations), extended by Phase 2C
 * (Frame-Interior-Aware Segmentation): deterministic, source-derived
 * STRUCTURAL REGION segmentation for banner-style rigid sign artwork —
 * the measurement layer a future `reflow_structural_layout`
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
 * PHASE 2C — ANALYSIS WINDOW: `segmentStructuralLayout` optionally accepts
 * a `SignStructuralAnalysisWindow`, a rectangular sub-region of the source
 * image to analyze INSTEAD OF the full image. This exists for exactly one
 * reason: a sign surrounded by a continuous decorative frame (measured by
 * `frame-structure-model.ts`) has NO full-width row anywhere that is
 * uniform — the frame's own left/right bands intrude on every row — so
 * unwindowed segmentation on such a sign always collapses to one
 * undifferentiated region (the real cc6cfc4b-... acceptance sign's own
 * measured behaviour). Restricting the row scan to the frame's own
 * measured `interior` lets the SAME deterministic algorithm see the
 * banner structure that exists WITHIN the frame, without the frame's own
 * bands ever being reclassified, removed, or reasoned about here.
 *
 * CRITICAL INVARIANT — THE FRAME MAY DEFINE AN ANALYSIS WINDOW; THE FRAME
 * MAY NEVER DEFINE THE PRODUCTION TEMPLATE. Nothing in this module reads
 * `cornerRadiusPx`, band colours/thicknesses, or hole geometry — only the
 * plain `{x, y, width, height}` rectangle `resolveFrameAnalysisWindow`
 * itself independently re-validates (never trusting `frame-structure-
 * model.ts`'s own internal guarantees blindly). `SignProductionTemplate`
 * (`sign-production-template.ts`) remains derived ONLY from the ordered
 * production spec + policy, exactly as before — this module cannot reach
 * it, has no reference to it, and never will.
 *
 * ALL EMITTED COORDINATES ARE SOURCE-IMAGE-ABSOLUTE. Analysis may scan
 * only a windowed sub-region, but every `sourceBounds`/`contentBounds`
 * this module returns is expressed in the SAME coordinate space as the
 * full source image — never window-relative — so no downstream consumer
 * (the planner, a future executor) ever needs to know a window was used
 * to correctly interpret a region's own position. This is achieved by
 * scanning using ABSOLUTE image y-coordinates from the very first row
 * (`domain.y` through `domain.y + domain.height`) rather than scanning
 * window-locally and translating afterward — there is no separate offset
 * step that could be forgotten.
 *
 * WHY THIS IS SAFE: every fact recorded is either a measured colour
 * (never invented) or a row index (never inferred from anything but the
 * measurement itself). A row this module cannot prove is fill is always
 * treated as content — never assumed to be safely extendable background.
 * Two adjacent fill runs of genuinely different measured colours with no
 * content between them (which color represents "the gap"?) is exactly
 * the sort of thing this module refuses to guess about — see `"ambiguous"`
 * below. An analysis window that is missing, invalid, out of bounds, too
 * small, or measured against a different image is never trusted — see
 * `resolveFrameAnalysisWindow`'s own doc — segmentation silently falls
 * back to the full, already-proven-safe image scan rather than guessing
 * at a window, or refusing to segment at all.
 *
 * STRUCTURAL ROLES ARE NOT SUBSTRATE SEMANTICS. `top_anchor`/`middle`/
 * `bottom_anchor` mean "first/ordered-middle/last structural region
 * WITHIN THE ANALYZED COMPOSITION" — never "touches the physical
 * production cut edge." That is equally true with or without an analysis
 * window: even the unwindowed (full-image) case never claimed a region
 * touching y=0 was drawn there BECAUSE it is the finished substrate edge
 * — only that it is the first region THIS scan measured. A future
 * planner/executor decides how these structural facts relate to the
 * ordered production template; this module has no opinion.
 *
 * PHASE 2D — BOUNDED TRANSITION RUNS: two directly adjacent fill runs of
 * genuinely different measured colours are, by default, exactly the
 * ambiguity described above. Before that check runs, a short candidate
 * fill run may be reclassified as TRANSITION EVIDENCE (an anti-aliased
 * blend row, not independent structure) and folded into a neighbouring
 * run — but ONLY when both (a) it is bounded in height
 * (`MAX_TRANSITION_RUN_HEIGHT_PX`) AND (b) its own measured colour is
 * affirmatively explained by a neighbouring run's colour (close to one
 * substantial neighbour, or a genuine channel-wise blend between two) —
 * see `decideTransitionAbsorption`'s own doc. Shortness ALONE is never
 * sufficient: a deliberate thin stripe, separator, or accent line whose
 * colour is not so explained is left exactly as measured, and remains
 * its own run — including remaining part of a genuine ambiguity when it
 * sits directly against another fill run. This module deliberately does
 * NOT reuse `frame-structure-model.ts`'s `MAX_TRANSITION_RUN_PX` /
 * `MIN_STROKE_RUN_PX` — those bound consecutive LOW-COVERAGE (internally
 * non-uniform, blurry) scan lines within one edge-band depth scan, a
 * different measurement entirely from a row that IS individually
 * confidently uniform (this module's own `classifyRow` already requires
 * that) but differs in colour from its neighbour. Reclassifying a run as
 * transition evidence changes ONLY this module's structural topology —
 * it never touches, deletes, or reinterprets a single source pixel; the
 * original bytes remain fully authoritative for any future preservation
 * or executor layer.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { EDGE_BACKGROUND_TOLERANCE, UNIFORM_MIN_COVERAGE } from "./edge-inspection";
import { measureLine, type SignPerimeterBandRow } from "./perimeter-reconstruction";
import type { SignFrameStructuralModelResult } from "./frame-structure-model";

export type SignStructuralRegionRole = "top_anchor" | "bottom_anchor" | "middle";

/** A vertical (row) span, in SOURCE image pixel coordinates — full analysis-domain width, never a 2D rectangle: this module's segmentation is vertical-axis only (see the module's own doc). */
export interface SignVerticalSpan {
  startYPx: number;
  heightPx: number;
}

/**
 * Phase 2C: a deterministic rectangular sub-region of the SOURCE image
 * `segmentStructuralLayout` may analyze instead of the full image — in
 * SOURCE-image pixel coordinates (never window-relative). See
 * `resolveFrameAnalysisWindow` for the only currently-supported way to
 * derive one (from measured frame evidence); a caller could in principle
 * construct one directly, but every field is independently re-validated
 * by `segmentStructuralLayout` itself regardless of origin.
 */
export interface SignStructuralAnalysisWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One structural region. `sourceBounds` is the region's FULL span,
 * including any of its own edge-touching fill (anchors only — see
 * `fillEdgeReaching`); `contentBounds` is always the narrower, purely
 * meaningful sub-span within it. For a `middle` region in V1,
 * `sourceBounds` and `contentBounds` are identical (a middle region owns
 * no fill of its own — any fill flanking it that does not touch an outer
 * analysis-domain edge is recorded as a `SignStructuralGap` instead,
 * never merged into a region). Always in SOURCE-image-absolute pixel
 * coordinates, regardless of whether a windowed analysis was used.
 */
export interface SignStructuralRegion {
  id: string;
  sourceBounds: SignVerticalSpan;
  contentBounds: SignVerticalSpan;
  role: SignStructuralRegionRole;
  /** This region's own measured, affirmatively uniform fill colour — `null` when the region owns no fill (every `middle` region in V1; an anchor whose own content starts at the analysis domain's own edge with no separate fill run touching that edge). */
  fillColor: { r: number; g: number; b: number } | null;
  /**
   * True only when `fillColor` is non-null AND that fill run touches the
   * outer edge of the ANALYSIS DOMAIN — the full source image when no
   * `analysisWindow` was used, or the window's own top/bottom boundary
   * when one was (`SignStructuralLayoutSegmentationResult.analysisWindow`
   * records which, for exactly this reason). NEVER a claim that this fill
   * reaches — or is safe to extend to — the PHYSICAL PRODUCTION CUT EDGE:
   * when a window was used, the analysis domain's own edge sits INSIDE
   * the true source canvas (typically still under a frame's own measured
   * band depth), with real pixels the executor must still account for
   * lying beyond it. This field means exactly what it always has —
   * "reaches the edge of what was analyzed" — the physical-cut-edge
   * decision remains entirely a later planner/executor responsibility
   * that this module has no ability to make.
   */
  fillEdgeReaching: boolean;
  /** Derived, never hardcoded per role: true iff `fillEdgeReaching` — only an edge-reaching fill band may grow; meaningful content is never a candidate for expansion. */
  expandable: boolean;
}

/** One measured gap between two consecutive regions — always a single, affirmatively uniform colour in a `"measured"` result (see `segmentStructuralLayout`'s ambiguity rule). Source-image-absolute, like everything else this module returns. */
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
      /**
       * Phase 2C: the analysis domain actually used — `null` when the full
       * source image was analyzed (every pre-Phase-2C caller's own exact
       * behaviour), or the validated window otherwise. Always present (as
       * `null` or a value) so a consumer never has to guess whether
       * `fillEdgeReaching`/`sourceBounds` boundary coordinates relate to
       * the true source canvas or to a sub-window — read this field to
       * know which, precisely.
       */
      analysisWindow: SignStructuralAnalysisWindow | null;
    }
  /** No content run anywhere — the whole analysis domain is one uniform fill (or, degenerately, zero-height). Nothing to segment; a future caller falls through to its existing behaviour, unaffected, exactly like `frame-structure-model.ts`'s own `"not_present"`. */
  | { status: "not_present" }
  /** A genuine ambiguity this module refuses to resolve by guessing — see `reason`. */
  | { status: "ambiguous"; reason: string };

/** `tolerance` defaults to `EDGE_BACKGROUND_TOLERANCE` — every pre-Phase-2D caller passing no third argument gets byte-identical behaviour to before. */
function colorsMatch(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tolerance: number = EDGE_BACKGROUND_TOLERANCE,
): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

/** Chebyshev (max-channel) colour distance — the same per-channel metric `colorsMatch` already thresholds, used here only for a deterministic closer-neighbour tie-break, never as a new matching rule. */
function colorDistanceChebyshev(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/**
 * True iff `candidate` lies, on every channel independently, within the
 * range spanned by `a` and `b` (plus `EDGE_BACKGROUND_TOLERANCE` slack per
 * channel for ordinary measurement noise) — a genuine channel-wise blend
 * between the two, not merely "close to one of them" (that case is
 * handled separately by `colorsMatch`). A colour outside that span on any
 * channel is never a blend of `a` and `b`, however close it happens to be
 * to either one alone.
 */
function isChannelwiseBetween(
  candidate: { r: number; g: number; b: number },
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): boolean {
  const slack = EDGE_BACKGROUND_TOLERANCE;
  const channels: Array<"r" | "g" | "b"> = ["r", "g", "b"];
  return channels.every((ch) => {
    const lo = Math.min(a[ch], b[ch]) - slack;
    const hi = Math.max(a[ch], b[ch]) + slack;
    return candidate[ch] >= lo && candidate[ch] <= hi;
  });
}

type RowClassification =
  | { kind: "fill"; color: SignPerimeterBandRow }
  | { kind: "content" };

/**
 * One row's own classification — reuses `measureLine`'s exact
 * membership/coverage measurement across the row's analysis-domain width
 * (`x0=domainX`, `dx=1`, `length=domainWidth`) at absolute row `y` —
 * never a narrower sample, and never the full image width when a window
 * restricts the domain.
 */
function classifyRow(image: RgbaImage, y: number, domainX: number, domainWidth: number): RowClassification {
  const line = measureLine(image, domainX, y, 1, 0, domainWidth);
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

/**
 * Run-length-encodes the row classification sequence across
 * `[domainStartY, domainEndY)` (ABSOLUTE source-image y-coordinates —
 * `RunSegment.startYPx` therefore never needs a later offset), merging
 * consecutive same-colour fill rows into one run (consecutive content
 * rows always merge regardless of what specifically makes each
 * non-uniform).
 */
function runLengthEncode(
  image: RgbaImage,
  domainStartY: number,
  domainEndY: number,
  domainX: number,
  domainWidth: number,
): RunSegment[] {
  const runs: RunSegment[] = [];
  for (let y = domainStartY; y < domainEndY; y++) {
    const classification = classifyRow(image, y, domainX, domainWidth);
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

/**
 * Phase 2D — bounded transition-run tolerance: a candidate fill run this
 * tall OR shorter may be considered anti-aliasing/measurement-transition
 * evidence — NEVER merely because it is short; see
 * `decideTransitionAbsorption` for the additional, REQUIRED colour and
 * neighbour evidence a candidate must also satisfy. Independently
 * justified for THIS module (deliberately not imported from
 * `frame-structure-model.ts`'s differently-scoped `MAX_TRANSITION_RUN_PX`
 * — see the module doc above for why those semantics do not transfer):
 * genuine anti-aliased blending in exported raster artwork is
 * conventionally 1-2 pixels; a deliberately designed visual element (a
 * stripe, an accent line, a banner) is essentially always taller.
 */
const MAX_TRANSITION_RUN_HEIGHT_PX = 2;

/**
 * A neighbouring fill run must be at least this tall to be trusted as the
 * genuine, stable structural colour a short candidate might be blending
 * toward — never itself another borderline-short run (which is exactly
 * how a genuine multi-run gradient or pattern of several short, distinct
 * runs correctly fails to resolve — see the synthetic test matrix).
 * Derived, not arbitrary: four times the largest tolerated transition, so
 * a trusted anchor is unambiguously larger than anything this module
 * would ever consider absorbing.
 */
const MIN_TRANSITION_ANCHOR_HEIGHT_PX = MAX_TRANSITION_RUN_HEIGHT_PX * 4;

/**
 * The looser, inter-run colour-continuity tolerance a transition
 * candidate's own colour is compared against when checking closeness to a
 * single anchor — the same "wider than per-line membership" allowance
 * `frame-structure-model.ts` already established for judging whether two
 * nearby measurements are close enough to be the same underlying colour
 * (its own `EDGE_BACKGROUND_TOLERANCE * 2`, used for cross-depth band
 * continuity). Reused here because the underlying colour-perception
 * reasoning is genuinely the same ("is this plausibly the same colour,
 * measured slightly differently"), not because the two modules' own
 * scanning mechanisms are related — they are not.
 */
const TRANSITION_COLOR_TOLERANCE = EDGE_BACKGROUND_TOLERANCE * 2;

type TransitionAbsorptionDecision = "before" | "after" | null;

/**
 * Decides whether `candidate` (a short fill run) is bounded transition
 * evidence that should be folded into its `before` or `after` neighbour,
 * or must remain its own independent run. Returns `null` — never absorb —
 * unless AFFIRMATIVE colour/neighbour evidence proves it:
 *
 *   - `candidate` must itself be a fill run no taller than
 *     `MAX_TRANSITION_RUN_HEIGHT_PX` (necessary, never sufficient).
 *   - At least one neighbour must be a substantial fill run
 *     (`MIN_TRANSITION_ANCHOR_HEIGHT_PX` or taller) — content, the domain
 *     edge (no neighbour), or another short run never counts as an
 *     anchor.
 *   - AND EITHER: `candidate`'s colour is within `TRANSITION_COLOR_
 *     TOLERANCE` of one anchor's colour (a trailing/leading anti-alias of
 *     that one anchor — Examples A/B: fill -> short transition -> content,
 *     or the reverse); OR, when BOTH neighbours are substantial fills of
 *     differing colours, `candidate`'s colour lies channel-wise BETWEEN
 *     them (`isChannelwiseBetween`) — a genuine cross-fade (Example C) —
 *     never merely "close to one side" when the other side is also a
 *     substantial, differently-coloured fill (that would let a
 *     deliberate, strongly distinct accent colour near one neighbour pass
 *     as a transition of the far one too).
 *
 * When both sides qualify, absorption picks whichever neighbour the
 * candidate's colour is genuinely closer to (Chebyshev distance) — a
 * deterministic tie-break, not a preference for either direction.
 *
 * A short run flanked by content on both sides, or by two OTHER short
 * runs (no substantial anchor either side), or whose colour is not
 * affirmatively explained by any neighbour, returns `null` and is left
 * exactly as measured — including remaining part of a genuine adjacent-
 * fill ambiguity, and including a genuine multi-run sequence of several
 * short, distinct runs (no single run in such a sequence has a
 * substantial immediate neighbour to anchor against, so none resolve —
 * fail closed).
 */
function decideTransitionAbsorption(
  candidate: RunSegment,
  before: RunSegment | null,
  after: RunSegment | null,
): TransitionAbsorptionDecision {
  if (candidate.kind !== "fill" || candidate.heightPx > MAX_TRANSITION_RUN_HEIGHT_PX) return null;

  const beforeAnchor = before && before.kind === "fill" && before.heightPx >= MIN_TRANSITION_ANCHOR_HEIGHT_PX ? before : null;
  const afterAnchor = after && after.kind === "fill" && after.heightPx >= MIN_TRANSITION_ANCHOR_HEIGHT_PX ? after : null;
  if (!beforeAnchor && !afterAnchor) return null;

  const beforeClose = beforeAnchor !== null && colorsMatch(candidate.color!, beforeAnchor.color!, TRANSITION_COLOR_TOLERANCE);
  const afterClose = afterAnchor !== null && colorsMatch(candidate.color!, afterAnchor.color!, TRANSITION_COLOR_TOLERANCE);
  const between =
    beforeAnchor !== null &&
    afterAnchor !== null &&
    isChannelwiseBetween(candidate.color!, beforeAnchor.color!, afterAnchor.color!);

  if (!beforeClose && !afterClose && !between) return null;

  const distBefore = beforeAnchor ? colorDistanceChebyshev(candidate.color!, beforeAnchor.color!) : Number.POSITIVE_INFINITY;
  const distAfter = afterAnchor ? colorDistanceChebyshev(candidate.color!, afterAnchor.color!) : Number.POSITIVE_INFINITY;
  return distBefore <= distAfter ? "before" : "after";
}

/**
 * Applies `decideTransitionAbsorption` across the full run sequence,
 * folding each absorbed run's rows into its target neighbour. All
 * decisions are computed FIRST against the ORIGINAL, unmodified `runs`
 * array (each run's own immediate original neighbours only) — never
 * against a neighbour already modified by an earlier fold in the same
 * pass — so results never depend on scan direction or the order runs
 * happen to appear in, only on each run's own original, independent
 * evidence (determinism; no cascading re-evaluation).
 *
 * An absorbed run's rows are folded into its target's existing
 * `startYPx`/`heightPx` span; the target keeps ITS OWN already-measured
 * colour (an absorbed row is considered part of the neighbouring fill,
 * never averaged or recoloured) — this changes only this module's
 * structural interpretation, never a source pixel.
 */
function normalizeTransitionRuns(runs: RunSegment[]): RunSegment[] {
  const decisions: TransitionAbsorptionDecision[] = runs.map((run, i) =>
    decideTransitionAbsorption(run, i > 0 ? runs[i - 1]! : null, i < runs.length - 1 ? runs[i + 1]! : null),
  );

  const normalized: RunSegment[] = [];
  for (let i = 0; i < runs.length; i++) {
    const decision = decisions[i];
    if (decision === "before" && normalized.length > 0) {
      normalized[normalized.length - 1]!.heightPx += runs[i]!.heightPx;
      continue;
    }
    if (decision === "after" && i < runs.length - 1) {
      const next = runs[i + 1]!;
      runs[i + 1] = { ...next, startYPx: runs[i]!.startYPx, heightPx: runs[i]!.heightPx + next.heightPx };
      continue;
    }
    normalized.push({ ...runs[i]! });
  }
  return normalized;
}

/**
 * Structural Layout Reflow Phase 2 (Planner Wiring): positional, purely a
 * function of `regions`'s own current length at call time — never a
 * module-level counter. A plan's `reflow_structural_layout` step persists
 * `region${i}Id` (`sign-repair-planner.ts`'s `encodeStructuralReflowParams`)
 * as PART of its canonical params, so identity must be reproducible:
 * calling `segmentStructuralLayout` twice on the identical image (and the
 * identical analysis window, Phase 2C) must yield identical ids, which a
 * module-global incrementing counter cannot guarantee — it would depend
 * on how many OTHER images this process happened to have already
 * segmented.
 */
function nextRegionId(regions: SignStructuralRegion[]): string {
  return `region-${regions.length}`;
}

const MIN_ANALYSIS_WINDOW_DIMENSION_PX = 8;

/**
 * Structural Layout Reflow Phase 2C (Frame-Interior-Aware Segmentation):
 * converts a measured `SignFrameStructuralModelResult` into a validated
 * `SignStructuralAnalysisWindow` for `segmentStructuralLayout`'s own
 * optional second parameter — or `null` when the frame evidence does not
 * safely support one. Never trusts `frame-structure-model.ts`'s own
 * internal guarantees blindly (defense in depth): every bound is
 * re-checked explicitly here, so a future change to that module's own
 * invariants can never silently make this window unsafe.
 *
 * Validated, in order: frame status is `"measured"` (never `"ambiguous"`
 * or `"not_present"` — there is nothing safe to window into otherwise);
 * every interior bound is a finite integer; the window clears a minimum
 * analyzable size (`MIN_ANALYSIS_WINDOW_DIMENSION_PX` on each axis — a
 * sliver too small to ever contain a genuine top+bottom anchor pair is
 * not worth analyzing and risks a degenerate/misleading result); the
 * window lies entirely within the supplied source dimensions (no
 * coordinate inversion, no out-of-bounds reach); and the frame model's
 * OWN recorded source dimensions match the caller's — a mismatch would
 * mean this window was measured against a DIFFERENT image than the one
 * about to be analyzed, exactly the "stale bytes" class of bug this
 * capability's own orchestration wiring is careful to avoid elsewhere.
 *
 * THE FRAME MAY DEFINE AN ANALYSIS WINDOW. THE FRAME MAY NEVER DEFINE THE
 * PRODUCTION TEMPLATE — this function returns plain geometry for
 * `segmentStructuralLayout` to look WITHIN; it never reads or returns
 * `cornerRadiusPx`, band colours, or hole geometry, and nothing it
 * returns is ever a valid input to `buildSignProductionTemplate`
 * (`sign-production-template.ts`), which remains derived only from the
 * ordered production spec + policy.
 */
export function resolveFrameAnalysisWindow(
  frameResult: SignFrameStructuralModelResult,
  sourceWidthPx: number,
  sourceHeightPx: number,
): SignStructuralAnalysisWindow | null {
  if (frameResult.status !== "measured") return null;
  const { model } = frameResult;
  const { x, y, width, height } = model.interior;

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    return null;
  }
  if (width < MIN_ANALYSIS_WINDOW_DIMENSION_PX || height < MIN_ANALYSIS_WINDOW_DIMENSION_PX) return null;
  if (x < 0 || y < 0) return null;
  if (x + width > sourceWidthPx || y + height > sourceHeightPx) return null;
  if (model.sourceWidthPx !== sourceWidthPx || model.sourceHeightPx !== sourceHeightPx) return null;

  return { x, y, width, height };
}

/**
 * Independently re-validates a caller-supplied `SignStructuralAnalysisWindow`
 * against the ACTUAL image about to be analyzed — the same bar
 * `resolveFrameAnalysisWindow` applies, checked again here regardless of
 * origin (a window is never trusted merely because a caller supplied one;
 * `segmentStructuralLayout` re-derives its own domain from scratch).
 * Returns `null` on ANY validation failure — the caller's own documented
 * fallback ("most conservative correct behaviour") is to analyze the full
 * image exactly as if no window had been supplied at all, never to guess
 * at a corrected window and never to refuse segmenting outright merely
 * because an optional hint was unusable.
 */
function validateAnalysisWindow(
  window: SignStructuralAnalysisWindow,
  image: RgbaImage,
): SignStructuralAnalysisWindow | null {
  const { x, y, width, height } = window;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    return null;
  }
  if (width < MIN_ANALYSIS_WINDOW_DIMENSION_PX || height < MIN_ANALYSIS_WINDOW_DIMENSION_PX) return null;
  if (x < 0 || y < 0) return null;
  if (x + width > image.width || y + height > image.height) return null;
  return { x, y, width, height };
}

/**
 * Segments `image` into structural regions and the gaps between them —
 * see the module's own doc for the measurement rule. Deliberately
 * position-based, never wording/content-based: the first region measured
 * is always `top_anchor` and the last is always `bottom_anchor`
 * (identical when there is exactly one region — see below), regardless of
 * whether either happens to own edge-reaching fill. No customer text,
 * layout count, or specific artwork is ever referenced — this runs
 * identically against any banner-shaped source.
 *
 * `analysisWindow` (Phase 2C), when supplied, restricts the scan to that
 * SOURCE-image sub-rectangle instead of the full image — see the module's
 * own doc for why (a continuous decorative frame defeats full-width row
 * uniformity everywhere) and for the "never trust it blindly" validation
 * this function itself re-applies (`validateAnalysisWindow`) regardless
 * of whatever validation the caller already performed. An invalid window
 * is never an error — this function silently falls back to analyzing the
 * full image, byte-for-byte the same behaviour as if no window had been
 * passed at all.
 *
 * GROUPING RULE (deliberately the simplest rule that is still correct and
 * fully general, not an attempt to solve every conceivable layout):
 *
 *   - If the FIRST run touches the analysis domain's own top edge
 *     (`startYPx === domain.y`) and is a FILL run, it merges into the
 *     first CONTENT run that follows it to form the `top_anchor` region
 *     (`sourceBounds` spans both; `contentBounds` is the content run
 *     alone; `fillEdgeReaching: true`). If the first run is already
 *     CONTENT, that run alone is `top_anchor` with no fill
 *     (`fillColor: null`, `fillEdgeReaching: false`).
 *   - The symmetric rule applies to the LAST run / `bottom_anchor`,
 *     against the domain's own bottom edge (`domain.y + domain.height`).
 *   - Every OTHER content run becomes a `middle` region, owning no fill.
 *   - Every OTHER fill run (touching neither domain edge, or sitting
 *     between two content runs) is a `SignStructuralGap` — UNLESS two
 *     fill runs are directly adjacent in the run sequence (only possible
 *     when they measured genuinely different colours, since same-colour
 *     adjacent fill rows already merged) — there is then no single colour
 *     to call "the gap", which is exactly the ambiguity this function
 *     fails closed on.
 */
export function segmentStructuralLayout(
  image: RgbaImage,
  analysisWindow?: SignStructuralAnalysisWindow,
): SignStructuralLayoutSegmentationResult {
  if (image.width <= 0 || image.height <= 0) return { status: "not_present" };

  const validatedWindow = analysisWindow ? validateAnalysisWindow(analysisWindow, image) : null;
  const domain = validatedWindow ?? { x: 0, y: 0, width: image.width, height: image.height };
  if (domain.width <= 0 || domain.height <= 0) return { status: "not_present" };

  const domainStartY = domain.y;
  const domainEndY = domain.y + domain.height;

  const rawRuns = runLengthEncode(image, domainStartY, domainEndY, domain.x, domain.width);
  // Phase 2D: resolve bounded transition evidence BEFORE any ambiguity
  // check or region/gap construction ever sees the run sequence — see
  // `normalizeTransitionRuns`'s own doc.
  const runs = normalizeTransitionRuns(rawRuns);

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
    // already refused) — a solid-colour analysis domain. Nothing to segment.
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
    const owningFillBefore = isFirstContent && i > 0 && runs[i - 1]!.kind === "fill" && runs[i - 1]!.startYPx === domainStartY
      ? runs[i - 1]!
      : null;
    const owningFillAfter =
      isLastContent &&
      i < runs.length - 1 &&
      runs[i + 1]!.kind === "fill" &&
      runs[i + 1]!.startYPx + runs[i + 1]!.heightPx === domainEndY
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
      id: nextRegionId(regions),
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
  // domain's own bottom edge — content is followed by fill, then something
  // else is structurally impossible after the last content run other than
  // one final fill run, since runs strictly alternate kind).
  const lastRun = runs[runs.length - 1]!;
  if (lastRun.kind === "fill" && lastRun.startYPx > runs[lastContentIdx]!.startYPx) {
    const alreadyOwned = regions[regions.length - 1]!.sourceBounds.startYPx <= lastRun.startYPx &&
      regions[regions.length - 1]!.sourceBounds.startYPx + regions[regions.length - 1]!.sourceBounds.heightPx >=
        lastRun.startYPx + lastRun.heightPx;
    if (!alreadyOwned) {
      gaps.push({ sourceHeightPx: lastRun.heightPx, fillColor: lastRun.color! });
    }
  }

  return { status: "measured", regions, gaps, analysisWindow: validatedWindow };
}
