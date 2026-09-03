/**
 * Signs Phase 3A: `reflow_structural_layout` execution — the first version
 * of this step this codebase ever executes. Synthetic, hand-derived
 * fixtures (never the real customer file).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION, type SignRepairPlan, type SignRepairStep } from "./contracts";
import {
  adaptGeometryStepsToActualReconstruction,
  executeAdmittedSignSteps,
  executeSignRepairPlan,
  finalizeSignExecution,
  planContainsOnlyAdmittedSteps,
  SIGN_EXECUTION_IMPLEMENTATION_VERSION,
} from "./sign-transform-executor";
import { makeImage, fillRect } from "./sign-fixtures";

function pixelAt(image: RgbaImage, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]!, a: image.data[i + 3]! };
}

/**
 * 100x150 source: region0 (top_anchor, rows 0-29, fill {200,0,0}) — the
 * outer 10 rows are the fill, the inner "content" a distinct colour so
 * translation is provable; gap0 rows 30-59 ({10,10,10}); region1 (middle,
 * rows 60-79, content {50,150,50}); gap1 rows 80-109 ({20,20,20});
 * region2 (bottom_anchor, rows 110-149, fill {0,0,200}).
 */
function reflowFixtureImage(): RgbaImage {
  const image = makeImage(100, 150, { r: 0, g: 0, b: 0 });
  fillRect(image, 0, 0, 100, 10, { r: 200, g: 0, b: 0 }); // region0 fill (top).
  fillRect(image, 0, 10, 100, 30, { r: 250, g: 100, b: 100 }); // region0 content.
  fillRect(image, 0, 30, 100, 60, { r: 10, g: 10, b: 10 }); // gap0.
  fillRect(image, 0, 60, 100, 80, { r: 50, g: 150, b: 50 }); // region1 (middle) content.
  fillRect(image, 0, 80, 100, 110, { r: 20, g: 20, b: 20 }); // gap1.
  fillRect(image, 0, 110, 100, 140, { r: 100, g: 100, b: 250 }); // region2 content.
  fillRect(image, 0, 140, 100, 150, { r: 0, g: 0, b: 200 }); // region2 fill (bottom).
  return image;
}

function reflowStep(): SignRepairStep {
  return {
    kind: "reflow_structural_layout",
    risk: "review_required",
    reasons: ["test"],
    params: {
      axis: "vertical",
      totalAddedPx: 50,
      sourceWidthPx: 100,
      sourceHeightPx: 150,
      templateWidthIn: 10,
      templateHeightIn: 20,
      templateShape: "straight_rectangle",
      templateMinimumSafeInsetIn: 0.125,
      scalingMode: "none",
      layoutTransform: "translate_and_redistribute_gaps",
      regionCount: 3,
      gapCount: 2,
      region0Id: "region-0",
      region0Role: "top_anchor",
      region0SourceStartYPx: 0,
      region0SourceHeightPx: 30,
      region0ContentStartYPx: 10,
      region0ContentHeightPx: 20,
      region0FillEdgeReaching: "true",
      region0Expandable: "true",
      region0FillColorR: 200,
      region0FillColorG: 0,
      region0FillColorB: 0,
      region1Id: "region-1",
      region1Role: "middle",
      region1SourceStartYPx: 60,
      region1SourceHeightPx: 20,
      region1ContentStartYPx: 60,
      region1ContentHeightPx: 20,
      region1FillEdgeReaching: "false",
      region1Expandable: "false",
      region2Id: "region-2",
      region2Role: "bottom_anchor",
      region2SourceStartYPx: 110,
      region2SourceHeightPx: 40,
      region2ContentStartYPx: 110,
      region2ContentHeightPx: 30,
      region2FillEdgeReaching: "true",
      region2Expandable: "true",
      region2FillColorR: 0,
      region2FillColorG: 0,
      region2FillColorB: 200,
      gap0SourceHeightPx: 30,
      gap0FillColorR: 10,
      gap0FillColorG: 10,
      gap0FillColorB: 10,
      gap1SourceHeightPx: 30,
      gap1FillColorR: 20,
      gap1FillColorG: 20,
      gap1FillColorB: 20,
    },
  };
}

