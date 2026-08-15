import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint A4 Correction C — the email gate waits for a DELIVERED concept.
 *
 * THE LIVE DEFECT THIS FILE EXISTS FOR
 *
 * The funnel audit caught the customer being shown, at the same moment:
 *
 *   "Approved — generating concepts…"
 *   "Like where this is going? Enter your email to keep working on your design."
 *
 * The gate was derived from `snapshot.artworkVersions.length > 0`, and the
 * generation worker writes artwork rows several writes BEFORE the project
 * leaves `generating` and the `concepts_ready` anchor message the concept
 * grid renders against exists. So the address was asked for before the free
 * concept was visible — the toll booth in front of the value, which is
 * exactly what the A4 funnel is not.
 *
 * These tests run the REAL customer read path (`conversation-service`,
 * whose `resolveAcquisitionView` is the boundary that was wrong), against
 * the real local repository and the safe local provider double.
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (set by the test bootstrap preload)
 * independently forces every provider resolver to its local implementation,
 * so no paid image call is possible here.
 *
 * The pure condition itself is unit-tested in
 * `capabilities/shared/concept-delivery.test.ts`.
 */
describe("Sprint A4 Correction C — the email gate waits for a delivered concept", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-delivery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * The local store is ONE JSON file for the whole test file, and
   * `claimNextQueuedJob` claims the oldest due job across EVERY project —
   * real background work is not scoped to one caller. Retiring leftovers at
   * the start of each test keeps a test that deliberately leaves a job
   * queued from being processed by the next one's worker.
   */
  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }
    const service = await import("@/lib/services/conversation-service");
    return { repo, service, graph: getCapabilityGraph() };
  }

  type Context = Awaited<ReturnType<typeof freshGraph>>;

  /** A brand-new anonymous prospect, interviewed up to the Design Summary. */
  async function newProspect(context: Context) {
    const session = await context.repo.createAcquisitionSession(
      `token-${Math.random().toString(36).slice(2)}`,
    );
    const { projectId } = await runAdaptiveInterviewToSummary(
      {
        start: context.service.startConversation,
        handleUserMessage: context.service.handleUserMessage,
      },
      {},
      session.id,
    );
    return { sessionId: session.id, projectId };
  }

  function hasConceptsReadyAnchor(messages: { metadata: Record<string, unknown> }[]) {
    return messages.some((message) => message.metadata?.phase === "concepts_ready");
  }

  /* ================================================================== */
  /* A + F + Goal 9: the exact live bad state                            */
  /* ================================================================== */

  it("A/F: generated artwork already persisted while the project is still generating is NOT email_required", async () => {
    const context = await freshGraph();
    const { projectId } = await newProspect(context);

    // Approval consumes the one free concept and enqueues the durable job.
    // The worker is deliberately NOT run: this test is about the window
    // INSIDE it.
    const approved = await context.service.submitDesignBriefDecision(
      projectId,
      "approve",
    );
    assert.equal(approved.project.status, "generating");

    const version = approved.designBriefVersions.at(-1)!;
    const [job] = await context.repo.listGenerationJobs(projectId);
    assert.ok(job);

    // THE LIVE BAD STATE, reproduced exactly: the worker has written its
    // ArtworkVersion row and has not yet completed the job, moved the
    // project to `concepts_ready`, or written the anchor message.
    await context.repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "concept",
        title: "Concept A",
        summary: "Concept A",
        placeholderLabel: "Concept A",
        accentColor: "#123456",
        designBriefVersionId: version.id,
        generationJobId: job!.id,
        providerKey: "local",
        primaryAssetId: null,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);

    const midFlight = await context.service.getConversation(projectId);
    assert.ok(midFlight);
    assert.equal(midFlight!.project.status, "generating");
    assert.equal(midFlight!.artworkVersions.length, 1);
    // The customer cannot see anything yet — no anchor message exists.
    assert.equal(hasConceptsReadyAnchor(midFlight!.messages), false);

    // This is the assertion that fails on the old rule.
    assert.notEqual(midFlight!.acquisition.state, "email_required");
    assert.equal(midFlight!.acquisition.state, "free_concept_generating");
    assert.equal(midFlight!.acquisition.message, null);

    await context.repo.updateGenerationJob(job!.id, { status: "cancelled" });
  });

  /* ================================================================== */
  /* B + G: a genuinely delivered, genuinely renderable concept          */
  /* ================================================================== */

  it("B/G: once the concept is delivered and renderable, the email gate appears", async () => {
    const context = await freshGraph();
    const { projectId } = await newProspect(context);
    await context.service.submitDesignBriefDecision(projectId, "approve");
    await context.graph.generationWorker.processNextJob();

    const delivered = await context.service.getConversation(projectId);
    assert.ok(delivered);
    assert.equal(delivered!.project.status, "concepts_ready");

    // Renderability, asserted as the UI actually decides it: a current
    // generated concept plus the anchor message the grid hangs off.
    assert.equal(delivered!.conceptStatus.currentConcepts.length > 0, true);
    assert.equal(hasConceptsReadyAnchor(delivered!.messages), true);
    const raw = await context.repo.getProject(projectId);
    assert.equal(
      raw!.artworkVersions.every((artwork) => artwork.kind === "concept"),
      true,
    );

    assert.equal(delivered!.acquisition.state, "email_required");
    assert.equal(delivered!.acquisition.emailCaptured, false);
    assert.ok(delivered!.acquisition.message);
  });

  /* ================================================================== */
  /* C: after the address is captured                                    */
  /* ================================================================== */

  it("C: capturing the address moves the customer to the post-email state", async () => {
    const context = await freshGraph();
    const { projectId } = await newProspect(context);
    await context.service.submitDesignBriefDecision(projectId, "approve");
    await context.graph.generationWorker.processNextJob();

    const captured = await context.service.captureAcquisitionEmail(
      projectId,
      "prospect@example.com",
    );
    assert.equal(captured.ok, true);

    const after = await context.service.getConversation(projectId);
    assert.equal(after!.acquisition.state, "continue_locked");
    assert.equal(after!.acquisition.emailCaptured, true);
  });

  /* ================================================================== */
  /* Goal 6: the two states are mutually exclusive, turn by turn         */
  /* ================================================================== */

  it("the customer never sees 'generating concepts' and 'enter your email' for the same attempt", async () => {
    const context = await freshGraph();
    const { projectId } = await newProspect(context);

    const observed: string[] = [];
    const record = async () => {
      const snapshot = await context.service.getConversation(projectId);
      const generatingCopy =
        snapshot!.project.status === "generating" ||
        snapshot!.conversation.phase === "generating" ||
        snapshot!.conversation.phase === "brief_approved";
      assert.equal(
        generatingCopy && snapshot!.acquisition.state === "email_required",
        false,
        "the email gate appeared while the customer was still being told concepts were generating",
      );
      observed.push(snapshot!.acquisition.state);
    };

    await record();
    await context.service.submitDesignBriefDecision(projectId, "approve");
    await record();
    await context.graph.generationWorker.processNextJob();
    await record();

    // And the gate really does arrive — the invariant above is not being
    // satisfied by never gating at all.
    assert.equal(observed.at(-1), "email_required");
  });

  /* ================================================================== */
  /* Goal 8: spent, dispatched, never delivered                          */
  /* ================================================================== */

  it("a free attempt that was physically dispatched and produced nothing stays continue_locked, never email_required", async () => {
    const context = await freshGraph();
    const { projectId } = await newProspect(context);
    await context.service.submitDesignBriefDecision(projectId, "approve");

    const [job] = await context.repo.listGenerationJobs(projectId);
    // A real submission reached the provider boundary and the job then
    // ended with no artwork — the ambiguous-failure shape.
    const reserved = await context.repo.reservePaidImageIntent(projectId, {
      generationJobId: job!.id,
      intentKey: `${job!.id}::ordinal-1`,
      intentKind: "initial_concept",
      directionKey: "bold_direct",
      paidIntentOrdinal: 1,
      providerKey: "local",
    });
    assert.equal(reserved.outcome, "created");
    assert.ok(
      await context.repo.beginPaidImageIntentDispatch(
        reserved.outcome === "created" ? reserved.intent.id : "",
        "claim-token",
        1,
      ),
    );
    await context.repo.updateGenerationJob(job!.id, {
      status: "failed",
      lastError: "ambiguous",
    });
    await context.repo.setProjectStatus(projectId, "failed");

    const stranded = await context.service.getConversation(projectId);
    assert.equal(stranded!.artworkVersions.length, 0);
    assert.equal(stranded!.acquisition.state, "continue_locked");
    assert.notEqual(stranded!.acquisition.state, "email_required");
    assert.notEqual(stranded!.acquisition.state, "open");
    assert.notEqual(stranded!.acquisition.state, "free_concept_generating");
  });

  /* ================================================================== */
  /* D + E + Goal 10: Existing Artwork                                   */
  /* ================================================================== */

  it("D/E: a prepared upload is not a delivered free concept and never triggers the email gate", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession(
      `token-${Math.random().toString(36).slice(2)}`,
    );
    const created = await context.service.startConversation(session.id);
    const projectId = created.project.id;

    // Technical upload preparation, which legitimately creates an
    // ArtworkVersion row — and nothing about a free Create New concept.
    await context.repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: null,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);
    await context.repo.setProjectStatus(projectId, "approved");

    const uploaded = await context.service.getConversation(projectId);
    assert.equal(uploaded!.artworkVersions.length, 1);
    // The free concept was never spent, so this session is simply open —
    // and above all it is not being asked for an address.
    assert.notEqual(uploaded!.acquisition.state, "email_required");
    assert.equal(uploaded!.acquisition.state, "open");
    // No generated concept was ever produced for this project.
    assert.equal(uploaded!.conceptStatus.currentConcepts.length, 0);
  });

  it("Goal 10: a prepared upload does not deliver the free concept even after one was spent", async () => {
    const context = await freshGraph();
    const { projectId } = await newProspect(context);
    await context.service.submitDesignBriefDecision(projectId, "approve");

    const [job] = await context.repo.listGenerationJobs(projectId);
    // The free attempt is spent and produced nothing; a prepared upload is
    // then added. Row existence must not stand in for a generated concept.
    await context.repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: null,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);
    await context.repo.updateGenerationJob(job!.id, {
      status: "cancelled",
      lastError: null,
    });
    await context.repo.setProjectStatus(projectId, "approved");

    const mixed = await context.service.getConversation(projectId);
    assert.equal(mixed!.artworkVersions.length, 1);
    assert.notEqual(mixed!.acquisition.state, "email_required");
  });
});
