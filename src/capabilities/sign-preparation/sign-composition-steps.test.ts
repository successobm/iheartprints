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
  MAX_MASKED_REGION_PIXELS,
  applyCorrectionsToCanvas,
  applyFillRect,
  applyMoveRegion,
  applyReplaceMaskedRegionWithBackground,
  applyReplaceRegionWithBackground,
  decodeReplaceMaskedRegionWithBackgroundParams,
  deriveUniformFitDimensions,
  encodeCropRegionParams,
  encodeFillRectParams,
  encodeFitArtworkToCanvasParams,
  encodeMoveRegionParams,
  encodeReplaceMaskedRegionWithBackgroundParams,
  encodeReplaceRegionWithBackgroundParams,
  executeCompositionSteps,
  executeCropRegion,
  executeFitArtworkToCanvas,
  measureUniformSurroundingBackground,
  verifyReplaceRegionSurroundingContext,
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

describe("sign-composition-steps: replace_region_with_background (Fit to Production)", () => {
  function canvasWithArtifact(): RgbaImage {
    // 100x100 uniform red canvas with a small black "hole" artifact near
    // the top-left corner (10..30, 10..30) — mirrors the real Signs
    // acceptance sign's own corner hole/ring graphic against a uniform
    // banner background.
    const image = makeImage(100, 100, { r: 200, g: 10, b: 10 });
    fillRect(image, 10, 10, 30, 30, { r: 20, g: 20, b: 20 });
    return image;
  }

  it("removes a bounded artifact when the surrounding context genuinely is the claimed colour", () => {
    const canvas = canvasWithArtifact();
    const working = Buffer.from(canvas.data);
    const s = step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
      xPx: 5, yPx: 5, widthPx: 30, heightPx: 30, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
    }));
    const refusal = applyReplaceRegionWithBackground(working, 100, 100, s);
    assert.equal(refusal, null);
    const result: RgbaImage = { width: 100, height: 100, data: working };
    assert.deepEqual(pixelAt(result, 20, 20), { r: 200, g: 10, b: 10, a: 255 }); // was black, now red
    assert.deepEqual(pixelAt(result, 50, 50), { r: 200, g: 10, b: 10, a: 255 }); // untouched elsewhere
  });

  it("refuses when the surrounding context is NOT uniformly the claimed colour (crosses non-uniform artwork)", () => {
    const canvas = canvasWithArtifact();
    const working = Buffer.from(canvas.data);
    // Rect too small to contain the artifact -> its own surrounding ring
    // still touches the black artifact -> must refuse, never partially
    // erase or silently shrink to fit.
    const s = step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
      xPx: 15, yPx: 15, widthPx: 10, heightPx: 10, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
    }));
    const refusal = applyReplaceRegionWithBackground(working, 100, 100, s);
    assert.notEqual(refusal, null);
    // Never partially applied — canvas is byte-identical to before.
    assert.deepEqual(working, canvas.data);
  });

  it("refuses a rectangle exceeding the canvas bounds", () => {
    const canvas = makeImage(50, 50, { r: 0, g: 0, b: 0 });
    const working = Buffer.from(canvas.data);
    const s = step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
      xPx: 45, yPx: 45, widthPx: 10, heightPx: 10, colorR: 0, colorG: 0, colorB: 0, contextDepthPx: 2,
    }));
    const refusal = applyReplaceRegionWithBackground(working, 50, 50, s);
    assert.notEqual(refusal, null);
  });

  it("refuses on a source-identity mismatch — malformed/missing params never silently default", () => {
    const working = Buffer.from(makeImage(50, 50, { r: 0, g: 0, b: 0 }).data);
    const s = step("replace_region_with_background", { xPx: 0, yPx: 0, widthPx: 10 }); // missing required params
    const refusal = applyReplaceRegionWithBackground(working, 50, 50, s);
    assert.notEqual(refusal, null);
  });

  it("verifyReplaceRegionSurroundingContext reports the exact mismatch count, never just true/false", () => {
    const canvas = canvasWithArtifact();
    const working = Buffer.from(canvas.data);
    const result = verifyReplaceRegionSurroundingContext(working, 100, 100, {
      xPx: 15, yPx: 15, widthPx: 10, heightPx: 10, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
    });
    assert.equal(result.uniform, false);
    assert.ok(result.mismatchedPx > 0);
    assert.ok(result.sampledPx >= result.mismatchedPx);
  });

  it("executeCompositionSteps runs replace_region_with_background as the final move/fill-stage operation", () => {
    const source = canvasWithArtifact();
    const steps: SignRepairStep[] = [
      step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 100, expectedArtworkHeightPx: 100, canvasWidthPx: 100, canvasHeightPx: 100,
        placementXPx: 0, placementYPx: 0, backgroundR: 200, backgroundG: 10, backgroundB: 10,
      })),
      step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
        xPx: 5, yPx: 5, widthPx: 30, heightPx: 30, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      })),
    ];
    const bounds = { x: 0, y: 0, width: source.width, height: source.height };
    const result = executeCompositionSteps(source, bounds, steps);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(pixelAt(result.image, 20, 20), { r: 200, g: 10, b: 10, a: 255 });
  });
});

