import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import type { AssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import {
  CONCEPT_EVALUATION_CRITERION_KEYS,
  createConceptEvaluationCapability,
  type ConceptEvaluationProvider,
  type ConceptEvaluationResult,
} from "@/capabilities/concept-evaluation";
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
  REPLACEMENT_PAID_INTENT_EPOCH,
} from "@/capabilities/shared/paid-image-intent";
import {
  PaidImagePersistenceError,
  classifyPaidImagePersistenceFailure,
  classifyProviderDispatchFailure,
  describePaidImageFailure,
  isPossiblyBilledFailureClass,
  readPaidImageFailureClass,
} from "@/capabilities/shared/paid-image-failure";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConceptDirectionKey,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";

import { createGenerationWorkerCapability } from "./generation-worker-capability";

/**
 * PHASE 2C.2C — FAILED PAID-INTENT DURABILITY / TERMINAL STATE HARDENING.
 *
 * THE LIVE DEFECT THIS FILE EXISTS FOR
 *
 * A live Soft replacement (project 969a2234…, job 2d5051ad…, ordinal 4,
 * epoch 1) reached OpenAI. A provider request id was issued and usage was
 * billed. Local persistence then failed, and the durable row ended:
 *
 *   status = reserved   dispatches = 1
 *   provider_request_id = null   result = null   last_error = null
 *
 * with the parent job `completed`, the project `concepts_ready`, Soft
 * withheld, and the replacement log claiming `paidCallMade: false`. Money had
 * moved and NOTHING durable said so.
 *
 * Every test below is written against that shape. The load-bearing
 * assertions are on DURABLE STATE (the `PaidImageIntent` row), not on
 * in-memory return values — the whole failure was that the in-memory truth
 * never reached the database.
 *
 * NO REAL OPENAI CALLS ARE POSSIBLE HERE. The providers are local doubles
 * with no network access, and the process-wide automated-test guard
 * (`test-safety-bootstrap`) independently forces every live resolver to a
 * placeholder — proven by test V at the bottom of this file.
 */

const DIRECTIONS: readonly ConceptDirectionKey[] = [
  "bold_direct",
  "soft_illustrated",
  "minimal_badge",
];

// --- Pixel fixtures -----------------------------------------------------
//
// The same white-on-black calibration the Phase 2B/2C suites use: the
// validator classifies dark ink as garment-matching, so the verdict is a
// direct function of how much black ink the artwork uses. Verdicts come from
// REAL pixels through the REAL validator — never a stubbed status.

type PaletteOutcome = "pass" | "warn" | "fail";

const CANVAS = 20;
const CANVAS_PIXELS = CANVAS * CANVAS;

