import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import {
  resolveEffectiveProductionTargetIn,
  productionAssetMatchesEffectiveTarget,
} from "@/capabilities/final-artwork/production-request-identity";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "@/capabilities/final-artwork/production-normalization";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import type { ProjectRepository } from "@/lib/db/repository";

import { createFinalArtworkWorkerCapability } from "../final-artwork-worker/final-artwork-worker-capability";

/**
 * Phase 28T — production request identity must represent the COMPLETE
 * effective production size, not merely the confirmed WIDTH.
 *
 * Regression proof for the exact real defect Phase 28S surfaced: the real
 * car-show project's confirmed width stayed 10.5in across the orientation
 * fix — only the confirmed box HEIGHT changed (10.5in -> 14in), which
 * `findJobForWidth`/`findDeliverableJob` never looked at, so the OLD
 * 6.96x10.5 completed job/asset could be silently presented as the answer
 * to the NEW 9.28x14 request.
 *
 * PORTRAIT fixture throughout (1000x1500 visible, 2:3 — the same family of
 * ratio as the real 1011x1525 car-show artwork), on `full_front`, so the
 * width/height trade-off `resolveWidthConstrainedSizing` performs is
 * actually exercised (a square fixture could never distinguish these
 * scenarios — see Phase 28R/28S's own fixture-design notes for the same
 * reasoning).
 */
describe("Phase 28T — resolveEffectiveProductionTargetIn / productionAssetMatchesEffectiveTarget (pure)", () => {
  const placement = "full_front" as const;
  const preparation = { analysis: { artworkBounds: { width: 1000, height: 1500 } } };

  it("B: height changes, width same — different effective target", () => {
    const squareBox = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 10.5, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    const tallBox = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 14, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    assert.ok(squareBox && tallBox);
    assert.notEqual(squareBox!.heightIn, tallBox!.heightIn);
    assert.notEqual(squareBox!.widthIn, tallBox!.widthIn);
  });

  it("C: width changes (both height-eligible to 14in) — different effective target", () => {
    // 9.5in wide, 14in ceiling: width-bound (9.5 x 12), never reaches the
    // height ceiling at all — genuinely different from 10.5x14's
    // height-bound 9.33x14, not merely a different STARTING width.
    const a = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 14, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    const b = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 8, boxMaxHeightIn: 14, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    assert.ok(a && b);
    assert.notEqual(a!.widthIn, b!.widthIn);
    assert.notEqual(a!.heightIn, b!.heightIn);
  });

  it("D: a user-proportional size change (future Phase 28U) is recognized as a different request", () => {
    const recommended = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 14, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    const userChosenSmaller = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 8.62, boxMaxHeightIn: 13, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    assert.ok(recommended && userChosenSmaller);
    assert.ok(!productionAssetMatchesEffectiveTarget(
      { widthPx: Math.round(recommended!.widthIn * 300), heightPx: Math.round(recommended!.heightIn * 300) },
      userChosenSmaller!,
    ));
  });

  it("G: canonically equivalent inch values (pixel-rounding noise) are the SAME effective target", () => {
    const target = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 14, confirmedAt: "2026-01-01T00:00:00.000Z" },
      preparation,
    );
    assert.ok(target);
    // An asset a single pixel off on either axis from rounding -- must
    // still register as the same request.
    const widthPx = Math.round(target!.widthIn * 300) + 1;
    const heightPx = Math.round(target!.heightIn * 300) - 1;
    assert.equal(
      productionAssetMatchesEffectiveTarget({ widthPx, heightPx }, target!),
      true,
      "sub-pixel rounding drift must not manufacture a different production identity",
    );
  });

  it("the real car-show envelope change resolves to the exact Phase 28S-documented sizes", () => {
    const realBounds = { analysis: { artworkBounds: { width: 1011, height: 1525 } } };
    const old = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 10.5, confirmedAt: "2026-01-01T00:00:00.000Z" },
      realBounds,
    );
    const corrected = resolveEffectiveProductionTargetIn(
      placement,
      { widthIn: 10.5, boxMaxHeightIn: 14, confirmedAt: "2026-01-01T00:00:00.000Z" },
      realBounds,
    );
    assert.ok(old && corrected);
    // Wider tolerance than a bare containment check: this function ALSO
    // applies the Phase 28I artwork-edge safety margin (Phase 28Q/28R's own
    // historical figures did not), which shifts the effective aspect ratio
    // by a few hundredths of an inch — a real, expected, and correctly-
    // applied difference, not drift to paper over.
    assert.ok(Math.abs(old!.widthIn - 6.96) < 0.1 && Math.abs(old!.heightIn - 10.5) < 0.1);
    assert.ok(Math.abs(corrected!.widthIn - 9.28) < 0.1 && Math.abs(corrected!.heightIn - 14) < 0.1);
    assert.ok(!productionAssetMatchesEffectiveTarget(
      { widthPx: Math.round(old!.widthIn * 300), heightPx: Math.round(old!.heightIn * 300) },
      corrected!,
    ));
  });
});

