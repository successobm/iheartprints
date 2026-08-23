import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assessSeparationReviewState,
  buildSeparationReviewView,
  isDecisionSetComplete,
  isDecisionSetStale,
  mergeRegionDecisions,
  pendingRegionIds,
  validateSubmitRegionDecisions,
} from "./separation-review";
import type {
  ConsequentialRegion,
  RegionDecision,
  RegionMap,
  SeparationDecisionSet,
} from "./region-separation-contracts";

function region(id: number, px = 1000): ConsequentialRegion {
  return { regionId: id, pixelCount: px, pctOfArtworkBounds: 1, bounds: { left: 0, top: 0, width: 10, height: 10 } };
}

function map(regions: ConsequentialRegion[], overrides: Partial<RegionMap> = {}): RegionMap {
  return {
    algorithmVersion: "v1",
    sourceAssetSha256: "sha-a",
    regionMapHash: "hash-a",
    silhouetteRadius: 3,
    artworkBounds: { left: 0, top: 0, width: 100, height: 100 },
    consequentialRegions: regions,
    totalRegionCount: regions.length,
    ...overrides,
  };
}

function decision(regionId: number, intent: RegionDecision["intent"], source: RegionDecision["source"] = "operator"): RegionDecision {
  return { regionId, intent, source, decidedAt: "2026-01-01T00:00:00.000Z" };
}

function decisionSet(regions: RegionDecision[], overrides: Partial<SeparationDecisionSet> = {}): SeparationDecisionSet {
  return {
    sourceAssetSha256: "sha-a",
    regionMapHash: "hash-a",
    algorithmVersion: "v1",
    decisions: regions,
    approvedAt: null,
    approvedAssetId: null,
    postCheckAtApproval: null,
    ...overrides,
  };
}

describe("separation-review: state machine", () => {
  it("no consequential regions -> review_not_required, regardless of decisions", () => {
    const m = map([]);
    assert.equal(assessSeparationReviewState(m, null), "review_not_required");
  });

  it("consequential regions, no decision set -> review_required", () => {
    const m = map([region(1)]);
    assert.equal(assessSeparationReviewState(m, null), "review_required");
  });

  it("K/L: some regions decided, one still uncertain -> not complete, blocks approval", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink"), decision(2, "uncertain")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_in_progress");
    assert.equal(isDecisionSetComplete(m, ds), false);
  });

  it("some but not all regions decided -> review_in_progress", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_in_progress");
  });

  it("M: all regions decided (substrate/ink only) -> review_complete, eligible but not yet approved", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink"), decision(2, "substrate")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
    assert.equal(isDecisionSetComplete(m, ds), true);
  });

  it("a semantic_suggestion alone never counts as a decision — only operator does", () => {
    const m = map([region(1)]);
    const ds = decisionSet([decision(1, "ink", "semantic_suggestion")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_required");
    assert.equal(isDecisionSetComplete(m, ds), false);
  });

  it("approved and still matching the current map -> review_complete", () => {
    const m = map([region(1)]);
    const ds = decisionSet([decision(1, "ink")], { approvedAt: "2026-01-01T00:00:00.000Z", approvedAssetId: "asset-1" });
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
  });

  describe("E/F: staleness", () => {
    it("stale source hash rejects — but overlapping region ids are still recoverable via review_required", () => {
      const m = map([region(1)]);
      const ds = decisionSet([decision(1, "ink")], { sourceAssetSha256: "sha-DIFFERENT" });
      assert.equal(isDecisionSetStale(m, ds), true);
      assert.equal(assessSeparationReviewState(m, ds), "review_required");
    });

    it("stale region map hash rejects the same way", () => {
      const m = map([region(1)]);
      const ds = decisionSet([decision(1, "ink")], { regionMapHash: "hash-DIFFERENT" });
      assert.equal(isDecisionSetStale(m, ds), true);
      assert.equal(assessSeparationReviewState(m, ds), "review_required");
    });

    it("a decision set with ZERO overlapping region ids cannot be recovered -> cannot_safely_automate", () => {
      const m = map([region(99)]);
      const ds = decisionSet([decision(1, "ink")], { regionMapHash: "hash-DIFFERENT" });
      assert.equal(assessSeparationReviewState(m, ds), "cannot_safely_automate");
    });

    it("a non-stale set is never flagged stale", () => {
      const m = map([region(1)]);
      const ds = decisionSet([decision(1, "ink")]);
      assert.equal(isDecisionSetStale(m, ds), false);
    });

    it("a null decision set is never stale", () => {
      const m = map([region(1)]);
      assert.equal(isDecisionSetStale(m, null), false);
    });
  });

  it("pendingRegionIds lists undecided and uncertain regions, never decided ones", () => {
    const m = map([region(1), region(2), region(3)]);
    const ds = decisionSet([decision(1, "ink"), decision(2, "uncertain")]);
    assert.deepEqual(pendingRegionIds(m, ds), [2, 3]);
  });
});

