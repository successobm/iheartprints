import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import { ProviderError } from "@/capabilities/providers";
import { createRevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";

import { createGenerationWorkerCapability } from "./generation-worker-capability";

/**
 * True Source-Image Targeted Revision — end-to-end through the worker.
 *
 * These prove the whole point of the change: the ACTUAL bytes of the
 * concept the customer selected reach the provider boundary, and a
 * targeted revision that cannot get them FAILS instead of quietly
 * becoming a fresh text-to-image generation.
 *
 * No network: the provider is a local double (Section 10).
 */

/** A provider that behaves like a real image adapter: it declares that a
 *  targeted revision is a real edit, and it produces real bytes. */
class EditCapableProvider implements ConceptGenerationProvider {
  readonly providerKey = "edit-capable";
  readonly editsSourceArtwork = true;
  readonly requests: ConceptGenerationRequest[] = [];
  failWith: Error | null = null;
  /** When false, concepts come back with no asset (no image bytes at all). */
  producesAssets = true;

  async generate(request: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;

    const isRevision = Boolean(request.prompt.targetConceptDirectionKey);
    const directions = ["bold_direct", "soft_illustrated", "minimal_badge"] as const;
    const count = isRevision ? 1 : request.conceptCount;

    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: count }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: "summary",
        placeholderLabel: `Concept ${index + 1}`,
        accentColor: "#000000",
        kind: (isRevision ? "revision" : "concept") as "concept" | "revision",
        directionKey: isRevision
          ? request.prompt.targetConceptDirectionKey!
          : directions[index]!,
        ...(this.producesAssets
          ? {
              asset: {
                imageBytes: Buffer.from(
                  isRevision ? "revised-artwork-bytes" : `concept-${index}-bytes`,
                ),
                contentType: "image/png",
                widthPx: 1024,
                heightPx: 1024,
                hasTransparency: true,
                providerMetadata: {},
              },
            }
          : {}),
      })),
    };
  }
}

