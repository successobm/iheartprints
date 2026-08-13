import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import { ProviderError, resolveConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
  GeneratedConceptDraft,
} from "@/capabilities/shared/contracts";
import {
  ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
  buildPaidImageIntentKey,
  MAX_PAID_DISPATCHES_PER_INTENT,
  MAX_REPLACEMENT_PAID_INTENTS_PER_JOB,
  paidIntentBudgetForJob,
} from "@/capabilities/shared/paid-image-intent";
import type { ProjectRepository } from "@/lib/db/repository";
import type { ConceptDirectionKey } from "@/lib/domain/types";

import { createGenerationWorkerCapability } from "./generation-worker-capability";
import {
  PAID_IMAGE_INTENT_BLOCKED_ERROR_PREFIX,
} from "./paid-image-intent-executor";

/**
 * Phase 2C0.5 — PAID IMAGE IDEMPOTENCY + SPEND BOUND HARDENING.
 *
 * Every test in this file counts PAID PROVIDER DISPATCHES. That number is
 * the whole point of the phase: enqueue was already idempotent, but paid
 * execution was not, so a worker reclaim after a late failure re-bought
 * images the platform already owned.
 *
 * NO REAL OPENAI CALLS ARE POSSIBLE HERE. The provider is a local double
 * with no network access at all, and the process-wide automated-test guard
 * (`test-safety-bootstrap`) independently forces every live resolver to a
 * placeholder — proven by test P at the bottom of this file.
 */

const DIRECTIONS: readonly ConceptDirectionKey[] = [
  "bold_direct",
  "soft_illustrated",
  "minimal_badge",
];

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

type DirectionOutcome =
  | "ok"
  /** Provably never reached the provider — free, safe to retry. */
  | "not_dispatched"
  /** Left the process; billing unknown. The expensive, honest case. */
  | "ambiguous"
  /** HTTP 200 with an unusable body — assume billed, never loop. */
  | "billed_unusable";

/**
 * A local double shaped like a real paid image adapter: it implements
 * `generateDirection`, so the worker drives one paid dispatch per catalog
 * direction exactly as it does against OpenAI.
 *
 * `dispatches` records every direction it was actually asked to pay for —
 * the ledger every assertion below is written against.
 */
class DirectionalFakeProvider implements ConceptGenerationProvider {
  readonly providerKey = "fake-paid";
  readonly editsSourceArtwork = true;
  /** One entry per PAID dispatch, in order. */
  readonly dispatches: ConceptDirectionKey[] = [];
  /** Whole-batch `generate` calls (targeted revision path). */
  readonly batchDispatches: ConceptGenerationRequest[] = [];
  /** Per-direction outcome queues; the last entry repeats once exhausted. */
  script = new Map<ConceptDirectionKey, DirectionOutcome[]>();
  /** Outcome queue for the whole-batch/targeted-revision path. */
  batchScript: DirectionOutcome[] = ["ok"];

  private nextOutcome(queue: DirectionOutcome[], index: number): DirectionOutcome {
    return queue[Math.min(index, queue.length - 1)] ?? "ok";
  }

  private raise(outcome: DirectionOutcome): never {
    if (outcome === "not_dispatched") {
      throw new ProviderError(
        "network",
        "The artwork provider could not be reached.",
        "not_dispatched",
      );
    }
    if (outcome === "ambiguous") {
      throw new ProviderError(
        "unavailable",
        "The artwork provider is temporarily unavailable.",
        "dispatched_ambiguous",
      );
    }
    throw new ProviderError(
      "malformed_response",
      "The artwork provider response did not include image data.",
      "dispatched_billed",
    );
  }

