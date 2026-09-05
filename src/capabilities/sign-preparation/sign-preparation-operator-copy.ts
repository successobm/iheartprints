/**
 * LIVE PRODUCT BLOCKER #4A: presentation-only translation of Signs planning
 * output into OPERATOR language — the internal counterpart to
 * `sign-preparation-copy.ts`'s `describeSignPlanForCustomer`.
 *
 * Same discipline as the customer module: pure, deterministic functions
 * from already-decided domain facts to strings. This module NEVER inspects
 * artwork, NEVER diagnoses a defect, and NEVER formulates a repair step —
 * every fact it renders was already decided by `sign-inspection.ts` /
 * `sign-diagnosis.ts` / `sign-repair-planner.ts`. It only decides what to
 * SAY about a decision that has already been made, to an audience (an
 * internal production operator) who needs more production detail than a
 * customer but still not raw plan JSON.
 *
 * Reuses `describeSignPlanForCustomer` for `findings` rather than
 * duplicating the defect-code vocabulary — one translation authority for
 * "what's wrong with this artwork", not two that could drift apart. Never
 * imports FROM this module back into the customer module, and never
 * changes that module's own behaviour.
 *
 * `SignRepairStepKind`, `SignEdgeClassification`, `planKey`, and every
 * other internal identifier stop here, same as the customer module — an
 * operator gets a labelled, plain-language sentence, never a bare code.
 */

import type {
  SignEdge,
  SignEdgeClassification,
  SignInspectionReport,
  SignRepairPlan,
  SignRepairStep,
  SignRiskClass,
} from "./contracts";
import { describeSignPlanForCustomer } from "./sign-preparation-copy";

/** One production step, translated for an operator deciding whether to authorize it. */
export interface SignPlanOperatorStepView {
  /** What this step does, in plain production language. Never a bare `SignRepairStepKind`. */
  summary: string;
  /** The step's actual parameters, translated. `null` when nothing further is available. */
  detail: string | null;
  /** True when THIS step is why the plan needs a human before production. */
  needsReview: boolean;
  /** Why this specific step needs review. `null` when `needsReview` is false. */
  reviewReason: string | null;
}

export interface SignPlanOperatorView {
  /** e.g. "Needs production review" — never the bare `SignRiskClass` value. */
  riskLabel: string;
  /**
   * False only when the plan could not be formulated at all — defensive:
   * a durably persisted plan is never actually `overallRisk === "blocked"`
   * (a blocked outcome carries no plan, by construction in
   * `sign-repair-planner.ts`), but the page that renders "Authorize plan"
   * reads this rather than a raw `SignRiskClass` so no internal vocabulary
   * needs to cross that boundary either.
   */
  canAuthorize: boolean;
  orderedWidthIn: number;
  orderedHeightIn: number;
  artworkWidthPx: number;
  artworkHeightPx: number;
  /** Reused verbatim from `describeSignPlanForCustomer` — one findings authority. */
  findings: string[];
  /** In plan order. Only steps the plan actually contains — nothing fabricated. */
  steps: SignPlanOperatorStepView[];
}

export interface DescribeSignPlanForOperatorInput {
  orderedWidthIn: number;
  orderedHeightIn: number;
  artworkWidthPx: number;
  artworkHeightPx: number;
  /** The persisted, deterministic edge/geometry facts the plan's steps were formulated from. */
  inspection: SignInspectionReport;
  plan: SignRepairPlan;
}

const RISK_LABEL: Record<SignRiskClass, string> = {
  auto_safe: "No production review needed",
  review_required: "Needs production review",
  // Defensive only: a durable plan's `overallRisk` is never actually
  // `"blocked"` (mirrors the identical defensive note in
  // `sign-preparation-copy.ts`'s `statusFor`) — a blocked outcome carries
  // no plan at all, by construction in `sign-repair-planner.ts`.
  blocked: "Could not be planned automatically",
};

/**
 * The one entry point. Takes exactly what the durable `SignPreparation` row
 * already carries (a real, persisted `SignRepairPlan` and the
 * `SignInspectionReport` it was formulated from) and renders it for an
 * internal operator deciding whether to authorize THIS exact plan.
 */
