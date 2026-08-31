import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { CREATE_NEW_WORKFLOW } from "@/lib/domain/conversation";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Correction A — the Create New workflow transition, server side.
 *
 * THE DEFECT
 *
 * "Create New Artwork" was implemented as a synthetic customer message,
 * "I'd like you to design new artwork for me.". It rendered as a customer
 * chat bubble nobody typed, and because it went through `/messages` it was
 * run through Intent Extraction, landed in the Design Brief's Additional
 * Notes, and headed for the generation prompt. A workflow choice is control
 * state; the customer's message channel is for the customer's own words.
 *
 * This file drives the REAL conversation-service path — the same module the
 * API route calls — against the real local repository and the safe local
 * provider double. `IHEARTPRINTS_AUTOMATED_TEST=1` (bootstrap preload)
 * independently forces every provider resolver local, so no paid call is
 * possible.
 */
describe("Correction A — the Create New workflow transition", () => {
  let tempDir = "";
  let previousCwd = "";

  const SYNTHETIC_INTENT = "I'd like you to design new artwork for me.";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-create-new-"));
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
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }
    const service = await import("@/lib/services/conversation-service");
    return { repo, service, graph: getCapabilityGraph() };
  }

  function userTurns(snapshot: { messages: { role: string; content: string }[] }) {
    return snapshot.messages.filter((message) => message.role === "user");
  }

  function markerCount(snapshot: { messages: { metadata: Record<string, unknown> }[] }) {
    return snapshot.messages.filter(
      (message) => message.metadata?.workflow === CREATE_NEW_WORKFLOW,
    ).length;
  }

  /* ================================================================== */
  /* The transition itself                                               */
  /* ================================================================== */

  it("adds an assistant question and NO customer message", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;
    assert.equal(started.messages.length, 1);

    const after = await context.service.beginCreateNewWorkflow(projectId);

    // The whole point: the customer said nothing, so nothing appears as if
    // they had.
    assert.deepEqual(userTurns(after), []);
    assert.equal(
      after.messages.some((message) => message.content.includes(SYNTHETIC_INTENT)),
      false,
    );
    // The interview moved forward and said so.
    assert.equal(after.messages.length, 2);
    const added = after.messages.at(-1)!;
    assert.equal(added.role, "assistant");
    assert.ok(added.content.trim().length > 0);
    assert.equal(added.metadata.workflow, CREATE_NEW_WORKFLOW);
    // The wording is the interview engine's own, not copy invented here.
    assert.equal(added.metadata.section, "product");
    assert.equal(after.conversation.phase, "interviewing");
    assert.equal(after.conversation.interviewState.pendingSection, "product");
  });

  it("touches no Design Brief field", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const before = started.brief;
    const after = await context.service.beginCreateNewWorkflow(started.project.id);

    for (const key of [
      "productSummary",
      "designDescription",
      "exactText",
      "shirtColor",
      "printPlacement",
      "designStyle",
      "additionalInstructions",
      "audience",
      "purpose",
      "exclusions",
    ] as const) {
      assert.equal(after.brief[key], before[key], `brief.${key} changed`);
    }
    assert.deepEqual(after.brief.preferredColors, before.preferredColors);
    assert.equal(
      JSON.stringify(after.brief).includes(SYNTHETIC_INTENT),
      false,
    );
  });

  it("creates no generation job and consumes no free entitlement", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("create-new-a");
    const started = await context.service.startConversation(session.id);
    await context.service.beginCreateNewWorkflow(started.project.id);

    assert.equal(
      (await context.repo.listGenerationJobs(started.project.id)).length,
      0,
    );
    const after = await context.repo.getAcquisitionSession(session.id);
    assert.equal(after?.freeConceptProjectId, null);
    assert.equal(after?.freeConceptGenerationJobId, null);
    assert.equal(await context.repo.getFreeConceptClaim(session.id), null);
    // Nothing is gated — choosing a workflow is not a paid-value action.
    const api = await context.service.getConversation(started.project.id);
    assert.equal(api!.acquisition.state, "open");
  });

  /* ================================================================== */
  /* Idempotency (Goal 11)                                               */
  /* ================================================================== */

  it("is idempotent across a double click, a retry, and a reload", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;

    await context.service.beginCreateNewWorkflow(projectId);
    await context.service.beginCreateNewWorkflow(projectId);
    const third = await context.service.beginCreateNewWorkflow(projectId);

    assert.equal(third.messages.length, 2, "the question was asked more than once");
    assert.equal(markerCount(third), 1);
    assert.deepEqual(userTurns(third), []);
    assert.equal((await context.repo.listGenerationJobs(projectId)).length, 0);
  });

  it("simultaneous requests stay harmless even where they are not deduplicated", async () => {
    // HONEST LIMIT. The guard is read-then-write and re-checked immediately
    // before the append, which covers everything a browser can produce: the
    // card disables both buttons while a request is in flight, so a double
    // click, a retry after a lost response, and a reload are all sequential
    // (proved above). Two requests issued at the very same instant — only
    // reachable by calling the API directly — can still both append,
    // because neither the local store nor the schema offers a uniqueness
    // constraint to serialize them, and adding a column for it is exactly
    // the schema work this correction was told not to do.
    //
    // What this test pins is that the unguarded case degrades to a repeated
    // QUESTION and nothing worse: no customer turn, no brief change, no
    // job, and the card still stays dismissed.
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;

    await Promise.all([
      context.service.beginCreateNewWorkflow(projectId),
      context.service.beginCreateNewWorkflow(projectId),
    ]);

    const reloaded = (await context.service.getConversation(projectId))!;
    assert.deepEqual(userTurns(reloaded), []);
    assert.equal(reloaded.brief.additionalInstructions, null);
    assert.equal(reloaded.brief.productSummary, null);
    assert.equal((await context.repo.listGenerationJobs(projectId)).length, 0);
    assert.ok(markerCount(reloaded) >= 1);

    const { isAtProjectStart } = await import(
      "@/components/chat/uploaded-artwork-flow"
    );
    assert.equal(
      isAtProjectStart({
        messages: reloaded.messages,
        artworkVersionCount: reloaded.artworkVersions.length,
      }),
      false,
    );

    // And once anything exists, a further request is a clean no-op.
    const before = reloaded.messages.length;
    const again = await context.service.beginCreateNewWorkflow(projectId);
    assert.equal(again.messages.length, before);
  });

  it("never interrupts an interview the customer already started", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;
    const typed = await context.service.handleUserMessage(projectId, "T-shirts");
    const before = typed.messages.length;

    const after = await context.service.beginCreateNewWorkflow(projectId);
    assert.equal(after.messages.length, before);
    assert.equal(markerCount(after), 0);
  });

  it("refuses a project that does not exist", async () => {
    const context = await freshGraph();
    await assert.rejects(
      () =>
        context.service.beginCreateNewWorkflow(
          "00000000-0000-4000-8000-000000000000",
        ),
      /not found/i,
    );
  });

  /* ================================================================== */
  /* Durability (Goal 10)                                                */
  /* ================================================================== */

  it("survives reload — the workflow card is not re-offered", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;
    await context.service.beginCreateNewWorkflow(projectId);

    // A brand-new read, as a page reload performs.
    const reloaded = await context.service.getConversation(projectId);
    const { isAtProjectStart, deriveUploadedArtworkStep } = await import(
      "@/components/chat/uploaded-artwork-flow"
    );
    const atStart = isAtProjectStart({
      messages: reloaded!.messages,
      artworkVersionCount: reloaded!.artworkVersions.length,
    });
    assert.equal(atStart, false);
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        signArtwork: null,
        choice: "undecided",
        artworkTypeChoice: "undecided",
        atProjectStart: atStart,
      }),
      null,
      "the workflow card reappeared after reload",
    );

    // And a project that never took the transition still gets the choice.
    const untouched = await context.service.startConversation();
    assert.equal(
      isAtProjectStart({
        messages: untouched.messages,
        artworkVersionCount: 0,
      }),
      true,
    );
  });

  /* ================================================================== */
  /* Goals 4/5/6 — the Jeep flow, end to end                             */
  /* ================================================================== */

  it("the Jeep flow: clean transcript, clean brief, clean generation prompt", async () => {
    const context = await freshGraph();
    const session = await context.repo.createAcquisitionSession("create-new-jeep");
    const started = await context.service.startConversation(session.id);
    const projectId = started.project.id;

    await context.service.beginCreateNewWorkflow(projectId);
    for (const reply of [
      "T-shirt",
      'black 2010 Jeep Wrangler Unlimited with full racks and an Inspired overland rooftop tent, large wheels with a 2.5" lift, beach and sunset',
      "none",
      "black shirt",
      "full front",
    ]) {
      await context.service.handleUserMessage(projectId, reply);
    }

    const snapshot = (await context.service.getConversation(projectId))!;
    const brief = snapshot.brief;

    // Goal 3: no customer bubble the customer did not type.
    assert.equal(
      snapshot.messages.some((message) => message.content.includes(SYNTHETIC_INTENT)),
      false,
    );
    assert.equal(
      userTurns(snapshot).some((message) => message.content === SYNTHETIC_INTENT),
      false,
    );
    assert.equal(snapshot.messages[0]?.role, "assistant");
    assert.equal(snapshot.messages[1]?.role, "assistant");

    // Goal 4: the brief is what the customer actually said.
    assert.equal(brief.productSummary, "T-shirt");
    assert.equal(brief.shirtColor, "Black");
    assert.equal(brief.printPlacement, "full_front");
    assert.match(String(brief.designDescription), /Jeep Wrangler/i);
    assert.equal(brief.exactText, "");
    assert.equal(
      JSON.stringify(brief).includes(SYNTHETIC_INTENT),
      false,
      "the synthetic workflow sentence reached a Design Brief field",
    );
    assert.equal(brief.additionalInstructions, null);

    // Goal 6 (Correction B, unchanged): the Jeep's black is subject detail.
    assert.deepEqual(brief.preferredColors, []);
    const { createBriefEvaluationCapability } = await import(
      "@/capabilities/brief-evaluation"
    );
    assert.equal(
      createBriefEvaluationCapability()
        .evaluate(brief)
        .contradictions.some((conflict) => conflict.code === "color_clash"),
      false,
    );

    // Goal 5: nothing synthetic reaches the image model.
    const approved = await context.service.submitDesignBriefDecision(
      projectId,
      "approve",
    );
    const version = approved.designBriefVersions.at(-1)!;
    const { createPromptTranslationCapability } = await import(
      "@/capabilities/prompt-translation"
    );
    const { createInitialGenerationIntent } = await import(
      "@/capabilities/prompt-translation/generation-intent"
    );
    const request = createPromptTranslationCapability().translate(
      createInitialGenerationIntent(version.content),
    );
    assert.equal(
      JSON.stringify(request).includes(SYNTHETIC_INTENT),
      false,
      "the synthetic workflow sentence reached the generation request",
    );
    assert.match(request.subject, /black/i);
    assert.match(request.subject, /Jeep/i);
    assert.equal(request.productColor, "Black");
    assert.deepEqual(request.colors, []);

    // Goal 8 (Corrections C/C2, unchanged): the email gate still waits.
    const generating = (await context.service.getConversation(projectId))!;
    assert.equal(generating.acquisition.state, "free_concept_generating");
    assert.equal(
      generating.messages.some((message) =>
        message.content.includes("Like where this is going"),
      ),
      false,
    );
    await context.graph.generationWorker.processNextJob();
    const delivered = (await context.service.getConversation(projectId))!;
    assert.equal(delivered.artworkVersions.length, 1);
    assert.equal(delivered.acquisition.state, "email_required");
  });

  /* ================================================================== */
  /* Goal 12 — a customer who TYPES it is still a customer               */
  /* ================================================================== */

  it("a manually typed 'create new' is still an ordinary customer message", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;

    const after = await context.service.handleUserMessage(projectId, "create new");

    assert.equal(
      after.messages.some(
        (message) => message.role === "user" && message.content === "create new",
      ),
      true,
      "a typed phrase was swallowed by workflow filtering",
    );
    assert.equal(markerCount(after), 0);
  });
});
