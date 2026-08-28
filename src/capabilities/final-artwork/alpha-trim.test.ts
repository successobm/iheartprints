import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeAlphaBounds,
  DEFAULT_ALPHA_THRESHOLD,
  MIN_SAFETY_MARGIN_PX,
  safetyMarginPxFor,
  trimToAlphaBounds,
} from "./alpha-trim";
import type { RgbaImage } from "./raster-transform";

function blankImage(width: number, height: number): RgbaImage {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function setPixel(
  image: RgbaImage,
  x: number,
  y: number,
  rgba: [number, number, number, number],
): void {
  const idx = (y * image.width + x) * 4;
  image.data[idx] = rgba[0];
  image.data[idx + 1] = rgba[1];
  image.data[idx + 2] = rgba[2];
  image.data[idx + 3] = rgba[3];
}

/** Opaque rectangle of artwork on an otherwise fully transparent canvas. */
function paddedArtwork(
  canvasWidth: number,
  canvasHeight: number,
  box: { left: number; top: number; width: number; height: number },
): RgbaImage {
  const image = blankImage(canvasWidth, canvasHeight);
  for (let y = box.top; y < box.top + box.height; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) {
      setPixel(image, x, y, [200, 30, 30, 255]);
    }
  }
  return image;
}

function fullyOpaque(width: number, height: number): RgbaImage {
  const image = blankImage(width, height);
  for (let i = 0; i < width * height; i += 1) {
    image.data[i * 4] = 12;
    image.data[i * 4 + 1] = 34;
    image.data[i * 4 + 2] = 56;
    image.data[i * 4 + 3] = 255;
  }
  return image;
}

describe("computeAlphaBounds (Print-Ready Normalization Phase 1)", () => {
  it("finds the tightest box containing every meaningful pixel", () => {
    const image = paddedArtwork(100, 80, { left: 20, top: 10, width: 30, height: 40 });
    const bbox = computeAlphaBounds(image);
    assert.deepEqual(bbox, {
      left: 20,
      top: 10,
      right: 50,
      bottom: 50,
      width: 30,
      height: 40,
    });
  });

  it("returns null for a fully transparent image", () => {
    assert.equal(computeAlphaBounds(blankImage(40, 40)), null);
  });

  it("includes pixels exactly at the alpha threshold, and excludes those just below it", () => {
    const image = blankImage(20, 20);
    setPixel(image, 5, 5, [10, 10, 10, DEFAULT_ALPHA_THRESHOLD]);
    setPixel(image, 15, 15, [10, 10, 10, DEFAULT_ALPHA_THRESHOLD - 1]);

    const bbox = computeAlphaBounds(image);
    assert.deepEqual(bbox, { left: 5, top: 5, right: 6, bottom: 6, width: 1, height: 1 });
  });
});

describe("safetyMarginPxFor", () => {
  it("uses the 8px floor for small artwork", () => {
    assert.equal(safetyMarginPxFor({ width: 200, height: 200 }), MIN_SAFETY_MARGIN_PX);
  });

  it("scales at 0.5% of the longest side for large artwork", () => {
    assert.equal(safetyMarginPxFor({ width: 3200, height: 2000 }), 16);
  });
});

