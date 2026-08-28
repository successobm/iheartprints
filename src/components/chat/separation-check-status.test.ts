import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeSeparationCheckStatus } from "./SeparationReviewPanel";

/**
 * Phase 28G Defect A — the pure decision behind what `SeparationReviewPanel`
 * reports upward via `onStateChange`, and what `CompareStep` fails closed
 * on. See `SeparationReviewPanel.tsx`'s `SeparationCheckStatus` doc comment
 * for the full reasoning. Extracted so the FAIL-CLOSED guarantee (Section
 * 3/4/17.G: an unresolved or failed check must never be reported the same
 * way as a genuinely resolved "nothing to review") is provable by a plain
 * function call, independent of `useEffect` (which this repo's test
 * tooling -- `node:test` + `renderToString` -- never executes).
 */

describe("computeSeparationCheckStatus", () => {
  it("A: reports \"checking\" whenever loading is true, regardless of any other input", () => {
    assert.equal(computeSeparationCheckStatus({ loading: true, error: null, viewState: undefined }), "checking");
    assert.equal(computeSeparationCheckStatus({ loading: true, error: "boom", viewState: "review_required" }), "checking");
  });

  it("G: reports \"error\" when the initial check failed outright (an error, but no view was ever obtained) -- NEVER silently \"review_not_required\"", () => {
    assert.equal(
      computeSeparationCheckStatus({ loading: false, error: "network error", viewState: undefined }),
      "error",
    );
  });

  it("an error alongside an ALREADY-obtained view (a later action failed, not the initial check) reports the view's real state, not \"error\"", () => {
    assert.equal(
      computeSeparationCheckStatus({ loading: false, error: "a decision failed to save", viewState: "review_required" }),
      "review_required",
    );
  });

  it("D: reports the real resolved state once loaded with no error", () => {
    assert.equal(computeSeparationCheckStatus({ loading: false, error: null, viewState: "review_required" }), "review_required");
    assert.equal(computeSeparationCheckStatus({ loading: false, error: null, viewState: "review_not_required" }), "review_not_required");
  });

  it("the 404/no-review-exists case (no error, no view) reports \"review_not_required\" -- unchanged meaning from before this phase", () => {
    assert.equal(computeSeparationCheckStatus({ loading: false, error: null, viewState: undefined }), "review_not_required");
  });
});