describe("GenerationWorker — true source-image targeted revision", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-source-revision-"));
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
    provider = new EditCapableProvider(),
  ) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      createPromptTranslationCapability(),
      assets,
      undefined,
      createRevisionIntelligenceCapability(),
    );
    return {
      provider,
      worker,
      assets,
      conceptGeneration: createConceptGenerationCapability(repo, provider.providerKey),
      designBrief: createDesignBriefCapability(repo),
    };
  }

  /** Approved brief → three concepts with real image bytes → one selected. */
  async function withSelectedConcept(provider = new EditCapableProvider()) {
    const repo = await freshRepo();
    const pipeline = buildPipeline(repo, provider);

    const created = await repo.createProject();
    const designId = created.project.id;
    await repo.updateBrief(designId, {
      productSummary: "a crewneck t-shirt",
      designDescription: "a vintage sports car badge",
      exactText: "1988 TOYOTA MR2",
      shirtColor: "Black",
      preferredColors: ["Red"],
      designStyle: "retro badge",
    });

    const firstVersion = await pipeline.designBrief.approveWorkingBrief(designId);
    await pipeline.conceptGeneration.generatePlaceholders(designId, firstVersion.id);
    await pipeline.worker.processNextJob();

    const afterInitial = (await repo.getProject(designId))!;
    assert.equal(afterInitial.artworkVersions.length, 3);

    const selected = afterInitial.artworkVersions[2]!;
    await repo.updateProject(designId, { selectedArtworkVersionId: selected.id });

    return { repo, designId, selected, ...pipeline };
  }

  async function enqueueRevision(
    ctx: Awaited<ReturnType<typeof withSelectedConcept>>,
    instruction: string | null,
    targetArtworkVersionId = ctx.selected.id,
  ) {
    await ctx.repo.updateBrief(ctx.designId, {
      designDescription: "a vintage sports car badge with a red shield border",
    });
    const version = await ctx.designBrief.approveWorkingBrief(ctx.designId);
    await ctx.conceptGeneration.reviseSelectedConcept(
      ctx.designId,
      version.id,
      targetArtworkVersionId,
      instruction,
    );
    return version;
  }

  it("sends the EXACT bytes of the exact selected concept across the provider boundary", async () => {
    const ctx = await withSelectedConcept();
    // The real pixels currently stored for the selected concept.
    const stored = await ctx.assets.downloadAssetBytes(ctx.selected.primaryAssetId!);
    assert.ok(stored);

    await enqueueRevision(ctx, "make the border red and change it to a shield");
    await ctx.worker.processNextJob();

    const revisionRequest = ctx.provider.requests.at(-1)!;
    assert.ok(revisionRequest.sourceArtwork, "source artwork must reach the provider");
    assert.equal(
      revisionRequest.sourceArtwork!.sourceArtworkVersionId,
      ctx.selected.id,
    );
    assert.deepEqual(revisionRequest.sourceArtwork!.imageBytes, stored!.bytes);
    assert.equal(revisionRequest.sourceArtwork!.contentType, "image/png");
  });

  it("delivers the customer's delta as discrete requested changes, with the wording locked", async () => {
    const ctx = await withSelectedConcept();
    await enqueueRevision(ctx, "make the border red and change it to a shield");
    await ctx.worker.processNextJob();

    const { prompt } = ctx.provider.requests.at(-1)!;
    assert.deepEqual(prompt.revision!.requestedChanges, [
      "make the border red",
      "change it to a shield",
    ]);
    assert.equal(prompt.revision!.wordingChangeRequested, false);
    assert.equal(prompt.revision!.lockedWording, "1988 TOYOTA MR2");
    assert.equal(prompt.targetConceptDirectionKey, ctx.selected.conceptDirectionKey);
  });

  it("produces ONE revised concept with intact lineage, keeping every original", async () => {
    const ctx = await withSelectedConcept();
    await enqueueRevision(ctx, "make the car larger");
    await ctx.worker.processNextJob();

    const after = (await ctx.repo.getProject(ctx.designId))!;
    assert.equal(after.artworkVersions.length, 4, "exactly one new concept");

    const revised = after.artworkVersions.at(-1)!;
    assert.equal(revised.kind, "revision");
    assert.equal(revised.sourceArtworkVersionId, ctx.selected.id);
    assert.equal(revised.conceptDirectionKey, ctx.selected.conceptDirectionKey);

    // The originals are all still there and untouched.
    for (const original of after.artworkVersions.slice(0, 3)) {
      assert.equal(original.kind, "concept");
      assert.equal(original.sourceArtworkVersionId, null);
    }

    // Revision lifecycle semantics are unchanged by this work.
    assert.equal(after.project.revisionPending, false);
    assert.equal(after.project.finalDirectionConfirmed, false);
    assert.equal(after.project.selectedArtworkVersionId, revised.id);
  });

  it("persists the customer's literal instruction on the job, so a resumed job keeps the delta", async () => {
    const ctx = await withSelectedConcept();
    await enqueueRevision(ctx, "make the border red and change it to a shield");

    const jobs = await ctx.repo.listGenerationJobs(ctx.designId);
    const revisionJob = jobs.find((job) => job.targetArtworkVersionId === ctx.selected.id);
    assert.equal(
      revisionJob?.revisionInstruction,
      "make the border red and change it to a shield",
    );
  });
});

