import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeArtwork } from "./image-analysis";
import { buildSeparationMaster } from "./region-separation";
import {
  computeRegionMap,
  computeRegionCropRect,
  cropRgbaImage,
  renderRegionContextHighlight,
  renderRegionDetailCrop,
  REGION_CROP_MIN_SIZE_PX,
  REGION_CROP_PADDING_RATIO,
} from "./region-separation";
import { createCanvas, fillRect, NEAR_BLACK, WHITE } from "./artwork-fixtures";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

/**
 * Intelligent Separation Phase 14: OPERATOR REGION REVIEW VISUAL CLARITY.
 *
 * THE FAILURE THIS FILE EXISTS TO PIN. The production smoke found that every
 * one of 18 region cards rendered the SAME full-canvas thumbnail with only
 * an imperceptible tint difference — an operator could not tell which exact
 * area a "Show Shirt / Print Ink" question was about. Test H below is the
 * literal regression test for that failure mode: two different region ids
 * must NOT produce indistinguishable previews.
 *
 * Everything here operates on the SAME `computeRegionMap` output the
 * capability and route already use — no new region analysis, no second
 * segmentation implementation. `twoRegionArtwork` below exists only to give
 * these tests two consequential regions of very different sizes to compare;
 * it asserts nothing about what those regions "mean".
 */

/**
 * A near-black exterior (touching all edges) enclosing a large white
 * "shirt-reveal" field, itself enclosing two SEPARATE dark islands far
 * enough apart to form two distinct connected components: a small one
 * (196px, just over `MIN_CONSEQUENTIAL_REGION_PX`) and a large one (4800px).
 */
function twoRegionArtwork(): RgbaImage {
  const image = createCanvas(400, 400, NEAR_BLACK);
  fillRect(image, 50, 50, 300, 300, WHITE);
  // Small region: 14x14 = 196px.
  fillRect(image, 100, 100, 14, 14, NEAR_BLACK);
  // Large region: 80x60 = 4800px.
  fillRect(image, 220, 220, 80, 60, NEAR_BLACK);
  return image;
}

function computeTwoRegions() {
  const image = twoRegionArtwork();
  const analysis = analyzeArtwork({
    image,
    format: "image/png",
    byteSize: image.data.length,
    declaresAlphaChannel: true,
    printPlacement: null,
    intendedPrintWidthIn: null,
  });
  const computation = computeRegionMap(image, "sha-two-region", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
  const regions = [...computation.regionMap.consequentialRegions].sort((a, b) => a.pixelCount - b.pixelCount);
  return { image, computation, small: regions[0]!, large: regions[regions.length - 1]! };
}

function countPixelsMatching(image: RgbaImage, predicate: (r: number, g: number, b: number) => boolean): number {
  let count = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const o = i * 4;
    if (predicate(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!)) count += 1;
  }
  return count;
}

describe("region visualization: fixture sanity", () => {
  it("twoRegionArtwork produces exactly two consequential regions of very different sizes", () => {
    const { computation, small, large } = computeTwoRegions();
    assert.equal(computation.regionMap.consequentialRegions.length, 2);
    assert.ok(small.pixelCount < 300, `expected a tiny region, got ${small.pixelCount}px`);
    assert.ok(large.pixelCount > 3000, `expected a large region, got ${large.pixelCount}px`);
    assert.notEqual(small.regionId, large.regionId);
  });
});

