import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PNG } from "pngjs";

import type { ProjectRepository } from "@/lib/db/repository";
import type { AssetCapability, UploadConceptAssetInput } from "@/capabilities/assets";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";
import type {
  ArtworkFidelityProposalImageInput,
  ArtworkFidelityProposalProvider,
  ArtworkFidelityProposalResult,
} from "@/capabilities/artwork-fidelity-proposal";

import {
  createRasterReconstructionWorkerCapability,
  MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS,
} from "./raster-reconstruction-worker-capability";
import type { RasterReconstructionProvider } from "./raster-reconstruction-provider";
import type { RasterReconstructionRequest, RasterReconstructionResult } from "./contracts";

/**
 * Phase R5: proves the worker's PROVIDER, JOB, ASSET, and VERIFICATION
 * behavior end to end against a fake provider/fake asset capability (no
 * network — see `resolveRasterReconstructionProvider`'s own hard test-
 * safety rule for why the REAL OpenAI adapter is never reachable from any
 * test).
 */

const SHA_A = "a".repeat(64);

function onePixelPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function fakeAssets(): {
  assets: AssetCapability;
  uploaded: (UploadConceptAssetInput & { primaryId: string })[];
} {
  const uploaded: (UploadConceptAssetInput & { primaryId: string })[] = [];
  const sourceBytes = Buffer.from("source-bytes-for-hashing");
  const assets: AssetCapability = {
    async listAssets() {
      return [];
    },
    async registerAsset() {
      return null;
    },
    async uploadConceptImage(_designId, input) {
      const primaryId = `candidate-${uploaded.length + 1}`;
      uploaded.push({ ...input, primaryId });
      return {
        primary: {
          id: primaryId,
          projectId: _designId,
          kind: "generated_artwork",
          storageKey: null,
          contentType: input.contentType,
          isThumbnail: false,
          widthPx: input.widthPx,
          heightPx: input.heightPx,
          hasTransparency: input.hasTransparency,
          providerKey: input.providerKey,
          generationJobId: input.generationJobId,
          metadata: input.metadata,
          vectorAssetId: null,
          printAssetId: null,
          finalArtworkJobId: null,
          productionRole: null,
          createdAt: new Date().toISOString(),
        },
        thumbnail: null,
      };
    },
    async uploadProductionAsset() {
      throw new Error("not used in this test");
    },
    async uploadCustomerArtwork() {
      throw new Error("not used in this test");
    },
    async getSignedUrl() {
      return null;
    },
    async downloadAssetBytes() {
      return { bytes: sourceBytes, contentType: "image/png" };
    },
    async deleteAsset() {},
  };
  return { assets, uploaded };
}

function sourceSha256(): string {
  return createHash("sha256").update(Buffer.from("source-bytes-for-hashing")).digest("hex");
}

function fakeReconstructionProvider(
  impl: (request: RasterReconstructionRequest) => Promise<RasterReconstructionResult>,
): RasterReconstructionProvider {
  return { providerKey: "fake_raster_reconstruction", reconstruct: impl };
}

function fakeProposalProvider(
  result: ArtworkFidelityProposalResult,
): ArtworkFidelityProposalProvider {
  return {
    providerKey: "fake_artwork_fidelity_proposal",
    async propose(_input: ArtworkFidelityProposalImageInput) {
      return result;
    },
  };
}

