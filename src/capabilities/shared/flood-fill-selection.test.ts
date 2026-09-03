/**
 * Wand-First Correction UX Phase: focused tests for the RELOCATED shared
 * flood-fill algorithm. The exhaustive adversarial case suite (gradients,
 * disconnected same-color regions, diagonal bridges, rings, etc.) already
 * lives in `src/experimental/magic-wand/magic-wand.test.ts` and continues
 * to pass unmodified — this file is deliberately NOT a duplicate of that
 * suite. It proves two things: (1) the relocated module itself is correct
 * on its own terms, standalone from DTF, and (2) `maskExactlyFillsBounds`,
 * the one genuinely NEW export this phase added, is correct.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CONNECTIVITY,
  FLOOD_FILL_ALGORITHM_VERSION,
  TOLERANCE_LEVELS,
  floodFillSelect,
  maskExactlyFillsBounds,
  type RgbaImage,
} from "./flood-fill-selection";

function makeImage(width: number, height: number, color: { r: number; g: number; b: number; a?: number }): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = color.r; data[o + 1] = color.g; data[o + 2] = color.b; data[o + 3] = color.a ?? 255;
  }
  return { width, height, data };
}

function fillRect(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, color: { r: number; g: number; b: number; a?: number }) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      image.data[o] = color.r; image.data[o + 1] = color.g; image.data[o + 2] = color.b; image.data[o + 3] = color.a ?? 255;
    }
  }
}

describe("flood-fill-selection: floodFillSelect (relocated)", () => {
  it("selects a uniform-color region contiguous from the seed", () => {
    const image = makeImage(20, 20, { r: 200, g: 10, b: 10 });
    fillRect(image, 5, 5, 15, 15, { r: 20, g: 20, b: 20 });
    const result = floodFillSelect(image, { x: 10, y: 10 }, "default");
    assert.equal(result.pixelCount, 100);
    assert.deepEqual(result.bounds, { left: 5, top: 5, width: 10, height: 10 });
    assert.equal(result.touchesEdge, false);
  });

  it("never selects a disconnected same-color region — two separate black squares stay separate", () => {
    const image = makeImage(30, 10, { r: 255, g: 255, b: 255 });
    fillRect(image, 0, 0, 5, 5, { r: 0, g: 0, b: 0 });
    fillRect(image, 20, 0, 25, 5, { r: 0, g: 0, b: 0 });
    const result = floodFillSelect(image, { x: 2, y: 2 }, "default");
    assert.equal(result.pixelCount, 25);
    assert.equal(result.mask[2 * image.width + 22], 0); // the OTHER square never selected
  });

  it("is deterministic — identical seed/tolerance always produces a byte-identical mask", () => {
    const image = makeImage(50, 50, { r: 10, g: 200, b: 30 });
    fillRect(image, 10, 10, 40, 40, { r: 250, g: 250, b: 250 });
    const a = floodFillSelect(image, { x: 25, y: 25 }, "less");
    const b = floodFillSelect(image, { x: 25, y: 25 }, "less");
    assert.deepEqual(Buffer.from(a.mask), Buffer.from(b.mask));
  });

  it("throws for a seed outside image bounds", () => {
    const image = makeImage(10, 10, { r: 0, g: 0, b: 0 });
    assert.throws(() => floodFillSelect(image, { x: 10, y: 0 }, "default"));
  });

  it("tolerance ladder is exactly {less:16, default:32, more:56}", () => {
    assert.deepEqual(TOLERANCE_LEVELS, { less: 16, default: 32, more: 56 });
  });

  it("default connectivity is 4", () => {
    assert.equal(DEFAULT_CONNECTIVITY, 4);
  });

  it("algorithm version string is stable", () => {
    assert.equal(FLOOD_FILL_ALGORITHM_VERSION, "magic-wand:v1");
  });
});

describe("flood-fill-selection: maskExactlyFillsBounds", () => {
  it("is true for a selection whose mask is genuinely a filled rectangle", () => {
    const image = makeImage(20, 20, { r: 255, g: 255, b: 255 });
    fillRect(image, 5, 5, 15, 15, { r: 0, g: 0, b: 0 });
    const result = floodFillSelect(image, { x: 10, y: 10 }, "default");
    assert.equal(maskExactlyFillsBounds(result.mask, image.width, result.bounds), true);
  });

  it("is false for a ring/donut selection — the interior hole is within bounds but not selected", () => {
    const image = makeImage(20, 20, { r: 255, g: 255, b: 255 });
    fillRect(image, 5, 5, 15, 15, { r: 0, g: 0, b: 0 });
    fillRect(image, 8, 8, 12, 12, { r: 255, g: 255, b: 255 }); // hole carved out of the middle
    const result = floodFillSelect(image, { x: 6, y: 6 }, "default"); // click the ring itself, not the hole
    assert.equal(maskExactlyFillsBounds(result.mask, image.width, result.bounds), false);
  });

  it("is false for an L-shaped (non-rectangular) selection", () => {
    const image = makeImage(20, 20, { r: 255, g: 255, b: 255 });
    fillRect(image, 0, 0, 10, 5, { r: 0, g: 0, b: 0 });
    fillRect(image, 0, 5, 5, 10, { r: 0, g: 0, b: 0 });
    const result = floodFillSelect(image, { x: 1, y: 1 }, "default");
    assert.equal(maskExactlyFillsBounds(result.mask, image.width, result.bounds), false);
  });
});
