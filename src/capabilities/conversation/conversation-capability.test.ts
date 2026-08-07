import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2D: verifies the constitutional approval gate.
 * Sprint 2F: the interview itself is now adaptive (see
 * `runAdaptiveInterviewToSummary`) instead of a fixed four-question ladder;
 * everything downstream of "the summary is presented" is unchanged.
 */
describe("ConversationCapability — adaptive interview + Design Summary approval gate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-approval-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshConversation() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  it("stops with a Design Summary instead of concepts once the interview is complete", async () => {
    const conversation = await freshConversation();
    const { afterSummary } = await runAdaptiveInterviewToSummary(conversation);

    assert.equal(afterSummary.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(afterSummary.artworkVersions.length, 0);
    assert.equal(afterSummary.designBriefVersions.length, 0);

    const lastMessage = afterSummary.messages.at(-1);
    assert.ok(lastMessage);
    assert.equal(lastMessage?.role, "assistant");
    assert.equal(lastMessage?.metadata.phase, "awaiting_summary_confirmation");
  });

  it("Design Summary reflects provided fields; deferred ones appear as designer decisions, never raw internal state", async () => {
    const conversation = await freshConversation();
    const { afterSummary } = await runAdaptiveInterviewToSummary(conversation);

    const lastMessage = afterSummary.messages.at(-1);
    const summary = lastMessage?.metadata.summary as
      | Record<string, unknown>
      | undefined;
    assert.ok(summary);

    // Sprint 2K Phase 3 (Goal 2): short product answers are normalized to
    // Title Case for display.
    assert.equal(summary?.product, "Camp Shirts");
    assert.equal(summary?.graphics, "A friendly bear logo");
    assert.equal(summary?.productColor, "Navy");
    assert.equal(summary?.requiredWording, "Camp Wildwood 2026");

    // Sprint 2L Phase 1B: printLocation is the only remaining high-value
    // section — the helper defers it ("You choose.") and it appears as its
    // own "Designer will determine" entry, never as raw internal state.
    // purpose/audience/style/colors are optional now (never proactively
    // asked, per interview-coverage-policy.ts) — they are simply absent
    // from both the regular field list AND the deferred-decisions list,
    // exactly like references/exclusions/additionalNotes always have been.
    for (const key of ["style", "colors", "printLocation", "purpose", "audience"]) {
      assert.equal(summary?.[key], undefined, key);
    }

    const deferredDecisions = lastMessage?.metadata.deferredDecisions as
      | Array<{ section: string; label: string }>
      | undefined;
    assert.ok(deferredDecisions);
    assert.deepEqual(
      deferredDecisions.map((d) => d.section),
      ["printLocation"],
    );
    for (const decision of deferredDecisions) {
      assert.doesNotMatch(decision.label, /deferred_to_designer|missing|unknown/i);
    }

    // References/exclusions/additional notes were never touched — still omitted.
    assert.equal(summary?.references, undefined);
    assert.equal(summary?.exclusions, undefined);
  });

  it("fills several fields from one rich reply and skips the questions they answer", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;
    assert.equal(started.conversation.interviewState.pendingSection, "product");

    const afterRich = await conversation.handleUserMessage(
      projectId,
      "Black hoodies with a vintage gold logo.",
    );

    assert.equal(afterRich.brief.productSummary?.toLowerCase().includes("hoodies"), true);
    assert.equal(afterRich.brief.shirtColor?.toLowerCase(), "black");
    assert.match(afterRich.brief.designStyle ?? "", /vintage/i);

    // productColor and style are now resolved — Interview Intelligence
    // should have skipped straight past them.
    const pending = afterRich.conversation.interviewState.pendingSection;
    assert.notEqual(pending, "productColor");
    assert.notEqual(pending, "style");
  });

  it("resume mid-interview restores the pending section", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterFirst = await conversation.handleUserMessage(projectId, "Camp shirts");
    const restored = await conversation.get(projectId);

    assert.equal(
      restored?.conversation.interviewState.pendingSection,
      afterFirst.conversation.interviewState.pendingSection,
    );
    assert.equal(restored?.conversation.phase, "interviewing");
  });

  it("blocks free-text chat while awaiting a summary decision", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);

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

  it("approve enqueues generation, and the background worker completes it with one durable brief version and three placeholder concepts", async () => {
    const conversation = await freshConversation();
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);

    const enqueued = await conversation.submitDesignBriefDecision(
      projectId,
      "approve",
    );
    assert.equal(enqueued.conversation.phase, "generating");
    assert.equal(enqueued.artworkVersions.length, 0);

    await getCapabilityGraph().generationWorker.processNextJob();
    const approved = await conversation.get(projectId);

    assert.equal(approved?.conversation.phase, "concepts_ready");
    assert.equal(approved?.designBriefVersions.length, 1);
    assert.equal(approved?.designBriefVersions[0]?.versionNumber, 1);
    assert.equal(approved?.designBriefVersions[0]?.status, "approved");
    assert.equal(approved?.artworkVersions.length, 3);

    for (const artwork of approved?.artworkVersions ?? []) {
      assert.equal(
        artwork.designBriefVersionId,
        approved?.designBriefVersions[0]?.id,
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
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);

    await conversation.submitDesignBriefDecision(projectId, "approve");
    await getCapabilityGraph().generationWorker.processNextJob();

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

  it("Edit corrects a specific field (via real extraction) and re-presents an updated summary", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);

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
    // Sprint 2K Phase 3 (Goal 2): color fields are normalized to Title Case.
    assert.equal(updated.brief.shirtColor, "Forest Green");

    const summary = updated.messages.at(-1)?.metadata.summary as
      | Record<string, unknown>
      | undefined;
    assert.match(String(summary?.productColor), /forest green/i);

    // Sprint 2G Part 2: the refreshed summary flags what just changed so
    // the UI can highlight it, without exposing internal impact detail.
    const updatedSections = updated.messages.at(-1)?.metadata.updatedSections;
    assert.deepEqual(updatedSections, ["productColor"]);

    // Still requires a fresh approval — editing does not auto-approve.
    assert.equal(updated.designBriefVersions.length, 0);
    assert.equal(updated.artworkVersions.length, 0);
  });

  it("Sprint 2L Phase 1B (Goal 12): Edit alone preserves uncertain free text as a note and returns to the summary for approval — 'Continue' was removed as redundant with it", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);

    const editing = await conversation.submitDesignBriefDecision(
      projectId,
      "edit",
    );
    assert.equal(editing.conversation.phase, "edit_requested");

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

  it("rejects Edit outside the summary confirmation state", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);
    await conversation.submitDesignBriefDecision(projectId, "approve");

    await assert.rejects(
      () => conversation.submitDesignBriefDecision(projectId, "edit"),
      /Cannot edit the design brief/,
    );
  });

  it("a historical project still sitting in a legacy ask_* phase keeps using the fixed ladder", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();

    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    // Simulate a project that predates Sprint 2F, still on the scripted ladder.
    await repo.updateConversationPhase(created.project.id, "ask_product");

    const graph = getCapabilityGraph();
    const afterReply = await graph.conversation.handleUserMessage(
      created.project.id,
      "A T-shirt for the school fair",
    );

    assert.equal(afterReply.conversation.phase, "ask_design");
    assert.equal(
      afterReply.brief.productSummary,
      "A T-shirt for the school fair",
    );
  });
});