export function describeSignPlanForOperator(
  input: DescribeSignPlanForOperatorInput,
): SignPlanOperatorView {
  const customerView = describeSignPlanForCustomer({
    orderedWidthIn: input.orderedWidthIn,
    orderedHeightIn: input.orderedHeightIn,
    artworkWidthPx: input.artworkWidthPx,
    artworkHeightPx: input.artworkHeightPx,
    defectCodes: input.plan.defects,
    plan: input.plan,
  });

  return {
    riskLabel: RISK_LABEL[input.plan.overallRisk],
    canAuthorize: input.plan.overallRisk !== "blocked",
    orderedWidthIn: input.orderedWidthIn,
    orderedHeightIn: input.orderedHeightIn,
    artworkWidthPx: input.artworkWidthPx,
    artworkHeightPx: input.artworkHeightPx,
    findings: customerView.findings,
    steps: input.plan.steps.map((step) => describeStepForOperator(step, input.inspection)),
  };
}

function describeStepForOperator(
  step: SignRepairStep,
  inspection: SignInspectionReport,
): SignPlanOperatorStepView {
  switch (step.kind) {
    case "reconstruct_resolution":
      return describeReconstruct(step);
    case "downsample":
      return describeDownsample(step);
    case "extend_uniform_background":
    case "pad_uniform_background":
      return describePad(step, inspection);
    case "reconstruct_perimeter_structure":
      return describeReconstructPerimeter(step);
    case "reconstruct_parametric_frame":
      return describeReconstructParametricFrame(step);
    case "reflow_structural_layout":
      return describeReflowStructuralLayout(step);
    case "rotate_90":
      return describeRotate(step);
    case "approved_crop":
      return describeApprovedCrop();
    case "fit_artwork_to_canvas":
      return describeFitArtworkToCanvas(step);
    case "crop_region":
      return describeCropRegion(step);
    case "move_region":
      return describeMoveRegion(step);
    case "fill_rect":
      return describeFillRect(step);
    case "replace_region_with_background":
      return describeReplaceRegionWithBackground(step);
    case "replace_masked_region_with_background":
      return describeReplaceMaskedRegionWithBackground(step);
    default:
      // Unreachable for any kind this build's planner emits — mirrors the
      // customer module's "silently omit an unmapped code" discipline
      // rather than leaking a bare internal spelling.
      return {
        summary: "A production adjustment is proposed for this artwork.",
        detail: null,
        needsReview: step.risk !== "auto_safe",
        reviewReason:
          step.risk !== "auto_safe" ? "This adjustment requires production review." : null,
      };
  }
}

function numberParam(step: SignRepairStep, key: string): number | null {
  const value = step.params[key];
  return typeof value === "number" ? value : null;
}

function stringParam(step: SignRepairStep, key: string): string | null {
  const value = step.params[key];
  return typeof value === "string" ? value : null;
}

function describeReconstruct(step: SignRepairStep): SignPlanOperatorStepView {
  const w = numberParam(step, "requestedWidthPx");
  const h = numberParam(step, "requestedHeightPx");
  const scale = numberParam(step, "requestedScale");
  const parts: string[] = [];
  if (w !== null && h !== null) parts.push(`Target size: about ${w} × ${h} px`);
  if (scale !== null) parts.push(`(${scale.toFixed(2)}× the original)`);

  const needsReview = step.risk !== "auto_safe";
  return {
    summary: "Increase the artwork's resolution for the ordered print size.",
    detail: parts.length ? parts.join(" ") : null,
    needsReview,
    reviewReason: needsReview
      ? "Increasing the resolution changes the artwork's pixels, so this requires production review."
      : null,
  };
}

function describeDownsample(step: SignRepairStep): SignPlanOperatorStepView {
  const w = numberParam(step, "targetWidthPx");
  const h = numberParam(step, "targetHeightPx");
  const needsReview = step.risk !== "auto_safe";
  return {
    summary: "Reduce the artwork's resolution to the production target.",
    detail: w !== null && h !== null ? `Target size: ${w} × ${h} px` : null,
    needsReview,
    reviewReason: needsReview ? "This resolution adjustment requires production review." : null,
  };
}

function edgesForAxis(axis: string | null): [SignEdge, SignEdge] | null {
  if (axis === "vertical") return ["top", "bottom"];
  if (axis === "horizontal") return ["left", "right"];
  return null;
}

/** Plain-language description of the fill colour — never a bare hex/RGB dump with no label. */
function colorDescription(step: SignRepairStep): string | null {
  const colorLabel = stringParam(step, "color");
  if (colorLabel === "unconfirmed") {
    return "a fill colour that could not be confidently determined";
  }
  const r = numberParam(step, "colorR");
  const g = numberParam(step, "colorG");
  const b = numberParam(step, "colorB");
  if (r === null || g === null || b === null) return null;
  const brightness = (r + g + b) / 3;
  const shade = brightness >= 235 ? "a near-white" : brightness <= 20 ? "a near-black" : "a detected background";
  return `${shade} fill (RGB ${r}, ${g}, ${b})`;
}

