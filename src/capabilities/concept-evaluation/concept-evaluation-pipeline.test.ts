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
  OpenAIConceptEvaluationProvider,
  PlaceholderConceptEvaluationProvider,
  type ConceptEvaluationProvider,
  type ConceptEvaluationResult,
  CONCEPT_EVALUATION_CRITERION_KEYS,
} from "./index";

class InstantProvider implements ConceptGenerationProvider {
  readonly providerKey = "instant";
  readonly editsSourceArtwork = false;
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

describe("Concept Evaluation — real (OpenAI) provider generation-worker integration (Sprint 2I Phase 2)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-concept-eval-openai-"));
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
      designStyle: "Rustic",
      preferredColors: ["Gold"],
      exclusions: "No cartoon weapons",
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  function fullMatchPayload() {
    return {
      requiredWording: { found: true, detectedText: "Camp Wildwood 2026", confidence: 92, notes: "clear" },
      exclusions: { violated: false, details: "none seen", confidence: 88 },
      style: { matches: true, score: 82, confidence: 78, notes: "rustic hand-drawn feel" },
      graphics: { matches: true, score: 85, confidence: 80, notes: "bear mascot present" },
      colorPalette: { matches: true, score: 80, confidence: 75, notes: "gold used" },
      productCompatibility: { matches: true, score: 90, confidence: 70, notes: "fits a t-shirt" },
      composition: { score: 82, confidence: 75, notes: "balanced" },
      readability: { score: 88, confidence: 80, notes: "legible" },
      overallAlignment: { score: 85, confidence: 80, notes: "strong alignment" },
      warnings: [],
      recommendations: [],
    };
  }

  it("evaluates real generated concepts against the approved brief via image URLs derived from AssetCapability", async () => {
    const repo = await freshRepo();
    const requestedImageUrls: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMessage = body.messages.find((m) => m.role === "user")!;
      const content = userMessage.content as Array<Record<string, unknown>>;
      const image = content.find((p) => p.type === "image_url") as {
        image_url: { url: string };
      };
      requestedImageUrls.push(image.image_url.url);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fullMatchPayload()) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const evaluationProvider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: async () => {},
    });

    const generationProvider = new InstantProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, generationProvider.providerKey);
    const conceptEvaluation = createConceptEvaluationCapability(evaluationProvider);
    const worker = createGenerationWorkerCapability(
      repo,
      generationProvider,
      promptTranslation,
      assets,
      conceptEvaluation,
    );

    const { projectId, version } = await approvedProject(repo);
    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    // InstantProvider produces no real image bytes, so no asset — and
    // therefore no source URL — exists per concept. The adapter must
    // degrade to its honest no-image result rather than fabricate one.
    for (const art of snapshot!.artworkVersions) {
      assert.equal(art.evaluationStatus, "needs_review");
      assert.equal(art.evaluation?.providerMetadata.mode, "no_image_available");
      assert.equal(art.evaluationProviderKey, "openai_vision_concept_evaluation");
    }
    assert.equal(requestedImageUrls.length, 0);

    // Customer-facing copy never mentions provider internals.
    const readyMessage = snapshot!.messages.filter((m) => m.role === "assistant").at(-1);
    assert.doesNotMatch(readyMessage?.content ?? "", /openai|vision|gpt|score/i);
  });

  it("passes AssetCapability-issued signed URLs through to the provider when real image bytes exist", async () => {
    const repo = await freshRepo();
    const requestedImageUrls: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMessage = body.messages.find((m) => m.role === "user")!;
      const content = userMessage.content as Array<Record<string, unknown>>;
      const image = content.find((p) => p.type === "image_url") as {
        image_url: { url: string };
      };
      requestedImageUrls.push(image.image_url.url);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fullMatchPayload()) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const evaluationProvider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: async () => {},
    });

    class RealBytesProvider implements ConceptGenerationProvider {
      readonly providerKey = "real-bytes";
      readonly editsSourceArtwork = false;
      async generate(req: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
        return {
          jobId: req.idempotencyKey,
          providerKey: this.providerKey,
          concepts: Array.from({ length: req.conceptCount }, (_, index) => ({
            versionNumber: index + 1,
            title: `Concept ${index + 1}`,
            summary: "x",
            placeholderLabel: `Concept ${index}`,
            accentColor: "#000",
            kind: "concept" as const,
            asset: {
              imageBytes: Buffer.from("fake-png-bytes"),
              contentType: "image/png",
              widthPx: 1024,
              heightPx: 1024,
              hasTransparency: true,
              providerMetadata: {},
            },
          })),
        };
      }
    }

    const generationProvider = new RealBytesProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, generationProvider.providerKey);
    const conceptEvaluation = createConceptEvaluationCapability(evaluationProvider);
    const worker = createGenerationWorkerCapability(
      repo,
      generationProvider,
      promptTranslation,
      assets,
      conceptEvaluation,
    );

    const { projectId, version } = await approvedProject(repo);
    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    // One image URL was requested per concept, each a data: URI (the
    // DataUriAssetStorageProvider's "signed URL") — never a raw storage key.
    assert.equal(requestedImageUrls.length, 3);
    for (const url of requestedImageUrls) {
      assert.match(url, /^data:image\/png;base64,/);
    }
    for (const art of snapshot!.artworkVersions) {
      assert.equal(art.evaluationStatus, "passed");
      assert.equal(art.evaluation?.overallScore, 85);
      assert.equal(art.evaluationProviderKey, "openai_vision_concept_evaluation");
    }
  });

  it("falls back to needs_review and never discards concepts when the real provider fails", async () => {
    const repo = await freshRepo();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "down" }), { status: 503 })) as typeof fetch;

    const evaluationProvider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: async () => {},
    });

    class RealBytesProvider implements ConceptGenerationProvider {
      readonly providerKey = "real-bytes";
      readonly editsSourceArtwork = false;
      async generate(req: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
        return {
          jobId: req.idempotencyKey,
          providerKey: this.providerKey,
          concepts: Array.from({ length: req.conceptCount }, (_, index) => ({
            versionNumber: index + 1,
            title: `Concept ${index + 1}`,
            summary: "x",
            placeholderLabel: `Concept ${index}`,
            accentColor: "#000",
            kind: "concept" as const,
            asset: {
              imageBytes: Buffer.from("fake-png-bytes"),
              contentType: "image/png",
              widthPx: 1024,
              heightPx: 1024,
              hasTransparency: true,
              providerMetadata: {},
            },
          })),
        };
      }
    }

    const generationProvider = new RealBytesProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, generationProvider.providerKey);
    const conceptEvaluation = createConceptEvaluationCapability(evaluationProvider);
    const worker = createGenerationWorkerCapability(
      repo,
      generationProvider,
      promptTranslation,
      assets,
      conceptEvaluation,
    );

    const { projectId, version } = await approvedProject(repo);
    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    // Failure never discards concepts — all 3 still exist, presented to the
    // customer, just internally marked needs_review.
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
    for (const art of snapshot!.artworkVersions) {
      assert.equal(art.evaluationStatus, "needs_review");
      assert.equal(art.evaluation?.providerMetadata.mode, "failure_fallback");
    }
  });
});