describe("sign-composition-steps: replace_masked_region_with_background (Wand-First Correction UX)", () => {
  function canvasWithRingArtifact(): RgbaImage {
    // 100x100 uniform red canvas with a RING artifact (10..30, 10..30
    // bounding box) — a donut, not a filled square, so its bounding
    // rectangle genuinely contains unselected interior pixels (the hole in
    // the middle of the ring, which stays red/background already) — this
    // is exactly the shape a rectangle-only tool cannot safely represent
    // without risk (if the interior weren't already background colour, a
    // naive rect-fill would have silently touched it).
    const image = makeImage(100, 100, { r: 200, g: 10, b: 10 });
    fillRect(image, 10, 10, 30, 30, { r: 20, g: 20, b: 20 }); // 20x20 solid black square (10..30)
    fillRect(image, 15, 15, 25, 25, { r: 200, g: 10, b: 10 }); // 10x10 red "hole" carved out of the middle -> a ring
    return image;
  }

  /** A boolean mask (1 byte/px) for exactly the black ring pixels within [10,10,20,20]. */
  function ringMaskBase64(): string {
    const mask = Buffer.alloc(20 * 20);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const isHole = x >= 5 && x < 15 && y >= 5 && y < 15; // the 10x10 carved-out middle, in rect-local coords
        mask[y * 20 + x] = isHole ? 0 : 1;
      }
    }
    return mask.toString("base64");
  }

  it("removes only the masked (ring) pixels — the already-background interior hole is left untouched, never silently rewritten", () => {
    const canvas = canvasWithRingArtifact();
    const working = Buffer.from(canvas.data);
    const s = step("replace_masked_region_with_background", encodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 10, yPx: 10, widthPx: 20, heightPx: 20, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      maskBase64: ringMaskBase64(),
    }));
    const refusal = applyReplaceMaskedRegionWithBackground(working, 100, 100, s);
    assert.equal(refusal, null);
    const result: RgbaImage = { width: 100, height: 100, data: working };
    // Ring pixels (e.g. corner of the black band) -> now red.
    assert.deepEqual(pixelAt(result, 12, 12), { r: 200, g: 10, b: 10, a: 255 });
    // Interior hole pixel -> was ALREADY red, still red (never "touched" by this op either way, but critically not corrupted).
    assert.deepEqual(pixelAt(result, 20, 20), { r: 200, g: 10, b: 10, a: 255 });
    // Elsewhere on the canvas -> untouched.
    assert.deepEqual(pixelAt(result, 60, 60), { r: 200, g: 10, b: 10, a: 255 });
  });

  it("a mask that leaves a non-mask pixel inside its own rectangle DIFFERENT from surrounding red proves the write is mask-restricted, not rect-wide", () => {
    const canvas = canvasWithRingArtifact();
    // Overwrite the ring's own middle "hole" (already red) with a THIRD,
    // distinctive colour the operator never selected — simulating some
    // other real content sitting inside the same bounding box that must
    // NEVER be touched by this masked op.
    fillRect(canvas, 15, 15, 25, 25, { r: 30, g: 200, b: 30 }); // green "unrelated content"
    const working = Buffer.from(canvas.data);
    const s = step("replace_masked_region_with_background", encodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 10, yPx: 10, widthPx: 20, heightPx: 20, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      maskBase64: ringMaskBase64(),
    }));
    const refusal = applyReplaceMaskedRegionWithBackground(working, 100, 100, s);
    assert.equal(refusal, null);
    const result: RgbaImage = { width: 100, height: 100, data: working };
    // The unrelated green content the operator never selected is COMPLETELY UNTOUCHED.
    assert.deepEqual(pixelAt(result, 20, 20), { r: 30, g: 200, b: 30, a: 255 });
    // But the actually-selected ring is still correctly removed.
    assert.deepEqual(pixelAt(result, 12, 12), { r: 200, g: 10, b: 10, a: 255 });
  });

  it("refuses when the surrounding context is NOT uniform — identical gate to the rectangle sibling", () => {
    const canvas = canvasWithRingArtifact();
    const working = Buffer.from(canvas.data);
    // Deliberately claim the WRONG colour so the context ring fails to verify.
    const s = step("replace_masked_region_with_background", encodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 10, yPx: 10, widthPx: 20, heightPx: 20, colorR: 0, colorG: 0, colorB: 0, contextDepthPx: 4,
      maskBase64: ringMaskBase64(),
    }));
    const refusal = applyReplaceMaskedRegionWithBackground(working, 100, 100, s);
    assert.notEqual(refusal, null);
    assert.deepEqual(working, canvas.data); // never partially applied
  });

  it("decode fails closed when the mask length does not match its own declared rectangle", () => {
    const badMask = Buffer.alloc(5).toString("base64"); // 5 bytes, not 20*20=400
    const decoded = decodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 10, yPx: 10, widthPx: 20, heightPx: 20, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      maskBase64: badMask,
    });
    assert.equal(decoded, null);
  });

  it("decode fails closed when the bounding rectangle exceeds MAX_MASKED_REGION_PIXELS", () => {
    const side = Math.ceil(Math.sqrt(MAX_MASKED_REGION_PIXELS)) + 10;
    const oversized = Buffer.alloc(side * side).toString("base64");
    const decoded = decodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 0, yPx: 0, widthPx: side, heightPx: side, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      maskBase64: oversized,
    });
    assert.equal(decoded, null);
  });

  it("refuses a rectangle exceeding the canvas bounds", () => {
    const canvas = makeImage(50, 50, { r: 0, g: 0, b: 0 });
    const working = Buffer.from(canvas.data);
    const s = step("replace_masked_region_with_background", encodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 45, yPx: 45, widthPx: 10, heightPx: 10, colorR: 0, colorG: 0, colorB: 0, contextDepthPx: 2,
      maskBase64: Buffer.alloc(100, 1).toString("base64"),
    }));
    const refusal = applyReplaceMaskedRegionWithBackground(working, 50, 50, s);
    assert.notEqual(refusal, null);
  });

  it("applyCorrectionsToCanvas (the operator preview/commit path) admits replace_masked_region_with_background", () => {
    const canvas = canvasWithRingArtifact();
    const s = step("replace_masked_region_with_background", encodeReplaceMaskedRegionWithBackgroundParams({
      xPx: 10, yPx: 10, widthPx: 20, heightPx: 20, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      maskBase64: ringMaskBase64(),
    }));
    const result = applyCorrectionsToCanvas(canvas, [s]);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(pixelAt(result.image, 12, 12), { r: 200, g: 10, b: 10, a: 255 });
  });

  it("executeCompositionSteps (the real plan-execution path) admits replace_masked_region_with_background as the final move/fill-stage operation", () => {
    const source = canvasWithRingArtifact();
    const steps: SignRepairStep[] = [
      step("fit_artwork_to_canvas", encodeFitArtworkToCanvasParams({
        expectedArtworkWidthPx: 100, expectedArtworkHeightPx: 100, canvasWidthPx: 100, canvasHeightPx: 100,
        placementXPx: 0, placementYPx: 0, backgroundR: 200, backgroundG: 10, backgroundB: 10,
      })),
      step("replace_masked_region_with_background", encodeReplaceMaskedRegionWithBackgroundParams({
        xPx: 10, yPx: 10, widthPx: 20, heightPx: 20, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
        maskBase64: ringMaskBase64(),
      })),
    ];
    const bounds = { x: 0, y: 0, width: source.width, height: source.height };
    const result = executeCompositionSteps(source, bounds, steps);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(pixelAt(result.image, 12, 12), { r: 200, g: 10, b: 10, a: 255 });
  });
});

