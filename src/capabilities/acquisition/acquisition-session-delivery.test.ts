import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import type { ProjectSnapshot } from "@/lib/domain/types";

import {
  EMAIL_REQUIRED_CONVERSATION_MESSAGE,
  FREE_CONCEPT_SPENT_MESSAGE,
} from "./acquisition-copy";

/**
 * Sprint A4 Correction C2 — delivery is a property of the SESSION, and
 * every surface that can ask for an address reads the same answer.
 *
 * THE LIVE DEFECT THIS FILE EXISTS FOR
 *
 * Correction C established what a delivered concept is and wired it into
 * one consumer: the acquisition state view behind the email-gate CARD. Two
 * other consumers of the same decision were left on their own rules, and
 * both of them write into the TRANSCRIPT — which is what the customer
 * actually reads:
 *
 *   refuseSpentFreeConcept        chose the email copy from `!session.email`
 *                                 alone, never asking whether a concept had
 *                                 been delivered at all.
 *   authorizeSessionContinuation  took `conceptDelivered` from its caller,
 *                                 computed as `artworkVersions.length > 0`
 *                                 — the pre-Correction-C rule.
 *
 * Manual replay: a second project in the same browser, on a session whose
 * free attempt was already spent. The card correctly read `continue_locked`
 * while the transcript said "Like where this is going? Enter your email to
 * keep working on your design." — on a project that had no job, no artwork,
 * and no concept, and never had.
 *
 * So every assertion here reads MESSAGE CONTENT, not just
 * `acquisition.state`. Asserting state alone is precisely what let the
 * defect through Correction C's test suite.
 *
 * Real repository, real conversation path, safe local provider double.
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (test bootstrap preload) independently
 * forces every provider resolver local, so no paid call is possible.
 */
