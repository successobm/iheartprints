import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inspectSignEdge } from "./edge-inspection";
import { inspectSignArtwork } from "./sign-inspection";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import type { SignProductionSpec } from "./contracts";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import {
  exactAspectSignArtwork,
  noisyEdgeSignArtwork,
  ruthLikeSignArtwork,
  transparentSignArtwork,
  uniformBackgroundSignArtwork,
} from "./sign-fixtures";

const RUTH_SPEC: SignProductionSpec = {
  category: RIGID_SIGN_CATEGORY,
  orderedWidthIn: 18,
  orderedHeightIn: 24,
  confirmedAt: "2026-08-30T12:00:00.000Z",
  resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
};

describe("sign edge inspection (deterministic, per-edge bands)", () => {
  it("A: a uniform near-black field proves uniform_background on every edge", () => {
    const image = uniformBackgroundSignArtwork();
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      const evidence = inspectSignEdge(image, edge);
      assert.equal(evidence.classification, "uniform_background", edge);
      assert.ok(evidence.dominantCoverage > 0.99);
      assert.ok(evidence.dominantColor);
      assert.ok(Math.abs(evidence.dominantColor!.r - 6) <= 2);
    }
  });

  it("B: Ruth-shaped rainbow bleeding off the side edges classifies foreground_bleed left/right, uniform top/bottom", () => {
    const image = ruthLikeSignArtwork();
    assert.equal(inspectSignEdge(image, "top").classification, "uniform_background");
    assert.equal(inspectSignEdge(image, "bottom").classification, "uniform_background");
    const left = inspectSignEdge(image, "left");
    const right = inspectSignEdge(image, "right");
    assert.equal(left.classification, "foreground_bleed");
    assert.equal(right.classification, "foreground_bleed");
    // The evidence explains itself: a long contiguous content run on the
    // outermost line, against a dominant near-black background.
    assert.ok(left.longestNonBackgroundRunPx >= 190);
    assert.ok(left.dominantCoverage >= 0.6 && left.dominantCoverage < 0.985);
  });

  it("C: an unprovable edge classifies mixed_or_uncertain — unknown never becomes safe", () => {
    const image = noisyEdgeSignArtwork();
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      assert.equal(inspectSignEdge(image, edge).classification, "mixed_or_uncertain", edge);
    }
  });

  it("D: transparency in an edge band forfeits the uniform verdict", () => {
    const image = uniformBackgroundSignArtwork(600, 900);
    // Punch transparency into the top band.
    for (let x = 0; x < 600; x++) image.data[(2 * 600 + x) * 4 + 3] = 0;
    const top = inspectSignEdge(image, "top");
    assert.notEqual(top.classification, "uniform_background");
  });
});

describe("sign inspection (geometry, resolution, transparency)", () => {
  it("E: Ruth geometry — 2:3 source on a 3:4 substrate, contain = 16×24 at a truthful 64 PPI", () => {
    const report = inspectSignArtwork(
      ruthLikeSignArtwork(),
      RUTH_SPEC,
      RIGID_RECT_UP_TO_24X36_V1,
    );
    assert.equal(report.aspectMismatch, true);
    const contain = report.placements.contain!;
    assert.ok(Math.abs(contain.artworkWidthIn - 16) < 1e-9);
    assert.ok(Math.abs(contain.artworkHeightIn - 24) < 1e-9);
    assert.ok(Math.abs(contain.effectivePpi - 64) < 1e-9);
    assert.deepEqual(contain.affectedEdges, ["left", "right"]);
    assert.ok(Math.abs(contain.paddingIn.left - 1) < 1e-9);
    assert.ok(Math.abs(contain.paddingIn.right - 1) < 1e-9);

    // Fill would cut 3 inches of height → 171 source px — and V1 treats any
    // non-zero crop as potentially meaningful. Stretching is not measured
    // anywhere: it is not a strategy.
    const fill = report.placements.fill!;
    assert.equal(fill.cropSourcePx.vertical, 171);
    assert.equal(fill.cropSourcePx.horizontal, 0);
    assert.equal(fill.meaningfulContentMayBeAffected, true);
    assert.deepEqual(fill.affectedEdges, ["top", "bottom"]);

    const res = report.resolution!;
    assert.equal(res.status, "below_minimum");
    assert.ok(Math.abs(res.requiredScaleToTarget - 150 / 64) < 1e-9);
    assert.ok(Math.abs(res.requiredScaleToMinimum - 100 / 64) < 1e-9);
    assert.equal(report.transparency.hasAlphaPixels, false);
  });

  it("F: without a confirmed spec, nothing ordered-size-dependent is computed or defaulted", () => {
    const report = inspectSignArtwork(ruthLikeSignArtwork(), null, null);
    assert.equal(report.ordered, null);
    assert.equal(report.aspectMismatch, null);
    assert.equal(report.placements.contain, null);
    assert.equal(report.placements.fill, null);
    assert.equal(report.resolution, null);
    // Spec-independent facts are still measured.
    assert.equal(report.source.widthPx, 1024);
    assert.equal(report.edges.length, 4);
  });

  it("G: transparency is measured from the alpha plane, never inferred", () => {
    const report = inspectSignArtwork(
      transparentSignArtwork(),
      RUTH_SPEC,
      RIGID_RECT_UP_TO_24X36_V1,
    );
    assert.equal(report.transparency.hasAlphaPixels, true);
    assert.ok(report.transparency.transparentPixelFraction > 0.05);
  });

  it("H: a 90° rotation match is recognized without ever being applied here", () => {
    const report = inspectSignArtwork(
      exactAspectSignArtwork(1200, 900),
      RUTH_SPEC,
      RIGID_RECT_UP_TO_24X36_V1,
    );
    assert.equal(report.aspectMismatch, true);
    assert.equal(report.orientation.source, "landscape");
    assert.equal(report.orientation.rotatedAspectMatches, true);
  });
});
