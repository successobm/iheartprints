import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveSignProductionWorkspaceUrl,
  resolveSignReviewWorkspaceUrl,
} from "./sign-production-bridge";

const AUTHORIZED = {
  project: { id: "0858d192-e74e-40b5-8532-a91bc4bcdf8e" },
  signArtwork: { authorization: { matchesCurrentPlan: true } },
} as const;

test("resolveSignProductionWorkspaceUrl: navigates to the correct project's internal workspace once authorized", () => {
  assert.equal(
    resolveSignProductionWorkspaceUrl(AUTHORIZED),
    "/internal/projects/0858d192-e74e-40b5-8532-a91bc4bcdf8e/sign-authorize",
  );
});

test("resolveSignProductionWorkspaceUrl: no snapshot at all does not navigate", () => {
  assert.equal(resolveSignProductionWorkspaceUrl(null), null);
});

test("resolveSignProductionWorkspaceUrl: no SignPreparation for this project does not navigate", () => {
  assert.equal(
    resolveSignProductionWorkspaceUrl({
      project: { id: "abc" },
      signArtwork: null,
    }),
    null,
  );
});

test("resolveSignProductionWorkspaceUrl: not yet authorized does not navigate", () => {
  assert.equal(
    resolveSignProductionWorkspaceUrl({
      project: { id: "abc" },
      signArtwork: { authorization: { matchesCurrentPlan: false } },
    }),
    null,
  );
});

test("resolveSignProductionWorkspaceUrl: stale authorization bound to a superseded plan does not navigate", () => {
  // A re-plan changed planKey; the previously-recorded authorizedPlanKey no
  // longer matches — exactly what `matchesCurrentPlan: false` durably
  // encodes. Must never be treated as though the CURRENT plan were
  // authorized just because SOME authorization exists.
  assert.equal(
    resolveSignProductionWorkspaceUrl({
      project: { id: "re-planned-project" },
      signArtwork: { authorization: { matchesCurrentPlan: false } },
    }),
    null,
  );
});

test("resolveSignProductionWorkspaceUrl: fails closed on a missing/empty project id even if otherwise authorized", () => {
  assert.equal(
    resolveSignProductionWorkspaceUrl({
      project: { id: "" },
      signArtwork: { authorization: { matchesCurrentPlan: true } },
    }),
    null,
  );
});

test("resolveSignProductionWorkspaceUrl: never invents a URL for a blocked/never-authorized plan", () => {
  // A blocked plan can never durably reach matchesCurrentPlan: true in the
  // first place (isAuthorizationSufficientForRisk refuses it outright), but
  // this asserts the pure gate itself never shortcuts execution eligibility
  // from any other field on the snapshot.
  assert.equal(
    resolveSignProductionWorkspaceUrl({
      project: { id: "blocked-project" },
      signArtwork: { authorization: { matchesCurrentPlan: false } },
    }),
    null,
  );
});

// ---------------------------------------------------------------------
// Signs Workflow Dead Ends fix (Defect 2): `resolveSignReviewWorkspaceUrl`
// — the "Review required" screen's own continuation action. A plan an
// operator (never a customer) must authorize gets a real link to the
// EXISTING workspace where that governed action already lives; a plan
// with nothing to review, or one already authorized, gets none.
// ---------------------------------------------------------------------

test("resolveSignReviewWorkspaceUrl: navigates to the internal workspace for a review-required, not-yet-authorized plan", () => {
  assert.equal(
    resolveSignReviewWorkspaceUrl({
      project: { id: "0858d192-e74e-40b5-8532-a91bc4bcdf8e" },
      signArtwork: {
        plan: { reviewRequired: true },
        authorization: { matchesCurrentPlan: false },
      },
    }),
    "/internal/projects/0858d192-e74e-40b5-8532-a91bc4bcdf8e/sign-authorize",
  );
});

test("resolveSignReviewWorkspaceUrl: no snapshot at all does not navigate", () => {
  assert.equal(resolveSignReviewWorkspaceUrl(null), null);
});

test("resolveSignReviewWorkspaceUrl: no SignPreparation for this project does not navigate", () => {
  assert.equal(
    resolveSignReviewWorkspaceUrl({ project: { id: "abc" }, signArtwork: null }),
    null,
  );
});

test("resolveSignReviewWorkspaceUrl: no plan yet does not navigate", () => {
  assert.equal(
    resolveSignReviewWorkspaceUrl({
      project: { id: "abc" },
      signArtwork: { plan: null, authorization: { matchesCurrentPlan: false } },
    }),
    null,
  );
});

test("resolveSignReviewWorkspaceUrl: a ready (auto_safe) plan does not navigate — it has its own sufficient customer action", () => {
  assert.equal(
    resolveSignReviewWorkspaceUrl({
      project: { id: "abc" },
      signArtwork: {
        plan: { reviewRequired: false },
        authorization: { matchesCurrentPlan: false },
      },
    }),
    null,
  );
});

test("resolveSignReviewWorkspaceUrl: a review-required plan already authorized for THIS plan does not navigate — 'Continue to production' is the right action there", () => {
  assert.equal(
    resolveSignReviewWorkspaceUrl({
      project: { id: "abc" },
      signArtwork: {
        plan: { reviewRequired: true },
        authorization: { matchesCurrentPlan: true },
      },
    }),
    null,
  );
});

test("resolveSignReviewWorkspaceUrl: fails closed on a missing/empty project id even if otherwise eligible", () => {
  assert.equal(
    resolveSignReviewWorkspaceUrl({
      project: { id: "" },
      signArtwork: {
        plan: { reviewRequired: true },
        authorization: { matchesCurrentPlan: false },
      },
    }),
    null,
  );
});
