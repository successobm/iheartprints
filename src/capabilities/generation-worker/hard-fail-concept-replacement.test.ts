import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import {
  CONCEPT_EVALUATION_CRITERION_KEYS,
  createConceptEvaluationCapability,
  evaluatePrintPaletteCompliance,
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
  MAX_REPLACEMENT_PAID_INTENTS_PER_JOB,
  REPLACEMENT_PAID_INTENT_EPOCH,
} from "@/capabilities/shared/paid-image-intent";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConceptDirectionKey,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  CONCEPT_SET_UNRESOLVABLE_ERROR_PREFIX,
  createGenerationWorkerCapability,
} from "./generation-worker-capability";
import {
  classifyReplacementAcceptance,
  isAutomaticInkRestrictionReplacementEligible,
  isHardPrintPaletteFailure,
} from "./hard-palette-replacement-policy";

/**
 * PHASE 2C — AUTOMATIC HARD-FAIL CONCEPT REPLACEMENT.
 *
 * Every test here counts PAID PROVIDER DISPATCHES, because the guarantee
 * this phase adds is bounded: a customer never sees a concept that violates
 * a hard production constraint when it can be replaced, and the platform
 * never spends more than five logical paid images to achieve that.
 *
 * NO REAL OPENAI CALLS ARE POSSIBLE HERE. The provider is a local double
 * with no network access, and the process-wide automated-test guard
 * (`test-safety-bootstrap`) independently forces every live resolver to a
 * placeholder — proven by test AC at the bottom of this file.
 *
 * Palette verdicts are produced by REAL PIXELS through the REAL Phase 2B
 * validator, never by stubbing the verdict. A test that faked the verdict
 * would prove the replacement plumbing and nothing about the trigger.
 */

const DIRECTIONS: readonly ConceptDirectionKey[] = [
  "bold_direct",
  "soft_illustrated",
  "minimal_badge",
];

/** Resolved BEFORE the suite chdirs into its temp workspace. */
const REPO_ROOT = process.cwd();
const HARLEY_DIR = path.join(REPO_ROOT, ".tmp-phase2b-harley");

// --- Pixel fixtures -----------------------------------------------------
//
// White print palette on a black garment (the live calibration case). The
// validator classifies dark ink as garment-matching, so the verdict is a
// direct function of how much black ink the artwork uses.

type PaletteOutcome = "pass" | "warn" | "fail";

const CANVAS = 20;
const CANVAS_PIXELS = CANVAS * CANVAS;

/**
 * `fail` — fully black ink: garment-matching fraction 1.0, far past the
 *          hard-fail threshold. This is the Soft & Illustrated shape.
 * `warn`  — 15% black ink: past the WARN threshold, nowhere near FAIL.
 *          This is the Bold & Direct shape.
 * `pass`  — fully white ink: full palette coverage, no garment matching.
 *          This is the Minimal Badge shape.
 */
function palettePng(outcome: PaletteOutcome): Buffer {
  const png = new PNG({ width: CANVAS, height: CANVAS });
  const darkPixels =
    outcome === "fail"
      ? CANVAS_PIXELS
      : outcome === "warn"
        ? Math.round(CANVAS_PIXELS * 0.15)
        : 0;
  for (let i = 0; i < CANVAS_PIXELS; i += 1) {
    const dark = i < darkPixels;
    const value = dark ? 0 : 255;
    png.data[i * 4] = value;
    png.data[i * 4 + 1] = value;
    png.data[i * 4 + 2] = value;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function hardWhiteOnBlackBrief(): Partial<DesignBriefSnapshotContent> {
  return {
    productSummary: "T-shirts",
    // Names subject-object colors outside the print palette, which is what
    // makes Phase 2A derive HARD enforcement (see `derivePrintPalette`).
    // Phase 2C.3A: this is inferred contrast guidance ONLY — not an explicit
    // ink restriction, and must not alone purchase a replacement.
    designDescription:
      "A black motorcycle with a black leather seat and a black helmet",
    exactText: "IRON HORSE",
    shirtColor: "Black",
    preferredColors: ["White"],
  };
}

/** Same design, plus explicit customer production ink restriction. */
function explicitWhiteInkOnlyBrief(): Partial<DesignBriefSnapshotContent> {
  return {
    ...hardWhiteOnBlackBrief(),
    additionalInstructions:
      "ONE COLOR WHITE INK ONLY. DO NOT USE BLACK INK.",
  };
}

function decodeRgba(bytes: Buffer): RgbaImage {
  const decoded = PNG.sync.read(bytes);
  return {
    width: decoded.width,
    height: decoded.height,
    data: Buffer.from(decoded.data),
  };
}

// --- Doubles ------------------------------------------------------------

/**
 * A local double shaped like a real paid image adapter. It exposes
 * `generateDirection`, so the worker drives one paid dispatch per direction
 * exactly as it does against OpenAI.
 *
 * Crucially, it tells an INITIAL dispatch from a REPLACEMENT dispatch the
 * same way a real adapter would: `prompt.printPaletteCorrection`. Nothing
 * out-of-band is threaded in, so these tests also prove the correction
 * directive genuinely reaches the provider boundary.
 */
class PaletteScriptedProvider implements ConceptGenerationProvider {
  readonly providerKey = "fake-paid";
  readonly editsSourceArtwork = true;

  readonly initialDispatches: ConceptDirectionKey[] = [];
  readonly replacementDispatches: ConceptDirectionKey[] = [];
  readonly replacementRequests: ConceptGenerationRequest[] = [];
  readonly batchDispatches: ConceptGenerationRequest[] = [];

  /** Palette outcome per direction for the INITIAL image. */
  initial = new Map<ConceptDirectionKey, PaletteOutcome>();
  /** Palette outcome per direction for the REPLACEMENT image. */
  replacement = new Map<ConceptDirectionKey, PaletteOutcome>();
  /** Directions whose replacement dispatch fails at the provider. */
  replacementProviderErrors = new Set<ConceptDirectionKey>();

  /** Every paid dispatch this double ever made, initial and replacement. */
  get totalDispatches(): number {
    return (
      this.initialDispatches.length +
      this.replacementDispatches.length +
      this.batchDispatches.length
    );
  }

  private draft(
    directionKey: ConceptDirectionKey,
    outcome: PaletteOutcome,
    kind: "concept" | "revision" = "concept",
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
        imageBytes: palettePng(outcome),
        contentType: "image/png",
        widthPx: CANVAS,
        heightPx: CANVAS,
        hasTransparency: true,
        providerMetadata: {
          providerRequestId: `req-${this.totalDispatches}`,
        },
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
      this.replacementRequests.push(request);
      if (this.replacementProviderErrors.has(directionKey)) {
        throw new ProviderError(
          "unavailable",
          "The artwork provider is temporarily unavailable.",
          "dispatched_ambiguous",
        );
      }
    } else {
      this.initialDispatches.push(directionKey);
    }

    const outcome =
      (isReplacement ? this.replacement : this.initial).get(directionKey) ??
      "pass";
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: [this.draft(directionKey, outcome)],
    };
  }

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.batchDispatches.push(request);
    const target = request.prompt.targetConceptDirectionKey;
    if (target) {
      return {
        jobId: request.idempotencyKey,
        providerKey: this.providerKey,
        concepts: [this.draft(target, this.initial.get(target) ?? "pass", "revision")],
      };
    }
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: DIRECTIONS.slice(0, request.conceptCount).map((direction) =>
        this.draft(direction, this.initial.get(direction) ?? "pass"),
      ),
    };
  }
}

