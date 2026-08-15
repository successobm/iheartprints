import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import {
  createConceptEvaluationCapability,
  PlaceholderConceptEvaluationProvider,
} from "@/capabilities/concept-evaluation";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import {
  GenerationUnavailableError,
  ProviderError,
} from "@/capabilities/providers";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
  GeneratedConceptDraft,
} from "@/capabilities/shared/contracts";
import {
  ACQUISITION_FREE_CONCEPT_MAX_PHYSICAL_DISPATCHES,
  MAX_PAID_DISPATCHES_PER_INTENT,
  maxPhysicalDispatchesForGenerationJob,
} from "@/capabilities/shared/paid-image-intent";
import { FreeConceptAlreadyConsumedError } from "@/lib/db/repository";
import type { ProjectRepository } from "@/lib/db/repository";
import type { ConceptDirectionKey } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createAcquisitionCapability } from "./acquisition-capability";

/**
 * Sprint A4 CORRECTIONS 2 AND 3 — physical dispatch authority, the durable
 * free-attempt tombstone, and the provider preflight boundary.
 *
 * A narrow re-audit found two defects that Correction 1 left standing:
 *
 *   P0  the free job had ONE logical paid intent, but that intent could
 *       still authorize `MAX_PAID_DISPATCHES_PER_INTENT` (3) PHYSICAL
 *       provider submissions. "One free concept" was true of the artwork
 *       and still false of the money.
 *
 *   P1  the one-job-per-session authority was a unique index on
 *       `generation_jobs`, which only constrains rows that EXIST. Deleting
 *       the free job freed the slot for another.
 *
 * A third narrow verification found one more:
 *
 *   P0  the single physical dispatch was CLAIMED before the provider had
 *       passed local availability/configuration preflight. A definite
 *       pre-provider failure therefore produced dispatches = 1 with ZERO
 *       external submissions — the customer's only free attempt spent on
 *       our own misconfiguration. Reproduced against the real production
 *       stub before the fix: ledger 1, submissions 0, intent `failed`.
 *
 * Every test counts PHYSICAL PROVIDER SUBMISSIONS against a local double. No
 * network, no credentials, no possibility of a real paid call —
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (bootstrap preload) independently forces
 * every provider resolver to its safe local implementation.
 */

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

type DispatchOutcome = "ok" | "ambiguous" | "not_dispatched";

/**
 * Counts every PHYSICAL submission — the thing that costs money — and can be
 * scripted to fail the way a real provider does.
 *
 * `ambiguous` is the scenario the whole correction turns on: the request may
 * have reached the provider and may have been billed, and nothing about the
 * response proves otherwise.
 */
class PhysicalDispatchCountingProvider implements ConceptGenerationProvider {
  readonly providerKey = "dispatch-counter";
  readonly editsSourceArtwork = true;

  /** Every physical submission, in order. Length IS the spend. */
  readonly submissions: Array<ConceptDirectionKey | "batch"> = [];
  outcomes: DispatchOutcome[] = [];

  /**
   * Sprint A4 Correction 3: local readiness, flipped the way a real
   * deployment's configuration is — missing credential, disabled provider,
   * invalid local config. `false` models a DEFINITE pre-provider failure:
   * nothing leaves the process, so nothing can have been billed.
   */
  ready = true;
  preflightCalls = 0;

  async assertReadyToDispatch(): Promise<void> {
    this.preflightCalls += 1;
    if (this.ready) return;
    throw this.unavailable();
  }

  private unavailable(): GenerationUnavailableError {
    return new GenerationUnavailableError(
      "GENERATION_PROVIDER_NOT_CONFIGURED",
      "dispatch-counter",
      "Injected local configuration failure",
    );
  }

  /**
   * Mirrors `UnavailableConceptGenerationProvider` exactly: when the local
   * configuration is bad, the generate entry points throw BEFORE anything
   * leaves the process — so `submissions` stays empty however many times
   * they are called.
   *
   * That is what makes this a faithful reproduction. Before this correction
   * the dispatch claim was taken first, so this path produced
   * `dispatches = 1` with `submissions = 0`: a definite local failure that
   * permanently consumed the customer's one free attempt without ever
   * contacting a provider.
   */
  private failIfUnconfigured(): void {
    if (!this.ready) throw this.unavailable();
  }

