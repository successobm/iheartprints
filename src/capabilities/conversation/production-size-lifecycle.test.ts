import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { deriveProductionRequirements } from "@/capabilities/print-validation/production-requirements";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Live Acceptance Cleanup — Issue 5, end to end through the lifecycle.
 *
 * The rule this file exists to pin: a PRODUCTION-SIZE change is not a
 * creative revision. "Make the print 12 inches wide" must change what the
 * production pipeline is told to produce and nothing else — no new
 * `ArtworkVersion`, no generation job, no image-provider call, no new
 * approved brief version, no concept staleness.
 *
 * Deterministic throughout: placeholder provider, no network, no paid call.
 */
describe("Production size lifecycle", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-print-size-"));
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

  /** Interview → approve → concepts → select → confirm final direction. */
  async function runToConfirmedDirection(graph: Graph) {
    const { conversation, generationWorker } = graph;
    // Print placement is required before any production size can be stated
    // honestly — the interview helper otherwise defers it to the designer.
    const { projectId } = await runAdaptiveInterviewToSummary(conversation, {
      printLocation: "Full front",
    });
    await conversation.submitDesignBriefDecision(projectId, "approve");
    await generationWorker.processNextJob();

    const ready = await conversation.get(projectId);
    const concepts = ready!.artworkVersions.map((version) => version.id);
    await conversation.selectConcept(projectId, concepts[0]!);
    await conversation.confirmSelectedDirection(projectId, concepts[0]!);

    return { projectId, concepts };
  }

  it("18: a chosen width persists as authoritative production intent", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConfirmedDirection(graph);

    const before = await graph.conversation.get(projectId);
    assert.equal(before!.brief.intendedPrintWidthIn, null, "no choice yet");

    await graph.conversation.setProductionPrintWidth(projectId, 12);

    const after = await graph.conversation.get(projectId);
    assert.equal(after!.brief.intendedPrintWidthIn, 12);

    // And it is what the production pipeline will actually be told to make.
    const requirements = deriveProductionRequirements({
      printPlacement: after!.brief.printPlacement,
      productSummary: after!.brief.productSummary,
      designDescription: after!.brief.designDescription,
      intendedPrintWidthIn: after!.brief.intendedPrintWidthIn,
    });
    assert.equal(requirements.sizing!.targetWidthIn, 12);
    assert.equal(requirements.sizing!.targetPpi, 300);
  });

  it("19: a size change creates no ArtworkVersion, no generation job, and no brief version", async () => {
    const graph = await freshGraph();
    const { projectId, concepts } = await runToConfirmedDirection(graph);

    const before = await graph.conversation.get(projectId);
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const jobsBefore = await repo.listGenerationJobs(projectId);

    await graph.conversation.setProductionPrintWidth(projectId, 12);

    const after = await graph.conversation.get(projectId);

    assert.equal(
      after!.artworkVersions.length,
      before!.artworkVersions.length,
      "resizing the print never produces new artwork",
    );
    assert.deepEqual(
      after!.artworkVersions.map((version) => version.id).sort(),
      [...concepts].sort(),
    );
    assert.equal(
      after!.designBriefVersions.length,
      before!.designBriefVersions.length,
      "size is a production spec, never an approved-brief change",
    );
    assert.equal(
      (await repo.listGenerationJobs(projectId)).length,
      jobsBefore.length,
      "no generation work is enqueued",
    );
    assert.equal(
      (await graph.generationWorker.processNextJob()).processedJobId,
      null,
      "and nothing is left claimable — no provider call can occur",
    );

    // The approved creative direction survives untouched.
    assert.equal(after!.project.selectedArtworkVersionId, concepts[0]);
    assert.equal(after!.project.finalDirectionConfirmed, true);
    assert.equal(after!.project.revisionPending, false);
  });

  it("19b: a size change never marks concepts stale", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConfirmedDirection(graph);

    await graph.conversation.setProductionPrintWidth(projectId, 12);

    const after = await graph.conversation.get(projectId);
    const status = graph.conceptGeneration.describeConceptStatus(
      after!.brief,
      after!.artworkVersions,
      after!.designBriefVersions,
    );
    assert.equal(status.status, "current");

    // And finalization stays available — a resize is not a pending revision.
    const result = await graph.finalArtwork.requestFinalArtwork(
      projectId,
      after!.project.selectedArtworkVersionId!,
    );
    assert.ok(result.job);
  });

  it("19c: 'make the print 12 inches wide' in chat is a size change, not a revision", async () => {
    const graph = await freshGraph();
    const { projectId, concepts } = await runToConfirmedDirection(graph);

    await graph.conversation.handleUserMessage(
      projectId,
      "make the print 12 inches wide",
    );

    const after = await graph.conversation.get(projectId);
    assert.equal(after!.brief.intendedPrintWidthIn, 12);
    assert.equal(after!.artworkVersions.length, concepts.length);
    assert.equal(after!.project.revisionPending, false);
    assert.equal(
      (await graph.generationWorker.processNextJob()).processedJobId,
      null,
    );

    const reply = after!.messages.at(-1)!;
    assert.equal(reply.role, "assistant");
    assert.match(reply.content, /12" wide/);
    assert.match(reply.content, /design itself stays exactly as you approved it/i);
  });

  it("19d: a creative instruction at the same stage is still a creative revision", async () => {
    const graph = await freshGraph();
    const { projectId, concepts } = await runToConfirmedDirection(graph);

    // The counterexample that keeps the size detector honest: "make it
    // smaller" is about the artwork, and must not be swallowed as a resize.
    await graph.conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );

    const after = await graph.conversation.get(projectId);
    assert.equal(
      after!.brief.intendedPrintWidthIn,
      null,
      "no production size was set",
    );
    assert.equal(after!.project.revisionPending, true);

    await graph.generationWorker.processNextJob();
    const revised = await graph.conversation.get(projectId);
    assert.equal(revised!.artworkVersions.length, concepts.length + 1);
  });

  it("17/18b: an out-of-band request is clamped and the customer is told plainly", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConfirmedDirection(graph);

    await graph.conversation.setProductionPrintWidth(projectId, 30);

    const after = await graph.conversation.get(projectId);
    assert.equal(after!.brief.intendedPrintWidthIn, 14, "clamped to what fits");
    assert.match(after!.messages.at(-1)!.content, /is what fits this print location/i);
  });

  it("22: a stale or direct finalize request cannot ignore the chosen production size", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConfirmedDirection(graph);
    await graph.conversation.setProductionPrintWidth(projectId, 12);

    const snapshot = await graph.conversation.get(projectId);
    const artworkVersionId = snapshot!.project.selectedArtworkVersionId!;

    // `requestFinalArtwork` accepts only an artwork id — there is no size
    // parameter anywhere on the request path, so no caller can supply one.
    // The worker reads the persisted intent instead.
    await graph.finalArtwork.requestFinalArtwork(projectId, artworkVersionId);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    assert.ok(approval);

    const persisted = await repo.getProject(projectId);
    assert.equal(
      persisted!.brief.intendedPrintWidthIn,
      12,
      "the width the worker will read is the one the customer chose",
    );

    const requirements = deriveProductionRequirements({
      printPlacement: persisted!.brief.printPlacement,
      productSummary: persisted!.brief.productSummary,
      designDescription: persisted!.brief.designDescription,
      intendedPrintWidthIn: persisted!.brief.intendedPrintWidthIn,
    });
    assert.equal(requirements.sizing!.targetWidthIn, 12);
    // 300 DPI at the chosen width — never a silently lower effective DPI.
    assert.equal(
      Math.round(requirements.sizing!.targetWidthIn * requirements.sizing!.targetPpi),
      3600,
    );
  });

  it("the size cannot be changed once production is already under way", async () => {
    const graph = await freshGraph();
    const { projectId } = await runToConfirmedDirection(graph);
    const snapshot = await graph.conversation.get(projectId);

    await graph.finalArtwork.requestFinalArtwork(
      projectId,
      snapshot!.project.selectedArtworkVersionId!,
    );

    await assert.rejects(
      () => graph.conversation.setProductionPrintWidth(projectId, 12),
      /being prepared right now/i,
    );
  });
});
