/**
 * Signs Phase S1: the repair PLANNER. Formulates — and never executes — the
 * least-destructive ordered operations that would make the supplied artwork
 * printable at the ordered substrate size (Constitution §16A.3).
 *
 * The decision hierarchy, least destructive first:
 *
 *   1. nothing / proportional resampling only
 *   2. deterministic uniform-background extension (auto only on affirmative
 *      per-edge evidence)
 *   3. bounded provider reconstruction (refused pre-plan when even the
 *      admitted ceiling cannot reach the blocking minimum)
 *   4. bounded, non-generative perimeter STRUCTURE reconstruction
 *      (Constitution §16A.3 amendment 3.1) — only when an edge the
 *      extension axis affects carries edge-dependent structure
 *      (`edge-dependence.ts`) AND that structure clears `perimeter-
 *      reconstruction.ts`'s affirmative uniform-per-line evidence bar.
 *      Always human-review-required, never `auto_safe`.
 *   5. anything touching content — approved_crop, seams over foreground,
 *      opacity decisions — is review or human territory, never automatic.
 *
 * Edge-dependent structure that does NOT clear tier 4's evidence bar has no
 * admitted repair at all — the plan refuses outright (`blocked`) rather
 * than falling through to tier 5's ordinary `pad_uniform_background`, which
 * would silently misrepresent an inadmissible repair as an ordinary
 * reviewable one.
 *
 * Risk discipline: AUTO_SAFE requires proof; uncertainty NEVER downgrades
 * to safe. Fill/crop is never selected automatically (any non-zero crop may
 * remove meaningful content until a human approves an exact preview).
 */

import type {
  SignDefect,
  SignEdge,
  SignEdgeEvidence,
  SignInspectionReport,
  SignPlanningResult,
  SignProductionSpec,
  SignProductionTemplate,
  SignRepairPlan,
  SignRepairStep,
  SignRiskClass,
} from "./contracts";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION } from "./contracts";
import { diagnoseInspection } from "./sign-diagnosis";
import { isEdgeDependentStructure } from "./edge-dependence";
import { computeSignPlanKey } from "./sign-plan-identity";
import {
  containPlacement,
  SIGN_ASPECT_TOLERANCE,
  SIGN_PPI_TOLERANCE,
} from "./sign-inspection";
import type { SignResolutionPolicy } from "./resolution-policy";
import {
  SIGN_RECONSTRUCTION_HEADROOM,
  SIGN_RECONSTRUCTION_SCALE_CEILING,
} from "./resolution-policy";
import type { SignPerimeterBandMeasurement } from "./perimeter-reconstruction";
import type { SignFrameStructuralModel, SignFrameStructuralModelResult } from "./frame-structure-model";
import { buildSignProductionTemplate } from "./sign-production-template";
import type {
  SignStructuralGap,
  SignStructuralLayoutSegmentationResult,
  SignStructuralRegion,
} from "./sign-layout-segmentation";

export interface SignPlanningInput {
  spec: SignProductionSpec;
  policy: SignResolutionPolicy;
  inspection: SignInspectionReport;
  sourceAssetId: string;
  sourceSha256: string;
  /**
   * Production-Aware Perimeter Reconstruction Phase: one measurement per
   * edge (however many the caller computed — `sign-preparation-
   * capability.ts` computes all four), used ONLY when an affected edge is
   * flagged edge-dependent and would otherwise block. Optional and
   * defaulted to none — a caller that never supplies this gets EXACTLY the
   * prior phase's behavior (edge-dependent structure always blocks); this
   * is additive, never a silent behavior change for an existing caller.
   */
  perimeterBands?: SignPerimeterBandMeasurement[];
  /**
   * Parametric Perimeter Frame Reconstruction Phase: the caller's own
   * `frame-structure-model.ts` measurement of the SOURCE image, used ONLY
   * when an affected edge is flagged edge-dependent and would otherwise
   * block or fall to `reconstruct_perimeter_structure`'s narrower tiling
   * bar. Optional and defaulted to absent — a caller that never supplies
   * this gets exactly the prior phase's behaviour, unaffected.
   */
  frameStructuralModel?: SignFrameStructuralModelResult;
  /**
   * Height/Redistribution Policy: `frame-structure-model.ts`'s own
   * `measureCleanFillRunPx`, one measurement per edge — how the newly
   * added space should be split between the axis's two affected edges
   * (see `encodeFrameStructuralModelParams`'s own doc). Only meaningful
   * alongside `frameStructuralModel`.
   */
  frameCleanFillRunPx?: Partial<Record<SignEdge, number>>;
  /**
   * Structural Layout Reflow Phase 2 (Planner Wiring): the caller's own
   * `sign-layout-segmentation.ts` measurement of the SOURCE image, used
   * ONLY when the aspect-correction axis is `"vertical"` (segmentation is
   * a row-scan and has nothing to say about a horizontal mismatch) and the
   * source was not rotated (pre-rotation segmentation is never trusted,
   * identical discipline to `frameStructuralModel`/edge evidence above).
   * Optional and defaulted to absent — a caller that never supplies this
   * gets EXACTLY the prior phase's behaviour (frame-model / perimeter-band
   * / block, unaffected). When supplied and admissible, this evidence is
   * PREFERRED over `frameStructuralModel`: a banner-style structural
   * layout and a concentric perimeter frame are different shapes, and the
   * real Signs acceptance incident proved the frame-model's "source
   * perimeter defines the substrate" assumption wrong for this shape —
   * `reconstruct_parametric_frame` is never even considered once this
   * evidence is supplied and admissible.
   */
  structuralLayoutSegmentation?: SignStructuralLayoutSegmentationResult;
}

const RISK_ORDER: Record<SignRiskClass, number> = {
  auto_safe: 0,
  review_required: 1,
  blocked: 2,
};