describe("sign-composition-steps: measureUniformSurroundingBackground (Operator Production Correction UX, Section H)", () => {
  function canvasWithArtifact(bg: { r: number; g: number; b: number }): RgbaImage {
    const image = makeImage(100, 100, bg);
    fillRect(image, 10, 10, 30, 30, { r: 20, g: 20, b: 20 }); // artifact
    return image;
  }

  it("measures a uniform red background and proposes it", () => {
    const image = canvasWithArtifact({ r: 200, g: 10, b: 10 });
    const result = measureUniformSurroundingBackground(image, { xPx: 5, yPx: 5, widthPx: 30, heightPx: 30 }, 4);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.deepEqual(result.color, { r: 200, g: 10, b: 10 });
  });

  it("measures a uniform white background and proposes it", () => {
    const image = canvasWithArtifact({ r: 253, g: 253, b: 253 });
    const result = measureUniformSurroundingBackground(image, { xPx: 5, yPx: 5, widthPx: 30, heightPx: 30 }, 4);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.deepEqual(result.color, { r: 253, g: 253, b: 253 });
  });

  it("refuses when the selection is too tight and its own ring still straddles the artifact boundary (nonuniform context)", () => {
    const image = canvasWithArtifact({ r: 200, g: 10, b: 10 });
    // A tiny rect well inside the 20x20 artifact (10..29,10..29), with a
    // context depth deep enough that the ring extends PAST the artifact's
    // own edge into the genuine red background — mixing the artifact's own
    // black with the true background, which is never uniform.
    const result = measureUniformSurroundingBackground(image, { xPx: 12, yPx: 12, widthPx: 10, heightPx: 10 }, 10);
    assert.equal(result.status, "refused");
  });

  it("refuses across a genuinely multi-colour structural boundary (never averages across it)", () => {
    // Left half red, right half white — no single uniform colour exists in
    // a ring straddling the boundary.
    const image = makeImage(100, 100, { r: 200, g: 10, b: 10 });
    fillRect(image, 50, 0, 100, 100, { r: 253, g: 253, b: 253 });
    const result = measureUniformSurroundingBackground(image, { xPx: 40, yPx: 40, widthPx: 20, heightPx: 20 }, 10);
    assert.equal(result.status, "refused");
  });

  it("never proposes a colour that would overwrite neighbouring protected artwork — exact rect bounds only", () => {
    const image = canvasWithArtifact({ r: 200, g: 10, b: 10 });
    // A second, separate artifact well away from the selection — must not
    // affect measurement or be touched by it.
    fillRect(image, 70, 70, 90, 90, { r: 30, g: 140, b: 30 });
    const result = measureUniformSurroundingBackground(image, { xPx: 5, yPx: 5, widthPx: 30, heightPx: 30 }, 4);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.deepEqual(result.color, { r: 200, g: 10, b: 10 });
    assert.deepEqual(pixelAt(image, 80, 80), { r: 30, g: 140, b: 30, a: 255 }); // untouched — measurement never writes.
  });

  it("refuses an out-of-bounds selection", () => {
    const image = makeImage(50, 50, { r: 0, g: 0, b: 0 });
    const result = measureUniformSurroundingBackground(image, { xPx: 45, yPx: 45, widthPx: 20, heightPx: 20 }, 4);
    assert.equal(result.status, "refused");
  });
});

