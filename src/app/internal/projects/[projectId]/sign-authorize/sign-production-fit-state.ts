/**
 * Signs Flat-Raster Production Workflow Correction (Section B/F/G): the pure
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
  /** No edge fails on protected/ambiguous content, but at least one edge's own bleed baseline could not be proven (`protectedResult: "unknown"`) — genuinely ambiguous edge content that needs production review. Deterministic Fit cannot resolve this. */
  | "edge_classification_needed";

/** The minimal edge shape this module's decisions depend on. */
export interface SignProductionFitEdgeSummary {
  protectedResult: "pass" | "fail" | "unknown";
}

/** ALWAYS computed from the CURRENT, persisted, un-applied-preview candidate — never from an active preview (Section G). */
export function resolveSignProductionFitState(edges: readonly SignProductionFitEdgeSummary[]): SignProductionFitState {
  if (edges.some((e) => e.protectedResult === "fail")) return "fit_adjustment_required";
  if (edges.some((e) => e.protectedResult === "unknown")) return "edge_classification_needed";
  return "ready_as_supplied";
}

/** The subset of `SignSafeAreaFitPreviewResult["status"]` this module's panel-mode decision depends on. */
export type SignFitPreviewStatus = "previewed" | "no_area" | "background_not_determinable" | "unsupported_plan_shape" | "no_candidate";

export type SignProductionFitPanelMode =
  | SignProductionFitState
  | "fit_preview_ready"
  | "fit_preview_no_area"
  | "fit_preview_background_not_determinable"
  | "fit_preview_unsupported_plan_shape";

/**
 * Signs Flat-Raster Production Workflow Correction (Section F/G — the real
 * browser-acceptance copy-contradiction fix): decides what the panel
 * ACTUALLY shows. An active preview's own status is checked FIRST and
 * governs EXCLUSIVELY when present — `persistedFitState` (the CURRENT,
 * authoritative, un-applied-preview-free candidate's own state) is
 * consulted ONLY when there is no preview to report on. This makes it
 * STRUCTURALLY IMPOSSIBLE for a passing, unapplied Fit preview to render
 * as "Ready as supplied" / "No artwork changes required" — that copy is
 * reachable only through `persistedFitState`, and `persistedFitState` is
 * never consulted while `fitPreviewStatus` is non-null. The preview is
 * proposed artwork, never confused with already-persisted production
 * state (Section G) — this function is the one place that distinction is
 * enforced.
 */
export function resolveSignProductionFitPanelMode(
  persistedFitState: SignProductionFitState,
  fitPreviewStatus: SignFitPreviewStatus | null,
): SignProductionFitPanelMode {
  switch (fitPreviewStatus) {
    case "previewed": return "fit_preview_ready";
    case "no_area": return "fit_preview_no_area";
    case "background_not_determinable": return "fit_preview_background_not_determinable";
    case "unsupported_plan_shape": return "fit_preview_unsupported_plan_shape";
    case "no_candidate": return persistedFitState;
    case null: return persistedFitState;
    default: return persistedFitState;
  }
}

/** Section E/F/G/I copy — kept here, not scattered across JSX, so the exact operator-facing wording is reviewable/testable in one place. Never mentions Wand, selecting pixels, or connected shapes (Section H/I). */
export const SIGN_PRODUCTION_FIT_PANEL_COPY: Record<SignProductionFitPanelMode, { status: string; detail: string }> = {
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
    status: "Edge content needs production review",
    detail: "Some edge content couldn't be automatically classified as background or protected artwork.",
  },
  fit_preview_ready: {
    status: "Fit preview ready",
    detail: "All protected content clears the 0.125\" safe area. The background will extend to the cut edge.",
  },
  fit_preview_no_area: {
    status: "Fit preview needs review",
    detail: "The safe-area inset would consume the entire canvas — this needs production review, not an automatic fit.",
  },
  fit_preview_background_not_determinable: {
    status: "Fit preview needs review",
    detail:
      "The artwork's background couldn't be confidently measured for a safe automatic fit — this needs production review rather than a guessed fill colour.",
  },
  fit_preview_unsupported_plan_shape: {
    status: "Fit preview needs review",
    detail: "This artwork's current production plan isn't in a shape Fit to Safe Area recognizes — this needs production review.",
  },
};
