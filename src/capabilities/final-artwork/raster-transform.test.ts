import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasAnyTransparentPixel,
  resampleContainWithTransparentPadding,
  type RgbaImage,
} from "./raster-transform";

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

describe("resampleContainWithTransparentPadding (Sprint 2M Phase 2C)", () => {
  it("downscaling (target smaller than source) never fabricates detail — contentScale <= 1", () => {
    const source = solidOpaqueSquare(1024, 10, 20, 30);
    const result = resampleContainWithTransparentPadding(source, 512, 512, 0);
    assert.ok(result.contentScale <= 1, `expected contentScale <= 1, got ${result.contentScale}`);
  });

  it("upscaling (target larger than source) is honestly reported — contentScale > 1", () => {
    const source = solidOpaqueSquare(1024, 10, 20, 30);
    const result = resampleContainWithTransparentPadding(source, 3600, 3600, 0.05);
    assert.ok(result.contentScale > 1, `expected contentScale > 1, got ${result.contentScale}`);
  });

  it("output canvas is always exactly the requested target dimensions", () => {
    const source = solidOpaqueSquare(200, 0, 0, 0);
    const result = resampleContainWithTransparentPadding(source, 900, 1200, 0.05);
    assert.equal(result.image.width, 900);
    assert.equal(result.image.height, 1200);
  });

  it("never distorts aspect ratio — content region matches source aspect ratio, not target aspect ratio", () => {
    const source = solidOpaqueSquare(500, 0, 0, 0); // square source
    const result = resampleContainWithTransparentPadding(source, 900, 1800, 0); // 1:2 target
    // A square source resampled into a "contain" box must stay square,
    // never stretched to fill a non-square target.
    assert.equal(result.contentWidthPx, result.contentHeightPx);
  });

  it("margin produces fully transparent padding on every edge", () => {
    const source = solidOpaqueSquare(200, 255, 0, 0);
    const result = resampleContainWithTransparentPadding(source, 400, 400, 0.1);
    const { width, data } = result.image;
    // Top-left corner pixel must be fully transparent padding.
    assert.equal(data[3], 0);
    // Top-right corner pixel too.
    assert.equal(data[(width - 1) * 4 + 3], 0);
  });

  it("zero margin with an exact-fit square source leaves no transparent padding", () => {
    const source = solidOpaqueSquare(400, 255, 255, 255);
    const result = resampleContainWithTransparentPadding(source, 400, 400, 0);
    assert.equal(hasAnyTransparentPixel(result.image), false);
  });

  it("is deterministic — identical inputs always produce byte-identical output", () => {
    const source = solidOpaqueSquare(300, 12, 34, 56);
    const first = resampleContainWithTransparentPadding(source, 900, 900, 0.05);
    const second = resampleContainWithTransparentPadding(source, 900, 900, 0.05);
    assert.deepEqual(first.image.data, second.image.data);
    assert.equal(first.contentScale, second.contentScale);
  });

  it("preserves source color content (center of a solid-color square stays that color)", () => {
    const source = solidOpaqueSquare(200, 200, 100, 50);
    const result = resampleContainWithTransparentPadding(source, 400, 400, 0.05);
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
