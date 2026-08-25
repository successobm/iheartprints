import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assessSeparationReviewState,
  buildSeparationReviewView,
  effectiveProposalDecision,
  isDecisionSetComplete,
  isDecisionSetStale,
  isProposalStale,
  isReadyForFinalApproval,
  mergeProposalDecision,
  mergeRegionDecisions,
  pendingRegionIds,
  validateSubmitProposalDecision,
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
    inBoundsProposal: null,
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
    proposalDecision: "pending",
    proposalDecisionAt: null,
    proposalHash: null,
    proposalPreserveOps: [],
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

  it("Phase 23 / Phase 22B Issue 2: consequential regions, no decision set, NO in-bounds proposal -> review_complete (0/N reviewed can still reach final review, since undecided regions already retain by default)", () => {
    const m = map([region(1)]);
    assert.equal(assessSeparationReviewState(m, null), "review_complete");
    // The individual region is still correctly reported as pending for the
    // OPTIONAL inspection UI -- only the top-level gate changed, not the
    // per-region bookkeeping.
    assert.deepEqual(pendingRegionIds(m, null), [1]);
  });

  it("K/L: some regions decided, one still uncertain, NO proposal -> still review_complete (region completeness no longer gates); isDecisionSetComplete remains an accurate INFORMATIONAL signal", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink"), decision(2, "uncertain")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
    assert.equal(isDecisionSetComplete(m, ds), false, "informational completeness is unaffected by the approval-gate change");
  });

  it("Phase 23: some but not all regions decided, NO proposal -> still review_complete; review_in_progress is now UNREACHABLE when there is no proposal to gate on (documented, not incidental)", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
  });

  it("M: all regions decided (substrate/ink only) -> review_complete, eligible but not yet approved", () => {
    const m = map([region(1), region(2)]);
    const ds = decisionSet([decision(1, "ink"), decision(2, "substrate")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
    assert.equal(isDecisionSetComplete(m, ds), true);
  });

  it("a semantic_suggestion alone never counts as a decision — only operator does (informational completeness, unaffected by the approval-gate change; NO proposal here so the state itself is review_complete)", () => {
    const m = map([region(1)]);
    const ds = decisionSet([decision(1, "ink", "semantic_suggestion")]);
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
    assert.equal(isDecisionSetComplete(m, ds), false);
    assert.deepEqual(pendingRegionIds(m, ds), [1], "a semantic_suggestion never resolves a region for the optional-inspection UI either");
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

function proposalMap(regions: ConsequentialRegion[], overrides: Partial<RegionMap> = {}): RegionMap {
  return map(regions, {
    inBoundsProposal: { proposalHash: "proposal-hash-a", pixelCount: 500, bounds: { left: 0, top: 0, width: 20, height: 20 } },
    ...overrides,
  });
}

describe("Phase 23: proposal-driven approval gate", () => {
  it("a proposal exists and is pending -> review_required, blocks approval, EVEN WITH ZERO consequential regions", () => {
    const m = proposalMap([]);
    assert.equal(assessSeparationReviewState(m, null), "review_required", "review_not_required would be wrong -- there IS something to review");
    assert.equal(isReadyForFinalApproval(m, null), false);
  });

  it("proposal decided remove_with_exceptions -> review_complete, ready for approval, even with 0/N consequential regions decided (Section 9's explicit requirement)", () => {
    const m = proposalMap([region(1), region(2)]);
    const ds = decisionSet([], { proposalDecision: "remove_with_exceptions", proposalDecisionAt: "2026-01-01T00:00:00.000Z", proposalHash: "proposal-hash-a" });
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
    assert.equal(isReadyForFinalApproval(m, ds), true);
    assert.deepEqual(pendingRegionIds(m, ds), [1, 2], "individual regions remain visibly pending for optional inspection, but do not block approval");
  });

  it("proposal decided preserve_all -> review_complete, ready for approval", () => {
    const m = proposalMap([]);
    const ds = decisionSet([], { proposalDecision: "preserve_all", proposalDecisionAt: "2026-01-01T00:00:00.000Z", proposalHash: "proposal-hash-a" });
    assert.equal(assessSeparationReviewState(m, ds), "review_complete");
    assert.equal(isReadyForFinalApproval(m, ds), true);
  });

  it("proposalHash mismatch (geometry drift) fails closed: treated as pending, never remapped onto the new proposal", () => {
    const m = proposalMap([]);
    const ds = decisionSet([], { proposalDecision: "remove_with_exceptions", proposalDecisionAt: "2026-01-01T00:00:00.000Z", proposalHash: "STALE-hash" });
    assert.equal(isProposalStale(m, ds), true);
    assert.equal(effectiveProposalDecision(m, ds), "pending");
    assert.equal(isReadyForFinalApproval(m, ds), false);
    assert.equal(assessSeparationReviewState(m, ds), "review_required");
  });

  it("a stale proposal is ALWAYS recoverable (never cannot_safely_automate) -- unlike a fully-disjoint region-id staleness", () => {
    const m = proposalMap([]);
    const ds = decisionSet([], { proposalDecision: "preserve_all", proposalDecisionAt: "2026-01-01T00:00:00.000Z", proposalHash: "STALE-hash" });
    assert.notEqual(assessSeparationReviewState(m, ds), "cannot_safely_automate");
  });

  it("regionMapHash staleness with zero overlap still produces cannot_safely_automate, independent of the proposal axis", () => {
    const m = proposalMap([region(1)]);
    const ds = decisionSet([decision(99, "ink")], { regionMapHash: "DIFFERENT-hash", proposalDecision: "remove_with_exceptions", proposalHash: "proposal-hash-a" });
    assert.equal(assessSeparationReviewState(m, ds), "cannot_safely_automate");
  });

  it("Phase 22B Issue 3: toggling remove_with_exceptions -> preserve_all invalidates prior approval", () => {
    const m = proposalMap([]);
    const approved = decisionSet([], {
      proposalDecision: "remove_with_exceptions",
      proposalHash: "proposal-hash-a",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedAssetId: "asset-1",
    });
    const merged = mergeProposalDecision(m, approved, { decision: "preserve_all" }, "2026-01-02T00:00:00.000Z", [], "cap:v1", "snap:v1");
    assert.equal(merged.approvedAt, null, "switching TO preserve_all must invalidate prior approval");
  });

  it("Phase 22B Issue 3: toggling preserve_all -> remove_with_exceptions invalidates prior approval", () => {
    const m = proposalMap([]);
    const approved = decisionSet([], {
      proposalDecision: "preserve_all",
      proposalHash: "proposal-hash-a",
      approvedAt: "2026-01-01T00:00:00.000Z",
      approvedAssetId: "asset-1",
    });
    const merged = mergeProposalDecision(m, approved, { decision: "remove_with_exceptions" }, "2026-01-02T00:00:00.000Z", [], "cap:v1", "snap:v1");
    assert.equal(merged.approvedAt, null, "switching AWAY FROM preserve_all must also invalidate prior approval");
  });

  it("Phase 22B Issue 3: preserve operations remain STORED (not deleted) while preserve_all is active, and reactivate on switching back", () => {
    const m = proposalMap([]);
    const withOps = decisionSet([], {
      proposalDecision: "remove_with_exceptions",
      proposalHash: "proposal-hash-a",
      proposalPreserveOps: [
        { operationId: "op-1", rawTapX: 5, rawTapY: 5, capRuleVersion: "cap:v1", snapRuleVersion: "snap:v1", decidedAt: "2026-01-01T00:00:00.000Z", source: "operator" },
      ],
    });
    const switchedToPreserveAll = mergeProposalDecision(m, withOps, { decision: "preserve_all" }, "2026-01-02T00:00:00.000Z", [], "cap:v1", "snap:v1");
    assert.equal(switchedToPreserveAll.proposalPreserveOps.length, 1, "the operation must not be deleted merely because preserve_all is now active");

    const switchedBack = mergeProposalDecision(m, switchedToPreserveAll, { decision: "remove_with_exceptions" }, "2026-01-03T00:00:00.000Z", [], "cap:v1", "snap:v1");
    assert.equal(switchedBack.proposalPreserveOps.length, 1, "the stored operation reactivates when switching back to remove_with_exceptions");
  });

  it("validateSubmitProposalDecision fails closed on a proposalHash mismatch", () => {
    const m = proposalMap([]);
    const result = validateSubmitProposalDecision(m, {
      sourceAssetSha256: "sha-a",
      proposalHash: "WRONG-hash",
      decision: "remove_with_exceptions",
    });
    assert.equal(result.ok, false);
  });

  it("validateSubmitProposalDecision refuses when there is no proposal to decide", () => {
    const m = map([]); // no inBoundsProposal
    const result = validateSubmitProposalDecision(m, {
      sourceAssetSha256: "sha-a",
      proposalHash: "anything",
      decision: "remove_with_exceptions",
    });
    assert.equal(result.ok, false);
  });
});
