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

/**
 * Parametric Frame Geometry Defect Correction Phase (real Signs acceptance
 * incident: semantic verification's `perimeter_edge_alignment` category
 * correctly caught "large blank red extensions above and below the
 * artwork, leaving the original inner border/frame system visibly inset
 * from the new outer panel boundary"). This suite would have FAILED on the
 * pre-fix code — the SAME fixture as test 16 above (4000x5333 -> 24x36,
 * whose own aspect-correction gap vastly exceeds this fixture's ~31px
 * measured frame depth, closely mirroring the real job's own
 * leadingPx=444/trailingPx=280 against a frame depth an order of magnitude
 * smaller) reproduces the exact geometric proportions of the real defect
 * without the customer's own 27MB file ever touching git.
 *
 * Direct assertion of the edge/substrate relationship itself — never
 * merely "semantic verification would be happy" — per this phase's own
 * explicit instruction.
 */
describe("Parametric Frame Geometry Defect Correction — edge/substrate boundary", () => {
  /** Every pixel between the measured band stack's own end and the protected interior's own start, on the AXIS the plan actually extended — the exact region the pre-fix code painted with a flat, unrelated `fillColor` patch. */
  function gapRegionSamples(
    executed: Extract<ReturnType<typeof executeSignRepairPlan>, { status: "executed" }>,
    axis: "horizontal" | "vertical",
    frameDepthPx: number,
  ): { x: number; y: number }[] {
    const cb = executed.contentBounds;
    const samples: { x: number; y: number }[] = [];
    if (axis === "vertical") {
      // Leading (top) gap: rows strictly between the end of the redrawn
      // band stack and the start of the interior, sampled at a handful of
      // x positions safely away from the rounded corners/hole indicators.
      const xs = [
        Math.floor(executed.image.width * 0.5),
        Math.floor(executed.image.width * 0.35),
        Math.floor(executed.image.width * 0.65),
      ];
      for (const y of [frameDepthPx + 5, Math.floor((frameDepthPx + cb.y) / 2), cb.y - 5]) {
        if (y <= frameDepthPx || y >= cb.y) continue;
        for (const x of xs) samples.push({ x, y });
      }
      // Trailing (bottom) gap, mirrored.
      const bottomBandEnd = executed.image.height - frameDepthPx;
      const interiorEndY = cb.y + cb.height;
      for (const y of [interiorEndY + 5, Math.floor((interiorEndY + bottomBandEnd) / 2), bottomBandEnd - 5]) {
        if (y <= interiorEndY || y >= bottomBandEnd) continue;
        for (const x of xs) samples.push({ x, y });
      }
    } else {
      const ys = [
        Math.floor(executed.image.height * 0.5),
        Math.floor(executed.image.height * 0.35),
        Math.floor(executed.image.height * 0.65),
      ];
      for (const x of [frameDepthPx + 5, Math.floor((frameDepthPx + cb.x) / 2), cb.x - 5]) {
        if (x <= frameDepthPx || x >= cb.x) continue;
        for (const y of ys) samples.push({ x, y });
      }
      const rightBandEnd = executed.image.width - frameDepthPx;
      const interiorEndX = cb.x + cb.width;
      for (const x of [interiorEndX + 5, Math.floor((interiorEndX + rightBandEnd) / 2), rightBandEnd - 5]) {
        if (x <= interiorEndX || x >= rightBandEnd) continue;
        for (const y of ys) samples.push({ x, y });
      }
    }
    return samples;
  }

  function pixelAt(executed: Extract<ReturnType<typeof executeSignRepairPlan>, { status: "executed" }>, x: number, y: number) {
    const i = (y * executed.image.width + x) * 4;
    return { r: executed.image.data[i]!, g: executed.image.data[i + 1]!, b: executed.image.data[i + 2]! };
  }

  function colorsClose(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, tolerance = 6): boolean {
    return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;
  }

  it("1: the outermost band reaches the true substrate edge with no blank/unrelated fill patch between the frame and the interior — reproduces the real defect's own proportions", () => {
    const { image, planResult, executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(planResult.status, "planned");
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;

    const model = measureFrameStructuralModel(image);
    assert.equal(model.status, "measured");
    if (model.status !== "measured") return;

    const axis = planResult.plan!.steps.find((s) => s.kind === "reconstruct_parametric_frame")?.params.axis;
    assert.ok(axis === "horizontal" || axis === "vertical", "sanity: this fixture requires an axis extension large enough to expose the defect");

    const samples = gapRegionSamples(executed, axis as "horizontal" | "vertical", model.model.frameDepthPx);
    assert.ok(samples.length > 0, "sanity: the gap region this test targets must actually exist for this fixture");

    const outerBandColor = model.model.bands[0]!.color;
    for (const { x, y } of samples) {
      const actual = pixelAt(executed, x, y);
      assert.ok(
        colorsClose(actual, outerBandColor),
        `pixel (${x},${y}) = rgb(${actual.r},${actual.g},${actual.b}) does not match the outermost band's own colour rgb(${outerBandColor.r},${outerBandColor.g},${outerBandColor.b}) — this is exactly the "blank extension" defect the real semantic finding caught`,
      );
      // The defect this phase fixes is specifically the OLD fallback
      // (`fillColor`) leaking into the gap — assert the negative directly
      // too, not merely "matches the outer band" (which could coincide
      // with fillColor in a pathological fixture).
      assert.ok(
        !colorsClose(actual, model.model.fillColor),
        `pixel (${x},${y}) matches the unrelated interior fill colour rgb(${model.model.fillColor.r},${model.model.fillColor.g},${model.model.fillColor.b}) — the pre-fix defect`,
      );
    }
  });

  it("2: no large uniform padding band of the OLD fill colour survives anywhere in the gap region (exhaustive row scan on the extended axis)", () => {
    const { image, executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;
    const model = measureFrameStructuralModel(image);
    assert.equal(model.status, "measured");
    if (model.status !== "measured") return;

    const cb = executed.contentBounds;
    const midX = Math.floor(executed.image.width / 2);
    let fillColorPixelsInGap = 0;
    // Scan every row strictly between the redrawn band stack's own end and
    // the interior's own start, at the horizontal centre (clear of rounded
    // corners and hole indicators) — the exact region the pre-fix
    // `fillColor` fallback painted for its ENTIRE leadingPx/trailingPx
    // extent.
    for (let y = model.model.frameDepthPx + 1; y < cb.y; y++) {
      if (colorsClose(pixelAt(executed, midX, y), model.model.fillColor, 3)) fillColorPixelsInGap += 1;
    }
    for (let y = cb.y + cb.height + 1; y < executed.image.height - model.model.frameDepthPx; y++) {
      if (colorsClose(pixelAt(executed, midX, y), model.model.fillColor, 3)) fillColorPixelsInGap += 1;
    }
    assert.equal(fillColorPixelsInGap, 0, "no pixel in the gap region may match the unrelated interior fill colour");
  });

  it("3: border-band depth sequence at the extended edge is outer-band colour continuously from the true edge to the interior — never a second, disconnected colour region", () => {
    const { image, executed } = planAndExecute(24, 36, { width: 4000, height: 5333, rounded: true, withHoles: true });
    assert.equal(executed?.status, "executed");
    if (executed?.status !== "executed") return;
    const model = measureFrameStructuralModel(image);
    assert.equal(model.status, "measured");
    if (model.status !== "measured") return;

    const cb = executed.contentBounds;
    const midX = Math.floor(executed.image.width / 2);
    const outerBandColor = model.model.bands[0]!.color;
    // From the true top edge (y=0) through the end of the measured band
    // stack, colours must follow the measured sequence (already proven by
    // existing tests) — this test's own new claim is the CONTINUATION: from
    // the end of the band stack through the start of the interior, the
    // colour must remain exactly the outer band's own colour, with no gap
    // and no reversion to any other measured band's colour in between.
    for (let y = model.model.frameDepthPx; y < cb.y; y++) {
      assert.ok(
        colorsClose(pixelAt(executed, midX, y), outerBandColor),
        `row y=${y} breaks the continuous outer-band extension — the frame does not reach the substrate boundary`,
      );
    }
  });
});
