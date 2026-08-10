import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
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
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshConversation() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  /** Drives the background worker to completion — Sprint 2H Part 2A: generation is enqueued, not synchronous. */
  async function runWorkerToCompletion(): Promise<void> {
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    await getCapabilityGraph().generationWorker.processNextJob();
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
    await conversation.submitDesignBriefDecision(projectId, "approve");
    await runWorkerToCompletion();
    const approved = await conversation.get(projectId);
    assert.ok(approved);
    assert.equal(approved.artworkVersions.length, 3);

    const firstConcept = approved.artworkVersions[0];
    assert.ok(firstConcept);
    const afterSelect = await conversation.selectConcept(projectId, firstConcept.id);
    assert.equal(afterSelect.conversation.phase, "ask_revisions");

    return { projectId, afterSelect };
  }

  it("Sprint 2M Phase 2G: an explicit, concept-relevant revision automatically enqueues regeneration", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );

    assert.match(afterRevision.brief.productSummary ?? "", /hoodie/i);
    // Pending-revision authority set immediately, before generation even
    // completes (Goal 3) — and enqueue happened automatically (Goal 4),
    // no "Generate Updated Concepts" click needed.
    assert.equal(afterRevision.project.revisionPending, true);
    assert.equal(afterRevision.project.status, "generating");
    assert.equal(afterRevision.artworkVersions.length, 3); // enqueued, not run yet

    // The auto-trigger's own acknowledgement (Goal 10), immediately
    // followed by the (pre-existing, shared with the manual "regenerate"
    // path) enqueue announcement — assert on whichever of the last two
    // messages carries which claim, since both are genuinely true. The
    // "we are updating it" claim now always comes from the enqueue
    // announcement, which is only written once the job is durable, so
    // match either phrasing rather than one exact sentence.
    const lastTwo = afterRevision.messages.slice(-2);
    assert.ok(lastTwo.every((m) => m.role === "assistant"));
    assert.ok(lastTwo.some((m) => /updating .*concept/i.test(m.content)));
    // Never a permission-asking prompt — the system already acted.
    assert.ok(!lastTwo.some((m) => /would you like me to generate/i.test(m.content)));

    await runWorkerToCompletion();
    const afterWorker = await conversation.get(projectId);
    assert.ok(afterWorker);
    // Back in the revision loop, not concept selection — there is one
    // revised concept, already selected, and the customer needs chat.
    assert.equal(afterWorker.conversation.phase, "ask_revisions");
    // Live Acceptance Corrective Pass (Section 3): the default post-
    // selection revision targets the ONE selected concept — 3 original +
    // 1 revision, never a fresh three-direction exploration.
    assert.equal(afterWorker.artworkVersions.length, 4);
    const revised = afterWorker.artworkVersions.at(-1);
    assert.equal(revised?.sourceArtworkVersionId, afterRevision.project.selectedArtworkVersionId);
    // Cleared only once the revision is actually represented by new
    // artwork (Goal 3) — never merely at enqueue time.
    assert.equal(afterWorker.project.revisionPending, false);
  });

  it("a tentative/hedged revision never auto-regenerates and still lets the conversation continue normally", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "Hmm, maybe make it a hoodie?",
    );
    assert.equal(afterRevision.project.revisionPending, false);
    assert.equal(afterRevision.artworkVersions.length, 3);

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

    // Hedged so this doesn't already auto-trigger — this test is about the
    // manual "regenerate" pattern still working several turns later
    // (Goal 4: the manual control remains available for anything the
    // automatic path doesn't cover).
    await conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");
    await conversation.handleUserMessage(
      projectId,
      "By the way, what's the turnaround time usually like?",
    );
    await conversation.handleUserMessage(
      projectId,
      "Please regenerate the concepts.",
    );
    await runWorkerToCompletion();
    const afterRegenerate = await conversation.get(projectId);

    assert.equal(afterRegenerate?.conversation.phase, "ask_revisions");
    assert.equal(afterRegenerate?.designBriefVersions.length, 2);
    // Live Acceptance Corrective Pass (Section 3): the manual "regenerate"
    // control now also defaults to revising the selected concept.
    assert.equal(afterRegenerate?.artworkVersions.length, 4);
  });

  it("explicit regenerateConcepts() creates a new brief version and a new batch of concepts", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    // This explicit message already auto-triggers regeneration (Sprint 2M
    // Phase 2G) — the immediately-following explicit regenerateConcepts()
    // call below must be a no-op (idempotent, Goal 4/8), not a second
    // brief version/job, which is exactly what this test proves.
    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    await conversation.regenerateConcepts(projectId);
    await runWorkerToCompletion();
    const afterRegen = await conversation.get(projectId);
    assert.ok(afterRegen);

    assert.equal(afterRegen.conversation.phase, "ask_revisions");
    assert.equal(afterRegen.designBriefVersions.length, 2);
    // Live Acceptance Corrective Pass (Section 3): original 3 + 1 targeted
    // revision, never deleted, never a fresh three-direction batch.
    assert.equal(afterRegen.artworkVersions.length, 4);

    const newestConcepts = afterRegen.artworkVersions.filter(
      (v) => v.designBriefVersionId === afterRegen.designBriefVersions.at(-1)?.id,
    );
    assert.equal(newestConcepts.length, 1);
    // A single-candidate revision is auto-selected as the thing under
    // review — there is nothing else to pick from — but this alone can
    // never make it finalization-eligible (finalDirectionConfirmed stays
    // false; see final-artwork-capability.test.ts).
    assert.equal(afterRegen.project.selectedArtworkVersionId, newestConcepts[0]?.id);
    assert.equal(afterRegen.project.finalDirectionConfirmed, false);
  });

  it("declining regeneration in chat keeps the existing concepts untouched", async () => {
    const conversation = await freshConversation();
    const { projectId } = await runToRevisionReady(conversation);

    // Hedged so the mention-only (not auto-triggered) path is what's under
    // test here.
    await conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");
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
    // first to set up a genuine clash on the next message. Hedged so this
    // seed itself doesn't auto-trigger regeneration (which would block the
    // very next chat message this test needs to send).
    await conversation.handleUserMessage(
      projectId,
      "Hmm, maybe use gold for the design colors?",
    );

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

    // Hedged so this seed doesn't auto-trigger regeneration and block the
    // wording message below.
    await conversation.handleUserMessage(
      projectId,
      "Hmm, maybe print it on the sleeve instead?",
    );
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

    // Sprint 2M Phase 2G: an explicit "remove X" is a concept-relevant
    // exclusion (Goal 2/12) and auto-triggers regeneration, so phase may
    // now be "generating" rather than "revision_received" — either way,
    // it must never fall back through the adaptive interview.
    assert.notEqual(afterRevision.conversation.phase, "interviewing");
    assert.notEqual(afterRevision.conversation.phase, "ask_product");

    // The reply this revision produced must not repeat the opening
    // question — only the very first message in history (before any of
    // this happened) is allowed to contain it.
    const lastMessage = afterRevision.messages.at(-1);
    assert.doesNotMatch(lastMessage?.content ?? "", /what are we printing today/i);

    // Drain the auto-triggered regeneration job this message enqueued —
    // otherwise it stays queued and a later, unrelated test's own
    // `runWorkerToCompletion()` call (which claims the oldest queued job
    // globally, not scoped to one project) would claim this leftover job
    // instead of its own.
    await runWorkerToCompletion();
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

    // This deferral is also concept-relevant and auto-triggers regeneration
    // (Sprint 2M Phase 2G) — the Designer Decision note rides on the
    // auto-trigger's own acknowledgement message, which may not be the
    // very last message (the enqueue announcement can follow it).
    const messageWithDecision = afterRevision.messages
      .slice(-2)
      .find((m) => m.metadata.deferredDecision);
    assert.ok(messageWithDecision, "expected a deferredDecision on a recent message");
    const decision = messageWithDecision!.metadata.deferredDecision as {
      section: string;
      message: string;
    };
    assert.equal(decision.section, "printLocation");
    assert.doesNotMatch(decision.message, /missing|unknown/i);

    // Drain the auto-triggered job so it doesn't leak into a later test.
    await runWorkerToCompletion();
  });

  describe("undo", () => {
    it("undoes the most recently accepted revision and restores the prior value", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      const original = await conversation.get(projectId);
      const originalProduct = original?.brief.productSummary;

      // Hedged so the phase stays chattable — typing "Undo that." next must
      // still work via the normal chat path, not be blocked by an
      // auto-triggered "generating" phase (unrelated to what this test is
      // about).
      await conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");
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

      // Hedged so this doesn't auto-trigger and leave a queued regeneration
      // job undrained (this test never calls runWorkerToCompletion()).
      await conversation.handleUserMessage(projectId, "Maybe make the shirt black?");
      const afterUndo = await conversation.undoLastChange(projectId);

      assert.equal(afterUndo.brief.shirtColor, originalColor);
    });

    it("only supports one level of undo — undoing twice in a row says there's nothing left", async () => {
      const conversation = await freshConversation();
      const { projectId } = await runToRevisionReady(conversation);

      await conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");
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

      // Both hedged: the first so the second message below (via chat) isn't
      // blocked by an auto-triggered "generating" phase, the second so it
      // doesn't leave a queued regeneration job undrained (this test never
      // calls runWorkerToCompletion()).
      await conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");
      const afterSecond = await conversation.handleUserMessage(
        projectId,
        "Maybe make the shirt black?",
      );
      // Sprint 2K Phase 3 (Goal 2): color fields are normalized to Title Case.
      assert.equal(afterSecond.brief.shirtColor, "Black");
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
      // Hedged so this specifically stays on the pre-Sprint-2M-Phase-2G
      // "changed but not yet approved/regenerated" path this test is about
      // — an auto-triggered revision immediately approves+regenerates,
      // which would make concept status "current" again, not "needs_update".
      await graph.conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");

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

      // Hedged so this doesn't leave a queued regeneration job undrained
      // (this test never calls runWorkerToCompletion()).
      await graph.conversation.handleUserMessage(projectId, "Hmm, maybe make it a hoodie?");
      await graph.conversation.undoLastChange(projectId);

      const reloaded = await graph.conversation.get(projectId);
      assert.equal(reloaded?.brief.productSummary, original?.brief.productSummary);
      assert.equal(reloaded?.conversation.interviewState.lastRevision, null);
    });
  });
});