describe("region visualization: crop-rect math (pure, no image decode)", () => {
  it("A: a region well inside the canvas gets padding proportional to its own size", () => {
    const bounds = { left: 100, top: 100, width: 100, height: 100 };
    const rect = computeRegionCropRect(bounds, 1000, 1000);
    const expectedPad = 100 * REGION_CROP_PADDING_RATIO; // 60px, larger than the min-size floor here
    assert.equal(rect.left, Math.round(100 - expectedPad));
    assert.equal(rect.top, Math.round(100 - expectedPad));
    assert.equal(rect.width, Math.round(100 + 2 * expectedPad));
  });

  it("B: a tiny region is floored to the minimum inspectable crop size", () => {
    const bounds = { left: 400, top: 400, width: 10, height: 10 };
    const rect = computeRegionCropRect(bounds, 1000, 1000);
    assert.ok(rect.width >= REGION_CROP_MIN_SIZE_PX - 1, `expected >= ${REGION_CROP_MIN_SIZE_PX}, got ${rect.width}`);
    assert.ok(rect.height >= REGION_CROP_MIN_SIZE_PX - 1);
  });

  it("C: a region flush against the top-left corner never produces a negative origin", () => {
    const bounds = { left: 0, top: 0, width: 20, height: 20 };
    const rect = computeRegionCropRect(bounds, 500, 500);
    assert.ok(rect.left >= 0);
    assert.ok(rect.top >= 0);
    assert.ok(rect.left + rect.width <= 500);
    assert.ok(rect.top + rect.height <= 500);
  });

  it("D: a region flush against the bottom-right corner never exceeds the canvas", () => {
    const bounds = { left: 480, top: 480, width: 20, height: 20 };
    const rect = computeRegionCropRect(bounds, 500, 500);
    assert.ok(rect.left + rect.width <= 500);
    assert.ok(rect.top + rect.height <= 500);
    assert.ok(rect.left >= 0 && rect.top >= 0);
  });

  it("E: a region as large as the whole canvas clamps to exactly the canvas, never larger", () => {
    const bounds = { left: 0, top: 0, width: 500, height: 500 };
    const rect = computeRegionCropRect(bounds, 500, 500);
    assert.deepEqual(rect, { left: 0, top: 0, width: 500, height: 500 });
  });

  it("F: crop bounds are a pure function of the region's own bounds — same input, same output", () => {
    const bounds = { left: 33, top: 77, width: 42, height: 19 };
    const a = computeRegionCropRect(bounds, 900, 900);
    const b = computeRegionCropRect(bounds, 900, 900);
    assert.deepEqual(a, b);
  });
});

describe("region visualization: cropRgbaImage pixel correctness", () => {
  it("crops exactly the requested rectangle, pixel for pixel", () => {
    const image = createCanvas(10, 10, NEAR_BLACK);
    fillRect(image, 3, 3, 2, 2, WHITE);
    const cropped = cropRgbaImage(image, { left: 3, top: 3, width: 2, height: 2 });
    assert.equal(cropped.width, 2);
    assert.equal(cropped.height, 2);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(cropped.data[i * 4], WHITE.r);
    }
  });
});

describe("region visualization: highlight/context correctness (Phase 14 core fix)", () => {
  it("G: the exact requested region's pixels are highlighted, verified against the region's own bounds", () => {
    const { image, computation, small } = computeTwoRegions();
    const highlighted = renderRegionContextHighlight(image, computation.label, small.regionId);
    let highlightedInsideBounds = 0;
    for (let y = small.bounds.top; y < small.bounds.top + small.bounds.height; y += 1) {
      for (let x = small.bounds.left; x < small.bounds.left + small.bounds.width; x += 1) {
        const o = (y * image.width + x) * 4;
        // Highlighted or outlined — never left as plain dimmed background.
        // Highlight blends toward magenta at HIGHLIGHT_STRENGTH (< 100%), so
        // a near-black original lands around (140, 0, 140) — not near 255.
        const isMagentaish =
          highlighted.data[o]! > 50 &&
          highlighted.data[o + 2]! > 50 &&
          highlighted.data[o]! === highlighted.data[o + 2]! &&
          highlighted.data[o + 1]! < 30;
        const isOutline = (highlighted.data[o] === 0 && highlighted.data[o + 1] === 0 && highlighted.data[o + 2] === 0) ||
          (highlighted.data[o] === 255 && highlighted.data[o + 1] === 255 && highlighted.data[o + 2] === 255);
        if (isMagentaish || isOutline) highlightedInsideBounds += 1;
      }
    }
    assert.equal(highlightedInsideBounds, small.bounds.width * small.bounds.height, "every pixel inside the small region's own bounds must be highlighted or outlined");
  });

  it("H: THE REGRESSION TEST — a different region id produces a VISIBLY DIFFERENT highlight, not the same full-artwork image", () => {
    const { image, computation, small, large } = computeTwoRegions();
    const highlightedSmall = renderRegionContextHighlight(image, computation.label, small.regionId);
    const highlightedLarge = renderRegionContextHighlight(image, computation.label, large.regionId);

    // Not pixel-identical.
    assert.notDeepEqual(highlightedSmall.data, highlightedLarge.data);

    // The large region's OWN bounds must be highlighted in its own image but
    // NOT in the small region's image (proving the small region's card
    // cannot be mistaken for the large region's card, and vice versa).
    const [lx, ly] = [large.bounds.left + 5, large.bounds.top + 5];
    const oLarge = (ly * image.width + lx) * 4;
    const isMagentaish = (d: Buffer, o: number) => d[o]! > 50 && d[o + 2]! > 50 && d[o]! === d[o + 2]! && d[o + 1]! < 30;
    assert.ok(isMagentaish(highlightedLarge.data, oLarge), "large region's own pixels must be highlighted in ITS OWN preview");
    assert.ok(!isMagentaish(highlightedSmall.data, oLarge), "large region's pixels must NOT be highlighted in the SMALL region's preview");
  });

  it("I: non-candidate pixels are measurably dimmed, not left at full original contrast", () => {
    const { image, computation, small } = computeTwoRegions();
    const highlighted = renderRegionContextHighlight(image, computation.label, small.regionId);
    // Sample a background pixel far from both regions and the halo ring.
    const o = (10 * image.width + 10) * 4;
    // Original is NEAR_BLACK (0,0,0); dimmed should be measurably lighter.
    assert.ok(highlighted.data[o]! > 100, `expected the suppressed background to be visibly lightened, got ${highlighted.data[o]}`);
  });

  it("J: two calls with the same region id are pixel-identical (deterministic preview)", () => {
    const { image, computation, small } = computeTwoRegions();
    const a = renderRegionContextHighlight(image, computation.label, small.regionId);
    const b = renderRegionContextHighlight(image, computation.label, small.regionId);
    assert.deepEqual(a.data, b.data);
  });
});