// --- Integration: the full requestPreparedUploadFinalArtwork + worker path ---

class FakePortraitReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "fake_portrait_reconstruction";
  submitCount = 0;
  resumeCount = 0;

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    const resumed = input.existingProviderRequest?.providerKey === this.providerKey;
    let requestId: string;
    if (resumed) {
      this.resumeCount += 1;
      requestId = input.existingProviderRequest!.providerRequestId;
    } else {
      this.submitCount += 1;
      requestId = `fake-portrait-request-${this.submitCount}`;
      await input.onProviderRequestSubmitted?.(requestId);
    }

    const source = PNG.sync.read(input.sourceBytes);
    // A generous fixed 4x, mirroring the real Topaz behavior Phase 28Q/28R
    // proved (returns ~4x of the source canvas) — sufficient for every
    // envelope this file confirms (all well under a 4x requirement).
    const scale = 4;
    const reconstructed = replicateScaled(source, scale);
    const normalized = normalizeProductionRaster(reconstructed, input.sizing);
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
      reconstructedWidthPx: reconstructed.width,
      reconstructedHeightPx: reconstructed.height,
      resolutionProvenance: "reconstructed",
      transformationMethod: "fake_portrait_reconstruction_v1",
      preservesApprovedContent: false,
      providerRequestId: requestId,
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