function palettePng(outcome: PaletteOutcome): Buffer {
  const png = new PNG({ width: CANVAS, height: CANVAS });
  const darkPixels =
    outcome === "fail"
      ? CANVAS_PIXELS
      : outcome === "warn"
        ? Math.round(CANVAS_PIXELS * 0.15)
        : 0;
  for (let i = 0; i < CANVAS_PIXELS; i += 1) {
    const value = i < darkPixels ? 0 : 255;
    png.data[i * 4] = value;
    png.data[i * 4 + 1] = value;
    png.data[i * 4 + 2] = value;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Names subject colors outside the print palette → HARD enforcement, PLUS
 * an explicit ink restriction so Phase 2C.3A still authorizes the
 * replacement path these durability tests exercise.
 */
function hardWhiteOnBlackBrief(): Partial<DesignBriefSnapshotContent> {
  return {
    productSummary: "T-shirts",
    designDescription:
      "A black motorcycle with a black leather seat and a black helmet",
    exactText: "IRON HORSE",
    shirtColor: "Black",
    preferredColors: ["White"],
    additionalInstructions:
      "ONE COLOR WHITE INK ONLY. DO NOT USE BLACK INK.",
  };
}

/** No preferred colors → no hard palette gate → no replacement path. */
function plainBrief(name: string): Partial<DesignBriefSnapshotContent> {
  return { productSummary: name };
}

// --- Doubles ------------------------------------------------------------

/**
 * A local double shaped like a real paid image adapter: it exposes
 * `generateDirection`, so the worker drives one paid dispatch per catalog
 * direction exactly as it does against OpenAI. It tells an INITIAL dispatch
 * from a REPLACEMENT dispatch the same way a real adapter would — via
 * `prompt.printPaletteCorrection` — so nothing is threaded in out of band.
 *
 * Every draft carries a `providerRequestId`, because the entire point of
 * this phase is what happens to that id when everything AFTER the provider
 * goes wrong.
 */
class ScriptedPaidProvider implements ConceptGenerationProvider {
  readonly providerKey = "fake-paid";
  readonly editsSourceArtwork = true;

  readonly initialDispatches: ConceptDirectionKey[] = [];
  readonly replacementDispatches: ConceptDirectionKey[] = [];

  /** Palette outcome per direction for the INITIAL image. */
  initial = new Map<ConceptDirectionKey, PaletteOutcome>();
  /** Palette outcome per direction for the REPLACEMENT image. */
  replacement = new Map<ConceptDirectionKey, PaletteOutcome>();
  /** Directions whose REPLACEMENT dispatch fails at the provider itself. */
  replacementProviderFailures = new Map<
    ConceptDirectionKey,
    "not_dispatched" | "ambiguous" | "billed_unusable"
  >();
  /** Directions whose INITIAL dispatch fails at the provider itself. */
  initialProviderFailures = new Map<
    ConceptDirectionKey,
    "not_dispatched" | "ambiguous" | "billed_unusable"
  >();

  get totalDispatches(): number {
    return this.initialDispatches.length + this.replacementDispatches.length;
  }

  /** Stable, predictable ids so a test can assert the exact stored value. */
  requestIdFor(kind: "initial" | "replacement", direction: ConceptDirectionKey): string {
    return `req_${kind}_${direction}`;
  }

  private raise(
    outcome: "not_dispatched" | "ambiguous" | "billed_unusable",
  ): never {
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
    outcome: PaletteOutcome,
    kind: "initial" | "replacement",
  ): GeneratedConceptDraft {
    return {
      versionNumber: 1,
      title: `Title ${directionKey}`,
      summary: `Summary ${directionKey}`,
      placeholderLabel: `Label ${directionKey}`,
      accentColor: "#123456",
      kind: "concept",
      directionKey,
      asset: {
        imageBytes: palettePng(outcome),
        contentType: "image/png",
        widthPx: CANVAS,
        heightPx: CANVAS,
        hasTransparency: true,
        providerMetadata: { providerRequestId: this.requestIdFor(kind, directionKey) },
      },
    };
  }

  async generateDirection(
    request: ConceptGenerationRequest,
    directionKey: ConceptDirectionKey,
  ): Promise<ConceptGenerationResult> {
    const isReplacement = request.prompt.printPaletteCorrection === true;

    if (isReplacement) {
      this.replacementDispatches.push(directionKey);
      const failure = this.replacementProviderFailures.get(directionKey);
      if (failure) this.raise(failure);
    } else {
      this.initialDispatches.push(directionKey);
      const failure = this.initialProviderFailures.get(directionKey);
      if (failure) this.raise(failure);
    }

    const outcome =
      (isReplacement ? this.replacement : this.initial).get(directionKey) ?? "pass";
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [
        this.draft(directionKey, outcome, isReplacement ? "replacement" : "initial"),
      ],
    };
  }

  async generate(request: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: DIRECTIONS.slice(0, request.conceptCount).map((direction) =>
        this.draft(direction, this.initial.get(direction) ?? "pass", "initial"),
      ),
    };
  }
}

/** A vision evaluator that always passes — the deterministic gate is the subject. */
class AlwaysPassVisionProvider implements ConceptEvaluationProvider {
  readonly providerKey = "fake-vision-pass";
  async evaluate(): Promise<ConceptEvaluationResult> {
    return {
      overallScore: 95,
      passed: true,
      confidence: 95,
      status: "passed",
      criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
        key,
        score: 95,
        passed: true,
        confidence: 95,
        notes: null,
      })),
      warnings: [],
      recommendations: [],
      missingRequirements: [],
      matchedRequirements: [],
      providerMetadata: { mode: "fake_pass" },
    };
  }
}

/** Fails only the REPLACEMENT concept's upload, identified by its intent stamp. */
function failReplacementUploads(
  assets: AssetCapability,
  message = "storage unavailable",
): AssetCapability {
  return {
    ...assets,
    async uploadConceptImage(designId, input) {
      const intentKey = input.metadata?.logicalPaidIntentKey;
      if (typeof intentKey === "string" && intentKey.includes(":replacement:")) {
        throw new PaidImagePersistenceError("storage_upload_failure", message);
      }
      return assets.uploadConceptImage(designId, input);
    },
  };
}

/** Storage that refuses the bytes — the real `AssetCapability` classifies it. */
function brokenUploadStorage(shouldFail: () => boolean): AssetStorageProvider {
  const real = new DataUriAssetStorageProvider();
  return {
    storageKey: real.storageKey,
    upload: async (input) => {
      if (shouldFail()) throw new Error("object store refused the bytes");
      return real.upload(input);
    },
    getSignedUrl: real.getSignedUrl.bind(real),
    download: real.download.bind(real),
    delete: real.delete.bind(real),
  };
}