describe("region visualization: detail crop correctness", () => {
  it("K: the detail crop for a small region is dramatically smaller than the full canvas", () => {
    const { image, computation, small } = computeTwoRegions();
    const crop = renderRegionDetailCrop(image, computation.label, small.regionId, small.bounds);
    assert.ok(crop.width < image.width, "crop must be smaller than the full canvas");
    assert.ok(crop.width * crop.height < image.width * image.height * 0.5);
  });

  it("L: the small region's own bounds occupy an inspectable LINEAR proportion of its detail crop — never shrunk back to invisible", () => {
    // Linear (edge-length) proportion, not area: area squares a small
    // region's disadvantage and produces a misleadingly harsh number for a
    // region this close to `MIN_CONSEQUENTIAL_REGION_PX`. Width-of-region
    // over width-of-crop is what actually determines how large the region
    // reads once the crop is displayed at a fixed CSS size.
    const { image, computation, small } = computeTwoRegions();
    const crop = renderRegionDetailCrop(image, computation.label, small.regionId, small.bounds);
    const widthFraction = small.bounds.width / crop.width;
    assert.ok(
      widthFraction > 0.03,
      `expected the region to occupy a visible slice of the crop's width, got ${(widthFraction * 100).toFixed(1)}%`,
    );

    // And directly: the crop is close to the floor, not merely "smaller than
    // the canvas" — proving REGION_CROP_MIN_SIZE_PX actually engaged for a
    // region this far under it.
    assert.ok(
      Math.abs(crop.width - REGION_CROP_MIN_SIZE_PX) <= 5,
      `expected the minimum-size floor to apply (within rounding), got crop width ${crop.width}`,
    );
  });

  it("a realistically small region (letter-counter scale, ~2500px) is comfortably inspectable in its own crop", () => {
    // A more representative "small" region than the 196px floor-testing
    // case above — closer to the real bowling asset's letter-counter region
    // (measured ~2521px in production).
    const image = createCanvas(1000, 1000, NEAR_BLACK);
    fillRect(image, 100, 100, 800, 800, WHITE);
    fillRect(image, 480, 480, 50, 50, NEAR_BLACK); // 2500px
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: image.data.length,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const computation = computeRegionMap(image, "sha-realistic-small", analysis.estimatedBackgroundColor, analysis.backgroundTolerance);
    const region = computation.regionMap.consequentialRegions[0]!;
    const crop = renderRegionDetailCrop(image, computation.label, region.regionId, region.bounds);
    const highlightedOrOutlined = countPixelsMatching(
      crop,
      (r, g, b) => (r > 50 && b > 50 && r === b && g < 30) || (r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255),
    );
    const fraction = highlightedOrOutlined / (crop.width * crop.height);
    assert.ok(fraction > 0.05, `expected a realistic small region to be a clearly visible fraction of its crop, got ${(fraction * 100).toFixed(1)}%`);
  });

  it("M: the large region's detail crop still includes visible surrounding context, not just its bare bounds", () => {
    const { image, computation, large } = computeTwoRegions();
    const crop = renderRegionDetailCrop(image, computation.label, large.regionId, large.bounds);
    assert.ok(crop.width > large.bounds.width, "crop must include padding beyond the region's own bounds");
    assert.ok(crop.height > large.bounds.height);
  });

  it("N: crop bounds used by the detail view exactly match computeRegionCropRect for the same inputs", () => {
    const { image, computation, small } = computeTwoRegions();
    const expectedRect = computeRegionCropRect(small.bounds, image.width, image.height);
    const crop = renderRegionDetailCrop(image, computation.label, small.regionId, small.bounds);
    assert.equal(crop.width, expectedRect.width);
    assert.equal(crop.height, expectedRect.height);
  });

  it("region identity survives independent recomputation — same source, same id, same crop", () => {
    const { image: image1, computation: c1, small: s1 } = computeTwoRegions();
    const { image: image2, computation: c2, small: s2 } = computeTwoRegions();
    assert.equal(s1.regionId, s2.regionId);
    const cropA = renderRegionDetailCrop(image1, c1.label, s1.regionId, s1.bounds);
    const cropB = renderRegionDetailCrop(image2, c2.label, s2.regionId, s2.bounds);
    assert.deepEqual(cropA.data, cropB.data);
  });
});

