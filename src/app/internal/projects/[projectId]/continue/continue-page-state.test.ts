import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveContinuePageState } from "./continue-page-state";

describe("Phase 28P — continue-as-internal-job operator page state", () => {
  it("not configured wins over everything else", () => {
    assert.deepEqual(
      resolveContinuePageState({ configured: false, isInternal: true, eligibility: { status: "eligible" } }),
      { kind: "unconfigured" },
    );
  });

  it("configured but not internal shows the internal-access prompt, without ever evaluating eligibility", () => {
    assert.deepEqual(
      resolveContinuePageState({ configured: true, isInternal: false, eligibility: null }),
      { kind: "not_internal" },
    );
  });

  it("internal + not found", () => {
    assert.deepEqual(
      resolveContinuePageState({ configured: true, isInternal: true, eligibility: { status: "not_found" } }),
      { kind: "not_found" },
    );
  });

  it("internal + ineligible carries the reason through", () => {
    assert.deepEqual(
      resolveContinuePageState({
        configured: true,
        isInternal: true,
        eligibility: { status: "ineligible", reason: "not approved yet" },
      }),
      { kind: "ineligible", reason: "not approved yet" },
    );
  });

  it("internal + already continued carries the existing project id through", () => {
    assert.deepEqual(
      resolveContinuePageState({
        configured: true,
        isInternal: true,
        eligibility: { status: "already_continued", newProjectId: "abc-123" },
      }),
      { kind: "already_continued", newProjectId: "abc-123" },
    );
  });

  it("internal + eligible is ready", () => {
    assert.deepEqual(
      resolveContinuePageState({ configured: true, isInternal: true, eligibility: { status: "eligible" } }),
      { kind: "ready" },
    );
  });
});
