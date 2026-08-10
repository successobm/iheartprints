import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Live Acceptance UX Pass — the state a customer is actually left in once
 * a targeted revision finishes.
 *
 * Live failure this pins down: the assistant said "Here's your revised
 * concept. How does this version look?" and the customer had no way to
 * answer. Generation completion put the conversation back in
 * `concepts_ready`, which exists for "pick one of these three" and
 * deliberately refuses free-text chat — so the composer was dead, and the
 * Use This Design action (gated on the revision loop) never rendered.
 * Neither of the two things the question invites was possible.
 *
 * Deterministic throughout: the placeholder provider, no network, no paid
 * call. See `chat-affordances.test.ts` for the matching UI-side proof.
 */
describe("Post-revision chat state", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-post-revision-"));
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

  /** Interview → approve → three concepts → select the first one. */
  async function runToSelectedConcept(graph: Graph) {
    const { conversation, generationWorker } = graph;
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);
    await conversation.submitDesignBriefDecision(projectId, "approve");
    await generationWorker.processNextJob();

    const approved = await conversation.get(projectId);
    assert.ok(approved);
    assert.equal(approved.artworkVersions.length, 3);
    const originals = approved.artworkVersions.map((version) => version.id);

    await conversation.selectConcept(projectId, originals[0]!);
    return { projectId, originals };
  }

  /** ...then request one targeted revision and run it to completion. */
  async function runThroughRevision(graph: Graph) {
    const { projectId, originals } = await runToSelectedConcept(graph);
    await graph.conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );
    await graph.generationWorker.processNextJob();

    const after = await graph.conversation.get(projectId);
    assert.ok(after);
    assert.equal(after.artworkVersions.length, 4, "exactly one revised concept");
    return { projectId, originals, snapshot: after };
  }

  it("H: a finished targeted revision leaves the conversation in the revision loop, not concept selection", async () => {
    const graph = await freshGraph();
    const { snapshot } = await runThroughRevision(graph);

    assert.equal(snapshot.conversation.phase, "ask_revisions");

    // The assistant's own question is the one that has to be answerable.
    assert.match(snapshot.messages.at(-1)?.content ?? "", /revised concept/i);
  });

  it("H: the customer can immediately request ANOTHER change, and it enqueues another targeted revision", async () => {
    const graph = await freshGraph();
    const { projectId, snapshot } = await runThroughRevision(graph);
    const revisedId = snapshot.artworkVersions.at(-1)!.id;

    // Previously this threw "Please wait for the current step to finish".
    const afterSecond = await graph.conversation.handleUserMessage(
      projectId,
      "Actually, make the lettering bigger.",
    );

    assert.equal(afterSecond.project.revisionPending, true);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const targeted = (await repo.listGenerationJobs(projectId)).filter(
      (job) => job.targetArtworkVersionId != null,
    );
    assert.equal(targeted.length, 2, "a second targeted revision was queued");

    await graph.generationWorker.processNextJob();
    const afterSecondRun = await graph.conversation.get(projectId);
    assert.ok(afterSecondRun);
    assert.equal(afterSecondRun.artworkVersions.length, 5);
    // Still chained to the artwork it was revising, never back to the original.
    assert.equal(afterSecondRun.artworkVersions.at(-1)?.sourceArtworkVersionId, revisedId);
    assert.equal(afterSecondRun.conversation.phase, "ask_revisions");
  });

  it("I/J: the revised concept is selected and reviewable, but never silently confirmed as final", async () => {
    const graph = await freshGraph();
    const { snapshot } = await runThroughRevision(graph);
    const revised = snapshot.artworkVersions.at(-1)!;

    assert.equal(snapshot.project.selectedArtworkVersionId, revised.id);
    assert.equal(snapshot.project.revisionPending, false);
    // The one state that must NOT flip on its own — Use This Design is the
    // only thing that may set it, and Prepare Print-Ready stays unavailable
    // until it does.
    assert.equal(snapshot.project.finalDirectionConfirmed, false);
  });

  it("K: initial generation is unchanged — three concepts, and chat stays blocked until one is chosen", async () => {
    const graph = await freshGraph();
    const { conversation, generationWorker } = graph;
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);
    await conversation.submitDesignBriefDecision(projectId, "approve");

    // While generation is genuinely running, chat is refused.
    const generating = await conversation.get(projectId);
    assert.equal(generating?.conversation.phase, "generating");
    await assert.rejects(
      () => conversation.handleUserMessage(projectId, "any update?"),
      /wait for the current step/i,
    );

    await generationWorker.processNextJob();
    const ready = await conversation.get(projectId);
    assert.equal(ready?.conversation.phase, "concepts_ready");
    assert.equal(ready?.artworkVersions.length, 3);
    await assert.rejects(
      () => conversation.handleUserMessage(projectId, "I like the first one"),
      /wait for the current step/i,
    );
  });

  it("L: an earlier concept can still be re-selected after a revision, and that selection is unconfirmed", async () => {
    const graph = await freshGraph();
    const { projectId, originals, snapshot } = await runThroughRevision(graph);
    assert.notEqual(snapshot.project.selectedArtworkVersionId, originals[2]);

    const afterReselect = await graph.conversation.selectConcept(
      projectId,
      originals[2]!,
    );

    assert.equal(afterReselect.project.selectedArtworkVersionId, originals[2]);
    assert.equal(afterReselect.project.finalDirectionConfirmed, false);
    assert.equal(afterReselect.conversation.phase, "ask_revisions");
    // History is never destroyed by re-selecting.
    assert.equal(afterReselect.artworkVersions.length, 4);
  });
});
