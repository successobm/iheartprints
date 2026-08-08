import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

describe("GET /api/projects/[projectId]/generation/status (Sprint 2H Part 2A)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-genstatus-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("returns 404 for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/projects/ghost/generation/status"), {
      params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000000" }),
    });

    assert.equal(response.status, 404);
  });

  it("returns only { status } — never a job id, provider name, or queue detail", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision } = await import(
      "@/lib/services/conversation-service"
    );

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/projects/${projectId}/generation/status`),
      { params: Promise.resolve({ projectId }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["status"]);
    assert.equal(body.status, "generating");

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 0);

    await getCapabilityGraph().generationWorker.processNextJob();

    const secondResponse = await GET(
      new Request(`http://localhost/api/projects/${projectId}/generation/status`),
      { params: Promise.resolve({ projectId }) },
    );
    const secondBody = await secondResponse.json();
    assert.equal(secondBody.status, "ready");
  });
});
