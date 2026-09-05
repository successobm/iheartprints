import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveSignProductionFitPanelMode,
  resolveSignProductionFitState,
  SIGN_PRODUCTION_FIT_PANEL_COPY,
  type SignProductionFitEdgeSummary,
} from "./sign-production-fit-state";

function edges(...results: Array<"pass" | "fail" | "unknown">): SignProductionFitEdgeSummary[] {
  return results.map((protectedResult) => ({ protectedResult }));
}

// 1. flattened sign with protected content safely inside SAFE: no correction required
test("all edges pass: ready_as_supplied", () => {
  assert.equal(resolveSignProductionFitState(edges("pass", "pass", "pass", "pass")), "ready_as_supplied");
});

// 4. protected content crossing SAFE: Fit-to-Production action offered
test("any edge failing: fit_adjustment_required, regardless of the other edges' state", () => {
  assert.equal(resolveSignProductionFitState(edges("pass", "fail", "pass", "pass")), "fit_adjustment_required");
  assert.equal(resolveSignProductionFitState(edges("fail", "unknown", "pass", "pass")), "fit_adjustment_required");
});

test("no edge fails, but one is unknown: edge_classification_needed", () => {
  assert.equal(resolveSignProductionFitState(edges("pass", "unknown", "pass", "pass")), "edge_classification_needed");
});

test("an empty edge list (no evidence at all) is ready_as_supplied — nothing to fix, nothing to classify", () => {
  assert.equal(resolveSignProductionFitState([]), "ready_as_supplied");
});

test("fail takes priority over unknown when both are present", () => {
  assert.equal(resolveSignProductionFitState(edges("unknown", "fail")), "fit_adjustment_required");
});

// --- resolveSignProductionFitPanelMode (Section F/G real browser-acceptance fix) ---

// 12/13. a passing Fit preview NEVER renders as "ready_as_supplied" / "no
// changes required" — structurally guaranteed, not merely by convention.
test("a previewed (passing) fit preview ALWAYS wins over persisted state, even when persisted state is ready_as_supplied", () => {
  const mode = resolveSignProductionFitPanelMode("ready_as_supplied", "previewed");
  assert.equal(mode, "fit_preview_ready");
  assert.notEqual(mode, "ready_as_supplied");
});

test("a previewed fit preview wins over a persisted fit_adjustment_required state too — the exact real browser-acceptance scenario", () => {
  assert.equal(resolveSignProductionFitPanelMode("fit_adjustment_required", "previewed"), "fit_preview_ready");
});

test("no preview at all (null) falls back to the persisted state exactly", () => {
  assert.equal(resolveSignProductionFitPanelMode("ready_as_supplied", null), "ready_as_supplied");
  assert.equal(resolveSignProductionFitPanelMode("fit_adjustment_required", null), "fit_adjustment_required");
  assert.equal(resolveSignProductionFitPanelMode("edge_classification_needed", null), "edge_classification_needed");
});

test("no_candidate preview status falls back to the persisted state (nothing to preview yet)", () => {
  assert.equal(resolveSignProductionFitPanelMode("fit_adjustment_required", "no_candidate"), "fit_adjustment_required");
});

test("each fail-closed preview status maps to its own distinct review mode, never silently falling back to ready_as_supplied", () => {
  assert.equal(resolveSignProductionFitPanelMode("ready_as_supplied", "no_area"), "fit_preview_no_area");
  assert.equal(resolveSignProductionFitPanelMode("ready_as_supplied", "background_not_determinable"), "fit_preview_background_not_determinable");
  assert.equal(resolveSignProductionFitPanelMode("ready_as_supplied", "unsupported_plan_shape"), "fit_preview_unsupported_plan_shape");
});

test("every panel mode has copy, and the fit_preview_ready copy never contains the words 'Ready as supplied' or 'no artwork changes'", () => {
  for (const mode of Object.keys(SIGN_PRODUCTION_FIT_PANEL_COPY) as (keyof typeof SIGN_PRODUCTION_FIT_PANEL_COPY)[]) {
    assert.ok(SIGN_PRODUCTION_FIT_PANEL_COPY[mode].status.length > 0);
    assert.ok(SIGN_PRODUCTION_FIT_PANEL_COPY[mode].detail.length > 0);
  }
  const readyCopy = SIGN_PRODUCTION_FIT_PANEL_COPY.fit_preview_ready;
  assert.doesNotMatch(readyCopy.status, /ready as supplied/i);
  assert.doesNotMatch(readyCopy.detail, /no artwork changes/i);
  assert.match(readyCopy.detail, /0\.125/); // states the safe-area inset explicitly
});

test("the edge_classification_needed copy never mentions the wand or selecting/clicking pixels (Section H/I)", () => {
  const copy = SIGN_PRODUCTION_FIT_PANEL_COPY.edge_classification_needed;
  assert.doesNotMatch(copy.status + " " + copy.detail, /wand|click|select/i);
});
