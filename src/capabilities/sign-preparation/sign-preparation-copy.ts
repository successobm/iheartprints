/**
 * LIVE PRODUCT BLOCKER #3: presentation-only translation of Signs planning
 * output into customer language.
 *
 * Mirrors `artwork-preparation/preparation-copy.ts`'s role exactly: pure,
 * deterministic functions from already-decided domain facts to strings. This
 * module NEVER inspects artwork, NEVER diagnoses a defect, and NEVER
 * formulates a repair step — every fact it renders was already decided by
 * `sign-inspection.ts` / `sign-diagnosis.ts` / `sign-repair-planner.ts`. It
 * only decides what to SAY about a decision that has already been made.
 *
 * Every internal identifier this module receives — `SignDefectCode`,
 * `SignRepairStepKind`, `resolutionPolicyId`, `planKey` — stops here. Not
 * one of them appears in any string this module returns.
 */

import type {
  SignDefectCode,
  SignRepairPlan,
  SignRepairStep,
  SignRepairStepKind,
} from "./contracts";

/**
 * `"ready"`       — the engine formulated a plan it considers safe to
 *                   propose automatically.
 * `"needs_review"`— the engine formulated a plan, but it needs a human's
 *                   review/approval before it may run.
 * `"blocked"`      — the engine could not formulate an acceptable automated
 *                   repair at all. A valid, honest product result — never
 *                   collapsed into a generic error.
 */
export type SignPlanCustomerStatus = "ready" | "needs_review" | "blocked";

/**
 * The deliberately narrow customer-facing view of one planning outcome.
 * Never includes `resolutionPolicyId`, `planKey`, defect codes, or step
 * kinds — only plain figures and already-translated sentences.
 */
export interface SignPlanCustomerView {
  status: SignPlanCustomerStatus;
  orderedWidthIn: number;
  orderedHeightIn: number;
  artworkWidthPx: number;
  artworkHeightPx: number;
  /** Plain-language observations, deduplicated, in no particular priority order. */
  findings: string[];
  /** Plain-language description of what the plan proposes. `null` when blocked, or when nothing needs to change. */
  proposedAction: string | null;
  reviewRequired: boolean;
  /** Whether iHeartPrints believes it can prepare this artwork at all — false only when blocked. */
  canProceed: boolean;
}

export interface DescribeSignPlanInput {
  orderedWidthIn: number;
  orderedHeightIn: number;
  artworkWidthPx: number;
  artworkHeightPx: number;
  /**
   * Just the codes — works identically whether sourced from a freshly
   * computed `SignDefect[]` (via `.map(d => d.code)`) or from a persisted
   * `SignRepairPlan.defects`, so the SAME translation runs for a
   * just-planned result and for one reconstructed from the durable
   * `SignPreparation` row on reload.
   */
  defectCodes: readonly SignDefectCode[];
  /** `null` for a blocked outcome — never a fabricated plan. */
  plan: SignRepairPlan | null;
}

/**
 * The one entry point. Takes exactly what `SignPreparationCapability`
 * already decided (fresh from `planSignRepair`, or reconstructed from a
 * persisted `SignPreparation` row) and renders it for a customer.
 */
export function describeSignPlanForCustomer(
  input: DescribeSignPlanInput,
): SignPlanCustomerView {
  const status = statusFor(input.plan);
  return {
    status,
    orderedWidthIn: input.orderedWidthIn,
    orderedHeightIn: input.orderedHeightIn,
    artworkWidthPx: input.artworkWidthPx,
    artworkHeightPx: input.artworkHeightPx,
    findings: findingsFor(input.defectCodes),
    proposedAction: input.plan ? proposedActionFor(input.plan.steps) : null,
    reviewRequired: status === "needs_review",
    canProceed: status !== "blocked",
  };
}

