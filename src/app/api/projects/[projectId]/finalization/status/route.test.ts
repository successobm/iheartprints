import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

describe("GET /api/projects/[projectId]/finalization/status", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-finalization-status-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function projectWithSelectedConcept() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
      selectConcept,
      confirmSelectedDirection,
    } = await import("@/lib/services/conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");
    await getCapabilityGraph().generationWorker.processNextJob();

    const conversationService = await import("@/lib/services/conversation-service");
    const generated = await conversationService.getConversation(projectId);
    const [concept] = generated!.artworkVersions;
    await selectConcept(projectId, concept!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default here.
    await confirmSelectedDirection(projectId, concept!.id);

    return { projectId, artworkVersionId: concept!.id };
  }

  it("returns 404 for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/projects/ghost/finalization/status"),
      { params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000000" }) },
    );

    assert.equal(response.status, 404);
  });

  it("G: returns only { status } — never a job id, provider name, or storage detail", async () => {
    const { projectId, artworkVersionId } = await projectWithSelectedConcept();
    const { approveFinalDirection } = await import("@/lib/services/conversation-service");
    await approveFinalDirection(projectId, artworkVersionId);

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/projects/${projectId}/finalization/status`),
      { params: Promise.resolve({ projectId }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["status"]);
    assert.equal(body.status, "preparing");

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("finalDirectionApprovalId"), false);
    assert.equal(serialized.includes("finalArtworkJobId"), false);
    assert.equal(serialized.includes("storageKey"), false);
    assert.equal(serialized.includes("topaz"), false);
    assert.equal(serialized.includes("provider"), false);
  });

  it("B/F: print_ready after persisted project status updates the poll response", async () => {
    const { projectId, artworkVersionId } = await projectWithSelectedConcept();
    const { approveFinalDirection, getConversation } = await import(
      "@/lib/services/conversation-service"
    );
    await approveFinalDirection(projectId, artworkVersionId);

    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "print_ready");

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/projects/${projectId}/finalization/status`),
      { params: Promise.resolve({ projectId }) },
    );
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["status"]);
    assert.equal(body.status, "print_ready");

    const snapshot = await getConversation(projectId);
    assert.equal(snapshot?.finalization.status, "print_ready");
  });

  it("C: needs_review after persisted finalization_required updates the poll response", async () => {
    const { projectId, artworkVersionId } = await projectWithSelectedConcept();
    const { approveFinalDirection } = await import("@/lib/services/conversation-service");
    await approveFinalDirection(projectId, artworkVersionId);

    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "finalization_required");

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/projects/${projectId}/finalization/status`),
      { params: Promise.resolve({ projectId }) },
    );
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["status"]);
    assert.equal(body.status, "needs_review");
  });
});
