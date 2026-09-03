/**
 * Signs Phase 3B (Canvas-First Correction): the four composition
 * primitives — `crop_region`, `fit_artwork_to_canvas`, `move_region`,
 * `fill_rect` — and their orchestration (`executeCompositionSteps`).
 * Synthetic fixtures only.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { SignRepairStep } from "./contracts";
import { makeImage, fillRect } from "./sign-fixtures";
import {
  applyFillRect,
  applyMoveRegion,
  deriveUniformFitDimensions,
  encodeCropRegionParams,
  encodeFillRectParams,
  encodeFitArtworkToCanvasParams,
  encodeMoveRegionParams,
  executeCompositionSteps,
  executeCropRegion,
  executeFitArtworkToCanvas,
} from "./sign-composition-steps";

function pixelAt(image: RgbaImage, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]!, a: image.data[i + 3]! };
}

function step(kind: SignRepairStep["kind"], params: Record<string, number | string>): SignRepairStep {
  return { kind, params, risk: "review_required", reasons: ["test"] };
}

describe("sign-composition-steps: crop_region", () => {
  it("crops the exact requested rectangle", () => {
    const image = makeImage(100, 100, { r: 0, g: 0, b: 0 });
    fillRect(image, 10, 10, 40, 40, { r: 200, g: 50, b: 50 }); // 30x30 block at (10,10)
    const s = step("crop_region", encodeCropRegionParams({
      expectedInputWidthPx: 100, expectedInputHeightPx: 100, xPx: 10, yPx: 10, widthPx: 30, heightPx: 30,
    }));
    const result = executeCropRegion(image, s);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 30);
    assert.equal(result.image.height, 30);
    assert.deepEqual(pixelAt(result.image, 0, 0), { r: 200, g: 50, b: 50, a: 255 });
    assert.deepEqual(pixelAt(result.image, 29, 29), { r: 200, g: 50, b: 50, a: 255 });
  });

  it("refuses a crop rectangle that exceeds the input bounds", () => {
    const image = makeImage(50, 50, { r: 0, g: 0, b: 0 });
    const s = step("crop_region", encodeCropRegionParams({
      expectedInputWidthPx: 50, expectedInputHeightPx: 50, xPx: 40, yPx: 40, widthPx: 20, heightPx: 20,
    }));
    const result = executeCropRegion(image, s);
    assert.equal(result.status, "refused");
  });

  it("refuses when the incoming image identity does not match the expected input dimensions", () => {
    const image = makeImage(50, 50, { r: 0, g: 0, b: 0 });
    const s = step("crop_region", encodeCropRegionParams({
      expectedInputWidthPx: 999, expectedInputHeightPx: 999, xPx: 0, yPx: 0, widthPx: 10, heightPx: 10,
    }));
    const result = executeCropRegion(image, s);
    assert.equal(result.status, "refused");
    if (result.status === "refused") {
      assert.match(result.detail, /wrong source identity/);
    }
  });
});

describe("sign-composition-steps: fit_artwork_to_canvas", () => {
  it("uniformly scales, centers, and fills background with no stretch", () => {
    // 100x50 artwork (2:1) into a 100x100 canvas -> uniform scale 1.0 on
    // the limiting width axis is wrong; actual: scale=min(100/100,100/50)=1.0
    // -> fitted 100x50, letterboxed top/bottom with background.
    const artwork = makeImage(100, 50, { r: 10, g: 200, b: 10 });
    const s = step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
      expectedArtworkWidthPx: 100, expectedArtworkHeightPx: 50,
      canvasWidthPx: 100, canvasHeightPx: 100,
      placementXPx: 0, placementYPx: 25,
      backgroundR: 255, backgroundG: 255, backgroundB: 255,
    }));
    const result = executeFitArtworkToCanvas(artwork, s);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 100);
    assert.equal(result.image.height, 100);
    // Background band above the fitted artwork.
    assert.deepEqual(pixelAt(result.image, 50, 5), { r: 255, g: 255, b: 255, a: 255 });
    // Fitted artwork itself.
    assert.deepEqual(pixelAt(result.image, 50, 50), { r: 10, g: 200, b: 10, a: 255 });
    // Background band below.
    assert.deepEqual(pixelAt(result.image, 50, 90), { r: 255, g: 255, b: 255, a: 255 });
  });

  it("derives uniform (never non-uniform) scale from the limiting axis", () => {
    const dims = deriveUniformFitDimensions(200, 100, 100, 100); // 2:1 artwork into 1:1 canvas
    assert.equal(dims.scale, 0.5);
    assert.equal(dims.scaledWidthPx, 100);
    assert.equal(dims.scaledHeightPx, 50);
  });

  it("refuses when the incoming artwork identity does not match the expected dimensions", () => {
    const artwork = makeImage(10, 10, { r: 0, g: 0, b: 0 });
    const s = step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
      expectedArtworkWidthPx: 999, expectedArtworkHeightPx: 999,
      canvasWidthPx: 100, canvasHeightPx: 100, placementXPx: 0, placementYPx: 0,
      backgroundR: 0, backgroundG: 0, backgroundB: 0,
    }));
    const result = executeFitArtworkToCanvas(artwork, s);
    assert.equal(result.status, "refused");
  });

  it("refuses a placement that pushes the fitted artwork outside the canvas", () => {
    const artwork = makeImage(100, 100, { r: 0, g: 0, b: 0 });
    const s = step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
      expectedArtworkWidthPx: 100, expectedArtworkHeightPx: 100,
      canvasWidthPx: 100, canvasHeightPx: 100, placementXPx: 50, placementYPx: 0,
      backgroundR: 0, backgroundG: 0, backgroundB: 0,
    }));
    const result = executeFitArtworkToCanvas(artwork, s);
    assert.equal(result.status, "refused");
  });
});

describe("sign-composition-steps: move_region", () => {
  function baseCanvas(): RgbaImage {
    const image = makeImage(10, 100, { r: 0, g: 0, b: 0 });
    fillRect(image, 0, 0, 10, 20, { r: 255, g: 0, b: 0 }); // band A: rows 0-19
    fillRect(image, 0, 20, 10, 80, { r: 0, g: 255, b: 0 }); // middle: rows 20-79
    fillRect(image, 0, 80, 10, 100, { r: 0, g: 0, b: 255 }); // band B: rows 80-99
    return image;
  }

  it("copies the exact source band to the destination, byte-for-byte, no scaling", () => {
    const base = baseCanvas();
    const working = Buffer.from(base.data);
    const s = step("move_region", encodeMoveRegionParams({ sourceStartYPx: 0, heightPx: 20, destStartYPx: 40 }));
    const refusal = applyMoveRegion(base, working, s);
    assert.equal(refusal, null);
    const moved: RgbaImage = { width: base.width, height: base.height, data: working };
    assert.deepEqual(pixelAt(moved, 5, 40), { r: 255, g: 0, b: 0, a: 255 });
    assert.deepEqual(pixelAt(moved, 5, 59), { r: 255, g: 0, b: 0, a: 255 });
    // Original source rows untouched by THIS single move (fold-independent read from `base`).
    assert.deepEqual(pixelAt(base, 5, 0), { r: 255, g: 0, b: 0, a: 255 });
  });

  it("reads its source from the FIXED base canvas, never from a working buffer another move already mutated", () => {
    // Regression-style proof for the core design fix this module's own doc
    // describes: two moves whose source/destination ranges overlap must
    // both read pristine base-canvas pixels, never each other's writes.
    const base = baseCanvas();
    const working = Buffer.from(base.data);
    // Move band A (rows 0-19, red) down to where band B (blue) currently sits.
    const moveA = step("move_region", encodeMoveRegionParams({ sourceStartYPx: 0, heightPx: 20, destStartYPx: 80 }));
    // Move band B (rows 80-99, blue) up to where band A currently sits.
    const moveB = step("move_region", encodeMoveRegionParams({ sourceStartYPx: 80, heightPx: 20, destStartYPx: 0 }));
    assert.equal(applyMoveRegion(base, working, moveA), null);
    assert.equal(applyMoveRegion(base, working, moveB), null);
    const swapped: RgbaImage = { width: base.width, height: base.height, data: working };
    // If moveB had read from `working` (post-moveA) instead of `base`, row 0
    // would incorrectly still be red (moveA's own write), not blue.
    assert.deepEqual(pixelAt(swapped, 5, 0), { r: 0, g: 0, b: 255, a: 255 });
    assert.deepEqual(pixelAt(swapped, 5, 90), { r: 255, g: 0, b: 0, a: 255 });
  });

  it("fails closed on an out-of-bounds source or destination band", () => {
    const base = baseCanvas();
    const working = Buffer.from(base.data);
    const badSource = step("move_region", encodeMoveRegionParams({ sourceStartYPx: 90, heightPx: 30, destStartYPx: 0 }));
    assert.notEqual(applyMoveRegion(base, working, badSource), null);
    const badDest = step("move_region", encodeMoveRegionParams({ sourceStartYPx: 0, heightPx: 10, destStartYPx: 95 }));
    assert.notEqual(applyMoveRegion(base, working, badDest), null);
  });
});

describe("sign-composition-steps: fill_rect", () => {
  it("fills exactly the bounded rectangle with the measured colour, nothing outside it", () => {
    const canvas = makeImage(20, 20, { r: 9, g: 9, b: 9 });
    const working = Buffer.from(canvas.data);
    const s = step("fill_rect", encodeFillRectParams({ xPx: 5, yPx: 5, widthPx: 4, heightPx: 4, colorR: 250, colorG: 10, colorB: 10 }));
    const refusal = applyFillRect(working, 20, 20, s);
    assert.equal(refusal, null);
    const filled: RgbaImage = { width: 20, height: 20, data: working };
    assert.deepEqual(pixelAt(filled, 5, 5), { r: 250, g: 10, b: 10, a: 255 });
    assert.deepEqual(pixelAt(filled, 8, 8), { r: 250, g: 10, b: 10, a: 255 });
    // Just outside the rectangle: untouched.
    assert.deepEqual(pixelAt(filled, 9, 5), { r: 9, g: 9, b: 9, a: 255 });
    assert.deepEqual(pixelAt(filled, 0, 0), { r: 9, g: 9, b: 9, a: 255 });
  });

  it("never implicitly fills full width — refuses a rectangle exceeding the canvas rather than clipping it", () => {
    const working = Buffer.from(makeImage(20, 20, { r: 0, g: 0, b: 0 }).data);
    const s = step("fill_rect", encodeFillRectParams({ xPx: 15, yPx: 0, widthPx: 10, heightPx: 5, colorR: 1, colorG: 1, colorB: 1 }));
    const refusal = applyFillRect(working, 20, 20, s);
    assert.notEqual(refusal, null);
  });
});

describe("sign-composition-steps: executeCompositionSteps orchestration", () => {
  it("runs crop -> fit -> move -> fill end to end and produces the expected canvas", () => {
    // 60x40 source; crop out a 40x40 square; fit into a 100x100 canvas
    // (uniform scale 2.5, centered); move the top 20px band (post-fit) down
    // by 30px; fill a small rectangle.
    const source = makeImage(60, 40, { r: 0, g: 0, b: 0 });
    fillRect(source, 10, 0, 50, 40, { r: 100, g: 150, b: 200 }); // content inside the crop area
    const steps: SignRepairStep[] = [
      step("crop_region", encodeCropRegionParams({ expectedInputWidthPx: 60, expectedInputHeightPx: 40, xPx: 10, yPx: 0, widthPx: 40, heightPx: 40 })),
      step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 40, expectedArtworkHeightPx: 40, canvasWidthPx: 100, canvasHeightPx: 100,
        placementXPx: 0, placementYPx: 0, backgroundR: 255, backgroundG: 255, backgroundB: 255,
      })),
      step("move_region", encodeMoveRegionParams({ sourceStartYPx: 0, heightPx: 20, destStartYPx: 30 })),
      step("fill_rect", encodeFillRectParams({ xPx: 0, yPx: 0, widthPx: 100, heightPx: 5, colorR: 0, colorG: 0, colorB: 0 })),
    ];
    const bounds = { x: 0, y: 0, width: source.width, height: source.height };
    const result = executeCompositionSteps(source, bounds, steps);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.image.width, 100);
    assert.equal(result.image.height, 100);
    // fill_rect band at the very top.
    assert.deepEqual(pixelAt(result.image, 50, 2), { r: 0, g: 0, b: 0, a: 255 });
    // Moved band (originally rows 0-19 of the fitted canvas) now sits at rows 30-49.
    assert.deepEqual(pixelAt(result.image, 50, 40), { r: 100, g: 150, b: 200, a: 255 });
  });

  it("refuses a segment that mixes composition kinds with an unrecognized/legacy kind", () => {
    const source = makeImage(20, 20, { r: 0, g: 0, b: 0 });
    const steps: SignRepairStep[] = [
      step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 20, expectedArtworkHeightPx: 20, canvasWidthPx: 20, canvasHeightPx: 20,
        placementXPx: 0, placementYPx: 0, backgroundR: 0, backgroundG: 0, backgroundB: 0,
      })),
      step("extend_uniform_background", { axis: "vertical", leadingPx: 1, trailingPx: 1, colorR: 0, colorG: 0, colorB: 0 }),
    ];
    const bounds = { x: 0, y: 0, width: source.width, height: source.height };
    const result = executeCompositionSteps(source, bounds, steps);
    assert.equal(result.status, "refused");
  });

  it("refuses a segment with no fit_artwork_to_canvas step", () => {
    const source = makeImage(20, 20, { r: 0, g: 0, b: 0 });
    const steps: SignRepairStep[] = [
      step("move_region", encodeMoveRegionParams({ sourceStartYPx: 0, heightPx: 5, destStartYPx: 10 })),
    ];
    const bounds = { x: 0, y: 0, width: source.width, height: source.height };
    const result = executeCompositionSteps(source, bounds, steps);
    assert.equal(result.status, "refused");
  });
});