describe("separation-review: write validation (G/H)", () => {
  it("G: an unknown region id is rejected", () => {
    const m = map([region(1)]);
    const result = validateSubmitRegionDecisions(m, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 999, intent: "ink" }],
    });
    assert.equal(result.ok, false);
  });

  it("rejects a stale sourceAssetSha256", () => {
    const m = map([region(1)]);
    const result = validateSubmitRegionDecisions(m, {
      sourceAssetSha256: "sha-WRONG",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 1, intent: "ink" }],
    });
    assert.equal(result.ok, false);
  });

  it("rejects a stale regionMapHash", () => {
    const m = map([region(1)]);
    const result = validateSubmitRegionDecisions(m, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-WRONG",
      decisions: [{ regionId: 1, intent: "ink" }],
    });
    assert.equal(result.ok, false);
  });

  it("rejects an illegal intent value", () => {
    const m = map([region(1)]);
    const result = validateSubmitRegionDecisions(m, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 1, intent: "delete" as never }],
    });
    assert.equal(result.ok, false);
  });

  it("rejects a duplicate region id in one request", () => {
    const m = map([region(1)]);
    const result = validateSubmitRegionDecisions(m, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [
        { regionId: 1, intent: "ink" },
        { regionId: 1, intent: "substrate" },
      ],
    });
    assert.equal(result.ok, false);
  });

  it("rejects an empty decisions array", () => {
    const m = map([region(1)]);
    const result = validateSubmitRegionDecisions(m, { sourceAssetSha256: "sha-a", regionMapHash: "hash-a", decisions: [] });
    assert.equal(result.ok, false);
  });

  it("accepts a fully valid request", () => {
    const m = map([region(1), region(2)]);
    const result = validateSubmitRegionDecisions(m, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 1, intent: "ink" }, { regionId: 2, intent: "substrate" }],
    });
    assert.equal(result.ok, true);
  });

  it("H: the validated request shape carries only regionId and intent — no pixel/mask field exists to submit", () => {
    const source = readFileSync(path.join(__dirname, "region-separation-contracts.ts"), "utf8");
    const inputBlock = source.slice(
      source.indexOf("export interface SubmitRegionDecisionInput"),
      source.indexOf("export interface SubmitRegionDecisionsRequest") + 400,
    );
    for (const forbidden of [/mask/i, /pixels/i, /rgba/i, /base64/i, /bytes/i]) {
      assert.doesNotMatch(inputBlock, forbidden, `the client-writable shape must not carry ${forbidden}`);
    }
  });
});

describe("separation-review: merge + invalidation (N)", () => {
  it("merging a new decision for an undecided region marks it operator-sourced", () => {
    const m = map([region(1)]);
    const merged = mergeRegionDecisions(m, null, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 1, intent: "ink" }],
    }, "2026-01-01T00:00:00.000Z");
    assert.equal(merged.decisions[0]!.source, "operator");
    assert.equal(merged.decisions[0]!.intent, "ink");
  });

  it("N: changing an already-decided region's intent clears prior approval", () => {
    const m = map([region(1)]);
    const approved = decisionSet([decision(1, "ink")], {
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedAssetId: "asset-1",
    });
    const merged = mergeRegionDecisions(m, approved, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 1, intent: "substrate" }],
    }, "2026-01-02T00:00:00.000Z");
    assert.equal(merged.approvedAt, null);
    assert.equal(merged.approvedAssetId, null);
  });

  it("re-submitting the SAME decision does not clear approval", () => {
    const m = map([region(1)]);
    const approved = decisionSet([decision(1, "ink")], {
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedAssetId: "asset-1",
    });
    const merged = mergeRegionDecisions(m, approved, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 1, intent: "ink" }],
    }, "2026-01-02T00:00:00.000Z");
    assert.equal(merged.approvedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(merged.approvedAssetId, "asset-1");
  });

  it("adding a decision for a NEW region while others stay unchanged clears approval too", () => {
    const m = map([region(1), region(2)]);
    const approved = decisionSet([decision(1, "ink")], {
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedAssetId: "asset-1",
    });
    const merged = mergeRegionDecisions(m, approved, {
      sourceAssetSha256: "sha-a",
      regionMapHash: "hash-a",
      decisions: [{ regionId: 2, intent: "substrate" }],
    }, "2026-01-02T00:00:00.000Z");
    assert.equal(merged.approvedAt, null);
  });
});

describe("buildSeparationReviewView", () => {
  it("assembles a consistent view from a map + decision set", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink"), decision(2, "substrate")]);
    const view = buildSeparationReviewView(m, ds, null, false);
    assert.equal(view.state, "review_complete");
    assert.equal(view.pendingRegionIds.length, 0);
    assert.equal(view.isProductionAuthoritative, false);
  });
});