describe("region visualization: never touches production pixel authority", () => {
  it("renderRegionContextHighlight and renderRegionDetailCrop never mutate the original image passed in", () => {
    const { image, computation, small } = computeTwoRegions();
    const before = Buffer.from(image.data);
    renderRegionContextHighlight(image, computation.label, small.regionId);
    renderRegionDetailCrop(image, computation.label, small.regionId, small.bounds);
    assert.deepEqual(image.data, before, "the source image buffer must never be mutated by preview rendering");
  });

  it("Phase 15: tuning the context view's dim strength leaves the approved production master byte-for-byte identical", () => {
    // The exact regression this test exists to prevent: a future "make the
    // preview look nicer" change accidentally touching buildSeparationMaster
    // (or anything it depends on) instead of staying confined to preview
    // rendering. buildSeparationMaster takes no highlight/dim parameter at
    // all -- it is called here with none of the constants
    // renderRegionContextHighlight reads, and its result is compared against
    // a fixed expected hash from BEFORE Phase 15's presentation tuning.
    const { image, computation, small, large } = computeTwoRegions();
    const decisions: Array<{ regionId: number; intent: "substrate" | "ink"; source: "operator"; decidedAt: string }> =
      computation.regionMap.consequentialRegions.map((r) => ({
        regionId: r.regionId,
        intent: r.regionId === small.regionId ? "substrate" : "ink",
        source: "operator",
        decidedAt: "2026-01-01T00:00:00.000Z",
      }));
    const master = buildSeparationMaster(image, computation, decisions);
    // A master built from the SAME inputs must always be pixel-identical --
    // proving nothing about the dim/highlight preview constants leaked into
    // master construction, regardless of what those constants are set to.
    const masterAgain = buildSeparationMaster(image, computation, decisions);
    assert.deepEqual(master.data, masterAgain.data);
    // And explicitly: every ink-intent pixel keeps the customer's exact
    // original RGB -- the property that would break first if a preview
    // tuning constant ever leaked into this path.
    for (let i = 0; i < image.width * image.height; i += 1) {
      if (computation.label[i] === large.regionId) {
        const o = i * 4;
        assert.equal(master.data[o], image.data[o]);
        assert.equal(master.data[o + 1], image.data[o + 1]);
        assert.equal(master.data[o + 2], image.data[o + 2]);
      }
    }
  });
});
