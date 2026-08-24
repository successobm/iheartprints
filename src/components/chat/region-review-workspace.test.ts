import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canStepRegion,
  computeAutoAdvanceTarget,
  computeRegionProgress,
  decisionForRegion,
  isFinalReviewReady,
  isRegionPending,
  regionPosition,
  selectInitialActiveRegionId,
  stepRegion,
  submitApproval,
  submitRegionDecision,
  type FetchLike,
  type WorkspaceViewLike,
} from "./region-review-workspace";

function view(overrides: Partial<WorkspaceViewLike> = {}): WorkspaceViewLike {
  return {
    state: "review_required",
    regionMap: { consequentialRegions: [{ regionId: 1 }, { regionId: 2 }, { regionId: 3 }] },
    decisions: [],
    pendingRegionIds: [1, 2, 3],
    ...overrides,
  };
}

describe("region-review-workspace: progress (Goal B/C)", () => {
  it("B: total and reviewed counts match the server's own region/pending arrays", () => {
    const v = view({ pendingRegionIds: [2, 3] });
    const progress = computeRegionProgress(v);
    assert.equal(progress.totalRegions, 3);
    assert.equal(progress.reviewedCount, 1);
  });

  it("C: a region marked uncertain is NOT counted as reviewed, matching Phase 9's completeness rule", () => {
    // pendingRegionIds still includes an "uncertain" region per the server's
    // own semantics (K/L) -- this module must not disagree with that.
    const v = view({ decisions: [{ regionId: 1, intent: "uncertain" }], pendingRegionIds: [1, 2, 3] });
    assert.equal(computeRegionProgress(v).reviewedCount, 0);
  });

  it("zero regions decided reports 0 reviewed", () => {
    assert.equal(computeRegionProgress(view()).reviewedCount, 0);
  });

  it("all regions decided reports full reviewed count", () => {
    assert.equal(computeRegionProgress(view({ pendingRegionIds: [] })).reviewedCount, 3);
  });
});

describe("region-review-workspace: final review gate (Goal I/J/S)", () => {
  it("review_required is never final review", () => {
    assert.equal(isFinalReviewReady(view({ state: "review_required" })), false);
  });

  it("review_in_progress is never final review", () => {
    assert.equal(isFinalReviewReady(view({ state: "review_in_progress" })), false);
  });

  it("review_complete IS final review — the exact state all decisions being made reaches", () => {
    assert.equal(isFinalReviewReady(view({ state: "review_complete", pendingRegionIds: [] })), true);
  });

  it("cannot_safely_automate is never final review — an honest operator-review state, not a completion", () => {
    assert.equal(isFinalReviewReady(view({ state: "cannot_safely_automate" })), false);
  });
});

describe("region-review-workspace: reload-resume rule (Goal G)", () => {
  it("G: with nothing decided, resumes at the FIRST region in server order", () => {
    assert.equal(selectInitialActiveRegionId(view()), 1);
  });

  it("G: with some decided, resumes at the first PENDING region — never region 1 unconditionally", () => {
    const v = view({ decisions: [{ regionId: 1, intent: "ink" }], pendingRegionIds: [2, 3] });
    assert.equal(selectInitialActiveRegionId(v), 2);
  });

  it("G: an uncertain region still counts as pending for resume purposes", () => {
    const v = view({
      decisions: [
        { regionId: 1, intent: "ink" },
        { regionId: 2, intent: "uncertain" },
      ],
      pendingRegionIds: [2, 3],
    });
    assert.equal(selectInitialActiveRegionId(v), 2);
  });

  it("I: once complete, resume returns null (caller shows final review, not region 1)", () => {
    const v = view({ state: "review_complete", pendingRegionIds: [] });
    assert.equal(selectInitialActiveRegionId(v), null);
  });
});

describe("region-review-workspace: Previous/Next navigation (Goal D)", () => {
  const regions = [{ regionId: 10 }, { regionId: 20 }, { regionId: 30 }];

  it("D: next moves forward through the full ordered list", () => {
    assert.equal(stepRegion(regions, 10, "next"), 20);
    assert.equal(stepRegion(regions, 20, "next"), 30);
  });

  it("D: previous moves backward through the full ordered list", () => {
    assert.equal(stepRegion(regions, 30, "previous"), 20);
    assert.equal(stepRegion(regions, 20, "previous"), 10);
  });

  it("D: clamps at the last region — next does not wrap to the first", () => {
    assert.equal(stepRegion(regions, 30, "next"), 30);
    assert.equal(canStepRegion(regions, 30, "next"), false);
  });

  it("D: clamps at the first region — previous does not wrap to the last", () => {
    assert.equal(stepRegion(regions, 10, "previous"), 10);
    assert.equal(canStepRegion(regions, 10, "previous"), false);
  });

  it("D: already-decided regions remain reachable by navigation (no filtering by pending status)", () => {
    // Navigation walks ALL regions, unlike the reload-resume rule.
    assert.equal(stepRegion(regions, 10, "next"), 20);
  });
});

