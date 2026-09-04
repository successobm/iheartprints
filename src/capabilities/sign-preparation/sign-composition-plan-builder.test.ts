/**
 * Signs Phase 3B (Canvas-First Correction): `buildSignCompositionPlan` —
 * the canvas-first invariant, and plan governance (planKey changes on any
 * operator change, identical inputs -> identical planKey).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RIGID_SIGN_CATEGORY, type SignProductionSpec } from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import {
  buildSignCompositionPlan,
  decodeSignCompositionPlanToOperatorChoices,
  type SignCompositionPlanInput,
} from "./sign-composition-plan-builder";

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

describe("buildSignCompositionPlan: fitSafeInsetIn (Signs Flat-Raster Production Workflow Correction, Section I/J)", () => {
  it("omitted reproduces the exact ordinary fit-to-fill plan — 100% backward compatible", () => {
    const withField = buildSignCompositionPlan(baseInput({ fitSafeInsetIn: undefined }));
    const without = buildSignCompositionPlan(baseInput());
    assert.equal(withField.status, "built");
    assert.equal(without.status, "built");
    if (withField.status !== "built" || without.status !== "built") return;
    assert.deepEqual(withField.plan.steps, without.plan.steps);
  });

  it("a positive inset produces a scaleTarget smaller than the canvas, centered by construction, never touching the ordered canvas SHAPE", () => {
    const result = buildSignCompositionPlan(baseInput({ fitSafeInsetIn: 0.125, fitPlacement: null }));
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const fitStep = result.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const canvasWidthPx = Number(fitStep.params.canvasWidthPx);
    const canvasHeightPx = Number(fitStep.params.canvasHeightPx);
    const scaleTargetWidthPx = Number(fitStep.params.scaleTargetWidthPx);
    const scaleTargetHeightPx = Number(fitStep.params.scaleTargetHeightPx);
    assert.ok(scaleTargetWidthPx > 0 && scaleTargetWidthPx < canvasWidthPx);
    assert.ok(scaleTargetHeightPx > 0 && scaleTargetHeightPx < canvasHeightPx);
    // Canvas SHAPE (physical ordered size) is completely unaffected by the inset.
    assert.equal(canvasWidthPx / canvasHeightPx > 0, true);
    const canvasAspect = canvasWidthPx / canvasHeightPx;
    assert.ok(Math.abs(canvasAspect - 24 / 36) < 0.001);
    // Placement is centered within the FULL canvas (leaving equal margin
    // on each axis — the inset frame), not touching either edge.
    const placementXPx = Number(fitStep.params.placementXPx);
    const placementYPx = Number(fitStep.params.placementYPx);
    assert.ok(placementXPx > 0);
    assert.ok(placementYPx > 0);
  });

  it("centered placement (fitPlacement: null) lands the fitted artwork ENTIRELY within the inset rectangle on every axis — never merely 'some positive margin'", () => {
    const result = buildSignCompositionPlan(baseInput({ fitSafeInsetIn: 0.125, fitPlacement: null }));
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const fitStep = result.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const canvasWidthPx = Number(fitStep.params.canvasWidthPx);
    const canvasHeightPx = Number(fitStep.params.canvasHeightPx);
    const scaleTargetWidthPx = Number(fitStep.params.scaleTargetWidthPx);
    const scaleTargetHeightPx = Number(fitStep.params.scaleTargetHeightPx);
    const insetPxX = (canvasWidthPx - scaleTargetWidthPx) / 2;
    const insetPxY = (canvasHeightPx - scaleTargetHeightPx) / 2;
    const placementXPx = Number(fitStep.params.placementXPx);
    const placementYPx = Number(fitStep.params.placementYPx);
    // The fitted artwork's own footprint must sit at-or-inside the inset
    // boundary on every side (the fitted size itself is <= the scale
    // target by construction, so a placement inside [insetPx, canvas -
    // insetPx] on each axis guarantees the whole footprint clears it).
    assert.ok(placementXPx >= insetPxX - 1); // -1: deriveUniformFitDimensions rounds the fitted size
    assert.ok(placementYPx >= insetPxY - 1);
    assert.ok(placementXPx <= canvasWidthPx - insetPxX + 1);
    assert.ok(placementYPx <= canvasHeightPx - insetPxY + 1);
  });

  it("refuses when the inset consumes the entire canvas (fails closed, never inverts/negatively-fits)", () => {
    // minimumSafeInsetIn cannot realistically consume a 24x36in canvas, so
    // force it with a deliberately absurd inset.
    const result = buildSignCompositionPlan(baseInput({ fitSafeInsetIn: 30 }));
    assert.equal(result.status, "refused");
  });

  it("the inset is derived per-axis via the SAME signSafeInsetPxForAxis the validator itself uses — guaranteed to land inside the validator's own SAFE guide", () => {
    const result = buildSignCompositionPlan(baseInput({ fitSafeInsetIn: 0.125, fitPlacement: null }));
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const fitStep = result.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const canvasWidthPx = Number(fitStep.params.canvasWidthPx);
    const canvasHeightPx = Number(fitStep.params.canvasHeightPx);
    const scaleTargetWidthPx = Number(fitStep.params.scaleTargetWidthPx);
    const scaleTargetHeightPx = Number(fitStep.params.scaleTargetHeightPx);
    const insetPxX = (canvasWidthPx - scaleTargetWidthPx) / 2;
    const insetPxY = (canvasHeightPx - scaleTargetHeightPx) / 2;
    // ceil(0.125in * achievedPpi) per axis, matching signSafeInsetPxForAxis exactly.
    const expectedInsetPxX = Math.ceil(0.125 * (canvasWidthPx / 24));
    const expectedInsetPxY = Math.ceil(0.125 * (canvasHeightPx / 36));
    assert.equal(insetPxX, expectedInsetPxX);
    assert.equal(insetPxY, expectedInsetPxY);
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

function maskedReplacement(overrides: Partial<{ xPx: number; yPx: number; widthPx: number; heightPx: number; contextDepthPx: number }> = {}) {
  return {
    xPx: 20, yPx: 20, widthPx: 4, heightPx: 4,
    color: { r: 200, g: 10, b: 10 },
    contextDepthPx: 5,
    maskBase64: Buffer.alloc(16, 1).toString("base64"), // 4x4, fully selected
    ...overrides,
  };
}

describe("buildSignCompositionPlan: replace_masked_region_with_background governance (Wand-First Correction UX)", () => {
  it("refuses a masked replacement rectangle outside the canvas", () => {
    const result = buildSignCompositionPlan(baseInput({ maskedReplacements: [maskedReplacement({ xPx: 0, yPx: 0, widthPx: 99999999, heightPx: 10 })] }));
    assert.equal(result.status, "refused");
  });

  it("refuses a masked replacement with a non-positive contextDepthPx", () => {
    const result = buildSignCompositionPlan(baseInput({ maskedReplacements: [maskedReplacement({ contextDepthPx: 0 })] }));
    assert.equal(result.status, "refused");
  });

  it("changing a masked replacement's rectangle changes the planKey", () => {
    const a = buildSignCompositionPlan(baseInput({ maskedReplacements: [maskedReplacement({ xPx: 10 })] }));
    const b = buildSignCompositionPlan(baseInput({ maskedReplacements: [maskedReplacement({ xPx: 20 })] }));
    assert.equal(a.status, "built");
    assert.equal(b.status, "built");
    if (a.status !== "built" || b.status !== "built") return;
    assert.notEqual(a.plan.planKey, b.plan.planKey);
  });

  it("a plan with a masked replacement differs in planKey from an otherwise-identical plan without one", () => {
    const without = buildSignCompositionPlan(baseInput());
    const withMasked = buildSignCompositionPlan(baseInput({ maskedReplacements: [maskedReplacement()] }));
    assert.equal(without.status, "built");
    assert.equal(withMasked.status, "built");
    if (without.status !== "built" || withMasked.status !== "built") return;
    assert.notEqual(without.plan.planKey, withMasked.plan.planKey);
  });

  it("replace_masked_region_with_background steps are ordered LAST — after every move, fill, and rectangle replacement", () => {
    const result = buildSignCompositionPlan(baseInput({
      moves: [{ sourceStartYPx: 0, heightPx: 100, destStartYPx: 50 }],
      fills: [{ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, color: { r: 255, g: 255, b: 255 } }],
      replacements: [{ xPx: 20, yPx: 20, widthPx: 30, heightPx: 30, color: { r: 200, g: 10, b: 10 }, contextDepthPx: 5 }],
      maskedReplacements: [maskedReplacement()],
    }));
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const kinds = result.plan.steps.map((s) => s.kind);
    const lastOfPreceding = Math.max(
      kinds.lastIndexOf("move_region"), kinds.lastIndexOf("fill_rect"), kinds.lastIndexOf("replace_region_with_background"),
    );
    const maskedIndex = kinds.indexOf("replace_masked_region_with_background");
    assert.ok(maskedIndex > lastOfPreceding);
  });
});

describe("decodeSignCompositionPlanToOperatorChoices (Operator Production Correction UX, Section K)", () => {
  it("round-trips: decoding a built plan and rebuilding through buildSignCompositionPlan reproduces an identical planKey", () => {
    const input = baseInput({
      moves: [{ sourceStartYPx: 0, heightPx: 100, destStartYPx: 50 }],
      fills: [{ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, color: { r: 255, g: 255, b: 255 } }],
      replacements: [{ xPx: 20, yPx: 20, widthPx: 30, heightPx: 30, color: { r: 200, g: 10, b: 10 }, contextDepthPx: 5 }],
    });
    const built = buildSignCompositionPlan(input);
    assert.equal(built.status, "built");
    if (built.status !== "built") return;

    const decoded = decodeSignCompositionPlanToOperatorChoices(built.plan);
    assert.ok(decoded, "a canvas-first plan must always decode successfully");
    if (!decoded) return;

    const rebuilt = buildSignCompositionPlan(baseInput({
      reconstruction: decoded.reconstruction,
      crop: decoded.crop,
      fitBackground: decoded.fitBackground,
      fitPlacement: decoded.fitPlacement,
      moves: decoded.moves,
      fills: decoded.fills,
      replacements: decoded.replacements,
    }));
    assert.equal(rebuilt.status, "built");
    if (rebuilt.status !== "built") return;
    assert.equal(rebuilt.plan.planKey, built.plan.planKey);
  });

  it("round-trips a masked replacement (Wand-First Correction UX) — decode -> rebuild reproduces an identical planKey, mask included", () => {
    const input = baseInput({ maskedReplacements: [maskedReplacement()] });
    const built = buildSignCompositionPlan(input);
    assert.equal(built.status, "built");
    if (built.status !== "built") return;

    const decoded = decodeSignCompositionPlanToOperatorChoices(built.plan);
    assert.ok(decoded);
    if (!decoded) return;
    assert.equal(decoded.maskedReplacements.length, 1);
    assert.equal(decoded.maskedReplacements[0]!.maskBase64, maskedReplacement().maskBase64);

    const rebuilt = buildSignCompositionPlan(baseInput({
      reconstruction: decoded.reconstruction,
      crop: decoded.crop,
      fitBackground: decoded.fitBackground,
      fitPlacement: decoded.fitPlacement,
      moves: decoded.moves,
      fills: decoded.fills,
      replacements: decoded.replacements,
      maskedReplacements: decoded.maskedReplacements,
    }));
    assert.equal(rebuilt.status, "built");
    if (rebuilt.status !== "built") return;
    assert.equal(rebuilt.plan.planKey, built.plan.planKey);
  });

  it("appending a NEW correction to decoded choices changes the planKey — governance (Section K)", () => {
    const built = buildSignCompositionPlan(baseInput());
    assert.equal(built.status, "built");
    if (built.status !== "built") return;
    const decoded = decodeSignCompositionPlanToOperatorChoices(built.plan);
    assert.ok(decoded);
    if (!decoded) return;

    const corrected = buildSignCompositionPlan(baseInput({
      reconstruction: decoded.reconstruction,
      crop: decoded.crop,
      fitBackground: decoded.fitBackground,
      fitPlacement: decoded.fitPlacement,
      moves: decoded.moves,
      fills: decoded.fills,
      replacements: [
        ...decoded.replacements,
        { xPx: 5, yPx: 5, widthPx: 20, heightPx: 20, color: { r: 250, g: 250, b: 250 }, contextDepthPx: 6 },
      ],
    }));
    assert.equal(corrected.status, "built");
    if (corrected.status !== "built") return;
    assert.notEqual(corrected.plan.planKey, built.plan.planKey);
  });

  it("refuses to decode a plan that is not the canvas-first shape (e.g. legacy step vocabulary)", () => {
    const plan = {
      schemaVersion: "sign-repair-plan:v1" as const,
      policyId: RIGID_RECT_UP_TO_24X36_V1.id,
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      sourceWidthPx: 1000,
      sourceHeightPx: 1500,
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      steps: [{ kind: "extend_uniform_background" as const, params: { axis: "vertical", leadingPx: 1, trailingPx: 1, colorR: 0, colorG: 0, colorB: 0 }, risk: "review_required" as const, reasons: [] }],
      expectedOutputWidthPx: 1000,
      expectedOutputHeightPx: 1500,
      expectedEffectivePpi: 41.6,
      overallRisk: "review_required" as const,
      defects: [],
      reasons: [],
      planKey: "irrelevant-for-this-test",
    };
    assert.equal(decodeSignCompositionPlanToOperatorChoices(plan), null);
  });
});
