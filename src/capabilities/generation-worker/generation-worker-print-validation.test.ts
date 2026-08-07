import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import { toCustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import {
  createConceptEvaluationCapability,
  CONCEPT_EVALUATION_CRITERION_KEYS,
  type ConceptEvaluationProvider,
  type ConceptEvaluationRequest,
  type ConceptEvaluationResult,
} from "@/capabilities/concept-evaluation";
import {
  createPrintValidationCapability,
  type PrintValidationCapability,
  type PrintValidationInput,
  type PrintValidationReport,
} from "@/capabilities/print-validation";
import type { ConceptEvaluationStatus, PrintPlacement } from "@/lib/domain/types";

import { createGenerationWorkerCapability } from "./generation-worker-capability";

/** Produces real image bytes with controllable dimensions/transparency — unlike the placeholder provider, this exercises effective-resolution checks. */
class FixedImageProvider implements ConceptGenerationProvider {
  readonly providerKey = "fixed-image-test";
  constructor(
    private readonly image: {
      widthPx: number;
      heightPx: number;
      hasTransparency: boolean;
      contentType?: string;
    },
  ) {}
  async generate(request: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: "x",
        placeholderLabel: `Concept ${index}`,
        accentColor: "#000",
        kind: "concept" as const,
        asset: {
          imageBytes: Buffer.from([0, 1, 2, 3]),
          contentType: this.image.contentType ?? "image/png",
          widthPx: this.image.widthPx,
          heightPx: this.image.heightPx,
          hasTransparency: this.image.hasTransparency,
          providerMetadata: {},
        },
      })),
    };
  }
}

/** No real image bytes — mirrors the actual placeholder provider's shape. */
class NoImageProvider implements ConceptGenerationProvider {
  readonly providerKey = "no-image-test";
  async generate(request: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: "x",
        placeholderLabel: `Concept ${index}`,
        accentColor: "#000",
        kind: "concept" as const,
      })),
    };
  }
}

class FixedStatusConceptEvaluationProvider implements ConceptEvaluationProvider {
  readonly providerKey = "fixed-status-test";
  constructor(private readonly status: ConceptEvaluationStatus) {}
  async evaluate(request: ConceptEvaluationRequest): Promise<ConceptEvaluationResult> {
    const passed =
      this.status === "passed" ? true : this.status === "failed" ? false : null;
    return {
      overallScore: passed === null ? null : passed ? 95 : 20,
      passed,
      confidence: 80,
      status: this.status,
      criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
        key,
        score: key === "required_wording" ? (passed ? 100 : 0) : null,
        passed: key === "required_wording" ? passed : null,
        confidence: 80,
        notes: null,
      })),
      warnings: [],
      recommendations: [],
      missingRequirements: [],
      matchedRequirements: [],
      providerMetadata: { assetCount: request.assets.length },
    };
  }
}

/** Wraps the real PrintValidationCapability to record every call — proves the wiring without coupling tests to log strings. */
function createRecordingPrintValidation(): {
  capability: PrintValidationCapability;
  calls: Array<{ input: PrintValidationInput; report: PrintValidationReport }>;
} {
  const real = createPrintValidationCapability();
  const calls: Array<{ input: PrintValidationInput; report: PrintValidationReport }> = [];
  return {
    calls,
    capability: {
      validateArtwork(input) {
        const report = real.validateArtwork(input);
        calls.push({ input, report });
        return report;
      },
    },
  };
}

