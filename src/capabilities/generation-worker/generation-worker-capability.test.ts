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
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createGenerationWorkerCapability } from "./generation-worker-capability";

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

describe("GenerationWorkerCapability (Sprint 2H Part 2A)", () => {
  // Sprint 2H Part 2A: one temp dir for the whole file (the pattern every
  // other test file in this repo uses) — `@/lib/db/local-store`'s data
  // file path is a module-level constant computed from `process.cwd()` the
  // first time it's imported, so re-`import()`ing it after a later
  // `process.chdir()` does NOT move it (ES module evaluation is cached).
  // `claimNextQueuedJob` is deliberately GLOBAL across projects (a real
  // worker services every project), so — since every test in this file
  // necessarily shares one store — each test below fully drains any job it
  // creates rather than leaving one queued for a sibling test to claim.
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-worker-"));
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
    const provider = new InstantProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, provider.providerKey);
    const worker = createGenerationWorkerCapability(repo, provider, promptTranslation, assets);
    return { capability, worker };
  }

  async function approvedProject(repo: Awaited<ReturnType<typeof freshRepo>>, name: string) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, { productSummary: name });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  it("processNextJob returns processedJobId: null when nothing is queued", async () => {
    const repo = await freshRepo();
    const { worker } = buildPipeline(repo);
    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, null);
  });

  it("claims the oldest queued job first, across different projects, and drains both", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);

    const first = await approvedProject(repo, "First project");
    await capability.generatePlaceholders(first.projectId, first.version.id);
    const [firstJob] = await repo.listGenerationJobs(first.projectId);

    const second = await approvedProject(repo, "Second project");
    await capability.generatePlaceholders(second.projectId, second.version.id);

    const claimedFirst = await worker.processNextJob();
    assert.equal(
      claimedFirst.processedJobId,
      firstJob?.id,
      "the first-enqueued job across all projects is claimed first",
    );

    // Drain the second project's job too — this test must not leave
    // anything queued for a later test sharing the same store.
    const claimedSecond = await worker.processNextJob();
    assert.ok(claimedSecond.processedJobId);
    assert.notEqual(claimedSecond.processedJobId, firstJob?.id);
  });

  it("recoverAbandonedJobs flips a stale 'running' job to 'recoverable' and processNextJob can then claim it", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo, "Camp t-shirts");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    // Simulate a worker that claimed the job, then died before finishing —
    // no heartbeat since, and it's well past any reasonable staleness window.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(job.id, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });

    const { recoveredCount } = await worker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recoveredCount, 1);

    const [recovered] = await repo.listGenerationJobs(projectId);
    assert.equal(recovered?.status, "recoverable");

    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, job.id);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
  });

  it("does not recover a 'running' job whose heartbeat is still fresh", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo, "Camp t-shirts");

    await capability.generatePlaceholders(projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    await repo.updateGenerationJob(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });

    const { recoveredCount } = await worker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recoveredCount, 0);

    const [stillRunning] = await repo.listGenerationJobs(projectId);
    assert.equal(stillRunning?.status, "running");

    // Drain it normally so nothing lingers for a later test.
    await repo.updateGenerationJob(job.id, { status: "queued" });
    await worker.processNextJob();
  });

  it("recovery never duplicates concepts even if the original attempt actually completed just before recovery ran", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo, "Camp t-shirts");

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob(); // completes normally

    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "completed");

    // Even if something re-marked it running with a stale heartbeat (e.g. a
    // race with a second worker), recovering and reprocessing must not
    // duplicate the already-persisted concepts.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(job!.id, { status: "running", heartbeatAt: longAgo });
    await worker.recoverAbandonedJobs(15 * 60 * 1000);
    await worker.processNextJob();

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
  });

  it("sets startedAt/heartbeatAt/completedAt across a full run", async () => {
    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo);
    const { projectId, version } = await approvedProject(repo, "Camp t-shirts");

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job?.startedAt);
    assert.ok(job?.heartbeatAt);
    assert.ok(job?.completedAt);
    assert.ok(new Date(job!.completedAt!).getTime() >= new Date(job!.startedAt!).getTime());
  });
});
