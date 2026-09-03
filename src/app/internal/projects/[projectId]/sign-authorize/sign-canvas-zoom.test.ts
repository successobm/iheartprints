import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampZoom, computeFitZoom } from "./sign-canvas-zoom";

const BOUNDS = { minZoom: 0.1, maxZoom: 3 };

describe("computeFitZoom", () => {
  it("fits a portrait sign to the binding (height) axis inside a wide, short viewport", () => {
    // The real acceptance candidate: 3717x5576px (~0.667 aspect), a plausible
    // wide desktop workspace column: 900x760.
    const zoom = computeFitZoom({ width: 3717, height: 5576 }, { width: 900, height: 760 }, BOUNDS);
    const expected = 760 / 5576;
    assert.ok(Math.abs(zoom - expected) < 1e-9, `expected ${expected}, got ${zoom}`);
    // Confirms height, not width, was the binding axis for this portrait sign.
    assert.ok(3717 * zoom <= 900 + 1e-6);
  });

  it("fits a landscape image to the binding (width) axis", () => {
    const zoom = computeFitZoom({ width: 4000, height: 2000 }, { width: 800, height: 900 }, BOUNDS);
    const expected = 800 / 4000;
    assert.ok(Math.abs(zoom - expected) < 1e-9, `expected ${expected}, got ${zoom}`);
    assert.ok(2000 * zoom <= 900 + 1e-6);
  });

  it("fits a near-square image using whichever axis is tighter", () => {
    const zoom = computeFitZoom({ width: 1000, height: 1000 }, { width: 500, height: 480 }, BOUNDS);
    assert.ok(Math.abs(zoom - 0.48) < 1e-9);
  });

  it("clamps to maxZoom when a small image would otherwise fit far larger than 100%", () => {
    const zoom = computeFitZoom({ width: 100, height: 100 }, { width: 900, height: 900 }, BOUNDS);
    assert.equal(zoom, BOUNDS.maxZoom);
  });

  it("clamps to minZoom when a huge image would otherwise need a near-zero scale", () => {
    const zoom = computeFitZoom({ width: 50000, height: 50000 }, { width: 300, height: 300 }, BOUNDS);
    assert.equal(zoom, BOUNDS.minZoom);
  });

  it("returns 1 for a zero-size natural image rather than dividing by zero", () => {
    assert.equal(computeFitZoom({ width: 0, height: 0 }, { width: 900, height: 700 }, BOUNDS), 1);
  });

  it("returns 1 for a not-yet-laid-out (zero-size) viewport rather than dividing by zero", () => {
    assert.equal(computeFitZoom({ width: 3717, height: 5576 }, { width: 0, height: 0 }, BOUNDS), 1);
  });

  it("preserves aspect ratio — the same scale applies to both axes", () => {
    const natural = { width: 3717, height: 5576 };
    const viewport = { width: 900, height: 760 };
    const zoom = computeFitZoom(natural, viewport, BOUNDS);
    const displayWidth = natural.width * zoom;
    const displayHeight = natural.height * zoom;
    const naturalAspect = natural.width / natural.height;
    const displayAspect = displayWidth / displayHeight;
    assert.ok(Math.abs(naturalAspect - displayAspect) < 1e-9);
  });
});

describe("clampZoom", () => {
  it("clamps a value above maxZoom", () => {
    assert.equal(clampZoom(10, BOUNDS), BOUNDS.maxZoom);
  });

  it("clamps a value below minZoom", () => {
    assert.equal(clampZoom(0.001, BOUNDS), BOUNDS.minZoom);
  });

  it("passes through an in-range value unchanged", () => {
    assert.equal(clampZoom(1, BOUNDS), 1);
  });

  it("falls back to minZoom for a non-finite value", () => {
    assert.equal(clampZoom(NaN, BOUNDS), BOUNDS.minZoom);
    assert.equal(clampZoom(Infinity, BOUNDS), BOUNDS.minZoom);
  });
});