describe("GenerationWorkerCapability — provisional Print Validation (Sprint 2M Phase 2A)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-worker-print-validation-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  function buildPipeline(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    options: {
      provider?: ConceptGenerationProvider;
      evaluationStatus?: ConceptEvaluationStatus;
    } = {},
  ) {
    const provider =
      options.provider ??
      new FixedImageProvider({ widthPx: 1024, heightPx: 1024, hasTransparency: true });
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const conceptEvaluation = createConceptEvaluationCapability(
      new FixedStatusConceptEvaluationProvider(options.evaluationStatus ?? "passed"),
    );
    const { capability: printValidation, calls } = createRecordingPrintValidation();
    const capability = createConceptGenerationCapability(repo, provider.providerKey);
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      promptTranslation,
      assets,
      conceptEvaluation,
      undefined,
      printValidation,
    );
    return { capability, worker, calls };
  }

  async function approvedProject(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    overrides: Partial<{
      productSummary: string;
      printPlacement: PrintPlacement | null;
    }> = {},
  ) {
    const created = await repo.createProject();
    const printPlacement: PrintPlacement | null =
      overrides.printPlacement === undefined ? "full_back" : overrides.printPlacement;
    await repo.updateBrief(created.project.id, {
      productSummary: overrides.productSummary ?? "T-shirt",
      designDescription: "A bear mascot",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      printPlacement,
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  // --- Scenario A -----------------------------------------------------------
  it("A: Concept Evaluation passed + 1024x1024 raster concept + full-back target → provisional finalization_required", async () => {
    const repo = await freshRepo();
    const { capability, worker, calls } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.report.status, "finalization_required");
      assert.ok(
        call.report.requiredTransformations.includes("regenerate_at_production_dimensions"),
      );
    }
  });

  // --- Scenario B -------------------------------------------------------------
  it("B: Concept Evaluation passing does not produce print_ready on the project", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.notEqual(snapshot?.project.status, "print_ready");
  });

  // --- Scenario C -------------------------------------------------------------
  it("C: provisional validation never changes PrintProject.status, whatever the report status is", async () => {
    const repo = await freshRepo();
    // A "ready"-eligible concept (small placement, sufficient pixels).
    const readyProvider = new FixedImageProvider({
      widthPx: 2000,
      heightPx: 2000,
      hasTransparency: true,
    });
    const { capability, worker, calls } = buildPipeline(repo, { provider: readyProvider });
    const { projectId, version } = await approvedProject(repo, {
      printPlacement: "left_chest",
    });

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.ok(calls.some((c) => c.report.status === "ready"));
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.project.status, "concepts_ready");
    assert.notEqual(snapshot?.project.status, "finalizing");
    assert.notEqual(snapshot?.project.status, "print_ready");
  });

  // --- Scenario D -------------------------------------------------------------
  it("D: provisional validation never marks an ArtworkVersion as final artwork", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    for (const artwork of snapshot!.artworkVersions) {
      assert.equal(artwork.isSelected, false);
      assert.equal(artwork.printValidationStatus, null);
      assert.equal(artwork.kind, "concept");
    }
  });

  // --- Scenario E -------------------------------------------------------------
  it("E: no production transformation is executed — no vector/print companion assets, no extra asset rows", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const assets = await repo.listAssets(projectId);
    // Exactly primary + thumbnail per concept (3 concepts) — nothing extra.
    assert.ok(assets.length <= 6);
    for (const asset of assets) {
      assert.equal(asset.vectorAssetId, null);
      assert.equal(asset.printAssetId, null);
    }
  });

  // --- Scenario F -------------------------------------------------------------
  it("F: generation retry remains idempotent — provisional validation does not re-run for already-evaluated concepts", async () => {
    const repo = await freshRepo();
    const { capability, worker, calls } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    assert.equal(calls.length, 3);

    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "completed");

    // Simulate a stale re-run (e.g. a duplicate claim that lost the race).
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(job!.id, { status: "running", heartbeatAt: longAgo });
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    // Every concept already had evaluationStatus set, so the idempotent
    // backfill path has nothing to do — no duplicate provisional calls.
    assert.equal(calls.length, 3);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
  });

  // --- Scenario G -------------------------------------------------------------
  it("G: missing asset metadata (placeholder-style provider) is represented honestly as blocked, without breaking generation", async () => {
    const repo = await freshRepo();
    const { capability, worker, calls } = buildPipeline(repo, {
      provider: new NoImageProvider(),
    });
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.report.status, "blocked");
      assert.equal(call.input.primaryAsset, null);
    }

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "completed");
  });

  // --- Scenario H -------------------------------------------------------------
  it("H: an unconfirmed production method never becomes 'confirmed'", async () => {
    const repo = await freshRepo();
    const { capability, worker, calls } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    for (const call of calls) {
      assert.notEqual(call.report.requirements.printMethodConfidence, "confirmed");
    }
  });

  // --- Scenario I -------------------------------------------------------------
  it("I: placement-derived physical dimensions remain provisional — null target dimensions when print location is unknown", async () => {
    const repo = await freshRepo();
    const { capability, worker, calls } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo, { printPlacement: null });

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    for (const call of calls) {
      assert.equal(call.report.requirements.targetDimensions, null);
    }
  });

  // --- Scenario J -------------------------------------------------------------
  it("J: customer ArtworkVersion serialization exposes no Print Validation internals", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    for (const artwork of snapshot!.artworkVersions) {
      const customerView = toCustomerArtworkVersion(artwork);
      assert.equal(customerView.printValidationStatus, null);
      assert.equal("requirements" in customerView, false);
      assert.equal("requiredTransformations" in customerView, false);
      assert.equal("checks" in customerView, false);
      assert.equal("storageKey" in customerView, false);
    }
  });

  // --- Scenario K -------------------------------------------------------------
  it("K: Concept Evaluation failure behavior is unchanged by Print Validation being wired in", async () => {
    const repo = await freshRepo();
    const { capability, worker, calls } = buildPipeline(repo, { evaluationStatus: "failed" });
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    // Concept Evaluation "failed" still never discards the concept —
    // unchanged Phase 1/2I behavior.
    assert.equal(snapshot?.artworkVersions.length, 3);
    for (const artwork of snapshot!.artworkVersions) {
      assert.equal(artwork.evaluationStatus, "failed");
    }
    assert.equal(snapshot?.project.status, "concepts_ready");

    // Print Validation reflects the failed evaluation but never causes it.
    for (const call of calls) {
      const evalCheck = call.report.checks.find(
        (c) => c.check === "concept_evaluation_alignment",
      );
      assert.equal(evalCheck?.status, "fail");
    }
  });
});
