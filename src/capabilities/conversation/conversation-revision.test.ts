import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Sprint 2G Part 2: adaptive post-concept revision handling, end to end
 * through ConversationCapability. Unit-level RevisionIntelligence/
 * InterviewIntelligence/ProductIntelligence coverage lives in their own
 * capability test files — this file proves the full pipeline wires up
 * correctly and the customer-visible behavior (no restarts, no repeated
 * questions, stale-concept prompting) actually holds.
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
  ): Promise<{ projectId: string; afterSelect: ProjectSnapshot }> {
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);
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

  it("a product-only revision updates the brief, prompts for regeneration, and asks nothing else", async () => {
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
    assert.equal(
      afterRevision.conversation.interviewState.awaitingConceptRegenerationConfirmation,
      true,
    );
  });

  it("confirming regeneration creates a new brief version and a new batch of concepts", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    const afterYes = await conversation.handleUserMessage(projectId, "Yes please.");

    assert.equal(afterYes.conversation.phase, "concepts_ready");
    assert.equal(afterYes.designBriefVersions.length, 2);
    assert.equal(afterYes.artworkVersions.length, 6); // original 3 + new 3, never deleted
    assert.equal(afterYes.project.selectedArtworkVersionId, null);
    assert.equal(
      afterYes.conversation.interviewState.awaitingConceptRegenerationConfirmation,
      false,
    );

    const newestConcepts = afterYes.artworkVersions.filter(
      (v) => v.designBriefVersionId === afterYes.designBriefVersions.at(-1)?.id,
    );
    assert.equal(newestConcepts.length, 3);
  });

  it("declining regeneration keeps the existing concepts untouched", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    const afterNo = await conversation.handleUserMessage(projectId, "No thanks.");

    assert.equal(afterNo.conversation.phase, "revision_received");
    assert.equal(afterNo.artworkVersions.length, 3);
    assert.equal(afterNo.designBriefVersions.length, 1);
    assert.equal(
      afterNo.conversation.interviewState.awaitingConceptRegenerationConfirmation,
      false,
    );
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
    assert.equal(
      afterNoOp.conversation.interviewState.awaitingConceptRegenerationConfirmation,
      false,
    );
    const lastMessage = afterNoOp.messages.at(-1);
    assert.match(lastMessage?.content ?? "", /noted|anything else/i);
  });

  it("audience/purpose-only revisions do not prompt for concept regeneration", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "This is actually for our alumni association, not current campers.",
    );

    assert.equal(
      afterRevision.conversation.interviewState.awaitingConceptRegenerationConfirmation,
      false,
    );
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
});
