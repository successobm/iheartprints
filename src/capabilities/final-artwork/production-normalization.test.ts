import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import {
  PRINT_PLACEMENT_SIZING_POLICY,
  resolveWidthConstrainedSizing,
} from "@/capabilities/shared/print-placement-dimensions";

import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "./production-normalization";
import { readPhysicalPixelDensity } from "./production-png";
import type { RgbaImage } from "./raster-transform";

/** Opaque artwork rectangle on a fully transparent canvas — the shape every reconstructed apparel raster has. */
function paddedArtwork(
  canvasWidth: number,
  canvasHeight: number,
  box: { left: number; top: number; width: number; height: number },
): RgbaImage {
  const image: RgbaImage = {
    width: canvasWidth,
    height: canvasHeight,
    data: Buffer.alloc(canvasWidth * canvasHeight * 4),
  };
  for (let y = box.top; y < box.top + box.height; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) {
      const idx = (y * canvasWidth + x) * 4;
      image.data[idx] = 90;
      image.data[idx + 1] = 140;
      image.data[idx + 2] = 210;
      image.data[idx + 3] = 255;
    }
  }
  return image;
}

const FULL_FRONT = PRINT_PLACEMENT_SIZING_POLICY.full_front;
const FULL_BACK = PRINT_PLACEMENT_SIZING_POLICY.full_back;

describe("production sizing policy (Print-Ready Normalization Phase 1)", () => {
  // --- H / I: standard adult apparel default width -------------------------
  it("H: full_front targets 10.5in wide at 300 PPI", () => {
    assert.equal(FULL_FRONT.strategy, "width_constrained_preserve_aspect");
    assert.equal(FULL_FRONT.targetWidthIn, 10.5);
    assert.equal(FULL_FRONT.targetPpi, 300);
  });

  it("I: full_back targets 10.5in wide at 300 PPI", () => {
    assert.equal(FULL_BACK.strategy, "width_constrained_preserve_aspect");
    assert.equal(FULL_BACK.targetWidthIn, 10.5);
    assert.equal(FULL_BACK.targetPpi, 300);
  });

  // --- J: 10.5in at 300 PPI is 3150px --------------------------------------
  it("J: 10.5in at 300 PPI resolves to a 3150px target width", () => {
    const resolution = resolveWidthConstrainedSizing(FULL_FRONT, 1000, 1000);
    assert.equal(resolution.widthPx, 3150);
    assert.equal(resolution.widthIn, 10.5);
  });

  // --- K: height derives from the artwork's aspect ratio --------------------
  it("K: height derives proportionally from the artwork's aspect ratio (10.5in x 11.25in → 3150x3375)", () => {
    // A 3150x3375 artwork ratio is exactly the sprint's own worked example.
    const resolution = resolveWidthConstrainedSizing(FULL_BACK, 1400, 1500);
    assert.equal(resolution.widthPx, 3150);
    assert.equal(resolution.heightPx, 3375);
    assert.equal(resolution.widthIn, 10.5);
    assert.equal(resolution.heightIn, 11.25);
    assert.equal(resolution.constrainedBy, "width");
  });

  it("K: a wide artwork gets a short plate, never a forced 3150x4200 canvas", () => {
    const resolution = resolveWidthConstrainedSizing(FULL_BACK, 2000, 1000);
    assert.equal(resolution.widthPx, 3150);
    assert.equal(resolution.heightPx, 1575);
    assert.notEqual(resolution.heightPx, 4200);
  });

  it("an extremely tall artwork is proportionally reduced to the placement's printable height, never stretched or cropped", () => {
    const resolution = resolveWidthConstrainedSizing(FULL_BACK, 500, 2000);
    assert.equal(resolution.constrainedBy, "max_height");
    assert.equal(resolution.heightPx, 4200); // 14in x 300 PPI
    assert.equal(resolution.widthPx, 1050);
    // Aspect ratio survived the height cap.
    assert.ok(Math.abs(resolution.widthPx / resolution.heightPx - 500 / 2000) < 0.001);
  });

  it("physical inches always agree with the pixels actually produced", () => {
    const resolution = resolveWidthConstrainedSizing(FULL_BACK, 1234, 987);
    assert.equal(resolution.widthPx / resolution.targetPpi, resolution.widthIn);
    assert.equal(resolution.heightPx / resolution.targetPpi, resolution.heightIn);
  });
});

