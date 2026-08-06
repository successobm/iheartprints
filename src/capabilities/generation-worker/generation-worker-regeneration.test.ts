import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import {
  createInitialGenerationIntent,
  createPromptTranslationCapability,
  translateApprovedBrief,
} from "@/capabilities/prompt-translation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { GenerationPromptRequest } from "@/lib/domain/types";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createRevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { createGenerationWorkerCapability } from "./generation-worker-capability";
import { buildGenerationIntentForJob } from "./build-generation-intent";

class CapturingProvider implements ConceptGenerationProvider {
  readonly providerKey = "capturing";
  lastPrompt: GenerationPromptRequest | null = null;
  prompts: GenerationPromptRequest[] = [];

  async generate(request: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    this.lastPrompt = request.prompt;
    this.prompts.push(request.prompt);
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

describe("GenerationWorker — live regeneration pipeline (Sprint 2J Phase 3)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-regen-live-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  function buildPipeline(repo: Awaited<ReturnType<typeof freshRepo>>) {
    const provider = new CapturingProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, provider.providerKey);
    const revisionIntelligence = createRevisionIntelligenceCapability();
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      promptTranslation,
      assets,
      undefined,
      revisionIntelligence,
    );
    const designBrief = createDesignBriefCapability(repo);
    return { capability, worker, provider, designBrief, revisionIntelligence };
  }

  it("initial generation prompt is byte-for-byte equivalent to historical brief-only translation", async () => {
    const repo = await freshRepo();
    const { capability, worker, provider, designBrief } = buildPipeline(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
      designDescription: "A friendly bear",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      preferredColors: ["Gold"],
      designStyle: "Rustic",
      exclusions: "No skulls",
      additionalInstructions: "Keep it simple",
    });
    const version = await designBrief.approveWorkingBrief(created.project.id);
    await capability.generatePlaceholders(created.project.id, version.id);
    await worker.processNextJob();

    assert.ok(provider.lastPrompt);
    const expected = translateApprovedBrief(version.content);
    assert.equal(JSON.stringify(provider.lastPrompt), JSON.stringify(expected));
    assert.deepEqual(
      provider.lastPrompt,
      createPromptTranslationCapability().translate(
        createInitialGenerationIntent(version.content),
      ),
    );
  });

  it("regeneration path merges a RegenerationPlan into the prompt (notes include guidance)", async () => {
    const repo = await freshRepo();
    const { capability, worker, provider, designBrief } = buildPipeline(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
      designDescription: "A friendly bear",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      preferredColors: ["Gold"],
      designStyle: "Rustic",
      exclusions: "No skulls",
    });
    const v1 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.generatePlaceholders(created.project.id, v1.id);
    await worker.processNextJob();
    const initialPrompt = provider.lastPrompt;
    assert.ok(initialPrompt);

    // Customer revises style, re-approves, regenerates.
    await repo.updateBrief(created.project.id, { designStyle: "Modern bold" });
    const v2 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.regenerateAfterRevision(created.project.id, v2.id);
    await worker.processNextJob();

    assert.ok(provider.lastPrompt);
    assert.notEqual(
      JSON.stringify(provider.lastPrompt),
      JSON.stringify(initialPrompt),
      "regeneration prompt must differ from initial when the brief changed",
    );
    assert.equal(provider.lastPrompt.exclusions, "No skulls");
    assert.equal(provider.lastPrompt.requiredWording, "Camp Wildwood 2026");
    assert.equal(provider.lastPrompt.style, "Modern bold");
    assert.match(
      provider.lastPrompt.notes ?? "",
      /style/i,
      "regeneration guidance should mention the customer style revision",
    );
    assert.doesNotMatch(
      JSON.stringify(provider.lastPrompt),
      /masterpiece|8k|openai|photorealistic/i,
    );
  });

  it("buildGenerationIntentForJob: initial never attaches a regenerationPlan", async () => {
    const repo = await freshRepo();
    const { designBrief, revisionIntelligence } = buildPipeline(repo);
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, { productSummary: "Tees" });
    const version = await designBrief.approveWorkingBrief(created.project.id);
    const project = await repo.getProject(created.project.id);
    assert.ok(project);

    const intent = buildGenerationIntentForJob({
      job: {
        id: "job-1",
        projectId: created.project.id,
        designBriefVersionId: version.id,
        status: "running",
        kind: "initial",
        conceptCount: 3,
        providerKey: "capturing",
        idempotencyKey: "k",
        attempts: 1,
        lastError: null,
        startedAt: null,
        completedAt: null,
        heartbeatAt: null,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
      },
      approvedVersion: version,
      project,
      generationJobs: [],
      deps: { revisionIntelligence },
    });

    assert.equal(intent.regenerationPlan, null);
    assert.deepEqual(intent.approvedBrief, version.content);
  });

  it("buildGenerationIntentForJob: regeneration attaches a plan derived from timeline", async () => {
    const repo = await freshRepo();
    const { capability, worker, designBrief, revisionIntelligence } =
      buildPipeline(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
      designStyle: "Rustic",
      exactText: "Camp Wildwood",
      exclusions: "No weapons",
    });
    const v1 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.generatePlaceholders(created.project.id, v1.id);
    await worker.processNextJob();

    await repo.updateBrief(created.project.id, { designStyle: "Modern" });
    const v2 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.regenerateAfterRevision(created.project.id, v2.id);

    const jobs = await repo.listGenerationJobs(created.project.id);
    const regenJob = jobs.find((j) => j.kind === "regeneration");
    assert.ok(regenJob);
    const project = await repo.getProject(created.project.id);
    assert.ok(project);

    const intent = buildGenerationIntentForJob({
      job: regenJob,
      approvedVersion: v2,
      project,
      generationJobs: jobs,
      deps: { revisionIntelligence },
    });

    assert.ok(intent.regenerationPlan);
    assert.ok(
      intent.regenerationPlan.customerRequestedChanges.some(
        (c) => c.section === "style",
      ),
    );
    assert.ok(intent.regenerationPlan.avoid.some((c) => c.section === "exclusions"));
    assert.equal(intent.regenerationPlan.generationAttempt >= 2, true);
  });

  it("multiple regeneration cycles remain deterministic for identical project state", async () => {
    const repo = await freshRepo();
    const { capability, worker, designBrief, revisionIntelligence } =
      buildPipeline(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
      designStyle: "Rustic",
      exactText: "Camp",
      exclusions: "No skulls",
    });
    const v1 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.generatePlaceholders(created.project.id, v1.id);
    await worker.processNextJob();

    await repo.updateBrief(created.project.id, { preferredColors: ["Red"] });
    const v2 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.regenerateAfterRevision(created.project.id, v2.id);
    // Do not run worker yet — inspect intent twice before completion.
    const jobs = await repo.listGenerationJobs(created.project.id);
    const regenJob = jobs.find((j) => j.kind === "regeneration");
    assert.ok(regenJob);
    const project = await repo.getProject(created.project.id);
    assert.ok(project);

    const a = buildGenerationIntentForJob({
      job: regenJob,
      approvedVersion: v2,
      project,
      generationJobs: jobs,
      deps: { revisionIntelligence },
    });
    const b = buildGenerationIntentForJob({
      job: regenJob,
      approvedVersion: v2,
      project,
      generationJobs: jobs,
      deps: { revisionIntelligence },
    });
    assert.deepEqual(a, b);
    assert.deepEqual(a.regenerationPlan, b.regenerationPlan);

    // Drain so the shared store is clean for later tests.
    await worker.processNextJob();
  });

  it("never persists GenerationIntent / RegenerationPlan on the job or artwork", async () => {
    const repo = await freshRepo();
    const { capability, worker, designBrief } = buildPipeline(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
      designStyle: "Rustic",
    });
    const v1 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.generatePlaceholders(created.project.id, v1.id);
    await worker.processNextJob();

    await repo.updateBrief(created.project.id, { designStyle: "Modern" });
    const v2 = await designBrief.approveWorkingBrief(created.project.id);
    await capability.regenerateAfterRevision(created.project.id, v2.id);
    await worker.processNextJob();

    const jobs = await repo.listGenerationJobs(created.project.id);
    const project = await repo.getProject(created.project.id);
    assert.ok(project);
    const serialized = JSON.stringify({ jobs, project });
    assert.doesNotMatch(serialized, /regenerationPlan|GenerationIntent|priorityChanges/);
    assert.doesNotMatch(serialized, /RevisionTimeline|customer_revision/);
  });
});
