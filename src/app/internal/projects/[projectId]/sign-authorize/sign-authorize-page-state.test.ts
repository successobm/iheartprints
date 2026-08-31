import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SignPlanOperatorReview } from "@/capabilities/sign-preparation";

import { resolveSignAuthorizePageState } from "./sign-authorize-page-state";

describe("LIVE PRODUCT BLOCKER #4A — sign-authorize operator page state", () => {
  it("not configured wins over everything else", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({
        configured: false,
        isInternal: true,
        review: { status: "not_found" },
      }),
      { kind: "unconfigured" },
    );
  });

  it("configured but not internal shows the internal-access prompt, without ever evaluating the review", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({ configured: true, isInternal: false, review: null }),
      { kind: "not_internal" },
    );
  });

  it("internal + no review loaded at all (defensive) is treated as not_found", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({ configured: true, isInternal: true, review: null }),
      { kind: "not_found" },
    );
  });

  it("internal + project not found", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({
        configured: true,
        isInternal: true,
        review: { status: "not_found" },
      }),
      { kind: "not_found" },
    );
  });

  it("internal + no sign preparation on this project", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({
        configured: true,
        isInternal: true,
        review: { status: "no_preparation" },
      }),
      { kind: "no_preparation" },
    );
  });

  it("internal + preparation exists but has never been (successfully) planned", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({
        configured: true,
        isInternal: true,
        review: { status: "no_plan" },
      }),
      { kind: "no_plan" },
    );
  });

  it("internal + a real plan exists: ready carries the full review through", () => {
    const review: SignPlanOperatorReview = {
      status: "ready",
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      originalAssetId: "asset-1",
      plan: {
        riskLabel: "Needs production review",
        canAuthorize: true,
        orderedWidthIn: 18,
        orderedHeightIn: 24,
        artworkWidthPx: 1024,
        artworkHeightPx: 1536,
        findings: [],
        steps: [],
      },
      authorization: { authorizedBy: null, authorizedAt: null, matchesCurrentPlan: false },
    };
    assert.deepEqual(
      resolveSignAuthorizePageState({ configured: true, isInternal: true, review }),
      { kind: "ready", review },
    );
  });
});