describe("Sprint A4 Correction C2 — session-level delivery authority", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-session-delivery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    // The local store is one JSON file for the whole test file and
    // `claimNextQueuedJob` claims across every project — retire leftovers so
    // a test that deliberately leaves a job queued cannot be processed by
    // the next test's worker.
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }
    const service = await import("@/lib/services/conversation-service");
    return { repo, service, graph: getCapabilityGraph() };
  }

  type Context = Awaited<ReturnType<typeof freshGraph>>;

  const ANSWERS: Record<string, string> = {
    product: "T-shirts",
    graphics: "A friendly bear logo for summer camp",
    productColor: "Navy",
    requiredWording: "Camp Wildwood 2026",
  };

  /** Drives the real adaptive interview to the Design Summary gate. */
  async function interview(context: Context, projectId: string, started: ProjectSnapshot) {
    let snapshot = started;
    for (let turn = 0; turn < 20; turn += 1) {
      if (snapshot.conversation.phase === "awaiting_summary_confirmation") return;
      const pending = snapshot.conversation.interviewState.pendingSection;
      const reply = (pending && ANSWERS[pending]) || "You choose.";
      snapshot = (await context.service.handleUserMessage(
        projectId,
        reply,
      )) as unknown as ProjectSnapshot;
    }
    throw new Error("interview did not reach the Design Summary");
  }

  function transcript(snapshot: { messages: { content: string }[] }): string {
    return snapshot.messages.map((message) => message.content).join("\n");
  }

  /**
   * Project A spends the session's free attempt. `deliver` decides whether
   * the worker actually runs and produces a customer-ready concept.
   */
  async function spendFreeAttempt(context: Context, sessionId: string, deliver: boolean) {
    const started = await context.service.startConversation(sessionId);
    const projectId = started.project.id;
    await interview(context, projectId, started as unknown as ProjectSnapshot);
    await context.service.submitDesignBriefDecision(projectId, "approve");
    if (deliver) {
      await context.graph.generationWorker.processNextJob();
    } else {
      // The attempt is durably spent AND physically dispatched — the job
      // exists, the claim is taken, a request reached the provider
      // boundary — but nothing was ever shown to the customer. (A dispatch
      // is needed for the honest `continue_locked`: an attempt stopped by
      // local configuration before any submission leaves the free concept
      // intact and stays `open`, per Correction 3.)
      const [job] = await context.repo.listGenerationJobs(projectId);
      const reserved = await context.repo.reservePaidImageIntent(projectId, {
        generationJobId: job!.id,
        intentKey: `${job!.id}::ordinal-1`,
        intentKind: "initial_concept",
        directionKey: "batch",
        paidIntentOrdinal: 1,
        providerKey: "local",
      });
      if (reserved.outcome !== "created") throw new Error("intent not reserved");
      await context.repo.beginPaidImageIntentDispatch(
        reserved.intent.id,
        "claim-token",
        1,
      );
      await context.repo.updateGenerationJob(job!.id, {
        status: "failed",
        lastError: "ambiguous",
      });
      await context.repo.setProjectStatus(projectId, "failed");
    }
    return projectId;
  }

  /* ================================================================== */
  /* GOAL 5 — the exact live shape: second project, nothing delivered    */
  /* ================================================================== */

  it("Goal 5: a second project on a spent-but-undelivered session is never asked for an email", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("c2-undelivered");
    const projectA = await spendFreeAttempt(context, session.id, false);

    // Sanity: the session really is spent, and really delivered nothing.
    assert.ok(await context.repo.getFreeConceptClaim(session.id));
    const rawA = await context.repo.getProject(projectA);
    assert.equal(rawA!.artworkVersions.length, 0);

    // Project B — the customer starts a second design in the same browser.
    const startedB = await context.service.startConversation(session.id);
    const projectB = startedB.project.id;

    // The interview is NOT gated: nothing was ever delivered, so there is
    // nothing an address would unlock.
    await interview(context, projectB, startedB as unknown as ProjectSnapshot);
    const afterInterview = await context.repo.getProject(projectB);
    assert.equal(
      transcript(afterInterview!).includes(EMAIL_REQUIRED_CONVERSATION_MESSAGE),
      false,
      "the interview asked for an email before any concept was delivered",
    );
    // Goal 5: the customer's turns were answered, not discarded.
    assert.equal(
      afterInterview!.messages.some((message) => message.role === "user"),
      true,
    );

    // Approving is refused — the free attempt is gone — and this is the
    // exact moment the live transcript said "enter your email".
    await context.service.submitDesignBriefDecision(projectB, "approve");

    const rawB = await context.repo.getProject(projectB);
    const apiB = await context.service.getConversation(projectB);

    assert.equal(await context.repo.listGenerationJobs(projectB).then((j) => j.length), 0);
    assert.equal(
      (await context.repo.getAcquisitionSession(session.id))!.freeConceptProjectId,
      projectA,
      "a second free entitlement was handed out",
    );

    // THE ASSERTION THAT FAILS ON THE OLD CODE.
    assert.equal(
      transcript(rawB!).includes(EMAIL_REQUIRED_CONVERSATION_MESSAGE),
      false,
      "the transcript asked for an email on a project that never showed a concept",
    );
    // …and the honest sentence IS there, the same one the card shows.
    assert.equal(transcript(rawB!).includes(FREE_CONCEPT_SPENT_MESSAGE), true);
    assert.equal(apiB!.acquisition.state, "continue_locked");
    assert.equal(apiB!.acquisition.message, FREE_CONCEPT_SPENT_MESSAGE);
    // Goal 4: card and transcript now say the same thing.
    assert.equal(transcript(rawB!).includes(apiB!.acquisition.message!), true);
  });

  /* ================================================================== */
  /* GOAL 6 — the positive mirror: delivery follows the SESSION          */
  /* ================================================================== */

  it("Goal 6: once the session HAS been given its concept, a second project may ask for the email", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("c2-delivered");
    const projectA = await spendFreeAttempt(context, session.id, true);

    const rawA = await context.repo.getProject(projectA);
    assert.equal(rawA!.project.status, "concepts_ready");
    assert.equal(
      rawA!.artworkVersions.some((artwork) => artwork.kind === "concept"),
      true,
    );

    // Project B holds no evidence of any of that — which is the whole
    // point: the entitlement is the session's, not the project's.
    const startedB = await context.service.startConversation(session.id);
    const projectB = startedB.project.id;
    const gated = await context.service.handleUserMessage(
      projectB,
      "I'd like a design for our hockey team",
    );

    assert.equal(gated.artworkVersions.length, 0);
    assert.equal(
      transcript(gated).includes(EMAIL_REQUIRED_CONVERSATION_MESSAGE),
      true,
    );
    // Goal 15: the refused turn is not persisted.
    assert.equal(
      gated.messages.some((message) => message.role === "user"),
      false,
    );
    // Goal 4: the card agrees on this project too.
    const apiB = await context.service.getConversation(projectB);
    assert.equal(apiB!.acquisition.state, "email_required");
  });

  it("Goal 4: capturing the address silences the email copy on every surface", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("c2-email");
    const projectA = await spendFreeAttempt(context, session.id, true);
    assert.equal(
      (await context.service.captureAcquisitionEmail(projectA, "p@example.com")).ok,
      true,
    );

    const startedB = await context.service.startConversation(session.id);
    const projectB = startedB.project.id;
    const after = await context.service.handleUserMessage(
      projectB,
      "another design please",
    );

    assert.equal(
      transcript(after).includes(EMAIL_REQUIRED_CONVERSATION_MESSAGE),
      false,
    );
    const apiB = await context.service.getConversation(projectB);
    assert.equal(apiB!.acquisition.state, "continue_locked");
    assert.equal(apiB!.acquisition.emailCaptured, true);
  });

  /* ================================================================== */
  /* GOAL 7 — a prepared upload is never a delivered free concept        */
  /* ================================================================== */

  it("Goal 7: a prepared_upload row does not satisfy delivery, on any surface", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("c2-upload");
    await spendFreeAttempt(context, session.id, false);

    // An Existing Artwork project in the same session. Technical upload
    // preparation legitimately creates an ArtworkVersion — and it is the
    // customer's OWN artwork, never the free Create New concept.
    const startedB = await context.service.startConversation(session.id);
    const projectB = startedB.project.id;
    await context.repo.addArtworkVersions(projectB, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "background removed",
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

    const after = await context.service.handleUserMessage(
      projectB,
      "can you make it bigger",
    );

    // Before C2 this exact turn was refused with the email copy, and the
    // customer's message was thrown away.
    assert.equal(
      transcript(after).includes(EMAIL_REQUIRED_CONVERSATION_MESSAGE),
      false,
    );
    assert.equal(
      after.messages.some(
        (message) =>
          message.role === "user" && message.content === "can you make it bigger",
      ),
      true,
      "the customer's message was discarded because of a prepared_upload row",
    );
  });

  /* ================================================================== */
  /* GOAL 8 — Correction C's generating window, preserved                */
  /* ================================================================== */

  it("Goal 8: an artwork row written mid-generation is not delivery, on any surface", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("c2-generating");
    const started = await context.service.startConversation(session.id);
    const projectId = started.project.id;
    await interview(context, projectId, started as unknown as ProjectSnapshot);
    const approved = await context.service.submitDesignBriefDecision(
      projectId,
      "approve",
    );
    const version = approved.designBriefVersions.at(-1)!;
    const [job] = await context.repo.listGenerationJobs(projectId);

    // The worker's first write, mid-run: rows exist, the job is not
    // complete, the project has not left `generating`, and no
    // `concepts_ready` anchor has been written.
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
    assert.equal(midFlight!.project.status, "generating");
    assert.equal(midFlight!.acquisition.state, "free_concept_generating");

    // The session-level authority agrees — asked from a SECOND project,
    // where the generating project's rows are the only evidence there is.
    const startedB = await context.service.startConversation(session.id);
    const apiB = await context.service.getConversation(startedB.project.id);
    assert.notEqual(apiB!.acquisition.state, "email_required");
    const rawB = await context.repo.getProject(startedB.project.id);
    assert.equal(
      transcript(rawB!).includes(EMAIL_REQUIRED_CONVERSATION_MESSAGE),
      false,
    );

    await context.repo.updateGenerationJob(job!.id, { status: "cancelled" });
  });
});
