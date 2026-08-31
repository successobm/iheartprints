import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { exactAspectSignArtwork, ruthLikeSignArtwork, toPngBytes } from "./sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { loadSignPlanOperatorReview } from "./sign-plan-operator-review";

/**
 * LIVE PRODUCT BLOCKER #4A: proves the operator-review loader reads the
 * SAME durable `SignPreparation` row every other layer reads — never
 * diagnoses, never plans, never mutates — and correctly reconstructs every
 * state an internal operator's review page must distinguish. Local
 * persistence only; never the configured live project.
 */
describe("loadSignPlanOperatorReview", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-operator-review-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  it("no such project: not_found", async () => {
    const { repo } = await freshGraph();
    const review = await loadSignPlanOperatorReview(repo, "00000000-0000-0000-0000-000000000000");
    assert.deepEqual(review, { status: "not_found" });
  });

  it("real project, no sign artwork uploaded: no_preparation", async () => {
    const { repo } = await freshGraph();
    const created = await repo.createProject();
    const review = await loadSignPlanOperatorReview(repo, created.project.id);
    assert.deepEqual(review, { status: "no_preparation" });
  });

  it("uploaded and spec-confirmed, but never planned: no_plan", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.deepEqual(review, { status: "no_plan" });
  });

  it("planned, review_required (Ruth-shaped, the real customer's exact scenario): full review payload, no authorization yet", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await graph.signPreparation.planSignRepair(projectId);

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;

    assert.equal(review.orderedWidthIn, 18);
    assert.equal(review.orderedHeightIn, 24);
    assert.ok(review.originalAssetId.length > 0);
    assert.match(review.plan.riskLabel, /review/i);
    assert.equal(review.plan.artworkWidthPx, 1024);
    assert.equal(review.plan.artworkHeightPx, 1536);
    assert.ok(review.plan.steps.some((step) => step.needsReview));
    assert.equal(review.authorization.authorizedBy, null);
    assert.equal(review.authorization.authorizedAt, null);
    assert.equal(review.authorization.matchesCurrentPlan, false);
  });

  it("planned, auto_safe: ready, ordinary translated plan, no review-flagged steps", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.match(review.plan.riskLabel, /no production review needed/i);
    assert.ok(review.plan.steps.every((step) => !step.needsReview));
  });

  it("after operator authorization: authorization state reflects the durable record and matches the current plan", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.authorization.authorizedBy, "operator");
    assert.ok(review.authorization.authorizedAt);
    assert.equal(review.authorization.matchesCurrentPlan, true);
  });

  it("stale authorization: replanning under a changed ordered size leaves matchesCurrentPlan false without erasing the old record", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const before1 = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(before1.status, "ready");
    if (before1.status === "ready") assert.equal(before1.authorization.matchesCurrentPlan, true);

    // A genuinely different ordered size — same aspect, different physical
    // size — produces a different plan (different expected output geometry)
    // and therefore a different planKey, without ever re-authorizing.
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await graph.signPreparation.planSignRepair(projectId);

    const after1 = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(after1.status, "ready");
    if (after1.status !== "ready") return;
    assert.equal(after1.authorization.matchesCurrentPlan, false);
    // The stale record itself is still shown, not silently erased — the UI
    // decides what to say about it, this loader just reports it honestly.
    assert.equal(after1.authorization.authorizedBy, "operator");
  });

  it("is read-only and idempotent: calling it twice in a row returns identical results", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const first = await loadSignPlanOperatorReview(repo, projectId);
    const second = await loadSignPlanOperatorReview(repo, projectId);
    assert.deepEqual(first, second);
  });
});
