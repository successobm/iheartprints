import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import {
  PlaceholderConceptProvider,
  resolveConceptGenerationProvider,
} from "@/capabilities/providers";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import { createConceptGenerationCapability } from "./concept-generation-capability";

/** A tiny, genuinely decodable PNG — real enough for the thumbnail pipeline to actually resize it. */
function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

/**
 * Sprint 2H Part 1: a fully controllable fake provider — real enough to
 * exercise the generation pipeline (job lifecycle, retries, asset
 * persistence) without ever making a network call, while still behaving
 * exactly like `ConceptGenerationProvider` requires.
 */
class ScriptedProvider implements ConceptGenerationProvider {
  readonly providerKey = "scripted";
  calls: ConceptGenerationRequest[] = [];
  private readonly script: Array<
    "succeed_with_assets" | "succeed_without_assets" | "fail"
  >;
  private callIndex = 0;

  constructor(
    script: Array<"succeed_with_assets" | "succeed_without_assets" | "fail">,
  ) {
    this.script = script;
  }

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.calls.push(request);
    const outcome = this.script[Math.min(this.callIndex, this.script.length - 1)];
    this.callIndex += 1;

    if (outcome === "fail") {
      throw new Error("scripted provider failure");
    }

    const withAssets = outcome === "succeed_with_assets";
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: `Scripted concept ${index + 1} for ${request.prompt.subject}.`,
        placeholderLabel: `Concept ${String.fromCharCode(65 + index)}`,
        accentColor: "#123456",
        kind: "concept" as const,
        ...(withAssets
          ? {
              asset: {
                imageBytes: tinyPng(),
                contentType: "image/png",
                widthPx: 4,
                heightPx: 4,
                hasTransparency: true,
                providerMetadata: { generatedAt: "2026-08-05T00:00:00.000Z" },
              },
            }
          : {}),
      })),
    };
  }
}

