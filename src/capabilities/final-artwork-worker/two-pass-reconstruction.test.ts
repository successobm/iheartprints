import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "@/capabilities/final-artwork/production-normalization";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderIntermediateReconstruction,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { ProviderError } from "@/capabilities/providers/provider-error";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import type { ProjectRepository } from "@/lib/db/repository";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Phase 28V — worker-level idempotency/crash-recovery proof for a controlled
 * two-pass Topaz reconstruction. The provider-level correctness of the
 * REAL two-pass algorithm (routing, geometry, normalization) is proven
 * directly against `TopazTransparencyUpscaleProvider` in
 * `topaz-transparency-upscale-provider.test.ts`; this file instead proves
 * what the WORKER does around it — the exact concern Section 7/8 of the
 * Phase 28V mission is about: crash recovery, self-healing the job's single
 * outstanding-request slot, and never resubmitting either pass on a retry.
 *
 * `FakeTwoPassProvider` deliberately always performs two passes regardless
 * of whether the fixture's own scale genuinely needs one — exactly like the
 * pre-existing `FakePortraitReconstructionProvider` (production-request-
 * identity.test.ts) always does a fixed 4x replicate rather than consulting
 * real sizing math. What these tests exercise is the WORKER's contract with
 * `existingIntermediateReconstruction`/`onIntermediateReconstructionProduced`,
 * not the provider's own routing decision.
 */
class FakeTwoPassProvider implements FinalArtworkProvider {
  readonly providerKey = "fake_two_pass_reconstruction";
  pass1SubmitCount = 0;
  pass2SubmitCount = 0;
  pass1ResumeCount = 0;
  pass2ResumeCount = 0;
  /** Test knob: simulate a crash right after pass 1 is durably persisted, before pass 2 is ever submitted. */
  crashBeforePass2Submit = false;
  /** Test knob: simulate a crash right after pass 2 is submitted, before it completes. */
  crashDuringPass2Poll = false;

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    const source = PNG.sync.read(input.sourceBytes);

    let pass1: RgbaImage;
    let pass1ProcessId: string;
    if (input.existingIntermediateReconstruction) {
      const png = PNG.sync.read(input.existingIntermediateReconstruction.bytes);
      pass1 = { width: png.width, height: png.height, data: png.data };
      pass1ProcessId = input.existingIntermediateReconstruction.providerRequestId;
    } else {
      const resumed = input.existingProviderRequest?.providerKey === this.providerKey;
      if (resumed) {
        this.pass1ResumeCount += 1;
        pass1ProcessId = input.existingProviderRequest!.providerRequestId;
      } else {
        this.pass1SubmitCount += 1;
        pass1ProcessId = `fake-pass1-${this.pass1SubmitCount}`;
        await input.onProviderRequestSubmitted?.(pass1ProcessId);
      }
      pass1 = replicateScaled(source, 4);
      const intermediate: FinalArtworkProviderIntermediateReconstruction = {
        bytes: encodeRgbaAsPng(pass1),
        widthPx: pass1.width,
        heightPx: pass1.height,
        providerRequestId: pass1ProcessId,
      };
      await input.onIntermediateReconstructionProduced?.(intermediate);

      if (this.crashBeforePass2Submit) {
        throw new ProviderError("network", "simulated crash: pass 1 persisted, pass 2 never submitted");
      }
    }

    // Only when pass 1 already durably existed (this attempt never
    // submitted it) can `existingProviderRequest` legitimately refer to
    // pass 2 — mirrors the real provider's own documented invariant.
    const pass2ExistingRequest =
      input.existingIntermediateReconstruction && input.existingProviderRequest?.providerKey === this.providerKey
        ? input.existingProviderRequest
        : null;

    let pass2ProcessId: string;
    if (pass2ExistingRequest) {
      this.pass2ResumeCount += 1;
      pass2ProcessId = pass2ExistingRequest.providerRequestId;
    } else {
      this.pass2SubmitCount += 1;
      pass2ProcessId = `fake-pass2-${this.pass2SubmitCount}`;
      await input.onProviderRequestSubmitted?.(pass2ProcessId);

      if (this.crashDuringPass2Poll) {
        throw new ProviderError("network", "simulated crash: pass 2 submitted, never completed");
      }
    }

    const pass2 = replicateScaled(pass1, 2);
    const normalized = normalizeProductionRaster(pass2, input.sizing);
    if (normalized.status !== "normalized") throw new Error(normalized.reason);
    const encoded = encodeProductionPng(normalized.result);

    return {
      bytes: encoded.bytes,
      contentType: "image/png",
      widthPx: normalized.result.image.width,
      heightPx: normalized.result.image.height,
      hasTransparency: encoded.hasTransparency,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      reconstructedWidthPx: pass2.width,
      reconstructedHeightPx: pass2.height,
      resolutionProvenance: "reconstructed",
      transformationMethod: "fake_two_pass_reconstruction_v1",
      preservesApprovedContent: false,
      providerRequestId: pass2ProcessId,
      normalization: normalized.result.metadata,
    };
  }
}

