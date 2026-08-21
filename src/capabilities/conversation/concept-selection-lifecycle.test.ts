import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Live Acceptance Cleanup — Issue 2 (unselect) and Issue 3 (a new batch of
 * concepts from the same approved brief).
 *
 * Both exist for the same live gap: once the customer had chosen — or
 * disliked — a concept, the only escape hatch was "Start Over", which throws
 * away a Design Brief that is usually perfectly correct.
 *
 * Deterministic throughout: placeholder provider, no network, no paid call.
 */
describe("Concept selection lifecycle", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-selection-"));
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

  type Graph = Awaited<ReturnType<typeof freshGraph>>;

  /** Interview → approve → three concepts. */
  async function runToConcepts(
    graph: Graph,
    answerOverrides: Partial<Record<string, string>> = {},
  ) {
    const { conversation, generationWorker } = graph;
    const { projectId } = await runAdaptiveInterviewToSummary(
      conversation,
      answerOverrides,
    );
    await conversation.submitDesignBriefDecision(projectId, "approve");
    await generationWorker.processNextJob();

    const snapshot = await conversation.get(projectId);
    assert.ok(snapshot);
    assert.equal(snapshot.artworkVersions.length, 3);
    return {
      projectId,
      originals: snapshot.artworkVersions.map((version) => version.id),
    };
  }

  async function runToSelectedConcept(
    graph: Graph,
    answerOverrides: Partial<Record<string, string>> = {},
  ) {
    const { projectId, originals } = await runToConcepts(graph, answerOverrides);
    await graph.conversation.selectConcept(projectId, originals[0]!);
    return { projectId, originals };
  }

  // --- Issue 2: unselect ---------------------------------------------------

  it("3: a selected concept can be explicitly unselected", async () => {
    const graph = await freshGraph();
    const { projectId, originals } = await runToSelectedConcept(graph);

    const selected = await graph.conversation.get(projectId);
    assert.equal(selected!.project.selectedArtworkVersionId, originals[0]);

    const cleared = await graph.conversation.unselectConcept(projectId);
    assert.equal(cleared.project.selectedArtworkVersionId, null);
  });

  it("4: unselect clears the authoritative selection on BOTH the project and the artwork rows", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToSelectedConcept(graph);

    const cleared = await graph.conversation.unselectConcept(projectId);

    assert.equal(cleared.project.selectedArtworkVersionId, null);
    assert.equal(
      cleared.artworkVersions.some((version) => version.isSelected),
      false,
      "no artwork row may still claim to be selected",
    );
    // A confirmation can never outlive the selection it was made about.
    assert.equal(cleared.project.finalDirectionConfirmed, false);
    // Selection state is never re-derived from a client hint: refetching
    // proves it was persisted, not just returned.
    const refetched = await graph.conversation.get(projectId);
    assert.equal(refetched!.project.selectedArtworkVersionId, null);
  });

  it("5: unselect deletes no concepts, batches, or history", async () => {
    const graph = await freshGraph();
    const { projectId, originals } = await runToSelectedConcept(graph);

    const cleared = await graph.conversation.unselectConcept(projectId);

    assert.equal(cleared.artworkVersions.length, 3);
    assert.deepEqual(
      cleared.artworkVersions.map((version) => version.id).sort(),
      [...originals].sort(),
    );
    assert.equal(cleared.designBriefVersions.length, 1, "brief history intact");
  });

  it("5b: unselect never generates anything", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToSelectedConcept(graph);

    await graph.conversation.unselectConcept(projectId);

    const processed = await graph.generationWorker.processNextJob();
    assert.equal(
      processed.processedJobId,
      null,
      "unselect must not enqueue any generation work",
    );
  });

  it("6: finalization is unavailable after unselect", async () => {
    const graph = await freshGraph();
    const { projectId, originals } = await runToSelectedConcept(graph);
    await graph.conversation.confirmSelectedDirection(projectId, originals[0]!);

    await graph.conversation.unselectConcept(projectId);

    await assert.rejects(
      () => graph.finalArtwork.requestFinalArtwork(projectId, originals[0]!),
      /Select this concept/i,
      "the server, not the UI, is the gate",
    );
  });

  it("6b: an active final-direction approval is explicitly superseded, never left orphaned", async () => {
    const graph = await freshGraph();
    // Print'em All Phase 1: the print location is answered DURING the
    // interview rather than patched in afterwards. There is no honest size
    // recommendation without a placement, and setting one after the brief is
    // approved would (correctly) mark the concepts stale — placement is
    // concept-relevant, unlike physical size.
    const { projectId, originals } = await runToSelectedConcept(graph, {
      printLocation: "Full front",
    });
    await graph.conversation.confirmSelectedDirection(projectId, originals[0]!);
    // Confirming the DESIGN and confirming the PRINT SIZE are separate
    // decisions, and production requires both.
    await graph.conversation.confirmRecommendedProductionSize(projectId);
    await graph.finalArtwork.requestFinalArtwork(projectId, originals[0]!);

    // A queued FinalArtworkJob exists, so unselect must refuse rather than
    // silently invalidate production work already in motion.
    await assert.rejects(
      () => graph.conversation.unselectConcept(projectId),
      /being prepared/i,
    );

    const stillSelected = await graph.conversation.get(projectId);
    assert.equal(stillSelected!.project.selectedArtworkVersionId, originals[0]);
  });

  it("6c: unselect is idempotent and refuses while a revision is in flight", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToSelectedConcept(graph);

    await graph.conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );
    const pending = await graph.conversation.get(projectId);
    assert.equal(pending!.project.revisionPending, true);

    await assert.rejects(
      () => graph.conversation.unselectConcept(projectId),
      /still updating/i,
    );

    await graph.generationWorker.processNextJob();
    const revised = await graph.conversation.get(projectId);
    await graph.conversation.unselectConcept(projectId);

    // Second call is a no-op, not an error and not a duplicate message.
    const twice = await graph.conversation.unselectConcept(projectId);
    assert.equal(twice.project.selectedArtworkVersionId, null);
    assert.equal(
      twice.artworkVersions.length,
      revised!.artworkVersions.length,
      "nothing was created or destroyed",
    );
  });

  // --- Issue 3: a new batch from the same approved brief -------------------

  it("7 & 8 & 9: a second batch of three is generated, the first is retained, and the brief is not reset", async () => {
    const graph = await freshGraph();
    const { projectId, originals } = await runToConcepts(graph);

    const briefBefore = (await graph.conversation.get(projectId))!.brief;

    await graph.conversation.exploreNewConceptBatch(projectId);
    await graph.generationWorker.processNextJob();

    const snapshot = await graph.conversation.get(projectId);
    assert.ok(snapshot);

    // 7: a second batch of three exists.
    assert.equal(snapshot.artworkVersions.length, 6);

    // 8: every original concept is still there, untouched.
    for (const id of originals) {
      assert.ok(
        snapshot.artworkVersions.some((version) => version.id === id),
        "prior batch must be retained",
      );
    }

    // 9: no brief reset — same working brief, same single approved version.
    assert.equal(snapshot.designBriefVersions.length, 1);
    assert.equal(snapshot.brief.productSummary, briefBefore.productSummary);
    assert.equal(snapshot.brief.designDescription, briefBefore.designDescription);
    assert.equal(snapshot.brief.exactText, briefBefore.exactText);
    assert.equal(snapshot.brief.shirtColor, briefBefore.shirtColor);
    assert.equal(snapshot.brief.printPlacement, briefBefore.printPlacement);
  });

  it("7b: the new batch is current and the prior batch becomes a previous batch, still selectable", async () => {
    const graph = await freshGraph();
    const { projectId, originals } = await runToConcepts(graph);

    await graph.conversation.exploreNewConceptBatch(projectId);
    await graph.generationWorker.processNextJob();

    const snapshot = await graph.conversation.get(projectId);
    const status = graph.conceptGeneration.describeConceptStatus(
      snapshot!.brief,
      snapshot!.artworkVersions,
      snapshot!.designBriefVersions,
    );

    assert.equal(status.currentConcepts.length, 3, "only the newest batch is current");
    assert.equal(
      status.currentConcepts.some((concept) => originals.includes(concept.id)),
      false,
      "the new batch is genuinely new artwork, not the old batch relabeled",
    );
    assert.equal(status.previousBatches.length, 1);
    assert.deepEqual(
      status.previousBatches[0]!.map((concept) => concept.id).sort(),
      [...originals].sort(),
    );

    // Still selectable — retention is meaningless if the customer can't act on it.
    const reselected = await graph.conversation.selectConcept(
      projectId,
      originals[1]!,
    );
    assert.equal(reselected.project.selectedArtworkVersionId, originals[1]);
  });

  it("10: a double request never duplicates the batch or the job", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConcepts(graph);

    await graph.conversation.exploreNewConceptBatch(projectId);
    // Second click before the worker picks anything up — the exact live race.
    await graph.conversation.exploreNewConceptBatch(projectId);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const jobs = await repo.listGenerationJobs(projectId);
    const explorations = jobs.filter((job) => !job.targetArtworkVersionId);
    assert.equal(explorations.length, 2, "the initial job plus exactly one new one");

    await graph.generationWorker.processNextJob();
    await graph.generationWorker.processNextJob();

    const snapshot = await graph.conversation.get(projectId);
    assert.equal(
      snapshot!.artworkVersions.length,
      6,
      "two batches of three — never three batches",
    );
  });

  it("10b: a new batch infers no selection and no final approval", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConcepts(graph);

    await graph.conversation.exploreNewConceptBatch(projectId);
    await graph.generationWorker.processNextJob();

    const snapshot = await graph.conversation.get(projectId);
    assert.equal(snapshot!.project.selectedArtworkVersionId, null);
    assert.equal(snapshot!.project.finalDirectionConfirmed, false);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    assert.equal(
      await repo.getActiveFinalDirectionApproval(projectId),
      null,
      "exploring new directions never approves anything",
    );
  });
});
