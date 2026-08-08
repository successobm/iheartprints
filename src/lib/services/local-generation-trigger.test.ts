import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

describe("maybeTriggerLocalGenerationWorker", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-local-trigger-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("rejects in automated tests without starting a batch", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { maybeTriggerLocalGenerationWorker } = await import(
      "./local-generation-trigger"
    );

    const result = maybeTriggerLocalGenerationWorker({
      projectId: "00000000-0000-0000-0000-000000000000",
      reason: "approve_brief",
    });

    assert.equal(result.attempted, true);
    assert.equal(result.accepted, false);
    assert.deepEqual(result.decision, {
      allowed: false,
      reason: "automated_test",
    });
    assert.equal(result.batchPromise, null);
    assert.equal(result.followUpPromise, null);
    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);
  });

  it("rejects production policy without invoking the scheduler", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { maybeTriggerLocalGenerationWorker } = await import(
      "./local-generation-trigger"
    );

    let processNextJobCalls = 0;
    const graph = getCapabilityGraph();
    const original = graph.workerScheduler;
    graph.workerScheduler = {
      ...original,
      hasActiveBatch() {
        return false;
      },
      runBatch() {
        processNextJobCalls += 1;
        return original.runBatch();
      },
    };

    const result = maybeTriggerLocalGenerationWorker({
      projectId: "proj-prod",
      reason: "approve_brief",
      policy: { allowed: false, reason: "production" },
    });

    assert.equal(result.accepted, false);
    assert.equal(result.batchPromise, null);
    assert.equal(result.followUpPromise, null);
    assert.equal(processNextJobCalls, 0);
  });

  it("after enqueue, interactive-dev policy moves the job queued → running without a manual worker POST", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph, drainCapabilityGraphForTests } =
      await import("@/capabilities/composition");
    const { createGenerationSchedulerCapability } = await import(
      "@/capabilities/worker-scheduler"
    );
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
    } = await import("./conversation-service");
    const { maybeTriggerLocalGenerationWorker } = await import(
      "./local-generation-trigger"
    );

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [queued] = await repo.listGenerationJobs(projectId);
    assert.ok(queued);
    assert.equal(queued.status, "queued");

    let releaseClaim: (() => void) | undefined;
    const graph = getCapabilityGraph();
    const slowWorker = {
      async processNextJob() {
        const job = await repo.claimNextQueuedJob();
        if (!job) return { processedJobId: null };
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
        return { processedJobId: job.id };
      },
      async recoverAbandonedJobs() {
        return { recoveredCount: 0 };
      },
    };
    graph.workerScheduler = createGenerationSchedulerCapability(slowWorker, {
      maxJobsPerRun: 5,
    });

    const result = maybeTriggerLocalGenerationWorker({
      projectId,
      reason: "approve_brief",
      policy: { allowed: true },
    });
    assert.equal(result.accepted, true);
    assert.ok(result.batchPromise);

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const current = await repo.getGenerationJob(queued.id);
      if (current?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const running = await repo.getGenerationJob(queued.id);
    assert.equal(running?.status, "running");
    assert.ok((running?.attempts ?? 0) >= 1);

    releaseClaim?.();
    const batch = await result.batchPromise;
    assert.deepEqual(batch.processedJobIds, [queued.id]);
    await drainCapabilityGraphForTests();
  });

  it("after enqueue, interactive-dev policy claims the queued job without a manual worker POST", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph, drainCapabilityGraphForTests } =
      await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
    } = await import("./conversation-service");
    const { maybeTriggerLocalGenerationWorker } = await import(
      "./local-generation-trigger"
    );

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [queued] = await repo.listGenerationJobs(projectId);
    assert.ok(queued);
    assert.equal(queued.status, "queued");

    const result = maybeTriggerLocalGenerationWorker({
      projectId,
      reason: "approve_brief",
      policy: { allowed: true },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.accepted, true);
    assert.equal(result.batchAlreadyActive, false);
    assert.ok(result.batchPromise);
    assert.equal(result.followUpPromise, null);

    const batch = await result.batchPromise;
    assert.deepEqual(batch.processedJobIds, [queued.id]);

    const claimed = await repo.getGenerationJob(queued.id);
    assert.ok(claimed);
    assert.equal(claimed.status, "completed");
    assert.ok(claimed.attempts >= 1);

    const snapshot = await getCapabilityGraph().conversation.get(projectId);
    assert.equal(snapshot?.project.status, "concepts_ready");

    await drainCapabilityGraphForTests();
  });

  it("joins an in-flight batch instead of starting a second claim loop", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph, drainCapabilityGraphForTests } =
      await import("@/capabilities/composition");
    const { createGenerationSchedulerCapability } = await import(
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
          return { processedJobId: "slow-job" };
        }
        return { processedJobId: null };
      },
      async recoverAbandonedJobs() {
        return { recoveredCount: 0 };
      },
    };
    const scheduler = createGenerationSchedulerCapability(slowWorker, {
      maxJobsPerRun: 5,
    });
    const graph = getCapabilityGraph();
    (graph as { workerScheduler: typeof scheduler }).workerScheduler = scheduler;

    const inFlight = scheduler.runBatch();
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    assert.equal(graph.workerScheduler.hasActiveBatch(), true);

    const { maybeTriggerLocalGenerationWorker } = await import(
      "./local-generation-trigger"
    );
    const result = maybeTriggerLocalGenerationWorker({
      projectId: "proj-busy",
      reason: "approve_brief",
      policy: { allowed: true },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.batchAlreadyActive, true);
    assert.equal(result.batchPromise, inFlight);
    assert.ok(result.followUpPromise);

    releaseProvider?.();
    const batch = await result.batchPromise;
    assert.deepEqual(batch.processedJobIds, ["slow-job"]);
    await result.followUpPromise;
    assert.ok(
      processNextJobCalls >= 3,
      "follow-up runBatch after an in-flight batch must tick again so a newly queued job can be claimed",
    );
    await drainCapabilityGraphForTests();
  });

  it("swallows scheduler construction failures instead of failing the customer request", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    graph.workerScheduler = {
      ...graph.workerScheduler,
      hasActiveBatch() {
        throw new Error("scheduler boom");
      },
    };

    const { maybeTriggerLocalGenerationWorker } = await import(
      "./local-generation-trigger"
    );
    const result = maybeTriggerLocalGenerationWorker({
      projectId: "proj-boom",
      reason: "regenerate_concepts",
      policy: { allowed: true },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.accepted, false);
    assert.equal(result.batchPromise, null);
    assert.equal(result.followUpPromise, null);
    resetCapabilityGraphForTests();
  });

  it("stranded recovery no-ops in automated tests even when a queued attempts=0 job exists", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
    } = await import("./conversation-service");
    const { maybeRecoverStrandedLocalGenerationJobs } = await import(
      "./local-generation-trigger"
    );

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const result = await maybeRecoverStrandedLocalGenerationJobs(
      projectId,
      "status_poll",
    );
    assert.equal(result, null);
    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 0);
  });

  it("stranded recovery claims a queued attempts=0 job under interactive-dev policy", async () => {
    const { resetCapabilityGraphForTests, drainCapabilityGraphForTests } =
      await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
    } = await import("./conversation-service");
    const { maybeRecoverStrandedLocalGenerationJobs } = await import(
      "./local-generation-trigger"
    );

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [queued] = await repo.listGenerationJobs(projectId);
    assert.ok(queued);
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempts, 0);

    const result = await maybeRecoverStrandedLocalGenerationJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.ok(result);
    assert.equal(result.accepted, true);
    assert.ok(result.batchPromise);
    await result.batchPromise;

    const claimed = await repo.getGenerationJob(queued.id);
    assert.equal(claimed?.status, "completed");
    assert.ok((claimed?.attempts ?? 0) >= 1);
    await drainCapabilityGraphForTests();
  });

  it("stranded recovery ignores running jobs and does not start a batch", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
    } = await import("./conversation-service");
    const { maybeRecoverStrandedLocalGenerationJobs } = await import(
      "./local-generation-trigger"
    );

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

    const result = await maybeRecoverStrandedLocalGenerationJobs(
      projectId,
      "status_poll",
      { allowed: true },
    );
    assert.equal(result, null);
    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);
    const stillRunning = await repo.getGenerationJob(job.id);
    assert.equal(stillRunning?.status, "running");
  });
});
