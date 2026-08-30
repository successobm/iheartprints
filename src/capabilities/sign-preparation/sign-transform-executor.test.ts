import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";

import type { SignRepairPlan, SignRepairStep } from "./contracts";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION } from "./contracts";
import {
  encodeSignPlate,
  executeSignRepairPlan,
  planContainsOnlyAdmittedSteps,
} from "./sign-transform-executor";
import { decodePngUpload } from "@/capabilities/artwork-preparation/image-decode";
import { fillRect, makeImage } from "./sign-fixtures";

function basePlan(overrides: Partial<SignRepairPlan> & { steps: SignRepairStep[] }): SignRepairPlan {
  return {
    schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
    policyId: "rigid_rect_up_to_24x36:v1",
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    sourceWidthPx: 100,
    sourceHeightPx: 100,
    orderedWidthIn: 10,
    orderedHeightIn: 10,
    expectedOutputWidthPx: 100,
    expectedOutputHeightPx: 100,
    expectedEffectivePpi: 10,
    overallRisk: "auto_safe",
    defects: [],
    reasons: [],
    planKey: "sign-repair-plan:v1:test",
    ...overrides,
  };
}

function opaqueImage(width: number, height: number): RgbaImage {
  const image = makeImage(width, height, { r: 6, g: 6, b: 6 });
  fillRect(image, Math.floor(width * 0.25), Math.floor(height * 0.25), Math.floor(width * 0.75), Math.floor(height * 0.75), { r: 250, g: 250, b: 250 });
  return image;
}

