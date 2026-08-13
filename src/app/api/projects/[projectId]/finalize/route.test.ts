import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

function postFinalize(projectId: string, body: unknown) {
  return import("./route").then(({ POST }) =>
    POST(
      new Request(`http://localhost/api/projects/${projectId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) },
    ),
  );
}

describe("POST /api/projects/[projectId]/finalize (Sprint 2M Phase 2B)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-finalize-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("returns 400 for a malformed body", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const response = await postFinalize("00000000-0000-0000-0000-000000000000", {
      artworkVersionId: "not-a-uuid",
    });
    assert.equal(response.status, 400);
  });

  it("returns 404 for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const response = await postFinalize("00000000-0000-0000-0000-000000000000", {
      artworkVersionId: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(response.status, 404);
  });

  it("approves the selected concept and returns a customer-safe snapshot", async () => {
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
    // never final approval — confirm explicitly first.
    await confirmSelectedDirection(projectId, concept!.id);

    const response = await postFinalize(projectId, { artworkVersionId: concept!.id });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.finalization.status, "preparing");
    assert.equal("finalDirectionApprovalId" in body, false);
  });

  it("returns 409 when the concept is not currently selected", async () => {
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
    await getCapabilityGraph().generationWorker.processNextJob();

    const conversationService = await import("@/lib/services/conversation-service");
    const generated = await conversationService.getConversation(projectId);
    const [concept] = generated!.artworkVersions;

    // Never selected — the finalize route must reject it, not silently
    // approve "whatever concept was named".
    const response = await postFinalize(projectId, { artworkVersionId: concept!.id });
    assert.equal(response.status, 409);
  });
});