describe("trimToAlphaBounds (Print-Ready Normalization Phase 1)", () => {
  // --- A: padded transparent PNG trims correctly ---------------------------
  it("A: a heavily padded transparent canvas is trimmed to its artwork plus the safety margin", () => {
    // Mirrors the audited live plate's shape: artwork occupying roughly half
    // the canvas, centred in transparent padding.
    const image = paddedArtwork(3600, 4200, { left: 469, top: 670, width: 2662, height: 2861 });

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    // max(8, ceil(0.5% of 2861)) = 15px per edge, and the padding is deep
    // enough that every edge gets the full margin.
    assert.equal(outcome.metadata.requestedMarginPx, 15);
    assert.deepEqual(outcome.metadata.appliedMarginPx, {
      left: 15,
      top: 15,
      right: 15,
      bottom: 15,
    });
    assert.equal(outcome.image.width, 2662 + 30);
    assert.equal(outcome.image.height, 2861 + 30);
    assert.equal(outcome.metadata.originalWidthPx, 3600);
    assert.equal(outcome.metadata.originalHeightPx, 4200);
    assert.deepEqual(outcome.metadata.alphaBBox, {
      left: 469,
      top: 670,
      right: 3131,
      bottom: 3531,
      width: 2662,
      height: 2861,
    });
    // Occupancy goes from ~0.50 of the original canvas to ~0.98 of the plate.
    assert.ok(
      outcome.metadata.artworkOccupancy > 0.97,
      `expected near-total occupancy, got ${outcome.metadata.artworkOccupancy}`,
    );
  });

  // --- B: already-tight artwork is effectively unchanged -------------------
  it("B: already-tight artwork is unchanged apart from the permitted safety margin", () => {
    const image = paddedArtwork(220, 220, { left: 10, top: 10, width: 200, height: 200 });

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    // 8px floor, but only 10px of canvas exists on each side — the full
    // margin fits, and nothing else is removed.
    assert.equal(outcome.metadata.requestedMarginPx, MIN_SAFETY_MARGIN_PX);
    assert.equal(outcome.image.width, 216);
    assert.equal(outcome.image.height, 216);
  });

  it("B: artwork already flush with the source edges gets no margin — the crop never invents canvas", () => {
    const image = paddedArtwork(64, 64, { left: 0, top: 0, width: 64, height: 64 });

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    assert.deepEqual(outcome.metadata.appliedMarginPx, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.equal(outcome.image.width, 64);
    assert.equal(outcome.image.height, 64);
    assert.equal(outcome.metadata.alreadyTightToSourceEdges, true);
    assert.equal(outcome.metadata.artworkOccupancy, 1);
  });

  // --- C: glow / anti-aliased edges survive ---------------------------------
  it("C: soft glow and anti-aliased edge pixels are preserved, never cropped away", () => {
    const image = blankImage(120, 120);
    // Solid core...
    for (let y = 50; y < 70; y += 1) {
      for (let x = 50; x < 70; x += 1) setPixel(image, x, y, [255, 255, 255, 255]);
    }
    // ...surrounded by a faint glow that still clears the threshold.
    setPixel(image, 40, 60, [255, 255, 255, 9]);
    setPixel(image, 80, 60, [255, 255, 255, 9]);
    setPixel(image, 60, 38, [255, 255, 255, 12]);

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    const { alphaBBox } = outcome.metadata;
    assert.equal(alphaBBox.left, 40, "faint left glow pixel is inside the bounds");
    assert.equal(alphaBBox.right, 81, "faint right glow pixel is inside the bounds");
    assert.equal(alphaBBox.top, 38, "faint top glow pixel is inside the bounds");

    // The glow pixels really are present in the cropped result, at their
    // expected offsets.
    const glowX = 40 - (alphaBBox.left - outcome.metadata.appliedMarginPx.left);
    const glowY = 60 - (alphaBBox.top - outcome.metadata.appliedMarginPx.top);
    const idx = (glowY * outcome.image.width + glowX) * 4;
    assert.equal(outcome.image.data[idx + 3], 9);
  });

  // --- D: near-zero alpha noise does not defeat trimming --------------------
  it("D: sub-threshold alpha noise outside the artwork does not prevent trimming", () => {
    const image = paddedArtwork(400, 400, { left: 150, top: 150, width: 100, height: 100 });
    // Encoder/upscaler noise scattered near the canvas corners.
    setPixel(image, 0, 0, [0, 0, 0, 1]);
    setPixel(image, 399, 0, [0, 0, 0, 3]);
    setPixel(image, 0, 399, [0, 0, 0, 7]);
    setPixel(image, 399, 399, [0, 0, 0, 2]);

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    assert.equal(outcome.metadata.alphaBBox.width, 100);
    assert.equal(outcome.metadata.alphaBBox.height, 100);
    assert.equal(outcome.image.width, 116);
    assert.equal(outcome.image.height, 116);
  });

  // --- E: fully transparent artwork fails safely ----------------------------
  it("E: a fully transparent image fails safely instead of producing an empty plate", () => {
    const outcome = trimToAlphaBounds(blankImage(256, 256));
    assert.equal(outcome.status, "no_visible_artwork");
    if (outcome.status !== "no_visible_artwork") return;
    assert.match(outcome.reason, /no visible artwork/i);
  });

  it("E: an image whose every pixel is below the alpha threshold also fails safely", () => {
    const image = blankImage(32, 32);
    for (let i = 3; i < image.data.length; i += 4) image.data[i] = DEFAULT_ALPHA_THRESHOLD - 1;

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "no_visible_artwork");
  });

  // --- F: opaque artwork is deterministic and documented --------------------
  it("F: fully opaque artwork passes through unchanged, with no margin and no fabricated transparency", () => {
    const image = fullyOpaque(300, 200);

    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    assert.equal(outcome.image.width, 300);
    assert.equal(outcome.image.height, 200);
    assert.deepEqual(outcome.metadata.appliedMarginPx, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.equal(outcome.metadata.sourceFullyOpaque, true);
    assert.equal(outcome.metadata.artworkOccupancy, 1);
    assert.deepEqual(outcome.image.data, image.data, "pixels are byte-identical");
  });

  it("is deterministic — identical input always produces byte-identical output", () => {
    const image = paddedArtwork(300, 240, { left: 30, top: 40, width: 150, height: 120 });
    const first = trimToAlphaBounds(image);
    const second = trimToAlphaBounds(image);
    assert.equal(first.status, "trimmed");
    assert.equal(second.status, "trimmed");
    if (first.status !== "trimmed" || second.status !== "trimmed") return;
    assert.deepEqual(first.image.data, second.image.data);
    assert.deepEqual(first.metadata, second.metadata);
  });

  it("preserves every meaningful pixel value exactly — trimming is never a resample", () => {
    const image = paddedArtwork(120, 120, { left: 40, top: 40, width: 20, height: 20 });
    const outcome = trimToAlphaBounds(image);
    assert.equal(outcome.status, "trimmed");
    if (outcome.status !== "trimmed") return;

    // The artwork's first pixel, offset by the applied margin.
    const idx =
      (outcome.metadata.appliedMarginPx.top * outcome.image.width +
        outcome.metadata.appliedMarginPx.left) *
      4;
    assert.deepEqual(
      [
        outcome.image.data[idx],
        outcome.image.data[idx + 1],
        outcome.image.data[idx + 2],
        outcome.image.data[idx + 3],
      ],
      [200, 30, 30, 255],
    );
  });
});
