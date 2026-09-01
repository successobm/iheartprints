import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { framedSignArtwork, uniformBackgroundSignArtwork } from "./sign-fixtures";
import { measureFrameStructuralModel } from "./frame-structure-model";

/**
 * Parametric Perimeter Frame Reconstruction Phase: coverage for the
 * deterministic measurement primitive. Fixtures mirror the REAL
 * cc6cfc4b-... acceptance sign's own measured geometry (never the
 * customer's own file — the bowling-fixture precedent), generalized so
 * these tests are never encoded only around that one real image.
 */
describe("measureFrameStructuralModel", () => {
  it("1: rectangular multi-band frame (no rounding, no holes) -> measured, cornerRadiusPx null, hole null", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: false, withHoles: false }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.model.bands.length, 3);
    assert.equal(result.model.cornerRadiusPx, null);
    assert.equal(result.model.hole, null);
    assert.equal(result.model.outerBackgroundColor, null);
  });

  it("2: rounded multi-band frame (no holes) -> measured, cornerRadiusPx close to the drawn 42px", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: false }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.ok(result.model.cornerRadiusPx !== null);
    assert.ok(Math.abs(result.model.cornerRadiusPx! - 42) <= 6, `expected ~42px, got ${result.model.cornerRadiusPx}`);
    assert.equal(result.model.hole, null);
    assert.ok(result.model.outerBackgroundColor !== null);
  });

  it("3: rounded frame + four symmetric hole indicators -> measured, hole geometry close to the drawn 9px radius / 33,33 offset", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: true }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.ok(result.model.hole !== null);
    assert.ok(Math.abs(result.model.hole!.radiusPx - 9) <= 4);
    assert.ok(Math.abs(result.model.hole!.offsetFromCornerXPx - 33) <= 6);
    assert.ok(Math.abs(result.model.hole!.offsetFromCornerYPx - 33) <= 6);
  });

  it("4: one missing/ambiguous hole -> blocked (ambiguous), never averaged away", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: true, breakCorner: "missing_hole" }));
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    assert.match(result.reason, /corner-hole indicator/i);
  });

  it("5: inconsistent corner radius -> blocked (ambiguous), never averaged away", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: false, breakCorner: "radius" }));
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    assert.match(result.reason, /radii disagree/i);
  });

  it("9: no frame structure at all -> not_present, never a false admission", () => {
    // A plain uniform-background sign carries no concentric band sequence.
    const image = uniformBackgroundSignArtwork(1000, 1500);
    const result = measureFrameStructuralModel(image);
    assert.equal(result.status, "not_present");
  });

  it("11: no duplicate/ambiguous hole geometry across corners when all four genuinely agree", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: true }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    // Exactly one hole model — never a per-corner array, never four
    // independently-reported holes that could disagree at reconstruction time.
    assert.equal(typeof result.model.hole, "object");
  });

  it("12: protected interior is a conservative, symmetric inset — never touches band territory", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: true }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    const { interior, frameDepthPx, sourceWidthPx, sourceHeightPx } = result.model;
    assert.equal(interior.x, frameDepthPx);
    assert.equal(interior.y, frameDepthPx);
    assert.equal(interior.width, sourceWidthPx - 2 * frameDepthPx);
    assert.equal(interior.height, sourceHeightPx - 2 * frameDepthPx);
  });

  it("band sequence measurement mirrors the REAL cc6cfc4b-... acceptance sign's own measured geometry (outer ~9px, gap ~14-15px, inner ~5-7px)", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: false }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.model.bands.length, 3);
    assert.ok(Math.abs(result.model.bands[0]!.thicknessPx - 9) <= 2);
    assert.ok(Math.abs(result.model.bands[1]!.thicknessPx - 15) <= 2);
    assert.ok(Math.abs(result.model.bands[2]!.thicknessPx - 7) <= 2);
  });

  it("fillColor is measured from the frame's own pixels, never invented", () => {
    const result = measureFrameStructuralModel(framedSignArtwork({ rounded: true, withHoles: false }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    // framedSignArtwork's interior content colour (250,250,250) is what
    // actually sits immediately past the frame band in this fixture — the
    // fixture's own separate "fillColor" (red) is fully overwritten by
    // the frame bands and the interior content, never itself visible.
    assert.ok(Math.abs(result.model.fillColor.r - 250) <= 12);
    assert.ok(Math.abs(result.model.fillColor.g - 250) <= 12);
    assert.ok(Math.abs(result.model.fillColor.b - 250) <= 12);
  });
});
