/**
 * Operator Production Correction UX (Section N: SELECTION GEOMETRY) —
 * `SignFitToProductionCorrectionTool.tsx`'s own coordinate-mapping logic,
 * pulled out pure/DOM-free so it is directly testable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isSelectionInBounds,
  mapDisplayPointToSourcePx,
  normalizeSelection,
} from "./correction-coordinate-mapping";

describe("mapDisplayPointToSourcePx", () => {
  it("maps a display point to the identical source pixel at 1:1 zoom", () => {
    const p = mapDisplayPointToSourcePx(
      50, 60,
      { left: 0, top: 0, width: 200, height: 300 },
      { width: 200, height: 300 },
    );
    assert.deepEqual(p, { xPx: 50, yPx: 60 });
  });

  it("zoom does not change the selected source pixel — the SAME source point maps identically at 50% and 200% zoom", () => {
    const natural = { width: 200, height: 300 };
    // A point at exactly the source-pixel centre (100, 150) of a 200x300 natural image.
    const atHalfZoom = mapDisplayPointToSourcePx(50, 75, { left: 0, top: 0, width: 100, height: 150 }, natural);
    const atFullZoom = mapDisplayPointToSourcePx(100, 150, { left: 0, top: 0, width: 200, height: 300 }, natural);
    const atDoubleZoom = mapDisplayPointToSourcePx(200, 300, { left: 0, top: 0, width: 400, height: 600 }, natural);
    assert.deepEqual(atHalfZoom, { xPx: 100, yPx: 150 });
    assert.deepEqual(atFullZoom, { xPx: 100, yPx: 150 });
    assert.deepEqual(atDoubleZoom, { xPx: 100, yPx: 150 });
  });

  it("accounts for the display rect's own offset (e.g. after scrolling/panning)", () => {
    const p = mapDisplayPointToSourcePx(
      110, 210,
      { left: 100, top: 200, width: 200, height: 300 },
      { width: 200, height: 300 },
    );
    assert.deepEqual(p, { xPx: 10, yPx: 10 });
  });

  it("clamps to the canvas bounds — a point past the right/bottom edge never exceeds natural width/height", () => {
    const p = mapDisplayPointToSourcePx(
      500, 500,
      { left: 0, top: 0, width: 200, height: 300 },
      { width: 200, height: 300 },
    );
    assert.deepEqual(p, { xPx: 200, yPx: 300 });
  });

  it("clamps to zero — a point before the left/top edge never goes negative", () => {
    const p = mapDisplayPointToSourcePx(
      -50, -50,
      { left: 0, top: 0, width: 200, height: 300 },
      { width: 200, height: 300 },
    );
    assert.deepEqual(p, { xPx: 0, yPx: 0 });
  });

  it("returns null for a zero-size display rect rather than dividing by zero", () => {
    const p = mapDisplayPointToSourcePx(10, 10, { left: 0, top: 0, width: 0, height: 0 }, { width: 200, height: 300 });
    assert.equal(p, null);
  });
});

describe("normalizeSelection", () => {
  it("normalizes a drag in any direction into a positive-area rect", () => {
    const forward = normalizeSelection({ xPx: 10, yPx: 10 }, { xPx: 40, yPx: 30 });
    const backward = normalizeSelection({ xPx: 40, yPx: 30 }, { xPx: 10, yPx: 10 });
    assert.deepEqual(forward, { xPx: 10, yPx: 10, widthPx: 30, heightPx: 20 });
    assert.deepEqual(backward, { xPx: 10, yPx: 10, widthPx: 30, heightPx: 20 });
  });

  it("rejects a zero-area selection (a click with no drag)", () => {
    assert.equal(normalizeSelection({ xPx: 10, yPx: 10 }, { xPx: 10, yPx: 10 }), null);
  });

  it("rejects a zero-width (vertical-line-only) selection", () => {
    assert.equal(normalizeSelection({ xPx: 10, yPx: 10 }, { xPx: 10, yPx: 40 }), null);
  });
});

describe("isSelectionInBounds", () => {
  it("accepts a rect entirely within the natural canvas", () => {
    assert.equal(isSelectionInBounds({ xPx: 10, yPx: 10, widthPx: 50, heightPx: 50 }, { width: 200, height: 300 }), true);
  });

  it("rejects a rect exceeding the canvas on the right/bottom", () => {
    assert.equal(isSelectionInBounds({ xPx: 190, yPx: 10, widthPx: 50, heightPx: 50 }, { width: 200, height: 300 }), false);
    assert.equal(isSelectionInBounds({ xPx: 10, yPx: 290, widthPx: 50, heightPx: 50 }, { width: 200, height: 300 }), false);
  });

  it("rejects a zero-area rect", () => {
    assert.equal(isSelectionInBounds({ xPx: 10, yPx: 10, widthPx: 0, heightPx: 10 }, { width: 200, height: 300 }), false);
  });
});
