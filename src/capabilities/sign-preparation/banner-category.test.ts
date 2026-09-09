/**
 * Banner Production Profile (Constitution amendment 3.3, §16A-bis): the
 * `banner_raster` sibling category — policy resolution stays category-
 * scoped and fails closed, production-requirements derive correctly for
 * Banner, and canvas construction respects the Banner-only `maxCanvasPpi`
 * memory ceiling while every existing rigid-sign guarantee (no maxCanvasPpi,
 * exact-shape/no-stretch) remains untouched. Mirrors `rigid-sign-category
 * .test.ts`'s own structure and discipline exactly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BANNER_CATEGORY, RIGID_SIGN_CATEGORY, type SignProductionSpec } from "./contracts";
import {
  BANNER_RECT_UP_TO_36X96_V1,
  RIGID_RECT_UP_TO_24X36_V1,
  resolveSignResolutionPolicy,
} from "./resolution-policy";
import { deriveRigidSignProductionRequirements } from "./sign-production-requirements";
import {
  buildSignCompositionPlan,
  type SignCompositionPlanInput,
} from "./sign-composition-plan-builder";

describe("banner_raster category resolution", () => {
  it("the real customer case (84x24in, 3.5:1) resolves under banner_raster, never under rigid_sign_raster", () => {
    assert.equal(resolveSignResolutionPolicy(84, 24, BANNER_CATEGORY)?.id, "banner_rect_up_to_36x96:v1");
    assert.equal(resolveSignResolutionPolicy(24, 84, BANNER_CATEGORY)?.id, "banner_rect_up_to_36x96:v1");
    assert.equal(resolveSignResolutionPolicy(84, 24, RIGID_SIGN_CATEGORY), null);
    // Default (omitted) category is still RIGID_SIGN_CATEGORY — byte-for-byte pre-Banner behavior.
    assert.equal(resolveSignResolutionPolicy(84, 24), null);
  });

  it("never infers Banner from size alone — an explicitly rigid_sign_raster request never silently resolves to the banner policy even though it would cover the size", () => {
    // 30x50: fits the banner envelope (short<=36, long<=96) but not the
    // rigid one (short<=24, long<=36) — proves category, never size, decides.
    assert.equal(resolveSignResolutionPolicy(30, 50, RIGID_SIGN_CATEGORY), null);
    assert.equal(resolveSignResolutionPolicy(30, 50, BANNER_CATEGORY)?.id, "banner_rect_up_to_36x96:v1");
  });

  it("banner envelope fails closed outside its own bounds", () => {
    assert.equal(resolveSignResolutionPolicy(36, 96, BANNER_CATEGORY)?.id, "banner_rect_up_to_36x96:v1");
    assert.equal(resolveSignResolutionPolicy(96, 36, BANNER_CATEGORY)?.id, "banner_rect_up_to_36x96:v1");
    assert.equal(resolveSignResolutionPolicy(37, 90, BANNER_CATEGORY), null);
    assert.equal(resolveSignResolutionPolicy(36, 97, BANNER_CATEGORY), null);
    assert.equal(resolveSignResolutionPolicy(0, 24, BANNER_CATEGORY), null);
    assert.equal(resolveSignResolutionPolicy(Number.NaN, 24, BANNER_CATEGORY), null);
  });

  it("rigid-sign envelope/figures are completely unaffected by Banner's existence", () => {
    assert.equal(resolveSignResolutionPolicy(18, 24)?.id, "rigid_rect_up_to_24x36:v1");
    assert.equal(RIGID_RECT_UP_TO_24X36_V1.targetPpi, 150);
    assert.equal(RIGID_RECT_UP_TO_24X36_V1.minPpi, 100);
    assert.equal(RIGID_RECT_UP_TO_24X36_V1.maxCanvasPpi, undefined);
  });

  it("Banner's resolution figures are its own, empirically justified, LOWER than rigid's — never copied from the rigid policy", () => {
    assert.equal(BANNER_RECT_UP_TO_36X96_V1.targetPpi, 72);
    assert.equal(BANNER_RECT_UP_TO_36X96_V1.minPpi, 50);
    assert.equal(BANNER_RECT_UP_TO_36X96_V1.maxCanvasPpi, 72);
    assert.ok(BANNER_RECT_UP_TO_36X96_V1.targetPpi < RIGID_RECT_UP_TO_24X36_V1.targetPpi);
    assert.ok(BANNER_RECT_UP_TO_36X96_V1.minPpi < RIGID_RECT_UP_TO_24X36_V1.minPpi);
  });
});

describe("banner_raster production requirements", () => {
  it("derives from the confirmed spec + policy, category-parameterized, never a hardcoded rigid-sign literal", () => {
    const spec: SignProductionSpec = {
      category: BANNER_CATEGORY,
      orderedWidthIn: 84,
      orderedHeightIn: 24,
      confirmedAt: "2026-09-08T12:00:00.000Z",
      resolutionPolicyId: BANNER_RECT_UP_TO_36X96_V1.id,
    };
    const requirements = deriveRigidSignProductionRequirements(spec, BANNER_RECT_UP_TO_36X96_V1);

    assert.equal(requirements.category, "banner_raster");
    assert.equal(requirements.requiredOutputType, "raster");
    assert.equal(requirements.targetPpi, 72);
    // Opaque production intent — identical contract to rigid, not weakened.
    assert.equal(requirements.transparencyRequired, false);
    assert.equal(requirements.colorMode, "rgb");
    assert.deepEqual(requirements.allowedFileFormats, ["png"]);
    assert.deepEqual(requirements.targetDimensions, { widthIn: 84, heightIn: 24 });
    // 84in x 24in @ 72 PPI.
    assert.deepEqual(requirements.minRasterDimensionsPx, { widthPx: 6048, heightPx: 1728 });
  });
});

function bannerCompositionInput(
  overrides: Partial<SignCompositionPlanInput> = {},
): SignCompositionPlanInput {
  const spec: SignProductionSpec = {
    category: BANNER_CATEGORY,
    orderedWidthIn: 84,
    orderedHeightIn: 24,
    confirmedAt: "2026-09-08T12:00:00.000Z",
    resolutionPolicyId: BANNER_RECT_UP_TO_36X96_V1.id,
  };
  return {
    spec,
    policy: BANNER_RECT_UP_TO_36X96_V1,
    sourceAssetId: "asset-banner-1",
    sourceSha256: "b".repeat(64),
    sourceWidthPx: 12000,
    sourceHeightPx: 3600, // matches the ordered 3.5:1 aspect exactly
    reconstruction: null,
    crop: null,
    fitBackground: { r: 255, g: 255, b: 255 },
    fitPlacement: null,
    moves: [],
    fills: [],
    replacements: [],
    ...overrides,
  };
}

describe("buildSignCompositionPlan: Banner canvas-first invariant + maxCanvasPpi memory ceiling", () => {
  it("exact 84x24in / 3.5:1 canvas shape, regardless of source resolution", () => {
    const result = buildSignCompositionPlan(bannerCompositionInput());
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    assert.equal(result.plan.orderedWidthIn, 84);
    assert.equal(result.plan.orderedHeightIn, 24);
    const fitStep = result.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const canvasWidthPx = Number(fitStep.params.canvasWidthPx);
    const canvasHeightPx = Number(fitStep.params.canvasHeightPx);
    assert.ok(Math.abs(canvasWidthPx / canvasHeightPx - 3.5) < 0.001, "canvas must be exactly 3.5:1 — no stretch");
  });

  it("a high-resolution source (well beyond the 72 PPI ceiling) is clamped to exactly 84x24in @ 72 PPI — never left uncapped", () => {
    // Raw density would be min(12000/84, 3600/24) = 142.86 PPI, far above the
    // policy's 72 PPI maxCanvasPpi ceiling.
    const result = buildSignCompositionPlan(bannerCompositionInput());
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    assert.equal(result.plan.expectedOutputWidthPx, 6048); // round(84 * 72)
    assert.equal(result.plan.expectedOutputHeightPx, 1728); // round(24 * 72)
    assert.equal(result.plan.expectedEffectivePpi, 72);
    // The final RGBA canvas buffer this implies (4 bytes/px) stays a small
    // fraction of this runtime's ~512MB budget — the exact evidence the
    // maxCanvasPpi ceiling exists to guarantee.
    const bufferBytes = 6048 * 1728 * 4;
    assert.ok(bufferBytes < 50 * 1024 * 1024, "capped Banner canvas buffer must stay well under 50MB");
  });

  it("a source resolution already at or below the ceiling is left uncapped — the ceiling only ever clamps downward", () => {
    // 84*36 x 24*36 -> raw density 36 PPI, below the 72 PPI ceiling.
    const result = buildSignCompositionPlan(
      bannerCompositionInput({ sourceWidthPx: 84 * 36, sourceHeightPx: 24 * 36 }),
    );
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    assert.equal(result.plan.expectedEffectivePpi, 36);
    assert.equal(result.plan.expectedOutputWidthPx, 84 * 36);
    assert.equal(result.plan.expectedOutputHeightPx, 24 * 36);
  });

  it("artwork crop aspect can never distort the ordered 3.5:1 Banner canvas shape", () => {
    const square = buildSignCompositionPlan(
      bannerCompositionInput({ crop: { xPx: 0, yPx: 0, widthPx: 3000, heightPx: 3000 } }),
    );
    assert.equal(square.status, "built");
    if (square.status !== "built") return;
    const fitStep = square.plan.steps.find((s) => s.kind === "fit_artwork_to_canvas")!;
    const canvasWidthPx = Number(fitStep.params.canvasWidthPx);
    const canvasHeightPx = Number(fitStep.params.canvasHeightPx);
    assert.ok(Math.abs(canvasWidthPx / canvasHeightPx - 3.5) < 0.001);
  });

  it("never emits reconstruct_parametric_frame, reconstruct_perimeter_structure, or reflow_structural_layout — Banner reuses the same admitted step set as rigid, no Banner-specific steps invented", () => {
    const result = buildSignCompositionPlan(bannerCompositionInput());
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const forbidden = new Set([
      "reconstruct_parametric_frame",
      "reconstruct_perimeter_structure",
      "reflow_structural_layout",
    ]);
    assert.ok(result.plan.steps.every((s) => !forbidden.has(s.kind)));
  });

  it("plan identity differs from an equivalent rigid-sign plan purely through the disjoint policyId — production type is production-significant", () => {
    const bannerResult = buildSignCompositionPlan(bannerCompositionInput());
    const rigidSpec: SignProductionSpec = {
      category: RIGID_SIGN_CATEGORY,
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      confirmedAt: "2026-09-08T12:00:00.000Z",
      resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
    };
    const rigidResult = buildSignCompositionPlan({
      spec: rigidSpec,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      sourceAssetId: "asset-banner-1",
      sourceSha256: "b".repeat(64),
      sourceWidthPx: 1086,
      sourceHeightPx: 1448,
      reconstruction: null,
      crop: null,
      fitBackground: { r: 255, g: 255, b: 255 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    assert.equal(bannerResult.status, "built");
    assert.equal(rigidResult.status, "built");
    if (bannerResult.status !== "built" || rigidResult.status !== "built") return;
    assert.notEqual(bannerResult.plan.policyId, rigidResult.plan.policyId);
    assert.notEqual(bannerResult.plan.planKey, rigidResult.plan.planKey);
  });
});