class CountingLocalProvider implements FinalArtworkProvider {
  readonly providerKey = "local_raster_interpolation";
  calls = 0;
  private readonly inner = new LocalRasterInterpolationProvider();
  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    this.calls += 1;
    return this.inner.produce(input);
  }
}

function replicateScaled(source: { width: number; height: number; data: Buffer | Uint8Array }, scale: number): RgbaImage {
  const width = source.width * scale;
  const height = source.height * scale;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = Math.floor(y / scale) * source.width;
    for (let x = 0; x < width; x += 1) {
      const from = (sourceRow + Math.floor(x / scale)) * 4;
      const to = (y * width + x) * 4;
      data[to] = source.data[from]!;
      data[to + 1] = source.data[from + 1]!;
      data[to + 2] = source.data[from + 2]!;
      data[to + 3] = source.data[from + 3]!;
    }
  }
  return { width, height, data };
}

function encodeRgbaAsPng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data).copy(png.data);
  return PNG.sync.write(png);
}

/** Portrait geometry — 500x750 visible artwork (2:3), same ratio family used across Phase 28S/28T/28T.1 fixtures. */
const PORTRAIT = { canvasWidthPx: 550, canvasHeightPx: 800, artworkWidthPx: 500, artworkHeightPx: 750 };

function drawPortrait(backgroundAlpha: number): Buffer {
  const { canvasWidthPx, canvasHeightPx, artworkWidthPx, artworkHeightPx } = PORTRAIT;
  const png = new PNG({ width: canvasWidthPx, height: canvasHeightPx });
  const insetX = Math.floor((canvasWidthPx - artworkWidthPx) / 2);
  const insetY = Math.floor((canvasHeightPx - artworkHeightPx) / 2);
  for (let y = 0; y < canvasHeightPx; y += 1) {
    for (let x = 0; x < canvasWidthPx; x += 1) {
      const idx = (canvasWidthPx * y + x) << 2;
      const inside = x >= insetX && x < insetX + artworkWidthPx && y >= insetY && y < insetY + artworkHeightPx;
      png.data[idx] = inside ? 30 : 0;
      png.data[idx + 1] = inside ? 60 : 0;
      png.data[idx + 2] = inside ? 90 : 0;
      png.data[idx + 3] = inside ? 255 : backgroundAlpha;
    }
  }
  return PNG.sync.write(png);
}