describe("GenerationWorker — a targeted revision never falls back to text-to-image", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-revision-failure-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  async function setup(provider: EditCapableProvider) {
    const repo = await freshRepo();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      createPromptTranslationCapability(),
      assets,
      undefined,
      createRevisionIntelligenceCapability(),
    );
    const conceptGeneration = createConceptGenerationCapability(repo, provider.providerKey);
    const designBrief = createDesignBriefCapability(repo);

    const created = await repo.createProject();
    const designId = created.project.id;
    await repo.updateBrief(designId, {
      productSummary: "a crewneck t-shirt",
      designDescription: "a vintage sports car badge",
      exactText: "1988 TOYOTA MR2",
      preferredColors: ["Red"],
    });
    const firstVersion = await designBrief.approveWorkingBrief(designId);
    await conceptGeneration.generatePlaceholders(designId, firstVersion.id);
    await worker.processNextJob();

    const afterInitial = (await repo.getProject(designId))!;
    const selected = afterInitial.artworkVersions[2]!;
    await repo.updateProject(designId, {
      selectedArtworkVersionId: selected.id,
      revisionPending: true,
    });

    return { repo, designId, selected, worker, provider, conceptGeneration, designBrief };
  }

  async function requestRevision(
    ctx: Awaited<ReturnType<typeof setup>>,
    targetArtworkVersionId: string,
  ) {
    await ctx.repo.updateBrief(ctx.designId, {
      designDescription: "a vintage sports car badge with a red shield border",
    });
    const version = await ctx.designBrief.approveWorkingBrief(ctx.designId);
    await ctx.conceptGeneration.reviseSelectedConcept(
      ctx.designId,
      version.id,
      targetArtworkVersionId,
      "change it to a shield",
    );
  }

  it("fails the job when the source ArtworkVersion no longer exists — and never calls the provider", async () => {
    const provider = new EditCapableProvider();
    const ctx = await setup(provider);
    const callsBefore = provider.requests.length;

    await requestRevision(ctx, "artwork-that-does-not-exist");
    await ctx.worker.processNextJob();

    assert.equal(provider.requests.length, callsBefore, "no generation was attempted");

    const after = (await ctx.repo.getProject(ctx.designId))!;
    assert.equal(after.artworkVersions.length, 3, "no fake revised concept was created");
    assert.equal(after.project.revisionPending, true, "the revision genuinely has not happened");

    const jobs = await ctx.repo.listGenerationJobs(ctx.designId);
    const failed = jobs.find((job) => job.status === "failed");
    assert.match(failed!.lastError!, /TARGETED_REVISION_SOURCE:source_artwork_missing/);
  });

  it("fails the job when the source concept has no stored image asset", async () => {
    // This provider produced concepts with no image bytes at all.
    const provider = new EditCapableProvider();
    provider.producesAssets = false;
    const ctx = await setup(provider);
    const callsBefore = provider.requests.length;

    await requestRevision(ctx, ctx.selected.id);
    await ctx.worker.processNextJob();

    assert.equal(provider.requests.length, callsBefore);
    const after = (await ctx.repo.getProject(ctx.designId))!;
    assert.equal(after.artworkVersions.length, 3);
    assert.equal(after.project.revisionPending, true);

    const jobs = await ctx.repo.listGenerationJobs(ctx.designId);
    const failed = jobs.find((job) => job.status === "failed");
    assert.match(failed!.lastError!, /TARGETED_REVISION_SOURCE:source_asset_missing/);
  });

  it("a provider edit failure never produces a fake success", async () => {
    const provider = new EditCapableProvider();
    const ctx = await setup(provider);

    await requestRevision(ctx, ctx.selected.id);
    provider.failWith = new ProviderError(
      "malformed_response",
      "The artwork provider returned an unexpected status (400).",
    );
    await ctx.worker.processNextJob();

    const after = (await ctx.repo.getProject(ctx.designId))!;
    assert.equal(after.artworkVersions.length, 3, "no concept was invented");
    assert.equal(after.project.revisionPending, true);
    assert.equal(after.project.finalDirectionConfirmed, false);
    // The customer keeps the concept they already had.
    assert.equal(after.project.selectedArtworkVersionId, ctx.selected.id);

    const jobs = await ctx.repo.listGenerationJobs(ctx.designId);
    assert.ok(jobs.some((job) => job.status === "failed"));
  });
});

describe("GenerationWorker — initial generation is unchanged", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-initial-unchanged-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("never resolves or requires a source image, and still produces three concepts", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const provider = new EditCapableProvider();
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      createPromptTranslationCapability(),
      createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator()),
      undefined,
      createRevisionIntelligenceCapability(),
    );
    const conceptGeneration = createConceptGenerationCapability(repo, provider.providerKey);
    const designBrief = createDesignBriefCapability(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "a crewneck t-shirt",
      designDescription: "a friendly bear mascot",
    });
    const version = await designBrief.approveWorkingBrief(created.project.id);
    await conceptGeneration.generatePlaceholders(created.project.id, version.id);
    await worker.processNextJob();

    const request = provider.requests.at(-1)!;
    assert.equal(request.sourceArtwork ?? null, null);
    assert.equal(request.prompt.revision ?? null, null);
    assert.equal(request.prompt.targetConceptDirectionKey ?? null, null);
    assert.equal(request.conceptCount, 3);

    const after = (await repo.getProject(created.project.id))!;
    assert.equal(after.artworkVersions.length, 3);
  });
});
