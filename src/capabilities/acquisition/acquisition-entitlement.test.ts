import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createConversationCapability } from "@/capabilities/conversation";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

import { createAcquisitionCapability } from "./acquisition-capability";
import {
  EMAIL_REQUIRED_CONVERSATION_MESSAGE,
  PAID_GENERATION_LOCKED_MESSAGE,
} from "./acquisition-copy";

/**
 * Sprint A4 — the acquisition entitlement, proved end to end against a
 * COUNTING provider.
 *
 * The claims under test are all about spend, so none of them is asserted
 * indirectly. Every one counts real provider dispatches and real
 * `GenerationJob` rows: "the customer sees a gate" is not the property that
 * matters, "no second image was ever bought" is.
 *
 * NO PAID CALL IS POSSIBLE HERE. The provider below is a local fake, and
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (set by the test bootstrap preload)
 * independently forces every provider resolver to its safe local
 * implementation regardless of ambient environment.
 */

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

/** Exists only to be counted. Every assertion about money reads `calls`. */
class CountingConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "counting";
  readonly editsSourceArtwork = false;
  calls: ConceptGenerationRequest[] = [];

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.calls.push(request);
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: `Concept ${index + 1}`,
        placeholderLabel: `Concept ${String.fromCharCode(65 + index)}`,
        accentColor: "#123456",
        kind: "concept" as const,
        asset: {
          imageBytes: tinyPng(),
          contentType: "image/png",
          widthPx: 4,
          heightPx: 4,
          hasTransparency: true,
          providerMetadata: {},
        },
      })),
    };
  }
}

