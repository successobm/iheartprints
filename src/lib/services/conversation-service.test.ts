import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2H Part 2A: polling status facade + fire-and-forget worker
 * dispatch. `submitDesignBriefDecision`/`regenerateConcepts` themselves are
 * already covered elsewhere (design-brief-decision.test.ts,
 * conversation-revision.test.ts) — this file is scoped to the new
 * `getGenerationStatus`/`triggerGenerationWorker` additions.
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

  it("triggerGenerationWorker is fire-and-forget and safe to call with nothing queued", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { triggerGenerationWorker } = await import("./conversation-service");
    // Must not throw and must not require awaiting.
    triggerGenerationWorker();
  });

  it("triggerGenerationWorker actually advances a queued job without the caller awaiting completion", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getGenerationStatus } =
      await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    // `triggerGenerationWorker` is deliberately fire-and-forget — the
    // caller (an API route, in production) never awaits it. Since the
    // underlying claim is exclusive, there's no reliable second call this
    // test could make to force completion without racing the dispatched
    // one; poll the same way a real client would instead.
    const { triggerGenerationWorker } = await import("./conversation-service");
    triggerGenerationWorker();

    const deadline = Date.now() + 2000;
    let status = await getGenerationStatus(projectId);
    while (status?.status === "generating" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await getGenerationStatus(projectId);
    }

    assert.deepEqual(status, { status: "ready" });
  });

  it("recovers an abandoned job's status on poll without a caller having to know jobs exist", async () => {
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

    const graph = getCapabilityGraph();
    const jobs = await (
      await import("@/lib/db")
    ).getProjectRepository().listGenerationJobs(projectId);
    const [job] = jobs;
    assert.ok(job);

    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const repo = (await import("@/lib/db")).getProjectRepository();
    await repo.updateGenerationJob(job.id, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });

    // Polling alone (no explicit recovery call from the caller) flags the
    // job recoverable — status stays "generating" until it's actually
    // reprocessed, but it's no longer silently stuck as "running" forever.
    await getGenerationStatus(projectId);
    const afterPoll = await repo.getGenerationJob(job.id);
    assert.equal(afterPoll?.status, "recoverable");

    await graph.generationWorker.processNextJob();
    assert.deepEqual(await getGenerationStatus(projectId), { status: "ready" });
  });
});