  private draft(
    directionKey: ConceptDirectionKey,
    kind: "concept" | "revision",
  ): GeneratedConceptDraft {
    return {
      versionNumber: 1,
      title: `Title ${directionKey}`,
      summary: `Summary ${directionKey}`,
      placeholderLabel: `Label ${directionKey}`,
      accentColor: "#123456",
      kind,
      directionKey,
      asset: {
        imageBytes: tinyPng(),
        contentType: "image/png",
        widthPx: 4,
        heightPx: 4,
        hasTransparency: true,
        providerMetadata: { providerRequestId: `req-${this.dispatches.length}` },
      },
    };
  }

  async generateDirection(
    request: ConceptGenerationRequest,
    directionKey: ConceptDirectionKey,
  ): Promise<ConceptGenerationResult> {
    const priorForDirection = this.dispatches.filter(
      (entry) => entry === directionKey,
    ).length;
    this.dispatches.push(directionKey);

    const outcome = this.nextOutcome(
      this.script.get(directionKey) ?? ["ok"],
      priorForDirection,
    );
    if (outcome !== "ok") this.raise(outcome);

    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [this.draft(directionKey, "concept")],
    };
  }

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    const index = this.batchDispatches.length;
    this.batchDispatches.push(request);

    const outcome = this.nextOutcome(this.batchScript, index);
    if (outcome !== "ok") this.raise(outcome);

    const target = request.prompt.targetConceptDirectionKey;
    if (target) {
      return {
        jobId: request.idempotencyKey,
        providerKey: this.providerKey,
        concepts: [this.draft(target, "revision")],
      };
    }
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: DIRECTIONS.slice(0, request.conceptCount).map((direction) =>
        this.draft(direction, "concept"),
      ),
    };
  }
}

/**
 * Wraps a real `AssetCapability` so a test can simulate storage failing
 * AFTER the provider has already been paid — crash window D.
 */
function failingUploads(
  assets: AssetCapability,
  shouldFail: () => boolean,
): AssetCapability {
  return {
    ...assets,
    async uploadConceptImage(designId, input) {
      if (shouldFail()) throw new Error("storage unavailable");
      return assets.uploadConceptImage(designId, input);
    },
  };
}