function describePad(step: SignRepairStep, inspection: SignInspectionReport): SignPlanOperatorStepView {
  const axis = stringParam(step, "axis");
  const leading = numberParam(step, "leadingPx");
  const trailing = numberParam(step, "trailingPx");
  const edges = edgesForAxis(axis);
  const color = colorDescription(step);
  const needsReview = step.risk !== "auto_safe";

  let detail: string | null = null;
  if (edges && leading !== null && trailing !== null) {
    const [leadEdge, trailEdge] = edges;
    const sizePhrase =
      leading === trailing
        ? `${leading} px to the ${leadEdge} and ${trailEdge}`
        : `${leading} px to the ${leadEdge} and ${trailing} px to the ${trailEdge}`;
    detail = color ? `Add ${sizePhrase}, using ${color}.` : `Add ${sizePhrase}.`;
  }

  let reviewReason: string | null = null;
  if (needsReview) {
    const clauses = edges
      ? edges
          .map((edge) => edgeReviewClause(edge, inspection))
          .filter((clause): clause is string => clause !== null)
      : [];
    reviewReason =
      clauses.length > 0
        ? `${capitalize(joinClauses(clauses))}. The added area could create a visible seam, so this adjustment requires production review.`
        : "The edges being extended could not be confirmed as safe uniform background, so this adjustment requires production review.";
  }

  return {
    summary: "Add space around the design so it fits the ordered sign size, without stretching or trimming the artwork.",
    detail,
    needsReview,
    reviewReason,
  };
}

/**
 * Production-Aware Perimeter Reconstruction Phase (Constitution §16A.3
 * amendment 3.1). Always `needsReview` — this repair is constitutionally
 * never `auto_safe` — and the copy is explicit that corner/hole indicators
 * are NOT part of what this repair does, so an operator never assumes a
 * mark they see near a corner was checked or moved when it was not.
 */
function describeReconstructPerimeter(step: SignRepairStep): SignPlanOperatorStepView {
  const axis = stringParam(step, "axis");
  const leading = numberParam(step, "leadingPx");
  const trailing = numberParam(step, "trailingPx");
  const edges = edgesForAxis(axis);

  let detail: string | null = null;
  if (edges && leading !== null && trailing !== null) {
    const [leadEdge, trailEdge] = edges;
    detail =
      `Extend the ${leadEdge} edge by ${leading}px and the ${trailEdge} edge by ${trailing}px, ` +
      "continuing the design's own measured border/edge pattern outward from each edge — every added pixel is a colour " +
      "already present in the customer's artwork, never invented.";
  }

  return {
    summary: "Reconstruct the artwork's own border/edge design outward to reach the finished sign's edges.",
    detail,
    needsReview: true,
    reviewReason:
      "This repair changes the artwork's perimeter geometry to match the finished sign size, so a human must confirm " +
      "the result before production — including checking the corners, since this repair does NOT detect or reposition " +
      "any mounting-hole or corner indicator; if one is present, verify its placement manually.",
  };
}

/**
 * Parametric Frame Reconstruction Phase (Constitution §16A.3 amendment 3.1's
 * own bounded carve-out, extended). Unlike `describeReconstructPerimeter`,
 * this repair DOES measure and reconstruct rounded corners and corner-hole
 * indicators when the plan's own persisted frame model actually contains
 * them (`sign-repair-planner.ts`'s `encodeFrameStructuralModelParams`) —
 * every conditional sentence below reads that SAME plan evidence rather
 * than assuming the artwork has either feature. Never claims a feature the
 * plan's own model did not measure, and never describes either as a
 * MANUFACTURING specification (drill diameter, hardware size, a physical
 * corner radius) — both are the customer's own ARTWORK graphics being
 * preserved/repositioned, exactly like every other pixel in the interior.
 */