/** Captures `console.info` lines emitted while `run` executes. */
async function captureLogs<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: Array<{ label: string; details: Record<string, unknown> }> }> {
  const original = console.info;
  const lines: Array<{ label: string; details: Record<string, unknown> }> = [];
  console.info = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[1] && typeof args[1] === "object") {
      lines.push({ label: args[0], details: args[1] as Record<string, unknown> });
    }
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.info = original;
  }
}

function replacementLine(
  lines: Array<{ label: string; details: Record<string, unknown> }>,
  decision: string,
): Record<string, unknown> | undefined {
  return lines.find(
    (line) =>
      line.label === "[concept-generation] hard-palette-replacement" &&
      line.details.decision === decision,
  )?.details;
}

describe("Phase 2C.2C — failed paid-intent durability and terminal state", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-2c2c-"));
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
    options: {
      wrapAssets?: (assets: AssetCapability) => AssetCapability;
      storage?: AssetStorageProvider;
    } = {},
  ) {
    const assets = (options.wrapAssets ?? ((a: AssetCapability) => a))(
      createAssetCapability(
        repo,
        options.storage ?? new DataUriAssetStorageProvider(),
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
        createConceptEvaluationCapability(new AlwaysPassVisionProvider()),
      ),
    };
  }

  async function approvedProject(
    repo: ProjectRepository,
    brief: Partial<DesignBriefSnapshotContent>,
  ) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, brief);
    const version = await createDesignBriefCapability(repo).approveWorkingBrief(
      created.project.id,
    );
    return { projectId: created.project.id, version };
  }

  /** A worker that died mid-attempt: running, long-stale heartbeat. */
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

  /**
   * The live defect's exact shape: Soft hard-fails, its replacement is
   * dispatched and answered by the provider, and local persistence then
   * fails. Bold (warn) and Minimal (pass) are delivered, so the parent job
   * intentionally COMPLETES with Soft withheld.
   */
  async function runLiveOrdinalFourShape() {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    provider.initial.set("bold_direct", "warn");
    provider.initial.set("soft_illustrated", "fail");
    provider.initial.set("minimal_badge", "pass");
    provider.replacement.set("soft_illustrated", "pass");

    const { capability, worker } = buildPipeline(repo, provider, {
      wrapAssets: (assets) => failReplacementUploads(assets),
    });
    const { projectId, version } = await approvedProject(repo, hardWhiteOnBlackBrief());
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    const { lines } = await captureLogs(() => worker.processNextJob());

    const replacementKey = buildPaidImageIntentKey({
      projectId,
      generationJobId: job.id,
      kind: "replacement",
      scopeKey: "soft_illustrated",
      replacedPaidIntentKey: buildPaidImageIntentKey({
        projectId,
        generationJobId: job.id,
        kind: "initial_concept",
        scopeKey: "soft_illustrated",
      }),
      epoch: REPLACEMENT_PAID_INTENT_EPOCH,
    });

    return { repo, provider, worker, projectId, job, replacementKey, lines };
  }

  // === STEP 9 — the exact live ordinal-4 state contract ==================

  it("LIVE SHAPE: a billed replacement whose persistence fails ends terminally failed, with its request id and error durable", async () => {
    const { repo, provider, projectId, job, replacementKey, lines } =
      await runLiveOrdinalFourShape();

    assert.equal(
      provider.replacementDispatches.length,
      1,
      "exactly one replacement was dispatched — and never a second",
    );

    const intent = await repo.getPaidImageIntentByKey(projectId, replacementKey);
    assert.ok(intent);
    assert.equal(intent.paidIntentOrdinal, 4, "the live ordinal");
    assert.equal(intent.intentKind, "replacement");
    assert.equal(intent.directionKey, "soft_illustrated");
    assert.equal(intent.dispatches, 1);

    // The four fields that were all wrong in the live run.
    assert.equal(
      intent.status,
      "failed",
      "the parent job completed and withheld this direction — the row is terminal, not open",
    );
    assert.equal(
      intent.providerRequestId,
      provider.requestIdFor("replacement", "soft_illustrated"),
      "the paid request id survived a failure that happened AFTER the provider answered",
    );
    assert.ok(intent.lastError, "and so did a description of what went wrong");
    assert.match(
      intent.lastError,
      /^storage_upload_failure: /,
      "classified by WHERE it failed, not collapsed into an opaque local_failure",
    );
    assert.equal(intent.result, null, "no durable artwork is claimed");

    const replacementUnavailable = replacementLine(lines, "replacement_unavailable");
    assert.ok(replacementUnavailable);
    assert.equal(
      replacementUnavailable.paidCallMade,
      true,
      "the log no longer says a billed dispatch was free",
    );
    assert.equal(
      replacementUnavailable.providerRequestId,
      provider.requestIdFor("replacement", "soft_illustrated"),
    );
    assert.equal(replacementUnavailable.skipReason, "replacement_generation_failed");

    // The customer-visible outcome is exactly the live one, unchanged.
    const finalJob = await repo.getGenerationJob(job.id);
    assert.equal(finalJob?.status, "completed");
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.project.status, "concepts_ready");
    assert.equal(snapshot?.artworkVersions.length, 2, "Soft is withheld");
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      ["bold_direct", "minimal_badge"],
    );
  });

  // === STEP 11 — a completed job must not reactivate its child intent ====

  it("G: a terminal failed child of a completed job can never be auto-reclaimed into another paid call", async () => {
    const { repo, provider, worker, projectId, job, replacementKey } =
      await runLiveOrdinalFourShape();
    const dispatchesAfterRun = provider.totalDispatches;

    // Normal abandoned-job recovery, repeatedly. A completed job is not
    // "running", so it is never swept — and even if some future change
    // claimed it, the intent itself is terminally failed.
    for (let i = 0; i < 3; i += 1) {
      await worker.recoverAbandonedJobs(15 * 60 * 1000);
      await worker.processNextJob();
    }

    assert.equal(
      provider.totalDispatches,
      dispatchesAfterRun,
      "no further paid dispatch, ever",
    );
    assert.equal((await repo.getGenerationJob(job.id))?.status, "completed");

    const intent = await repo.getPaidImageIntentByKey(projectId, replacementKey);
    assert.equal(intent?.status, "failed");
    assert.equal(intent?.dispatches, 1, "the durable spend record is unchanged");

    // And the persistence layer refuses a fresh dispatch of that row outright.
    const refused = await repo.beginPaidImageIntentDispatch(
      intent!.id,
      "a-fresh-token",
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
    assert.equal(refused, null);
  });

  it("G: recoverAbandonedJobs still recovers a genuinely stale RUNNING job", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, plainBrief("Stale sweep"));

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await forceReclaimable(repo, job.id);
    const { recoveredCount } = await worker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recoveredCount, 1, "real stale running jobs still recover");
    assert.equal((await repo.getGenerationJob(job.id))?.status, "recoverable");

    await worker.processNextJob();
    assert.equal((await repo.getGenerationJob(job.id))?.status, "completed");
    assert.equal(provider.initialDispatches.length, 3);
  });

  // === STEP 10 — the recoverable-parent case must NOT change ============

  it("E: a storage failure under a still-recoverable parent keeps the SAME intent retry-eligible, with evidence", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    let failUploads = true;
    const { capability, worker } = buildPipeline(repo, provider, {
      storage: brokenUploadStorage(() => failUploads),
    });
    const { projectId, version } = await approvedProject(
      repo,
      plainBrief("Recoverable storage failure"),
    );

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();
    assert.deepEqual(provider.initialDispatches, ["bold_direct"]);

    const boldKey = buildPaidImageIntentKey({
      projectId,
      generationJobId: job.id,
      kind: "initial_concept",
      scopeKey: "bold_direct",
    });
    const afterFailure = await repo.getPaidImageIntentByKey(projectId, boldKey);
    assert.ok(afterFailure);

    // The NEW guarantees: evidence lands on the first failed dispatch...
    assert.match(afterFailure.lastError ?? "", /^storage_upload_failure: /);
    assert.equal(
      afterFailure.providerRequestId,
      provider.requestIdFor("initial", "bold_direct"),
    );
    // ...without costing the intent its remaining retries.
    assert.equal(
      afterFailure.status,
      "reserved",
      "the parent job still intends recovery, so this stays retry-eligible",
    );
    assert.equal(afterFailure.dispatches, 1);
    assert.equal(
      (await repo.listPaidImageIntentsForJob(projectId, job.id)).length,
      1,
      "a failed store consumed no extra logical budget",
    );
    assert.notEqual(
      (await repo.getGenerationJob(job.id))?.status,
      "completed",
      "the parent did NOT complete, so nothing was terminalized",
    );

    // The reclaim reuses the same logical intent — same row, same ordinal.
    failUploads = false;
    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    const recovered = await repo.getPaidImageIntentByKey(projectId, boldKey);
    assert.equal(recovered?.id, afterFailure.id, "the SAME logical intent");
    assert.equal(recovered?.paidIntentOrdinal, 1, "no new logical paid ordinal");
    assert.equal(
      recovered?.dispatches,
      2,
      "dispatches incremented only because the provider was genuinely called again",
    );
    assert.equal(recovered?.status, "succeeded");
    assert.deepEqual(provider.initialDispatches, ["bold_direct", ...DIRECTIONS]);
    assert.equal(
      (await repo.listPaidImageIntentsForJob(projectId, job.id)).length,
      3,
      "budget unchanged: three logical intents for a three-direction job",
    );
  });

  // === STEP 14 A/B — paidCallMade semantics =============================

  it("A: a replacement refused BEFORE the provider is contacted reports paidCallMade false", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    provider.initial.set("bold_direct", "warn");
    provider.initial.set("soft_illustrated", "fail");
    provider.initial.set("minimal_badge", "pass");
    // The dispatch never leaves the process.
    provider.replacementProviderFailures.set("soft_illustrated", "not_dispatched");

    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, hardWhiteOnBlackBrief());
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    const { lines } = await captureLogs(() => worker.processNextJob());

    const unavailable = replacementLine(lines, "replacement_unavailable");
    assert.ok(unavailable);
    assert.equal(
      unavailable.paidCallMade,
      false,
      "the dispatch counter moved, but the failure PROVES nothing was billed",
    );

    const replacementKey = buildPaidImageIntentKey({
      projectId,
      generationJobId: job.id,
      kind: "replacement",
      scopeKey: "soft_illustrated",
      replacedPaidIntentKey: buildPaidImageIntentKey({
        projectId,
        generationJobId: job.id,
        kind: "initial_concept",
        scopeKey: "soft_illustrated",
      }),
      epoch: REPLACEMENT_PAID_INTENT_EPOCH,
    });
    const intent = await repo.getPaidImageIntentByKey(projectId, replacementKey);
    assert.match(intent?.lastError ?? "", /^provider_not_dispatched: /);
    assert.equal(
      intent?.dispatches,
      1,
      "the durable dispatch ledger still records the ATTEMPT honestly",
    );
    assert.equal(
      intent?.providerRequestId,
      null,
      "no request id exists to record, and none is invented",
    );
    assert.equal(
      isPossiblyBilledFailureClass("provider_not_dispatched"),
      false,
      "the class itself says no money moved",
    );
    assert.equal(
      readPaidImageFailureClass(intent?.lastError),
      "provider_not_dispatched",
      "and the durable row is what `paidCallMade` was read from",
    );
  });

  it("A: a replacement blocked by an exhausted BUDGET reports paidCallMade false", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    // All three hard-fail, which is exactly how the budget genuinely runs
    // out: the first two directions consume the job's two replacement slots
    // (ordinals 4 and 5), and the third is refused at reservation — the
    // provider is never contacted for it at all.
    for (const direction of DIRECTIONS) {
      provider.initial.set(direction, "fail");
      provider.replacement.set(direction, "pass");
    }

    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, hardWhiteOnBlackBrief());
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    const { lines } = await captureLogs(() => worker.processNextJob());

    const unavailable = replacementLine(lines, "replacement_unavailable");
    assert.ok(unavailable, "the third direction could not be replaced");
    assert.equal(unavailable.paidCallMade, false, "a refusal to spend is not a spend");
    assert.equal(unavailable.skipReason, "paid_budget_exhausted");
    assert.equal(
      provider.replacementDispatches.length,
      MAX_REPLACEMENT_PAID_INTENTS_PER_JOB,
      "exactly two replacements were bought, and the third was never dispatched",
    );

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(
      intents.length,
      ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
      "the ceiling is what refused the third replacement",
    );
  });

  it("B: a replacement the provider answered and local storage then dropped reports paidCallMade TRUE", async () => {
    const { lines } = await runLiveOrdinalFourShape();
    const unavailable = replacementLine(lines, "replacement_unavailable");
    assert.ok(unavailable);
    assert.equal(unavailable.paidCallMade, true);
    // The regression in one line: this is a FAILED replacement whose asset
    // never completed, and it must still be reported as paid for.
    assert.equal(unavailable.decision, "replacement_unavailable");
  });

  // === STEP 14 C/D — request id and last_error on a NON-terminal failure ==

  it("C/D: the first failed dispatch persists both the request id and the error, long before the ceiling", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    // A billed-but-unusable response: dispatch 1 of 3, nowhere near the
    // ceiling, so the pre-2C.2C code wrote nothing at all.
    provider.initialProviderFailures.set("bold_direct", "billed_unusable");

    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(
      repo,
      plainBrief("Nonterminal evidence"),
    );
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();

    const boldKey = buildPaidImageIntentKey({
      projectId,
      generationJobId: job.id,
      kind: "initial_concept",
      scopeKey: "bold_direct",
    });
    const intent = await repo.getPaidImageIntentByKey(projectId, boldKey);
    assert.ok(intent);
    assert.equal(intent.dispatches, 1);
    assert.ok(
      intent.dispatches < MAX_PAID_DISPATCHES_PER_INTENT,
      "evidence is not withheld until the dispatch budget is spent",
    );
    assert.equal(intent.status, "reserved", "and recording it did not end the intent");
    assert.match(intent.lastError ?? "", /^provider_billed_unusable: /);
  });

  it("C: a provider request id is written even when the intent never succeeds", async () => {
    const { repo, projectId, replacementKey, provider } =
      await runLiveOrdinalFourShape();
    const intent = await repo.getPaidImageIntentByKey(projectId, replacementKey);
    assert.equal(
      intent?.providerRequestId,
      provider.requestIdFor("replacement", "soft_illustrated"),
    );
    assert.equal(
      intent?.result,
      null,
      "a stored request id never implies a recoverable image",
    );
  });

  // === STEP 14 H/I/J/K — failure classification ==========================

  it("H: a storage upload failure is classified storage_upload_failure", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    const { capability, worker } = buildPipeline(repo, provider, {
      storage: brokenUploadStorage(() => true),
    });
    const { projectId, version } = await approvedProject(repo, plainBrief("Upload class"));
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();

    const [intent] = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.match(intent?.lastError ?? "", /^storage_upload_failure: /);
    assert.match(
      intent?.lastError ?? "",
      /object store refused the bytes/,
      "the underlying diagnostic is preserved, not replaced by the label",
    );
    assert.equal(
      intent?.providerRequestId,
      provider.requestIdFor("initial", "bold_direct"),
    );
  });

  it("I: an asset DB write failure is classified asset_persistence_failure, and orphan cleanup still runs", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    const deleted: string[] = [];
    const real = new DataUriAssetStorageProvider();
    const spyingStorage: AssetStorageProvider = {
      storageKey: real.storageKey,
      upload: real.upload.bind(real),
      getSignedUrl: real.getSignedUrl.bind(real),
      download: real.download.bind(real),
      delete: async (objectKey: string) => {
        deleted.push(objectKey);
        // The data-URI provider stores nothing out of process, so its
        // `delete` takes no key — the spy above is what this test observes.
        return real.delete();
      },
    };
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            throw new Error("simulated asset row failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;

    const { capability, worker } = buildPipeline(failingRepo, provider, {
      storage: spyingStorage,
    });
    const { projectId, version } = await approvedProject(
      failingRepo,
      plainBrief("Asset row class"),
    );
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await failingRepo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();

    const [intent] = await failingRepo.listPaidImageIntentsForJob(projectId, job.id);
    assert.match(intent?.lastError ?? "", /^asset_persistence_failure: /);
    assert.match(intent?.lastError ?? "", /simulated asset row failure/);
    assert.equal(
      intent?.providerRequestId,
      provider.requestIdFor("initial", "bold_direct"),
      "the paid request id is recorded even though nothing durable survives",
    );
    assert.ok(
      deleted.length >= 1,
      "the immutable-asset orphan cleanup path is unchanged",
    );
    assert.equal(
      (await failingRepo.listAssets(projectId)).length,
      0,
      "and no orphaned asset row exists",
    );
  });

  it("J: an intent-completion failure is classified intent_completion_failure and the bytes stay adoptable", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    let failNextCompletion = true;
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "completePaidImageIntent") {
          return async (...args: Parameters<ProjectRepository["completePaidImageIntent"]>) => {
            if (failNextCompletion) {
              failNextCompletion = false;
              throw new Error("intent row write failed");
            }
            return repo.completePaidImageIntent(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;

    const { capability, worker } = buildPipeline(failingRepo, provider);
    const { projectId, version } = await approvedProject(
      failingRepo,
      plainBrief("Completion class"),
    );
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await failingRepo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();

    const boldKey = buildPaidImageIntentKey({
      projectId,
      generationJobId: job.id,
      kind: "initial_concept",
      scopeKey: "bold_direct",
    });
    const intent = await failingRepo.getPaidImageIntentByKey(projectId, boldKey);
    assert.match(intent?.lastError ?? "", /^intent_completion_failure: /);
    assert.equal(intent?.status, "reserved", "the parent job can still recover this");
    assert.equal(
      intent?.providerRequestId,
      provider.requestIdFor("initial", "bold_direct"),
    );

    // N (orphan adoption unchanged): the bytes are durable and stamped, so
    // the reclaim adopts them and buys nothing.
    const dispatchesBefore = provider.initialDispatches.length;
    await forceReclaimable(failingRepo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(
      provider.initialDispatches.filter((d) => d === "bold_direct").length,
      provider.initialDispatches
        .slice(0, dispatchesBefore)
        .filter((d) => d === "bold_direct").length,
      "Bold was adopted from its orphaned asset, not re-bought",
    );
    assert.equal(
      (await failingRepo.getPaidImageIntentByKey(projectId, boldKey))?.status,
      "succeeded",
    );
    assert.equal((await failingRepo.getProject(projectId))?.artworkVersions.length, 3);
  });

  it("K: the billed-unusable provider classification is preserved end to end", () => {
    const billed = new ProviderError(
      "malformed_response",
      "The artwork provider response did not include image data.",
      "dispatched_billed",
    );
    assert.equal(classifyProviderDispatchFailure(billed), "provider_billed_unusable");
    assert.equal(isPossiblyBilledFailureClass("provider_billed_unusable"), true);

    const ambiguous = new ProviderError("unavailable", "down", "dispatched_ambiguous");
    assert.equal(classifyProviderDispatchFailure(ambiguous), "provider_ambiguous");

    const clean = new ProviderError("network", "unreachable", "not_dispatched");
    assert.equal(classifyProviderDispatchFailure(clean), "provider_not_dispatched");

    // An adapter that throws something unexpected can never prove the
    // request stayed home, so it is classified in the expensive direction.
    assert.equal(
      classifyProviderDispatchFailure(new Error("boom")),
      "provider_ambiguous",
    );
    assert.equal(
      classifyPaidImagePersistenceFailure(new Error("boom")),
      "unknown_local_failure",
    );
  });

  it("the persisted failure description never carries bytes, keys, or payloads", () => {
    const secretish = "sk-" + "A".repeat(80);
    const described = describePaidImageFailure(
      "storage_upload_failure",
      new Error(`upload rejected token=${secretish} body=data:image/png;base64,${"Q".repeat(200)}`),
    );
    assert.doesNotMatch(described, new RegExp("A".repeat(64)));
    assert.doesNotMatch(described, new RegExp("Q".repeat(64)));
    assert.doesNotMatch(described, /base64/);
    assert.ok(described.length <= 320, "and it is bounded in length");
    assert.match(described, /^storage_upload_failure: /);
  });

  // === STEP 14 L — claim fencing =========================================

  it("L: a stale worker cannot write failure evidence over newer intent state", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, plainBrief("Fencing"));
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();

    const [bold] = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.ok(bold);
    assert.equal(bold.status, "succeeded");

    // A zombie worker holding a stale token is refused.
    const fenced = await repo.recordPaidImageIntentFailure(bold.id, "a-stale-token", {
      lastError: "zombie says this failed",
      providerRequestId: "req_zombie",
      terminal: true,
    });
    assert.equal(fenced, null, "a stale token can never write");

    // And even the CURRENT token cannot downgrade a durable success — the
    // bytes exist and are reusable, whatever a late writer believes.
    const downgraded = await repo.recordPaidImageIntentFailure(
      bold.id,
      bold.claimToken ?? "",
      { lastError: "late failure", terminal: true },
    );
    assert.equal(downgraded, null);

    const unchanged = await repo.getPaidImageIntentByKey(projectId, bold.intentKey);
    assert.equal(unchanged?.status, "succeeded");
    assert.equal(unchanged?.lastError, null);
    assert.notEqual(unchanged?.providerRequestId, "req_zombie");
  });

  it("L: a recorded provider request id is never cleared by a later, less-informed failure", async () => {
    const repo = await freshRepo();
    // Exercises the repository method directly, so this test deliberately
    // enqueues no GenerationJob at all — the local store is shared across
    // this suite, and a queued job left behind would be claimed by whichever
    // test ran next.
    const { projectId } = await approvedProject(repo, plainBrief("Id retention"));

    const reservation = await repo.reservePaidImageIntent(projectId, {
      generationJobId: "job-id-retention",
      intentKey: "retention-intent",
      intentKind: "initial_concept",
      directionKey: "bold_direct",
      paidIntentOrdinal: 1,
      providerKey: "fake-paid",
    });
    assert.equal(reservation.outcome, "created");
    const claimed = await repo.beginPaidImageIntentDispatch(
      reservation.outcome === "created" ? reservation.intent.id : "",
      "token-1",
      MAX_PAID_DISPATCHES_PER_INTENT,
    );
    assert.ok(claimed);

    await repo.recordPaidImageIntentFailure(claimed.id, "token-1", {
      lastError: "storage_upload_failure: first",
      providerRequestId: "req_known",
    });
    await repo.recordPaidImageIntentFailure(claimed.id, "token-1", {
      lastError: "provider_ambiguous: second, knows nothing",
      providerRequestId: null,
    });

    const intent = await repo.getPaidImageIntentByKey(projectId, "retention-intent");
    assert.equal(intent?.providerRequestId, "req_known");
    assert.match(intent?.lastError ?? "", /second, knows nothing/);
    assert.equal(intent?.status, "reserved", "non-terminal writes leave status alone");
  });

  // === STEP 14 M/N/O — unchanged behavior ================================

  it("M: the successful path is unchanged — 3 dispatches, 3 concepts, 3 succeeded intents", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, plainBrief("Happy path"));
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();

    assert.deepEqual(provider.initialDispatches, [...DIRECTIONS]);
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 3);
    assert.deepEqual(
      intents.map((intent) => intent.status),
      ["succeeded", "succeeded", "succeeded"],
    );
    assert.ok(
      intents.every((intent) => intent.lastError === null),
      "a clean run records no failure evidence at all",
    );
    assert.ok(intents.every((intent) => intent.providerRequestId));
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
    assert.equal((await repo.getGenerationJob(job.id))?.status, "completed");
  });

  it("M: completing a job never terminalizes an intent that was reserved but never dispatched", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, plainBrief("Undispatched"));
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    // A reserved-but-never-dispatched slot, taking the FIRST budget slot so
    // the three initial directions still fit inside the unchanged budget
    // (they take 2, 3 and 4). Nothing was paid for on this row, so failing
    // it would invent a spend record that never happened.
    await repo.reservePaidImageIntent(projectId, {
      generationJobId: job.id,
      intentKey: "never-dispatched",
      intentKind: "replacement",
      directionKey: "minimal_badge",
      paidIntentOrdinal: 1,
      providerKey: provider.providerKey,
    });

    await worker.processNextJob();

    const untouched = await repo.getPaidImageIntentByKey(projectId, "never-dispatched");
    assert.equal(untouched?.status, "reserved");
    assert.equal(untouched?.dispatches, 0);
    assert.equal(untouched?.lastError, null);
    assert.equal((await repo.getGenerationJob(job.id))?.status, "completed");
  });

  it("O: the late-third failure / reclaim idempotency contract is unchanged", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedPaidProvider();
    provider.initialProviderFailures.set("minimal_badge", "ambiguous");

    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo, plainBrief("Late third"));
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();
    assert.deepEqual(provider.initialDispatches, [...DIRECTIONS]);

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.deepEqual(
      intents.map((intent) => intent.status),
      ["succeeded", "succeeded", "reserved"],
      "the two completed directions are checkpointed; only the third is outstanding",
    );
    // NEW: the outstanding one now says why.
    assert.match(intents[2]?.lastError ?? "", /^provider_ambiguous: /);

    provider.initialProviderFailures.clear();
    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.deepEqual(
      provider.initialDispatches,
      [...DIRECTIONS, "minimal_badge"],
      "the reclaim dispatched ONLY Minimal — 4 paid calls total, not 6",
    );
    assert.equal((await repo.getProject(projectId))?.artworkVersions.length, 3);
  });

  // === STEP 14 P/Q/R — budgets and epoch unchanged =======================

  it("P/Q/R: replacement budget, intent ceiling, and replacement epoch are unchanged", () => {
    assert.equal(MAX_REPLACEMENT_PAID_INTENTS_PER_JOB, 2);
    assert.equal(ABSOLUTE_MAX_PAID_INTENTS_PER_JOB, 5);
    assert.equal(MAX_PAID_DISPATCHES_PER_INTENT, 3);
    assert.equal(paidIntentBudgetForJob(3), 5);
    assert.equal(paidIntentBudgetForJob(1), 3);
    assert.equal(REPLACEMENT_PAID_INTENT_EPOCH, 1);
  });

  it("P: a failed replacement still consumes exactly one budget slot, and never a second", async () => {
    const { repo, provider, projectId, job } = await runLiveOrdinalFourShape();
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 4, "3 initial + 1 replacement — never a retry slot");
    assert.deepEqual(
      intents.map((intent) => intent.paidIntentOrdinal),
      [1, 2, 3, 4],
    );
    assert.ok(
      intents.length <= paidIntentBudgetForJob(3),
      "within the unchanged budget",
    );
    assert.equal(provider.replacementDispatches.length, 1);
  });

  // === STEP 14 V — no paid provider is reachable =========================

  it("V: the automated-test environment can never resolve a paid provider", () => {
    const resolved = resolveConceptGenerationProvider();
    assert.equal(resolved.providerKey, "placeholder");
    assert.equal(
      typeof (resolved as { generateDirection?: unknown }).generateDirection,
      "undefined",
      "and it exposes no paid per-direction path at all",
    );
  });
});
