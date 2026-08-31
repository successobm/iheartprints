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
    case "rotate_90":
      return describeRotate(step);
    case "approved_crop":
      return describeApprovedCrop();
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
