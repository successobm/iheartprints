import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  createCanvas,
  DARK_OUTLINE,
  fillRect,
  getPixel,
  lightSpeckleResidueArtwork,
  NEAR_BLACK,
  setPixel,
  SPECKLE_ACCENT_POINT,
  SPECKLE_CLUSTER_POINTS,
  SPECKLE_INTERIOR_POINTS,
  SPECKLE_ISLAND_POINTS,
  speckleResidueArtwork,
  WHITE,
  type Rgba,
} from "./artwork-fixtures";
import {
  expandMaskWithBackgroundSpeckle,
  SPECKLE_BACKGROUND_DISTANCE_MULTIPLIER,
  SPECKLE_MAX_ISLAND_PX,
} from "./background-speckle";
import { computeExteriorMask, isolateBackground } from "./background-isolation";
import { analyzeArtwork } from "./image-analysis";

/**
 * Phase 1.2, Part B: isolated near-background residue.
 *
 * The population this pass exists for was MEASURED on the real customer
 * artwork, not imagined: 488 isolated islands totalling 520 pixels, every one
 * of them 1–4px, every one between Chebyshev 13 and 24 of a background whose
 * fill tolerance was 12. The fixtures below reproduce that mechanism exactly —
 * residue is placed at distance 13 so the flood fill genuinely goes around it,
 * rather than being painted in afterwards.
 *
 * Half these tests are negative controls, and they are the important half.
 */
