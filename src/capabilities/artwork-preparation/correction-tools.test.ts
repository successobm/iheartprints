import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "./magic-wand-algorithm";
import { computeTransparentComponent, isEnclosedComponent, rasterizeStroke, BRUSH_RADIUS_LEVELS } from "./correction-tools";

/**
 * Phase 27I — focused, isolated tests for the two NEW pure algorithms this
 * phase adds: Restore Fill's transparent-component finder and the
 * Brush/Eraser stroke rasterizer. Deliberately does not touch anything in
 * `magic-wand-algorithm.ts` (frozen) or re-test its flood-fill/tolerance
 * behaviour — that surface is exhaustively covered elsewhere.
 */

function solidImage(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

function setAlpha(image: RgbaImage, x: number, y: number, alpha: number) {
  image.data[(y * image.width + x) * 4 + 3] = alpha;
}
function getPixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}
function countMask(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) if (v) n += 1;
  return n;
}

describe("Phase 27I: computeTransparentComponent (Restore Fill's core algorithm)", () => {
  it("D: finds an enclosed pocket of alpha===0 pixels fully surrounded by opaque pixels", () => {
    const img = solidImage(20, 20, [10, 10, 10, 255]);
    // A 3x3 hole in the middle, nowhere near the border.
    for (let y = 8; y <= 10; y += 1) {
      for (let x = 8; x <= 10; x += 1) setAlpha(img, x, y, 0);
    }
    const result = computeTransparentComponent(img, { x: 9, y: 9 });
    assert.equal(result.pixelCount, 9);
    assert.equal(result.touchesEdge, false);
    assert.ok(isEnclosedComponent(result), "a hole nowhere near the border must be enclosed");
    assert.equal(countMask(result.mask), 9);
  });

  it("E: refuses (touchesEdge=true) when the transparent component reaches the image boundary", () => {
    const img = solidImage(20, 20, [10, 10, 10, 255]);
    // A missing strip touching the left edge (x=0..2).
    for (let y = 5; y <= 7; y += 1) {
      for (let x = 0; x <= 2; x += 1) setAlpha(img, x, y, 0);
    }
    const result = computeTransparentComponent(img, { x: 1, y: 6 });
    assert.equal(result.touchesEdge, true);
    assert.equal(isEnclosedComponent(result), false, "a border-connected component must never be reported as enclosed");
  });

  it("does not cross an opaque wall into an unrelated, separately-enclosed hole", () => {
    const img = solidImage(20, 20, [10, 10, 10, 255]);
    setAlpha(img, 3, 3, 0); // isolated single missing pixel
    setAlpha(img, 15, 15, 0); // a second, unrelated isolated missing pixel
    const result = computeTransparentComponent(img, { x: 3, y: 3 });
    assert.equal(result.pixelCount, 1);
    assert.equal(result.mask[15 * 20 + 15], 0, "the unrelated hole elsewhere must not be included");
  });

  it("clicking a non-missing (opaque) pixel finds nothing", () => {
    const img = solidImage(10, 10, [200, 200, 200, 255]);
    const result = computeTransparentComponent(img, { x: 5, y: 5 });
    assert.equal(result.pixelCount, 0);
    assert.equal(result.bounds, null);
  });

  it("throws for an out-of-bounds seed, exactly like the frozen flood fill does", () => {
    const img = solidImage(5, 5, [0, 0, 0, 255]);
    assert.throws(() => computeTransparentComponent(img, { x: 99, y: 99 }));
  });
});

describe("Phase 27I: rasterizeStroke (Brush/Eraser's shared deterministic geometry)", () => {
  it("H sanity: a single point stamps a filled circle of the given radius", () => {
    const raster = rasterizeStroke([{ x: 10, y: 10 }], 4, 20, 20);
    assert.ok(raster.pixelCount > 0);
    assert.equal(raster.mask[10 * 20 + 10], 1, "the center must always be covered");
    assert.equal(raster.mask[10 * 20 + 15], 0, "far outside the radius must not be covered");
  });

  it("I: interpolates between far-apart sampled points with no gaps along the path", () => {
    // Two points far apart relative to the radius -- if the rasterizer only
    // stamped at the two endpoints, the midpoint would be uncovered.
    const raster = rasterizeStroke([{ x: 0, y: 10 }, { x: 40, y: 10 }], 3, 50, 20);
    for (let x = 0; x <= 40; x += 2) {
      assert.equal(raster.mask[10 * 50 + x], 1, `pixel (${x},10) along the stroke path must be covered -- no gap`);
    }
  });

  it("clips to image bounds -- never marks a pixel outside [0,width)x[0,height)", () => {
    const raster = rasterizeStroke([{ x: 0, y: 0 }, { x: 19, y: 19 }], 8, 20, 20);
    assert.equal(raster.mask.length, 400);
    // Bounds, if present, must lie fully within the image.
    if (raster.bounds) {
      assert.ok(raster.bounds.left >= 0 && raster.bounds.top >= 0);
      assert.ok(raster.bounds.left + raster.bounds.width <= 20);
      assert.ok(raster.bounds.top + raster.bounds.height <= 20);
    }
  });

  it("S: an empty points array or non-positive radius produces an empty, safe result rather than throwing", () => {
    assert.equal(rasterizeStroke([], 5, 10, 10).pixelCount, 0);
    assert.equal(rasterizeStroke([{ x: 1, y: 1 }], 0, 10, 10).pixelCount, 0);
    assert.equal(rasterizeStroke([{ x: 1, y: 1 }], -5, 10, 10).pixelCount, 0);
  });

  it("is a pure, deterministic function -- identical inputs always produce a byte-identical mask", () => {
    const points = [{ x: 3, y: 3 }, { x: 8, y: 5 }, { x: 2, y: 9 }];
    const a = rasterizeStroke(points, BRUSH_RADIUS_LEVELS.medium, 30, 30);
    const b = rasterizeStroke(points, BRUSH_RADIUS_LEVELS.medium, 30, 30);
    assert.equal(Buffer.compare(Buffer.from(a.mask), Buffer.from(b.mask)), 0);
    assert.equal(a.pixelCount, b.pixelCount);
  });

  it("BRUSH_RADIUS_LEVELS exposes three distinct, increasing sizes (Small/Medium/Large)", () => {
    assert.ok(BRUSH_RADIUS_LEVELS.small < BRUSH_RADIUS_LEVELS.medium);
    assert.ok(BRUSH_RADIUS_LEVELS.medium < BRUSH_RADIUS_LEVELS.large);
  });
});

// Re-exported here only to keep the getPixel/solidImage helpers demonstrably
// exercised beyond raw mask inspection (RGB/alpha sanity for the fixtures
// themselves, not the algorithm under test).
describe("test fixture sanity", () => {
  it("solidImage/getPixel/setAlpha behave as expected", () => {
    const img = solidImage(2, 2, [1, 2, 3, 255]);
    assert.deepEqual(getPixel(img, 0, 0), [1, 2, 3, 255]);
    setAlpha(img, 0, 0, 0);
    assert.deepEqual(getPixel(img, 0, 0), [1, 2, 3, 0]);
  });
});
