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
  type ConceptEvaluationProvider,
  type ConceptEvaluationResult,
} from "@/capabilities/concept-evaluation";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
  GeneratedConceptDraft,
} from "@/capabilities/shared/contracts";
import {
  ACQUISITION_FREE_CONCEPT_PAID_INTENT_BUDGET,
  paidIntentBudgetForGenerationJob,
  paidIntentBudgetForJob,
} from "@/capabilities/shared/paid-image-intent";
import { FreeConceptAlreadyConsumedError } from "@/lib/db/repository";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConceptDirectionKey,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createAcquisitionCapability } from "./acquisition-capability";
import { ACQUISITION_UNAVAILABLE_MESSAGE } from "./acquisition-copy";

/**
 * Sprint A4 CORRECTION 1 — acquisition spend authority.
 *
 * An independent audit found four defects, all of the same shape: the
 * entitlement was APPLICATION state the database had no opinion about, so
 * every guarantee depended on a write actually happening rather than on a
 * constraint that cannot be circumvented.
 *
 *   P0-1  one free concept could buy THREE paid images (Phase 2C
 *         replacement allowance survived `conceptCount: 1`)
 *   P0-2  job insert and consumption marker were separate writes; a crash
 *         between them left an executable job AND an apparently unspent
 *         session
 *   P1-3  deleting the job erased the consumed marker
 *   P1-4  a project bound to a missing session degraded to unrestricted
 *         legacy access
 *
 * Every test below counts PAID PROVIDER DISPATCHES against local doubles.
 * No network, no credentials, no possibility of a real paid call —
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (test bootstrap preload) independently
 * forces every provider resolver to its safe local implementation.
 */

const CANVAS = 16;
const CANVAS_PIXELS = CANVAS * CANVAS;

/**
 * A raster that hard-FAILS the deterministic print-palette validator: every
 * pixel is black on a brief that explicitly restricts production to white
 * ink only. Copied in shape from the Phase 2C fixtures so the SAME real
 * validator reaches the SAME verdict — a fake verdict would make the
 * "no replacement is bought" claim meaningless.
 */
function allBlackPng(): Buffer {
  const png = new PNG({ width: CANVAS, height: CANVAS });
  for (let i = 0; i < CANVAS_PIXELS; i += 1) {
    png.data[i * 4] = 0;
    png.data[i * 4 + 1] = 0;
    png.data[i * 4 + 2] = 0;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

/** The brief shape Phase 2C treats as an EXPLICIT ink restriction. */
function explicitWhiteInkOnlyBrief(): Partial<DesignBriefSnapshotContent> {
  return {
    productSummary: "T-shirts",
    designDescription:
      "A black motorcycle with a black leather seat and a black helmet",
    exactText: "IRON HORSE",
    shirtColor: "Black",
    preferredColors: ["White"],
    additionalInstructions: "ONE COLOR WHITE INK ONLY. DO NOT USE BLACK INK.",
  };
}

class AlwaysPassVisionProvider implements ConceptEvaluationProvider {
  readonly providerKey = "always-pass";
  async evaluate(): Promise<ConceptEvaluationResult> {
    return {
      overallAlignment: "strong",
      confidence: "high",
      criteria: {},
      violations: [],
      providerMetadata: {},
    } as unknown as ConceptEvaluationResult;
  }
}

/**
 * Counts every paid dispatch and can be told to produce pixels the real
 * validator hard-fails — the exact condition that would purchase a Phase 2C
 * replacement on an ordinary job.
 */
class CountingPaidProvider implements ConceptGenerationProvider {
  readonly providerKey = "counting-paid";
  readonly editsSourceArtwork = true;

  readonly dispatches: Array<{
    directionKey: ConceptDirectionKey | "batch";
    isReplacement: boolean;
  }> = [];

  constructor(private readonly hardFail: boolean = false) {}

  get totalDispatches(): number {
    return this.dispatches.length;
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
        imageBytes: this.hardFail ? allBlackPng() : tinyPng(),
        contentType: "image/png",
        widthPx: this.hardFail ? CANVAS : 4,
        heightPx: this.hardFail ? CANVAS : 4,
        hasTransparency: false,
        providerMetadata: {},
      },
    } as unknown as GeneratedConceptDraft;
  }

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.dispatches.push({ directionKey: "batch", isReplacement: false });
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
    this.dispatches.push({
      directionKey,
      // A replacement is the only dispatch carrying the deterministic
      // palette correction — the same signal a real adapter reads.
      isReplacement: Boolean(
        (request.prompt as { printPaletteCorrection?: unknown })
          .printPaletteCorrection,
      ),
    });
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [this.draft(directionKey)],
    };
  }
}