describe("RasterReconstructionWorkerCapability", () => {
  // Fresh temp dir PER TEST (not once for the whole file): the local
  // store's job claim has no project scope
  // (`claimNextQueuedArtworkReconstructionJob` claims the globally oldest
  // queued/recoverable job), so a job left `"recoverable"` by one test
  // would otherwise be claimed by a LATER test's `processNextJob()` call
  // instead of that test's own job.
  let tempDir = "";
  let previousCwd = "";

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-reconstruction-worker-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildConfirmedJob() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const fidelity = createArtworkFidelityCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;

    const proposed = await fidelity.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: sourceSha256(),
    });
    const contract = await fidelity.confirmContract(projectId, proposed.id, {
      currentSourceSha256: sourceSha256(),
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });
    const job = await repo.createArtworkReconstructionJob(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: sourceSha256(),
      fidelityContractId: contract.id,
      contractKey: contract.contractKey!,
    });
    return { repo, projectId, contract, job };
  }

  it("provider success produces a candidate asset, marks the job completed with reviewStatus pending_review -- never accepted, never Print Ready", async () => {
    const { repo, job } = await buildConfirmedJob();
    const { assets, uploaded } = fakeAssets();
    const provider = fakeReconstructionProvider(async () => ({
      bytes: onePixelPng(),
      widthPx: 4,
      heightPx: 4,
      providerRequestId: "req-1",
      metadata: { model: "fake-model" },
    }));
    const proposal = fakeProposalProvider({
      wording: [{ text: "REGENCY", readability: "readable", confidence: "high", visibleEvidence: "" }],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: true,
    });
    const worker = createRasterReconstructionWorkerCapability(repo, assets, provider, proposal);

    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, job.id);

    const reloaded = await repo.getArtworkReconstructionJob(job.id);
    assert.equal(reloaded!.status, "completed");
    assert.equal(reloaded!.reviewStatus, "pending_review");
    assert.ok(reloaded!.candidateAssetId);
    assert.equal(reloaded!.wordingVerified, true);
    assert.equal(reloaded!.geometryStatus, "review_required"); // no source aspect ratio was recorded on this contract

    // ASSET: candidate lineage correct, never a production asset.
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].generationJobId, null);
    assert.equal((uploaded[0].metadata as Record<string, unknown>).reconstructionJobId, job.id);
    assert.equal(
      (uploaded[0].metadata as Record<string, unknown>).sourceAssetId,
      job.sourceAssetId,
    );
    assert.notEqual(uploaded[0].primaryId, job.sourceAssetId);
  });

  it("provider failure produces NO candidate and no accepted anything -- job becomes recoverable (attempts remain)", async () => {
    const { repo, job } = await buildConfirmedJob();
    const { assets } = fakeAssets();
    const provider = fakeReconstructionProvider(async () => {
      throw new Error("provider exploded");
    });
    const proposal = fakeProposalProvider({
      wording: [],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: false,
    });
    const worker = createRasterReconstructionWorkerCapability(repo, assets, provider, proposal);

    await worker.processNextJob();

    const reloaded = await repo.getArtworkReconstructionJob(job.id);
    assert.equal(reloaded!.candidateAssetId, null);
    assert.equal(reloaded!.reviewStatus, null);
    assert.ok(reloaded!.status === "recoverable" || reloaded!.status === "failed");
  });

  it("JOB: exceeding the attempt budget fails the job outright without another provider call", async () => {
    const { repo, job } = await buildConfirmedJob();
    await repo.updateArtworkReconstructionJob(job.id, {
      attempts: MAX_ARTWORK_RECONSTRUCTION_ATTEMPTS + 1,
    });
    const { assets } = fakeAssets();
    let calls = 0;
    const provider = fakeReconstructionProvider(async () => {
      calls += 1;
      throw new Error("should never be called");
    });
    const proposal = fakeProposalProvider({
      wording: [],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: false,
    });
    const worker = createRasterReconstructionWorkerCapability(repo, assets, provider, proposal);

    // Claim happens inside processNextJob and bumps attempts by one more,
    // so this simulates "already over budget after the claim increments it".
    await worker.processNextJob();

    assert.equal(calls, 0, "the provider must never be called once the attempt budget is exceeded");
    const reloaded = await repo.getArtworkReconstructionJob(job.id);
    assert.equal(reloaded!.status, "failed");
  });

  it("AUTHORITY: re-verifies the contract is still confirmed and current BEFORE calling the provider -- a superseded contract fails the job with no provider call", async () => {
    const { repo, projectId, contract, job } = await buildConfirmedJob();
    const fidelity = createArtworkFidelityCapability(repo);

    // Correct the contract AFTER the job was created -- the job's own
    // frozen contractKey is now stale.
    const proposedCorrection = await fidelity.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: sourceSha256(),
    });
    await fidelity.confirmContract(projectId, proposedCorrection.id, {
      currentSourceSha256: sourceSha256(),
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["®"], // corrected
      confirmedBy: "customer",
    });
    assert.notEqual(contract.contractKey, (await fidelity.getContract(projectId))!.contractKey);

    const { assets } = fakeAssets();
    let calls = 0;
    const provider = fakeReconstructionProvider(async () => {
      calls += 1;
      throw new Error("should never be called");
    });
    const proposal = fakeProposalProvider({
      wording: [],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: false,
    });
    const worker = createRasterReconstructionWorkerCapability(repo, assets, provider, proposal);

    await worker.processNextJob();

    assert.equal(calls, 0, "a stale contractKey must block before any provider call");
    const reloaded = await repo.getArtworkReconstructionJob(job.id);
    assert.equal(reloaded!.status, "failed");
    assert.equal(reloaded!.candidateAssetId, null);
  });

  it("recoverAbandonedJobs mirrors the FinalArtworkJob precedent -- a stale running job flips back to recoverable", async () => {
    const { repo, job } = await buildConfirmedJob();
    await repo.updateArtworkReconstructionJob(job.id, {
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const { assets } = fakeAssets();
    const provider = fakeReconstructionProvider(async () => {
      throw new Error("not used");
    });
    const proposal = fakeProposalProvider({
      wording: [],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: false,
    });
    const worker = createRasterReconstructionWorkerCapability(repo, assets, provider, proposal);

    const { recoveredCount } = await worker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recoveredCount, 1);
    const reloaded = await repo.getArtworkReconstructionJob(job.id);
    assert.equal(reloaded!.status, "recoverable");
  });
});
