/**
 * Signs Flat-Raster Production Workflow Correction (Section B/F): the pure
 * decision logic behind the workstation's PRIMARY operator state — derived
 * from the SAME Fit to Production edge evidence the dashed SAFE guide and
 * status bar already read (never a separate re-derivation), so this can
 * never disagree with what the operator sees drawn on the canvas.
 *
 * GOVERNING RULE: background/bleed/intentional edge artwork may reach CUT —
 * only PROTECTED_CONTENT (or content the scanner cannot yet classify,
 * AMBIGUOUS_REVIEW) failing to clear the SAFE inset is ever a real problem.
 * `analyzeSignFitToProduction`'s own edge results already encode this
 * distinction (`protectedResult`, `unresolvedAmbiguousPresent`,
 * `edgeIntentPresent`) — this module only ever reads that evidence, never
 * re-implements the scan.
 */

export type SignProductionFitState =
  /** Every edge already clears SAFE (or the guide couldn't be established at all, in which case there is nothing this whole-composition action could fix either — routed to review, never silently offered a fit). */
  | "ready_as_supplied"
  /** At least one edge's own PROTECTED/AMBIGUOUS content fails to clear SAFE — a whole-composition "Fit artwork to safe area" correction is the normal remedy. */
  | "fit_adjustment_required"
  /** No edge fails on protected/ambiguous content, but at least one edge's own bleed baseline could not be proven (`protectedResult: "unknown"`) — genuinely ambiguous edge content the operator must classify (via Wand), not something a whole-composition fit can resolve. */
  | "edge_classification_needed";

/** The minimal edge shape this module's decisions depend on. */
export interface SignProductionFitEdgeSummary {
  protectedResult: "pass" | "fail" | "unknown";
}

export function resolveSignProductionFitState(edges: readonly SignProductionFitEdgeSummary[]): SignProductionFitState {
  if (edges.some((e) => e.protectedResult === "fail")) return "fit_adjustment_required";
  if (edges.some((e) => e.protectedResult === "unknown")) return "edge_classification_needed";
  return "ready_as_supplied";
}

/** Section E/F copy — kept here, not scattered across JSX, so the exact operator-facing wording is reviewable/testable in one place. */
export const SIGN_PRODUCTION_FIT_COPY: Record<SignProductionFitState, { status: string; detail: string }> = {
  ready_as_supplied: {
    status: "Ready as supplied",
    detail: "Artwork fits the production area. No artwork changes required.",
  },
  fit_adjustment_required: {
    status: "Protected content needs more clearance",
    detail:
      "Some artwork is too close to (or crosses) the cut edge. \"Fit artwork to safe area\" proportionally repositions the WHOLE composition — never an individual piece of it — so it clears the safe area, filling any newly exposed edge with your artwork's own background.",
  },
  edge_classification_needed: {
    status: "Edge content needs classification",
    detail:
      "Some edge content couldn't be automatically classified as background or protected artwork. Use the wand to click it and answer whether it's intentionally allowed to reach the cut edge.",
  },
};