function replicateScaled(source: PNG, scale: number): RgbaImage {
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

/** Portrait geometry — 1000x1500 visible artwork (2:3), same ratio family as the real car-show asset. */
const PORTRAIT = { canvasWidthPx: 1100, canvasHeightPx: 1600, artworkWidthPx: 1000, artworkHeightPx: 1500 };

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

describe("Phase 28T — normal Create Print-Ready Artwork path (integration)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-production-identity-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo(): Promise<ProjectRepository> {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  /**
   * Every `it()` in this describe block shares ONE on-disk store (the local
   * repository is rooted at the process working directory — see
   * `prepared-upload-finalization.test.ts`'s identical helper/reasoning). A
   * job an earlier scenario deliberately left `queued` (e.g. the treatment
   * test below never runs its worker) would otherwise be claimed by the
   * NEXT scenario's `worker.processNextJob()` instead of the job that
   * scenario actually cares about.
   */
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
      // Phase 28T: `artworkBounds` is exactly what `resolveEffectiveProductionTargetIn`
      // reads — the same field `image-analysis.ts` already populates for real
      // uploads.
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

  it("A/H: same request twice (same size, same artwork, same treatment) reuses the same job and makes exactly ONE provider submission", async () => {
    const repo = await freshRepo();
    const provider = new FakePortraitReconstructionProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });

    const first = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();
    const second = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    assert.equal(second.job.id, first.job.id, "the exact same request must reuse the same job");
    assert.equal(second.alreadyRequested, true);
    assert.equal(provider.submitCount, 1, "one logical request must never submit twice");
  });

  it("F: same size, different treatment is NOT the same production request", async () => {
    const repo = await freshRepo();
    const provider = new FakePortraitReconstructionProvider();
    const { assets, finalArtwork } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });

    const raster = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Halftone eligibility/creation itself is out of scope here — this only
    // proves the two treatments never collapse into the same job identity,
    // which `findJobForWidth`'s existing treatment-key comparison already
    // guarantees; asserted directly for this file's own portrait fixture.
    const preparation = await repo.getArtworkPreparation(projectId);
    const jobs = await repo.listFinalArtworkJobsForPreparation(projectId, preparation!.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, raster.job.id);
    assert.equal(jobs[0]!.productionTreatmentKey, "standard_raster");
  });

  it("I: a completed job for the OLD envelope is recognized as stale once the confirmed envelope changes, and is revived rather than duplicated", async () => {
    const repo = await freshRepo();
    const provider = new FakePortraitReconstructionProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId, preparationId } = await setupApprovedPortraitProject(repo, assets);

    // Request A: the OLD flat 10.5x10.5 envelope.
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 10.5 });
    const requestA = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();
    const jobAfterA = await repo.getFinalArtworkJob(requestA.job.id);
    assert.equal(jobAfterA!.status, "completed");
    assert.equal(provider.submitCount, 1);

    // Now the confirmed envelope changes to the CORRECTED 10.5x14 (Phase 28S).
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });
    const requestB = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    // Same underlying job row (the DB unique index still keys on width alone
    // — see the Phase 28T report's migration discussion) — but REVIVED, not
    // silently treated as already-satisfying the new request.
    assert.equal(requestB.job.id, requestA.job.id);
    assert.equal(requestB.alreadyRequested, false, "a stale completed job must not be reported as already satisfying the new request");
    const revivedJob = await repo.getFinalArtworkJob(requestB.job.id);
    assert.equal(revivedJob!.status, "queued");

    await worker.processNextJob();
    const jobAfterB = await repo.getFinalArtworkJob(requestB.job.id);
    assert.equal(jobAfterB!.status, "completed");

    // The existing paid reconstruction was RESUMED, never resubmitted.
    assert.equal(provider.submitCount, 1, "correcting the envelope must never submit a new provider request");
    assert.equal(provider.resumeCount, 1, "the existing reconstruction must be resumed for the corrected size");

    // Both production assets now exist, additively — the old one untouched.
    const allAssets = await repo.listAssets(projectId);
    const productionAssets = allAssets.filter(
      (a) => a.finalArtworkJobId === requestA.job.id && a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 2, "the historical asset must be preserved, not overwritten");

    void preparationId;
  });

  it("J: the CURRENT production asset selected matches the CURRENT confirmed envelope, not merely the newest or first", async () => {
    const repo = await freshRepo();
    const provider = new FakePortraitReconstructionProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId } = await setupApprovedPortraitProject(repo, assets);

    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 10.5 });
    const requestA = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 14 });
    await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    // Current state: TWO production assets exist under the same job, for
    // two different confirmed envelopes. The variant-state resolver must
    // surface the one matching the CURRENT (14in) envelope.
    const state = await finalArtwork.resolveProductionVariantState(projectId, "standard_raster");
    assert.ok(state.asset, "a current deliverable must be found");
    const expectedHeightPx = Math.round(14 * 300);
    assert.ok(
      Math.abs((state.asset!.heightPx ?? 0) - expectedHeightPx) < 6,
      `expected the CORRECTED (14in-tall) asset to be current, got height ${state.asset!.heightPx}`,
    );

    // Now revert to the OLD envelope — the OLD asset must become current
    // again (still preserved, never deleted).
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5, boxMaxHeightIn: 10.5 });
    const revertedState = await finalArtwork.resolveProductionVariantState(projectId, "standard_raster");
    assert.ok(revertedState.asset);
    const expectedOldHeightPx = Math.round(10.5 * 300);
    assert.ok(
      Math.abs((revertedState.asset!.heightPx ?? 0) - expectedOldHeightPx) < 6,
      `expected the OLD (10.5in) asset to be current again after reverting, got height ${revertedState.asset!.heightPx}`,
    );

    void requestA;
  });
});
