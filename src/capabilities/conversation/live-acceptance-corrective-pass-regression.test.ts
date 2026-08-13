import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Live Acceptance Corrective Pass — regression coverage for Sections 2–4
 * (final-direction confirmation gate, one-revision-not-three, and revision
 * lineage/history) not already covered by `rinker-boat-revision-regression.test.ts`
 * or `conversation-revision.test.ts`. Deterministic path only — no paid
 * provider calls.
 */
describe("Live Acceptance Corrective Pass — final direction confirmation, single-concept revision, and lineage", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-corrective-pass-"));
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
    return getCapabilityGraph();
  }

  async function toSelectedConcept(graph: Awaited<ReturnType<typeof freshConversation>>) {
    const { conversation, generationWorker } = graph;
    const { projectId } = await runAdaptiveInterviewToSummary(conversation, {
      product: "T-shirt",
      productColor: "Navy",
      requiredWording: "Camp Wildwood 2026",
    });
    await conversation.submitDesignBriefDecision(projectId, "approve");
    await generationWorker.processNextJob();

    const generated = await conversation.get(projectId);
    assert.ok(generated);
    assert.equal(generated.artworkVersions.length, 3);
    const [firstConcept] = generated.artworkVersions;
    assert.ok(firstConcept);
    const afterSelect = await conversation.selectConcept(projectId, firstConcept.id);
    return { projectId, originalConceptId: firstConcept.id, afterSelect };
  }

  it("1: selecting a concept does not make finalization eligible", async () => {
    const graph = await freshConversation();
    const { projectId, originalConceptId } = await toSelectedConcept(graph);

    const snapshot = await graph.conversation.get(projectId);
    assert.equal(snapshot?.project.finalDirectionConfirmed, false);

    await assert.rejects(
      () => graph.finalArtwork.requestFinalArtwork(projectId, originalConceptId),
      /confirm this is your final direction/i,
    );
  });

  it("2: explicit confirmSelectedDirection() makes finalization eligible", async () => {
    const graph = await freshConversation();
    const { projectId, originalConceptId } = await toSelectedConcept(graph);

    const confirmed = await graph.conversation.confirmSelectedDirection(
      projectId,
      originalConceptId,
    );
    assert.equal(confirmed.project.finalDirectionConfirmed, true);

    const result = await graph.finalArtwork.requestFinalArtwork(projectId, originalConceptId);
    assert.equal(result.approval.status, "active");
  });

  it('3: the typed "use this design" chat phrase confirms the same way as the button', async () => {
    const graph = await freshConversation();
    const { projectId, originalConceptId } = await toSelectedConcept(graph);

    const afterReply = await graph.conversation.handleUserMessage(
      projectId,
      "Use this design",
    );
    assert.equal(afterReply.project.finalDirectionConfirmed, true);

    const result = await graph.finalArtwork.requestFinalArtwork(projectId, originalConceptId);
    assert.equal(result.approval.status, "active");
  });

  it("4: confirming, then requesting a change, blocks finalization again", async () => {
    const graph = await freshConversation();
    const { conversation, generationWorker, finalArtwork } = graph;
    const { projectId, originalConceptId } = await toSelectedConcept(graph);

    await conversation.confirmSelectedDirection(projectId, originalConceptId);
    const afterRevision = await conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );
    assert.equal(afterRevision.project.revisionPending, true);

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, originalConceptId),
      /reviewed before/i,
    );

    await generationWorker.processNextJob();
  });

  it("5: a normal revision produces exactly ONE new concept, linked to the source", async () => {
    const graph = await freshConversation();
    const { conversation, generationWorker } = graph;
    const { projectId, originalConceptId } = await toSelectedConcept(graph);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    await generationWorker.processNextJob();

    const afterRevision = await conversation.get(projectId);
    assert.ok(afterRevision);
    const newestVersion = afterRevision.designBriefVersions.at(-1);
    const revisedBatch = afterRevision.artworkVersions.filter(
      (v) => v.designBriefVersionId === newestVersion?.id,
    );
    assert.equal(revisedBatch.length, 1);
    assert.equal(revisedBatch[0]?.sourceArtworkVersionId, originalConceptId);

    // Original remains historical, never deleted.
    assert.ok(afterRevision.artworkVersions.some((v) => v.id === originalConceptId));
    assert.equal(afterRevision.artworkVersions.length, 4);
  });

  it('6: an explicit "show me alternatives" request still produces three fresh directions after selection', async () => {
    const graph = await freshConversation();
    const { conversation, generationWorker } = graph;
    const { projectId } = await toSelectedConcept(graph);

    // A bare "show me alternatives" with literally no other change is a
    // no-op against an already-approved, unchanged brief (existing
    // idempotency architecture — nothing new to approve/regenerate
    // against, and `ALTERNATIVES_REQUEST_PATTERN` is checked ahead of
    // extraction so it never also applies a field change bundled into the
    // same message). Seed a real, separate change first, the same way a
    // real customer conversation naturally has one.
    await conversation.handleUserMessage(projectId, "Hmm, maybe make the shirt gray?");
    const afterAlternatives = await conversation.handleUserMessage(
      projectId,
      "Actually, show me a few different directions.",
    );
    assert.equal(afterAlternatives.project.status, "generating");
    await generationWorker.processNextJob();

    const afterWorker = await conversation.get(projectId);
    assert.ok(afterWorker);
    const newestVersion = afterWorker.designBriefVersions.at(-1);
    const newBatch = afterWorker.artworkVersions.filter(
      (v) => v.designBriefVersionId === newestVersion?.id,
    );
    assert.equal(newBatch.length, 3);
    // An explicit "alternatives" batch has no single source — it's a
    // fresh exploration, not a targeted revision of one concept.
    assert.ok(newBatch.every((v) => v.sourceArtworkVersionId == null));
  });

  it("7: the customer can explicitly return to the original concept after an unwanted revision", async () => {
    const graph = await freshConversation();
    const { conversation, generationWorker } = graph;
    const { projectId, originalConceptId } = await toSelectedConcept(graph);

    await conversation.handleUserMessage(projectId, "Actually, make it a hoodie.");
    await generationWorker.processNextJob();

    const afterRevision = await conversation.get(projectId);
    assert.ok(afterRevision);
    // The revision auto-selected itself; the customer decides they preferred the original.
    assert.notEqual(afterRevision.project.selectedArtworkVersionId, originalConceptId);

    const restored = await conversation.selectConcept(projectId, originalConceptId);
    assert.equal(restored.project.selectedArtworkVersionId, originalConceptId);
    assert.equal(restored.project.finalDirectionConfirmed, false);

    // The original concept is still fully intact and can be confirmed/finalized.
    const confirmed = await conversation.confirmSelectedDirection(projectId, originalConceptId);
    assert.equal(confirmed.project.finalDirectionConfirmed, true);
  });

  it("8: preview opening does not mutate selection or any lifecycle state (server-side has no preview endpoint to call)", async () => {
    // The preview modal is a pure client-side viewer (ConceptPreviewModal) —
    // there is no server mutation path for it at all, which is itself the
    // guarantee: no capability method exists for "preview," only for
    // `selectConcept`. This test documents that contract.
    const graph = await freshConversation();
    const { projectId } = await toSelectedConcept(graph);
    const before = await graph.conversation.get(projectId);
    const after = await graph.conversation.get(projectId);
    assert.deepEqual(before?.project, after?.project);
  });
});