function describeReconstructParametricFrame(step: SignRepairStep): SignPlanOperatorStepView {
  const axis = stringParam(step, "axis");
  const leading = numberParam(step, "leadingPx");
  const trailing = numberParam(step, "trailingPx");
  const edges = edgesForAxis(axis);
  const cornerRadiusPx = numberParam(step, "cornerRadiusPx");
  // `-1` is the planner's own persisted sentinel for "no rounding measured"
  // (`encodeFrameStructuralModelParams`) — never treat it as a real radius.
  const hasRoundedCorners = cornerRadiusPx !== null && cornerRadiusPx >= 0;
  const hasHole = stringParam(step, "hasHole") === "true";

  const detailParts: string[] = [
    "Rebuild the artwork's own measured frame/border at the finished sign edges while preserving the central artwork.",
  ];
  if (edges && leading !== null && trailing !== null) {
    const [leadEdge, trailEdge] = edges;
    detailParts.push(
      leading === trailing
        ? `The frame moves outward by ${leading}px on the ${leadEdge} and ${trailEdge} edges to reach the new boundary.`
        : `The frame moves outward by ${leading}px on the ${leadEdge} edge and ${trailing}px on the ${trailEdge} edge to reach the new boundary.`,
    );
  }
  if (hasRoundedCorners) {
    detailParts.push("Preserves the artwork's existing rounded-corner treatment at the frame's corners.");
  }
  if (hasHole) {
    detailParts.push(
      "Repositions the artwork's four existing corner-hole indicators with the reconstructed frame — these are the customer's own graphic elements, not a manufacturing drilling instruction.",
    );
  }
  detailParts.push("The customer's artwork will not be stretched.");

  const reviewClauses: string[] = [
    "this repair discards the artwork's own old frame/border and redraws it at the finished sign edges",
  ];
  if (hasHole) {
    reviewClauses.push("all four corner-hole indicators reconstructed correctly with none lost or duplicated");
  }
  if (hasRoundedCorners) {
    reviewClauses.push("every corner's rounding looks consistent");
  }

  return {
    summary: "Adapt the sign's perimeter artwork to the ordered size.",
    detail: detailParts.join(" "),
    needsReview: true,
    reviewReason: `A human must confirm the result before production: ${joinClauses(reviewClauses)}.`,
  };
}

/**
 * Structural Layout Reflow Phase 2 (Planner Wiring): the operator-facing
 * translation of a `reflow_structural_layout` step. Generic production
 * language throughout — never the customer's own wording, never a literal
 * quote of any region's content, and never a manufacturing claim; only
 * what MOVES (structural sections, spacing) and what stays fixed
 * (meaningful content, never stretched). Every figure below is read from
 * the plan's own persisted params (`encodeStructuralReflowParams`) —
 * nothing here is invented or assumed about a specific sign.
 */
function describeReflowStructuralLayout(step: SignRepairStep): SignPlanOperatorStepView {
  const regionCount = numberParam(step, "regionCount");
  const gapCount = numberParam(step, "gapCount");
  const templateWidthIn = numberParam(step, "templateWidthIn");
  const templateHeightIn = numberParam(step, "templateHeightIn");
  const minimumSafeInsetIn = numberParam(step, "templateMinimumSafeInsetIn");
  const middleCount = regionCount !== null ? Math.max(0, regionCount - 2) : null;

  const detailParts: string[] = [
    "Create the ordered, straight-edged rectangular production area — the artwork's own perimeter shape (a rounded corner, a drawn border, or similar) never defines the finished substrate boundary.",
    "Anchor the artwork's first structural section to the top of that area and its last structural section to the bottom.",
  ];
  if (middleCount !== null) {
    detailParts.push(
      middleCount > 0
        ? `Keep the ${middleCount} structural section${middleCount === 1 ? "" : "s"} between them in the same order, unchanged.`
        : "There are no structural sections between the top and bottom anchors.",
    );
  }
  detailParts.push(
    "Only the measured background fill behind the top and bottom sections extends to reach the new cut edges — nothing is generated or invented.",
  );
  if (gapCount !== null && gapCount > 0) {
    detailParts.push(
      `Redistribute the added space across the ${gapCount} measured gap${gapCount === 1 ? "" : "s"} already present in the source layout, in proportion to each gap's own size.`,
    );
  }
  if (minimumSafeInsetIn !== null) {
    detailParts.push(`Meaningful content stays at least ${minimumSafeInsetIn}in inside every cut edge.`);
  }
  detailParts.push("The artwork itself is only repositioned, never stretched or resized non-uniformly.");
  if (templateWidthIn !== null && templateHeightIn !== null) {
    detailParts.push(`Production area: ${templateWidthIn} × ${templateHeightIn}in.`);
  }

  return {
    summary:
      "Rebuild the sign's layout on the ordered straight-rectangle production area, anchoring the top and bottom sections and redistributing the space between them.",
    detail: detailParts.join(" "),
    needsReview: true,
    reviewReason:
      "This repair moves structural artwork sections to fit the ordered size, so a human must confirm the result " +
      "before production — including that meaningful content stayed inside the safety area and nothing was stretched.",
  };
}