describe("normalizeProductionRaster (Print-Ready Normalization Phase 1)", () => {
  it("normalizes a padded reconstruction into an artwork-defined plate at the target width", () => {
    // A reconstructed 4096x4096 raster whose visible artwork is ~2660x2860 —
    // the audited live shape.
    const source = paddedArtwork(4096, 4096, { left: 700, top: 600, width: 2660, height: 2860 });

    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") return;
    const { image, metadata } = outcome.result;

    assert.equal(image.width, 3150, "plate width is the 10.5in target at 300 PPI");
    assert.equal(metadata.intendedWidthIn, 10.5);
    assert.equal(metadata.targetPpi, 300);
    // Height came from the artwork, not from a 14in canvas.
    assert.notEqual(image.height, 4200);
    assert.equal(image.height, metadata.outputHeightPx);
    assert.equal(metadata.constrainedBy, "width");
    assert.equal(metadata.strategy, "width_constrained_preserve_aspect");
  });

  // --- G: aspect ratio preserved through trim + resize ----------------------
  it("G: aspect ratio is preserved through trim + resize", () => {
    const source = paddedArtwork(2000, 2000, { left: 200, top: 300, width: 1200, height: 900 });

    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") return;
    const { metadata } = outcome.result;

    const relativeDeviation =
      Math.abs(metadata.outputAspectRatio - metadata.trimmedAspectRatio) /
      metadata.trimmedAspectRatio;
    assert.ok(
      relativeDeviation < 0.001,
      `aspect ratio drifted by ${relativeDeviation}`,
    );
    assert.equal(
      metadata.intendedWidthIn / metadata.intendedHeightIn > 1,
      true,
      "a wide artwork produces a wide plate",
    );
  });

  // --- L: output effective resolution meets 300 PPI -------------------------
  it("L: the plate's effective resolution is exactly the target PPI on both axes", () => {
    const source = paddedArtwork(4096, 4096, { left: 500, top: 500, width: 3000, height: 2400 });

    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") return;
    const { metadata } = outcome.result;

    assert.ok(metadata.effectivePpiWidth >= 300, `${metadata.effectivePpiWidth} PPI wide`);
    assert.ok(metadata.effectivePpiHeight >= 300, `${metadata.effectivePpiHeight} PPI tall`);
    // Calculated from pixels ÷ intended inches, never from density metadata.
    assert.equal(metadata.effectivePpiWidth, metadata.outputWidthPx / metadata.intendedWidthIn);
  });

  it("leaves almost no transparent dead canvas — occupancy is far above the audited ~50%", () => {
    const source = paddedArtwork(3600, 4200, { left: 469, top: 670, width: 2662, height: 2861 });

    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") return;

    assert.ok(
      outcome.result.metadata.artworkOccupancy > 0.97,
      `expected >0.97 occupancy, got ${outcome.result.metadata.artworkOccupancy}`,
    );
    assert.ok(outcome.result.metadata.transparentPaddingFraction < 0.03);
  });

  it("downscaling a high-resolution reconstruction never fabricates detail (contentScale <= 1)", () => {
    const source = paddedArtwork(4096, 4096, { left: 200, top: 200, width: 3600, height: 3600 });
    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") return;
    assert.ok(outcome.result.metadata.contentScale <= 1);
  });

  it("honestly reports contentScale > 1 when trimmed artwork is smaller than the production size", () => {
    const source = paddedArtwork(1024, 1024, { left: 100, top: 100, width: 800, height: 800 });
    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") return;
    assert.ok(outcome.result.metadata.contentScale > 1);
  });

  it("fails safely for artwork with nothing visible in it", () => {
    const outcome = normalizeProductionRaster(
      { width: 512, height: 512, data: Buffer.alloc(512 * 512 * 4) },
      FULL_BACK,
    );
    assert.equal(outcome.status, "no_visible_artwork");
  });

  it("is deterministic", () => {
    const source = paddedArtwork(1200, 1000, { left: 50, top: 60, width: 700, height: 500 });
    const first = normalizeProductionRaster(source, FULL_BACK);
    const second = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(first.status, "normalized");
    assert.equal(second.status, "normalized");
    if (first.status !== "normalized" || second.status !== "normalized") return;
    assert.deepEqual(first.result.image.data, second.result.image.data);
    assert.deepEqual(first.result.metadata, second.result.metadata);
  });
});

describe("encodeProductionPng (Print-Ready Normalization Phase 1)", () => {
  function normalizedFixture() {
    const source = paddedArtwork(1600, 1400, { left: 100, top: 120, width: 1200, height: 1000 });
    const outcome = normalizeProductionRaster(source, FULL_BACK);
    assert.equal(outcome.status, "normalized");
    if (outcome.status !== "normalized") throw new Error("fixture failed to normalize");
    return outcome.result;
  }

  // --- U: PNG carries 300-PPI density metadata ------------------------------
  it("U: the encoded PNG carries pHYs density metadata corresponding to 300 PPI", () => {
    const encoded = encodeProductionPng(normalizedFixture());

    const density = readPhysicalPixelDensity(encoded.bytes);
    assert.ok(density, "production PNG carries physical-resolution metadata");
    assert.equal(density!.unitSpecifier, 1, "declared in pixels per metre");
    assert.equal(density!.pixelsPerMetreX, 11811);
    assert.equal(density!.pixelsPerMetreY, 11811);
    assert.ok(Math.abs(density!.ppiX - 300) < 0.5, `${density!.ppiX} PPI`);
  });

  it("the density-tagged PNG still decodes normally, at the normalized dimensions", () => {
    const normalized = normalizedFixture();
    const encoded = encodeProductionPng(normalized);

    const decoded = PNG.sync.read(encoded.bytes);
    assert.equal(decoded.width, normalized.image.width);
    assert.equal(decoded.height, normalized.image.height);
    assert.equal(encoded.hasTransparency, true);
  });

  it("declared physical size, pixel geometry, and density metadata all agree", () => {
    const normalized = normalizedFixture();
    const encoded = encodeProductionPng(normalized);
    const density = readPhysicalPixelDensity(encoded.bytes)!;

    // pixels ÷ intended inches === the target PPI === the embedded density.
    const geometryPpi = normalized.image.width / normalized.metadata.intendedWidthIn;
    assert.equal(geometryPpi, normalized.metadata.targetPpi);
    assert.ok(Math.abs(density.ppiX - geometryPpi) < 0.5);
  });
});
