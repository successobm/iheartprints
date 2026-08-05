import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Sprint 2D: verifies the constitutional approval gate.
 *
 * The scripted four-question interview itself is unchanged (kept identical
 * to Sprint 1); only what happens *after* the fourth answer changes: the
 * system must present a Design Summary and wait for an explicit customer
 * decision instead of generating concepts automatically.
 */
describe("ConversationCapability — Design Summary approval gate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-approval-"));
    process.chdir(tempDir);
  });

  after(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function freshConversation() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  async function runScriptedInterview(
    conversation: Awaited<ReturnType<typeof freshConversation>>,
  ) {
    const started = await conversation.start();
    const projectId = started.project.id;

    await conversation.handleUserMessage(projectId, "Camp shirts");
    await conversation.handleUserMessage(projectId, "A friendly bear logo");
    await conversation.handleUserMessage(projectId, "Navy");
    const afterText = await conversation.handleUserMessage(
      projectId,
      "Camp Wildwood 2026",
    );

    return { projectId, afterText };
  }

  it("stops after the fourth scripted answer with a Design Summary instead of concepts", async () => {
    const conversation = await freshConversation();
    const { afterText } = await runScriptedInterview(conversation);

    assert.equal(afterText.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(afterText.artworkVersions.length, 0);
    assert.equal(afterText.designBriefVersions.length, 0);

    const lastMessage = afterText.messages.at(-1);
    assert.ok(lastMessage);
    assert.equal(lastMessage?.role, "assistant");
    assert.equal(lastMessage?.metadata.phase, "awaiting_summary_confirmation");
  });

  it("Design Summary includes only known fields and never invents others", async () => {
    const conversation = await freshConversation();
    const { afterText } = await runScriptedInterview(conversation);

    const summary = afterText.messages.at(-1)?.metadata.summary as
      | Record<string, unknown>
      | undefined;
    assert.ok(summary);

    assert.equal(summary?.product, "Camp shirts");
    assert.equal(summary?.graphics, "A friendly bear logo");
    assert.equal(summary?.productColor, "Navy");
    assert.equal(summary?.requiredWording, "Camp Wildwood 2026");

    // Never asked by the current scripted interview — must not be fabricated.
    assert.equal(summary?.audience, undefined);
    assert.equal(summary?.purpose, undefined);
    assert.equal(summary?.printLocation, undefined);
    assert.equal(summary?.references, undefined);
    assert.equal(summary?.productionConsiderations, undefined);
  });

  it("blocks free-text chat while awaiting a summary decision", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runScriptedInterview(conversation);

    await assert.rejects(
      () => conversation.handleUserMessage(projectId, "actually make it red"),
      /wait for the current step/,
    );
  });

  it("rejects direct concept generation without an approved brief", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();

    const started = await graph.conversation.start();

    await assert.rejects(
      () =>
        graph.conceptGeneration.generatePlaceholders(started.project.id, ""),
      /Cannot generate concepts without an approved design brief/,
    );
    await assert.rejects(
      () =>
        graph.conceptGeneration.generatePlaceholders(
          started.project.id,
          "00000000-0000-0000-0000-000000000000",
        ),
      /Cannot generate concepts without an approved design brief/,
    );
  });

  it("rejects approval before the Design Summary has been presented", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();

    await assert.rejects(
      () => conversation.submitDesignBriefDecision(started.project.id, "approve"),
      /not ready for approval/,
    );
  });

  it("approve creates exactly one durable brief version and three placeholder concepts", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runScriptedInterview(conversation);

    const approved = await conversation.submitDesignBriefDecision(
      projectId,
      "approve",
    );

    assert.equal(approved.conversation.phase, "concepts_ready");
    assert.equal(approved.designBriefVersions.length, 1);
    assert.equal(approved.designBriefVersions[0]?.versionNumber, 1);
    assert.equal(approved.designBriefVersions[0]?.status, "approved");
    assert.equal(approved.artworkVersions.length, 3);

    for (const artwork of approved.artworkVersions) {
      assert.equal(
        artwork.designBriefVersionId,
        approved.designBriefVersions[0]?.id,
      );
    }

    // Durable across reload, not just in-memory / React state.
    const reloaded = await conversation.get(projectId);
    assert.equal(reloaded?.conversation.phase, "concepts_ready");
    assert.equal(reloaded?.designBriefVersions.length, 1);
    assert.equal(reloaded?.artworkVersions.length, 3);
  });

  it("repeated approval requests are idempotent — no duplicate versions or concepts", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runScriptedInterview(conversation);

    await conversation.submitDesignBriefDecision(projectId, "approve");
    const second = await conversation.submitDesignBriefDecision(
      projectId,
      "approve",
    );
    const third = await conversation.submitDesignBriefDecision(
      projectId,
      "approve",
    );

    assert.equal(second.designBriefVersions.length, 1);
    assert.equal(second.artworkVersions.length, 3);
    assert.equal(third.designBriefVersions.length, 1);
    assert.equal(third.artworkVersions.length, 3);
  });

  it("Edit returns to conversational collection and re-presents an updated summary", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runScriptedInterview(conversation);

    const editing = await conversation.submitDesignBriefDecision(
      projectId,
      "edit",
    );
    assert.equal(editing.conversation.phase, "edit_requested");

    const updated = await conversation.handleUserMessage(
      projectId,
      "Actually, please make the shirt color forest green.",
    );

    assert.equal(updated.conversation.phase, "awaiting_summary_confirmation");
    assert.match(
      updated.brief.additionalInstructions ?? "",
      /forest green/,
    );

    const summary = updated.messages.at(-1)?.metadata.summary as
      | Record<string, unknown>
      | undefined;
    assert.match(String(summary?.additionalNotes ?? ""), /forest green/);

    // Still requires a fresh approval — editing does not auto-approve.
    assert.equal(updated.designBriefVersions.length, 0);
    assert.equal(updated.artworkVersions.length, 0);
  });

  it("Continue collects additional notes and returns to the summary for approval", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runScriptedInterview(conversation);

    const continuing = await conversation.submitDesignBriefDecision(
      projectId,
      "continue",
    );
    assert.equal(continuing.conversation.phase, "continue_requested");

    const updated = await conversation.handleUserMessage(
      projectId,
      "This is for a nonprofit fundraiser, please keep costs low.",
    );

    assert.equal(updated.conversation.phase, "awaiting_summary_confirmation");
    assert.match(
      updated.brief.additionalInstructions ?? "",
      /nonprofit fundraiser/,
    );
  });

  it("rejects Edit or Continue outside the summary confirmation state", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runScriptedInterview(conversation);
    await conversation.submitDesignBriefDecision(projectId, "approve");

    await assert.rejects(
      () => conversation.submitDesignBriefDecision(projectId, "edit"),
      /Cannot edit the design brief/,
    );
    await assert.rejects(
      () => conversation.submitDesignBriefDecision(projectId, "continue"),
      /Cannot continue the design brief/,
    );
  });
});