describe("ConceptGenerationCapability — real generation pipeline (Sprint 2H Part 2A: background jobs)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-generation-"));
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

  it("enqueues fast — no provider call until the worker runs — then completes in the background", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["succeed_with_assets"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    const enqueued = await capability.generatePlaceholders(projectId, version.id);
    assert.equal(enqueued.project.status, "generating");
    assert.equal(enqueued.artworkVersions.length, 0);
    assert.equal(provider.calls.length, 0, "the provider must not be called synchronously");

    const { processedJobId } = await worker.processNextJob();
    assert.ok(processedJobId);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "completed");
    assert.equal(jobs[0]?.attempts, 1);
    assert.equal(jobs[0]?.providerKey, "scripted");
    assert.equal(jobs[0]?.kind, "initial");
    assert.ok(jobs[0]?.startedAt);
    assert.ok(jobs[0]?.completedAt);

    for (const artwork of snapshot?.artworkVersions ?? []) {
      assert.equal(artwork.generationJobId, jobs[0]?.id);
      assert.equal(artwork.providerKey, "scripted");
      assert.ok(artwork.primaryAssetId);
      assert.ok(artwork.thumbnailAssetId);
    }
  });

  it("registers real, retrievable asset records linked back to the concept and job", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["succeed_with_assets"]);
    const { capability, worker, assets } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);
    const allAssets = await assets.listAssets(projectId);

    // Primary + thumbnail per concept.
    assert.equal(allAssets.length, (snapshot?.artworkVersions.length ?? 0) * 2);

    const first = snapshot!.artworkVersions[0]!;
    const primary = allAssets.find((asset) => asset.id === first.primaryAssetId);
    const thumbnail = allAssets.find((asset) => asset.id === first.thumbnailAssetId);
    assert.ok(primary);
    assert.equal(primary?.isThumbnail, false);
    assert.equal(primary?.providerKey, "scripted");
    assert.equal(primary?.generationJobId, first.generationJobId);
    assert.ok(thumbnail);
    assert.equal(thumbnail?.isThumbnail, true);
  });

  it("the placeholder provider still produces concepts with no asset records (backward compatible)", async () => {
    const repo = await freshRepo();
    const provider = new PlaceholderConceptProvider();
    const { capability, worker, assets } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(snapshot?.artworkVersions.length, 3);
    for (const artwork of snapshot?.artworkVersions ?? []) {
      assert.equal(artwork.primaryAssetId, null);
      assert.equal(artwork.thumbnailAssetId, null);
      assert.equal(artwork.providerKey, "placeholder");
    }
    assert.deepEqual(await assets.listAssets(projectId), []);
  });

  it("is idempotent: calling generatePlaceholders again after completion never re-enqueues or re-runs the provider", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["succeed_without_assets"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const second = await capability.generatePlaceholders(projectId, version.id);
    const { processedJobId } = await worker.processNextJob();

    assert.equal(second.artworkVersions.length, 3);
    assert.equal(provider.calls.length, 1); // provider was never called a second time
    assert.equal(processedJobId, null); // nothing left queued
    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
  });

  it("resumes a failed job on the next enqueue instead of starting a duplicate one (job resume)", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["fail", "succeed_without_assets"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    let jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed");
    assert.equal(jobs[0]?.attempts, 1);
    const afterFirstFailure = await repo.getProject(projectId);
    assert.equal(afterFirstFailure?.artworkVersions.length, 0);
    assert.equal(afterFirstFailure?.project.status, "failed");

    // A later retry (a new approve/regenerate action, or a button press)
    // re-enqueues the SAME job — never a new one.
    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const secondAttempt = await repo.getProject(projectId);
    assert.equal(secondAttempt?.artworkVersions.length, 3);
    assert.equal(secondAttempt?.project.status, "concepts_ready");

    jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1); // still the same job — resumed, not duplicated
    assert.equal(jobs[0]?.status, "completed");
    assert.equal(jobs[0]?.attempts, 2);
  });

  it("gives up after exhausting the retry budget without ever creating partial concepts", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["fail", "fail", "fail", "fail"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    for (let i = 0; i < 3; i += 1) {
      await capability.generatePlaceholders(projectId, version.id);
      await worker.processNextJob();
    }

    let jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs[0]?.attempts, 3);
    assert.equal(jobs[0]?.status, "failed");

    // A fourth enqueue attempt gives up without re-queuing or calling the
    // provider a fourth time.
    const fourthEnqueue = await capability.generatePlaceholders(projectId, version.id);
    assert.equal(fourthEnqueue.artworkVersions.length, 0);
    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, null);
    assert.equal(provider.calls.length, 3);

    jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs[0]?.attempts, 3);
  });

  it("regeneration after a revision continues version numbering and never deletes prior concepts", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider([
      "succeed_without_assets",
      "succeed_without_assets",
    ]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version: v1 } = await approvedProject(repo);
    await capability.generatePlaceholders(projectId, v1.id);
    await worker.processNextJob();

    await repo.updateBrief(projectId, { shirtColor: "Black" });
    const designBrief = createDesignBriefCapability(repo);
    const v2 = await designBrief.approveWorkingBrief(projectId);

    await capability.regenerateAfterRevision(projectId, v2.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(snapshot?.artworkVersions.length, 6);
    const versionNumbers = snapshot!.artworkVersions
      .map((a) => a.versionNumber)
      .sort((a, b) => a - b);
    assert.deepEqual(versionNumbers, [1, 2, 3, 4, 5, 6]);

    const firstBatch = snapshot!.artworkVersions.filter(
      (a) => a.designBriefVersionId === v1.id,
    );
    const secondBatch = snapshot!.artworkVersions.filter(
      (a) => a.designBriefVersionId === v2.id,
    );
    assert.equal(firstBatch.length, 3);
    assert.equal(secondBatch.length, 3);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1]?.kind, "regeneration");
  });

  it("a failed regeneration keeps the existing concepts available instead of wiping them out", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["succeed_without_assets", "fail"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version: v1 } = await approvedProject(repo);
    await capability.generatePlaceholders(projectId, v1.id);
    await worker.processNextJob();

    await repo.updateBrief(projectId, { shirtColor: "Black" });
    const designBrief = createDesignBriefCapability(repo);
    const v2 = await designBrief.approveWorkingBrief(projectId);

    await capability.regenerateAfterRevision(projectId, v2.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(snapshot?.artworkVersions.length, 3); // original batch intact
    assert.equal(snapshot?.project.status, "concepts_ready"); // not "failed" — customer keeps what they had
  });

  it("never mentions the provider name, a job id, or an asset id in any customer-facing message", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["succeed_with_assets"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);
    const jobs = await repo.listGenerationJobs(projectId);
    const job = jobs[0]!;

    for (const message of snapshot?.messages ?? []) {
      assert.doesNotMatch(message.content, /scripted|openai|placeholder/i);
      assert.doesNotMatch(message.content, new RegExp(job.id));
      for (const artwork of snapshot?.artworkVersions ?? []) {
        if (artwork.primaryAssetId) {
          assert.doesNotMatch(message.content, new RegExp(artwork.primaryAssetId));
        }
      }
    }
  });

  it("translates the approved brief — not the live working brief — into the generation prompt", async () => {
    const repo = await freshRepo();
    const provider = new ScriptedProvider(["succeed_without_assets"]);
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    // Diverge the working brief *after* approval but before generation runs.
    await repo.updateBrief(projectId, { shirtColor: "Hot Pink" });

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.prompt.productColor, "Navy");
  });

  describe("Sprint 2H Part 1A: development-fallback configuration still generates real concepts", () => {
    for (const environment of ["development", "test", undefined]) {
      it(`succeeds using the placeholder provider when openai was requested without a key (NODE_ENV=${environment})`, async () => {
        const originalWarn = console.warn;
        const originalNodeEnv = process.env.NODE_ENV;
        const warnCalls: unknown[][] = [];
        console.warn = (...args: unknown[]) => {
          warnCalls.push(args);
        };
        if (environment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = environment;

        try {
          const provider = resolveConceptGenerationProvider({
            mode: "placeholder",
            reason: "development_fallback",
          });
          assert.equal(provider.providerKey, "placeholder");
          assert.equal(warnCalls.length, 1);

          const repo = await freshRepo();
          const { capability, worker } = buildPipeline(repo, provider);
          const { projectId, version } = await approvedProject(repo);
          await capability.generatePlaceholders(projectId, version.id);
          await worker.processNextJob();
          const snapshot = await repo.getProject(projectId);

          assert.equal(snapshot?.artworkVersions.length, 3);
          assert.equal(snapshot?.project.status, "concepts_ready");
        } finally {
          console.warn = originalWarn;
          if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = originalNodeEnv;
        }
      });
    }
  });
});