function maxRisk(a: SignRiskClass, b: SignRiskClass): SignRiskClass {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function edgeByName(
  edges: SignEdgeEvidence[],
  edge: SignEdge,
): SignEdgeEvidence {
  const found = edges.find((item) => item.edge === edge);
  if (!found) throw new Error(`missing edge evidence for ${edge}`);
  return found;
}

/**
 * Flattens both affected edges' measured band rows into `SignRepairStep`'s
 * flat `Record<string, number | string>` params shape — canonical
 * serialization (plan identity, `stableStringify`) requires flat values, so
 * each measured line's colour gets its own dynamically-named key. Every
 * value here is a real colour `perimeter-reconstruction.ts` measured from
 * the source; nothing is invented at this layer either.
 */
function encodePerimeterBandsParams(
  axis: "horizontal" | "vertical",
  leadingPx: number,
  trailingPx: number,
  leadingBand: SignPerimeterBandMeasurement,
  trailingBand: SignPerimeterBandMeasurement,
): Record<string, number | string> {
  const params: Record<string, number | string> = {
    axis,
    leadingPx,
    trailingPx,
    leadingBandDepthPx: leadingBand.bandDepthPx,
    trailingBandDepthPx: trailingBand.bandDepthPx,
  };
  leadingBand.rows.forEach((row, i) => {
    params[`leadingRow${i}R`] = row.r;
    params[`leadingRow${i}G`] = row.g;
    params[`leadingRow${i}B`] = row.b;
  });
  trailingBand.rows.forEach((row, i) => {
    params[`trailingRow${i}R`] = row.r;
    params[`trailingRow${i}G`] = row.g;
    params[`trailingRow${i}B`] = row.b;
  });
  return params;
}

/**
 * Flattens a measured `SignFrameStructuralModel` (bands, corner rounding,
 * hole geometry, all still in SOURCE-image pixel units) plus this axis's
 * redistribution share into `SignRepairStep`'s flat params shape. Every
 * value is either directly measured from the source (never invented) or
 * a plain geometry fact (axis, leadingPx/trailingPx, leadingShare)
 * `sign-transform-executor.ts` independently re-derives from at
 * EXECUTION time when a preceding `reconstruct_resolution` step's actual
 * output diverges from what was requested — see that module's own
 * `adaptGeometryStepsToActualReconstruction` doc.
 *
 * `leadingShare` — Height/Redistribution Policy: the neutral, measured
 * proportion (0..1) of the newly added space that goes to the LEADING
 * side, derived from each side's own measured "clean fill" depth
 * (`measureCleanFillRunPx`) — preserving the artwork's own existing
 * top/bottom (or left/right) proportions rather than an arbitrary 50/50
 * split, while never asking an operator to type a number. Falls back to
 * an even 0.5 split only when NEITHER side measured any clean fill at
 * all (both exactly 0) — a genuinely symmetric case, not a guess.
 */
function encodeFrameStructuralModelParams(
  axis: "horizontal" | "vertical",
  leadingPx: number,
  trailingPx: number,
  leadingShare: number,
  model: SignFrameStructuralModel,
): Record<string, number | string> {
  const params: Record<string, number | string> = {
    axis,
    leadingPx,
    trailingPx,
    leadingShare,
    modelSourceWidthPx: model.sourceWidthPx,
    modelSourceHeightPx: model.sourceHeightPx,
    frameDepthPx: model.frameDepthPx,
    bandCount: model.bands.length,
    fillColorR: model.fillColor.r,
    fillColorG: model.fillColor.g,
    fillColorB: model.fillColor.b,
    cornerRadiusPx: model.cornerRadiusPx ?? -1,
    hasHole: model.hole ? "true" : "false",
  };
  model.bands.forEach((band, i) => {
    params[`band${i}R`] = band.color.r;
    params[`band${i}G`] = band.color.g;
    params[`band${i}B`] = band.color.b;
    params[`band${i}ThicknessPx`] = band.thicknessPx;
  });
  if (model.outerBackgroundColor) {
    params.outerBackgroundColorR = model.outerBackgroundColor.r;
    params.outerBackgroundColorG = model.outerBackgroundColor.g;
    params.outerBackgroundColorB = model.outerBackgroundColor.b;
  }
  if (model.hole) {
    params.holeRadiusPx = model.hole.radiusPx;
    params.holeOffsetXPx = model.hole.offsetFromCornerXPx;
    params.holeOffsetYPx = model.hole.offsetFromCornerYPx;
    params.holeRingColorR = model.hole.ringColor.r;
    params.holeRingColorG = model.hole.ringColor.g;
    params.holeRingColorB = model.hole.ringColor.b;
    params.holeInteriorColorR = model.hole.interiorColor.r;
    params.holeInteriorColorG = model.hole.interiorColor.g;
    params.holeInteriorColorB = model.hole.interiorColor.b;
  }
  return params;
}

/**
 * Structural Layout Reflow Phase 2 (Planner Wiring): flattens a `"measured"`
 * segmentation's regions/gaps plus the authoritative `SignProductionTemplate`
 * into `SignRepairStep`'s flat params shape — the same `${prefix}Count` +
 * per-index dynamically-named-key convention `encodeFrameStructuralModelParams`
 * /`encodePerimeterBandsParams` already use. Every bound/colour here is
 * exactly what `sign-layout-segmentation.ts` measured from the SOURCE image
 * — still in SOURCE-image pixel units, never pre-rescaled to any later
 * pixel space (mirrors `encodeFrameStructuralModelParams`'s own discipline:
 * a future executor re-derives actual output pixels from whatever a
 * preceding `reconstruct_resolution` step's ACTUAL output turns out to be,
 * exactly like it already does for `reconstruct_parametric_frame` — this
 * phase does not implement that).
 *
 * `scalingMode`/`layoutTransform` are explicit, literal flat-string
 * declarations of V1's only permitted repair semantics — translation plus
 * source-derived gap redistribution, NEVER non-uniform scaling of
 * meaningful content — so a future executor (or an auditor reading a
 * persisted plan) never has to infer permission from the mere absence of a
 * scaling parameter.
 */
function encodeStructuralReflowParams(
  axis: "horizontal" | "vertical",
  totalAddedPx: number,
  template: SignProductionTemplate,
  regions: SignStructuralRegion[],
  gaps: SignStructuralGap[],
): Record<string, number | string> {
  const params: Record<string, number | string> = {
    axis,
    totalAddedPx,
    templateWidthIn: template.widthIn,
    templateHeightIn: template.heightIn,
    templateShape: template.shape,
    templateMinimumSafeInsetIn: template.minimumSafeInsetIn,
    scalingMode: "none",
    layoutTransform: "translate_and_redistribute_gaps",
    regionCount: regions.length,
    gapCount: gaps.length,
  };
  regions.forEach((region, i) => {
    params[`region${i}Id`] = region.id;
    params[`region${i}Role`] = region.role;
    params[`region${i}SourceStartYPx`] = region.sourceBounds.startYPx;
    params[`region${i}SourceHeightPx`] = region.sourceBounds.heightPx;
    params[`region${i}ContentStartYPx`] = region.contentBounds.startYPx;
    params[`region${i}ContentHeightPx`] = region.contentBounds.heightPx;
    params[`region${i}FillEdgeReaching`] = region.fillEdgeReaching ? "true" : "false";
    params[`region${i}Expandable`] = region.expandable ? "true" : "false";
    if (region.fillColor) {
      params[`region${i}FillColorR`] = region.fillColor.r;
      params[`region${i}FillColorG`] = region.fillColor.g;
      params[`region${i}FillColorB`] = region.fillColor.b;
    }
  });
  gaps.forEach((gap, i) => {
    params[`gap${i}SourceHeightPx`] = gap.sourceHeightPx;
    params[`gap${i}FillColorR`] = gap.fillColor.r;
    params[`gap${i}FillColorG`] = gap.fillColor.g;
    params[`gap${i}FillColorB`] = gap.fillColor.b;
  });
  return params;
}

type StructuralReflowEvaluation =
  | { status: "eligible"; template: SignProductionTemplate; regions: SignStructuralRegion[]; gaps: SignStructuralGap[] }
  | { status: "ambiguous"; reason: string }
  | { status: "insufficient"; failures: string[] }
  | { status: "not_applicable" };

/**
 * Structural Layout Reflow Phase 2B (Planning Orchestration Wiring):
 * evaluates — as pure DATA, with no side effect on `steps`/`defects` and
 * never an immediate refusal — whether `structuralLayoutSegmentation`
 * evidence is ELIGIBLE for a `reflow_structural_layout` proposal.
 *
 * Split out from the emission call site specifically so a caller can
 * correctly decide what to try NEXT when this evidence is `"ambiguous"` or
 * `"insufficient"`: real orchestration wiring (`sign-preparation-
 * capability.ts`) proved that a genuinely bordered/framed sign routinely
 * trips segmentation's own ambiguity rule — a frame's outer-stroke/gap
 * boundary looks, to a full-width row scanner, exactly like two directly
 * adjacent, differently-coloured fill runs at the very edge (the same
 * shape `sign-layout-segmentation.ts` refuses to guess about). That is
 * evidence the ROW-SCAN technique does not fit THIS artwork — never
 * evidence the artwork itself has no admitted repair at all. A caller
 * with independently valid `frameStructuralModel` evidence must still be
 * able to reach `reconstruct_parametric_frame` in that case, exactly as
 * it always has (Historical Compatibility) — only when NEITHER frame
 * evidence NOR edge-dependent structure independently justifies a
 * different repair does failure here become an outright block.
 */
function evaluateStructuralReflow(
  spec: SignProductionSpec,
  policy: SignResolutionPolicy,
  effectivePpi: number,
  segmentation: SignStructuralLayoutSegmentationResult,
): StructuralReflowEvaluation {
  if (segmentation.status === "not_present") return { status: "not_applicable" };
  if (segmentation.status === "ambiguous") return { status: "ambiguous", reason: segmentation.reason };

  const regions = segmentation.regions;
  // A single-region "measured" result (`regions[0]` and the last region are
  // the SAME object — the algorithm's own documented tie-break, `sign-
  // layout-segmentation.ts`) is an ORDINARY picture with one bounded
  // content area, not genuine multi-section banner structure: exactly the
  // same shape `uniformBackgroundSignArtwork`/`exactAspectSignArtwork`
  // already represent, which real orchestration wiring proved segments as
  // exactly ONE region. Treating that as "insufficient structural
  // evidence" would BLOCK an ordinary, previously-safe `extend_uniform_
  // background`/`pad_uniform_background` case — worse than doing nothing.
  // A genuine top+bottom anchor PAIR requires at least two regions
  // (`regions[0].role` is always `"top_anchor"` and the last region's role
  // is always `"bottom_anchor"` by the segmentation algorithm's own
  // construction whenever `regions.length >= 2`), so this is exactly
  // equivalent to requiring a distinct anchor pair — treated as
  // `"not_applicable"` (as if segmentation had never found anything
  // relevant here at all), never as a failed proposal.
  if (regions.length < 2) return { status: "not_applicable" };

  const topRegion = regions[0];
  const bottomRegion = regions[regions.length - 1];
  // A genuine banner's own defining trait is a MEASURED FILL an anchor's
  // content sits inside of — never merely "content happens to be the
  // first/last run." When NEITHER anchor has one, content touches BOTH
  // outer edges directly with nothing but plain background between them
  // (real orchestration wiring's own acceptance shape: noise/foreground
  // reaching both edges, uniform interior) — the structural INVERSE of a
  // banner, not partial evidence of one. That shape already has a
  // dedicated, correct handler (`edge-dependence.ts`/`isEdgeDependentStructure`
  // plus the perimeter-band reconstructability check below) — treated as
  // `"not_applicable"` so it falls through to that, unaffected, rather
  // than this evidence intercepting and blocking it. (At least one
  // anchor's own fill — `bannerSignEdgeContentArtwork`'s own shape, e.g.
  // — is genuine partial banner evidence and still fails closed below.)
  if (!topRegion?.fillEdgeReaching && !bottomRegion?.fillEdgeReaching) {
    return { status: "not_applicable" };
  }

  const template = buildSignProductionTemplate(spec, policy);
  const gaps = segmentation.gaps;

  const failures: string[] = [];
  // Defensive, currently unreachable in V1 (the only admitted shape), kept
  // as an explicit PROOF point rather than an assumption — a future
  // second `SignProductionTemplateShape` must not silently start passing
  // this gate.
  if (template.shape !== "straight_rectangle") {
    failures.push(`the production template's shape (${template.shape}) is not a straight rectangle`);
  }
  if (!topRegion?.fillEdgeReaching || !topRegion.fillColor) {
    failures.push("the top anchor has no measured, edge-reaching fill to extend to the new cut edge");
  }
  if (!bottomRegion?.fillEdgeReaching || !bottomRegion.fillColor) {
    failures.push("the bottom anchor has no measured, edge-reaching fill to extend to the new cut edge");
  }
  if (gaps.length === 0) {
    failures.push(
      "no measured inter-region gap exists to redistribute the added space into without stretching meaningful content",
    );
  }
  if (topRegion && bottomRegion && topRegion !== bottomRegion) {
    const topGapPx = topRegion.contentBounds.startYPx - topRegion.sourceBounds.startYPx;
    const bottomGapPx =
      bottomRegion.sourceBounds.startYPx +
      bottomRegion.sourceBounds.heightPx -
      (bottomRegion.contentBounds.startYPx + bottomRegion.contentBounds.heightPx);
    const topGapIn = topGapPx / effectivePpi;
    const bottomGapIn = bottomGapPx / effectivePpi;
    // Full pixel-output enforcement belongs to later deterministic
    // verification (Phase 3+) — this is the plan-time NECESSARY-condition
    // check: reject geometry that is already provably incapable of
    // clearing the minimum, using the SOURCE's own truthful physical
    // density (stable regardless of any later resolution-stage pixel-
    // density change — see `encodeStructuralReflowParams`'s own doc).
    if (topGapIn + 1e-9 < template.minimumSafeInsetIn) {
      failures.push(
        `the top anchor's meaningful content sits only ${topGapIn.toFixed(3)}in from its own fill's source edge, short of the ${template.minimumSafeInsetIn}in minimum safe inset`,
      );
    }
    if (bottomGapIn + 1e-9 < template.minimumSafeInsetIn) {
      failures.push(
        `the bottom anchor's meaningful content sits only ${bottomGapIn.toFixed(3)}in from its own fill's source edge, short of the ${template.minimumSafeInsetIn}in minimum safe inset`,
      );
    }
  }

  if (failures.length > 0) return { status: "insufficient", failures };
  return { status: "eligible", template, regions, gaps };
}

/**
 * Formulates the V1 plan. Precondition: `input.spec` is a CONFIRMED spec and
 * `input.inspection` was produced under it (ordered/contain/resolution
 * non-null) — the capability enforces fail-closed spec resolution before
 * ever calling this.
 */
export function planSignRepair(input: SignPlanningInput): SignPlanningResult {
  const { spec, policy, inspection } = input;
  const defects: SignDefect[] = diagnoseInspection(inspection);
  const reasons: string[] = [];
  const steps: SignRepairStep[] = [];

  const resolution = inspection.resolution;
  const containNow = inspection.placements.contain;
  if (!resolution || !containNow || !inspection.ordered) {
    // Structurally unreachable via the capability; refuse rather than guess.
    defects.push({
      code: "unsupported_input",
      severity: "blocking",
      detail: "Inspection lacks spec-dependent geometry; cannot plan.",
    });
    return { status: "blocked", plan: null, defects };
  }

  // ---------------------------------------------------------------------
  // Optional rotate_90 — only when the direct aspect mismatches but a 90°
  // rotation lands inside tolerance. Lossless, but it changes viewing
  // intent, so it is never automatic.
  // ---------------------------------------------------------------------
  let srcW = inspection.source.widthPx;
  let srcH = inspection.source.heightPx;
  let rotated = false;
  if (
    inspection.aspectMismatch === true &&
    inspection.orientation.rotatedAspectMatches === true
  ) {
    steps.push({
      kind: "rotate_90",
      params: { direction: "cw" },
      risk: "review_required",
      reasons: [
        "A 90° rotation brings the source aspect within tolerance of the ordered aspect, but rotation changes viewing intent — a human must confirm it.",
      ],
    });
    [srcW, srcH] = [srcH, srcW];
    rotated = true;
  }

  const contain = containPlacement(
    srcW,
    srcH,
    spec.orderedWidthIn,
    spec.orderedHeightIn,
  );
  const effectivePpi = contain.effectivePpi;
  const orderedAspect = spec.orderedWidthIn / spec.orderedHeightIn;

  // ---------------------------------------------------------------------
  // Bounded-reconstruction gate (Constitution §16A.3), measured on the
  // planning geometry (post-rotation): if even the admitted ceiling cannot
  // reach the blocking minimum, no admitted repair exists — refuse before
  // formulating anything, and long before any provider could be dispatched
  // (S2's pre-dispatch refusal re-checks the same bound).
  // ---------------------------------------------------------------------
  const maxAchievablePpi = effectivePpi * SIGN_RECONSTRUCTION_SCALE_CEILING;
  if (maxAchievablePpi + SIGN_PPI_TOLERANCE < policy.minPpi) {
    defects.push({
      code: "reconstruction_exceeds_supported_scale",
      severity: "blocking",
      detail:
        `Reaching the ${policy.minPpi} PPI blocking minimum needs ` +
        `${(policy.minPpi / effectivePpi).toFixed(2)}×, beyond the admitted ` +
        `${SIGN_RECONSTRUCTION_SCALE_CEILING}× reconstruction ceiling ` +
        `(maximum achievable ≈ ${maxAchievablePpi.toFixed(1)} PPI). ` +
        "The honest remedies are a smaller ordered size or a better source file.",
    });
    return { status: "blocked", plan: null, defects };
  }

  // ---------------------------------------------------------------------
  // Resolution stage: reconstruct (bounded) when short of target; downsample
  // when meaningfully oversized; otherwise keep native pixels untouched.
  // Enlarged pixels are never claimed as native detail — the plan records
  // the requested scale, and S4/authoritative validation judge provenance.
  // ---------------------------------------------------------------------
  let contentW = srcW;
  let contentH = srcH;
  if (effectivePpi + SIGN_PPI_TOLERANCE >= policy.targetPpi) {
    const targetContentW = Math.round(contain.artworkWidthIn * policy.targetPpi);
    const targetContentH = Math.round(contain.artworkHeightIn * policy.targetPpi);
    if (contentW > Math.round(targetContentW * 1.005)) {
      steps.push({
        kind: "downsample",
        params: { targetWidthPx: targetContentW, targetHeightPx: targetContentH },
        risk: "auto_safe",
        reasons: [
          `Source provides ${effectivePpi.toFixed(1)} PPI, above the ${policy.targetPpi} PPI target; a proportional downsample is deterministic and information-preserving for print.`,
        ],
      });
      contentW = targetContentW;
      contentH = targetContentH;
      reasons.push("Oversized source downsampled to the policy target.");
    } else {
      reasons.push(
        `Source already provides ${effectivePpi.toFixed(1)} PPI at the contain placement — no resolution work needed.`,
      );
    }
  } else {
    const rawScale = policy.targetPpi / effectivePpi;
    let requestedScale = rawScale * SIGN_RECONSTRUCTION_HEADROOM;
    if (requestedScale > SIGN_RECONSTRUCTION_SCALE_CEILING) {
      requestedScale = SIGN_RECONSTRUCTION_SCALE_CEILING;
      reasons.push(
        `The ${policy.targetPpi} PPI target needs ${rawScale.toFixed(2)}×, beyond the admitted ` +
          `${SIGN_RECONSTRUCTION_SCALE_CEILING}× ceiling; planning the maximum admitted reconstruction ` +
          `(blocking minimum ${policy.minPpi} PPI remains reachable).`,
      );
    }
    const requestedWidthPx = Math.round(srcW * requestedScale);
    const requestedHeightPx = Math.round(srcH * requestedScale);
    steps.push({
      kind: "reconstruct_resolution",
      params: { requestedScale, requestedWidthPx, requestedHeightPx },
      risk: "auto_safe",
      reasons: [
        `Truthful effective resolution ${effectivePpi.toFixed(1)} PPI is below the ${policy.targetPpi} PPI target; ` +
          `a bounded provider reconstruction at ${requestedScale.toFixed(4)}× ` +
          `(includes ${SIGN_RECONSTRUCTION_HEADROOM}× headroom) is authorized, cost-controlled, and ` +
          "preservation-verified before any print_ready claim (Constitution §16A.3).",
      ],
    });
    contentW = requestedWidthPx;
    contentH = requestedHeightPx;
  }
  // ---------------------------------------------------------------------
  // Geometry stage: exact-aspect sources need nothing; mismatches are
  // repaired by extending the substrate-defined canvas along the padding
  // axis — reconstruct FIRST, extend SECOND, so the provider only ever sees
  // the customer's pixels and never a synthetic seam.
  // ---------------------------------------------------------------------
  let plateW = contentW;
  let plateH = contentH;
  const aspectMismatchNow =
    Math.abs(srcW / srcH - orderedAspect) / orderedAspect >
    SIGN_ASPECT_TOLERANCE;
  if (aspectMismatchNow) {
    const heightBound = srcW / srcH < orderedAspect;
    let axis: "horizontal" | "vertical";
    let affectedEdges: [SignEdge, SignEdge];
    if (heightBound) {
      plateH = contentH;
      plateW = Math.round(contentH * orderedAspect);
      axis = "horizontal";
      affectedEdges = ["left", "right"];
    } else {
      plateW = contentW;
      plateH = Math.round(contentW / orderedAspect);
      axis = "vertical";
      affectedEdges = ["top", "bottom"];
    }
    const totalPad = axis === "horizontal" ? plateW - contentW : plateH - contentH;
    const leadingPx = Math.floor(totalPad / 2);
    const trailingPx = totalPad - leadingPx;

    const first = edgeByName(inspection.edges, affectedEdges[0]);
    const second = edgeByName(inspection.edges, affectedEdges[1]);

    // Signs Perimeter Safety / Production-Aware Perimeter Reconstruction
    // Phases: an affected edge whose evidence shows a continuous, near-edge
    // structure (`edge-dependence.ts`) means this extension axis would move
    // MEANINGFUL, edge-relative artwork (a border, frame, rounded-corner
    // treatment, mounting-hole indicators — anything whose meaning depends
    // on the finished substrate edge) away from where it needs to end up —
    // a PRODUCTION-SEMANTICS change, never a pixel-preservation one.
    // Checked, and resolved, BEFORE `bothUniform` below: either the
    // narrowly-admitted `reconstruct_perimeter_structure` repair applies
    // (Constitution §16A.3 amendment 3.1 — real evidence required, always
    // human-review-required, never `auto_safe`), or no admitted repair
    // exists at all and the plan refuses outright — `pad_uniform_
    // background` (the `bothUniform`-false path below) is never offered as
    // a substitute for either outcome; operator review can authorize a
    // genuinely admitted repair, never turn an inadmissible one into one.
    // Pre-rotation edge evidence is never trusted for any of this, for the
    // identical reason `bothUniform` already excludes it.
    const edgeDependentEdges = rotated
      ? []
      : affectedEdges.filter((edge) =>
          isEdgeDependentStructure(edgeByName(inspection.edges, edge)),
        );
    // Parametric Perimeter Frame Reconstruction Phase (Constitution
    // §16A.3 amendment 3.1's own bounded carve-out, extended): the frame
    // model's OWN cross-edge/cross-corner agreement is independent,
    // purpose-built affirmative evidence — strictly STRONGER than
    // `edge-dependence.ts`'s cruder whole-band dominant-colour heuristic
    // (built for detecting stripe-like edge bleeding, not concentric
    // frame band sequences). Gating frame admission on `edgeDependentEdges`
    // firing FIRST would make it a hostage to that unrelated heuristic's
    // own tie-breaking: a genuinely, symmetrically framed sign with SQUARE
    // (unrounded) corners can measure a near-even black/white row split
    // within `edge-inspection.ts`'s own band-depth window, occasionally
    // landing outermostCoverage on the "matches dominant" side purely by
    // which colour bucket a tie resolves to — a fact about a DIFFERENT
    // measurement's window depth, never evidence the frame itself is any
    // less real. A measured (or ambiguous) frame model is therefore
    // checked on its OWN terms here, never gated behind edge-dependence.
    const hasFrameEvidence =
      !rotated && input.frameStructuralModel !== undefined && input.frameStructuralModel.status !== "not_present";
    // Structural Layout Reflow Phase 2/2B: segmentation is a row-scan
    // (`sign-layout-segmentation.ts`'s own doc — vertical-axis only), so it
    // can only ever speak to a VERTICAL (top/bottom) mismatch; a horizontal
    // mismatch simply never routes through this evidence, exactly as if it
    // had never been supplied. `!rotated` mirrors `hasFrameEvidence`'s own
    // discipline — pre-rotation segmentation is never trusted post-rotation.
    // Evaluated as DATA (never an immediate refusal) — see
    // `evaluateStructuralReflow`'s own doc for why: real orchestration
    // wiring (Phase 2B) proved a genuinely bordered/framed sign routinely
    // trips segmentation's ambiguity rule, and must still be able to reach
    // `reconstruct_parametric_frame` when independently valid frame
    // evidence exists.
    const reflowEvaluation: StructuralReflowEvaluation =
      !rotated && axis === "vertical" && input.structuralLayoutSegmentation !== undefined
        ? evaluateStructuralReflow(spec, policy, effectivePpi, input.structuralLayoutSegmentation)
        : { status: "not_applicable" };
    if (edgeDependentEdges.length > 0 || hasFrameEvidence || reflowEvaluation.status !== "not_applicable") {
      if (reflowEvaluation.status === "eligible") {
        // Preferred over `reconstruct_parametric_frame` for this shape —
        // see `SignPlanningInput.structuralLayoutSegmentation`'s own doc.
        defects.push({
          code: "structural_layout_reflow_proposed",
          severity: "review",
          detail:
            `The ${affectedEdges.join("/")} edges show a measurable banner-style structural layout (${reflowEvaluation.regions.length} ` +
            `regions, ${reflowEvaluation.gaps.length} measured gap(s)) — proposing a structural reflow onto the ordered straight-` +
            "rectangle production template: measured background fills extend to the new cut edges, spacing between " +
            "middle regions redistributes proportionally from the source's own gaps, and meaningful content is only " +
            "translated, never stretched. Always human-review-required, regardless of this evidence's strength.",
        });
        steps.push({
          kind: "reflow_structural_layout",
          params: encodeStructuralReflowParams(
            axis,
            totalPad,
            reflowEvaluation.template,
            reflowEvaluation.regions,
            reflowEvaluation.gaps,
          ),
          risk: "review_required",
          reasons: [
            "Edge-dependent/frame-like structure was detected, but the artwork's own perimeter is not what defines " +
              "the finished substrate boundary — a deterministic banner-style structural layout was measured instead, " +
              "and the ordered straight-rectangle production template is authoritative over it. Still requires human " +
              "production review before execution.",
          ],
        });
        // Deliberately skips the `hasFrameEvidence` frame-model branch, the
        // `reconstruct_perimeter_structure` tiling check, AND the outright-
        // block fallthrough below — see this input field's own doc for why
        // structural reflow evidence, once ELIGIBLE, is exclusive/
        // authoritative for this axis rather than falling back to either.
      } else if (hasFrameEvidence) {
        // `hasFrameEvidence` already established `input.frameStructuralModel`
        // is defined and not `"not_present"` — captured once here so
        // TypeScript's control-flow narrowing (which does not follow
        // through the multi-condition boolean above) has a single,
        // definitely-typed value for the rest of this branch.
        const frameResult = input.frameStructuralModel!;
        if (frameResult.status === "ambiguous") {
          defects.push({
            code: "perimeter_structure_at_extension_edge",
            severity: "blocking",
            detail:
              `The ${affectedEdges.join("/")} edge band(s) show a continuous, near-edge structure ` +
              "consistent with a frame, but its own geometry could not be measured with affirmative " +
              `cross-edge/cross-corner agreement: ${frameResult.reason}`,
          });
          return { status: "blocked", plan: null, defects };
        }
        if (frameResult.status !== "measured") {
          // Structurally unreachable: `hasFrameEvidence` already excluded
          // `"not_present"`, and `"ambiguous"` returned above.
          return { status: "blocked", plan: null, defects };
        }
        const model = frameResult.model;
        const leadingRunPx = input.frameCleanFillRunPx?.[affectedEdges[0]] ?? 0;
        const trailingRunPx = input.frameCleanFillRunPx?.[affectedEdges[1]] ?? 0;
        const totalRunPx = leadingRunPx + trailingRunPx;
        const leadingShare = totalRunPx > 0 ? leadingRunPx / totalRunPx : 0.5;
        const totalPad = leadingPx + trailingPx;
        const adaptedLeadingPx = Math.round(totalPad * leadingShare);
        const adaptedTrailingPx = totalPad - adaptedLeadingPx;

        defects.push({
          code: "parametric_frame_structure_reconstructed",
          severity: "review",
          detail:
            `The ${affectedEdges.join("/")} edge bands show a measurable concentric frame (band sequence ` +
            `depth ${model.frameDepthPx}px${model.cornerRadiusPx !== null ? `, corner radius ~${model.cornerRadiusPx}px` : ""}` +
            `${model.hole ? ", with repeated corner-hole indicators" : ""}) — proposing a parametric frame ` +
            "reconstruction built only from the customer's own measured geometry, never a block. Always " +
            "human-review-required (Constitution §16A.3 amendment 3.1), regardless of this evidence's strength.",
        });
        steps.push({
          kind: "reconstruct_parametric_frame",
          params: encodeFrameStructuralModelParams(axis, adaptedLeadingPx, adaptedTrailingPx, leadingShare, model),
          risk: "review_required",
          reasons: [
            "Edge-dependent structure was detected, and the perimeter measures as a genuine concentric " +
              "frame (band sequence, optional rounding, optional corner-hole indicators) with real, checkable " +
              "agreement across all four edges/corners — still requires human production review before execution.",
          ],
        });
        // Deliberately skips BOTH the `reconstruct_perimeter_structure`
        // tiling check AND the outright-block fallthrough below — a
        // measured frame model is a strictly MORE informative, more
        // semantically correct repair for this shape than either.
      } else if (edgeDependentEdges.length > 0) {
      // Production-Aware Perimeter Reconstruction Phase (Constitution
      // §16A.3 amendment 3.1): before refusing outright, check whether BOTH
      // affected edges (not just the one(s) that tripped edge-dependence
      // above — whatever fills the OTHER side of this axis must also be
      // provably safe) cleared `perimeter-reconstruction.ts`'s affirmative
      // uniform-per-line evidence bar. Reconstructability is independent of
      // — and strictly narrower than — mere edge-dependence: a band can be
      // edge-dependent (content reaches the edge) yet still not
      // reconstructable (that content isn't a uniform, tileable pattern),
      // and that combination still blocks, unchanged from the prior phase.
      // Scope limit (deliberate, not yet lifted): `reconstruct_perimeter_
      // structure` never coexists with `reconstruct_resolution` in the same
      // plan. The band was measured at the SOURCE image's own pixel
      // geometry, before any provider reconstruction would scale it up —
      // combining the two needs the measured band depth/colours to be
      // re-derived proportionally against whatever the provider actually
      // returns, which `sign-transform-executor.ts`'s S3C adaptive-geometry
      // machinery does not yet know how to do for this step kind. Blocking
      // here (never silently falling back to `pad_uniform_background`) is
      // the honest answer until that combination gets its own audited work.
      const alreadyNeedsProviderReconstruction = steps.some(
        (step) => step.kind === "reconstruct_resolution",
      );
      const leadingBand = input.perimeterBands?.find((band) => band.edge === affectedEdges[0]);
      const trailingBand = input.perimeterBands?.find((band) => band.edge === affectedEdges[1]);
      const reconstructable =
        !alreadyNeedsProviderReconstruction &&
        Boolean(leadingBand?.reconstructable && trailingBand?.reconstructable);

      defects.push({
        code: "perimeter_structure_at_extension_edge",
        // "blocking" only when no admitted repair actually resolves it — a
        // plan this defect still allowed to be PRODUCED (the reconstructed
        // case below) never carries a blocking-severity defect, so nothing
        // downstream that scans severity has to know this code exists.
        severity: reconstructable ? "review" : "blocking",
        detail:
          `The ${edgeDependentEdges.join(" and ")} edge band(s) show a continuous, near-edge ` +
          "structure (outermost coverage " +
          edgeDependentEdges
            .map((edge) => edgeByName(inspection.edges, edge).outermostCoverage.toFixed(4))
            .join("/") +
          ", longest non-background run " +
          edgeDependentEdges
            .map((edge) => edgeByName(inspection.edges, edge).longestNonBackgroundRunPx)
            .join("/") +
          "px) consistent with artwork whose meaning depends on the finished substrate edge.",
      });

      if (reconstructable && leadingBand && trailingBand) {
        defects.push({
          code: "perimeter_structure_reconstructed",
          severity: "review",
          detail:
            `Both ${affectedEdges.join("/")} edge bands cleared the affirmative uniform-per-line evidence ` +
            "bar (perimeter-reconstruction.ts) — proposing a bounded, non-generative reconstruction built " +
            "only from the customer's own measured pixels, never a block. Always human-review-required " +
            "(Constitution §16A.3 amendment 3.1), regardless of this evidence's strength.",
        });
        steps.push({
          kind: "reconstruct_perimeter_structure",
          params: encodePerimeterBandsParams(axis, leadingPx, trailingPx, leadingBand, trailingBand),
          risk: "review_required",
          reasons: [
            "Edge-dependent structure was detected, but both affected edges are affirmatively uniform " +
              "enough per measured line to reconstruct by tiling the customer's own pixels outward — " +
              "still requires human production review before execution.",
          ],
        });
      } else {
        return { status: "blocked", plan: null, defects };
      }
      } else {
      // Structural Layout Reflow Phase 2B: reached only when structural
      // reflow evidence was supplied and NOT eligible (`"ambiguous"` or
      // `"insufficient"` — see `evaluateStructuralReflow`), and neither
      // frame evidence nor edge-dependent structure independently
      // justifies a different repair. The ONLY remaining admitted answer
      // is to refuse honestly, rather than falling through to
      // `bothUniform`'s ordinary background-extension path below — which
      // would silently treat unresolved structural evidence as safe.
      // Mirrors the identical discipline `hasFrameEvidence`'s own
      // ambiguous/insufficient sub-cases already apply.
      if (reflowEvaluation.status === "not_applicable") {
        // Structurally unreachable: the outer condition already guarantees
        // at least one of {eligible, hasFrameEvidence, edgeDependentEdges,
        // reflowEvaluation !== "not_applicable"} holds, and the first three
        // are excluded by the time control reaches here — kept only so
        // TypeScript's narrowing has a definite type for the rest of this
        // branch.
        return { status: "blocked", plan: null, defects };
      }
      defects.push({
        code: "perimeter_structure_at_extension_edge",
        severity: "blocking",
        detail:
          reflowEvaluation.status === "ambiguous"
            ? `The ${affectedEdges.join("/")} edge structural layout could not be resolved: ${reflowEvaluation.reason} ` +
              "Never guessed — this axis has no admitted repair without affirmative segmentation evidence."
            : `Structural layout reflow evidence for the ${affectedEdges.join("/")} edges is insufficient to propose ` +
              `a repair: ${reflowEvaluation.failures.join("; ")}. Never guessed — this axis has no admitted repair ` +
              "without sufficient affirmative evidence.",
      });
      return { status: "blocked", plan: null, defects };
      } // closes the `frameStructuralModel` not-present/absent fallback branch opened above.
    } else {

    const bothUniform =
      !rotated &&
      first.classification === "uniform_background" &&
      second.classification === "uniform_background";

    if (bothUniform && first.dominantColor && second.dominantColor) {
      const color = {
        r: Math.round((first.dominantColor.r + second.dominantColor.r) / 2),
        g: Math.round((first.dominantColor.g + second.dominantColor.g) / 2),
        b: Math.round((first.dominantColor.b + second.dominantColor.b) / 2),
      };
      steps.push({
        kind: "extend_uniform_background",
        params: {
          axis,
          leadingPx,
          trailingPx,
          colorR: color.r,
          colorG: color.g,
          colorB: color.b,
        },
        risk: "auto_safe",
        reasons: [
          `Both ${affectedEdges.join("/")} edge bands are affirmatively uniform background ` +
            `(coverage ${first.dominantCoverage.toFixed(4)} / ${second.dominantCoverage.toFixed(4)}); ` +
            "continuing the measured background is deterministic and touches no foreground pixel.",
        ],
      });
    } else {
      const params: Record<string, number | string> = {
        axis,
        leadingPx,
        trailingPx,
      };
      if (first.dominantColor && second.dominantColor) {
        params.colorR = Math.round(
          (first.dominantColor.r + second.dominantColor.r) / 2,
        );
        params.colorG = Math.round(
          (first.dominantColor.g + second.dominantColor.g) / 2,
        );
        params.colorB = Math.round(
          (first.dominantColor.b + second.dominantColor.b) / 2,
        );
      } else {
        params.color = "unconfirmed";
      }
      const seamReasons = affectedEdges
        .map((edge) => {
          const evidence = edgeByName(inspection.edges, edge);
          return `${edge}: ${evidence.classification}`;
        })
        .join("; ");
      steps.push({
        kind: "pad_uniform_background",
        params,
        risk: "review_required",
        reasons: [
          rotated
            ? "Edge evidence was measured pre-rotation; a human must confirm the fill against the rotated artwork."
            : `Extension edges are not provably uniform background (${seamReasons}) — the fill terminates content visibly and a human must approve the seam.`,
        ],
      });
      if (
        !rotated &&
        (first.classification === "foreground_bleed" ||
          second.classification === "foreground_bleed")
      ) {
        defects.push({
          code: "foreground_reaches_extension_edge",
          severity: "review",
          detail:
            `Foreground provably reaches the ${affectedEdges
              .filter(
                (edge) =>
                  edgeByName(inspection.edges, edge).classification ===
                  "foreground_bleed",
              )
              .join(" and ")} edge band(s); extending there creates a visible termination seam.`,
        });
      }
    }
    }
  }

  // ---------------------------------------------------------------------
  // Aggregate risk. Review-severity defects (e.g. transparency_present)
  // escalate the whole plan; uncertainty never downgrades to safe.
  // ---------------------------------------------------------------------
  let overallRisk: SignRiskClass = "auto_safe";
  for (const step of steps) overallRisk = maxRisk(overallRisk, step.risk);
  for (const defect of defects) {
    if (defect.severity === "review") {
      overallRisk = maxRisk(overallRisk, "review_required");
    }
  }
  if (
    overallRisk === "review_required" &&
    !defects.some((defect) => defect.code === "repair_requires_review")
  ) {
    defects.push({
      code: "repair_requires_review",
      severity: "review",
      detail:
        "The formulated plan is mechanically executable but requires human judgment before execution.",
    });
  }

  const expectedEffectivePpi = plateH / spec.orderedHeightIn;

  const planWithoutKey: Omit<SignRepairPlan, "planKey"> = {
    schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
    policyId: policy.id,
    sourceAssetId: input.sourceAssetId,
    sourceSha256: input.sourceSha256,
    sourceWidthPx: inspection.source.widthPx,
    sourceHeightPx: inspection.source.heightPx,
    orderedWidthIn: spec.orderedWidthIn,
    orderedHeightIn: spec.orderedHeightIn,
    steps,
    expectedOutputWidthPx: plateW,
    expectedOutputHeightPx: plateH,
    expectedEffectivePpi,
    overallRisk,
    defects: defects.map((defect) => defect.code),
    reasons,
  };

  const planKey = computeSignPlanKey(planWithoutKey);
  return {
    status: "planned",
    plan: { ...planWithoutKey, planKey },
    defects,
  };
}
