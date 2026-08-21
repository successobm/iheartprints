import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2M Phase 2G (Goal 16) — permanent regression fixture for the real
 * live failure this sprint fixes, generalized where practical (no
 * boat-specific parsing exists anywhere in the implementation this test
 * exercises — see `extraction.ts`'s structural entity-naming shape
 * recognition).
 *
 * Live scenario:
 *   "I have a 2000 Rinker Fiesta Vee 270 and want a T-shirt design of that
 *   boat" → "GLORIOUS is the boat name" → concept selected → "the wording
 *   is the boat name shouldn't appear on the design. it was me telling you
 *   to use the word GLORIOUS" → revision must be recognized, required
 *   wording must remain/resolve to GLORIOUS, the explanatory wording must
 *   be excluded, revision generation must auto-enqueue, no FinalArtworkJob
 *   may be created, and only after the customer explicitly selects the
 *   revised concept and clicks Prepare may finalization begin.
 *
 * Covers test-matrix items H, I, J, K, M, N, O, P, Q, R, U (deterministic
 * path only — no OpenAI/paid-provider calls).
 */
describe("Regression — Rinker boat revision lifecycle (Sprint 2M Phase 2G, Goal 16)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-rinker-regression-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph();
  }

  async function driveToSelectedConcept(
    graph: Awaited<ReturnType<typeof freshGraph>>,
  ) {
    const { conversation, generationWorker } = graph;
    const { projectId, afterSummary } = await runAdaptiveInterviewToSummary(
      conversation,
      {
        product: "T-shirt",
        graphics: "A design of a 2000 Rinker Fiesta Vee 270 boat",
        productColor: "White",
        // The live failing message, verbatim.
        requiredWording: "GLORIOUS is the boat name",
        // Print'em All Phase 1: the print location is answered during the
        // interview, so the project has a placement to recommend and confirm
        // a production size against before any finalization is requested.
        printLocation: "Full front",
      },
    );
    void afterSummary;

    await conversation.submitDesignBriefDecision(projectId, "approve");
    await generationWorker.processNextJob();

    const afterGeneration = await conversation.get(projectId);
    assert.ok(afterGeneration);
    assert.equal(afterGeneration.artworkVersions.length, 3);
    const [firstConcept] = afterGeneration.artworkVersions;
    assert.ok(firstConcept);

    const afterSelect = await conversation.selectConcept(projectId, firstConcept.id);
    return { projectId, originalConceptId: firstConcept.id, afterSelect };
  }

  it("H/goal1: 'GLORIOUS is the boat name' resolves to literal required wording GLORIOUS, not the whole sentence", async () => {
    const graph = await freshGraph();
    const { projectId } = await driveToSelectedConcept(graph);

    const snapshot = await graph.conversation.get(projectId);
    assert.equal(snapshot?.brief.exactText, "GLORIOUS");
  });

  it("H/I/J/K/M/N: the correction message marks revision pending, auto-enqueues regeneration, creates no FinalArtworkJob, and clears only once revised artwork exists", async () => {
    const graph = await freshGraph();
    const { conversation, generationWorker, finalArtwork } = graph;
    const { projectId, originalConceptId } = await driveToSelectedConcept(graph);

    const afterCorrection = await conversation.handleUserMessage(
      projectId,
      "the wording is the boat name shouldn't appear on the design. it was me telling you to use the word GLORIOUS",
    );

    // H: required wording remains/updates to GLORIOUS; explanatory wording excluded.
    assert.equal(afterCorrection.brief.exactText, "GLORIOUS");
    assert.match(String(afterCorrection.brief.exclusions ?? ""), /boat name/i);

    // H: revision pending, durable authority — not merely status="revision_requested".
    assert.equal(afterCorrection.project.revisionPending, true);

    // I: automatically enqueued — no extra "Generate Updated Concepts" click.
    assert.equal(afterCorrection.project.status, "generating");

    // The acknowledgement conveys understanding + in-progress revision —
    // never the generic "Got it — I've updated the notes." fallback, and
    // never implies final approval.
    const lastTwoMessages = afterCorrection.messages.slice(-2);
    assert.ok(
      lastTwoMessages.every((m) => !/I've updated the notes/i.test(m.content)),
    );
    // The in-progress claim now always comes from the enqueue
    // announcement, written only once the job is durable — match either
    // phrasing rather than one exact sentence.
    assert.ok(lastTwoMessages.some((m) => /updating .*concept/i.test(m.content)));

    // J: no FinalDirectionApproval / FinalArtworkJob exists — Prepare was
    // never (and could never have been) called during the pending window.
    const activeApproval = await graph.finalArtwork.getCurrentProductionAssetId(projectId);
    assert.equal(activeApproval, null);

    // K: server-side, Prepare is authoritatively refused while pending —
    // even if a stale browser tab tried it against the original concept.
    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, originalConceptId),
      /reviewed before/i,
    );

    // Drive the auto-enqueued regeneration to completion.
    await generationWorker.processNextJob();
    const afterRevision = await conversation.get(projectId);
    assert.ok(afterRevision);

    // M: pending cleared only once represented by new artwork.
    assert.equal(afterRevision.project.revisionPending, false);
    // A finished targeted revision returns to the revision loop, not to
    // concept selection — the customer must be able to ask for another
    // change or confirm this one (`concepts_ready` blocks chat).
    assert.equal(afterRevision.conversation.phase, "ask_revisions");

    // N: the original ArtworkVersion remains historical, never deleted.
    const original = afterRevision.artworkVersions.find((v) => v.id === originalConceptId);
    assert.ok(original, "original concept must remain historical");

    // A genuinely new batch exists, tied to the newest approved brief
    // version — exactly ONE targeted revision, never a fresh
    // three-direction exploration (Section 3).
    const newestVersion = afterRevision.designBriefVersions.at(-1);
    const revisedBatch = afterRevision.artworkVersions.filter(
      (v) => v.designBriefVersionId === newestVersion?.id,
    );
    assert.equal(revisedBatch.length, 1);
    assert.equal(revisedBatch[0]?.sourceArtworkVersionId, originalConceptId);
    assert.ok(!revisedBatch.some((v) => v.id === originalConceptId));
  });

  it("O/P: customer selects the revised concept and Prepare targets exactly that version, never the original", async () => {
    const graph = await freshGraph();
    const { conversation, generationWorker, finalArtwork } = graph;
    const { projectId, originalConceptId } = await driveToSelectedConcept(graph);

    await conversation.handleUserMessage(
      projectId,
      "the wording is the boat name shouldn't appear on the design. it was me telling you to use the word GLORIOUS",
    );
    await generationWorker.processNextJob();

    const afterRevision = await conversation.get(projectId);
    assert.ok(afterRevision);
    const newestVersion = afterRevision.designBriefVersions.at(-1);
    const revisedConcept = afterRevision.artworkVersions.find(
      (v) => v.designBriefVersionId === newestVersion?.id,
    );
    assert.ok(revisedConcept);

    await conversation.selectConcept(projectId, revisedConcept.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — the customer must explicitly confirm.
    await conversation.confirmSelectedDirection(projectId, revisedConcept.id);
    // Print'em All Phase 1: the DESIGN is confirmed above; the PHYSICAL SIZE
    // is a separate decision, and production requires both.
    await conversation.confirmRecommendedProductionSize(projectId);
    const result = await finalArtwork.requestFinalArtwork(projectId, revisedConcept.id);

    // P: final approval targets the revised ArtworkVersion, never the original.
    assert.equal(result.approval.artworkVersionId, revisedConcept.id);
    assert.notEqual(result.approval.artworkVersionId, originalConceptId);
    assert.equal(result.approval.status, "active");

    const afterPrepare = await conversation.get(projectId);
    assert.equal(afterPrepare?.project.status, "finalizing");

    // Drain the FinalArtworkJob this created — otherwise it stays queued
    // and a later test's own `finalArtworkWorker.processNextJob()` call
    // (which claims the oldest queued job globally, not scoped to one
    // project) would claim this leftover job instead of its own.
    await graph.finalArtworkWorker.processNextJob();
  });

  it("Q/R/U: a revision requested during finalization supersedes the in-flight approval; the stale job can never reach print_ready", async () => {
    const graph = await freshGraph();
    const { conversation, generationWorker, finalArtwork, finalArtworkWorker } = graph;
    const { projectId } = await driveToSelectedConcept(graph);

    const afterCorrection = await conversation.handleUserMessage(
      projectId,
      "the wording is the boat name shouldn't appear on the design. it was me telling you to use the word GLORIOUS",
    );
    void afterCorrection;
    await generationWorker.processNextJob();

    const afterRevision = await conversation.get(projectId);
    const newestVersion = afterRevision!.designBriefVersions.at(-1);
    const revisedConcept = afterRevision!.artworkVersions.find(
      (v) => v.designBriefVersionId === newestVersion?.id,
    )!;
    await conversation.selectConcept(projectId, revisedConcept.id);
    await conversation.confirmSelectedDirection(projectId, revisedConcept.id);
    // Print'em All Phase 1: the DESIGN is confirmed above; the PHYSICAL SIZE
    // is a separate decision, and production requires both.
    await conversation.confirmRecommendedProductionSize(projectId);

    const prepared = await finalArtwork.requestFinalArtwork(projectId, revisedConcept.id);
    assert.equal(prepared.approval.status, "active");

    // Customer requests ANOTHER change while finalization is in flight.
    const afterSecondRevision = await conversation.handleUserMessage(
      projectId,
      "Actually, make the boat larger too.",
    );
    assert.equal(afterSecondRevision.project.revisionPending, true);

    // R: the in-flight approval is immediately superseded — historical,
    // not deleted.
    const stillActive = await finalArtwork
      .getCurrentProductionAssetId(projectId)
      .catch(() => null);
    assert.equal(stillActive, null);

    // Q: the stale job (targeting the now-superseded approval) can never
    // transition the project to print_ready, even once "processed".
    await finalArtworkWorker.processNextJob();
    const afterStaleWorker = await conversation.get(projectId);
    assert.notEqual(afterStaleWorker?.project.status, "print_ready");

    // U: no duplicate FinalArtworkJob was created by any of the above.
    const project = await graph.finalArtwork.getCurrentProductionAssetId(projectId);
    assert.equal(project, null);
  });
});