describe("Sprint A4 Correction 1 — acquisition spend authority", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-a4-authority-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness(options: { hardFail?: boolean } = {}) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();

    // The local store is one JSON file for this whole file's tests, and
    // `claimNextQueuedJob` claims the oldest due job across every project.
    // Retiring leftovers keeps each test's dispatch count its own.
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }

    const provider = new CountingPaidProvider(options.hardFail ?? false);
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
      createConceptEvaluationCapability(new AlwaysPassVisionProvider()),
    );
    const designBrief = createDesignBriefCapability(repo);

    return { repo, provider, acquisition, conceptGeneration, worker, designBrief };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;

  /**
   * A prospect with an approved brief, ready to generate. Deliberately built
   * from repository primitives rather than a full interview: every claim in
   * this file is about the authority around job creation, and a 20-turn
   * conversation in front of each one would only add ways to be flaky.
   */
  async function approvedProspect(
    harness: Harness,
    brief: Partial<DesignBriefSnapshotContent> = { productSummary: "T-shirts" },
  ) {
    tokenCounter += 1;
    const session = await harness.repo.createAcquisitionSession(
      `token-${tokenCounter}`,
    );
    const created = await harness.repo.createProject(session.id);
    await harness.repo.updateBrief(created.project.id, brief);
    const version = await harness.designBrief.approveWorkingBrief(
      created.project.id,
    );
    return { sessionId: session.id, projectId: created.project.id, version };
  }

  /* ================================================================== */
  /* GOAL 17 — free-job economics                                        */
  /* ================================================================== */

  it("17-A/B: the free job is conceptCount 1 AND paid-image budget 1", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await approvedProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    const [job] = await harness.repo.listGenerationJobs(projectId);

    assert.equal(job?.conceptCount, 1);
    assert.equal(job?.acquisitionSessionId, sessionId);
    // THE P0-1 DEFECT, pinned. `paidIntentBudgetForJob(1)` is 3 — the
    // replacement allowance is added on top of the concept count — so a
    // "one free concept" job used to carry a three-image budget.
    assert.equal(paidIntentBudgetForJob(job!.conceptCount), 3);
    assert.equal(paidIntentBudgetForGenerationJob(job!), 1);
    assert.equal(
      paidIntentBudgetForGenerationJob(job!),
      ACQUISITION_FREE_CONCEPT_PAID_INTENT_BUDGET,
    );
  });

  it("17-C: an ordinary three-concept job keeps its normal budget, untouched", async () => {
    const harness = await buildHarness();
    // No acquisition session — a legacy/internal job, which is every job
    // the product had before A4.
    const created = await harness.repo.createProject();
    await harness.repo.updateBrief(created.project.id, {
      productSummary: "T-shirts",
    });
    const version = await harness.designBrief.approveWorkingBrief(
      created.project.id,
    );
    await harness.conceptGeneration.generatePlaceholders(
      created.project.id,
      version.id,
    );
    const [job] = await harness.repo.listGenerationJobs(created.project.id);

    assert.equal(job?.conceptCount, 3);
    assert.equal(job?.acquisitionSessionId, null);
    assert.equal(paidIntentBudgetForGenerationJob(job!), 5);
  });

  it("17-D/E/H: a hard-failing free concept buys NO replacement, and is still delivered", async () => {
    const harness = await buildHarness({ hardFail: true });
    const { projectId, version } = await approvedProspect(
      harness,
      explicitWhiteInkOnlyBrief(),
    );

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.worker.processNextJob();

    // Exactly one paid dispatch, and none of them a replacement. On an
    // ordinary job these same pixels and this same brief purchase a
    // replacement image (Phase 2C) — that behavior is unchanged there.
    assert.equal(harness.provider.totalDispatches, 1);
    assert.equal(
      harness.provider.dispatches.filter((d) => d.isReplacement).length,
      0,
    );

    const [job] = await harness.repo.listGenerationJobs(projectId);
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(intents.length, 1);

    // And — the part that makes skipping the replacement safe rather than
    // merely cheap — the concept is NOT withheld. Withholding is right for a
    // batch of three (two good directions still land); for a batch of one it
    // would deliver nothing at all while the entitlement was already spent.
    const snapshot = await harness.repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 1);
  });

  it("17-F/G: a worker resume reuses the same paid intent and never a second dispatch", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await approvedProspect(harness);

    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.worker.processNextJob();

    const [job] = await harness.repo.listGenerationJobs(projectId);
    // Force the job back to claimable, exactly as `recoverAbandonedJobs`
    // leaves a worker that died mid-attempt.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await harness.repo.updateGenerationJob(job!.id, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });
    await harness.repo.recoverAbandonedJobs(1000);
    await harness.worker.processNextJob();

    assert.equal(harness.provider.totalDispatches, 1);
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      job!.id,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.dispatches, 1);

    const snapshot = await harness.repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 1);
  });

  /* ================================================================== */
  /* GOAL 16 / GOAL 4 — failure injection across the crash windows       */
  /* ================================================================== */

  /** Fails the named repository method once, then passes everything through. */
  function failingOnce(
    repo: ProjectRepository,
    method: keyof ProjectRepository,
  ): ProjectRepository {
    let shouldFail = true;
    return new Proxy(repo, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const bound = value.bind(target) as (...a: unknown[]) => Promise<unknown>;
        if (property !== method) return bound;
        return async (...args: unknown[]) => {
          if (shouldFail) {
            shouldFail = false;
            throw { code: "PGRST204", message: "injected failure" };
          }
          return bound(...args);
        };
      },
    }) as ProjectRepository;
  }

  it("4-A / 18-C: allocation succeeds, job insert crashes → same project retries, nothing spent", async () => {
    const base = await buildHarness();
    const repo = failingOnce(base.repo, "createGenerationJob");
    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      base.provider.providerKey,
      undefined,
      acquisition,
    );
    const { sessionId, projectId, version } = await approvedProspect(base);

    await assert.rejects(() =>
      conceptGeneration.generatePlaceholders(projectId, version.id),
    );

    // ALLOCATED but not CONSUMED. No job exists, so nothing was spent, and
    // the free concept must still be the customer's.
    const stranded = await repo.getAcquisitionSession(sessionId);
    assert.equal(stranded?.freeConceptProjectId, projectId);
    assert.equal(stranded?.freeConceptConsumedAt, null);
    assert.equal((await repo.listGenerationJobs(projectId)).length, 0);
    assert.equal(await repo.getFreeConceptGenerationJob(sessionId), null);

    // The retry resumes the same allocation and produces the one job.
    await conceptGeneration.generatePlaceholders(projectId, version.id);
    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.conceptCount, 1);
    assert.equal(jobs[0]?.acquisitionSessionId, sessionId);
  });

  it("4-B / 18-D: job insert succeeds, consumption marker crashes → NO second free job, ever", async () => {
    const base = await buildHarness();
    const repo = failingOnce(base.repo, "recordFreeConceptConsumed");
    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      base.provider.providerKey,
      undefined,
      acquisition,
    );
    const { sessionId, projectId, version } = await approvedProspect(base);

    // The marker write fails. It is deliberately swallowed — the job is
    // already durable and queued, and failing the customer's request would
    // not un-spend it.
    await conceptGeneration.generatePlaceholders(projectId, version.id);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    const firstJobId = jobs[0]!.id;

    // THE P0-2 STATE: an executable job exists, and the marker does not.
    const session = await repo.getAcquisitionSession(sessionId);
    assert.equal(session?.freeConceptConsumedAt, null);
    assert.equal(session?.freeConceptGenerationJobId, null);

    // Reconciliation from durable evidence: the job itself answers the
    // question the missing marker cannot.
    assert.equal(
      (await repo.getFreeConceptGenerationJob(sessionId))?.id,
      firstJobId,
    );
    const authorization =
      await acquisition.authorizeConceptGeneration(projectId);
    assert.equal(authorization.allowed, false);

    // And a genuinely NEW request — a second project in the same session,
    // the strongest form of the bypass — cannot create a second free job.
    const secondProject = await repo.createProject(sessionId);
    await repo.updateBrief(secondProject.project.id, {
      productSummary: "Hoodies",
    });
    const secondVersion = await createDesignBriefCapability(
      repo,
    ).approveWorkingBrief(secondProject.project.id);
    await conceptGeneration.generatePlaceholders(
      secondProject.project.id,
      secondVersion.id,
    );

    assert.equal(
      (await repo.listGenerationJobs(secondProject.project.id)).length,
      0,
    );
    assert.equal(
      (await repo.getFreeConceptGenerationJob(sessionId))?.id,
      firstJobId,
    );
  });

  it("4-B: the database itself refuses the second free job, not just the pre-check", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await approvedProspect(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    // Bypasses every application pre-check and goes straight at the store —
    // exactly what a lost consumption write plus a racing request amounts
    // to. The constraint is the guarantee; the pre-check is only an
    // optimization.
    await assert.rejects(
      () =>
        harness.repo.createGenerationJob(projectId, {
          designBriefVersionId: version.id,
          kind: "initial",
          conceptCount: 1,
          providerKey: "counting-paid",
          idempotencyKey: "a-completely-different-key",
          acquisitionSessionId: sessionId,
        }),
      (error: unknown) => error instanceof FreeConceptAlreadyConsumedError,
    );
  });

  it("4-C/D/E / 18-E: consumed survives reload, worker resume, and terminal failure", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await approvedProspect(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    const [job] = await harness.repo.listGenerationJobs(projectId);

    // C: consumed, worker never ran.
    assert.ok(
      (await harness.repo.getAcquisitionSession(sessionId))
        ?.freeConceptConsumedAt,
    );
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 1);

    // E: the job fails terminally. A provider that could not deliver is not
    // a reason to hand out a fresh free entitlement.
    await harness.repo.updateGenerationJob(job!.id, {
      status: "failed",
      attempts: 3,
      lastError: "terminal",
    });
    const authorization =
      await harness.acquisition.authorizeConceptGeneration(projectId);
    assert.equal(authorization.allowed, false);
    assert.equal(
      (await harness.repo.getFreeConceptGenerationJob(sessionId))?.id,
      job!.id,
    );
    assert.equal(harness.provider.totalDispatches, 0);
  });

  /* ================================================================== */
  /* GOAL 18 — entitlement matrix                                        */
  /* ================================================================== */

  it("18-B: concurrent free-job creation produces exactly one job", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await approvedProspect(harness);

    await Promise.all([
      harness.conceptGeneration.generatePlaceholders(projectId, version.id),
      harness.conceptGeneration.generatePlaceholders(projectId, version.id),
      harness.conceptGeneration.generatePlaceholders(projectId, version.id),
    ]);

    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.acquisitionSessionId, sessionId);

    await harness.worker.processNextJob();
    await harness.worker.processNextJob();
    assert.equal(harness.provider.totalDispatches, 1);
  });

  it("18-F: consumption survives deletion of the job it names", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await approvedProspect(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);

    const session = await harness.repo.getAcquisitionSession(sessionId);
    assert.ok(session?.freeConceptConsumedAt);
    assert.ok(session?.freeConceptGenerationJobId);

    // THE P1-3 DEFECT. `free_concept_generation_job_id` used to be a foreign
    // key with ON DELETE SET NULL, so removing the job erased the only
    // record that the entitlement had been spent. The column is now an
    // immutable historical reference with no FK, and `freeConceptConsumedAt`
    // beside it is a timestamp nothing cascades to.
    //
    // The repository deliberately exposes no `deleteGenerationJob`, so the
    // job's ABSENCE is simulated at the boundary that would observe it:
    // reconciliation returns nothing, exactly as it would if the row were
    // gone. That isolates the claim precisely — the marker alone, with no
    // job to reconcile from, must still refuse.
    //
    // Real DELETE semantics (and the RESTRICT rules protecting the session
    // itself) are proved against actual PostgreSQL in
    // `scripts/verify-acquisition-authority-postgres.mjs`.
    const withoutJob = new Proxy(harness.repo, {
      get(target, property, receiver) {
        if (property === "getFreeConceptGenerationJob") {
          return async () => null;
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectRepository;

    const survived = await withoutJob.getAcquisitionSession(sessionId);
    assert.ok(survived?.freeConceptConsumedAt);
    assert.equal(
      (
        await createAcquisitionCapability(
          withoutJob,
        ).authorizeConceptGeneration(projectId)
      ).allowed,
      false,
    );
  });

  it("18-G: a project bound to a MISSING session fails closed — never legacy", async () => {
    const harness = await buildHarness();
    // A project naming a session that does not exist. THE P1-4 DEFECT: this
    // used to resolve to the same `null` as a legacy project and was
    // therefore grandfathered into unrestricted generation and finalization.
    const created = await harness.repo.createProject(
      "00000000-0000-4000-8000-000000000000",
    );
    await harness.repo.updateBrief(created.project.id, {
      productSummary: "T-shirts",
    });
    const version = await harness.designBrief.approveWorkingBrief(
      created.project.id,
    );

    const authorization = await harness.acquisition.authorizeConceptGeneration(
      created.project.id,
    );
    assert.equal(authorization.allowed, false);
    assert.equal(
      authorization.allowed === false && authorization.reason,
      "authority_unavailable",
    );

    // Finalization too — an upload project's only acquisition gate.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(created.project.id))
        .allowed,
      false,
    );

    // And continuing the session.
    assert.equal(
      (
        await harness.acquisition.authorizeSessionContinuation(
          created.project.id,
          true,
        )
      ).allowed,
      false,
    );

    // No job, no spend.
    await harness.conceptGeneration.generatePlaceholders(
      created.project.id,
      version.id,
    );
    assert.equal(
      (await harness.repo.listGenerationJobs(created.project.id)).length,
      0,
    );
    assert.equal(harness.provider.totalDispatches, 0);
  });

  it("18-H: a legacy NULL project is still deliberately grandfathered", async () => {
    const harness = await buildHarness();
    const created = await harness.repo.createProject();
    assert.equal(created.project.acquisitionSessionId, null);

    const authorization = await harness.acquisition.authorizeConceptGeneration(
      created.project.id,
    );
    assert.equal(authorization.allowed, true);
    assert.equal(authorization.allowed === true && authorization.grant, "entitled");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(created.project.id))
        .allowed,
      true,
    );
  });

  it("18-I: the customer project route cannot create a NULL-authority project", async () => {
    const harness = await buildHarness();
    // `resolveOrCreateSession` always yields a session — with no cookie, an
    // unrecognized cookie, or an empty one — so the id passed to
    // `createProject` on the customer path is never null.
    for (const token of [null, "", "not-a-real-token"]) {
      const session = await harness.acquisition.resolveOrCreateSession(token);
      assert.ok(session.id);
      const created = await harness.repo.createProject(session.id);
      assert.equal(created.project.acquisitionSessionId, session.id);
    }
  });

  /* ================================================================== */
  /* GOAL 10 — customer view fails closed                                */
  /* ================================================================== */

  it("10: missing authority shows a neutral unavailable state, never `open`", async () => {
    const harness = await buildHarness();
    const created = await harness.repo.createProject(
      "00000000-0000-4000-8000-000000000001",
    );

    const view = await harness.acquisition.describeForCustomer(
      created.project.id,
      { conceptDelivered: false, generating: false },
    );
    assert.equal(view.state, "unavailable");
    assert.equal(view.message, ACQUISITION_UNAVAILABLE_MESSAGE);
    assert.equal(view.emailCaptured, false);
  });

  it("10: the unavailable state and copy leak nothing internal", async () => {
    const harness = await buildHarness();
    const created = await harness.repo.createProject(
      "00000000-0000-4000-8000-000000000002",
    );
    const view = await harness.acquisition.describeForCustomer(
      created.project.id,
      { conceptDelivered: true, generating: false },
    );

    const serialized = JSON.stringify(view);

    // Identifiers first — nothing that could be a session, project, or job
    // id may appear, in any form.
    assert.doesNotMatch(
      serialized,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      `unavailable view leaked an id: ${serialized}`,
    );

    // Then internal vocabulary. "design session" is deliberately NOT on this
    // list: it is the customer's own words for the thing they are doing, and
    // the one term here that is genuinely theirs rather than ours.
    for (const forbidden of [
      "acquisitionSession",
      "entitlement",
      "prospect",
      "internal",
      "legacy",
      "unavailable_authority",
      "authority",
      "database",
      "PGRST",
      "sessionToken",
      "generationJob",
    ]) {
      assert.equal(
        serialized.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `unavailable view leaked "${forbidden}": ${serialized}`,
      );
    }
  });

  it("10: the customer state agrees with what the gate will actually do", async () => {
    const harness = await buildHarness();
    const { projectId, version } = await approvedProspect(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.worker.processNextJob();

    // Spent, no email → the view says email_required and the gate refuses.
    const view = await harness.acquisition.describeForCustomer(projectId, {
      conceptDelivered: true,
      generating: false,
    });
    assert.equal(view.state, "email_required");
    assert.equal(
      (await harness.acquisition.authorizeConceptGeneration(projectId)).allowed,
      false,
    );
  });

  /* ================================================================== */
  /* GOAL 13 — defence in depth: both layers, independently              */
  /* ================================================================== */

  it("13: authority and economics are independent layers, and both hold", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, version } = await approvedProspect(harness);
    await harness.conceptGeneration.generatePlaceholders(projectId, version.id);
    await harness.worker.processNextJob();

    const jobs = await harness.repo.listGenerationJobs(projectId);

    // Layer 1 — acquisition authority: exactly one authorized job, enforced
    // by a uniqueness rule the application cannot talk its way past.
    assert.equal(jobs.length, 1);
    assert.equal(
      (await harness.repo.getFreeConceptGenerationJob(sessionId))?.id,
      jobs[0]!.id,
    );

    // Layer 2 — worker economics: exactly one paid intent, one dispatch,
    // bounded independently of whether layer 1 held.
    const intents = await harness.repo.listPaidImageIntentsForJob(
      projectId,
      jobs[0]!.id,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.dispatches, 1);
    assert.equal(paidIntentBudgetForGenerationJob(jobs[0]!), 1);
    assert.equal(harness.provider.totalDispatches, 1);
  });
});
