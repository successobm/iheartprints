import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isEdgeDependentStructure, anyEdgeIsEdgeDependent, affectedEdgesForAxis } from "./edge-dependence";
import { inspectSignEdge } from "./edge-inspection";
import {
  edgeStructureSignArtwork,
  noisyEdgeSignArtwork,
  ruthLikeSignArtwork,
  uniformBackgroundSignArtwork,
} from "./sign-fixtures";

/**
 * Signs Perimeter Safety Phase: the deterministic edge-dependence signal
 * (`edge-dependence.ts`), calibrated against a representative fixture set —
 * never fit to the one real image (project cc6cfc4b-...) alone. See that
 * module's own doc comment for the full rationale.
 */
describe("isEdgeDependentStructure — calibration set", () => {
  it("A: a genuinely empty/uniform extension-safe margin is never edge-dependent", () => {
    const image = uniformBackgroundSignArtwork();
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      const evidence = inspectSignEdge(image, edge);
      assert.equal(evidence.classification, "uniform_background", edge);
      assert.equal(isEdgeDependentStructure(evidence), false, edge);
    }
  });

  it("B: ordinary foreground that approaches/touches an edge without forming a perimeter system is never edge-dependent (Ruth's rainbow, ~12.5% of the edge length)", () => {
    const image = ruthLikeSignArtwork();
    const left = inspectSignEdge(image, "left");
    const right = inspectSignEdge(image, "right");
    // Same classification bucket the flagged cases below can ALSO land in —
    // proving the signal distinguishes WITHIN one bucket, not merely across
    // buckets.
    assert.equal(left.classification, "foreground_bleed");
    assert.equal(right.classification, "foreground_bleed");
    assert.equal(isEdgeDependentStructure(left), false);
    assert.equal(isEdgeDependentStructure(right), false);
  });

  it("C: a strong, continuous, full-length border/frame structure IS edge-dependent, even though it classifies the SAME `foreground_bleed` as Ruth's ordinary partial bleed above", () => {
    const image = edgeStructureSignArtwork({ solidColor: true });
    const top = inspectSignEdge(image, "top");
    assert.equal(top.classification, "foreground_bleed");
    assert.equal(isEdgeDependentStructure(top), true);
    // The other three edges are untouched, ordinary uniform background.
    for (const edge of ["right", "bottom", "left"] as const) {
      assert.equal(isEdgeDependentStructure(inspectSignEdge(image, edge)), false, edge);
    }
  });

  it("D: the real incident's own shape — mixed_or_uncertain under the existing classifier, dominantCoverage narrowly below the foreground_bleed floor, low outermost coverage, a very long continuous run — IS edge-dependent", () => {
    const image = edgeStructureSignArtwork({ solidColor: false });
    const top = inspectSignEdge(image, "top");
    assert.equal(top.classification, "mixed_or_uncertain");
    assert.ok(top.dominantCoverage < 0.6, "must miss the existing foreground_bleed floor — this is not a retuned threshold");
    assert.ok(top.outermostCoverage < 0.5);
    assert.ok(top.longestNonBackgroundRunPx / top.edgeLengthPx >= 0.5);
    assert.equal(isEdgeDependentStructure(top), true);
  });

  it("pure per-pixel noise (no coherent background at all) is never edge-dependent, despite an extreme outermostCoverage/run shape — the dominant-coverage floor exists precisely for this case", () => {
    const image = noisyEdgeSignArtwork();
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      const evidence = inspectSignEdge(image, edge);
      assert.equal(evidence.classification, "mixed_or_uncertain", edge);
      assert.equal(isEdgeDependentStructure(evidence), false, edge);
    }
  });
});

describe("affectedEdgesForAxis / anyEdgeIsEdgeDependent", () => {
  it("maps axis strings to the correct edge pair, and null/unrecognized to null", () => {
    assert.deepEqual(affectedEdgesForAxis("vertical"), ["top", "bottom"]);
    assert.deepEqual(affectedEdgesForAxis("horizontal"), ["left", "right"]);
    assert.equal(affectedEdgesForAxis(null), null);
    assert.equal(affectedEdgesForAxis("diagonal"), null);
    assert.equal(affectedEdgesForAxis(undefined), null);
  });

  it("anyEdgeIsEdgeDependent is true only when a NAMED edge is flagged, ignoring edge-dependence on an edge not in the list", () => {
    const image = edgeStructureSignArtwork({ solidColor: false });
    const allEdges = (["top", "right", "bottom", "left"] as const).map((edge) => inspectSignEdge(image, edge));
    assert.equal(anyEdgeIsEdgeDependent(allEdges, ["top", "bottom"]), true, "top is flagged");
    assert.equal(anyEdgeIsEdgeDependent(allEdges, ["left", "right"]), false, "left/right are ordinary uniform background");
  });
});
