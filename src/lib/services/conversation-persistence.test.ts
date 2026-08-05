import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

describe("Sprint 1/2F conversation persistence", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-persist-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(previousCwd);
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    await removeTempDir(tempDir);
  });

  it("restores the same project and adaptive interview state instead of resetting", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();

    const { startConversation, getConversation, handleUserMessage } =
      await import("./conversation-service");

    const created = await startConversation();
    const projectId = created.project.id;
    assert.equal(created.conversation.phase, "interviewing");
    assert.equal(created.conversation.interviewState.pendingSection, "product");

    const afterReply = await handleUserMessage(
      projectId,
      "A T-shirt for the school fair",
    );
    assert.equal(afterReply.conversation.phase, "interviewing");
    assert.equal(afterReply.messages.length, created.messages.length + 2);
    assert.equal(afterReply.brief.productSummary, "A T-shirt for the school fair");

    const restored = await getConversation(projectId);
    assert.ok(restored);
    assert.equal(restored.project.id, projectId);
    assert.equal(restored.conversation.phase, "interviewing");
    assert.equal(restored.brief.productSummary, "A T-shirt for the school fair");
    assert.equal(restored.messages.length, afterReply.messages.length);
    assert.equal(restored.messages[0]?.content, "What are we printing today?");
    assert.equal(
      restored.conversation.interviewState.pendingSection,
      afterReply.conversation.interviewState.pendingSection,
    );

    const restoredAgain = await getConversation(projectId);
    assert.equal(restoredAgain?.project.id, projectId);
    assert.equal(restoredAgain?.messages.length, afterReply.messages.length);
  });

  it("restores awaiting summary confirmation without fabricating approvals or concepts", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();

    const { startConversation, getConversation, handleUserMessage } =
      await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });

    const restored = await getConversation(projectId);
    assert.ok(restored);
    assert.equal(restored.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(restored.artworkVersions.length, 0);
    assert.equal(restored.designBriefVersions.length, 0);
    assert.equal(
      restored.messages.at(-1)?.metadata.phase,
      "awaiting_summary_confirmation",
    );
    // The summary gate clears the pending section — nothing left dangling.
    assert.equal(restored.conversation.interviewState.pendingSection, null);
  });
});
