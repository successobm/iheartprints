/**
 * Signs Phase 3B (Canvas-First Correction): `buildSignCompositionPlan` —
 * the canvas-first invariant, and plan governance (planKey changes on any
 * operator change, identical inputs -> identical planKey).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RIGID_SIGN_CATEGORY, type SignProductionSpec } from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { buildSignCompositionPlan, type SignCompositionPlanInput } from "./sign-composition-plan-builder";

function baseSpec(): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn: 24,
    orderedHeightIn: 36,
    confirmedAt: "2026-01-01T00:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function baseInput(overrides: Partial<SignCompositionPlanInput> = {}): SignCompositionPlanInput {
  return {
    spec: baseSpec(),
    policy: RIGID_RECT_UP_TO_24X36_V1,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    sourceWidthPx: 1086,
    sourceHeightPx: 1448,
    reconstruction: { requestedScale: 4, requestedWidthPx: 4344, requestedHeightPx: 5792 },
    crop: { xPx: 108, yPx: 108, widthPx: 4128, heightPx: 5576 },
    fitBackground: { r: 255, g: 255, b: 255 },
    fitPlacement: null,
    moves: [],
    fills: [],
    replacements: [],
    ...overrides,
  };
}

describe("buildSignCompositionPlan: canvas-first invariant", () => {
  it("derives the canvas shape/physical size ONLY from the ordered spec, never the artwork", () => {
    const result = buildSignCompositionPlan(baseInput());
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    assert.equal(result.plan.orderedWidthIn, 24);
    assert.equal(result.plan.orderedHeightIn, 36);
    const fitStep = result.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    // Canvas aspect must equal the ORDERED aspect exactly, regardless of the
    // crop/artwork's own aspect (4128/5576 != 24/36).
    const canvasAspect = Number(fitStep.params.canvasWidthPx) / Number(fitStep.params.canvasHeightPx);
    assert.ok(Math.abs(canvasAspect - 24 / 36) < 0.001);
  });

  it("artwork dimensions cannot alter the production canvas shape, even with a very different crop aspect", () => {
    const square = buildSignCompositionPlan(baseInput({ crop: { xPx: 0, yPx: 0, widthPx: 4000, heightPx: 4000 } }));
    const tall = buildSignCompositionPlan(baseInput({ crop: { xPx: 0, yPx: 0, widthPx: 2000, heightPx: 5000 } }));
    assert.equal(square.status, "built");
    assert.equal(tall.status, "built");
    if (square.status !== "built" || tall.status !== "built") return;
    // Both plans still target the SAME ordered 24x36 rectangle shape.
    assert.equal(square.plan.orderedWidthIn, tall.plan.orderedWidthIn);
    assert.equal(square.plan.orderedHeightIn, tall.plan.orderedHeightIn);
    const squareFit = square.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const tallFit = tall.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const squareAspect = Number(squareFit.params.canvasWidthPx) / Number(squareFit.params.canvasHeightPx);
    const tallAspect = Number(tallFit.params.canvasWidthPx) / Number(tallFit.params.canvasHeightPx);
    assert.ok(Math.abs(squareAspect - 24 / 36) < 0.001);
    assert.ok(Math.abs(tallAspect - 24 / 36) < 0.001);
  });

  it("never emits reconstruct_parametric_frame, reconstruct_perimeter_structure, or reflow_structural_layout", () => {
    const result = buildSignCompositionPlan(baseInput());
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const forbidden = new Set(["reconstruct_parametric_frame", "reconstruct_perimeter_structure", "reflow_structural_layout"]);
    assert.ok(result.plan.steps.every((s) => !forbidden.has(s.kind)));
  });
});

describe("buildSignCompositionPlan: governance", () => {
  it("identical inputs produce the identical planKey (exact authorization accepted)", () => {
    const a = buildSignCompositionPlan(baseInput());
    const b = buildSignCompositionPlan(baseInput());
    assert.equal(a.status, "built");
    assert.equal(b.status, "built");
    if (a.status !== "built" || b.status !== "built") return;
    assert.equal(a.plan.planKey, b.plan.planKey);
  });

  it("changing a move's destination Y changes the planKey", () => {
    const withoutMove = buildSignCompositionPlan(baseInput());
    const withMove = buildSignCompositionPlan(baseInput({ moves: [{ sourceStartYPx: 0, heightPx: 100, destStartYPx: 50 }] }));
    assert.equal(withoutMove.status, "built");
    assert.equal(withMove.status, "built");
    if (withoutMove.status !== "built" || withMove.status !== "built") return;
    assert.notEqual(withoutMove.plan.planKey, withMove.plan.planKey);
  });

  it("changing a fill rectangle's colour changes the planKey", () => {
    const fillA = buildSignCompositionPlan(baseInput({ fills: [{ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, color: { r: 255, g: 0, b: 0 } }] }));
    const fillB = buildSignCompositionPlan(baseInput({ fills: [{ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, color: { r: 0, g: 255, b: 0 } }] }));
    assert.equal(fillA.status, "built");
    assert.equal(fillB.status, "built");
    if (fillA.status !== "built" || fillB.status !== "built") return;
    assert.notEqual(fillA.plan.planKey, fillB.plan.planKey);
  });

  it("changing the crop rectangle changes the planKey", () => {
    const cropA = buildSignCompositionPlan(baseInput());
    const cropB = buildSignCompositionPlan(baseInput({ crop: { xPx: 0, yPx: 0, widthPx: 4344, heightPx: 5792 } }));
    assert.equal(cropA.status, "built");
    assert.equal(cropB.status, "built");
    if (cropA.status !== "built" || cropB.status !== "built") return;
    assert.notEqual(cropA.plan.planKey, cropB.plan.planKey);
  });

  it("a plan with no crop still builds (crop is optional)", () => {
    const result = buildSignCompositionPlan(baseInput({ crop: null }));
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    assert.ok(!result.plan.steps.some((s) => s.kind === "crop_region"));
  });
});

describe("buildSignCompositionPlan: fail-closed refusals", () => {
  it("refuses a crop rectangle exceeding the pre-composition artwork bounds", () => {
    const result = buildSignCompositionPlan(baseInput({ crop: { xPx: 0, yPx: 0, widthPx: 999999, heightPx: 999999 } }));
    assert.equal(result.status, "refused");
  });

  it("refuses a move band outside the canvas", () => {
    const result = buildSignCompositionPlan(baseInput({ moves: [{ sourceStartYPx: 0, heightPx: 99999999, destStartYPx: 0 }] }));
    assert.equal(result.status, "refused");
  });

  it("refuses a fill rectangle outside the canvas", () => {
    const result = buildSignCompositionPlan(baseInput({ fills: [{ xPx: 0, yPx: 0, widthPx: 99999999, heightPx: 10, color: { r: 0, g: 0, b: 0 } }] }));
    assert.equal(result.status, "refused");
  });

  it("refuses a replace_region_with_background rectangle outside the canvas", () => {
    const result = buildSignCompositionPlan(baseInput({ replacements: [{ xPx: 0, yPx: 0, widthPx: 99999999, heightPx: 10, color: { r: 0, g: 0, b: 0 }, contextDepthPx: 5 }] }));
    assert.equal(result.status, "refused");
  });

  it("refuses a replace_region_with_background with a non-positive contextDepthPx", () => {
    const result = buildSignCompositionPlan(baseInput({ replacements: [{ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, color: { r: 0, g: 0, b: 0 }, contextDepthPx: 0 }] }));
    assert.equal(result.status, "refused");
  });
});

describe("buildSignCompositionPlan: replace_region_with_background governance", () => {
  it("changing a replacement's rectangle changes the planKey", () => {
    const a = buildSignCompositionPlan(baseInput({ replacements: [{ xPx: 10, yPx: 10, widthPx: 50, heightPx: 50, color: { r: 200, g: 10, b: 10 }, contextDepthPx: 5 }] }));
    const b = buildSignCompositionPlan(baseInput({ replacements: [{ xPx: 20, yPx: 10, widthPx: 50, heightPx: 50, color: { r: 200, g: 10, b: 10 }, contextDepthPx: 5 }] }));
    assert.equal(a.status, "built");
    assert.equal(b.status, "built");
    if (a.status !== "built" || b.status !== "built") return;
    assert.notEqual(a.plan.planKey, b.plan.planKey);
  });

  it("a plan with a replacement differs in planKey from an otherwise-identical plan without one — stale authorization is never silently reused", () => {
    const withoutReplacement = buildSignCompositionPlan(baseInput());
    const withReplacement = buildSignCompositionPlan(baseInput({ replacements: [{ xPx: 10, yPx: 10, widthPx: 50, heightPx: 50, color: { r: 200, g: 10, b: 10 }, contextDepthPx: 5 }] }));
    assert.equal(withoutReplacement.status, "built");
    assert.equal(withReplacement.status, "built");
    if (withoutReplacement.status !== "built" || withReplacement.status !== "built") return;
    assert.notEqual(withoutReplacement.plan.planKey, withReplacement.plan.planKey);
  });

  it("replace_region_with_background steps are ordered LAST, after every move and fill", () => {
    const result = buildSignCompositionPlan(baseInput({
      moves: [{ sourceStartYPx: 0, heightPx: 100, destStartYPx: 50 }],
      fills: [{ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, color: { r: 255, g: 255, b: 255 } }],
      replacements: [{ xPx: 20, yPx: 20, widthPx: 30, heightPx: 30, color: { r: 200, g: 10, b: 10 }, contextDepthPx: 5 }],
    }));
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const kinds = result.plan.steps.map((s) => s.kind);
    const lastMoveOrFillIndex = Math.max(kinds.lastIndexOf("move_region"), kinds.lastIndexOf("fill_rect"));
    const replacementIndex = kinds.indexOf("replace_region_with_background");
    assert.ok(replacementIndex > lastMoveOrFillIndex);
  });
});