/** A batch-only adapter: no `generateDirection`, so no per-direction unit. */
class BatchOnlyProvider implements ConceptGenerationProvider {
  readonly providerKey = "fake-batch";
  readonly editsSourceArtwork = true;
  readonly batchDispatches: ConceptGenerationRequest[] = [];

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.batchDispatches.push(request);
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: DIRECTIONS.slice(0, request.conceptCount).map((direction) => ({
        versionNumber: 1,
        title: `Title ${direction}`,
        summary: `Summary ${direction}`,
        placeholderLabel: `Label ${direction}`,
        accentColor: "#123456",
        kind: "concept" as const,
        directionKey: direction,
        asset: {
          imageBytes: palettePng("fail"),
          contentType: "image/png",
          widthPx: CANVAS,
          heightPx: CANVAS,
          hasTransparency: true,
          providerMetadata: {},
        },
      })),
    };
  }
}

/**
 * A vision evaluator that ALWAYS passes. Deliberately the default posture
 * for this whole suite: every replacement it triggers is one a subjective
 * evaluator said was fine, so Phase 2B precedence (deterministic hard FAIL
 * cannot be overridden by Vision PASS) is proven continuously rather than in
 * a single test.
 */
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

/**
 * Makes a REPLACEMENT concept's pixels unreadable, and only a replacement's:
 * the asset is identified by the intent stamp its metadata already carries,
 * so nothing about the initial candidates changes. This is how the
 * NOT_APPLICABLE branch is reached honestly (a decode failure) rather than
 * by stubbing a verdict.
 */
function withUnreadableReplacementPixels(
  assets: AssetCapability,
  repo: ProjectRepository,
): AssetCapability {
  return {
    ...assets,
    async downloadAssetBytes(assetId: string) {
      const asset = await repo.getAssetById(assetId);
      const intentKey = asset?.metadata?.logicalPaidIntentKey;
      if (typeof intentKey === "string" && intentKey.includes(":replacement:")) {
        return { bytes: Buffer.from("not a png"), contentType: "image/png" };
      }
      return assets.downloadAssetBytes(assetId);
    },
  };
}