describe("sign-composition-steps: applyCorrectionsToCanvas (Operator Production Correction UX, Section L)", () => {
  it("applies a single replace_region_with_background on top of an already-composed candidate", () => {
    const candidate = makeImage(100, 100, { r: 200, g: 10, b: 10 });
    fillRect(candidate, 10, 10, 30, 30, { r: 20, g: 20, b: 20 });
    const s = step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
      xPx: 5, yPx: 5, widthPx: 30, heightPx: 30, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
    }));
    const result = applyCorrectionsToCanvas(candidate, [s]);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(pixelAt(result.image, 20, 20), { r: 200, g: 10, b: 10, a: 255 });
    // The ORIGINAL candidate buffer is never mutated in place.
    assert.deepEqual(pixelAt(candidate, 20, 20), { r: 20, g: 20, b: 20, a: 255 });
  });

  it("applies a move_region on top of an already-composed candidate, reading its source band from the candidate itself", () => {
    const candidate = makeImage(20, 40, { r: 0, g: 0, b: 0 });
    fillRect(candidate, 0, 0, 20, 10, { r: 250, g: 0, b: 0 }); // band A: rows 0-9
    const s = step("move_region", encodeMoveRegionParams({ sourceStartYPx: 0, heightPx: 10, destStartYPx: 20 }));
    const result = applyCorrectionsToCanvas(candidate, [s]);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(pixelAt(result.image, 5, 25), { r: 250, g: 0, b: 0, a: 255 }); // moved to new destination.
    assert.deepEqual(pixelAt(result.image, 5, 5), { r: 250, g: 0, b: 0, a: 255 }); // source band untouched (byte copy, not a cut).
  });

  it("chains multiple new corrections in order — a second replace sees the first's own already-applied result", () => {
    const candidate = makeImage(100, 100, { r: 200, g: 10, b: 10 });
    fillRect(candidate, 10, 10, 20, 20, { r: 20, g: 20, b: 20 }); // artifact 1
    fillRect(candidate, 60, 60, 70, 70, { r: 20, g: 20, b: 20 }); // artifact 2
    const steps: SignRepairStep[] = [
      step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
        xPx: 8, yPx: 8, widthPx: 14, heightPx: 14, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      })),
      step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
        xPx: 58, yPx: 58, widthPx: 14, heightPx: 14, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      })),
    ];
    const result = applyCorrectionsToCanvas(candidate, steps);
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.deepEqual(pixelAt(result.image, 15, 15), { r: 200, g: 10, b: 10, a: 255 });
    assert.deepEqual(pixelAt(result.image, 65, 65), { r: 200, g: 10, b: 10, a: 255 });
  });

  it("refuses (never partially applies) when a later correction in the batch is unsafe", () => {
    const candidate = makeImage(100, 100, { r: 200, g: 10, b: 10 });
    fillRect(candidate, 10, 10, 30, 30, { r: 20, g: 20, b: 20 });
    const steps: SignRepairStep[] = [
      step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
        xPx: 5, yPx: 5, widthPx: 30, heightPx: 30, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      })),
      // Bogus rectangle exceeding canvas bounds.
      step("replace_region_with_background", encodeReplaceRegionWithBackgroundParams({
        xPx: 95, yPx: 95, widthPx: 20, heightPx: 20, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 4,
      })),
    ];
    const result = applyCorrectionsToCanvas(candidate, steps);
    assert.equal(result.status, "refused");
  });

  it("refuses a legacy (non-composition) step kind — only move/fill/replace are admitted on top of an existing candidate", () => {
    const candidate = makeImage(50, 50, { r: 0, g: 0, b: 0 });
    const s = step("extend_uniform_background", { axis: "vertical", leadingPx: 1, trailingPx: 1, colorR: 0, colorG: 0, colorB: 0 });
    const result = applyCorrectionsToCanvas(candidate, [s]);
    assert.equal(result.status, "refused");
  });
});
