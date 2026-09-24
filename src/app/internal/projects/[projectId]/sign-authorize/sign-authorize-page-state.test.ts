import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SignPlanOperatorReview } from "@/capabilities/sign-preparation";

import { resolveSignApprovalCtaState, resolveSignAuthorizePageState } from "./sign-authorize-page-state";

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
      operatorStructuralOverridePresent: false,
      backgroundTreatment: "keep",
      backgroundRemoval: null,
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
      sourceCurrent: true,
      production: {
        jobStatus: null,
        inFlight: false,
        failed: false,
        printReady: false,
        needsAttention: false,
        blockedCandidateAssetId: null,
        blockedValidationId: null,
        blockedValidationStatus: null,
        fitToProduction: null,
        machineReadableContent: null,
        physicalResolutionMetadata: null,
        requiresVisualAcceptance: false,
        visualAcceptanceSatisfied: false,
        visualAcceptanceAcceptedAt: null,
      },
    };
    assert.deepEqual(
      resolveSignAuthorizePageState({ configured: true, isInternal: true, review }),
      { kind: "ready", review },
    );
  });
});

/** R6B repair (Cursor independent review, Required Repair #3): the "Approve & Continue" CTA's own pure decision. */
describe("resolveSignApprovalCtaState (R6B repair, Required Repair #3)", () => {
  function readyReview(overrides: { canAuthorize: boolean; sourceCurrent: boolean }): Extract<
    SignPlanOperatorReview,
    { status: "ready" }
  > {
    return {
      status: "ready",
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      originalAssetId: "asset-1",
      operatorStructuralOverridePresent: false,
      backgroundTreatment: "keep",
      backgroundRemoval: null,
      plan: {
        riskLabel: "Needs production review",
        canAuthorize: overrides.canAuthorize,
        orderedWidthIn: 18,
        orderedHeightIn: 24,
        artworkWidthPx: 1024,
        artworkHeightPx: 1536,
        findings: [],
        proposedAction: null,
        reviewRequired: true,
        steps: [],
      },
      authorization: { authorizedBy: null, authorizedAt: null, matchesCurrentPlan: false },
      sourceCurrent: overrides.sourceCurrent,
      production: {
        jobStatus: null,
        inFlight: false,
        failed: false,
        printReady: false,
        needsAttention: false,
        blockedCandidateAssetId: null,
        blockedValidationId: null,
        blockedValidationStatus: null,
        fitToProduction: null,
        machineReadableContent: null,
        physicalResolutionMetadata: null,
        requiresVisualAcceptance: false,
        visualAcceptanceSatisfied: false,
        visualAcceptanceAcceptedAt: null,
      },
    };
  }

  it("a plan that could not be formulated is 'blocked', regardless of source currency", () => {
    assert.equal(resolveSignApprovalCtaState(readyReview({ canAuthorize: false, sourceCurrent: true })), "blocked");
    assert.equal(resolveSignApprovalCtaState(readyReview({ canAuthorize: false, sourceCurrent: false })), "blocked");
  });

  it("a well-formed plan whose source has gone stale is 'source_stale', never presented as ordinarily actionable", () => {
    assert.equal(resolveSignApprovalCtaState(readyReview({ canAuthorize: true, sourceCurrent: false })), "source_stale");
  });

  it("a well-formed, current plan is 'can_authorize'", () => {
    assert.equal(resolveSignApprovalCtaState(readyReview({ canAuthorize: true, sourceCurrent: true })), "can_authorize");
  });
});