function edgeReviewClause(edge: SignEdge, inspection: SignInspectionReport): string | null {
  const evidence = inspection.edges.find((candidate) => candidate.edge === edge);
  if (!evidence) return null;
  return clauseForClassification(edge, evidence.classification);
}

function clauseForClassification(edge: SignEdge, classification: SignEdgeClassification): string | null {
  if (classification === "mixed_or_uncertain") {
    return `the artwork at the ${edge} edge is not clearly uniform background`;
  }
  if (classification === "foreground_bleed") {
    return `part of the design reaches the ${edge} edge`;
  }
  // uniform_background never drives a review reason on its own.
  return null;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0]!;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

function capitalize(sentence: string): string {
  return sentence.length ? sentence[0]!.toUpperCase() + sentence.slice(1) : sentence;
}

function describeRotate(step: SignRepairStep): SignPlanOperatorStepView {
  const needsReview = step.risk !== "auto_safe";
  return {
    summary: "Rotate the artwork 90° to better match the sign's proportions.",
    detail: null,
    needsReview,
    reviewReason: needsReview
      ? "Rotating changes how the design will appear on the sign, so a human must confirm it before this proceeds."
      : null,
  };
}

function describeApprovedCrop(): SignPlanOperatorStepView {
  return {
    summary: "Trim part of the artwork to fit the ordered size exactly.",
    detail: null,
    needsReview: true,
    reviewReason: "Trimming could remove part of the design, so this requires production review.",
  };
}

/**
 * Signs Flat-Raster Production Workflow Correction (Section E/F/H): the
 * ONE whole-composition remedy — never a per-object edit. Distinguishes,
 * using ONLY the step's own persisted params (never a fresh measurement,
 * never the historical original source), between:
 *
 *  - a genuine "Fit to Safe Area" reduction — `scaleTargetWidthPx`/
 *    `scaleTargetHeightPx` are present (they are ONLY ever persisted when
 *    an operator-requested safe-area inset produced a scale target
 *    smaller than the canvas — `encodeFitArtworkToCanvasParams`'s own
 *    doc), and
 *  - the ORDINARY "place the artwork on the ordered canvas" step every
 *    sign's initial composition plan already contains (no inset
 *    requested — the two fields are simply absent).
 *
 * The applied scale is derived from `expectedArtworkWidthPx`/
 * `expectedArtworkHeightPx` — the EXACT dimensions
 * `executeFitArtworkToCanvas` itself validates the incoming artwork
 * against before scaling it — never the plan's own `sourceWidthPx`/
 * `sourceHeightPx` (a different, pre-composition, possibly-reconstructed-
 * from stage). Omitted entirely rather than fabricated when the numbers
 * needed to compute it safely aren't all present.
 */
function describeFitArtworkToCanvas(step: SignRepairStep): SignPlanOperatorStepView {
  const canvasWidthPx = numberParam(step, "canvasWidthPx");
  const canvasHeightPx = numberParam(step, "canvasHeightPx");
  const expectedArtworkWidthPx = numberParam(step, "expectedArtworkWidthPx");
  const expectedArtworkHeightPx = numberParam(step, "expectedArtworkHeightPx");
  const scaleTargetWidthPx = numberParam(step, "scaleTargetWidthPx");
  const scaleTargetHeightPx = numberParam(step, "scaleTargetHeightPx");
  const needsReview = step.risk !== "auto_safe";

  const isSafeAreaFit = scaleTargetWidthPx !== null && scaleTargetHeightPx !== null;

  let scalePercent: number | null = null;
  const targetWidthPx = scaleTargetWidthPx ?? canvasWidthPx;
  const targetHeightPx = scaleTargetHeightPx ?? canvasHeightPx;
  if (
    expectedArtworkWidthPx !== null && expectedArtworkWidthPx > 0 &&
    expectedArtworkHeightPx !== null && expectedArtworkHeightPx > 0 &&
    targetWidthPx !== null && targetHeightPx !== null
  ) {
    const scale = Math.min(targetWidthPx / expectedArtworkWidthPx, targetHeightPx / expectedArtworkHeightPx);
    if (Number.isFinite(scale) && scale > 0) scalePercent = scale * 100;
  }

  if (isSafeAreaFit) {
    const detailParts: string[] = [];
    if (scalePercent !== null) detailParts.push(`Artwork scale: ${scalePercent.toFixed(1)}%.`);
    detailParts.push("Background will extend to the cut edge.");
    detailParts.push("Aspect ratio will be preserved. Artwork will not be stretched.");
    return {
      summary: "Reduce the complete artwork slightly so important content stays inside the 0.125\" safe area.",
      detail: detailParts.join(" "),
      needsReview,
      reviewReason: needsReview
        ? "Repositioning the whole composition changes where content sits relative to the cut edge, so this requires production review."
        : null,
    };
  }

  return {
    summary: "Place the artwork on the exact ordered production canvas.",
    detail: "Any uncovered edge is filled with the artwork's own background. The artwork itself is not stretched or cropped.",
    needsReview,
    reviewReason: needsReview
      ? "Placing the artwork on the production canvas changes its pixels, so this requires production review."
      : null,
  };
}

