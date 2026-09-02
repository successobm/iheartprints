import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { SignProductionSpec, SignRepairPlan, SignRepairStep } from "./contracts";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import { measureFrameStructuralModel } from "./frame-structure-model";
import { RIGID_RECT_UP_TO_24X36_V1, SIGN_MINIMUM_SAFE_INSET_IN } from "./resolution-policy";
import { framedSignArtwork } from "./sign-fixtures";
import { computeSignPlanKey } from "./sign-plan-identity";
import { buildSignProductionTemplate, signSafeInsetPx } from "./sign-production-template";

function spec(orderedWidthIn: number, orderedHeightIn: number): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-09-02T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function planFor(steps: SignRepairStep[]): SignRepairPlan {
  return {
    schemaVersion: "sign-repair-plan:v1",
    policyId: RIGID_RECT_UP_TO_24X36_V1.id,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    sourceWidthPx: 1000,
    sourceHeightPx: 1500,
    orderedWidthIn: 18,
    orderedHeightIn: 24,
    steps,
    expectedOutputWidthPx: 2700,
    expectedOutputHeightPx: 3600,
    expectedEffectivePpi: 150,
    overallRisk: "review_required",
    defects: [],
    reasons: [],
    planKey: "", // not part of SignPlanIdentityInput — computed separately by computeSignPlanKey in each test.
  };
}

describe("SignProductionTemplate", () => {
  it("is built only from the confirmed spec and policy — straight_rectangle is the only V1 shape", () => {
    const template = buildSignProductionTemplate(spec(18, 24), RIGID_RECT_UP_TO_24X36_V1);
    assert.equal(template.widthIn, 18);
    assert.equal(template.heightIn, 24);
    assert.equal(template.shape, "straight_rectangle");
    assert.equal(template.minimumSafeInsetIn, SIGN_MINIMUM_SAFE_INSET_IN);
  });

  it("carries the 0.125in minimum safe inset from the single central policy figure, never a duplicated literal", () => {
    assert.equal(SIGN_MINIMUM_SAFE_INSET_IN, 0.125);
    assert.equal(RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn, SIGN_MINIMUM_SAFE_INSET_IN);
    const template = buildSignProductionTemplate(spec(24, 36), RIGID_RECT_UP_TO_24X36_V1);
    assert.equal(template.minimumSafeInsetIn, SIGN_MINIMUM_SAFE_INSET_IN);
  });

  it("cannot be influenced by rounded, decorative source artwork — shape stays straight_rectangle regardless of a measured rounded frame", () => {
    const rounded: RgbaImage = framedSignArtwork({ rounded: true, withHoles: true });
    const frameModel = measureFrameStructuralModel(rounded);
    assert.equal(frameModel.status, "measured");
    if (frameModel.status === "measured") {
      // The source really does carry rounded-corner decoration...
      assert.ok((frameModel.model.cornerRadiusPx ?? 0) > 0);
    }

    // ...yet the production template — built with no artwork/image
    // parameter at all — is unaffected.
    const template = buildSignProductionTemplate(spec(18, 24), RIGID_RECT_UP_TO_24X36_V1);
    assert.equal(template.shape, "straight_rectangle");

    const squareCornered = framedSignArtwork({ rounded: false, withHoles: true });
    const squareModel = measureFrameStructuralModel(squareCornered);
    assert.equal(squareModel.status, "measured");
    if (squareModel.status === "measured") {
      assert.equal(squareModel.model.cornerRadiusPx, null);
    }
    // Same template either way — corner geometry never selects `shape`.
    const templateForSquareSource = buildSignProductionTemplate(spec(18, 24), RIGID_RECT_UP_TO_24X36_V1);
    assert.deepEqual(templateForSquareSource, template);
  });
});

describe("signSafeInsetPx", () => {
  it("converts a physical inset to pixels independently on the horizontal axis", () => {
    // 18in ordered width, 2700px output width => 150 px/in exactly.
    const px = signSafeInsetPx(0.125, 2700, 18);
    assert.equal(px, Math.ceil(0.125 * 150));
  });

  it("converts a physical inset to pixels independently on the vertical axis", () => {
    // 24in ordered height, 3600px output height => 150 px/in exactly.
    const px = signSafeInsetPx(0.125, 3600, 24);
    assert.equal(px, Math.ceil(0.125 * 150));
  });

  it("rounds up conservatively so the physical minimum can never shrink due to pixel rounding", () => {
    // 100 px/in would give exactly 12.5px; must round UP to 13, never down to 12.
    const px = signSafeInsetPx(0.125, 1000, 10);
    assert.equal(px, 13);
    assert.ok(px / (1000 / 10) >= 0.125);
  });

  it("returns 0 rather than throwing for non-finite or non-positive geometry", () => {
    assert.equal(signSafeInsetPx(0.125, 0, 18), 0);
    assert.equal(signSafeInsetPx(0.125, 2700, 0), 0);
    assert.equal(signSafeInsetPx(0, 2700, 18), 0);
    assert.equal(signSafeInsetPx(0.125, Number.NaN, 18), 0);
    assert.equal(signSafeInsetPx(-1, 2700, 18), 0);
  });
});

describe("reflow_structural_layout contract", () => {
  it("serializes and canonicalizes through the existing plan-identity machinery exactly like any other step kind", () => {
    const step: SignRepairStep = {
      kind: "reflow_structural_layout",
      params: { regionCount: 4, gapCount: 3, minimumSafeInsetIn: 0.125 },
      risk: "review_required",
      reasons: ["dormant foundations phase — not planner-emitted yet"],
    };
    const plan = planFor([step]);
    const key = computeSignPlanKey(plan);
    assert.equal(typeof key, "string");
    assert.ok(key.startsWith("sign-repair-plan:v1:"));

    // Changing a param changes the key...
    const changed = computeSignPlanKey(planFor([{ ...step, params: { ...step.params, regionCount: 5 } }]));
    assert.notEqual(changed, key);

    // ...but risk/reasons are excluded from identity, exactly like every
    // other step kind — only kind+params are canonical.
    const sameKeyDespiteRationale = computeSignPlanKey(
      planFor([{ ...step, risk: "blocked", reasons: ["a completely different rationale"] }]),
    );
    assert.equal(sameKeyDespiteRationale, key);
  });

  it("does not require any change to reconstruct_parametric_frame's own historical contract shape", () => {
    const historicalStep: SignRepairStep = {
      kind: "reconstruct_parametric_frame",
      params: {
        outerStrokeThicknessPx: 9,
        gapThicknessPx: 15,
        innerStrokeThicknessPx: 7,
        cornerRadiusPx: 42,
        holeRadiusPx: 9,
      },
      risk: "review_required",
      reasons: ["measured concentric band sequence with corner rounding"],
    };
    const plan = planFor([historicalStep]);
    const key = computeSignPlanKey(plan);
    assert.equal(typeof key, "string");
    // A plan mixing the historical step with the new dormant one is still
    // a perfectly ordinary, serializable plan — proving the new kind was
    // added additively, alongside the old one, never replacing it.
    const mixedKey = computeSignPlanKey(
      planFor([
        historicalStep,
        {
          kind: "reflow_structural_layout",
          params: { regionCount: 2 },
          risk: "review_required",
          reasons: ["dormant"],
        },
      ]),
    );
    assert.notEqual(mixedKey, key);
  });
});
