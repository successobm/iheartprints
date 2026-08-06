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
import { MAX_GENERATION_ATTEMPTS } from "@/capabilities/shared/generation-retry-policy";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createGenerationWorkerCapability } from "./generation-worker-capability";
import { createGenerationSchedulerCapability } from "@/capabilities/worker-scheduler";

/**
 * Sprint 2H Part 2B: "two workers started simultaneously → exactly one
 * claims a job. No duplicate generation. No duplicate uploads. No
 * duplicate concepts." — verified against `LocalProjectRepository`
 * (`supabase-store.generation-jobs.test.ts` covers the Supabase repository
 * the same way, against a fake Postgrest client since this repo has no
 * live Supabase instance in CI).
 */
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

describe("Generation worker concurrency (Sprint 2H Part 2B)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-worker-concurrency-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  function buildWorker(repo: Awaited<ReturnType<typeof freshRepo>>) {
    const provider = new InstantProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    return createGenerationWorkerCapability(repo, provider, promptTranslation, assets);
  }

  async function approvedProject(repo: Awaited<ReturnType<typeof freshRepo>>, name: string) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, { productSummary: name });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  async function enqueueGeneration(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    projectId: string,
    versionId: string,
  ) {
    const provider = new InstantProvider();
    const capability = createConceptGenerationCapability(repo, provider.providerKey);
    await capability.generatePlaceholders(projectId, versionId);
  }

  it("two workers racing to claim a single job — exactly one runs it, exactly 3 concepts persisted (no duplicate generation, no duplicate concepts)", async () => {
    const repo = await freshRepo();
    const { projectId, version } = await approvedProject(repo, "Race single job");
    await enqueueGeneration(repo, projectId, version.id);

    // Two independent worker instances sharing the same repository —
    // exactly what "two workers started simultaneously" means in practice
    // (same persistence, different process/instance).
    const workerA = buildWorker(repo);
    const workerB = buildWorker(repo);

    const [resultA, resultB] = await Promise.all([
      workerA.processNextJob(),
      workerB.processNextJob(),
    ]);

    const claimedIds = [resultA.processedJobId, resultB.processedJobId].filter(
      (id): id is string => id !== null,
    );
    assert.equal(claimedIds.length, 1, "exactly one worker should have claimed the job");

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3, "exactly one batch of 3 concepts — no duplicates");
    assert.equal(snapshot?.project.status, "concepts_ready");
  });

  it("multiple workers draining multiple queued jobs across multiple projects — every job processed exactly once", async () => {
    const repo = await freshRepo();
    const projects = await Promise.all(
      ["Alpha", "Bravo", "Charlie", "Delta"].map((name) => approvedProject(repo, name)),
    );
    for (const { projectId, version } of projects) {
      await enqueueGeneration(repo, projectId, version.id);
    }

    const workerA = buildWorker(repo);
    const workerB = buildWorker(repo);

    // Each worker independently drains until it finds nothing left —
    // exactly how two long-running worker processes would behave, racing
    // on every claim.
    async function drain(worker: ReturnType<typeof buildWorker>): Promise<string[]> {
      const claimed: string[] = [];
      for (;;) {
        const { processedJobId } = await worker.processNextJob();
        if (!processedJobId) break;
        claimed.push(processedJobId);
      }
      return claimed;
    }

    const [claimedByA, claimedByB] = await Promise.all([drain(workerA), drain(workerB)]);
    const allClaimed = [...claimedByA, ...claimedByB];

    assert.equal(allClaimed.length, 4, "all four jobs were claimed exactly once, total");
    assert.equal(new Set(allClaimed).size, 4, "no job id claimed twice");

    for (const { projectId } of projects) {
      const snapshot = await repo.getProject(projectId);
      assert.equal(
        snapshot?.artworkVersions.length,
        3,
        `project ${projectId} should have exactly one batch of 3 concepts`,
      );
      assert.equal(snapshot?.project.status, "concepts_ready");
    }
  });

  it("worker restart: a fresh worker instance (simulating a new process) resumes exactly where a crashed one left off, with no duplicate concepts", async () => {
    const repo = await freshRepo();
    const { projectId, version } = await approvedProject(repo, "Restart mid-queue");
    await enqueueGeneration(repo, projectId, version.id);

    // Simulate the original worker claiming the job, then crashing before
    // doing any work — the crash itself is unobservable from outside the
    // process, so we simulate it the same way `recoverAbandonedJobs`
    // itself is exercised elsewhere in this codebase: the job is left
    // "running" with a stale heartbeat, and nothing else about it changed.
    // (No worker instance is even constructed for this "crashed" attempt —
    // the claim alone, via the repository directly, stands in for a
    // process that died before it could do anything with the job.)
    const claimed = await repo.claimNextQueuedJob();
    assert.ok(claimed, "expected a job to claim");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(claimed.id, { heartbeatAt: longAgo, startedAt: longAgo });

    // A brand-new worker instance — same repo, zero shared in-memory state
    // — is exactly what restarting the process (or a scheduled/standalone
    // deployment) looks like.
    const restartedWorker = buildWorker(repo);
    const { recoveredCount } = await restartedWorker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recoveredCount, 1);

    const { processedJobId } = await restartedWorker.processNextJob();
    assert.equal(processedJobId, claimed.id);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
  });

  it("retry budget: after MAX_GENERATION_ATTEMPTS worth of attempts, a job that keeps getting abandoned fails permanently instead of looping forever", async () => {
    const repo = await freshRepo();
    const { projectId, version } = await approvedProject(repo, "Crash loop");
    await enqueueGeneration(repo, projectId, version.id);
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    // Simulate the job having already been claimed-and-abandoned
    // `MAX_GENERATION_ATTEMPTS` times by a worker that kept crashing before
    // doing any work (not a provider failure — a process death every
    // time). The next claim is attempt number MAX_GENERATION_ATTEMPTS + 1.
    await repo.updateGenerationJob(job.id, {
      status: "recoverable",
      attempts: MAX_GENERATION_ATTEMPTS,
    });

    const worker = buildWorker(repo);
    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, job.id);

    const failedJob = await repo.getGenerationJob(job.id);
    assert.equal(failedJob?.status, "failed");
    assert.match(failedJob?.lastError ?? "", /maximum generation attempts/i);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 0, "no concepts were ever created");
    assert.equal(snapshot?.project.status, "failed");
    const lastMessage = snapshot?.messages[snapshot.messages.length - 1];
    assert.equal(lastMessage?.role, "assistant");

    // Nothing left to claim — the budget guard does not requeue itself.
    const secondAttempt = await worker.processNextJob();
    assert.equal(secondAttempt.processedJobId, null);
  });

  it("scheduler batch processing: caps a single run at maxJobsPerRun, and a later run finishes what was left over", async () => {
    const repo = await freshRepo();
    const projects = await Promise.all(
      ["One", "Two", "Three"].map((name) => approvedProject(repo, name)),
    );
    for (const { projectId, version } of projects) {
      await enqueueGeneration(repo, projectId, version.id);
    }

    const worker = buildWorker(repo);
    const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 2 });

    const first = await scheduler.runBatch();
    assert.equal(first.processedJobIds.length, 2);
    assert.equal(first.limitReached, true);

    const readyAfterFirst = await Promise.all(
      projects.map(({ projectId }) => repo.getProject(projectId)),
    );
    const readyCount = readyAfterFirst.filter(
      (snapshot) => snapshot?.project.status === "concepts_ready",
    ).length;
    assert.equal(readyCount, 2, "exactly two of the three projects finished in the first batch");

    const second = await scheduler.runBatch();
    assert.equal(second.processedJobIds.length, 1);
    assert.equal(second.limitReached, false);

    for (const { projectId } of projects) {
      const snapshot = await repo.getProject(projectId);
      assert.equal(snapshot?.artworkVersions.length, 3);
      assert.equal(snapshot?.project.status, "concepts_ready");
    }
  });
});