describe("region-review-workspace: auto-advance (Goal E/F)", () => {
  it("E: deciding a PENDING region advances to the next still-pending region", () => {
    const fresh = view({ decisions: [{ regionId: 1, intent: "ink" }], pendingRegionIds: [2, 3] });
    const result = computeAutoAdvanceTarget(true, fresh);
    assert.equal(result.shouldAdvance, true);
    assert.equal(result.targetRegionId, 2);
  });

  it("E: deciding the LAST pending region advances to final review (null target)", () => {
    const fresh = view({ state: "review_complete", decisions: [{ regionId: 3, intent: "ink" }], pendingRegionIds: [] });
    const result = computeAutoAdvanceTarget(true, fresh);
    assert.equal(result.shouldAdvance, true);
    assert.equal(result.targetRegionId, null);
  });

  it("revisiting an ALREADY-DECIDED region and changing it does NOT auto-advance", () => {
    const fresh = view({ decisions: [{ regionId: 1, intent: "substrate" }], pendingRegionIds: [2, 3] });
    const result = computeAutoAdvanceTarget(false, fresh);
    assert.equal(result.shouldAdvance, false);
  });
});

describe("region-review-workspace: decision lookup + position", () => {
  it("decisionForRegion returns the current intent or null", () => {
    const v = view({ decisions: [{ regionId: 2, intent: "substrate" }] });
    assert.equal(decisionForRegion(v, 2), "substrate");
    assert.equal(decisionForRegion(v, 1), null);
  });

  it("isRegionPending matches the server's pendingRegionIds exactly", () => {
    const v = view({ pendingRegionIds: [2] });
    assert.equal(isRegionPending(v, 2), true);
    assert.equal(isRegionPending(v, 1), false);
  });

  it("regionPosition is 1-based and follows server order, not regionId value", () => {
    const v = view({ regionMap: { consequentialRegions: [{ regionId: 259 }, { regionId: 5 }, { regionId: 64 }] } });
    assert.equal(regionPosition(v, 259), 1);
    assert.equal(regionPosition(v, 5), 2);
    assert.equal(regionPosition(v, 64), 3);
  });
});

describe("region-review-workspace: persistence gates navigation (Goal E/F)", () => {
  function okFetch(responseBody: unknown): FetchLike {
    return async () => ({ ok: true, json: async () => responseBody });
  }
  function failFetch(errorBody: unknown): FetchLike {
    return async () => ({ ok: false, json: async () => errorBody });
  }
  function throwingFetch(message: string): FetchLike {
    return async () => {
      throw new Error(message);
    };
  }

  it("E: a successful decision returns the fresh view, ready to compute an advance target", async () => {
    const fresh = view({ decisions: [{ regionId: 1, intent: "ink" }], pendingRegionIds: [2, 3] });
    const result = await submitRegionDecision(okFetch(fresh), "proj-1", "sha", "hash", 1, "ink");
    assert.equal(result.ok, true);
    if (result.ok) {
      const advance = computeAutoAdvanceTarget(true, result.view as WorkspaceViewLike);
      assert.equal(advance.shouldAdvance, true);
      assert.equal(advance.targetRegionId, 2);
    }
  });

  it("F: a failed decision (server rejects) returns an error and NO view — there is nothing to navigate with", async () => {
    const result = await submitRegionDecision(failFetch({ error: "stale region map" }), "proj-1", "sha", "hash", 1, "ink");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "stale region map");
      // Structural proof, not just an assertion: the failure branch's type
      // carries no `view` field at all -- `computeAutoAdvanceTarget` cannot
      // be called with what this branch produces without a type error.
      assert.ok(!("view" in result));
    }
  });

  it("F: a network failure (fetch throws) also returns an error, not a crash", async () => {
    const result = await submitRegionDecision(throwingFetch("network down"), "proj-1", "sha", "hash", 1, "ink");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "network down");
  });

  it("a malformed error body still produces a safe fallback message", async () => {
    const brokenJsonFetch: FetchLike = async () => ({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });
    const result = await submitRegionDecision(brokenJsonFetch, "proj-1", "sha", "hash", 1, "ink");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "That decision could not be saved");
  });

  it("J: approval uses the existing approval path and returns the fresh, now-authoritative view", async () => {
    const approved = view({ state: "review_complete", pendingRegionIds: [] });
    const result = await submitApproval(okFetch(approved), "proj-1");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.view, approved);
  });

  it("approval failure is reported, not silently swallowed", async () => {
    const result = await submitApproval(failFetch({ error: "every highlighted area needs a decision" }), "proj-1");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "every highlighted area needs a decision");
  });
});
