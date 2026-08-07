import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConceptEvaluation } from "@/lib/domain/types";

import { checkSourceEligibleForFinalization } from "./source-eligibility";

function evaluationFixture(overrides: Partial<ConceptEvaluation> = {}): ConceptEvaluation {
  return {
    overallScore: 90,
    passed: true,
    confidence: 90,
    criteria: [],
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
    ...overrides,
  };
}

describe("checkSourceEligibleForFinalization (Sprint 2M Phase 2E Goal 6)", () => {
  it("M: a concept whose required-wording criterion explicitly failed is ineligible", () => {
    const result = checkSourceEligibleForFinalization(
      evaluationFixture({
        criteria: [
          { key: "required_wording", score: 0, passed: false, confidence: 90, notes: "missing" },
        ],
      }),
    );
    assert.equal(result.eligible, false);
    assert.match(result.reason ?? "", /required wording/i);
  });

  it("a concept with no evaluation at all is eligible (insufficient evidence to block on)", () => {
    const result = checkSourceEligibleForFinalization(null);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, null);
  });

  it("a concept whose required-wording criterion was never assessed (passed: null) is eligible", () => {
    const result = checkSourceEligibleForFinalization(
      evaluationFixture({
        criteria: [
          { key: "required_wording", score: null, passed: null, confidence: 0, notes: "not_specified_in_brief" },
        ],
      }),
    );
    assert.equal(result.eligible, true);
  });

  it("a concept whose required-wording criterion explicitly passed is eligible", () => {
    const result = checkSourceEligibleForFinalization(
      evaluationFixture({
        criteria: [
          { key: "required_wording", score: 100, passed: true, confidence: 90, notes: null },
        ],
      }),
    );
    assert.equal(result.eligible, true);
  });

  it("does not block on other failed criteria (e.g. exclusions) — scoped to required wording only", () => {
    const result = checkSourceEligibleForFinalization(
      evaluationFixture({
        criteria: [
          { key: "exclusions", score: 0, passed: false, confidence: 90, notes: "violation" },
        ],
      }),
    );
    assert.equal(result.eligible, true);
  });
});
