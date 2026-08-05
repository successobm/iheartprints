import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Sprint 2G Part 2/3: adaptive post-concept revision handling, end to end
 * through ConversationCapability. Unit-level RevisionIntelligence/
 * InterviewIntelligence/ProductIntelligence/ConceptGeneration coverage
 * lives in their own capability test files — this file proves the full
 * pipeline wires up correctly and the customer-visible behavior (no
 * restarts, no repeated questions, no forced yes/no, persistent
 * regeneration availability, undo) actually holds.
 */
describe("ConversationCapability — adaptive post-concept revisions", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-revision-"));
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

  async function freshConversation() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  /** Runs the interview to summary, approves it, and selects the first concept. */
  async function runToRevisionReady(
    conversation: Awaited<ReturnType<typeof freshConversation>>,
    answerOverrides: Partial<Record<string, string>> = {},
  ): Promise<{ projectId: string; afterSelect: ProjectSnapshot }> {
    const { projectId } = await runAdaptiveInterviewToSummary(
      conversation,
      answerOverrides,
    );
    const approved = await conversation.submitDesignBriefDecision(
      projectId,
      "approve",
    );
    assert.equal(approved.artworkVersions.length, 3);

    const firstConcept = approved.artworkVersions[0];
    assert.ok(firstConcept);
    const afterSelect = await conversation.selectConcept(projectId, firstConcept.id);
    assert.equal(afterSelect.conversation.phase, "ask_revisions");

    return { projectId, afterSelect };
  }

  it("a product-only revision updates the brief and mentions regeneration, without asking anything else", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );

    assert.match(afterRevision.brief.productSummary ?? "", /hoodie/i);
    assert.equal(afterRevision.conversation.phase, "revision_received");
    assert.equal(afterRevision.artworkVersions.length, 3); // not regenerated yet

    const lastMessage = afterRevision.messages.at(-1);
    assert.equal(lastMessage?.role, "assistant");
    assert.match(lastMessage?.content ?? "", /updated concepts/i);
  });

  it("ignoring the regeneration mention entirely still lets the conversation continue normally", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    // Completely unrelated reply — must not be misread as a yes/no answer
    // to the earlier regeneration mention.
    const afterUnrelated = await conversation.handleUserMessage(
      projectId,
      "By the way, what's the turnaround time usually like?",
    );

    assert.equal(afterUnrelated.conversation.phase, "revision_received");
    assert.equal(afterUnrelated.artworkVersions.length, 3); // still not regenerated
    const lastMessage = afterUnrelated.messages.at(-1);
    assert.doesNotMatch(lastMessage?.content ?? "", /would you like me to generate/i);
  });

  it("a clear 'regenerate' reply on ANY later turn triggers regeneration, not just the immediate next one", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    await conversation.handleUserMessage(
      projectId,
      "By the way, what's the turnaround time usually like?",
    );
    const afterRegenerate = await conversation.handleUserMessage(
      projectId,
      "Please regenerate the concepts.",
    );

    assert.equal(afterRegenerate.conversation.phase, "concepts_ready");
    assert.equal(afterRegenerate.designBriefVersions.length, 2);
    assert.equal(afterRegenerate.artworkVersions.length, 6);
  });

  it("explicit regenerateConcepts() creates a new brief version and a new batch of concepts", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    const afterRegen = await conversation.regenerateConcepts(projectId);

    assert.equal(afterRegen.conversation.phase, "concepts_ready");
    assert.equal(afterRegen.designBriefVersions.length, 2);
    assert.equal(afterRegen.artworkVersions.length, 6); // original 3 + new 3, never deleted
    assert.equal(afterRegen.project.selectedArtworkVersionId, null);

    const newestConcepts = afterRegen.artworkVersions.filter(
      (v) => v.designBriefVersionId === afterRegen.designBriefVersions.at(-1)?.id,
    );
    assert.equal(newestConcepts.length, 3);
  });

  it("declining regeneration in chat keeps the existing concepts untouched", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    const afterNo = await conversation.handleUserMessage(
      projectId,
      "Keep the current concepts for now.",
    );

    assert.equal(afterNo.conversation.phase, "revision_received");
    assert.equal(afterNo.artworkVersions.length, 3);
    assert.equal(afterNo.designBriefVersions.length, 1);
  });

  it("a product color change that clashes with artwork colors produces a clarification, not a silent update", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const beforeSnapshot = await conversation.get(projectId);
    // The scripted helper defers artwork colors, so seed a concrete one
    // first to set up a genuine clash on the next message.
    await conversation.handleUserMessage(projectId, "Use gold for the design colors.");

    const afterClash = await conversation.handleUserMessage(
      projectId,
      "Actually, make the shirt gold too.",
    );

    const lastMessage = afterClash.messages.at(-1);
    assert.match(lastMessage?.content ?? "", /may not be visible/i);
    assert.notEqual(afterClash.brief.updatedAt, beforeSnapshot?.brief.updatedAt);
  });

  it("a wording change on a sleeve placement raises a production concern via advise", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Print it on the sleeve instead.");
    const longWording = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const afterWording = await conversation.handleUserMessage(
      projectId,
      `Change the wording to ${longWording}.`,
    );

    const lastMessage = afterWording.messages.at(-1);
    assert.match(lastMessage?.content ?? "", /won't fit|shorter|placement/i);
  });

  it("a no-op revision (no structured change) stays in the loop with a generic acknowledgement", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterNoOp = await conversation.handleUserMessage(
      projectId,
      "Sounds good, thanks!",
    );

    assert.equal(afterNoOp.conversation.phase, "revision_received");
    const lastMessage = afterNoOp.messages.at(-1);
    assert.match(lastMessage?.content ?? "", /noted|anything else/i);
  });

  it("audience/purpose-only revisions never mention concept regeneration", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "This is actually for our alumni association, not current campers.",
    );

    const lastMessage = afterRevision.messages.at(-1);
    assert.doesNotMatch(lastMessage?.content ?? "", /would you like me to generate/i);
    assert.equal(afterRevision.artworkVersions.length, 3);
  });

  it("never restarts the interview or re-asks an already-answered required question", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "Remove the bowling pins from the design.",
    );

    // Still in the revision loop, not back in the adaptive interview phase.
    assert.equal(afterRevision.conversation.phase, "revision_received");
    assert.notEqual(afterRevision.conversation.phase, "interviewing");
    assert.notEqual(afterRevision.conversation.phase, "ask_product");

    // The reply this revision produced must not repeat the opening
    // question — only the very first message in history (before any of
    // this happened) is allowed to contain it.
    const lastMessage = afterRevision.messages.at(-1);
    assert.doesNotMatch(lastMessage?.content ?? "", /what are we printing today/i);
  });

  it("a deferral during a revision produces a Designer Decision note", async () => {
    const conversation = await freshConversation();
    // Seed a concrete (non-deferred) print location so deferring it during
    // the revision is a genuine first-time change, not a no-op re-defer.
    const { projectId } = await runToRevisionReady(conversation, {
      printLocation: "Full front",
    });

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "Actually, you choose the print placement.",
    );

    const lastMessage = afterRevision.messages.at(-1);
    assert.ok(lastMessage?.metadata.deferredDecision);
    const decision = lastMessage?.metadata.deferredDecision as {
      section: string;
      message: string;
    };
    assert.equal(decision.section, "printLocation");
    assert.doesNotMatch(decision.message, /missing|unknown/i);
  });

  describe("undo", () => {
    it("undoes the most recently accepted revision and restores the prior value", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      const original = await conversation.get(projectId);
      const originalProduct = original?.brief.productSummary;

      await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
      const afterUndo = await conversation.handleUserMessage(projectId, "Undo that.");

      assert.equal(afterUndo.brief.productSummary, originalProduct);
      const lastMessage = afterUndo.messages.at(-1);
      assert.match(lastMessage?.content ?? "", /undone/i);
    });

    it("explicit undoLastChange() works the same way as typing 'undo'", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      const original = await conversation.get(projectId);
      const originalColor = original?.brief.shirtColor;

      await conversation.handleUserMessage(projectId, "Make the shirt black.");
      const afterUndo = await conversation.undoLastChange(projectId);

      assert.equal(afterUndo.brief.shirtColor, originalColor);
    });

    it("only supports one level of undo — undoing twice in a row says there's nothing left", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
      await conversation.handleUserMessage(projectId, "Undo that.");
      const secondUndo = await conversation.handleUserMessage(projectId, "Undo that.");

      const lastMessage = secondUndo.messages.at(-1);
      assert.match(lastMessage?.content ?? "", /nothing to undo/i);
    });

    it("undoing with no prior revision at all is a safe no-op", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      const afterUndo = await conversation.undoLastChange(projectId);
      const lastMessage = afterUndo.messages.at(-1);
      assert.match(lastMessage?.content ?? "", /nothing to undo/i);
    });

    it("a second real revision replaces the undo point rather than stacking", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
      const afterSecond = await conversation.handleUserMessage(
        projectId,
        "Make the shirt black.",
      );
      assert.equal(afterSecond.brief.shirtColor, "black");
      assert.match(afterSecond.brief.productSummary ?? "", /hoodie/i);

      // Undo only reverts the *second* change (shirt color), not the first.
      const afterUndo = await conversation.undoLastChange(projectId);
      assert.notEqual(afterUndo.brief.shirtColor, "black");
      assert.match(afterUndo.brief.productSummary ?? "", /hoodie/i);
    });
  });

  describe("reload persistence", () => {
    it("concept status and the undo point survive a reload, not just the in-memory response", async () => {
      const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
        "@/capabilities/composition"
      );
      resetCapabilityGraphForTests();
      const graph = getCapabilityGraph();

      const { projectId } = await runToRevisionReady(graph.conversation);
      await graph.conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");

      const reloaded = await graph.conversation.get(projectId);
      assert.ok(reloaded);
      assert.ok(reloaded.conversation.interviewState.lastRevision);
      assert.deepEqual(
        reloaded.conversation.interviewState.lastRevision?.changedSections,
        ["product"],
      );

      const status = graph.conceptGeneration.describeConceptStatus(
        reloaded.brief,
        reloaded.artworkVersions,
        reloaded.designBriefVersions,
      );
      assert.equal(status.status, "needs_update");

      // A second reload sees the exact same thing — not a one-time fluke.
      const reloadedAgain = await graph.conversation.get(projectId);
      assert.deepEqual(
        reloadedAgain?.conversation.interviewState.lastRevision,
        reloaded.conversation.interviewState.lastRevision,
      );
    });

    it("an undo performed before reload is reflected after reload", async () => {
      const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
        "@/capabilities/composition"
      );
      resetCapabilityGraphForTests();
      const graph = getCapabilityGraph();

      const { projectId } = await runToRevisionReady(graph.conversation);
      const original = await graph.conversation.get(projectId);

      await graph.conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
      await graph.conversation.undoLastChange(projectId);

      const reloaded = await graph.conversation.get(projectId);
      assert.equal(reloaded?.brief.productSummary, original?.brief.productSummary);
      assert.equal(reloaded?.conversation.interviewState.lastRevision, null);
    });
  });
});
