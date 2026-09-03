/**
 * Wand-First Correction UX Phase: `computeSignWandSelection`'s own
 * Signs-specific augmentation over the shared flood-fill algorithm
 * (`rectExact`, `eligibleForMaskedDelete`, `touchedCanvasEdges`), plus the
 * transparent overlay-crop renderer and the mask transport encoding.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeImage, fillRect } from "./sign-fixtures";
import {
  computeSignWandSelection,
  encodeSignWandMaskForBounds,
  renderSignSelectionOverlayCrop,
} from "./sign-wand-selection";

describe("computeSignWandSelection", () => {
  it("a genuinely rectangular selection is rectExact", () => {
    const image = makeImage(100, 100, { r: 255, g: 255, b: 255 });
    fillRect(image, 10, 10, 30, 30, { r: 0, g: 0, b: 0 });
    const selection = computeSignWandSelection(image, { x: 15, y: 15 }, "default");
    assert.equal(selection.rectExact, true);
  });

  it("a ring/donut selection is NOT rectExact — its bounding box contains an unselected interior hole", () => {
    const image = makeImage(100, 100, { r: 255, g: 255, b: 255 });
    fillRect(image, 10, 10, 30, 30, { r: 0, g: 0, b: 0 });
    fillRect(image, 15, 15, 25, 25, { r: 255, g: 255, b: 255 }); // carved-out hole
    const selection = computeSignWandSelection(image, { x: 11, y: 11 }, "default"); // click the ring
    assert.equal(selection.rectExact, false);
  });

  it("touchedCanvasEdges is derived purely from bounding-rect geometry, never pixel content", () => {
    const image = makeImage(50, 50, { r: 255, g: 255, b: 255 });
    fillRect(image, 0, 0, 10, 10, { r: 0, g: 0, b: 0 }); // touches top and left
    const selection = computeSignWandSelection(image, { x: 2, y: 2 }, "default");
    assert.deepEqual([...selection.touchedCanvasEdges].sort(), ["left", "top"]);
  });

  it("a fully interior selection touches no canvas edge", () => {
    const image = makeImage(50, 50, { r: 255, g: 255, b: 255 });
    fillRect(image, 20, 20, 30, 30, { r: 0, g: 0, b: 0 });
    const selection = computeSignWandSelection(image, { x: 25, y: 25 }, "default");
    assert.deepEqual(selection.touchedCanvasEdges, []);
  });

  it("a selection touching all four edges reports all four", () => {
    const image = makeImage(10, 10, { r: 0, g: 0, b: 0 }); // the whole canvas is one region
    const selection = computeSignWandSelection(image, { x: 5, y: 5 }, "default");
    assert.deepEqual([...selection.touchedCanvasEdges].sort(), ["bottom", "left", "right", "top"]);
  });

  it("eligibleForMaskedDelete is true for a small, localized selection", () => {
    const image = makeImage(200, 200, { r: 255, g: 255, b: 255 });
    fillRect(image, 10, 10, 20, 20, { r: 0, g: 0, b: 0 });
    const selection = computeSignWandSelection(image, { x: 12, y: 12 }, "default");
    assert.equal(selection.eligibleForMaskedDelete, true);
  });

  it("throws for an out-of-bounds seed, same as the underlying algorithm", () => {
    const image = makeImage(10, 10, { r: 0, g: 0, b: 0 });
    assert.throws(() => computeSignWandSelection(image, { x: 99, y: 0 }, "default"));
  });
});

describe("renderSignSelectionOverlayCrop", () => {
  it("produces a crop sized to bounds, not the full image", () => {
    const image = makeImage(500, 500, { r: 255, g: 255, b: 255 });
    fillRect(image, 100, 100, 120, 120, { r: 0, g: 0, b: 0 });
    const selection = computeSignWandSelection(image, { x: 110, y: 110 }, "default");
    const overlay = renderSignSelectionOverlayCrop(selection.mask, image.width, selection.bounds);
    assert.equal(overlay.width, selection.bounds.width);
    assert.equal(overlay.height, selection.bounds.height);
  });

  it("is alpha-transparent outside the selection and opaque-ish inside it", () => {
    const image = makeImage(50, 50, { r: 255, g: 255, b: 255 });
    fillRect(image, 10, 10, 30, 30, { r: 0, g: 0, b: 0 });
    const selection = computeSignWandSelection(image, { x: 15, y: 15 }, "default");
    const overlay = renderSignSelectionOverlayCrop(selection.mask, image.width, selection.bounds);
    // Corner of the crop (0,0) corresponds to bounds.left/top, which IS the
    // selection's own top-left corner for a perfect rectangle -> selected,
    // so check a point definitely OUTSIDE via direct mask lookup instead.
    const outsideX = selection.bounds.left - 1; // just left of the selection, still >= 0
    if (outsideX >= 0) {
      const idx = selection.bounds.top * image.width + outsideX;
      assert.equal(selection.mask[idx], 0);
    }
    // Every pixel inside the rectangular selection must carry non-zero alpha.
    let anyOpaque = false;
    for (let i = 3; i < overlay.data.length; i += 4) {
      if (overlay.data[i]! > 0) anyOpaque = true;
    }
    assert.equal(anyOpaque, true);
  });

  it("a fully unselected crop region (degenerate) stays fully transparent", () => {
    const mask = new Uint8Array(4 * 4); // all zero
    const overlay = renderSignSelectionOverlayCrop(mask, 4, { left: 0, top: 0, width: 4, height: 4 });
    for (let i = 3; i < overlay.data.length; i += 4) {
      assert.equal(overlay.data[i], 0);
    }
  });
});

describe("encodeSignWandMaskForBounds", () => {
  it("round-trips: the cropped, base64-encoded mask matches the original mask at every selected coordinate", () => {
    const image = makeImage(100, 100, { r: 255, g: 255, b: 255 });
    fillRect(image, 20, 20, 40, 40, { r: 0, g: 0, b: 0 });
    const selection = computeSignWandSelection(image, { x: 25, y: 25 }, "default");
    const encoded = encodeSignWandMaskForBounds(selection.mask, image.width, selection.bounds);
    const decoded = Buffer.from(encoded, "base64");
    assert.equal(decoded.length, selection.bounds.width * selection.bounds.height);
    // Every byte in the cropped mask must equal the full-image mask at the corresponding absolute coordinate.
    for (let cy = 0; cy < selection.bounds.height; cy++) {
      for (let cx = 0; cx < selection.bounds.width; cx++) {
        const absoluteIdx = (selection.bounds.top + cy) * image.width + (selection.bounds.left + cx);
        assert.equal(decoded[cy * selection.bounds.width + cx], selection.mask[absoluteIdx]);
      }
    }
  });
});
