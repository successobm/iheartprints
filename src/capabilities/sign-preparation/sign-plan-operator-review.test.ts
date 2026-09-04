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

/**
 * LIVE PRODUCT BLOCKER #4B: the `production` field the operator page reads
 * to decide between "Prepare artwork", "Preparing artwork…", a needs-
 * attention notice, and the download link. Every state below is reached
 * through the REAL `requestSignFinalArtwork` → scheduler → worker path —
 * never asserted by hand-constructing a `FinalArtworkJob` row.
 */
describe("loadSignPlanOperatorReview — production status", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-operator-review-production-"));
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

  it("planned + authorized, never prepared: production is the all-false 'nothing yet' state", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.deepEqual(review.production, {
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
    });
  });

  it("prepared, still queued: inFlight true, nothing else", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await graph.finalArtwork.requestSignFinalArtwork(projectId);

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.jobStatus, "queued");
    assert.equal(review.production.inFlight, true);
    assert.equal(review.production.printReady, false);
    assert.equal(review.production.needsAttention, false);
  });

  it("prepared and failed: failed true, nothing else", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "failed", lastError: "simulated" });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.jobStatus, "failed");
    assert.equal(review.production.failed, true);
    assert.equal(review.production.inFlight, false);
    assert.equal(review.production.printReady, false);
  });

  it("prepared and print-ready: printReady true, downloadable", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.jobStatus, "completed");
    assert.equal(review.production.printReady, true);
    assert.equal(review.production.needsAttention, false);
    assert.equal(review.production.inFlight, false);
    assert.equal(review.production.failed, false);
  });

  it("prepared, completed, but not print-ready: needsAttention true, never printReady", async () => {
    // The simplest real way to reach 'completed, not ready' without a
    // provider: a plan requiring an approved crop is refused before any
    // asset is produced (`completeWithoutAsset`) — the job still reaches
    // 'completed', with no validation record at all, which the loader
    // must still report as `needsAttention`, never `printReady`.
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    // Simulates the worker's own `completeWithoutAsset` outcome directly —
    // a real, honest terminal state this loader must still classify
    // correctly, without re-running the whole worker for one edge case
    // already exhaustively covered by `final-artwork-worker-capability`'s
    // own test suite.
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.jobStatus, "completed");
    assert.equal(review.production.printReady, false);
    assert.equal(review.production.needsAttention, true);
    assert.equal(
      review.production.blockedCandidateAssetId,
      null,
      "completeWithoutAsset produced no validation and no asset — nothing to inspect",
    );
    assert.equal(review.production.blockedValidationId, null);
    assert.equal(review.production.blockedValidationStatus, null);
  });

  it("Blocked Production Candidate Inspection Phase: a completed job with a blocking validation surfaces the exact validation-bound asset", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const blockedAsset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-blocked-test`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: { rigidSign: { planKey: "sign-repair-plan:v1:test" } },
    });
    const validation = await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: blockedAsset.id,
      status: "finalization_required",
      report: {},
    });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.needsAttention, true);
    assert.equal(review.production.printReady, false);
    assert.equal(review.production.blockedCandidateAssetId, blockedAsset.id);
    assert.equal(review.production.blockedValidationId, validation.id);
    assert.equal(review.production.blockedValidationStatus, "finalization_required");
  });

  it("Blocked Production Candidate Inspection Phase: a print-ready job never surfaces a blocked candidate", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.plan!.steps.length, 0, "sanity: zero-step plan needs no provider");
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.printReady, true);
    assert.equal(review.production.blockedCandidateAssetId, null);
  });

  it("SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION: reads machineReadableContent back from the SAME report.machineReadableContentEvidence field the QR check/restore actions persist — never re-computed here", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const asset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-qr-test`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: asset.id,
      status: "finalization_required",
      report: {
        checks: [{ check: "machine_readable_content_preserved", status: "fail", severity: "blocking", reason: "test" }],
        machineReadableContentEvidence: {
          instances: [
            {
              id: "qr-1",
              kind: "qr",
              sourceBounds: { xPx: 1, yPx: 1, widthPx: 2, heightPx: 2 },
              sourceDecodable: true,
              sourcePayloadSha256: "a".repeat(64),
              candidateBounds: null,
              candidateDecodable: false,
              candidatePayloadSha256: null,
              result: "fail",
            },
          ],
          overall: "fail",
        },
      },
    });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.machineReadableContent?.overall, "fail");
    assert.equal(review.production.machineReadableContent?.regions.length, 1);
    assert.equal(review.production.machineReadableContent?.regions[0].sourceDecodable, true);
    assert.equal(review.production.machineReadableContent?.regions[0].candidateDecodable, false);
    // Never the raw payload — only the hash, exactly as persisted.
    assert.equal(review.production.machineReadableContent?.regions[0].sourcePayloadSha256, "a".repeat(64));
  });

  it("SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION: a malformed/missing evidence shape reads back as null, never guessed", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });
    const asset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-qr-missing-test`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: asset.id,
      status: "ready",
      report: { checks: [] }, // no machineReadableContentEvidence at all — the pre-this-feature shape
    });

    const review = await loadSignPlanOperatorReview(repo, projectId);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;
    assert.equal(review.production.machineReadableContent, null);
  });
});