  private nextOutcome(): DispatchOutcome {
    return this.outcomes.shift() ?? "ok";
  }

  private draft(directionKey: ConceptDirectionKey): GeneratedConceptDraft {
    return {
      versionNumber: 1,
      title: `Title ${directionKey}`,
      summary: `Summary ${directionKey}`,
      placeholderLabel: `Label ${directionKey}`,
      accentColor: "#123456",
      kind: "concept" as const,
      conceptDirectionKey: directionKey,
      asset: {
        imageBytes: tinyPng(),
        contentType: "image/png",
        widthPx: 4,
        heightPx: 4,
        hasTransparency: false,
        providerMetadata: {},
      },
    } as unknown as GeneratedConceptDraft;
  }

  private applyOutcome(): void {
    const outcome = this.nextOutcome();
    if (outcome === "ambiguous") {
      // Exactly the shape the executor classifies as possibly-billed: the
      // request left the process and nothing proves it was not charged.
      throw new ProviderError(
        "network",
        "Timed out awaiting the image response",
        "dispatched_ambiguous",
      );
    }
    if (outcome === "not_dispatched") {
      // Provably never reached the provider — nothing was billed, so this
      // must stay retryable even on the free path.
      throw new ProviderError(
        "network",
        "Connection refused before sending",
        "not_dispatched",
      );
    }
  }

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.failIfUnconfigured();
    this.submissions.push("batch");
    this.applyOutcome();
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [this.draft("bold_direct")],
    };
  }

  async generateDirection(
    request: ConceptGenerationRequest,
    directionKey: ConceptDirectionKey,
  ): Promise<ConceptGenerationResult> {
    this.failIfUnconfigured();
    this.submissions.push(directionKey);
    this.applyOutcome();
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [this.draft(directionKey)],
    };
  }
}

