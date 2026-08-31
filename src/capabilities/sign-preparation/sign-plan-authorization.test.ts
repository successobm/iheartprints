import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAuthorizationSufficientForRisk } from "./sign-plan-authorization";

/**
 * LIVE PRODUCT BLOCKER #4: the ONE rule this whole authority enforces,
 * tested in complete isolation from the capability/route/PrintValidation
 * layers that each independently apply it (`authorizeSignRepairPlan`,
 * `requestSignFinalArtwork`, `validateRigidSign`'s own re-stated copy).
 */
describe("isAuthorizationSufficientForRisk", () => {
  it("auto_safe: customer is sufficient", () => {
    assert.equal(isAuthorizationSufficientForRisk("auto_safe", "customer"), true);
  });

  it("auto_safe: operator is sufficient", () => {
    assert.equal(isAuthorizationSufficientForRisk("auto_safe", "operator"), true);
  });

  it("review_required: customer is NOT sufficient", () => {
    assert.equal(isAuthorizationSufficientForRisk("review_required", "customer"), false);
  });

  it("review_required: operator is sufficient", () => {
    assert.equal(isAuthorizationSufficientForRisk("review_required", "operator"), true);
  });

  it("blocked: no actor is ever sufficient — there is no plan to authorize", () => {
    assert.equal(isAuthorizationSufficientForRisk("blocked", "customer"), false);
    assert.equal(isAuthorizationSufficientForRisk("blocked", "operator"), false);
  });
});
