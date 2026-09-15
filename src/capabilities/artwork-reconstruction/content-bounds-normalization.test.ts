import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  normalizeReconstructionCanvas,
  RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE,
} from "./content-bounds-normalization";

/**
 * Phase R5 (Section 15/P of the task): proves the provider-canvas ->
 * content-bounds normalization contract — reuses the SAME `trimToAlphaBounds`
 * machinery `alpha-trim.test.ts` already exercises for the apparel
 * production pipeline, so this file focuses on what's NEW here: the
 * aspect-ratio drift comparison against confirmed-contract evidence.
 */

function blankImage(width: number, height: number): RgbaImage {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function fillOpaqueRect(
  image: RgbaImage,
  box: { left: number; top: number; width: number; height: number },
): void {
  for (let y = box.top; y < box.top + box.height; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) {
      const idx = (y * image.width + x) * 4;
      image.data[idx] = 10;
      image.data[idx + 1] = 20;
      image.data[idx + 2] = 30;
      image.data[idx + 3] = 255;
    }
  }
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

describe("normalizeReconstructionCanvas", () => {
  it("trims real transparent provider padding to the artwork's own content bounds (a wide source correctly reconstructed on a square canvas)", () => {
    // A 1024x1024 canvas with a wide (900x300) opaque box centered
    // vertically -- exactly the R1/R2 "square canvas for wide artwork"
    // shape, but with GENUINE transparent padding (not opaque).
    const image = blankImage(1024, 1024);
    fillOpaqueRect(image, { left: 62, top: 362, width: 900, height: 300 });
    const bytes = encodePng(image);

    const result = normalizeReconstructionCanvas(bytes, 900 / 300);

    // `trimToAlphaBounds` adds a small proportional safety margin around
    // the tight content box (its own documented contract) -- this asserts
    // the trim actually narrowed the FULL 1024x1024 canvas down to
    // approximately the artwork's own bounds, not the exact pixel count of
    // that unrelated implementation detail.
    assert.ok(result.widthPx < 1024, "provider's square canvas must have been trimmed");
    assert.ok(result.widthPx >= 900 && result.widthPx <= 950);
    assert.ok(result.heightPx >= 300 && result.heightPx <= 350);
    assert.equal(result.geometryStatus, "verified");
  });

  it("flags review_required when a fully opaque square-canvas result drifts from the source's known aspect ratio (never guesses/warps a crop)", () => {
    // Fully opaque 1024x1024 -- nothing for trimToAlphaBounds to trim, so
    // this can ONLY be caught by the aspect-ratio comparison.
    const image = blankImage(200, 200);
    fillOpaqueRect(image, { left: 0, top: 0, width: 200, height: 200 });
    const bytes = encodePng(image);

    // Source was a wide 900x300 (aspect ratio 3.0) logo -- a square 1:1
    // result is a massive, unresolved drift.
    const result = normalizeReconstructionCanvas(bytes, 3.0);

    assert.equal(result.widthPx, 200);
    assert.equal(result.heightPx, 200);
    assert.equal(result.geometryStatus, "review_required");
    // Never silently warped/cropped back into shape -- geometry is passed
    // through byte-identical, only FLAGGED.
    assert.equal(result.widthPx / result.heightPx, 1);
  });

  it("verified when the result's aspect ratio is within the v1 tolerance of the source's measured aspect ratio", () => {
    const image = blankImage(300, 100); // 3.0 aspect ratio
    fillOpaqueRect(image, { left: 0, top: 0, width: 300, height: 100 });
    const bytes = encodePng(image);

    const withinTolerance = 3.0 * (1 + RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE * 0.5);
    const result = normalizeReconstructionCanvas(bytes, withinTolerance);
    assert.equal(result.geometryStatus, "verified");
  });

  it("review_required when no source aspect ratio evidence exists at all -- never silently 'verified' without evidence", () => {
    const image = blankImage(100, 100);
    fillOpaqueRect(image, { left: 0, top: 0, width: 100, height: 100 });
    const bytes = encodePng(image);

    const result = normalizeReconstructionCanvas(bytes, null);
    assert.equal(result.geometryStatus, "review_required");
  });

  it("throws a clear error for bytes that do not decode as a PNG", () => {
    assert.throws(() => normalizeReconstructionCanvas(Buffer.from("not a png"), null), /could not be decoded/);
  });
});
