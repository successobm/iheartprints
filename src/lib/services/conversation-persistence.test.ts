import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

describe("Sprint 1 conversation persistence", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-persist-"));
    process.chdir(tempDir);
  });

  after(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("restores the same project and opening message instead of resetting", async () => {
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
});
