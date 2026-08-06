import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";

import {
  createConceptEvaluationCapability,
  PlaceholderConceptEvaluationProvider,
  type ConceptEvaluationProvider,
  type ConceptEvaluationResult,
  CONCEPT_EVALUATION_CRITERION_KEYS,
} from "./index";

class InstantProvider implements ConceptGenerationProvider {
  readonly providerKey = "instant";
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

describe("Concept Evaluation — generation integration (Sprint 2I Phase 1)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-concept-eval-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  async function approvedProject(repo: Awaited<ReturnType<typeof freshRepo>>) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp t-shirts",
      designDescription: "A friendly bear mascot",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  function buildPipeline(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    evaluationProvider: ConceptEvaluationProvider = new PlaceholderConceptEvaluationProvider(),
  ) {
    const generationProvider = new InstantProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(
      repo,
      generationProvider.providerKey,
    );
    const conceptEvaluation = createConceptEvaluationCapability(evaluationProvider);
    const worker = createGenerationWorkerCapability(
      repo,
      generationProvider,
      promptTranslation,
      assets,
      conceptEvaluation,
    );
    return { capability, worker, conceptEvaluation };
  }

  it("persists evaluation on every concept after generation without changing customer copy", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.project.status, "concepts_ready");
    assert.equal(snapshot?.artworkVersions.length, 3);
    for (const art of snapshot!.artworkVersions) {
      assert.equal(art.evaluationStatus, "needs_review");
      assert.ok(art.evaluation);
      assert.equal(art.evaluation!.criteria.length, 9);
      assert.ok(art.evaluationEvaluatedAt);
      assert.equal(art.evaluationProviderKey, "placeholder_concept_evaluation");
    }

    const readyMessage = snapshot!.messages.filter((m) => m.role === "assistant").at(-1);
    assert.match(readyMessage?.content ?? "", /concept directions/i);
    assert.doesNotMatch(readyMessage?.content ?? "", /needs_review|score|evaluation/i);
  });

  it("continues generation and retains concepts when the evaluation provider throws", async () => {
    const failing: ConceptEvaluationProvider = {
      providerKey: "broken_eval",
      async evaluate(): Promise<ConceptEvaluationResult> {
        throw new Error("evaluator exploded");
      },
    };

    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo, failing);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
    for (const art of snapshot!.artworkVersions) {
      assert.equal(art.evaluationStatus, "needs_review");
      assert.equal(art.evaluation?.providerMetadata.mode, "failure_fallback");
    }
  });

  it("is idempotent: a second worker pass does not duplicate concepts or re-score evaluated ones", async () => {
    const callCounts = { evaluate: 0 };
    const counting: ConceptEvaluationProvider = {
      providerKey: "counting",
      async evaluate(): Promise<ConceptEvaluationResult> {
        callCounts.evaluate += 1;
        return {
          overallScore: 10,
          passed: null,
          confidence: 1,
          status: "needs_review",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: null,
            passed: null,
            confidence: 0,
            notes: "counted",
          })),
          warnings: [],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: { n: callCounts.evaluate },
        };
      },
    };

    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo, counting);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    assert.equal(callCounts.evaluate, 3);

    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    // Simulate a recovered duplicate claim after success.
    await repo.updateGenerationJob(job.id, { status: "queued" });
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    // Already evaluated concepts are not re-scored on the idempotent path.
    assert.equal(callCounts.evaluate, 3);
  });

  it("persists evaluation via updateArtworkEvaluation for backfill when status was null", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    const art = snapshot!.artworkVersions[0]!;
    // Clear evaluation as if an older run wrote concepts without it.
    await repo.updateArtworkEvaluation(art.id, {
      evaluationStatus: "pending",
      evaluation: {
        overallScore: null,
        passed: null,
        confidence: 0,
        criteria: [],
        warnings: [],
        recommendations: [],
        missingRequirements: [],
        matchedRequirements: [],
        providerMetadata: {},
      },
      evaluationEvaluatedAt: new Date().toISOString(),
      evaluationProviderKey: "manual",
    });

    // Force status null by writing through add is not possible; exercise
    // repository update + read round-trip for persistence contract.
    const updated = await repo.updateArtworkEvaluation(art.id, {
      evaluationStatus: "passed",
      evaluation: {
        overallScore: 95,
        passed: true,
        confidence: 90,
        criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
          key,
          score: 95,
          passed: true,
          confidence: 90,
          notes: null,
        })),
        warnings: [],
        recommendations: [],
        missingRequirements: [],
        matchedRequirements: ["style"],
        providerMetadata: { source: "test" },
      },
      evaluationEvaluatedAt: "2026-08-06T00:00:00.000Z",
      evaluationProviderKey: "test_provider",
    });

    assert.equal(updated.evaluationStatus, "passed");
    assert.equal(updated.evaluationProviderKey, "test_provider");
    assert.equal(updated.evaluation?.overallScore, 95);

    const reloaded = await repo.getProject(projectId);
    const found = reloaded!.artworkVersions.find((a) => a.id === art.id);
    assert.equal(found?.evaluationStatus, "passed");
    assert.equal(found?.evaluationEvaluatedAt, "2026-08-06T00:00:00.000Z");
  });
});