describe("Background speckle — isolated near-background residue", () => {
  function prepare(image: RgbaImage) {
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 4096,
      declaresAlphaChannel: false,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    return {
      analysis,
      isolated: isolateBackground(image, {
        backgroundColor: analysis.estimatedBackgroundColor,
        tolerance: analysis.backgroundTolerance,
      }),
    };
  }

  it("removes an isolated one-pixel island next to removed background", () => {
    const image = speckleResidueArtwork();
    const { isolated } = prepare(image);

    for (const [x, y] of SPECKLE_ISLAND_POINTS) {
      // It was genuinely retained by the earlier passes — otherwise this test
      // would be asserting nothing.
      assert.equal(getPixel(image, x, y).a, 255);
      assert.equal(
        getPixel(isolated.image, x, y).a,
        0,
        `fleck at ${x},${y} should be gone`,
      );
    }
    assert.ok(isolated.record.speckleIslandsRemoved >= SPECKLE_ISLAND_POINTS.length);
  });

  it("removes an isolated multi-pixel island up to the documented size", () => {
    const image = speckleResidueArtwork();
    const { isolated } = prepare(image);

    assert.equal(SPECKLE_CLUSTER_POINTS.length <= SPECKLE_MAX_ISLAND_PX, true);
    for (const [x, y] of SPECKLE_CLUSTER_POINTS) {
      assert.equal(
        getPixel(isolated.image, x, y).a,
        0,
        `cluster pixel at ${x},${y} should be gone`,
      );
    }
  });

  it("refuses an island one pixel larger than the documented bound", () => {
    // Built directly against the pass so the bound itself is under test, not
    // the analyzer's opinion of a fixture.
    const image = createCanvas(40, 40, NEAR_BLACK);
    const mask = new Uint8Array(40 * 40).fill(1);
    const residue: Rgba = { r: 14, g: 14, b: 14, a: 255 };

    const oversized: Array<[number, number]> = [];
    for (let i = 0; i <= SPECKLE_MAX_ISLAND_PX; i += 1) {
      oversized.push([10 + i, 10]);
    }
    for (const [x, y] of oversized) {
      setPixel(image, x, y, residue);
      mask[y * 40 + x] = 0;
    }

    const result = expandMaskWithBackgroundSpeckle(image, mask, {
      backgroundColor: { r: 1, g: 1, b: 1 },
      tolerance: 12,
    });

    assert.equal(result.removedIslandCount, 0);
    assert.equal(result.removedPixelCount, 0);
    for (const [x, y] of oversized) {
      assert.equal(result.mask[y * 40 + x], 0, "an oversized island stays");
    }
  });

  it("preserves a tiny same-colour region deep inside the artwork", () => {
    const image = speckleResidueArtwork();
    const { isolated } = prepare(image);

    // Attached to the subject on every side, so it is not an island at all and
    // this pass cannot see it. This is the check that would catch the pass
    // eroding inward from a boundary.
    for (const [x, y] of SPECKLE_INTERIOR_POINTS) {
      const pixel = getPixel(isolated.image, x, y);
      assert.equal(pixel.a, 255, `interior pixel at ${x},${y} must survive`);
      assert.deepEqual(pixel, getPixel(image, x, y), "byte-identical");
    }
  });

  it("preserves an isolated dot that is not background-coloured", () => {
    const image = speckleResidueArtwork();
    const { isolated } = prepare(image);

    const [x, y] = SPECKLE_ACCENT_POINT;
    const pixel = getPixel(isolated.image, x, y);
    assert.equal(pixel.a, 255, "a deliberate accent is not residue");
    assert.equal(pixel.r, 220);
    assert.ok(
      isolated.speckle.preservedIslandCount >= 1,
      "and it is reported as considered-and-refused",
    );
  });

  it("preserves a dark outline that touches the removed background", () => {
    const image = speckleResidueArtwork();
    const { isolated } = prepare(image);

    // The outline is attached to the subject, so it is part of the artwork's
    // own component no matter how much removed background it borders.
    for (const [x, y] of [
      [31, 60],
      [60, 31],
      [88, 60],
      [60, 88],
    ] as const) {
      assert.equal(
        getPixel(image, x, y).r,
        DARK_OUTLINE.r,
        `fixture sanity at ${x},${y}`,
      );
      assert.equal(
        getPixel(isolated.image, x, y).a,
        255,
        `outline at ${x},${y} must survive`,
      );
    }
  });

  it("changes nothing beyond the islands it removes", () => {
    const image = speckleResidueArtwork();
    const exterior = computeExteriorMask(image, {
      backgroundColor: { r: 1, g: 1, b: 1 },
      tolerance: 12,
    });
    const result = expandMaskWithBackgroundSpeckle(image, exterior.mask, {
      backgroundColor: { r: 1, g: 1, b: 1 },
      tolerance: 12,
    });

    // The pass may only ever ADD to the mask, and only by exactly the pixels
    // it reported. It reads colours; it never writes one.
    let added = 0;
    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      if (exterior.mask[pixel] === 1) {
        assert.equal(result.mask[pixel], 1, "never un-removes a pixel");
        continue;
      }
      if (result.mask[pixel] === 1) added += 1;
    }
    assert.equal(added, result.removedPixelCount);
  });

  it("works identically on a light background", () => {
    const image = lightSpeckleResidueArtwork();
    const { analysis, isolated } = prepare(image);

    assert.equal(analysis.estimatedBackgroundColor.r, 250);
    for (const [x, y] of SPECKLE_ISLAND_POINTS) {
      assert.equal(
        getPixel(isolated.image, x, y).a,
        0,
        `light-background fleck at ${x},${y} should be gone`,
      );
    }
    // The dark subject is untouched.
    assert.equal(getPixel(isolated.image, 60, 60).a, 255);
  });

  it("preserves a bowling ball's finger holes", () => {
    // Finger holes are attached to the ball, so they belong to the artwork's
    // own retained component and are structurally invisible to this pass.
    // Asserted anyway, because it is the failure nobody could undo.
    const image = createCanvas(320, 320, NEAR_BLACK);
    fillRect(image, 60, 60, 200, 200, WHITE);
    fillRect(image, 140, 130, 24, 24, NEAR_BLACK);

    const mask = computeExteriorMask(image, {
      backgroundColor: { r: 0, g: 0, b: 0 },
      tolerance: 12,
    });
    const result = expandMaskWithBackgroundSpeckle(image, mask.mask, {
      backgroundColor: { r: 0, g: 0, b: 0 },
      tolerance: 12,
    });

    assert.equal(result.removedIslandCount, 0);
    assert.equal(result.mask[145 * 320 + 150], 0, "the hole is still there");
  });

  it("scales its colour allowance with the confirmed tolerance", () => {
    // The allowance is a MULTIPLE of the fill tolerance, not an absolute, so a
    // noisier export gets proportionally more room and a clean one gets almost
    // none. A fleck just past the multiple is refused.
    const image = createCanvas(40, 40, NEAR_BLACK);
    const mask = new Uint8Array(40 * 40).fill(1);
    const tolerance = 12;
    const limit = tolerance * SPECKLE_BACKGROUND_DISTANCE_MULTIPLIER;

    setPixel(image, 10, 10, { r: limit, g: 0, b: 0, a: 255 });
    mask[10 * 40 + 10] = 0;
    setPixel(image, 20, 20, { r: limit + 1, g: 0, b: 0, a: 255 });
    mask[20 * 40 + 20] = 0;

    const result = expandMaskWithBackgroundSpeckle(image, mask, {
      backgroundColor: { r: 0, g: 0, b: 0 },
      tolerance,
    });

    assert.equal(result.mask[10 * 40 + 10], 1, "at the limit: residue");
    assert.equal(result.mask[20 * 40 + 20], 0, "one past it: artwork");
    assert.equal(result.removedIslandCount, 1);
    assert.equal(result.preservedIslandCount, 1);
  });
});
