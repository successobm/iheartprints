import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

async function reachConfirmedSelectedConcept() {
  const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
    "@/capabilities/composition"
  );
  resetCapabilityGraphForTests();
  const conversationService = await import("./conversation-service");
  const {
    startConversation,
    handleUserMessage,
    submitDesignBriefDecision,
    selectConcept,
    confirmSelectedDirection,
  } = conversationService;

  const { projectId } = await runAdaptiveInterviewToSummary({
    start: startConversation,
    handleUserMessage,
  });
  await submitDesignBriefDecision(projectId, "approve");
  await getCapabilityGraph().generationWorker.processNextJob();

  const generated = await conversationService.getConversation(projectId);
  const [concept] = generated!.artworkVersions;
  await selectConcept(projectId, concept!.id);
  await confirmSelectedDirection(projectId, concept!.id);

  return {
    projectId,
    artworkVersionId: concept!.id,
    conversationService,
  };
}

/**
 * Existing Artwork → Print Ready Phase 2 (scenario AD): drives a project to
 * "approved prepared upload" through the REAL service layer, so the
 * interactive-dev trigger is exercised against a `prepared_upload` job rather
 * than a hand-built row.
 */
async function reachApprovedPreparedUpload() {
  const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
  resetCapabilityGraphForTests();

  const { solidBlackExteriorArtwork, toPngBytes } = await import(
    "@/capabilities/artwork-preparation/artwork-fixtures"
  );
  const conversationService = await import("./conversation-service");
  const preparationService = await import("./artwork-preparation-service");

  const started = await conversationService.startConversation();
  const projectId = started.project.id;

  await preparationService.uploadArtwork(projectId, {
    bytes: toPngBytes(solidBlackExteriorArtwork()),
    declaredContentType: "image/png",
    filename: "team-logo.png",
  });
  await preparationService.setUploadedArtworkContext(projectId, {
    productSummary: "T-shirts for our bowling team",
    productColor: "Black",
    printPlacement: "left_chest",
  });
  await preparationService.prepareUploadedArtwork(projectId);
  await preparationService.approvePreparedArtwork(projectId);

  return { projectId, preparationService };
}