describe("Phase 28V — two-pass reconstruction, worker-level idempotency (integration)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-two-pass-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo(): Promise<ProjectRepository> {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  /** See `production-request-identity.test.ts`'s identical helper/reasoning. */
  async function retireQueuedJobs(repo: ProjectRepository): Promise<void> {
    for (;;) {
      const claimed = await repo.claimNextQueuedFinalArtworkJob();
      if (!claimed) return;
      await repo.updateFinalArtworkJob(claimed.id, {
        status: "cancelled",
        lastError: "Retired by test isolation.",
        completedAt: new Date().toISOString(),
      });
    }
  }

  function buildPipeline(repo: ProjectRepository, provider: FinalArtworkProvider) {
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      provider,
      createPrintValidationCapability(),
      undefined,
      new CountingLocalProvider(),
    );
    return { assets, finalArtwork, worker };
  }

  async function setupApprovedPortraitProject(
    repo: ProjectRepository,
    assets: ReturnType<typeof buildPipeline>["assets"],
  ) {
    await retireQueuedJobs(repo);
    const created = await repo.createProject();
    const projectId = created.project.id;
    await repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      shirtColor: "Black",
      printPlacement: "full_front",
      garmentSizeClass: "adult_standard",
    });

    const originalBytes = drawPortrait(255);
    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: originalBytes,
      contentType: "image/png",
      widthPx: PORTRAIT.canvasWidthPx,
      heightPx: PORTRAIT.canvasHeightPx,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: {},
    });

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "portrait.png",
      analysis: {
        artworkBounds: { width: PORTRAIT.artworkWidthPx, height: PORTRAIT.artworkHeightPx },
      },
    });

    const preparedBytes = drawPortrait(0);
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedBytes,
      contentType: "image/png",
      widthPx: PORTRAIT.canvasWidthPx,
      heightPx: PORTRAIT.canvasHeightPx,
      hasTransparency: true,
      kind: "png",
      metadata: {},
    });

    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: prepared.id,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);
    await repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedAssetId: prepared.id,
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "approved");

    return { projectId, preparationId: preparation.id, artworkVersionId: artwork!.id };
  }

  it("baseline: a genuine two-pass job completes via exactly two submissions, one intermediate asset, correct cost accounting", async () => {
    const repo = await freshRepo();
    const provider = new FakeTwoPassProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job!.status, "completed");
    assert.equal(provider.pass1SubmitCount, 1);
    assert.equal(provider.pass2SubmitCount, 1);

    const allAssets = await repo.listAssets(projectId);
    const productionAssets = allAssets.filter(
      (a) => a.finalArtworkJobId === job!.id && a.productionRole === "production_png",
    );
    const intermediates = productionAssets.filter(isReconstructionIntermediateAsset);
    const finals = productionAssets.filter((a) => !isReconstructionIntermediateAsset(a));
    assert.equal(intermediates.length, 1, "pass 1's output must be durably persisted, internally, exactly once");
    assert.equal(finals.length, 1, "exactly one customer-facing final deliverable");

    // N (structural half): `resolveProductionVariantState` surfaces the
    // FINAL asset (never the intermediate) as "the" deliverable, and
    // separately exposes pass 1's own provider request id for cost
    // accounting to combine with the final's — see
    // `production-variant.test.ts` for the accounting arithmetic itself
    // (this fake provider's key is deliberately not a registered PAID
    // provider, so asserting `externalProviderCalls` through it would prove
    // nothing about that arithmetic).
    const state = await finalArtwork.resolveProductionVariantState(projectId, "standard_raster");
    assert.ok(state.asset, "the current deliverable must be the FINAL asset, never the intermediate");
    assert.equal(state.asset!.id, finals[0]!.id);
    assert.equal(
      state.intermediateReconstructionProviderRequestId,
      (intermediates[0]!.metadata as Record<string, unknown>).providerRequestId,
      "pass 1's own request id must be discoverable for cost accounting",
    );
  });

  it("F: after full completion, a duplicate Create Print-Ready request makes zero additional provider calls of either pass", async () => {
    const repo = await freshRepo();
    const provider = new FakeTwoPassProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });

    const first = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();
    assert.equal(provider.pass1SubmitCount, 1);
    assert.equal(provider.pass2SubmitCount, 1);

    const second = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.alreadyRequested, true, "the exact same request must be recognized as already satisfied");

    // No job was requeued, so a worker pass has nothing to claim.
    const claimed = await repo.claimNextQueuedFinalArtworkJob();
    assert.equal(claimed, null, "no new job should ever have been queued");

    assert.equal(provider.pass1SubmitCount, 1, "duplicate request must never resubmit pass 1");
    assert.equal(provider.pass2SubmitCount, 1, "duplicate request must never resubmit pass 2");
  });

  it("O: a crash after pass 1 completes (before pass 2 is submitted) never re-spends pass 1's paid credit on retry", async () => {
    const repo = await freshRepo();
    const provider = new FakeTwoPassProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });

    provider.crashBeforePass2Submit = true;
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const afterCrash = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterCrash!.status, "failed", "an infrastructure failure, never a false print-readiness verdict");
    assert.equal(provider.pass1SubmitCount, 1);
    assert.equal(provider.pass2SubmitCount, 0);

    // The intermediate must already be durably persisted, even though the
    // job itself is not done.
    const allAssetsAfterCrash = await repo.listAssets(projectId);
    const intermediatesAfterCrash = allAssetsAfterCrash.filter(
      (a) => a.finalArtworkJobId === requested.job.id && isReconstructionIntermediateAsset(a),
    );
    assert.equal(intermediatesAfterCrash.length, 1);

    // Retry: revive the failed job and let a healthy provider finish it.
    provider.crashBeforePass2Submit = false;
    const retried = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(retried.job.id, requested.job.id);
    await worker.processNextJob();

    const afterRetry = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterRetry!.status, "completed");
    assert.equal(provider.pass1SubmitCount, 1, "pass 1 must NEVER be resubmitted across the crash/retry");
    assert.equal(provider.pass1ResumeCount, 0, "pass 1 was durably complete, not merely in-flight -- nothing to resume either");
    assert.equal(provider.pass2SubmitCount, 1, "pass 2 submitted exactly once, on the retry");

    const allAssetsAfterRetry = await repo.listAssets(projectId);
    const intermediatesAfterRetry = allAssetsAfterRetry.filter(
      (a) => a.finalArtworkJobId === requested.job.id && isReconstructionIntermediateAsset(a),
    );
    assert.equal(intermediatesAfterRetry.length, 1, "still exactly one intermediate -- never duplicated");
  });

  it("P: a crash after pass 2 is submitted (before it completes) resumes pass 2 on retry, never resubmitting either pass", async () => {
    const repo = await freshRepo();
    const provider = new FakeTwoPassProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });

    provider.crashDuringPass2Poll = true;
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const afterCrash = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterCrash!.status, "failed");
    assert.equal(provider.pass1SubmitCount, 1);
    assert.equal(provider.pass2SubmitCount, 1);
    // The job's single outstanding-request slot must now hold PASS 2's
    // identity, not pass 1's (pass 1's was already retired when its
    // intermediate was persisted).
    assert.equal(afterCrash!.providerKey, provider.providerKey);
    assert.equal(afterCrash!.providerRequestId, "fake-pass2-1");

    provider.crashDuringPass2Poll = false;
    const retried = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(retried.job.id, requested.job.id);
    await worker.processNextJob();

    const afterRetry = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterRetry!.status, "completed");
    assert.equal(provider.pass1SubmitCount, 1, "pass 1 must never be resubmitted");
    assert.equal(provider.pass2SubmitCount, 1, "pass 2 must never be resubmitted -- resumed instead");
    assert.equal(provider.pass2ResumeCount, 1, "pass 2's in-flight request must be resumed on retry");
  });
});
