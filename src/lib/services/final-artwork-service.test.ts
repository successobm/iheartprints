import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2M Phase 2B: end-to-end coverage of the customer-facing final
 * direction approval flow through `conversation-service` — the same layer
 * the API routes and UI actually call. Capability-level idempotency/
 * validation edge cases live in
 * `capabilities/final-artwork/final-artwork-capability.test.ts`; this file
 * is scoped to what a customer/API caller can observe.
 */
describe("conversation-service — final direction approval (Sprint 2M Phase 2B)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-final-artwork-service-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function reachSelectedConcept() {
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
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default here.
    await confirmSelectedDirection(projectId, concept!.id);

    return { projectId, artworkVersionId: concept!.id, conversationService };
  }

  it("selecting a concept never requests finalization on its own", async () => {
    const { projectId, conversationService } = await reachSelectedConcept();
    const snapshot = await conversationService.getConversation(projectId);
    assert.equal(snapshot?.finalization.status, "not_requested");
  });

  it("approveFinalDirection transitions customer-safe finalization status to 'preparing', never 'print_ready'", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await reachSelectedConcept();

    const result = await conversationService.approveFinalDirection(
      projectId,
      artworkVersionId,
    );

    assert.equal(result.finalization.status, "preparing");
    assert.notEqual(result.finalization.status, "print_ready");

    const reloaded = await conversationService.getConversation(projectId);
    assert.equal(reloaded?.finalization.status, "preparing");
  });

  it("repeated approveFinalDirection calls are safe and do not post duplicate messages", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await reachSelectedConcept();

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const before = await conversationService.getConversation(projectId);
    const beforeCount = before!.messages.length;

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const after = await conversationService.getConversation(projectId);

    assert.equal(after!.messages.length, beforeCount);
    assert.equal(after!.finalization.status, "preparing");
  });

  it("customer snapshot never exposes final-artwork job/approval ids or asset details", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await reachSelectedConcept();

    const result = await conversationService.approveFinalDirection(
      projectId,
      artworkVersionId,
    );

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("finalDirectionApprovalId"), false);
    assert.equal(serialized.includes("finalArtworkJobId"), false);
    assert.equal(serialized.includes("storageKey"), false);
    // The finalization view carries only a customer-safe status string.
    assert.deepEqual(Object.keys(result.finalization), ["status"]);
  });

  it("F: getConversation reconstructs persisted print_ready after a hard reload", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await reachSelectedConcept();

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    assert.equal(
      (await conversationService.getConversation(projectId))?.finalization.status,
      "preparing",
    );

    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "print_ready");

    const reloaded = await conversationService.getConversation(projectId);
    assert.equal(reloaded?.finalization.status, "print_ready");
    assert.deepEqual(Object.keys(reloaded!.finalization), ["status"]);
  });

  it("rejects approving a project's concept from another project's request", async () => {
    const { artworkVersionId } = await reachSelectedConcept();
    const { projectId: otherProjectId } = await reachSelectedConcept();
    const conversationService = await import("./conversation-service");

    await assert.rejects(() =>
      conversationService.approveFinalDirection(otherProjectId, artworkVersionId),
    );
  });
});