describe("Sprint A4 Corrections 2/3 — one free concept, one physical dispatch", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-a4-dispatch-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();

    // The local store is one JSON file for the whole file's tests, and
    // `claimNextQueuedJob` claims the oldest due job across every project.
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }

    const provider = new PhysicalDispatchCountingProvider();
    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      provider.providerKey,
      undefined,
      acquisition,
    );
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      createPromptTranslationCapability(),
      createAssetCapability(
        repo,
        new DataUriAssetStorageProvider(),
        new PngThumbnailGenerator(),
      ),
      createConceptEvaluationCapability(new PlaceholderConceptEvaluationProvider()),
    );
    return {
      repo,
      provider,
      acquisition,
      conceptGeneration,
      worker,
      designBrief: createDesignBriefCapability(repo),
    };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;

  async function freeProspect(harness: Harness) {
    tokenCounter += 1;
    const session = await harness.repo.createAcquisitionSession(
      `dispatch-token-${tokenCounter}`,
    );
    const created = await harness.repo.createProject(session.id);
    await harness.repo.updateBrief(created.project.id, {
      productSummary: "T-shirts",
    });
    const version = await harness.designBrief.approveWorkingBrief(
      created.project.id,
    );
    return { sessionId: session.id, projectId: created.project.id, version };
  }

  /** An ordinary (non-acquisition) project — no session binding at all. */
  async function ordinaryProject(harness: Harness) {
    const created = await harness.repo.createProject();
    await harness.repo.updateBrief(created.project.id, {
      productSummary: "T-shirts",
    });
    const version = await harness.designBrief.approveWorkingBrief(
      created.project.id,
    );
    return { projectId: created.project.id, version };
  }

  /** Drives the job through every attempt its budget allows. */
  async function drainWorker(harness: Harness, times = 5) {
    for (let i = 0; i < times; i += 1) {
      await harness.worker.processNextJob();
    }
  }

  /* ================================================================== */
  /* The policy itself                                                   */
  /* ================================================================== */

  it("policy: the ceiling is keyed on acquisition authority, never on conceptCount", () => {
    assert.equal(
      maxPhysicalDispatchesForGenerationJob({ acquisitionSessionId: "s" }),
      ACQUISITION_FREE_CONCEPT_MAX_PHYSICAL_DISPATCHES,
    );
    assert.equal(
      maxPhysicalDispatchesForGenerationJob({ acquisitionSessionId: "s" }),
      1,
    );
    // The defect in one line: a one-concept job is NOT automatically a free
    // job, and the ordinary ceiling stays 3 for it.
    assert.equal(
      maxPhysicalDispatchesForGenerationJob({ acquisitionSessionId: null }),
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
    assert.equal(maxPhysicalDispatchesForGenerationJob({}), 3);
  });

  /* ================================================================== */
  /* GOAL 7 — physical dispatch failure matrix                           */
  /* ================================================================== */

  it("7-A: a successful free generation makes exactly ONE physical submission", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await freeProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    assert.equal(harness.provider.submissions.length, 1);
    const snapshot = await harness.repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 1);
  });

  it("7-B: an AMBIGUOUS possibly-billed failure is never submitted again", async () => {
    const harness = await buildHarness();
    // Every attempt would fail ambiguously — on an ordinary job this buys
    // three images.
    harness.provider.outcomes = ["ambiguous", "ambiguous", "ambiguous"];
    const { projectId, version } = await freeProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    // THE P0 GUARANTEE. One submission, whatever the provider did with it.
    assert.equal(harness.provider.submissions.length, 1);

    const [job] = await harness.repo.listGenerationJobs(projectId);
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.dispatches, 1);
    // Terminal at the ceiling, so nothing is left implying another try.
    assert.equal(intents[0]?.status, "failed");

    // Deterministic terminal state — the customer is not left polling.
    const snapshot = await harness.repo.getProject(projectId);
    assert.equal(snapshot?.project.status, "failed");
    assert.notEqual(snapshot?.project.status, "generating");
  });

  it("7-B: re-requesting after an ambiguous failure never resubmits and never re-queues", async () => {
    const harness = await buildHarness();
    harness.provider.outcomes = ["ambiguous"];
    const { sessionId, projectId, version } = await freeProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);
    assert.equal(harness.provider.submissions.length, 1);

    // The customer presses the button again. The job must NOT be re-queued —
    // it would only be refused before contacting any provider, three times,
    // while a spinner ran.
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    const [job] = await harness.repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "failed");

    await drainWorker(harness);
    assert.equal(harness.provider.submissions.length, 1);

    // And no second free entitlement, no second job.
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);
    assert.equal(
      (await harness.acquisition.authorizeConceptGeneration(projectId)).allowed,
      false,
    );
    assert.ok(await harness.repo.getFreeConceptClaim(sessionId));
  });

  /* ================================================================== */
  /* GOAL 14 A-C — provider PREFLIGHT: a local configuration failure     */
  /*               must not consume the one physical dispatch            */
  /* ================================================================== */

  it("14-A/B/C: an unavailable provider costs NO dispatch, and the SAME job succeeds after repair", async () => {
    const harness = await buildHarness();
    // A definite LOCAL failure — missing credentials, disabled provider,
    // invalid configuration. Nothing leaves the process, so nothing can
    // have been billed, so the free attempt must survive it.
    harness.provider.ready = false;
    const { sessionId, projectId, version } = await freeProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    const [job] = await harness.repo.listGenerationJobs(projectId);

    // A: nothing was submitted and nothing was charged against the ledger.
    // Before this correction the claim was taken BEFORE the provider was
    // consulted, so this read was 1 and the free attempt was already gone.
    assert.equal(harness.provider.submissions.length, 0);
    assert.equal(harness.provider.preflightCalls > 0, true);
    const strandedIntents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    for (const intent of strandedIntents) {
      assert.equal(
        intent.dispatches,
        0,
        "a local configuration failure consumed a physical dispatch",
      );
    }

    // The customer is not told their free concept is gone, because it
    // is not — and the next thing they do must be allowed to work.
    const strandedView = await harness.acquisition.describeForCustomer(
      projectId,
      { conceptDelivered: false, generating: false },
    );
    assert.notEqual(strandedView.state, "continue_locked");

    // B: configuration is repaired. NOTHING about the ledger is touched by
    // the test — the retry goes through the ordinary customer path.
    harness.provider.ready = true;
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    assert.equal(harness.provider.submissions.length, 1);
    const afterRepair = await harness.repo.listGenerationJobs(projectId);
    // Same job — the attempt belongs to the already-authorized job, and the
    // entitlement was never restored to create a different one.
    assert.equal(afterRepair.length, 1);
    assert.equal(afterRepair[0]?.id, job!.id);

    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.dispatches, 1);

    const snapshot = await harness.repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 1);

    // C: a second recovery sweep adds nothing.
    await drainWorker(harness);
    assert.equal(harness.provider.submissions.length, 1);
    const finalIntents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(finalIntents.length, 1);
    assert.equal(finalIntents[0]?.dispatches, 1);

    // And the session still holds exactly one claim, on that same job.
    const claim = await harness.repo.getFreeConceptClaim(sessionId);
    assert.equal(claim?.generationJobId, job!.id);
  });

  it("14-A: a preflight failure creates no paid intent dispatch and no second job", async () => {
    const harness = await buildHarness();
    harness.provider.ready = false;
    const { sessionId, projectId, version } = await freeProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);
    // Repeated customer retries while still broken never submit and never
    // create a second job or a second claim.
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    assert.equal(harness.provider.submissions.length, 0);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);
    const claim = await harness.repo.getFreeConceptClaim(sessionId);
    assert.ok(claim);
  });

  it("14-E: two concurrent workers both preflight, but only ONE submits", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await freeProspect(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    // Moving preflight before the claim must not let two workers both reach
    // the provider. Preflight is advisory and side-effect-free; the dispatch
    // claim remains the sole concurrency authority, and the loser never
    // calls the provider at all.
    await Promise.all([
      harness.worker.processNextJob(),
      harness.worker.processNextJob(),
      harness.worker.processNextJob(),
    ]);

    assert.equal(harness.provider.submissions.length, 1);
    const [job] = await harness.repo.listGenerationJobs(projectId);
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.dispatches, 1);
  });

  it("14-F: an ORDINARY job's preflight failure is retryable and costs no dispatch", async () => {
    const harness = await buildHarness();
    harness.provider.ready = false;
    const { projectId, version } = await ordinaryProject(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.worker.processNextJob();

    assert.equal(harness.provider.submissions.length, 0);
    const [job] = await harness.repo.listGenerationJobs(projectId);
    const stranded = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    for (const intent of stranded) assert.equal(intent.dispatches, 0);

    // Repaired, the ordinary job resumes exactly as it always did — the
    // correction must not have made a configuration failure terminal for
    // paid work.
    harness.provider.ready = true;
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    assert.equal(harness.provider.submissions.length, 3);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);
    const snapshot = await harness.repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
  });

  it("14-G: a TARGETED REVISION's preflight failure is retryable and keeps ordinary policy", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await ordinaryProject(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);
    const sourceId = (await harness.repo.getProject(projectId))!
      .artworkVersions[0]!.id;
    const submissionsAfterInitial = harness.provider.submissions.length;

    harness.provider.ready = false;
    await harness.repo.updateBrief(projectId, {
      designDescription: "Make the bear red",
    });
    const revised = await harness.designBrief.approveWorkingBrief(projectId);
    await harness.conceptGeneration.reviseSelectedConcept(
      projectId,
      revised.id,
      sourceId,
      "make the bear red",
    );
    await harness.worker.processNextJob();

    // No submission, no dispatch consumed.
    assert.equal(harness.provider.submissions.length, submissionsAfterInitial);
    const revisionJob = (await harness.repo.listGenerationJobs(projectId)).at(-1)!;
    assert.equal(revisionJob.conceptCount, 1);
    assert.equal(revisionJob.acquisitionSessionId, null);
    for (const intent of await harness.repo.listPaidImageIntentsForJob(
      projectId,
      revisionJob.id,
    )) {
      assert.equal(intent.dispatches, 0);
    }
    // Still the ordinary ceiling — a one-concept revision is not free work.
    assert.equal(
      maxPhysicalDispatchesForGenerationJob(revisionJob),
      MAX_PAID_DISPATCHES_PER_INTENT,
    );

    harness.provider.ready = true;
    await harness.conceptGeneration.reviseSelectedConcept(
      projectId,
      revised.id,
      sourceId,
      "make the bear red",
    );
    await drainWorker(harness);
    assert.equal(
      harness.provider.submissions.length,
      submissionsAfterInitial + 1,
    );
  });

  it("7-D: a resume that ADOPTS the earlier result makes no second submission", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await freeProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.worker.processNextJob();
    assert.equal(harness.provider.submissions.length, 1);

    const [job] = await harness.repo.listGenerationJobs(projectId);
    // Force the job back to claimable, as `recoverAbandonedJobs` leaves a
    // worker that died mid-attempt.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await harness.repo.updateGenerationJob(job!.id, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });
    await harness.repo.recoverAbandonedJobs(1000);
    await drainWorker(harness);

    // Reuse/adoption is NOT a physical dispatch.
    assert.equal(harness.provider.submissions.length, 1);
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.dispatches, 1);
    assert.equal(intents[0]?.status, "succeeded");
  });

  /* ================================================================== */
  /* GOAL 7 F+G — ordinary economics must be untouched                   */
  /* ================================================================== */

  it("7-F: an ordinary 3-concept job keeps its existing retry economics", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await ordinaryProject(harness);

    const [job] = [
      await harness.conceptGeneration
        .generatePlaceholders(projectId, version.id)
        .then(() => harness.repo.listGenerationJobs(projectId))
        .then((jobs) => jobs[0]!),
    ];
    assert.equal(job.acquisitionSessionId, null);
    assert.equal(job.conceptCount, 3);
    assert.equal(maxPhysicalDispatchesForGenerationJob(job), 3);

    await drainWorker(harness);
    // Three directions, three physical submissions — unchanged.
    assert.equal(harness.provider.submissions.length, 3);
  });

  it("7-G: a targeted revision (conceptCount 1) keeps the ORDINARY retry policy", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await ordinaryProject(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await drainWorker(harness);

    const snapshot = await harness.repo.getProject(projectId);
    const sourceId = snapshot!.artworkVersions[0]!.id;

    await harness.repo.updateBrief(projectId, {
      designDescription: "Make the bear red",
    });
    const revisedVersion = await harness.designBrief.approveWorkingBrief(projectId);
    await harness.conceptGeneration.reviseSelectedConcept(
      projectId,
      revisedVersion.id,
      sourceId,
      "make the bear red",
    );

    const revisionJob = (await harness.repo.listGenerationJobs(projectId)).at(-1)!;
    assert.equal(revisionJob.conceptCount, 1);
    assert.equal(revisionJob.acquisitionSessionId, null);
    // THE POINT OF THIS TEST: conceptCount === 1 must NOT be mistaken for
    // "free acquisition". A targeted revision is paid work on a design the
    // customer already chose, and stranding it on one ambiguous transport
    // failure is exactly the harm the ordinary policy prevents.
    assert.equal(
      maxPhysicalDispatchesForGenerationJob(revisionJob),
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
  });

  /* ================================================================== */
  /* GOAL 8 / 12 / 14 — the durable tombstone                            */
  /* ================================================================== */

  it("8: the claim is taken atomically with the job, and is session-owned", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await freeProspect(harness);

    assert.equal(await harness.repo.getFreeConceptClaim(sessionId), null);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    const [job] = await harness.repo.listGenerationJobs(projectId);
    const claim = await harness.repo.getFreeConceptClaim(sessionId);
    assert.ok(claim);
    assert.equal(claim?.acquisitionSessionId, sessionId);
    assert.equal(claim?.generationJobId, job!.id);
    assert.ok(claim?.claimedAt);
  });

  it("12/14: the claim survives the job disappearing — no second free attempt", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await freeProspect(harness);
    const version = (await harness.repo.getProject(projectId))!
      .designBriefVersions.at(-1)!;
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    // THE P1 STATE, modelled at the boundary that would observe it: the job
    // is gone from every job-shaped read, and the claim is all that remains.
    // (The repository deliberately exposes no `deleteGenerationJob`; real
    // DELETE semantics are proved against PostgreSQL in
    // `scripts/verify-acquisition-authority-postgres.sql`.)
    const withoutJob = new Proxy(harness.repo, {
      get(target, property, receiver) {
        if (property === "getFreeConceptGenerationJob") return async () => null;
        if (property === "listGenerationJobs") return async () => [];
        if (property === "getGenerationJobByIdempotencyKey")
          return async () => null;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectRepository;

    // The claim still refuses a brand-new free job for this session.
    await assert.rejects(
      () =>
        withoutJob.createGenerationJob(projectId, {
          designBriefVersionId: version.id,
          kind: "initial",
          conceptCount: 1,
          providerKey: "dispatch-counter",
          idempotencyKey: "an-entirely-different-key",
          acquisitionSessionId: sessionId,
        }),
      (error: unknown) => error instanceof FreeConceptAlreadyConsumedError,
    );

    // And the application agrees — the customer does not become `open`.
    const acquisition = createAcquisitionCapability(withoutJob);
    assert.equal(
      (await acquisition.authorizeConceptGeneration(projectId)).allowed,
      false,
    );
    const view = await acquisition.describeForCustomer(projectId, {
      conceptDelivered: false,
      generating: false,
    });
    assert.notEqual(view.state, "open");
  });

  it("14: a failed consumption-marker write does not weaken the claim", async () => {
    const harness = await buildHarness();
    let shouldFail = true;
    const repo = new Proxy(harness.repo, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const bound = value.bind(target) as (...a: unknown[]) => Promise<unknown>;
        if (property !== "recordFreeConceptConsumed") return bound;
        return async (...args: unknown[]) => {
          if (shouldFail) {
            shouldFail = false;
            throw { code: "PGRST204", message: "injected" };
          }
          return bound(...args);
        };
      },
    }) as ProjectRepository;

    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      "dispatch-counter",
      undefined,
      acquisition,
    );
    const { sessionId, projectId, version } = await freeProspect(harness);

    await conceptGeneration.generatePlaceholders(projectId, version.id);

    // Marker never written…
    const session = await repo.getAcquisitionSession(sessionId);
    assert.equal(session?.freeConceptConsumedAt, null);
    // …but the claim was taken atomically with the job, so authority holds.
    assert.ok(await repo.getFreeConceptClaim(sessionId));
    assert.equal(
      (await acquisition.authorizeConceptGeneration(projectId)).allowed,
      false,
    );
  });

  it("11: a same-job retry still resumes rather than being refused", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await freeProspect(harness);

    // Same project, same approved version → same idempotency key. The claim
    // must not turn a legitimate resume into a refusal.
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);
    await drainWorker(harness);
    assert.equal(harness.provider.submissions.length, 1);
  });

  it("17: ordinary and internal jobs never take a claim", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await ordinaryProject(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    const internalSession =
      await harness.repo.createAcquisitionSession("internal-token");
    await harness.repo.grantInternalEntitlement(internalSession.id);
    const internalProject = await harness.repo.createProject(internalSession.id);
    await harness.repo.updateBrief(internalProject.project.id, {
      productSummary: "Hoodies",
    });
    const internalVersion = await harness.designBrief.approveWorkingBrief(
      internalProject.project.id,
    );
    await harness.conceptGeneration.generatePlaceholders(
      internalProject.project.id,
      internalVersion.id,
    );

    // An internal grant is entitled, not free — it must not spend the claim.
    assert.equal(
      await harness.repo.getFreeConceptClaim(internalSession.id),
      null,
    );
    const internalJob = (
      await harness.repo.listGenerationJobs(internalProject.project.id)
    )[0];
    assert.equal(internalJob?.acquisitionSessionId, null);
    assert.equal(internalJob?.conceptCount, 3);
    assert.equal(maxPhysicalDispatchesForGenerationJob(internalJob!), 3);
  });
});
