import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2H Part 2A/2B: polling status facade.
 * `submitDesignBriefDecision`/`regenerateConcepts` themselves are already
 * covered elsewhere (design-brief-decision.test.ts,
 * conversation-revision.test.ts) — this file is scoped to
 * `getGenerationStatus`, which Sprint 2H Part 2B made strictly read-only:
 * it no longer dispatches a worker (removed along with
 * `triggerGenerationWorker`) and no longer recovers abandoned jobs as a
 * side effect of being polled — see `capabilities/worker-scheduler/` for
 * where that responsibility now lives.
 */
describe("conversation-service — generation status polling (Sprint 2H Part 2A)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-genstatus-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("returns null for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getGenerationStatus } = await import("./conversation-service");
    assert.equal(await getGenerationStatus("00000000-0000-0000-0000-000000000000"), null);
  });

  it("reports 'idle' before any generation has been requested", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { startConversation, getGenerationStatus } = await import("./conversation-service");

    const created = await startConversation();
    assert.deepEqual(await getGenerationStatus(created.project.id), { status: "idle" });
  });

  it("reports 'generating' immediately after approval, then 'ready' once the worker completes — never blocking on the provider itself", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
      getGenerationStatus,
    } = await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });

    const enqueued = await submitDesignBriefDecision(projectId, "approve");
    assert.equal(enqueued.conversation.phase, "generating");
    assert.deepEqual(await getGenerationStatus(projectId), { status: "generating" });
    assert.equal(
      getCapabilityGraph().workerScheduler.hasActiveBatch(),
      false,
      "automated tests must not auto-trigger the local worker after enqueue",
    );

    await getCapabilityGraph().generationWorker.processNextJob();
    assert.deepEqual(await getGenerationStatus(projectId), { status: "ready" });
  });

  it("no longer exports triggerGenerationWorker or drainGenerationWorkersForTests — generation is never dispatched from this module", async () => {
    const conversationService = await import("./conversation-service");
    assert.equal("triggerGenerationWorker" in conversationService, false);
    assert.equal("drainGenerationWorkersForTests" in conversationService, false);
  });

  it("automated-test polling never starts a local batch for a queued attempts=0 job", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getGenerationStatus } =
      await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    await getGenerationStatus(projectId);
    await getGenerationStatus(projectId);

    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 0);
  });

  it("polling never recovers an abandoned running job — that stays 'generating', unresolved, until the independent worker runs", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getGenerationStatus } =
      await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(job.id, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });

    // Polling repeatedly must never flip the stale job to "recoverable" —
    // recovery is exclusively the independent worker's job now.
    await getGenerationStatus(projectId);
    await getGenerationStatus(projectId);
    await getGenerationStatus(projectId);

    const stillRunning = await repo.getGenerationJob(job.id);
    assert.equal(stillRunning?.status, "running");
    assert.deepEqual(await getGenerationStatus(projectId), { status: "generating" });

    // Only once the independent worker actually runs does the job resolve.
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    await getCapabilityGraph().workerScheduler.runBatch();
    assert.deepEqual(await getGenerationStatus(projectId), { status: "ready" });
  });
});

describe("conversation-service — finalization status polling", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-finalization-status-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function projectWithSelectedConcept() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const conversationService = await import("./conversation-service");
    const { startConversation, handleUserMessage, submitDesignBriefDecision, selectConcept } =
      conversationService;

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");
    await getCapabilityGraph().generationWorker.processNextJob();

    const generated = await conversationService.getConversation(projectId);
    const [concept] = generated!.artworkVersions;
    await selectConcept(projectId, concept!.id);

    return { projectId, artworkVersionId: concept!.id, conversationService };
  }

  it("returns null for a project that does not exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getFinalizationStatus } = await import("./conversation-service");
    assert.equal(
      await getFinalizationStatus("00000000-0000-0000-0000-000000000000"),
      null,
    );
  });

  it("reports not_requested before finalization is requested", async () => {
    const { projectId, conversationService } = await projectWithSelectedConcept();
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "not_requested",
    });
  });

  it("reports preparing after approveFinalDirection, then print_ready once persisted", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });

    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "print_ready");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "print_ready",
    });
    const snapshot = await conversationService.getConversation(projectId);
    assert.equal(snapshot?.finalization.status, "print_ready");
  });

  it("reports needs_review once PrintProject.status is finalization_required", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "finalization_required");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "needs_review",
    });
  });

  it("E: repeated polls never enqueue a second FinalArtworkJob or revive work", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    assert.ok(approval);
    const job = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
    assert.ok(job);
    assert.equal(job.status, "queued");

    await conversationService.getFinalizationStatus(projectId);
    await conversationService.getFinalizationStatus(projectId);
    await conversationService.getFinalizationStatus(projectId);

    const stillQueued = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
    assert.equal(stillQueued?.id, job.id);
    assert.equal(stillQueued?.status, "queued");
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("G: customer-safe status view never includes job/provider/storage internals", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const view = await conversationService.getFinalizationStatus(projectId);
    assert.deepEqual(Object.keys(view ?? {}), ["status"]);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("finalArtworkJobId"), false);
    assert.equal(serialized.includes("storageKey"), false);
    assert.equal(serialized.includes("topaz"), false);
    assert.equal(serialized.includes("provider"), false);
  });
});