function describeCropRegion(step: SignRepairStep): SignPlanOperatorStepView {
  const widthPx = numberParam(step, "widthPx");
  const heightPx = numberParam(step, "heightPx");
  const needsReview = step.risk !== "auto_safe";
  return {
    summary: "Crop the artwork to the operator-selected area before production.",
    detail: widthPx !== null && heightPx !== null ? `Cropped size: ${widthPx} × ${heightPx} px.` : null,
    needsReview,
    reviewReason: needsReview ? "Cropping could remove part of the design, so this requires production review." : null,
  };
}

function describeMoveRegion(step: SignRepairStep): SignPlanOperatorStepView {
  const sourceStartYPx = numberParam(step, "sourceStartYPx");
  const heightPx = numberParam(step, "heightPx");
  const destStartYPx = numberParam(step, "destStartYPx");
  const needsReview = step.risk !== "auto_safe";
  return {
    summary: "Move a horizontal band of the artwork to a new position.",
    detail:
      sourceStartYPx !== null && heightPx !== null && destStartYPx !== null
        ? `A ${heightPx}px-tall band moves from y ${sourceStartYPx} to y ${destStartYPx}.`
        : null,
    needsReview,
    reviewReason: needsReview
      ? "Moving artwork changes its position relative to the cut edge, so this requires production review."
      : null,
  };
}

function describeFillRect(step: SignRepairStep): SignPlanOperatorStepView {
  const widthPx = numberParam(step, "widthPx");
  const heightPx = numberParam(step, "heightPx");
  const color = colorDescription(step);
  const needsReview = step.risk !== "auto_safe";
  const sizePhrase = widthPx !== null && heightPx !== null ? `a ${widthPx} × ${heightPx} px area` : "a selected area";
  return {
    summary: "Fill a selected area with a solid colour.",
    detail: color ? `Fill ${sizePhrase} with ${color}.` : `Fill ${sizePhrase}.`,
    needsReview,
    reviewReason: needsReview ? "Filling artwork with a solid colour changes its pixels, so this requires production review." : null,
  };
}

function describeReplaceRegionWithBackground(step: SignRepairStep): SignPlanOperatorStepView {
  const widthPx = numberParam(step, "widthPx");
  const heightPx = numberParam(step, "heightPx");
  const color = colorDescription(step);
  const needsReview = step.risk !== "auto_safe";
  const sizePhrase = widthPx !== null && heightPx !== null ? `a ${widthPx} × ${heightPx} px area` : "a selected area";
  return {
    summary: "Remove a selected artifact and fill it with the surrounding background.",
    detail: color ? `Replace ${sizePhrase} with ${color}, independently verified as the actual surrounding colour.` : null,
    needsReview,
    reviewReason: needsReview ? "Removing artwork could delete something meaningful, so this requires production review." : null,
  };
}

function describeReplaceMaskedRegionWithBackground(step: SignRepairStep): SignPlanOperatorStepView {
  const color = colorDescription(step);
  const needsReview = step.risk !== "auto_safe";
  return {
    summary: "Remove a selected artifact — its exact shape, not just a box around it — and fill it with the surrounding background.",
    detail: color ? `Fill with ${color}, independently verified as the actual surrounding colour.` : null,
    needsReview,
    reviewReason: needsReview ? "Removing artwork could delete something meaningful, so this requires production review." : null,
  };
}
