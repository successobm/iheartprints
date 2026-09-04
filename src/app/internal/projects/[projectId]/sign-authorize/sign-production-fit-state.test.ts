import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSignProductionFitState, type SignProductionFitEdgeSummary } from "./sign-production-fit-state";

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
