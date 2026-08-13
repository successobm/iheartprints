import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasAnyTransparentPixel, resampleExact, type RgbaImage } from "./raster-transform";

/** A fully opaque solid-color square — no randomness, deterministic. */
function solidOpaqueSquare(size: number, r: number, g: number, b: number): RgbaImage {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}

describe("resampleExact (Print-Ready Normalization Phase 1)", () => {
  it("downscaling (target smaller than source) never fabricates detail — contentScale <= 1", () => {
    const source = solidOpaqueSquare(1024, 10, 20, 30);
    const result = resampleExact(source, 512, 512);
    assert.ok(result.contentScale <= 1, `expected contentScale <= 1, got ${result.contentScale}`);
  });

  it("upscaling (target larger than source) is honestly reported — contentScale > 1", () => {
    const source = solidOpaqueSquare(1024, 10, 20, 30);
    const result = resampleExact(source, 3150, 3150);
    assert.ok(result.contentScale > 1, `expected contentScale > 1, got ${result.contentScale}`);
  });

  it("output is exactly the requested dimensions", () => {
    const source = solidOpaqueSquare(200, 0, 0, 0);
    const result = resampleExact(source, 900, 1200);
    assert.equal(result.image.width, 900);
    assert.equal(result.image.height, 1200);
  });

  it("introduces no transparent padding — the artwork IS the canvas", () => {
    const source = solidOpaqueSquare(200, 255, 0, 0);
    const result = resampleExact(source, 400, 400);
    assert.equal(hasAnyTransparentPixel(result.image), false);
  });

  it("rejects non-positive dimensions rather than producing an empty plate", () => {
    const source = solidOpaqueSquare(100, 1, 2, 3);
    assert.throws(() => resampleExact(source, 0, 100), /must be positive/i);
    assert.throws(
      () => resampleExact({ width: 0, height: 0, data: Buffer.alloc(0) }, 10, 10),
      /must be positive/i,
    );
  });

  it("is deterministic — identical inputs always produce byte-identical output", () => {
    const source = solidOpaqueSquare(300, 12, 34, 56);
    const first = resampleExact(source, 900, 900);
    const second = resampleExact(source, 900, 900);
    assert.deepEqual(first.image.data, second.image.data);
    assert.equal(first.contentScale, second.contentScale);
  });

  it("preserves source color content (center of a solid-color square stays that color)", () => {
    const source = solidOpaqueSquare(200, 200, 100, 50);
    const result = resampleExact(source, 400, 400);
    const { width, height, data } = result.image;
    const centerIdx = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    assert.equal(data[centerIdx], 200);
    assert.equal(data[centerIdx + 1], 100);
    assert.equal(data[centerIdx + 2], 50);
    assert.equal(data[centerIdx + 3], 255);
  });
});

describe("hasAnyTransparentPixel", () => {
  it("returns false for a fully opaque image", () => {
    const image = solidOpaqueSquare(10, 1, 2, 3);
    assert.equal(hasAnyTransparentPixel(image), false);
  });

  it("returns true when even a single pixel has alpha < 255", () => {
    const image = solidOpaqueSquare(10, 1, 2, 3);
    image.data[3] = 0; // make the first pixel transparent
    assert.equal(hasAnyTransparentPixel(image), true);
  });
});
