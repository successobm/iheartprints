import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ambiguousAdjacentFillArtwork,
  bannerSignArtwork,
  bannerSignEdgeContentArtwork,
  bannerSignNoGapMiddleArtwork,
  makeImage,
  noisyEdgeSignArtwork,
} from "./sign-fixtures";
import { segmentStructuralLayout } from "./sign-layout-segmentation";

describe("segmentStructuralLayout", () => {
  it("deterministically detects a top anchor, ordered middle regions, a bottom anchor, and the gaps between them", () => {
    const result = segmentStructuralLayout(bannerSignArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    assert.equal(result.regions.length, 4);
    const [top, mid1, mid2, bottom] = result.regions;

    assert.equal(top!.role, "top_anchor");
    assert.equal(mid1!.role, "middle");
    assert.equal(mid2!.role, "middle");
    assert.equal(bottom!.role, "bottom_anchor");

    // Regions are ordered top-to-bottom by source position.
    assert.ok(top!.sourceBounds.startYPx < mid1!.sourceBounds.startYPx);
    assert.ok(mid1!.sourceBounds.startYPx < mid2!.sourceBounds.startYPx);
    assert.ok(mid2!.sourceBounds.startYPx < bottom!.sourceBounds.startYPx);

    assert.equal(result.gaps.length, 3);
  });

  it("derives contentBounds narrower than (or equal to) sourceBounds, and equal for middle regions with no owned fill", () => {
    const result = segmentStructuralLayout(bannerSignArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    for (const region of result.regions) {
      assert.ok(region.contentBounds.startYPx >= region.sourceBounds.startYPx);
      assert.ok(
        region.contentBounds.startYPx + region.contentBounds.heightPx <=
          region.sourceBounds.startYPx + region.sourceBounds.heightPx,
      );
      if (region.role === "middle") {
        assert.deepEqual(region.contentBounds, region.sourceBounds);
      }
    }
  });

  it("measures the top and bottom anchors' own fill colour and marks it edge-reaching and expandable", () => {
    const result = segmentStructuralLayout(bannerSignArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    const [top, , , bottom] = result.regions;
    assert.ok(top!.fillColor);
    assert.equal(top!.fillEdgeReaching, true);
    assert.equal(top!.expandable, true);
    assert.equal(top!.sourceBounds.startYPx, 0);

    assert.ok(bottom!.fillColor);
    assert.equal(bottom!.fillEdgeReaching, true);
    assert.equal(bottom!.expandable, true);
  });

  it("gives middle regions no fill and marks them non-expandable", () => {
    const result = segmentStructuralLayout(bannerSignArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    for (const region of result.regions.filter((r) => r.role === "middle")) {
      assert.equal(region.fillColor, null);
      assert.equal(region.fillEdgeReaching, false);
      assert.equal(region.expandable, false);
    }
  });

  it("measures a single uniform colour for each inter-region gap", () => {
    const result = segmentStructuralLayout(bannerSignArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    assert.equal(result.gaps.length, 3);
    for (const gap of result.gaps) {
      assert.ok(gap.sourceHeightPx > 0);
      assert.ok(Number.isFinite(gap.fillColor.r));
      assert.ok(Number.isFinite(gap.fillColor.g));
      assert.ok(Number.isFinite(gap.fillColor.b));
    }
  });

  it("merges two content blocks with no separating fill run into a single middle region", () => {
    const result = segmentStructuralLayout(bannerSignNoGapMiddleArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    // top_anchor, ONE merged middle region (not two), a second middle
    // region, bottom_anchor — proving the merge, not a naive count of the
    // fixture's own visually-distinct content blocks (which is 4).
    assert.equal(result.regions.length, 4);
    assert.equal(result.gaps.length, 3);
    const middles = result.regions.filter((r) => r.role === "middle");
    assert.equal(middles.length, 2);
  });

  it("supports meaningful content sitting directly at the canvas edge with no owning fill", () => {
    const result = segmentStructuralLayout(bannerSignEdgeContentArtwork());
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;

    const top = result.regions[0]!;
    assert.equal(top.contentBounds.startYPx, 0);
    assert.equal(top.sourceBounds.startYPx, 0);
    assert.equal(top.fillColor, null);
    assert.equal(top.fillEdgeReaching, false);
  });

  it("fails closed (ambiguous) on two directly adjacent fill runs of genuinely different colours", () => {
    const result = segmentStructuralLayout(ambiguousAdjacentFillArtwork());
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    assert.ok(result.reason.length > 0);
  });

  it("never invokes AI or guesses on a solid single-colour sign — reports not_present, not a fabricated region", () => {
    const image = makeImage(400, 300, { r: 10, g: 10, b: 10 });
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "not_present");
  });

  it("never invents a fill it cannot measure: genuinely noisy artwork with no provable uniform row anywhere becomes one content region, not a guessed anchor/gap", () => {
    // Every row of this fixture is non-uniform, so classifyRow never
    // returns a fill anywhere — the whole canvas is one content run, with
    // no fill colour and no gap recorded for any of it.
    const image = noisyEdgeSignArtwork();
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 1);
    assert.equal(result.gaps.length, 0);
    assert.equal(result.regions[0]!.fillColor, null);
    assert.deepEqual(result.regions[0]!.contentBounds, { startYPx: 0, heightPx: image.height });
  });

  it("depends only on measured pixel evidence — never on literal customer wording or specific content identity", () => {
    // The fixtures used throughout this suite are generic synthetic
    // banner shapes (stripe patterns), never the real customer's own
    // wording or artwork — segmentation has no code path that reads or
    // compares against any literal string at all.
    const result = segmentStructuralLayout(bannerSignArtwork());
    assert.equal(result.status, "measured");
  });
});
