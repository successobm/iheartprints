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

    await getCapabilityGraph().generationWorker.processNextJob();
    assert.deepEqual(await getGenerationStatus(projectId), { status: "ready" });
  });

  it("no longer exports triggerGenerationWorker or drainGenerationWorkersForTests — generation is never dispatched from this module", async () => {
    const conversationService = await import("./conversation-service");
    assert.equal("triggerGenerationWorker" in conversationService, false);
    assert.equal("drainGenerationWorkersForTests" in conversationService, false);
  });

  it("polling never recovers an abandoned job — that stays 'generating', unresolved, until the independent worker runs", async () => {
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