describe("executeSignRepairPlan — reflow_structural_layout (Phase 3A)", () => {
  it("A: translates regions verbatim, redistributes added height proportionally across gaps, exactly matches ordered template output dimensions", () => {
    const source = reflowFixtureImage();
    const plan: SignRepairPlan = {
      schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
      policyId: "test",
      sourceAssetId: "test",
      sourceSha256: "test",
      sourceWidthPx: 100,
      sourceHeightPx: 150,
      orderedWidthIn: 10,
      orderedHeightIn: 20,
      steps: [reflowStep()],
      expectedOutputWidthPx: 100,
      expectedOutputHeightPx: 200,
      expectedEffectivePpi: 10,
      overallRisk: "review_required" as const,
      defects: [],
      reasons: [],
      planKey: "test",
    };

    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;

    assert.equal(result.image.width, 100);
    assert.equal(result.image.height, 200);

    // region0 (top_anchor): translated verbatim to rows [0,30).
    assert.deepEqual(pixelAt(result.image, 5, 0), { r: 200, g: 0, b: 0, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 29), { r: 250, g: 100, b: 100, a: 255 });

    // gap0: new height 30 (original) + 25 (half of 50 added, proportional
    // to its own 30/(30+30) share) = 55, filled flat, rows [30,85).
    assert.deepEqual(pixelAt(result.image, 5, 30), { r: 10, g: 10, b: 10, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 84), { r: 10, g: 10, b: 10, a: 255 });

    // region1 (middle): translated verbatim to rows [85,105).
    assert.deepEqual(pixelAt(result.image, 5, 85), { r: 50, g: 150, b: 50, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 104), { r: 50, g: 150, b: 50, a: 255 });

    // gap1: rows [105,160).
    assert.deepEqual(pixelAt(result.image, 5, 105), { r: 20, g: 20, b: 20, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 159), { r: 20, g: 20, b: 20, a: 255 });

    // region2 (bottom_anchor): translated verbatim to rows [160,200).
    assert.deepEqual(pixelAt(result.image, 5, 160), { r: 100, g: 100, b: 250, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 199), { r: 0, g: 0, b: 200, a: 255 });

    assert.equal(result.contentBounds.height, 200);
  });

  it("B: is opaque, straight-rectangular, and admitted by the executor (SIGN_EXECUTION_IMPLEMENTATION_VERSION is v3)", () => {
    const plan: SignRepairPlan = {
      schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
      policyId: "test",
      sourceAssetId: "test",
      sourceSha256: "test",
      sourceWidthPx: 100,
      sourceHeightPx: 150,
      orderedWidthIn: 10,
      orderedHeightIn: 20,
      steps: [reflowStep()],
      expectedOutputWidthPx: 100,
      expectedOutputHeightPx: 200,
      expectedEffectivePpi: 10,
      overallRisk: "review_required" as const,
      defects: [],
      reasons: [],
      planKey: "test",
    };
    assert.equal(planContainsOnlyAdmittedSteps(plan), true);
    assert.equal(SIGN_EXECUTION_IMPLEMENTATION_VERSION, "sign-execution-v3");
  });

  it("C: adapts to an ACTUAL image taller than the plan's own recorded sourceHeightPx (simulating a Topaz reconstruction whose actual scale diverged from what was requested) — proportional translation, not a crash or silent misplacement", () => {
    // Simulate a 2x proportional reconstruction: the "source" the reflow
    // step actually receives is 200x300 (2x the plan's own recorded
    // 100x150), never re-decoded from the original — exactly what a
    // preceding reconstruct_resolution step's ACTUAL (not requested)
    // output would look like.
    const reconstructed = makeImage(200, 300, { r: 0, g: 0, b: 0 });
    fillRect(reconstructed, 0, 0, 200, 20, { r: 200, g: 0, b: 0 }); // region0 fill (top), scaled 2x -> 0-19.
    fillRect(reconstructed, 0, 20, 200, 60, { r: 250, g: 100, b: 100 }); // region0 content, 20-59.
    fillRect(reconstructed, 0, 60, 200, 120, { r: 10, g: 10, b: 10 }); // gap0, 60-119.
    fillRect(reconstructed, 0, 120, 200, 160, { r: 50, g: 150, b: 50 }); // region1, 120-159.
    fillRect(reconstructed, 0, 160, 200, 220, { r: 20, g: 20, b: 20 }); // gap1, 160-219.
    fillRect(reconstructed, 0, 220, 200, 280, { r: 100, g: 100, b: 250 }); // region2 content, 220-279.
    fillRect(reconstructed, 0, 280, 200, 300, { r: 0, g: 0, b: 200 }); // region2 fill (bottom), 280-299.

    // Mirrors the REAL worker's own S3C usage exactly:
    // `adaptGeometryStepsToActualReconstruction` first (never
    // `executeSignRepairPlan` directly — that path only ever checks the
    // plan's own STALE predicted dimensions, by design, and correctly
    // refuses when they no longer match reality), producing adapted steps
    // + adapted expected output dimensions, THEN `executeAdmittedSignSteps`
    // + `finalizeSignExecution` against those adapted values.
    const adaptation = adaptGeometryStepsToActualReconstruction(
      [reflowStep()],
      200, // actualReconstructedWidthPx
      300, // actualReconstructedHeightPx
      170, // requestedReconstructionWidthPx (whatever was originally requested — irrelevant here since it differs from actual)
      255, // requestedReconstructionHeightPx
      10, // orderedWidthIn
      20, // orderedHeightIn
      100, // plannedExpectedOutputWidthPx
      200, // plannedExpectedOutputHeightPx
    );
    assert.equal(adaptation.status, "adapted");
    if (adaptation.status !== "adapted") return;
    assert.equal(adaptation.expectedOutputWidthPx, 200);
    assert.equal(adaptation.expectedOutputHeightPx, 400);

    const executed = executeAdmittedSignSteps(
      reconstructed,
      { x: 0, y: 0, width: reconstructed.width, height: reconstructed.height },
      adaptation.steps,
    );
    assert.equal(executed.status, "executed");
    if (executed.status !== "executed") return;
    const result = finalizeSignExecution(
      executed.image,
      executed.contentBounds,
      adaptation.expectedOutputWidthPx,
      adaptation.expectedOutputHeightPx,
    );
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;

    // Output width matches the ACTUAL (2x) image width, unchanged; height
    // is derived from THAT width against the 10:20 template (2x of 200).
    assert.equal(result.image.width, 200);
    assert.equal(result.image.height, 400);

    // region0's own fill, translated (scaled 2x by construction of this
    // fixture) to the very top of the output.
    assert.deepEqual(pixelAt(result.image, 5, 0), { r: 200, g: 0, b: 0, a: 255 });
    // region2's own fill reaches the very bottom.
    assert.deepEqual(pixelAt(result.image, 5, 399), { r: 0, g: 0, b: 200, a: 255 });
  });

  it("D: redistributes added height EQUALLY across gaps of very different original sizes (never proportionally), and preserves analysis-window leading/trailing SOURCE bands verbatim — the real cc6cfc4b-... acceptance shape", () => {
    // 100x140 source: leading band [0,10) — SOURCE rows outside the
    // analysis window (a measured decorative frame border, on a real
    // sign) — region0 [10,40) (fill+content), gap0 [40,70) (30px), region1
    // (middle) [70,90) (20px), gap1 [90,100) (10px — deliberately
    // asymmetric vs gap0), region2 [100,130) (content+fill), trailing band
    // [130,140).
    const source = makeImage(100, 140, { r: 0, g: 0, b: 0 });
    fillRect(source, 0, 0, 100, 10, { r: 50, g: 50, b: 50 }); // leading band.
    fillRect(source, 0, 10, 100, 20, { r: 200, g: 0, b: 0 }); // region0 fill.
    fillRect(source, 0, 20, 100, 40, { r: 250, g: 100, b: 100 }); // region0 content.
    fillRect(source, 0, 40, 100, 70, { r: 10, g: 10, b: 10 }); // gap0 (30px).
    fillRect(source, 0, 70, 100, 90, { r: 50, g: 150, b: 50 }); // region1 (middle).
    fillRect(source, 0, 90, 100, 100, { r: 20, g: 20, b: 20 }); // gap1 (10px — asymmetric).
    fillRect(source, 0, 100, 100, 120, { r: 100, g: 100, b: 250 }); // region2 content.
    fillRect(source, 0, 120, 100, 130, { r: 0, g: 0, b: 200 }); // region2 fill.
    fillRect(source, 0, 130, 100, 140, { r: 80, g: 80, b: 80 }); // trailing band.

    const step: SignRepairStep = {
      kind: "reflow_structural_layout",
      risk: "review_required",
      reasons: ["test"],
      params: {
        axis: "vertical",
        totalAddedPx: 60,
        sourceWidthPx: 100,
        sourceHeightPx: 140,
        templateWidthIn: 10,
        templateHeightIn: 20,
        templateShape: "straight_rectangle",
        templateMinimumSafeInsetIn: 0.125,
        scalingMode: "none",
        layoutTransform: "translate_and_redistribute_gaps",
        regionCount: 3,
        gapCount: 2,
        analysisWindowXPx: 0,
        analysisWindowYPx: 10,
        analysisWindowWidthPx: 100,
        analysisWindowHeightPx: 120,
        region0Id: "region-0",
        region0Role: "top_anchor",
        region0SourceStartYPx: 10,
        region0SourceHeightPx: 30,
        region0ContentStartYPx: 20,
        region0ContentHeightPx: 20,
        region0FillEdgeReaching: "true",
        region0Expandable: "true",
        region0FillColorR: 200,
        region0FillColorG: 0,
        region0FillColorB: 0,
        region1Id: "region-1",
        region1Role: "middle",
        region1SourceStartYPx: 70,
        region1SourceHeightPx: 20,
        region1ContentStartYPx: 70,
        region1ContentHeightPx: 20,
        region1FillEdgeReaching: "false",
        region1Expandable: "false",
        region2Id: "region-2",
        region2Role: "bottom_anchor",
        region2SourceStartYPx: 100,
        region2SourceHeightPx: 30,
        region2ContentStartYPx: 100,
        region2ContentHeightPx: 20,
        region2FillEdgeReaching: "true",
        region2Expandable: "true",
        region2FillColorR: 0,
        region2FillColorG: 0,
        region2FillColorB: 200,
        gap0SourceHeightPx: 30,
        gap0FillColorR: 10,
        gap0FillColorG: 10,
        gap0FillColorB: 10,
        gap1SourceHeightPx: 10,
        gap1FillColorR: 20,
        gap1FillColorG: 20,
        gap1FillColorB: 20,
      },
    };
    const plan: SignRepairPlan = {
      schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
      policyId: "test",
      sourceAssetId: "test",
      sourceSha256: "test",
      sourceWidthPx: 100,
      sourceHeightPx: 140,
      orderedWidthIn: 10,
      orderedHeightIn: 20,
      steps: [step],
      expectedOutputWidthPx: 100,
      expectedOutputHeightPx: 200,
      expectedEffectivePpi: 10,
      overallRisk: "review_required",
      defects: [],
      reasons: [],
      planKey: "test",
    };

    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 100);
    assert.equal(result.image.height, 200);

    // Leading band [0,10) preserved verbatim at the very top.
    assert.deepEqual(pixelAt(result.image, 5, 0), { r: 50, g: 50, b: 50, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 9), { r: 50, g: 50, b: 50, a: 255 });
    // region0, translated to [10,40).
    assert.deepEqual(pixelAt(result.image, 5, 10), { r: 200, g: 0, b: 0, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 39), { r: 250, g: 100, b: 100, a: 255 });
    // gap0: EQUAL share (30 of the 60 added, split 2 ways = 30 extra),
    // NOT proportional (which would give gap0 the 3x-larger 45px share
    // since its own original height (30) is 3x gap1's (10)) — new height
    // 30 (original) + 30 (equal share) = 60, at [40,100).
    assert.deepEqual(pixelAt(result.image, 5, 40), { r: 10, g: 10, b: 10, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 99), { r: 10, g: 10, b: 10, a: 255 });
    // region1 (middle), translated to [100,120).
    assert.deepEqual(pixelAt(result.image, 5, 100), { r: 50, g: 150, b: 50, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 119), { r: 50, g: 150, b: 50, a: 255 });
    // gap1: EQUAL share too — new height 10 (original) + 30 (equal share)
    // = 40, at [120,160).
    assert.deepEqual(pixelAt(result.image, 5, 120), { r: 20, g: 20, b: 20, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 159), { r: 20, g: 20, b: 20, a: 255 });
    // region2, translated to [160,190).
    assert.deepEqual(pixelAt(result.image, 5, 160), { r: 100, g: 100, b: 250, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 189), { r: 0, g: 0, b: 200, a: 255 });
    // Trailing band [190,200) preserved verbatim at the very bottom.
    assert.deepEqual(pixelAt(result.image, 5, 190), { r: 80, g: 80, b: 80, a: 255 });
    assert.deepEqual(pixelAt(result.image, 5, 199), { r: 80, g: 80, b: 80, a: 255 });
  });
});
