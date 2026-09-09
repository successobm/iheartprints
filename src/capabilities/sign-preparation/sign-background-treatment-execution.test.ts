/**
 * Constitution amendment 3.2 (§16A.2): the execution-layer relaxation —
 * `sign-transform-executor.ts` / `sign-composition-steps.ts` become
 * background-treatment-AWARE, never background-treatment-BLIND. "keep"
 * (the default, and every pre-amendment call site) must reproduce the
 * original unconditional opaque contract exactly; "remove" must permit
 * ONLY the governed transparency this amendment explicitly authorizes,
 * never silently relax anything else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";

import type { SignRepairPlan, SignRepairStep } from "./contracts";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION } from "./contracts";
import {
  encodeFitArtworkToCanvasParams,
  executeCompositionSteps,
  executeFitArtworkToCanvas,
} from "./sign-composition-steps";
import { executeSignRepairPlan, finalizeSignExecution } from "./sign-transform-executor";
import { fillRect, makeImage } from "./sign-fixtures";

function pixelAt(image: RgbaImage, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]!, a: image.data[i + 3]! };
}

function step(kind: SignRepairStep["kind"], params: Record<string, number | string>): SignRepairStep {
  return { kind, params, risk: "review_required", reasons: ["test"] };
}

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

describe("executeFitArtworkToCanvas: background-treatment-aware padding", () => {
  it("KEEP (default): uncovered canvas padding remains fully opaque — byte-for-byte pre-amendment behavior", () => {
    // 80x60 artwork fit into a wider 100x60 canvas -> padding on left/right.
    const artwork = makeImage(80, 60, { r: 10, g: 10, b: 10 });
    const s = step(
      "fit_artwork_to_canvas",
      encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 80,
        expectedArtworkHeightPx: 60,
        canvasWidthPx: 100,
        canvasHeightPx: 60,
        placementXPx: 10,
        placementYPx: 0,
        backgroundR: 240,
        backgroundG: 240,
        backgroundB: 240,
      }),
    );
    const result = executeFitArtworkToCanvas(artwork, s);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    const padding = pixelAt(result.image, 2, 2); // left padding strip
    assert.deepEqual(padding, { r: 240, g: 240, b: 240, a: 255 });
  });

  it('REMOVE: uncovered canvas padding is TRANSPARENT — no opaque colour is invented for it', () => {
    const artwork = makeImage(80, 60, { r: 10, g: 10, b: 10 });
    const s = step(
      "fit_artwork_to_canvas",
      encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 80,
        expectedArtworkHeightPx: 60,
        canvasWidthPx: 100,
        canvasHeightPx: 60,
        placementXPx: 10,
        placementYPx: 0,
        backgroundR: 240,
        backgroundG: 240,
        backgroundB: 240,
      }),
    );
    const result = executeFitArtworkToCanvas(artwork, s, "remove");
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    const padding = pixelAt(result.image, 2, 2);
    assert.equal(padding.a, 0);
  });

  it("REMOVE: the fitted artwork's OWN alpha (e.g. governed background removal) is carried through unchanged", () => {
    const artwork = makeImage(60, 60, { r: 5, g: 5, b: 5, a: 0 }); // fully "removed" exterior
    fillRect(artwork, 15, 15, 45, 45, { r: 200, g: 20, b: 20, a: 255 }); // opaque subject
    const s = step(
      "fit_artwork_to_canvas",
      encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 60,
        expectedArtworkHeightPx: 60,
        canvasWidthPx: 60,
        canvasHeightPx: 60,
        placementXPx: 0,
        placementYPx: 0,
        backgroundR: 0,
        backgroundG: 0,
        backgroundB: 0,
      }),
    );
    const result = executeFitArtworkToCanvas(artwork, s, "remove");
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(pixelAt(result.image, 2, 2).a, 0); // still-removed exterior
    assert.equal(pixelAt(result.image, 30, 30).a, 255); // subject preserved opaque
  });

  it("executeCompositionSteps threads the treatment through to its own fit_artwork_to_canvas step identically", () => {
    const artwork = makeImage(80, 60, { r: 10, g: 10, b: 10 });
    const s = step(
      "fit_artwork_to_canvas",
      encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 80,
        expectedArtworkHeightPx: 60,
        canvasWidthPx: 100,
        canvasHeightPx: 60,
        placementXPx: 10,
        placementYPx: 0,
        backgroundR: 240,
        backgroundG: 240,
        backgroundB: 240,
      }),
    );
    const result = executeCompositionSteps(
      artwork,
      { x: 0, y: 0, width: artwork.width, height: artwork.height },
      [s],
      "remove",
    );
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(pixelAt(result.image, 2, 2).a, 0);
  });
});

describe("executeSignRepairPlan: background-treatment-aware opacity refusal", () => {
  it("KEEP (default): a transparent source is refused exactly as before this amendment", () => {
    const source = makeImage(50, 50, { r: 10, g: 10, b: 10, a: 0 });
    const plan = basePlan({ steps: [], expectedOutputWidthPx: 50, expectedOutputHeightPx: 50 });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "source_transparent");
  });

  it('REMOVE: a governed-transparent source is permitted through to execution', () => {
    const source = makeImage(50, 50, { r: 10, g: 10, b: 10, a: 0 });
    fillRect(source, 10, 10, 40, 40, { r: 200, g: 20, b: 20, a: 255 });
    const plan = basePlan({
      steps: [],
      expectedOutputWidthPx: 50,
      expectedOutputHeightPx: 50,
      backgroundTreatment: "remove",
    });
    const result = executeSignRepairPlan(source, plan);
    assert.equal(result.status, "executed");
  });
});

describe("finalizeSignExecution: background-treatment-aware output opacity", () => {
  it("KEEP (default): a transparent output is refused exactly as before this amendment", () => {
    const image = makeImage(20, 20, { r: 1, g: 1, b: 1, a: 0 });
    const result = finalizeSignExecution(image, { x: 0, y: 0, width: 20, height: 20 }, 20, 20);
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "output_not_opaque");
  });

  it('REMOVE: a transparent output is permitted — the governed, expected result', () => {
    const image = makeImage(20, 20, { r: 1, g: 1, b: 1, a: 0 });
    const result = finalizeSignExecution(image, { x: 0, y: 0, width: 20, height: 20 }, 20, 20, "remove");
    assert.equal(result.status, "executed");
  });

  it("REMOVE: exact-geometry refusal is UNCONDITIONAL — never relaxed by treatment", () => {
    const image = makeImage(20, 20, { r: 1, g: 1, b: 1, a: 0 });
    const result = finalizeSignExecution(image, { x: 0, y: 0, width: 20, height: 20 }, 25, 25, "remove");
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.equal(result.reason, "output_geometry_mismatch");
  });

  it("I: an opaque output under KEEP still measures hasAnyTransparentPixel === false — unchanged", () => {
    const image = makeImage(20, 20, { r: 1, g: 1, b: 1, a: 255 });
    const result = finalizeSignExecution(image, { x: 0, y: 0, width: 20, height: 20 }, 20, 20);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(hasAnyTransparentPixel(result.image), false);
  });
});