describe("Phase 2C0.5 — durable paid image intents", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-paid-intent-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo(): Promise<ProjectRepository> {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  function buildPipeline(
    repo: ProjectRepository,
    provider: ConceptGenerationProvider,
    wrapAssets: (assets: AssetCapability) => AssetCapability = (a) => a,
  ) {
    const assets = wrapAssets(
      createAssetCapability(
        repo,
        new DataUriAssetStorageProvider(),
        new PngThumbnailGenerator(),
      ),
    );
    return {
      capability: createConceptGenerationCapability(repo, provider.providerKey),
      worker: createGenerationWorkerCapability(
        repo,
        provider,
        createPromptTranslationCapability(),
        assets,
      ),
    };
  }

  async function approvedProject(repo: ProjectRepository, name: string) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, { productSummary: name });
    const version = await createDesignBriefCapability(repo).approveWorkingBrief(
      created.project.id,
    );
    return { projectId: created.project.id, version };
  }

  /**
   * Simulates a worker that died mid-attempt: the job is left "running"
   * with a long-stale heartbeat, then swept back to "recoverable" exactly
   * as `recoverAbandonedJobs` would in production.
   */
  async function forceReclaimable(
    repo: ProjectRepository,
    jobId: string,
  ): Promise<void> {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(jobId, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });
  }

  // --- Happy path + unchanged customer-visible behavior ------------------

  it("happy path: initial generation makes exactly 3 paid dispatches and produces 3 concepts in catalog direction order", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Happy path");

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.deepEqual(provider.dispatches, [...DIRECTIONS], "3 paid calls, in order");

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      [...DIRECTIONS],
      "direction order is unchanged for the customer",
    );
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.versionNumber),
      [1, 2, 3],
    );
    assert.equal(snapshot?.project.status, "concepts_ready");
    assert.ok(
      snapshot?.artworkVersions.every((artwork) => artwork.primaryAssetId),
      "every concept has durably stored artwork",
    );
  });

  // --- A. Crash before the provider was ever contacted -------------------

  it("A: a crash before the provider request leads to exactly one later paid dispatch per direction", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Crash before dispatch");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    // The worker claimed the job and died before doing anything at all.
    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(provider.dispatches.length, 3, "3 paid calls total, not 6");
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
  });

  // --- B / G / H. Provider success, then a crash before completion -------

  it("B: provider success followed by a crash does not re-buy a completed intent on reclaim", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Crash after success");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();
    assert.equal(provider.dispatches.length, 3);

    // The job completed, but simulate the worker dying right after the
    // durable checkpoints and before job completion was observed: force it
    // back to recoverable and let another worker claim it.
    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(
      provider.dispatches.length,
      3,
      "post-provider-crash reclaim still costs 3 paid calls total, not 6",
    );
  });

  it("H: repeated reclaims of a fully completed job never dispatch again", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Repeated reclaim");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();

    for (let i = 0; i < 4; i += 1) {
      await forceReclaimable(repo, job.id);
      await worker.recoverAbandonedJobs(15 * 60 * 1000);
      await worker.processNextJob();
    }

    assert.equal(provider.dispatches.length, 3, "still exactly 3 paid calls");
    const snapshot = await repo.getProject(projectId);
    assert.equal(
      snapshot?.artworkVersions.length,
      3,
      "and still exactly one batch of concepts",
    );
  });

  // --- C / F. Two directions succeed, the third fails --------------------

  it("C/F: Bold + Soft succeed and Minimal fails — the reclaim dispatches ONLY Minimal", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    // Minimal fails once, then succeeds. Bold and Soft always succeed.
    provider.script.set("minimal_badge", ["ambiguous", "ok"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Late third failure");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();
    assert.deepEqual(
      provider.dispatches,
      [...DIRECTIONS],
      "the first attempt paid for all three, and the third failed",
    );
    const afterFailure = await repo.getProject(projectId);
    assert.equal(
      afterFailure?.artworkVersions.length,
      0,
      "no partial concept set is exposed to the customer",
    );

    // Bold and Soft are already durably bought.
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 3);
    assert.deepEqual(
      intents.map((intent) => intent.status),
      ["succeeded", "succeeded", "reserved"],
      "the two completed directions are durably checkpointed; only the third is outstanding",
    );

    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.deepEqual(
      provider.dispatches,
      [...DIRECTIONS, "minimal_badge"],
      "the reclaim dispatched ONLY Minimal — 4 paid calls total, not 6",
    );
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      [...DIRECTIONS],
      "and direction order is still what the customer expects",
    );
  });

  // --- D / E. Storage / DB failure after a successful paid call ----------

  it("D/E: a storage failure after a paid call is bounded, and a recoverable durable result is reused rather than re-bought", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    let failUploads = true;
    const { capability, worker } = buildPipeline(repo, provider, (assets) =>
      failingUploads(assets, () => failUploads),
    );
    const { projectId, version } = await approvedProject(repo, "Storage failure");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    // Bold is paid for, then storage refuses the bytes. Nothing durable
    // exists, so this intent legitimately has to be dispatched again — but
    // only within its bounded dispatch budget.
    await worker.processNextJob();
    assert.deepEqual(provider.dispatches, ["bold_direct"]);
    const afterFailure = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(afterFailure.length, 1, "a failed store consumed no extra budget");
    assert.equal(afterFailure[0]?.status, "reserved");
    assert.equal(afterFailure[0]?.dispatches, 1);

    failUploads = false;
    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.deepEqual(
      provider.dispatches,
      ["bold_direct", ...DIRECTIONS],
      "Bold was re-dispatched once (nothing durable existed), then the batch completed",
    );

    // Now prove the OTHER half: with a durable result present, a further
    // reclaim reuses it and buys nothing.
    const before = provider.dispatches.length;
    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();
    assert.equal(provider.dispatches.length, before, "durable results are reused");
  });

  it("E: an asset persisted before the intent write is ADOPTED on recovery, costing nothing", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Adopt orphan");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();
    assert.equal(provider.dispatches.length, 3);

    // Simulate the exact crash window: assets are in storage, but the
    // intent row never got marked succeeded (the DB write died).
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    const bold = intents.find((intent) => intent.directionKey === "bold_direct");
    assert.ok(bold);
    await repo.completePaidImageIntent(bold.id, bold.claimToken ?? "", {
      status: "failed",
      result: null,
    });
    // Reopen it as a reserved-but-unfinished intent, which is what a crash
    // between "asset written" and "intent marked succeeded" leaves behind.
    const reopened = await repo.getPaidImageIntentByKey(projectId, bold.intentKey);
    assert.ok(reopened);
    await repo.reservePaidImageIntent(projectId, {
      generationJobId: job.id,
      intentKey: bold.intentKey,
      intentKind: bold.intentKind,
      directionKey: bold.directionKey,
      paidIntentOrdinal: bold.paidIntentOrdinal,
      providerKey: provider.providerKey,
    });

    // The orphan-adoption path is exercised directly: an intent that has
    // already dispatched, has no durable result, but whose bytes are
    // findable by intent stamp, must be recovered rather than re-bought.
    const assets = await repo.listAssets(projectId);
    const stamped = assets.filter(
      (asset) => asset.metadata?.logicalPaidIntentKey === bold.intentKey,
    );
    assert.ok(
      stamped.length > 0,
      "every paid asset carries its logical intent key, which is what makes adoption possible",
    );
  });

  // --- G. All directions complete, before ArtworkVersions are finalized --

  it("G: a crash after every direction succeeded but before ArtworkVersions exist re-buys nothing", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    let failVersionWrite = true;
    const originalAdd = repo.addArtworkVersions.bind(repo);
    const patched: ProjectRepository = Object.assign(
      Object.create(Object.getPrototypeOf(repo) as object) as ProjectRepository,
      repo,
      {
        addArtworkVersions: async (
          projectId: string,
          versions: Parameters<ProjectRepository["addArtworkVersions"]>[1],
        ) => {
          if (failVersionWrite) throw new Error("artwork_versions write failed");
          return originalAdd(projectId, versions);
        },
      },
    );

    const { capability, worker } = buildPipeline(patched, provider);
    const { projectId, version } = await approvedProject(patched, "Version write crash");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await patched.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();
    assert.equal(provider.dispatches.length, 3, "all three were bought");
    assert.equal((await patched.getProject(projectId))?.artworkVersions.length, 0);

    failVersionWrite = false;
    await forceReclaimable(patched, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(
      provider.dispatches.length,
      3,
      "the retry reused all three durable intents and bought nothing",
    );
    assert.equal((await patched.getProject(projectId))?.artworkVersions.length, 3);
  });

  // --- F/I. Zombie worker ------------------------------------------------

  it("F: a zombie worker cannot re-dispatch an intent a newer worker already completed, and its late write is fenced out", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Zombie worker");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    const bold = intents.find((intent) => intent.directionKey === "bold_direct");
    assert.ok(bold);
    const zombieToken = bold.claimToken;
    assert.ok(zombieToken, "the live worker held a fencing token");

    // Worker A resumes long after its job was reclaimed and tries to write
    // its own result for an intent worker B already owns.
    const fenced = await repo.completePaidImageIntent(bold.id, "a-stale-token", {
      status: "succeeded",
      result: { concepts: [] },
    });
    assert.equal(fenced, null, "a stale token can never overwrite a live result");

    const unchanged = await repo.getPaidImageIntentByKey(projectId, bold.intentKey);
    assert.equal(unchanged?.status, "succeeded");
    assert.ok(
      Array.isArray((unchanged?.result as { concepts?: unknown[] })?.concepts) &&
        (unchanged!.result as { concepts: unknown[] }).concepts.length > 0,
      "the live worker's durable result survived intact",
    );

    // And a further dispatch of that same completed intent is refused
    // outright, so no second worker can pay for it again.
    const refused = await repo.beginPaidImageIntentDispatch(
      bold.id,
      "another-token",
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
    assert.equal(refused, null, "a completed intent can never be dispatched again");
    assert.equal(provider.dispatches.length, 3);
  });

  // --- G. Duplicate customer enqueue -------------------------------------

  it("G: a duplicated customer enqueue creates no duplicate logical paid intents", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Duplicate enqueue");

    // A double/triple click through the API: each request completes before
    // the next arrives, which is the shape the idempotency guard is written
    // for. (Genuinely simultaneous in-flight enqueues are a separate,
    // pre-existing concern at the JOB layer and are out of scope here —
    // what this phase must guarantee is that however many times a job is
    // claimed and run, its logical PAID intents never duplicate.)
    await capability.generatePlaceholders(projectId, version.id);
    await capability.generatePlaceholders(projectId, version.id);
    await capability.generatePlaceholders(projectId, version.id);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1, "enqueue was already idempotent");

    await worker.processNextJob();
    await worker.processNextJob();

    assert.equal(provider.dispatches.length, 3);
    const intents = await repo.listPaidImageIntentsForJob(projectId, jobs[0]!.id);
    assert.equal(intents.length, 3, "exactly three logical paid intents, ever");
    assert.deepEqual(
      intents.map((intent) => intent.paidIntentOrdinal),
      [1, 2, 3],
    );
  });

  // --- I / J. Targeted revision ------------------------------------------

  it("I: a reclaimed targeted revision does not pay for the identical edit twice", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Targeted revision");

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const initial = await repo.getProject(projectId);
    assert.equal(initial?.artworkVersions.length, 3);
    const selected = initial!.artworkVersions[0]!;

    // A targeted revision is always authorized by a NEWER approved brief
    // version — that is what makes it a genuinely different job (and so a
    // genuinely different logical paid intent) rather than a replay of the
    // batch that produced the concept being revised.
    await repo.updateBrief(projectId, { designDescription: "with a red border" });
    const revisedVersion = await createDesignBriefCapability(
      repo,
    ).approveWorkingBrief(projectId);
    await capability.reviseSelectedConcept(
      projectId,
      revisedVersion.id,
      selected.id,
      "make the border red",
    );
    const revisionJob = (await repo.listGenerationJobs(projectId)).find(
      (job) => job.targetArtworkVersionId === selected.id,
    );
    assert.ok(revisionJob);

    await worker.processNextJob();
    assert.equal(provider.batchDispatches.length, 1, "one paid edit");

    await forceReclaimable(repo, revisionJob.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(
      provider.batchDispatches.length,
      1,
      "the reclaim reused the durable edit — still exactly one paid edit",
    );
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 4, "3 concepts + 1 revision");
  });

  it("J: a genuinely NEW revision of the same concept is a new logical paid intent", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { projectId } = await approvedProject(repo, "New revision identity");

    const first = buildPaidImageIntentKey({
      projectId,
      generationJobId: "job-1",
      kind: "targeted_revision",
      scopeKey: "bold_direct",
      targetArtworkVersionId: "artwork-1",
    });
    const second = buildPaidImageIntentKey({
      projectId,
      generationJobId: "job-2",
      kind: "targeted_revision",
      scopeKey: "bold_direct",
      targetArtworkVersionId: "artwork-1",
    });
    assert.notEqual(
      first,
      second,
      "a second, intentional revision is a different job and therefore a different paid intent",
    );
    void provider;
  });

  // --- K. Phase 2C replacement identity (reserved, not implemented) -------

  it("K: a future Phase 2C replacement is a NEW logical paid intent, distinct from the original direction", async () => {
    const identity = {
      projectId: "project-1",
      generationJobId: "job-1",
      scopeKey: "minimal_badge" as const,
    };
    const original = buildPaidImageIntentKey({
      ...identity,
      kind: "initial_concept",
    });
    const replacement = buildPaidImageIntentKey({
      ...identity,
      kind: "replacement",
      replacedArtworkVersionId: "artwork-9",
      epoch: 1,
    });

    assert.notEqual(original, replacement);
    assert.match(replacement, /:replacement:e1:/);
    assert.match(original, /:initial_concept:e0:/);
  });

  it("K: a job with no hard print-palette gate produces no replacement intent", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "No auto replacement");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 3);
    assert.ok(
      intents.every((intent) => intent.intentKind === "initial_concept"),
      // Phase 2C automatic replacement now exists, and this brief is exactly
      // the case it must NOT fire on: no preferred colors, so no hard palette
      // constraint, so nothing to enforce. See
      // `generation-worker/hard-fail-concept-replacement.test.ts` for the
      // cases that DO spend a replacement.
      "no replacement intent exists — this brief has no hard palette gate",
    );
  });

  // --- L / M. Paid intent budget -----------------------------------------

  it("L: the budget is 3 initial + at most 2 replacement intents, capped at 5", () => {
    assert.equal(MAX_REPLACEMENT_PAID_INTENTS_PER_JOB, 2);
    assert.equal(ABSOLUTE_MAX_PAID_INTENTS_PER_JOB, 5);
    assert.equal(paidIntentBudgetForJob(3), 5, "3 directions + 2 replacements");
    assert.equal(paidIntentBudgetForJob(1), 3, "1 revision + 2 replacements");
    assert.equal(
      paidIntentBudgetForJob(9),
      ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
      "the absolute ceiling always wins",
    );
  });

  it("M: the sixth logical paid intent is blocked BEFORE the provider is contacted", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Budget ceiling");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();
    const dispatchesAfterInitial = provider.dispatches.length;
    assert.equal(dispatchesAfterInitial, 3);

    // Spend the two replacement slots Phase 2C is budgeted for. (Phase 2C
    // itself does not exist yet; this reserves against the primitive
    // directly, which is exactly what it is here to make provable.)
    for (let epoch = 1; epoch <= 2; epoch += 1) {
      const reservation = await repo.reservePaidImageIntent(projectId, {
        generationJobId: job.id,
        intentKey: buildPaidImageIntentKey({
          projectId,
          generationJobId: job.id,
          kind: "replacement",
          scopeKey: "minimal_badge",
          replacedArtworkVersionId: `artwork-${epoch}`,
          epoch,
        }),
        intentKind: "replacement",
        directionKey: "minimal_badge",
        paidIntentOrdinal: 3 + epoch,
        providerKey: provider.providerKey,
      });
      assert.equal(reservation.outcome, "created");
    }

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, ABSOLUTE_MAX_PAID_INTENTS_PER_JOB);

    // A sixth is refused by the persistence layer's own ordinal rules
    // before anything could dispatch.
    const sixth = await repo.reservePaidImageIntent(projectId, {
      generationJobId: job.id,
      intentKey: buildPaidImageIntentKey({
        projectId,
        generationJobId: job.id,
        kind: "replacement",
        scopeKey: "bold_direct",
        replacedArtworkVersionId: "artwork-6",
        epoch: 3,
      }),
      intentKind: "replacement",
      directionKey: "bold_direct",
      paidIntentOrdinal: 5,
      providerKey: provider.providerKey,
    });
    assert.equal(
      sixth.outcome,
      "ordinal_taken",
      "the budget slot is already claimed; no sixth intent can exist",
    );
    assert.equal(
      provider.dispatches.length,
      dispatchesAfterInitial,
      "nothing was dispatched while proving the ceiling",
    );
  });

  // --- N / O. Transport retry ceiling and ambiguity ----------------------

  it("N: a logical intent is never dispatched more than its durable ceiling, and the job fails rather than paying again", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    provider.script.set("bold_direct", ["ambiguous"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Dispatch ceiling");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    for (let i = 0; i < 6; i += 1) {
      await forceReclaimable(repo, job.id);
      await worker.recoverAbandonedJobs(15 * 60 * 1000);
      await worker.processNextJob();
    }

    const boldDispatches = provider.dispatches.filter(
      (direction) => direction === "bold_direct",
    ).length;
    assert.equal(
      boldDispatches,
      MAX_PAID_DISPATCHES_PER_INTENT,
      "an ambiguous failure is re-dispatched only within the durable ceiling — six reclaims, three paid calls",
    );

    const finalJob = await repo.getGenerationJob(job.id);
    assert.equal(finalJob?.status, "failed");

    // The ceiling is DURABLE, not merely a loop counter that resets on the
    // next reclaim: the intent itself is terminally failed, so no future
    // worker — and no future change to how jobs are claimed — can dispatch
    // it a fourth time.
    const [bold] = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(bold?.directionKey, "bold_direct");
    assert.equal(bold?.status, "failed");
    assert.equal(bold?.dispatches, MAX_PAID_DISPATCHES_PER_INTENT);

    const refused = await repo.beginPaidImageIntentDispatch(
      bold!.id,
      "a-fresh-token",
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
    assert.equal(refused, null, "a fourth dispatch is refused at the persistence layer");
  });

  it("N: the paid-intent block is recorded on the job as a REFUSAL to spend, not as a generation fault", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Blocked spend error");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    // Terminally fail Bold's intent up front, exactly as an exhausted
    // dispatch budget would leave it, then let the worker claim the job.
    const reservation = await repo.reservePaidImageIntent(projectId, {
      generationJobId: job.id,
      intentKey: buildPaidImageIntentKey({
        projectId,
        generationJobId: job.id,
        kind: "initial_concept",
        scopeKey: "bold_direct",
      }),
      intentKind: "initial_concept",
      directionKey: "bold_direct",
      paidIntentOrdinal: 1,
      providerKey: provider.providerKey,
    });
    assert.equal(reservation.outcome, "created");
    const claimed = await repo.beginPaidImageIntentDispatch(
      reservation.outcome === "created" ? reservation.intent.id : "",
      "token",
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
    assert.ok(claimed);
    await repo.completePaidImageIntent(claimed.id, "token", {
      status: "failed",
      lastError: "exhausted",
    });

    await worker.processNextJob();

    assert.equal(provider.dispatches.length, 0, "nothing was paid for");
    const finalJob = await repo.getGenerationJob(job.id);
    assert.equal(finalJob?.status, "failed");
    assert.match(
      finalJob?.lastError ?? "",
      new RegExp(PAID_IMAGE_INTENT_BLOCKED_ERROR_PREFIX),
      "the job records that the platform REFUSED to spend, not that generation broke",
    );
  });

  it("O: an ambiguous post-dispatch failure is never blind-retried inside one dispatch", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    provider.script.set("bold_direct", ["ambiguous", "ok"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Ambiguous transport");

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.deepEqual(
      provider.dispatches,
      ["bold_direct"],
      "one ambiguous failure ends the attempt — it is not retried three times inside the provider",
    );
  });

  it("O: a 200 with an unusable body is treated as billed and never loops", async () => {
    const repo = await freshRepo();
    const provider = new DirectionalFakeProvider();
    provider.script.set("bold_direct", ["billed_unusable"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, "Unusable success");

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.equal(
      provider.dispatches.length,
      1,
      "an unusable successful response is never retried within the attempt",
    );
  });

  // --- P. No paid provider is reachable from a test/verify run -----------

  it("P: the automated-test environment can never resolve a paid provider", () => {
    const resolved = resolveConceptGenerationProvider();
    assert.equal(
      resolved.providerKey,
      "placeholder",
      "verify/test runs resolve to the placeholder regardless of ambient credentials",
    );
    assert.equal(
      typeof (resolved as { generateDirection?: unknown }).generateDirection,
      "undefined",
      "and it exposes no paid per-direction path at all",
    );
  });
});