describe("Phase 2C — automatic hard-fail concept replacement", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-2c-replacement-"));
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
    wrapAssets: (
      assets: AssetCapability,
      repo: ProjectRepository,
    ) => AssetCapability = (a) => a,
  ) {
    const assets = wrapAssets(
      createAssetCapability(
        repo,
        new DataUriAssetStorageProvider(),
        new PngThumbnailGenerator(),
      ),
      repo,
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

  async function approvedHardPaletteProject(
    repo: ProjectRepository,
    brief: Partial<DesignBriefSnapshotContent> = explicitWhiteInkOnlyBrief(),
  ) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, brief);
    const version = await createDesignBriefCapability(repo).approveWorkingBrief(
      created.project.id,
    );
    return { projectId: created.project.id, version };
  }

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

  async function runInitialJob(
    repo: ProjectRepository,
    provider: ConceptGenerationProvider,
    wrapAssets?: (
      assets: AssetCapability,
      repo: ProjectRepository,
    ) => AssetCapability,
    brief: Partial<DesignBriefSnapshotContent> = explicitWhiteInkOnlyBrief(),
  ) {
    const { capability, worker } = buildPipeline(repo, provider, wrapAssets);
    const { projectId, version } = await approvedHardPaletteProject(repo, brief);
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await worker.processNextJob();
    return { projectId, job, worker, capability };
  }

  // --- Pixel fixture sanity ---------------------------------------------
  //
  // Everything below depends on these three rasters producing exactly the
  // live Harley verdicts through the REAL validator. If that ever stops
  // being true, every downstream assertion becomes meaningless, so it is
  // asserted first and directly.

  it("fixture: the synthetic rasters reproduce the live PASS / WARN / FAIL verdicts", () => {
    const brief = {
      ...hardWhiteOnBlackBrief(),
      deferredSections: [],
    } as DesignBriefSnapshotContent;

    const fail = evaluatePrintPaletteCompliance({
      image: decodeRgba(palettePng("fail")),
      brief,
    });
    assert.equal(fail.status, "fail");
    assert.equal(fail.metrics.enforcement, "hard");

    const warn = evaluatePrintPaletteCompliance({
      image: decodeRgba(palettePng("warn")),
      brief,
    });
    assert.equal(warn.status, "warn");
    assert.equal(warn.metrics.enforcement, "hard");

    const pass = evaluatePrintPaletteCompliance({
      image: decodeRgba(palettePng("pass")),
      brief,
    });
    assert.equal(pass.status, "pass");
    assert.equal(pass.metrics.enforcement, "hard");
  });

  // --- A / B. No replacement when nothing hard-failed --------------------

  it("A: all three PASS — 3 paid calls, 0 replacements", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.deepEqual(provider.initialDispatches, [...DIRECTIONS]);
    assert.equal(provider.replacementDispatches.length, 0);
    assert.equal(provider.totalDispatches, 3);

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 3);
    assert.ok(intents.every((intent) => intent.intentKind === "initial_concept"));

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
  });

  it("B: a WARN is customer-visible and never triggers a replacement", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("bold_direct", "warn");
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.equal(provider.totalDispatches, 3, "3 paid calls, no replacement");
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 3);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3, "the WARN concept is shown");
    const bold = snapshot?.artworkVersions.find(
      (artwork) => artwork.conceptDirectionKey === "bold_direct",
    );
    assert.equal(
      bold?.evaluation?.printPaletteCompliance?.status,
      "warn",
      "and its WARN verdict is recorded, unchanged",
    );
  });

  // --- Phase 2C.3A: advisory inferred-hard FAIL must not spend ------------

  it("2C.3A: Soft FAIL without explicit ink restriction — KEEP, 3 paid, ~$0.126", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("bold_direct", "warn");
    provider.initial.set("soft_illustrated", "fail");
    provider.initial.set("minimal_badge", "pass");
    const { projectId, job } = await runInitialJob(
      repo,
      provider,
      undefined,
      hardWhiteOnBlackBrief(),
    );

    assert.equal(provider.replacementDispatches.length, 0);
    assert.equal(provider.totalDispatches, 3, "advisory MUST NOT buy a 4th image");

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 3);
    assert.ok(intents.every((intent) => intent.intentKind === "initial_concept"));

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3, "customer receives all 3 concepts");
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      [...DIRECTIONS],
    );
    assert.equal(
      snapshot?.artworkVersions.find(
        (artwork) => artwork.conceptDirectionKey === "soft_illustrated",
      )?.evaluation?.printPaletteCompliance?.status,
      "fail",
      "Soft FAIL is retained as advisory evaluation, not withheld",
    );
  });

  it("2C.3A: imperfect preferred-palette dominance without explicit restriction — 3 paid", async () => {
    // Synthetic FAIL encodes both garment-matching and low coverage shapes.
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    const { projectId, job } = await runInitialJob(
      repo,
      provider,
      undefined,
      hardWhiteOnBlackBrief(),
    );

    assert.equal(provider.totalDispatches, 3);
    assert.equal(
      (await repo.listPaidImageIntentsForJob(projectId, job.id)).length,
      3,
    );
    assert.equal(
      (await repo.getProject(projectId))?.artworkVersions.length,
      3,
    );
  });

  // --- C / F / X. One EXPLICIT restriction FAIL, replacement passes ------

  it("C/F/X: one explicit ink-restriction FAIL is replaced once — 4 paid calls, and the customer sees the REPLACEMENT", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.deepEqual(provider.initialDispatches, [...DIRECTIONS]);
    assert.deepEqual(provider.replacementDispatches, ["soft_illustrated"]);
    assert.equal(provider.totalDispatches, 4, "3 initial + 1 replacement");

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 4);
    const replacement = intents.find(
      (intent) => intent.intentKind === "replacement",
    );
    assert.ok(replacement);
    assert.equal(replacement.directionKey, "soft_illustrated");
    assert.equal(replacement.paidIntentOrdinal, 4);
    assert.equal(replacement.status, "succeeded");

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3, "still three concepts");
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      [...DIRECTIONS],
      "in unchanged catalog direction order",
    );

    const soft = snapshot?.artworkVersions.find(
      (artwork) => artwork.conceptDirectionKey === "soft_illustrated",
    );
    assert.equal(
      soft?.evaluation?.printPaletteCompliance?.status,
      "pass",
      "the customer-visible Soft concept is the compliant REPLACEMENT",
    );

    // Y: no customer-visible concept is a known hard failure.
    assert.ok(
      snapshot?.artworkVersions.every(
        (artwork) =>
          artwork.evaluation?.printPaletteCompliance?.status !== "fail",
      ),
      "no delivered concept carries a hard FAIL verdict",
    );
  });

  it("X: the rejected initial image survives internally for lineage, and is never an ArtworkVersion", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");
    const { projectId, job } = await runInitialJob(repo, provider);

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    const initialSoft = intents.find(
      (intent) =>
        intent.intentKind === "initial_concept" &&
        intent.directionKey === "soft_illustrated",
    );
    assert.equal(
      initialSoft?.status,
      "succeeded",
      "the rejected original is still a durably-recorded paid image — history is not deleted",
    );

    const assets = await repo.listAssets(projectId);
    assert.ok(
      assets.some(
        (asset) => asset.metadata?.logicalPaidIntentKey === initialSoft?.intentKey,
      ),
      "and its stored bytes are untouched",
    );

    const snapshot = await repo.getProject(projectId);
    assert.equal(
      snapshot?.artworkVersions.filter(
        (artwork) => artwork.conceptDirectionKey === "soft_illustrated",
      ).length,
      1,
      "but exactly one Soft concept is customer-visible — the replacement",
    );
  });

  // --- D. Two hard FAILs -------------------------------------------------

  it("D: two hard FAILs are both replaced — exactly 5 paid calls", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("bold_direct", "fail");
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("bold_direct", "pass");
    provider.replacement.set("soft_illustrated", "warn");
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.deepEqual(provider.replacementDispatches, [
      "bold_direct",
      "soft_illustrated",
    ]);
    assert.equal(provider.totalDispatches, 5);

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, ABSOLUTE_MAX_PAID_INTENTS_PER_JOB);
    assert.deepEqual(
      intents.map((intent) => intent.paidIntentOrdinal),
      [1, 2, 3, 4, 5],
    );

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    // G: a WARN replacement is accepted, exactly as a WARN original is.
    assert.equal(
      snapshot?.artworkVersions.find(
        (artwork) => artwork.conceptDirectionKey === "soft_illustrated",
      )?.evaluation?.printPaletteCompliance?.status,
      "warn",
    );
  });

  // --- E / T. Three hard FAILs: the budget is the limit ------------------

  it("E/T: all three hard-FAIL — exactly 2 replacements, exactly 5 paid calls, no sixth", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    for (const direction of DIRECTIONS) {
      provider.initial.set(direction, "fail");
      provider.replacement.set(direction, "pass");
    }
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.deepEqual(
      provider.replacementDispatches,
      ["bold_direct", "soft_illustrated"],
      "the first two eligible failures in catalog direction order — deterministic, not timing-dependent",
    );
    assert.equal(
      provider.totalDispatches,
      ABSOLUTE_MAX_PAID_INTENTS_PER_JOB,
      "exactly five paid images; the third failure was never dispatched",
    );

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 5);
    assert.equal(
      intents.filter((intent) => intent.intentKind === "replacement").length,
      MAX_REPLACEMENT_PAID_INTENTS_PER_JOB,
    );
    assert.ok(
      !intents.some((intent) => intent.directionKey === "minimal_badge" && intent.intentKind === "replacement"),
      "no replacement intent was ever reserved for the third failure",
    );

    const snapshot = await repo.getProject(projectId);
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      ["bold_direct", "soft_illustrated"],
      "the unresolvable third direction is withheld rather than shown hard-failing",
    );
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.versionNumber),
      [1, 2],
      "and version numbering has no gap",
    );

    const finalJob = await repo.getGenerationJob(job.id);
    assert.equal(finalJob?.status, "completed", "the job reaches a stable state");
    assert.equal(snapshot?.project.status, "concepts_ready");
  });

  it("E: a short concept set is announced honestly and records why", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    for (const direction of DIRECTIONS) {
      provider.initial.set(direction, "fail");
      provider.replacement.set(direction, "pass");
    }
    const { projectId } = await runInitialJob(repo, provider);

    const snapshot = await repo.getProject(projectId);
    const last = snapshot?.messages.at(-1);
    assert.match(
      last?.content ?? "",
      /^Here are two concept directions\./,
      "the copy never promises three concepts the customer cannot see",
    );
    assert.equal(
      last?.metadata?.conceptsWithheld,
      1,
      "and the short set is durable, observable UX data for a later phase",
    );
  });

  // --- H. A failed replacement is never replaced again -------------------

  it("H: a replacement that still hard-FAILS is not replaced again, and is not shown", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "fail");
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.deepEqual(provider.replacementDispatches, ["soft_illustrated"]);
    assert.equal(provider.totalDispatches, 4, "one replacement only — never two");

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 4, "and no second replacement intent exists");

    const snapshot = await repo.getProject(projectId);
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      ["bold_direct", "minimal_badge"],
      "the direction is withheld rather than shown knowingly non-compliant",
    );
  });

  it("Y: when NO direction can be delivered, the job fails rather than showing hard failures", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    for (const direction of DIRECTIONS) {
      provider.initial.set(direction, "fail");
      provider.replacement.set(direction, "fail");
    }
    const { projectId, job } = await runInitialJob(repo, provider);

    assert.equal(provider.totalDispatches, 5, "still bounded at five");
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 0);
    assert.equal(snapshot?.project.status, "failed");

    const finalJob = await repo.getGenerationJob(job.id);
    assert.equal(finalJob?.status, "failed");
    assert.match(
      finalJob?.lastError ?? "",
      new RegExp(CONCEPT_SET_UNRESOLVABLE_ERROR_PREFIX),
      "recorded as an honest refusal to present non-compliant artwork, not a provider outage",
    );
    assert.ok(
      snapshot?.messages.at(-1)?.content.length,
      "and the customer is told something rather than left hanging",
    );
  });

  // --- I. Deterministic FAIL beats Vision PASS ---------------------------

  it("I: a deterministic hard FAIL triggers replacement even though Vision passed the concept", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("minimal_badge", "fail");
    provider.replacement.set("minimal_badge", "pass");
    const { projectId } = await runInitialJob(repo, provider);

    // The vision provider in this suite always returns `passed: true`.
    assert.deepEqual(provider.replacementDispatches, ["minimal_badge"]);

    const snapshot = await repo.getProject(projectId);
    const minimal = snapshot?.artworkVersions.find(
      (artwork) => artwork.conceptDirectionKey === "minimal_badge",
    );
    assert.equal(minimal?.evaluation?.printPaletteCompliance?.status, "pass");
    assert.equal(
      minimal?.evaluationStatus,
      "passed",
      "Vision's verdict still stands for the concept that is actually delivered",
    );
  });

  // --- J / K. Non-triggers ------------------------------------------------

  it("J: a SOFT palette deviation never triggers a replacement", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    for (const direction of DIRECTIONS) provider.initial.set(direction, "fail");

    const { capability, worker } = buildPipeline(repo, provider);
    const created = await repo.createProject();
    // Soft enforcement: preferred colors contrast with the garment, but the
    // description names no subject-object colors outside the palette.
    await repo.updateBrief(created.project.id, {
      productSummary: "T-shirts",
      designDescription: "A friendly bear mascot holding a pennant",
      shirtColor: "Black",
      preferredColors: ["White"],
    });
    const version = await createDesignBriefCapability(repo).approveWorkingBrief(
      created.project.id,
    );
    await capability.generatePlaceholders(created.project.id, version.id);
    await worker.processNextJob();

    assert.equal(provider.replacementDispatches.length, 0);
    assert.equal(provider.totalDispatches, 3);
    const snapshot = await repo.getProject(created.project.id);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(
      snapshot?.artworkVersions[0]?.evaluation?.printPaletteCompliance?.metrics
        .enforcement,
      "soft",
    );
  });

  it("K: a brief with no palette at all never triggers a replacement", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    for (const direction of DIRECTIONS) provider.initial.set(direction, "fail");

    const { capability, worker } = buildPipeline(repo, provider);
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "T-shirts",
      designDescription: "A black motorcycle",
      shirtColor: "Black",
      preferredColors: [],
    });
    const version = await createDesignBriefCapability(repo).approveWorkingBrief(
      created.project.id,
    );
    await capability.generatePlaceholders(created.project.id, version.id);
    await worker.processNextJob();

    assert.equal(provider.replacementDispatches.length, 0);
    assert.equal(provider.totalDispatches, 3);
    assert.equal(
      (await repo.getProject(created.project.id))?.artworkVersions[0]?.evaluation
        ?.printPaletteCompliance?.status,
      "not_applicable",
    );
  });

  it("K: a batch-only adapter has no per-direction paid unit to replace, and never re-buys the whole batch", async () => {
    const repo = await freshRepo();
    const provider = new BatchOnlyProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedHardPaletteProject(repo);
    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.equal(
      provider.batchDispatches.length,
      1,
      "exactly one paid batch — a hard failure never re-buys three images",
    );
    const snapshot = await repo.getProject(projectId);
    assert.equal(
      snapshot?.artworkVersions.length,
      0,
      "and the known-failing concepts are withheld rather than shown",
    );
  });

  // --- Replacement identity: Q / R / S ------------------------------------

  it("Q/R: a replacement intent is kind=replacement at epoch 1, for the same direction", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");
    const { projectId, job } = await runInitialJob(repo, provider);

    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    const replacement = intents.find(
      (intent) => intent.intentKind === "replacement",
    );
    assert.ok(replacement);
    assert.equal(replacement.intentKind, "replacement");
    assert.equal(replacement.directionKey, "soft_illustrated");
    assert.match(
      replacement.intentKey,
      /:replacement:e1:/,
      "epoch 1 — one automatic replacement per direction, never epoch 2",
    );

    const expected = buildPaidImageIntentKey({
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
    assert.equal(
      replacement.intentKey,
      expected,
      "the identity is a pure function of durable facts, reproducible from outside the worker",
    );
  });

  it("R: the replacement key is distinct from the initial key it replaces", () => {
    const initial = buildPaidImageIntentKey({
      projectId: "p1",
      generationJobId: "j1",
      kind: "initial_concept",
      scopeKey: "soft_illustrated",
    });
    const replacement = buildPaidImageIntentKey({
      projectId: "p1",
      generationJobId: "j1",
      kind: "replacement",
      scopeKey: "soft_illustrated",
      replacedPaidIntentKey: initial,
      epoch: REPLACEMENT_PAID_INTENT_EPOCH,
    });
    assert.notEqual(initial, replacement);
    assert.match(initial, /:initial_concept:e0:/);
    assert.match(replacement, /:replacement:e1:/);

    // Rebuilding it from the same durable facts produces the identical key —
    // this is exactly what makes a reclaim reuse rather than re-buy.
    assert.equal(
      replacement,
      buildPaidImageIntentKey({
        projectId: "p1",
        generationJobId: "j1",
        kind: "replacement",
        scopeKey: "soft_illustrated",
        replacedPaidIntentKey: initial,
        epoch: REPLACEMENT_PAID_INTENT_EPOCH,
      }),
    );
  });

  // --- U / V / S. Reclaim and crash safety --------------------------------

  it("U/S: a reclaim after a successful replacement re-buys nothing and creates no epoch 2", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");
    const { projectId, job, worker } = await runInitialJob(repo, provider);
    assert.equal(provider.totalDispatches, 4);

    await forceReclaimable(repo, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(
      provider.totalDispatches,
      4,
      "the reclaim reused every durable intent — still four paid images",
    );
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 4);
    assert.ok(
      !intents.some((intent) => /:replacement:e2:/.test(intent.intentKey)),
      "no epoch-2 replacement was ever created",
    );
  });

  it("V: repeated reclaims never open a new replacement slot", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");
    const { projectId, job, worker } = await runInitialJob(repo, provider);

    for (let i = 0; i < 4; i += 1) {
      await forceReclaimable(repo, job.id);
      await worker.recoverAbandonedJobs(15 * 60 * 1000);
      await worker.processNextJob();
    }

    assert.equal(provider.totalDispatches, 4, "still exactly four paid images");
    const intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    assert.equal(intents.length, 4);
    const snapshot = await repo.getProject(projectId);
    assert.equal(
      snapshot?.artworkVersions.length,
      3,
      "and still exactly one batch of concepts",
    );
  });

  it("U: a crash between the replacement's paid call and the ArtworkVersion write does not re-buy it", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");

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
    const { projectId, version } = await approvedHardPaletteProject(patched);
    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await patched.listGenerationJobs(projectId);
    assert.ok(job);

    await worker.processNextJob();
    assert.equal(provider.totalDispatches, 4, "the replacement was bought");
    assert.equal((await patched.getProject(projectId))?.artworkVersions.length, 0);

    failVersionWrite = false;
    await forceReclaimable(patched, job.id);
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    assert.equal(
      provider.totalDispatches,
      4,
      "recovery reused the durable replacement and bought nothing",
    );
    const snapshot = await patched.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(
      snapshot?.artworkVersions.find(
        (artwork) => artwork.conceptDirectionKey === "soft_illustrated",
      )?.evaluation?.printPaletteCompliance?.status,
      "pass",
    );
  });

  it("U: a replacement whose provider call fails withholds the direction and never fails the whole job", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacementProviderErrors.add("soft_illustrated");
    const { projectId, job } = await runInitialJob(repo, provider);

    const snapshot = await repo.getProject(projectId);
    assert.deepEqual(
      snapshot?.artworkVersions.map((artwork) => artwork.conceptDirectionKey),
      ["bold_direct", "minimal_badge"],
      "the two healthy concepts are delivered — a failed improvement never destroys them",
    );
    assert.equal((await repo.getGenerationJob(job.id))?.status, "completed");
  });

  // --- NOT_APPLICABLE replacement -----------------------------------------

  it("a replacement whose pixels cannot be read is delivered as needs_review, never as verified-compliant", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    provider.initial.set("soft_illustrated", "fail");
    provider.replacement.set("soft_illustrated", "pass");
    const { projectId } = await runInitialJob(
      repo,
      provider,
      withUnreadableReplacementPixels,
    );

    assert.deepEqual(provider.replacementDispatches, ["soft_illustrated"]);
    const snapshot = await repo.getProject(projectId);
    const soft = snapshot?.artworkVersions.find(
      (artwork) => artwork.conceptDirectionKey === "soft_illustrated",
    );
    assert.ok(soft, "the replacement is still delivered — a paid image is not discarded on a decode failure");
    assert.equal(
      soft?.evaluation?.printPaletteCompliance?.status,
      "not_applicable",
    );
    assert.equal(
      soft?.evaluationStatus,
      "needs_review",
      "but nothing downstream may treat it as verified hard-palette compliant",
    );
  });

  // --- W. Targeted revision stays separate --------------------------------

  it("W: a targeted revision is never an automatic replacement, and keeps its own paid identity", async () => {
    const repo = await freshRepo();
    const provider = new PaletteScriptedProvider();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedHardPaletteProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const initial = await repo.getProject(projectId);
    assert.equal(initial?.artworkVersions.length, 3);
    const selected = initial!.artworkVersions[0]!;

    // The revision itself comes back hard-failing. It must NOT be
    // auto-replaced: the customer asked for this specific change, and
    // silently re-buying a different interpretation of it is not a
    // correction, it is a substitution they never asked for.
    provider.initial.set("bold_direct", "fail");
    await repo.updateBrief(projectId, {
      designDescription:
        "A black motorcycle with a black leather seat, a black helmet and a wide border",
    });
    const revisedVersion = await createDesignBriefCapability(
      repo,
    ).approveWorkingBrief(projectId);
    await capability.reviseSelectedConcept(
      projectId,
      revisedVersion.id,
      selected.id,
      "make the border wider",
    );
    const revisionJob = (await repo.listGenerationJobs(projectId)).find(
      (job) => job.targetArtworkVersionId === selected.id,
    );
    assert.ok(revisionJob);

    await worker.processNextJob();

    assert.equal(provider.batchDispatches.length, 1, "one paid edit");
    assert.equal(
      provider.replacementDispatches.length,
      0,
      "and no automatic replacement was triggered by the revision's verdict",
    );
    const revisionIntents = await repo.listPaidImageIntentsForJob(
      projectId,
      revisionJob.id,
    );
    assert.equal(revisionIntents.length, 1);
    assert.equal(revisionIntents[0]?.intentKind, "targeted_revision");
  });

  // --- Policy unit rules ---------------------------------------------------

  it("policy: only EXPLICIT ink restriction + violating FAIL is an automatic-replacement trigger", () => {
    const advisoryBrief = {
      designDescription:
        "A black motorcycle with a black leather seat and a black helmet",
      additionalInstructions: null,
      exclusions: null,
    };
    const explicitBrief = {
      ...advisoryBrief,
      additionalInstructions:
        "ONE COLOR WHITE INK ONLY. DO NOT USE BLACK INK.",
    };
    const compliance = (
      status: "pass" | "warn" | "fail" | "not_applicable",
      enforcement: "hard" | "soft" | "none",
      reasons: string[] = ["excessive_garment_matching_ink"],
      metrics: Record<string, number> = {
        nearBlackPixelFraction: 0.7,
        darkPixelFraction: 0.7,
        garmentMatchingFraction: 0.7,
        paletteCoverageFraction: 0.2,
      },
    ) =>
      ({
        printPaletteCompliance: {
          status,
          reasons,
          metrics: { enforcement, ...metrics },
        },
      }) as never;

    // Inferred hard + FAIL without explicit restriction → no spend.
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        compliance("fail", "hard"),
        advisoryBrief,
      ),
      false,
    );
    assert.equal(
      isHardPrintPaletteFailure(compliance("fail", "hard"), advisoryBrief),
      false,
    );

    // Explicit restriction + violating FAIL → eligible.
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        compliance("fail", "hard"),
        explicitBrief,
      ),
      true,
    );

    // Explicit restriction but PASS/WARN → keep.
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        compliance("warn", "hard"),
        explicitBrief,
      ),
      false,
    );
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        compliance("pass", "hard"),
        explicitBrief,
      ),
      false,
    );
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        compliance("not_applicable", "hard"),
        explicitBrief,
      ),
      false,
    );

    // Soft/none enforcement still never spends without restriction evidence;
    // without restriction, soft FAIL is also non-eligible.
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        compliance("fail", "soft"),
        advisoryBrief,
      ),
      false,
    );
    assert.equal(isHardPrintPaletteFailure(null), false);
    assert.equal(
      isHardPrintPaletteFailure({ printPaletteCompliance: null } as never),
      false,
    );
  });

  it("policy: PASS and WARN replacements are accepted; EXPLICIT FAIL is rejected; advisory FAIL is accepted", () => {
    const restriction = {
      kind: "white_ink_only" as const,
      sourceField: "additionalInstructions" as const,
      matchedPhrase: "white ink only",
    };
    const at = (
      status: "pass" | "warn" | "fail" | "not_applicable",
      metrics: Record<string, number> = {},
      reasons: string[] = [],
    ) =>
      ({
        status,
        reasons,
        metrics: {
          nearBlackPixelFraction: 0,
          darkPixelFraction: 0,
          garmentMatchingFraction: 0,
          paletteCoverageFraction: 1,
          ...metrics,
        },
      }) as never;

    assert.equal(classifyReplacementAcceptance(at("pass"), restriction), "accept");
    assert.equal(classifyReplacementAcceptance(at("warn"), restriction), "accept");
    assert.equal(
      classifyReplacementAcceptance(
        at(
          "fail",
          {
            nearBlackPixelFraction: 0.7,
            garmentMatchingFraction: 0.7,
            paletteCoverageFraction: 0.2,
          },
          ["excessive_garment_matching_ink"],
        ),
        restriction,
      ),
      "reject",
    );
    assert.equal(
      classifyReplacementAcceptance(
        at(
          "fail",
          {
            nearBlackPixelFraction: 0.7,
            garmentMatchingFraction: 0.7,
            paletteCoverageFraction: 0.2,
          },
          ["excessive_garment_matching_ink"],
        ),
        null,
      ),
      "accept",
      "advisory FAIL after replacement must not withhold",
    );
    assert.equal(
      classifyReplacementAcceptance(at("not_applicable"), restriction),
      "accept_unverified",
    );
    assert.equal(classifyReplacementAcceptance(null), "accept_unverified");
  });

  // --- Harley decision regression (Step 17 / Phase 2C.3A) -----------------
  //
  // The live Phase 2B calibration rasters are customer assets and are
  // gitignored, so this runs only where they exist. It calls NO provider —
  // it drives the real validator over the real pixels and asserts the Phase
  // 2C.3A DECISION each verdict produces.

  const harleyFiles = {
    bold: path.join(HARLEY_DIR, "bold_direct.png"),
    soft: path.join(HARLEY_DIR, "soft_illustrated.png"),
    minimal: path.join(HARLEY_DIR, "minimal_badge.png"),
  };
  const harleyPresent =
    existsSync(harleyFiles.bold) &&
    existsSync(harleyFiles.soft) &&
    existsSync(harleyFiles.minimal);

  it(
    "Harley regression (advisory): Bold keep, Soft KEEP, Minimal keep — exactly 3 paid intents",
    { skip: !harleyPresent },
    () => {
      const brief = {
        ...hardWhiteOnBlackBrief(),
        designDescription:
          "A black 2005 Harley Road Glide with black leather and black helmet",
        exactText: "",
        deferredSections: [],
      } as DesignBriefSnapshotContent;

      const verdicts = {
        bold_direct: evaluatePrintPaletteCompliance({
          image: decodeRgba(readFileSync(harleyFiles.bold)),
          brief,
        }),
        soft_illustrated: evaluatePrintPaletteCompliance({
          image: decodeRgba(readFileSync(harleyFiles.soft)),
          brief,
        }),
        minimal_badge: evaluatePrintPaletteCompliance({
          image: decodeRgba(readFileSync(harleyFiles.minimal)),
          brief,
        }),
      };

      assert.equal(verdicts.soft_illustrated.status, "fail");
      assert.notEqual(verdicts.minimal_badge.status, "fail");
      assert.notEqual(verdicts.bold_direct.status, "fail");

      const decisions = DIRECTIONS.map((direction) => ({
        direction,
        replace: isAutomaticInkRestrictionReplacementEligible(
          { printPaletteCompliance: verdicts[direction] } as never,
          brief,
        ),
      }));
      assert.deepEqual(decisions, [
        { direction: "bold_direct", replace: false },
        { direction: "soft_illustrated", replace: false },
        { direction: "minimal_badge", replace: false },
      ]);

      const paidIntents = 3 + decisions.filter((d) => d.replace).length;
      assert.equal(paidIntents, 3, "3 initial + 0 replacement ≈ $0.126");
      assert.ok(paidIntents <= ABSOLUTE_MAX_PAID_INTENTS_PER_JOB);
    },
  );

  it(
    "Harley regression (explicit WHITE INK ONLY): Soft FAIL becomes replacement-eligible",
    { skip: !harleyPresent },
    () => {
      const brief = {
        ...explicitWhiteInkOnlyBrief(),
        designDescription:
          "A black 2005 Harley Road Glide with black leather and black helmet",
        exactText: "",
        deferredSections: [],
      } as DesignBriefSnapshotContent;

      const soft = evaluatePrintPaletteCompliance({
        image: decodeRgba(readFileSync(harleyFiles.soft)),
        brief,
      });
      assert.equal(soft.status, "fail");
      assert.equal(
        isAutomaticInkRestrictionReplacementEligible(
          { printPaletteCompliance: soft } as never,
          brief,
        ),
        true,
      );
    },
  );

  it("Harley regression: synthetic WARN/FAIL/PASS — advisory Soft FAIL does not replace", () => {
    // The committed half of the regression above: the WARN / FAIL / PASS
    // shapes the live rasters produce, reproduced from pixels this repo
    // actually carries, so the decision rule stays covered everywhere.
    const brief = {
      ...hardWhiteOnBlackBrief(),
      deferredSections: [],
    } as DesignBriefSnapshotContent;
    const shapes: Record<ConceptDirectionKey, PaletteOutcome> = {
      bold_direct: "warn",
      soft_illustrated: "fail",
      minimal_badge: "pass",
    };
    const decisions = DIRECTIONS.map((direction) => ({
      direction,
      replace: isAutomaticInkRestrictionReplacementEligible(
        {
          printPaletteCompliance: evaluatePrintPaletteCompliance({
            image: decodeRgba(palettePng(shapes[direction])),
            brief,
          }),
        } as never,
        brief,
      ),
    }));
    assert.deepEqual(decisions, [
      { direction: "bold_direct", replace: false },
      { direction: "soft_illustrated", replace: false },
      { direction: "minimal_badge", replace: false },
    ]);
  });

  it("Harley regression: synthetic Soft FAIL + explicit WHITE INK ONLY → replace once eligible", () => {
    const brief = {
      ...explicitWhiteInkOnlyBrief(),
      deferredSections: [],
    } as DesignBriefSnapshotContent;
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        {
          printPaletteCompliance: evaluatePrintPaletteCompliance({
            image: decodeRgba(palettePng("fail")),
            brief,
          }),
        } as never,
        brief,
      ),
      true,
    );
    assert.equal(
      isAutomaticInkRestrictionReplacementEligible(
        {
          printPaletteCompliance: evaluatePrintPaletteCompliance({
            image: decodeRgba(palettePng("pass")),
            brief,
          }),
        } as never,
        brief,
      ),
      false,
    );
  });

  // --- AC. No paid provider is reachable from a test/verify run ------------

  it("AC: the automated-test environment can never resolve a paid provider", () => {
    const resolved = resolveConceptGenerationProvider();
    assert.equal(resolved.providerKey, "placeholder");
    assert.equal(
      typeof (resolved as { generateDirection?: unknown }).generateDirection,
      "undefined",
      "and it exposes no paid per-direction path at all",
    );
  });
});
