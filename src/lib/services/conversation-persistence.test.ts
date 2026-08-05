import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";

describe("Sprint 1 conversation persistence", () => {
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

  it("restores the same project and opening message instead of resetting", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();

    const { startConversation, getConversation, handleUserMessage } =
      await import("./conversation-service");

    const created = await startConversation();
    const projectId = created.project.id;

    const afterReply = await handleUserMessage(
      projectId,
      "A T-shirt for the school fair",
    );
    assert.equal(afterReply.conversation.phase, "ask_design");
    assert.equal(afterReply.messages.length, created.messages.length + 2);

    const restored = await getConversation(projectId);
    assert.ok(restored);
    assert.equal(restored.project.id, projectId);
    assert.equal(restored.conversation.phase, "ask_design");
    assert.equal(restored.brief.productSummary, "A T-shirt for the school fair");
    assert.equal(restored.messages.length, afterReply.messages.length);
    assert.equal(restored.messages[0]?.content, "What are we printing today?");

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

    const created = await startConversation();
    const projectId = created.project.id;

    await handleUserMessage(projectId, "Camp shirts");
    await handleUserMessage(projectId, "A friendly bear logo");
    await handleUserMessage(projectId, "Navy");
    await handleUserMessage(projectId, "Camp Wildwood 2026");

    const restored = await getConversation(projectId);
    assert.ok(restored);
    assert.equal(restored.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(restored.artworkVersions.length, 0);
    assert.equal(restored.designBriefVersions.length, 0);
    assert.equal(
      restored.messages.at(-1)?.metadata.phase,
      "awaiting_summary_confirmation",
    );
  });
});