describe("sign-transform-executor: extend/pad uniform background", () => {
  it("1/2: extends exact pixels with the exact recorded fill colour, content offset exactly as planned", () => {
    const source = opaqueImage(100, 60);
    const plan = basePlan({
      sourceWidthPx: 100,
      sourceHeightPx: 60,
      expectedOutputWidthPx: 140,
      expectedOutputHeightPx: 60,
      steps: [
        {
          kind: "extend_uniform_background",
          params: { axis: "horizontal", leadingPx: 20, trailingPx: 20, colorR: 6, colorG: 6, colorB: 6 },
          risk: "auto_safe",
          reasons: [],
        },
      ],
    });

    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 140);
    assert.equal(result.image.height, 60);
    assert.deepEqual(result.contentBounds, { x: 20, y: 0, width: 100, height: 60 });

    // Exact fill colour on the added strip.
    const output = result.image;
    const px = (x: number, y: number) => {
      const i = (y * output.width + x) * 4;
      return [output.data[i], output.data[i + 1], output.data[i + 2], output.data[i + 3]];
    };
    assert.deepEqual(px(5, 30), [6, 6, 6, 255]);
    assert.deepEqual(px(135, 30), [6, 6, 6, 255]);

    // Original content pixels copied byte-for-byte at the exact offset.
    for (let y = 0; y < source.height; y += 7) {
      for (let x = 0; x < source.width; x += 7) {
        const srcI = (y * source.width + x) * 4;
        const destI = (y * output.width + (x + 20)) * 4;
        assert.deepEqual(
          [output.data[destI], output.data[destI + 1], output.data[destI + 2], output.data[destI + 3]],
          [source.data[srcI], source.data[srcI + 1], source.data[srcI + 2], source.data[srcI + 3]],
        );
      }
    }
  });

  it("pad_uniform_background behaves identically to extend for pixel placement", () => {
    const source = opaqueImage(50, 80);
    const plan = basePlan({
      sourceWidthPx: 50,
      sourceHeightPx: 80,
      expectedOutputWidthPx: 50,
      expectedOutputHeightPx: 100,
      steps: [
        {
          kind: "pad_uniform_background",
          params: { axis: "vertical", leadingPx: 10, trailingPx: 10, colorR: 6, colorG: 6, colorB: 6 },
          risk: "review_required",
          reasons: [],
        },
      ],
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.height, 100);
    assert.deepEqual(result.contentBounds, { x: 0, y: 10, width: 50, height: 80 });
  });

  it("refuses rather than inventing a fill colour when the plan carries none", () => {
    const source = opaqueImage(40, 40);
    const plan = basePlan({
      sourceWidthPx: 40,
      sourceHeightPx: 40,
      steps: [
        {
          kind: "pad_uniform_background",
          params: { axis: "horizontal", leadingPx: 5, trailingPx: 5, color: "unconfirmed" },
          risk: "review_required",
          reasons: [],
        },
      ],
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "unconfirmed_fill_color");
  });
});

describe("sign-transform-executor: downsample / proportional_resample", () => {
  it("3: downsample produces the exact requested output pixel geometry", () => {
    const source = opaqueImage(400, 400);
    const plan = basePlan({
      sourceWidthPx: 400,
      sourceHeightPx: 400,
      expectedOutputWidthPx: 200,
      expectedOutputHeightPx: 200,
      steps: [
        {
          kind: "downsample",
          params: { targetWidthPx: 200, targetHeightPx: 200 },
          risk: "auto_safe",
          reasons: [],
        },
      ],
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 200);
    assert.equal(result.image.height, 200);
    assert.equal(hasAnyTransparentPixel(result.image), false);
  });

  it("4: proportional_resample produces the exact requested output pixel geometry", () => {
    const source = opaqueImage(100, 150);
    const plan = basePlan({
      sourceWidthPx: 100,
      sourceHeightPx: 150,
      expectedOutputWidthPx: 300,
      expectedOutputHeightPx: 450,
      steps: [
        {
          kind: "proportional_resample",
          params: { targetWidthPx: 300, targetHeightPx: 450 },
          risk: "auto_safe",
          reasons: [],
        },
      ],
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 300);
    assert.equal(result.image.height, 450);
  });
});

describe("sign-transform-executor: rotate_90", () => {
  it("5: rotate_90 swaps dimensions exactly and preserves every pixel", () => {
    const source = makeImage(4, 2, { r: 0, g: 0, b: 0 });
    // A distinctive marker at (3,0) — top-right corner — to trace rotation.
    fillRect(source, 3, 0, 4, 1, { r: 200, g: 10, b: 10 });

    const plan = basePlan({
      sourceWidthPx: 4,
      sourceHeightPx: 2,
      expectedOutputWidthPx: 2,
      expectedOutputHeightPx: 4,
      steps: [{ kind: "rotate_90", params: { direction: "cw" }, risk: "review_required", reasons: [] }],
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 2);
    assert.equal(result.image.height, 4);

    // Every source pixel must be preserved: the single-pixel marker
    // survives rotation exactly (count unchanged, position moved).
    let markerCount = 0;
    for (let i = 0; i < result.image.data.length; i += 4) {
      if (result.image.data[i] === 200) markerCount++;
    }
    assert.equal(markerCount, 1);
  });
});

describe("sign-transform-executor: admitted-step refusals", () => {
  it("6: a plan containing reconstruct_resolution refuses with zero pixels touched", () => {
    const source = opaqueImage(50, 50);
    const plan = basePlan({
      sourceWidthPx: 50,
      sourceHeightPx: 50,
      steps: [
        { kind: "reconstruct_resolution", params: { requestedScale: 2, requestedWidthPx: 100, requestedHeightPx: 100 }, risk: "auto_safe", reasons: [] },
      ],
    });
    assert.equal(planContainsOnlyAdmittedSteps(plan), false);
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "contains_reconstruct_resolution");
  });

  it("7: a plan containing approved_crop refuses — never part of S2 automatic execution", () => {
    const source = opaqueImage(50, 50);
    const plan = basePlan({
      sourceWidthPx: 50,
      sourceHeightPx: 50,
      steps: [{ kind: "approved_crop", params: { x: 0, y: 0, width: 40, height: 40 }, risk: "review_required", reasons: [] }],
    });
    assert.equal(planContainsOnlyAdmittedSteps(plan), false);
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "contains_approved_crop");
  });

  it("a transparent source refuses — no S2 step flattens or invents a colour", () => {
    const source = makeImage(20, 20, { r: 6, g: 6, b: 6, a: 0 });
    const plan = basePlan({ sourceWidthPx: 20, sourceHeightPx: 20, steps: [] });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "source_transparent");
  });

  it("11: an output-geometry mismatch against the recorded plan refuses rather than persisting", () => {
    const source = opaqueImage(50, 50);
    const plan = basePlan({
      sourceWidthPx: 50,
      sourceHeightPx: 50,
      expectedOutputWidthPx: 999, // deliberately wrong
      expectedOutputHeightPx: 999,
      steps: [],
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "output_geometry_mismatch");
  });

  it("a no-op plan (already exact) executes with content bounds covering the whole frame", () => {
    const source = opaqueImage(80, 80);
    const plan = basePlan({ sourceWidthPx: 80, sourceHeightPx: 80, expectedOutputWidthPx: 80, expectedOutputHeightPx: 80, steps: [] });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(result.contentBounds, { x: 0, y: 0, width: 80, height: 80 });
  });
});

describe("sign-transform-executor: PNG encode", () => {
  it("12/13: encodes a valid, decodable, opaque PNG", () => {
    const image = opaqueImage(30, 30);
    const bytes = encodeSignPlate(image);
    const decoded = decodePngUpload(bytes);
    assert.equal(decoded.image.width, 30);
    assert.equal(decoded.image.height, 30);
    assert.equal(hasAnyTransparentPixel(decoded.image), false);
  });
});
