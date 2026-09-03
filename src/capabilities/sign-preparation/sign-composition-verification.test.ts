/**
 * Signs Phase 3B (Canvas-First Correction): `verifySignCompositionExecution`
 * — deterministic per-operation + global verification. Proves it catches a
 * one-pixel corruption, an altered region, and a wrong fill, and passes a
 * genuinely correct execution.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { RIGID_SIGN_CATEGORY, type SignProductionSpec } from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { buildSignCompositionPlan } from "./sign-composition-plan-builder";
import { executeCompositionSteps } from "./sign-composition-steps";
import { verifySignCompositionExecution } from "./sign-composition-verification";
import { makeImage, fillRect } from "./sign-fixtures";

function testSpec(): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn: 2,
    orderedHeightIn: 2,
    confirmedAt: "2026-01-01T00:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function buildAndExecute() {
  const artwork = makeImage(200, 200, { r: 255, g: 255, b: 255 });
  fillRect(artwork, 20, 20, 180, 60, { r: 200, g: 0, b: 0 }); // top band
  fillRect(artwork, 20, 140, 180, 180, { r: 0, g: 0, b: 200 }); // bottom band

  const planResult = buildSignCompositionPlan({
    spec: testSpec(),
    policy: RIGID_RECT_UP_TO_24X36_V1,
    sourceAssetId: "asset-1",
    sourceSha256: "b".repeat(64),
    sourceWidthPx: 200,
    sourceHeightPx: 200,
    reconstruction: null,
    crop: null,
    fitBackground: { r: 255, g: 255, b: 255 },
    fitPlacement: null,
    moves: [{ sourceStartYPx: 20, heightPx: 40, destStartYPx: 0 }],
    fills: [{ xPx: 0, yPx: 190, widthPx: 200, heightPx: 10, color: { r: 10, g: 10, b: 10 } }],
  });
  if (planResult.status !== "built") throw new Error("test setup: plan build failed");
  const plan = planResult.plan;
  const compositionSteps = plan.steps; // no reconstruction step in this fixture
  const bounds = { x: 0, y: 0, width: artwork.width, height: artwork.height };
  const executed = executeCompositionSteps(artwork, bounds, compositionSteps);
  if (executed.status !== "executed") throw new Error("test setup: execution failed");
  return { artwork, plan, produced: executed.image };
}

function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

describe("verifySignCompositionExecution", () => {
  it("passes for a genuinely correct execution", () => {
    const { artwork, plan, produced } = buildAndExecute();
    const result = verifySignCompositionExecution(artwork, plan, produced);
    assert.equal(result.status, "pass");
    assert.ok(result.checks.every((c) => c.status === "pass"));
  });

  it("detects a single corrupted pixel", () => {
    const { artwork, plan, produced } = buildAndExecute();
    const corrupted = cloneImage(produced);
    const i = (100 * corrupted.width + 100) * 4;
    corrupted.data[i] = (corrupted.data[i]! + 1) % 256;
    const result = verifySignCompositionExecution(artwork, plan, corrupted);
    assert.equal(result.status, "fail");
    assert.ok(result.checks.some((c) => c.check === "pixel_exact_recomputation" && c.status === "fail"));
  });

  it("detects an altered (shifted) region", () => {
    const { artwork, plan, produced } = buildAndExecute();
    const altered = cloneImage(produced);
    // Overwrite a whole row with an unrelated colour, simulating an
    // altered/corrupted region.
    const rowBytes = altered.width * 4;
    for (let x = 0; x < altered.width; x++) {
      const i = 50 * rowBytes + x * 4;
      altered.data[i] = 77; altered.data[i + 1] = 88; altered.data[i + 2] = 99; altered.data[i + 3] = 255;
    }
    const result = verifySignCompositionExecution(artwork, plan, altered);
    assert.equal(result.status, "fail");
  });

  it("detects a wrong fill colour", () => {
    const { artwork, plan, produced } = buildAndExecute();
    const wrongFill = cloneImage(produced);
    const rowBytes = wrongFill.width * 4;
    for (let x = 0; x < wrongFill.width; x++) {
      const i = 195 * rowBytes + x * 4;
      wrongFill.data[i] = 255; wrongFill.data[i + 1] = 0; wrongFill.data[i + 2] = 0; wrongFill.data[i + 3] = 255;
    }
    const result = verifySignCompositionExecution(artwork, plan, wrongFill);
    assert.equal(result.status, "fail");
  });

  it("fails on a dimension mismatch before ever comparing pixels", () => {
    const { artwork, plan, produced } = buildAndExecute();
    const wrongDims: RgbaImage = { width: produced.width + 1, height: produced.height, data: Buffer.alloc((produced.width + 1) * produced.height * 4) };
    const result = verifySignCompositionExecution(artwork, plan, wrongDims);
    assert.equal(result.status, "fail");
    assert.ok(result.checks.some((c) => c.check === "exact_final_dimensions" && c.status === "fail"));
  });
});