describe("maybeTriggerLocalFinalArtworkWorker", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-local-fa-trigger-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("C: rejects in automated tests without starting a batch", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { maybeTriggerLocalFinalArtworkWorker } = await import(
      "./local-final-artwork-trigger"
    );

    const result = maybeTriggerLocalFinalArtworkWorker({
      projectId: "00000000-0000-0000-0000-000000000000",
      reason: "approve_final_direction",
    });

    assert.equal(result.attempted, true);
    assert.equal(result.accepted, false);
    assert.deepEqual(result.decision, {
      allowed: false,
      reason: "automated_test",
    });
    assert.equal(result.batchPromise, null);
    assert.equal(result.followUpPromise, null);
    assert.equal(
      getCapabilityGraph().finalArtworkScheduler.hasActiveBatch(),
      false,
    );
  });

  it("B: rejects production policy without invoking the scheduler", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { maybeTriggerLocalFinalArtworkWorker } = await import(
      "./local-final-artwork-trigger"
    );

    let runBatchCalls = 0;
    const graph = getCapabilityGraph();
    const original = graph.finalArtworkScheduler;
    graph.finalArtworkScheduler = {
      ...original,
      hasActiveBatch() {
        return false;
      },
      runBatch() {
        runBatchCalls += 1;
        return original.runBatch();
      },
    };

    const result = maybeTriggerLocalFinalArtworkWorker({
      projectId: "proj-prod",
      reason: "approve_final_direction",
      policy: { allowed: false, reason: "production" },
    });

    assert.equal(result.accepted, false);
    assert.equal(result.batchPromise, null);
    assert.equal(result.followUpPromise, null);
    assert.equal(runBatchCalls, 0);
  });

  it("A: after enqueue, interactive-dev policy claims the queued job without a manual worker POST", async () => {
    const {
      resetCapabilityGraphForTests,
      drainCapabilityGraphForTests,
    } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeTriggerLocalFinalArtworkWorker } = await import(
      "./local-final-artwork-trigger"
    );

    // approveFinalDirection would also kick under interactive-dev; force the
    // default automated-test suppression first, then trigger explicitly.
    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    assert.ok(approval);
    const queued = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval.id,
    );
    assert.ok(queued);
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempts, 0);

    const result = maybeTriggerLocalFinalArtworkWorker({
      projectId,
      reason: "approve_final_direction",
      policy: { allowed: true },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.accepted, true);
    assert.equal(result.batchAlreadyActive, false);
    assert.ok(result.batchPromise);
    assert.equal(result.followUpPromise, null);

    const batch = await result.batchPromise;
    assert.deepEqual(batch.processedJobIds, [queued.id]);

    const claimed = await repo.getFinalArtworkJob(queued.id);
    assert.ok(claimed);
    assert.ok(
      claimed.status === "completed" || claimed.status === "failed",
      `expected terminal job status, got ${claimed.status}`,
    );
    assert.ok(claimed.attempts >= 1);
    assert.equal(claimed.providerRequestId, null, "L: no Topaz in automated tests");

    await drainCapabilityGraphForTests();
  });

  it("K: joins an in-flight batch instead of starting a second claim loop", async () => {
    const {
      resetCapabilityGraphForTests,
      getCapabilityGraph,
      drainCapabilityGraphForTests,
    } = await import("@/capabilities/composition");
    const { createFinalArtworkSchedulerCapability } = await import(
      "@/capabilities/worker-scheduler"
    );
    resetCapabilityGraphForTests();

    let releaseProvider: (() => void) | undefined;
    let processNextJobCalls = 0;
    const slowWorker = {
      async processNextJob() {
        processNextJobCalls += 1;
        if (processNextJobCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseProvider = resolve;
          });
          return { processedJobId: "slow-fa-job" };
        }
        return { processedJobId: null };
      },
      async recoverAbandonedJobs() {
        return { recoveredCount: 0 };
      },
    };
    const scheduler = createFinalArtworkSchedulerCapability(slowWorker, {
      maxJobsPerRun: 5,
    });
    const graph = getCapabilityGraph();
    graph.finalArtworkScheduler = scheduler;

    const inFlight = scheduler.runBatch();
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    assert.equal(graph.finalArtworkScheduler.hasActiveBatch(), true);

    const { maybeTriggerLocalFinalArtworkWorker } = await import(
      "./local-final-artwork-trigger"
    );
    const result = maybeTriggerLocalFinalArtworkWorker({
      projectId: "proj-busy",
      reason: "approve_final_direction",
      policy: { allowed: true },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.batchAlreadyActive, true);
    assert.equal(result.batchPromise, inFlight);
    assert.ok(result.followUpPromise);

    releaseProvider?.();
    const batch = await result.batchPromise;
    assert.deepEqual(batch.processedJobIds, ["slow-fa-job"]);
    await result.followUpPromise;
    assert.ok(
      processNextJobCalls >= 3,
      "follow-up runBatch after an in-flight batch must tick again",
    );
    await drainCapabilityGraphForTests();
  });

  it("AD: the same interactive-dev trigger claims a prepared_upload finalization job", async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    const { projectId, preparationService } = await reachApprovedPreparedUpload();
    const { maybeTriggerLocalFinalArtworkWorker } = await import(
      "./local-final-artwork-trigger"
    );

    await preparationService.prepareUploadedArtworkForPrint(projectId);

    const repo = (await import("@/lib/db")).getProjectRepository();
    const preparation = await repo.getArtworkPreparation(projectId);
    assert.ok(preparation);
    const jobs = await repo.listFinalArtworkJobsForPreparation(
      projectId,
      preparation.id,
    );
    assert.equal(jobs.length, 1, "AD: exactly one finalization job");
    const queued = jobs[0]!;
    assert.equal(queued.sourceKind, "prepared_upload");
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempts, 0);
    // No second worker exists for uploaded artwork — the create_new authority
    // is genuinely absent here (Goal 1/17).
    assert.equal(await repo.getActiveFinalDirectionApproval(projectId), null);

    const result = maybeTriggerLocalFinalArtworkWorker({
      projectId,
      reason: "prepare_uploaded_artwork",
      policy: { allowed: true },
    });
    assert.equal(result.accepted, true);
    assert.ok(result.batchPromise);

    const batch = await result.batchPromise;
    assert.deepEqual(batch.processedJobIds, [queued.id]);

    const claimed = await repo.getFinalArtworkJob(queued.id);
    assert.ok(claimed);
    assert.ok(
      claimed.status === "completed" || claimed.status === "failed",
      `expected a terminal job status, got ${claimed.status}`,
    );
    assert.ok(claimed.attempts >= 1);
    // The automated-test provider is local by construction — never Topaz.
    assert.equal(claimed.providerRequestId, null, "no paid request in automated tests");

    await drainCapabilityGraphForTests();
  });

  it("AD: stranded recovery finds a prepared_upload job with no final-direction approval to look behind", async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    const { projectId, preparationService } = await reachApprovedPreparedUpload();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await preparationService.prepareUploadedArtworkForPrint(projectId);

    const repo = (await import("@/lib/db")).getProjectRepository();
    const preparation = await repo.getArtworkPreparation(projectId);
    const [queued] = await repo.listFinalArtworkJobsForPreparation(
      projectId,
      preparation!.id,
    );
    assert.equal(queued!.status, "queued");
    assert.equal(queued!.attempts, 0);

    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "project_reload",
      { allowed: true },
    );
    assert.ok(result, "the upload workflow must not be invisible to recovery");
    assert.equal(result.accepted, true);
    assert.ok(result.batchPromise);
    await result.batchPromise;

    const after = await repo.getFinalArtworkJob(queued!.id);
    assert.notEqual(after?.status, "queued");
    assert.ok((after?.attempts ?? 0) >= 1);

    // Recovery never creates a second job.
    const stillOne = await repo.listFinalArtworkJobsForPreparation(
      projectId,
      preparation!.id,
    );
    assert.equal(stillOne.length, 1);

    await drainCapabilityGraphForTests();
  });

  it("swallows scheduler construction failures instead of failing the customer request", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    graph.finalArtworkScheduler = {
      ...graph.finalArtworkScheduler,
      hasActiveBatch() {
        throw new Error("scheduler boom");
      },
    };

    const { maybeTriggerLocalFinalArtworkWorker } = await import(
      "./local-final-artwork-trigger"
    );
    const result = maybeTriggerLocalFinalArtworkWorker({
      projectId: "proj-boom",
      reason: "approve_final_direction",
      policy: { allowed: true },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.accepted, false);
    assert.equal(result.batchPromise, null);
    assert.equal(result.followUpPromise, null);
    resetCapabilityGraphForTests();
  });

  it("D/E/F: stranded recovery claims queued attempts=0 via status path without duplicating the job or pre-bumping attempts", async () => {
    const { resetCapabilityGraphForTests, drainCapabilityGraphForTests } =
      await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    assert.ok(approval);
    const queued = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval.id,
    );
    assert.ok(queued);
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempts, 0);

    const beforeAttempts = queued.attempts;
    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.ok(result);
    assert.equal(result.accepted, true);
    assert.ok(result.batchPromise);

    // Recovery itself must not mutate attempts — only the claim does.
    const mid = await repo.getFinalArtworkJob(queued.id);
    assert.ok(mid);
    if (mid.status === "queued") {
      assert.equal(mid.attempts, beforeAttempts);
    }

    await result.batchPromise;

    const after = await repo.getFinalArtworkJob(queued.id);
    assert.equal(after?.id, queued.id);
    assert.ok((after?.attempts ?? 0) >= 1);
    assert.notEqual(after?.status, "queued");

    const stillOne = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval.id,
    );
    assert.equal(stillOne?.id, queued.id);

    await drainCapabilityGraphForTests();
  });

  it("stranded recovery no-ops in automated tests even when a queued attempts=0 job exists", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "status_poll",
    );
    assert.equal(result, null);
    assert.equal(
      getCapabilityGraph().finalArtworkScheduler.hasActiveBatch(),
      false,
    );

    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    const job = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval!.id,
    );
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 0);
  });

  it("G: failed final-artwork job is not auto-requeued by stranded recovery", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    const job = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval!.id,
    );
    assert.ok(job);
    await repo.updateFinalArtworkJob(job.id, {
      status: "failed",
      attempts: 3,
      lastError: "exhausted",
      completedAt: new Date().toISOString(),
    });

    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.equal(result, null);
    assert.equal(
      getCapabilityGraph().finalArtworkScheduler.hasActiveBatch(),
      false,
    );
    const stillFailed = await repo.getFinalArtworkJob(job.id);
    assert.equal(stillFailed?.status, "failed");
    assert.equal(stillFailed?.attempts, 3);
  });

  it("H: cancelled job is not auto-requeued by stranded recovery", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    const job = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval!.id,
    );
    assert.ok(job);
    await repo.updateFinalArtworkJob(job.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      lastError: "operator cancelled",
    });

    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.equal(result, null);
    assert.equal(
      getCapabilityGraph().finalArtworkScheduler.hasActiveBatch(),
      false,
    );
    const stillCancelled = await repo.getFinalArtworkJob(job.id);
    assert.equal(stillCancelled?.status, "cancelled");
    assert.equal(stillCancelled?.attempts, 0);
  });

  it("I: completed job is not auto-requeued by stranded recovery", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    const job = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval!.id,
    );
    assert.ok(job);
    await repo.updateFinalArtworkJob(job.id, {
      status: "completed",
      attempts: 1,
      completedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "print_ready");

    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.equal(result, null);
    assert.equal(
      getCapabilityGraph().finalArtworkScheduler.hasActiveBatch(),
      false,
    );
    const stillCompleted = await repo.getFinalArtworkJob(job.id);
    assert.equal(stillCompleted?.status, "completed");
  });

  it("stranded recovery ignores running jobs and does not start a batch", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { projectId, artworkVersionId, conversationService } =
      await reachConfirmedSelectedConcept();
    const { maybeRecoverStrandedLocalFinalArtworkJobs } = await import(
      "./local-final-artwork-trigger"
    );

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    const job = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval!.id,
    );
    assert.ok(job);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateFinalArtworkJob(job.id, {
      status: "running",
      attempts: 1,
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });

    const result = await maybeRecoverStrandedLocalFinalArtworkJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.equal(result, null);
    assert.equal(
      getCapabilityGraph().finalArtworkScheduler.hasActiveBatch(),
      false,
    );
    const stillRunning = await repo.getFinalArtworkJob(job.id);
    assert.equal(stillRunning?.status, "running");
    assert.equal(stillRunning?.attempts, 1);
  });
});