describe("Sprint A4 — one free concept, then an email gate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-acquisition-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness(repoOverride?: (repo: ProjectRepository) => ProjectRepository) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createCapabilityGraph } = await import("@/capabilities/composition");

    const baseRepo = new LocalProjectRepository();

    // The local store is ONE JSON file for the whole test file (its data
    // path is fixed at import time, so a per-test `chdir` cannot separate
    // them), and `claimNextQueuedJob` deliberately claims the oldest due
    // job across EVERY project — real background work is not scoped to one
    // caller. So a test that leaves a job queued on purpose would otherwise
    // have it claimed by the next test's worker, and that test would count
    // a dispatch it never caused. Retiring leftovers here keeps each test's
    // provider count its own.
    for (;;) {
      const stale = await baseRepo.claimNextQueuedJob();
      if (!stale) break;
      await baseRepo.updateGenerationJob(stale.id, { status: "cancelled" });
    }

    const repo = repoOverride ? repoOverride(baseRepo) : baseRepo;
    const graph = createCapabilityGraph(repo);
    const provider = new CountingConceptProvider();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );

    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      provider.providerKey,
      graph.ipSafety,
      acquisition,
    );
    const finalArtwork = createFinalArtworkCapability(repo, acquisition);
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      graph.promptTranslation,
      assets,
      graph.conceptEvaluation,
      graph.revisionIntelligence,
      graph.printValidation,
      graph.ipSafety,
    );
    const conversation = createConversationCapability({
      repo,
      intentExtraction: graph.intentExtraction,
      conversationUnderstanding: graph.conversationUnderstanding,
      designBrief: graph.designBrief,
      briefEvaluation: graph.briefEvaluation,
      designIntelligence: graph.designIntelligence,
      interviewIntelligence: graph.interviewIntelligence,
      revisionIntelligence: graph.revisionIntelligence,
      designSummary: graph.designSummary,
      conceptGeneration,
      finalArtwork,
      ipSafety: graph.ipSafety,
      acquisition,
    });

    return {
      repo,
      graph,
      provider,
      acquisition,
      conceptGeneration,
      finalArtwork,
      worker,
      conversation,
    };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  /** A brand-new anonymous prospect: fresh session, fresh bound project. */
  async function newProspect(harness: Harness, briefOverrides = {}) {
    const session = await harness.repo.createAcquisitionSession(
      `token-${Math.random().toString(36).slice(2)}`,
    );
    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      briefOverrides,
      session.id,
    );
    return { sessionId: session.id, projectId };
  }

  /** Approve the summary (the one action that can enqueue initial generation). */
  async function approve(harness: Harness, projectId: string) {
    return harness.conversation.submitDesignBriefDecision(projectId, "approve");
  }

  /* ================================================================== */
  /* A + B + C: a new prospect has one free concept, and spending it     */
  /*            atomically claims the entitlement                        */
  /* ================================================================== */

  it("A: a brand-new anonymous prospect starts with the free concept available", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);

    const session = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(session?.freeConceptGenerationJobId, null);
    assert.equal(session?.email, null);

    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: false,
    });
    assert.equal(view.state, "open");
    assert.equal(view.emailCaptured, false);
  });

  it("B+C: the first generation is allowed and produces exactly ONE concept, claiming the entitlement", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);

    await approve(harness, projectId);

    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    // The product promise is ONE customer-visible concept — not one batch
    // of three that happens to be free.
    assert.equal(jobs[0]?.conceptCount, 1);

    const session = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(session?.freeConceptProjectId, projectId);
    assert.equal(session?.freeConceptGenerationJobId, jobs[0]?.id);

    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
    assert.equal(harness.provider.calls[0]?.conceptCount, 1);

    const snapshot = await harness.conversation.get(projectId);
    assert.equal(snapshot?.artworkVersions.length, 1);
  });

  /* ================================================================== */
  /* D + E: double click and two tabs                                    */
  /* ================================================================== */

  it("D: a double click creates exactly one generation job and one paid attempt", async () => {
    const harness = await buildHarness();
    const { projectId } = await newProspect(harness);

    await approve(harness, projectId);
    await approve(harness, projectId);
    await approve(harness, projectId);

    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);
    await harness.worker.processNextJob();
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
  });

  it("E: two concurrent tabs create exactly one paid attempt", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);

    await Promise.all([
      approve(harness, projectId),
      approve(harness, projectId),
    ]);

    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);

    const session = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(session?.freeConceptGenerationJobId, jobs[0]?.id);

    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
  });

  /* ================================================================== */
  /* F + G: reload and reopen never restore the entitlement              */
  /* ================================================================== */

  it("F: reloading the project does not restore the free entitlement", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();

    // A reload is exactly this: read the project (which also runs the
    // interrupted-request recovery path) and look again.
    await harness.conversation.recoverInterruptedGenerationRequest(projectId);
    await harness.conversation.get(projectId);

    const session = await harness.repo.getAcquisitionSession(sessionId);
    assert.ok(session?.freeConceptGenerationJobId);

    const authorization =
      await harness.acquisition.authorizeConceptGeneration(projectId);
    assert.equal(authorization.allowed, false);
  });

  it("G: a SECOND project in the same session gets no free concept", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();

    // The one-click bypass a per-project entitlement would have: start
    // over, get another free concept. The session is the authority, so it
    // does not work.
    //
    // Sprint A4 Correction C2: the refusal now lands at the SECOND
    // project's first design turn rather than only at its approval. The
    // session has already been given the concept it was promised, so
    // further design work — on any project — is what the address unlocks.
    // This used to be allowed all the way to approval only because the
    // continuation gate read the second project's own (empty) artwork list
    // instead of the session's entitlement.
    const second = await harness.conversation.start(sessionId);
    const secondProjectId = second.project.id;
    const gated = await harness.conversation.handleUserMessage(
      secondProjectId,
      "I'd like a design for our hockey team",
    );

    assert.equal(
      gated.messages.at(-1)?.content,
      EMAIL_REQUIRED_CONVERSATION_MESSAGE,
    );
    // The turn is refused before it is persisted — a message that will not
    // be answered must not sit in the transcript as if it had been.
    assert.equal(
      gated.messages.some((message) => message.role === "user"),
      false,
    );
    assert.equal(
      (await harness.repo.listGenerationJobs(secondProjectId)).length,
      0,
    );
    assert.equal(harness.provider.calls.length, 1);
  });

  /* ================================================================== */
  /* H + Y: a safety-blocked request never costs the free concept        */
  /* ================================================================== */

  it("H+Y: an IP-safety-blocked request does not consume the entitlement, and the safe retry still gets the free concept", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession("token-ip");
    const started = await harness.conversation.start(session.id);
    const projectId = started.project.id;

    await harness.conversation.handleUserMessage(
      projectId,
      "Make me the Raiders logo on a black t-shirt.",
    );

    // Blocked before the brief changed, before any job, before any spend —
    // and, critically, before the entitlement was touched.
    const afterBlock = await harness.repo.getAcquisitionSession(session.id);
    assert.equal(afterBlock?.freeConceptProjectId, null);
    assert.equal(afterBlock?.freeConceptGenerationJobId, null);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);
    assert.equal(harness.provider.calls.length, 0);

    // The customer rephrases and still has their one free concept.
    const { projectId: safeProjectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      session.id,
    );
    await approve(harness, safeProjectId);
    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, 1);
    assert.equal(
      (await harness.conversation.get(safeProjectId))?.artworkVersions.length,
      1,
    );
  });

  /* ================================================================== */
  /* I: a pre-provider failure never burns the free concept              */
  /* ================================================================== */

  it("I: an enqueue failure before any durable job leaves the free concept intact, and the retry uses it", async () => {
    let shouldFail = true;
    const harness = await buildHarness((repo) =>
      new Proxy(repo, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function") return value;
          const method = value.bind(target) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          if (property !== "createGenerationJob") return method;
          return async (...args: unknown[]) => {
            if (shouldFail) {
              shouldFail = false;
              // A PostgREST-shaped rejection: a plain object, not an Error.
              throw { code: "PGRST204", message: "column missing" };
            }
            return method(...args);
          };
        },
      }) as ProjectRepository,
    );

    const { sessionId, projectId } = await newProspect(harness);

    await assert.rejects(() => approve(harness, projectId));

    // ALLOCATED but not CONSUMED — the distinction the whole design rests
    // on. The platform never committed to a paid attempt, so the customer
    // must not have been charged their one free concept for our failure.
    const stranded = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(stranded?.freeConceptProjectId, projectId);
    assert.equal(stranded?.freeConceptGenerationJobId, null);

    // The retry resumes the same allocation and succeeds.
    await approve(harness, projectId);
    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.conceptCount, 1);

    const consumed = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(consumed?.freeConceptGenerationJobId, jobs[0]?.id);
  });

  /* ================================================================== */
  /* J + Z: a submitted attempt is never given a second entitlement      */
  /* ================================================================== */

  it("J+Z: re-requesting after the job exists never claims a second entitlement or a second paid submit", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);

    await approve(harness, projectId);
    const jobs = await harness.repo.listGenerationJobs(projectId);
    const jobId = jobs[0]!.id;

    // Simulate a worker that submitted and then died: the job is left
    // mid-flight and recoverable, exactly as `recoverAbandonedJobs` leaves
    // it. Resuming it must reuse the SAME entitlement and the SAME job.
    await harness.repo.updateGenerationJob(jobId, { status: "recoverable" });

    await approve(harness, projectId);
    await harness.conversation.recoverInterruptedGenerationRequest(projectId);

    const after = await harness.repo.listGenerationJobs(projectId);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.id, jobId);

    const session = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(session?.freeConceptGenerationJobId, jobId);

    // And the resumed job produces exactly one paid dispatch in total.
    await harness.worker.processNextJob();
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
  });

  /* ================================================================== */
  /* K + N + O: the email gate                                           */
  /* ================================================================== */

  it("K: once the free concept is ready, continuing the conversation asks for an email", async () => {
    const harness = await buildHarness();
    const { projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();

    // The gate state is visible the moment the concept is delivered, so
    // the card renders next to the concept rather than only appearing once
    // the customer bumps into a refusal.
    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: false,
    });
    assert.equal(view.state, "email_required");
    assert.equal(view.emailCaptured, false);

    // Selecting is deliberately NOT gated — the customer has to be able to
    // work with what they were shown. `concepts_ready` blocks free-text
    // chat on its own (pre-existing product behavior), so selection is the
    // real path to the next conversational turn.
    const snapshot = await harness.conversation.get(projectId);
    await harness.conversation.selectConcept(
      projectId,
      snapshot!.artworkVersions[0]!.id,
    );

    const gated = await harness.conversation.handleUserMessage(
      projectId,
      "Can you make the bear bigger?",
    );
    assert.equal(
      gated.messages.at(-1)?.content,
      EMAIL_REQUIRED_CONVERSATION_MESSAGE,
    );
    // The refused turn is not persisted as if it had been answered.
    assert.equal(
      gated.messages.some(
        (message) =>
          message.role === "user" &&
          message.content === "Can you make the bear bigger?",
      ),
      false,
    );
  });

  it("the gate is NOT shown while the free concept is still generating", async () => {
    const harness = await buildHarness();
    const { projectId } = await newProspect(harness);
    await approve(harness, projectId);

    // Value has been promised but not delivered. Asking for an address here
    // would be a toll booth in front of a promise we have not kept.
    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: true,
    });
    assert.equal(view.state, "free_concept_generating");
  });

  it("M+V: a valid email is persisted, normalized, and a duplicate submission is idempotent", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();

    const first = await harness.acquisition.captureEmail(
      projectId,
      "  Eric@Example.COM  ",
    );
    assert.equal(first.ok, true);

    const stored = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(stored?.email, "eric@example.com");
    const capturedAt = stored?.emailCapturedAt;
    assert.ok(capturedAt);

    const second = await harness.acquisition.captureEmail(
      projectId,
      "ERIC@example.com",
    );
    assert.equal(second.ok, true);

    const after = await harness.repo.getAcquisitionSession(sessionId);
    assert.equal(after?.email, "eric@example.com");
    // The capture moment is when they entered the funnel, and a repeat
    // submission is not a new entry into it.
    assert.equal(after?.emailCapturedAt, capturedAt);
  });

  it("L: an invalid email is refused and nothing is persisted", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();

    const result = await harness.acquisition.captureEmail(projectId, "nope");
    assert.equal(result.ok, false);
    assert.equal((await harness.repo.getAcquisitionSession(sessionId))?.email, null);
  });

  it("N: a captured email is not marketing consent — nothing records one", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const session = await harness.repo.getAcquisitionSession(sessionId);
    // The whole session record is inspected: there must be no consent
    // flag, no subscription state, and no list membership anywhere on it.
    // A field that does not exist cannot be silently interpreted as a yes.
    for (const key of Object.keys(session ?? {})) {
      assert.doesNotMatch(
        key,
        /consent|marketing|subscrib|newsletter|optIn|opt_in/i,
        `acquisition session carries a consent-shaped field: ${key}`,
      );
    }
    // And the entitlement is untouched by capturing an address.
    assert.equal(session?.entitlement, "prospect");
  });

  it("O: capturing an email does not grant a second free generation", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();
    const consumedJobId = (await harness.repo.getAcquisitionSession(sessionId))
      ?.freeConceptGenerationJobId;

    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const authorization =
      await harness.acquisition.authorizeConceptGeneration(projectId);
    assert.equal(authorization.allowed, false);
    assert.equal(
      (await harness.repo.getAcquisitionSession(sessionId))
        ?.freeConceptGenerationJobId,
      consumedJobId,
    );
    assert.equal(harness.provider.calls.length, 1);
  });

  /* ================================================================== */
  /* P + Q + R: email is not a generation entitlement                    */
  /* ================================================================== */

  async function prospectWithEmailAndConcept(harness: Harness) {
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const snapshot = await harness.conversation.get(projectId);
    const artworkVersionId = snapshot!.artworkVersions[0]!.id;
    await harness.conversation.selectConcept(projectId, artworkVersionId);
    return { sessionId, projectId, artworkVersionId };
  }

  it("P: regenerating after email but before payment creates no new job and no new paid call", async () => {
    const harness = await buildHarness();
    const { projectId } = await prospectWithEmailAndConcept(harness);
    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;

    // Deliberately asserts spend, not copy. With an unchanged brief this
    // request never even reaches the acquisition fence — `enqueue`'s own
    // per-approved-version idempotency has always made it a no-op — so
    // demanding a refusal message here would pin behavior that belongs to
    // a different mechanism. The property A4 owes is that nothing new is
    // bought, and that is what is checked. The refusal COPY is proved by R
    // below, on the path that genuinely reaches the fence.
    await harness.conversation.regenerateConcepts(projectId);

    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
    );
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
  });

  it("Q: exploring a new batch after email but before payment is blocked", async () => {
    const harness = await buildHarness();
    const { projectId } = await prospectWithEmailAndConcept(harness);
    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;

    await harness.conversation.exploreNewConceptBatch(projectId);

    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
    );
    assert.equal(harness.provider.calls.length, 1);
  });

  it("R: a generative revision after email but before payment is blocked", async () => {
    const harness = await buildHarness();
    const { projectId } = await prospectWithEmailAndConcept(harness);
    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;

    // A real change to the brief produces a NEW approved version and
    // therefore a genuinely new generation request — the path that actually
    // reaches the acquisition fence.
    const refused = await harness.conversation.handleUserMessage(
      projectId,
      "Make the bear red instead of brown.",
    );

    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
    );
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
    assert.equal(refused.messages.at(-1)?.content, PAID_GENERATION_LOCKED_MESSAGE);

    // A refused revision leaves a pending-revision authority with no job,
    // which the interrupted-request recovery path re-attempts on EVERY
    // read. It must be refused again without buying anything and without
    // repeating itself at the customer.
    const before = (await harness.conversation.get(projectId))!.messages.length;
    await harness.conversation.recoverInterruptedGenerationRequest(projectId);
    await harness.conversation.recoverInterruptedGenerationRequest(projectId);
    const reloaded = (await harness.conversation.get(projectId))!;

    assert.equal(reloaded.messages.length, before);
    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
    );
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
  });

  /* ================================================================== */
  /* S: finalization / Topaz                                             */
  /* ================================================================== */

  it("S: print-ready preparation is blocked before payment — no FinalArtworkJob is ever created", async () => {
    const harness = await buildHarness();
    const { projectId, artworkVersionId } =
      await prospectWithEmailAndConcept(harness);
    await harness.conversation.confirmSelectedDirection(
      projectId,
      artworkVersionId,
    );

    await assert.rejects(() =>
      harness.finalArtwork.requestFinalArtwork(projectId, artworkVersionId),
    );

    // No job means the final-artwork worker has nothing to claim, which is
    // what makes "no free Topaz work" structural rather than a policy the
    // worker has to remember.
    assert.equal(
      await harness.repo.getActiveFinalDirectionApproval(projectId),
      null,
    );
  });

  it("S: the uploaded-artwork finalization path is blocked by the same fence", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession("token-upload");
    const started = await harness.conversation.start(session.id);

    // Refused before any preparation lookup — an upload project never
    // consumes a free concept, so this fence is its only acquisition gate.
    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(
        started.project.id,
      ),
    );
  });

  /* ================================================================== */
  /* T: internal entitlement                                             */
  /* ================================================================== */

  it("T: an internally entitled session bypasses the acquisition gate entirely", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession("token-internal");
    await harness.repo.grantInternalEntitlement(session.id);

    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      session.id,
    );
    await approve(harness, projectId);

    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    // Full batch behavior, unchanged — an internal operator is doing real
    // production work, not evaluating a funnel.
    assert.equal(jobs[0]?.conceptCount, 3);

    // The free entitlement is never touched by internal use, so an internal
    // grant cannot quietly spend a prospect's concept.
    const after = await harness.repo.getAcquisitionSession(session.id);
    assert.equal(after?.freeConceptProjectId, null);
    assert.equal(after?.freeConceptGenerationJobId, null);

    await harness.worker.processNextJob();
    const snapshot = await harness.conversation.get(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);

    // And nothing is gated afterwards, including finalization.
    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: false,
    });
    assert.equal(view.state, "open");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  /* ================================================================== */
  /* U: direct API cannot bypass                                         */
  /* ================================================================== */

  it("U: calling the capability directly — no cookie, no UI — cannot bypass the entitlement", async () => {
    const harness = await buildHarness();
    const { projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();

    const snapshot = await harness.conversation.get(projectId);
    const approvedVersionId = snapshot!.designBriefVersions.at(-1)!.id;

    // Every generation entry point, invoked directly with a known project
    // id and a known approved brief version — precisely what a scripted
    // caller bypassing the browser would do. Authority comes from the
    // project's own binding, so none of them succeed.
    await harness.conceptGeneration.generatePlaceholders(projectId, approvedVersionId);
    await harness.conceptGeneration.regenerateAfterRevision(projectId, approvedVersionId);
    await harness.conceptGeneration.exploreNewConceptBatch(projectId, approvedVersionId);
    await harness.conceptGeneration.reviseSelectedConcept(
      projectId,
      approvedVersionId,
      snapshot!.artworkVersions[0]!.id,
      "make it red",
    );

    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 1);
  });

  /* ================================================================== */
  /* W: no internal enum leaks into customer-facing state                */
  /* ================================================================== */

  it("W: the customer-safe view never exposes an internal entitlement value or an email address", async () => {
    const harness = await buildHarness();
    const { projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: false,
    });

    const serialized = JSON.stringify(view);
    for (const forbidden of [
      "prospect",
      "internal",
      "eric@example.com",
      "entitlement",
      "sessionToken",
      "freeConcept",
      "generationJob",
      "paid_image_intent",
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `customer view leaked "${forbidden}": ${serialized}`,
      );
    }
    assert.equal(view.emailCaptured, true);
  });

  it("W: gate copy never mentions credits, spend, quotas, or abuse prevention", () => {
    for (const copy of [
      EMAIL_REQUIRED_CONVERSATION_MESSAGE,
      PAID_GENERATION_LOCKED_MESSAGE,
    ]) {
      assert.doesNotMatch(
        copy,
        /credit|quota|token|spend|cost|abuse|entitle|limit|billing|provider/i,
        `customer copy leaked internal accounting: ${copy}`,
      );
    }
  });

  /* ================================================================== */
  /* X: legacy projects stay backward compatible                         */
  /* ================================================================== */

  it("X: a project created before A4 (no acquisition session) is grandfathered, not blocked", async () => {
    const harness = await buildHarness();

    // Exactly what a pre-A4 row looks like: no binding at all.
    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
    );
    const created = await harness.repo.getProject(projectId);
    assert.equal(created?.project.acquisitionSessionId, null);

    await approve(harness, projectId);
    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.conceptCount, 3);

    await harness.worker.processNextJob();
    assert.equal(
      (await harness.conversation.get(projectId))?.artworkVersions.length,
      3,
    );

    // Nothing is gated, and no gate copy is shown.
    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: false,
    });
    assert.equal(view.state, "open");
    assert.equal(view.message, null);
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  /* ================================================================== */
  /* Goal 20: deterministic evidence                                     */
  /* ================================================================== */

  it("Goal 20: the durable record answers who consumed what, and whether it submitted", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await newProspect(harness);
    await approve(harness, projectId);
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const session = await harness.repo.getAcquisitionSession(sessionId);

    // Was the free entitlement consumed, and by which job?
    const jobId = session?.freeConceptGenerationJobId;
    assert.ok(jobId);
    assert.ok(session?.freeConceptConsumedAt);

    // Did that job submit to the provider? Answered by the paid-intent
    // ledger the job already owns — no new analytics table needed.
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      jobId!,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.status, "succeeded");
    assert.equal(intents[0]?.dispatches, 1);

    // Was an email captured?
    assert.ok(session?.emailCapturedAt);
  });
});
