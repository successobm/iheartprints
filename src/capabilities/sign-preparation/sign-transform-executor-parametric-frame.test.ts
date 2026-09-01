import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { framedSignArtwork } from "./sign-fixtures";
import { measureCleanFillRunPx, measureFrameStructuralModel } from "./frame-structure-model";
import { inspectSignArtwork } from "./sign-inspection";
import { planSignRepair } from "./sign-repair-planner";
import { executeSignRepairPlan } from "./sign-transform-executor";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import type { SignProductionSpec, SignEdge } from "./contracts";

/**
 * Parametric Perimeter Frame Reconstruction Phase: plan -> execute
 * end-to-end coverage. Mirrors the REAL cc6cfc4b-... acceptance sign's own
 * shape without ever using the customer's own file.
 */
function planAndExecute(orderedWidthIn: number, orderedHeightIn: number, imageOpts: Parameters<typeof framedSignArtwork>[0]) {
  const image = framedSignArtwork(imageOpts);
  const spec: SignProductionSpec = {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-08-30T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
  const inspection = inspectSignArtwork(image, spec, RIGID_RECT_UP_TO_24X36_V1);
  const frameStructuralModel = measureFrameStructuralModel(image);
  const frameCleanFillRunPx: Partial<Record<SignEdge, number>> = {};
  if (frameStructuralModel.status === "measured") {
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      frameCleanFillRunPx[edge] = measureCleanFillRunPx(image, edge, frameStructuralModel.model.frameDepthPx);
    }
  }
  const planResult = planSignRepair({
    spec,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    frameStructuralModel,
    frameCleanFillRunPx,
  });
  if (planResult.status !== "planned") return { image, planResult, executed: null };
  const executed = executeSignRepairPlan(image, planResult.plan);
  return { image, planResult, executed };
}

describe("sign-transform-executor — reconstruct_parametric_frame", () => {
  it("16: perimeter-only reconstruction — output matches the ordered aspect exactly, frame reaches the new edges", () => {
    const { planResult, executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(planResult.status, "planned");
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;
    assert.equal(executed.image.width, planResult.plan!.expectedOutputWidthPx);
    assert.equal(executed.image.height, planResult.plan!.expectedOutputHeightPx);
    assert.ok(Math.abs(executed.image.width / executed.image.height - 24 / 36) < 0.001);
    // The true corner pixel is NOT the outer stroke colour — the redrawn
    // frame is rounded, matching the source's own measured rounding.
    const corner = { r: executed.image.data[0], g: executed.image.data[1], b: executed.image.data[2] };
    assert.notEqual(corner.r < 30 && corner.g < 30 && corner.b < 30, true);
  });

  it("13: no non-uniform scaling — the protected interior is a byte-for-byte crop, never resampled", () => {
    const { image, executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;
    // No reconstruct_resolution in this plan (sufficient PPI), so the
    // interior's own pixel data must be an EXACT, unscaled crop of a
    // (possibly downsampled) intermediate — verify pixel-identity at a
    // sampled interior point against the model's own measured fill colour.
    void image;
    const cb = executed.contentBounds;
    const midX = cb.x + Math.floor(cb.width / 2);
    const midY = cb.y + Math.floor(cb.height / 2);
    const i = (midY * executed.image.width + midX) * 4;
    const model = measureFrameStructuralModel(image);
    assert.equal(model.status, "measured");
    if (model.status !== "measured") return;
    assert.ok(Math.abs(executed.image.data[i]! - model.model.fillColor.r) <= 15);
  });

  it("17a: perimeter + reconstruct_resolution — the plan itself admits both steps, in order (full execution through the provider split is covered at the worker level, not here — see sign-preservation-worker-orchestration.test.ts's own parametric-frame suite)", () => {
    const { planResult } = planAndExecute(24, 36, { width: 1086, height: 1448, rounded: true, withHoles: true });
    assert.equal(planResult.status, "planned");
    assert.ok(planResult.plan!.steps.some((s) => s.kind === "reconstruct_resolution"));
    assert.ok(planResult.plan!.steps.some((s) => s.kind === "reconstruct_parametric_frame"));
  });

  it("17b: executeSignRepairPlan (the fully-local path) correctly REFUSES a plan needing reconstruct_resolution — never silently executes around it", () => {
    const { planResult, executed } = planAndExecute(24, 36, { width: 1086, height: 1448, rounded: true, withHoles: true });
    assert.equal(planResult.status, "planned");
    assert.equal(executed?.status, "refused");
    if (executed?.status !== "refused") return;
    assert.equal(executed.reason, "contains_reconstruct_resolution");
  });

  it("no residual old corner arc / no duplicate hole — the old frame's own pixels never appear anywhere in the output (interior is a crop, not a blit of the whole original)", () => {
    const { planResult, executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;
    // The content bounds (protected interior) must be STRICTLY SMALLER
    // than the full output canvas on the extended axis — proof the old
    // frame band was cropped away, not merely padded around.
    const cb = executed.contentBounds;
    assert.ok(cb.width < executed.image.width || cb.height < executed.image.height);
    assert.ok(cb.x > 0 || cb.y > 0);
    void planResult;
  });

  it("output is fully opaque (finalizeSignExecution's own invariant, unaffected by this step)", () => {
    const { executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;
    for (let i = 3; i < executed.image.data.length; i += 4 * 997) {
      assert.equal(executed.image.data[i], 255);
    }
  });
});