function statusFor(plan: SignRepairPlan | null): SignPlanCustomerStatus {
  if (!plan) return "blocked";
  // Defensive only: a non-null plan's `overallRisk` should never actually be
  // `"blocked"` (a blocked outcome carries no plan at all, by construction
  // in `sign-repair-planner.ts`) — anything other than a proven `auto_safe`
  // is treated as needing review rather than risking a false "ready".
  return plan.overallRisk === "auto_safe" ? "ready" : "needs_review";
}

/**
 * Every `SignDefectCode` this build knows how to phrase for a customer.
 * Deliberately a lookup table, not a fallback template — an unmapped code
 * is silently omitted rather than leaking its internal spelling.
 */
const DEFECT_FINDING: Partial<Record<SignDefectCode, string>> = {
  aspect_ratio_mismatch:
    "The proportions of your artwork don't exactly match the sign size.",
  resolution_below_target:
    "Your artwork is a little lower resolution than we'd recommend at this print size.",
  resolution_below_minimum:
    "Your artwork's resolution is lower than we can safely print at this size.",
  reconstruction_exceeds_supported_scale:
    "Your artwork's resolution is too far below what this size needs for us to safely increase it.",
  transparency_present:
    "Your artwork has transparent areas, and signs print on an opaque background.",
  foreground_reaches_extension_edge:
    "Part of your design reaches the very edge of the artwork, so filling it in needs a closer look.",
  perimeter_structure_at_extension_edge:
    "Part of your design — like a border or frame — is built right up to the edge of your artwork. Adding space around it to fit this sign size would move that part inward, away from the actual edge of the finished sign, so we can't do that automatically.",
  meaningful_crop_required:
    "Fitting your artwork to this size exactly would mean trimming part of your design.",
  // Deliberately NOT mapped: `repair_requires_review` is meta-commentary
  // about the PROCESS ("a human should look at this"), not a fact about
  // the artwork — the dedicated "Review required" section the UI renders
  // whenever `reviewRequired` is true already says this, once, in one
  // place. Mapping it here would say the identical thing twice on the
  // same screen (LIVE PRODUCT BLOCKER #3A).
  missing_confirmed_width: "We don't have a confirmed width for this sign yet.",
  missing_confirmed_height: "We don't have a confirmed height for this sign yet.",
  missing_spec_confirmation: "We don't have a confirmed size for this sign yet.",
  unsupported_input: "We don't currently support this sign size.",
};

function findingsFor(codes: readonly SignDefectCode[]): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    const sentence = DEFECT_FINDING[code];
    if (!sentence || seen.has(sentence)) continue;
    seen.add(sentence);
    findings.push(sentence);
  }
  return findings;
}

/**
 * Every `SignRepairStepKind` this build knows how to phrase. Only steps
 * ACTUALLY present in the plan are ever translated — this never promises an
 * operation the planner didn't include.
 *
 * LIVE PRODUCT BLOCKER #3A: `extend_uniform_background`/
 * `pad_uniform_background` are both a deterministic canvas/background
 * extension — the pixels that make the artwork's proportions match the
 * ordered sign, never a decorative addition. "Uniform border" tested as
 * misleading (a print customer reasonably read it as a graphic border
 * being added to their design); "add space around the design" describes
 * the same real operation without that misreading, and says plainly what
 * it does NOT do — stretch or trim the artwork.
 */
const STEP_ACTION: Partial<Record<SignRepairStepKind, string>> = {
  reconstruct_resolution: "increase your artwork's resolution",
  extend_uniform_background:
    "add space around the design so it fits your sign without stretching or trimming your artwork",
  pad_uniform_background:
    "add space around the design so it fits your sign without stretching or trimming your artwork",
  proportional_resample: "resize your artwork proportionally",
  downsample: "adjust the resolution to match production requirements",
  approved_crop: "trim your artwork slightly to fit",
  rotate_90: "rotate your artwork to better fit the sign",
};

function proposedActionFor(steps: readonly SignRepairStep[]): string | null {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const phrase = STEP_ACTION[step.kind];
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
  }
  if (phrases.length === 0) return null;
  return `We can ${joinWithAnd(phrases)}.`;
}

function joinWithAnd(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
