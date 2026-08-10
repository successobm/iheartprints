import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import {
  UnavailableConceptGenerationProvider,
  type ConceptGenerationProvider,
} from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import { createConceptGenerationCapability } from "./concept-generation-capability";

/** A minimal always-succeeds provider, standing in for "configuration was fixed". */
class WorkingProvider implements ConceptGenerationProvider {
  readonly providerKey = "working";
  readonly editsSourceArtwork = false;
  async generate(request: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: "A working concept.",
        placeholderLabel: `Concept ${index + 1}`,
        accentColor: "#123456",
        kind: "concept" as const,
      })),
    };
  }
}

describe("ConceptGenerationCapability — production-unsafe configuration (Sprint 2H Part 1A/2A)", () => {
  let tempDir = "";
  let previousCwd = "";
  let warnCalls: unknown[][] = [];
  let errorCalls: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-unavailable-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  beforeEach(() => {
    warnCalls = [];
    errorCalls = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
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
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  function buildPipeline(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    provider: ConceptGenerationProvider,
  ) {
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, provider.providerKey);
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      promptTranslation,
      assets,
    );
    return { capability, worker, assets };
  }

  function unavailableProvider() {
    return new UnavailableConceptGenerationProvider(
      "GENERATION_PROVIDER_NOT_CONFIGURED",
      "openai",
      "CONCEPT_GENERATION_PROVIDER=openai but OPENAI_API_KEY is not set in a production environment.",
    );
  }

  it("fails the job with a safe error code, creates no concepts or assets, and shows a customer-safe message", async () => {
    const repo = await freshRepo();
    const { capability, worker, assets } = buildPipeline(repo, unavailableProvider());
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(snapshot?.artworkVersions.length, 0);
    assert.equal(snapshot?.project.status, "failed");
    assert.deepEqual(await assets.listAssets(projectId), []);

    const lastMessage = snapshot?.messages.at(-1);
    assert.equal(
      lastMessage?.content,
      "Concept generation is temporarily unavailable. Please try again shortly.",
    );

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed");
    assert.match(jobs[0]?.lastError ?? "", /GENERATION_PROVIDER_NOT_CONFIGURED/);
  });

  it("never leaks provider or key terminology into any customer-facing message", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo, unavailableProvider());
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    for (const message of snapshot?.messages ?? []) {
      assert.doesNotMatch(message.content, /openai|api[_-]?key|GENERATION_PROVIDER_NOT_CONFIGURED|placeholder/i);
    }
  });

  it("logs a structured, secret-free configuration error including the job and project id", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo, unavailableProvider());
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const jobs = await repo.listGenerationJobs(projectId);

    assert.equal(errorCalls.length, 1);
    const [label, payload] = errorCalls[0] as [string, Record<string, unknown>];
    assert.match(label, /concept-generation/i);
    assert.equal(payload.safeErrorCode, "GENERATION_PROVIDER_NOT_CONFIGURED");
    assert.equal(payload.provider, "openai");
    assert.equal(payload.generationJobId, jobs[0]?.id);
    assert.equal(payload.projectId, projectId);

    const serialized = JSON.stringify([label, payload]);
    assert.doesNotMatch(serialized, /sk-|Bearer|authorization/i);
  });

  it("a failed regeneration due to unavailable configuration preserves existing concepts and reassures the customer", async () => {
    const repo = await freshRepo();
    const working = buildPipeline(repo, new WorkingProvider());
    const { projectId, version: v1 } = await approvedProject(repo);
    await working.capability.generatePlaceholders(projectId, v1.id);
    await working.worker.processNextJob();

    await repo.updateBrief(projectId, { designDescription: "A revised bear mascot" });
    const designBrief = createDesignBriefCapability(repo);
    const v2 = await designBrief.approveWorkingBrief(projectId);

    // Configuration became unavailable before this regeneration attempt —
    // a fresh worker built against the unavailable provider stands in for
    // "the process restarted with broken config", which is how env-driven
    // configuration actually changes in this architecture.
    const broken = buildPipeline(repo, unavailableProvider());
    await broken.capability.regenerateAfterRevision(projectId, v2.id);
    await broken.worker.processNextJob();
    const failedSnapshot = await repo.getProject(projectId);

    assert.equal(failedSnapshot?.artworkVersions.length, 3); // original batch intact
    assert.equal(failedSnapshot?.project.status, "concepts_ready");
    assert.match(
      failedSnapshot?.messages.at(-1)?.content ?? "",
      /temporarily unavailable/i,
    );
    assert.match(
      failedSnapshot?.messages.at(-1)?.content ?? "",
      /current concepts are still available/i,
    );

    // Retry remains possible once configuration is fixed (a new process
    // picking up the corrected environment).
    const fixed = buildPipeline(repo, new WorkingProvider());
    await fixed.capability.regenerateAfterRevision(projectId, v2.id);
    await fixed.worker.processNextJob();
    const recoveredSnapshot = await repo.getProject(projectId);

    assert.equal(recoveredSnapshot?.artworkVersions.length, 6);
    assert.equal(recoveredSnapshot?.project.status, "concepts_ready");

    // No duplicate concepts from the failed attempt.
    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 2); // one per approved version, not one per call
  });

  it("secrets never appear in the returned snapshot", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo, unavailableProvider());
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /sk-|Bearer|authorization/i);
  });
});
