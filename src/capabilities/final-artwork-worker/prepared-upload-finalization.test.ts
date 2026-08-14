import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createIntentExtractionCapability } from "@/capabilities/intent-extraction";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "@/capabilities/final-artwork/production-normalization";
import { readPhysicalPixelDensity } from "@/capabilities/final-artwork/production-png";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { PrintValidationReport } from "@/capabilities/print-validation/contracts";
import type { PrintPlacement } from "@/lib/domain/types";
import type { ProjectRepository } from "@/lib/db/repository";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Existing Artwork → Print Ready Phase 2 acceptance coverage for the upload
 * workflow's finalization path.
 *
 * NO PAID PROVIDER IS EVER REACHABLE HERE. The "reconstruction" provider below
 * is a local, deterministic pixel replicator with no network access at all —
 * every scenario that exercises the enhancement path exercises it, and the
 * scenarios that must SKIP enhancement assert its call count is zero.
 */

/**
 * A faithful local stand-in for a provider-hosted reconstruction: scales
 * proportionally by an exact integer factor (preserving alpha, so alpha bounds
 * scale exactly too), then runs the SAME shared production normalization the
 * real Topaz adapter runs. Reports `preservesApprovedContent: false` and
 * `resolutionProvenance: "reconstructed"`, exactly like the real adapter.
 */
class FakeReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "fake_upload_reconstruction";
  submitCount = 0;
  resumeCount = 0;
  produceCount = 0;

  constructor(
    private readonly behavior: { scale?: number; crashAfterSubmit?: boolean } = {},
  ) {}

  /** 5x, so the fixtures below clear a 12in/300 PPI target the way live Topaz's 4x clears the bowling case's. */
  private static readonly DEFAULT_SCALE = 5;

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    this.produceCount += 1;
    const resumed = input.existingProviderRequest?.providerKey === this.providerKey;
    let requestId: string;
    if (resumed) {
      this.resumeCount += 1;
      requestId = input.existingProviderRequest!.providerRequestId;
    } else {
      this.submitCount += 1;
      requestId = `fake-upload-request-${this.submitCount}`;
      await input.onProviderRequestSubmitted?.(requestId);
      if (this.behavior.crashAfterSubmit) {
        throw new Error("simulated worker crash after paid submission");
      }
    }

    const source = PNG.sync.read(input.sourceBytes);
    const reconstructed = replicateScaled(
      source,
      this.behavior.scale ?? FakeReconstructionProvider.DEFAULT_SCALE,
    );
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
      transformationMethod: "fake_upload_reconstruction_v1",
      preservesApprovedContent: false,
      providerRequestId: requestId,
      normalization: normalized.result.metadata,
    };
  }
}

/** A provider that always fails, for the "failure leaves everything intact" scenario. */
class FailingProvider implements FinalArtworkProvider {
  readonly providerKey = "fake_failing_reconstruction";
  calls = 0;
  async produce(): Promise<FinalArtworkProviderOutput> {
    this.calls += 1;
    throw new Error("simulated reconstruction outage");
  }
}

/** Counts calls without changing behavior, so "was the local path taken?" is observable. */
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

/**
 * The fixture geometry, in one place.
 *
 * Deliberately WIDE rather than square: a wide plate keeps the pixel counts
 * these scenarios move (a real 10.5in/300 PPI deliverable is genuinely
 * 3150px across) down to something a test suite can run repeatedly, AND it
 * makes "height is derived from the artwork's own proportions" an assertion
 * with teeth — a square fixture would pass a pipeline that simply squared
 * every plate.
 */
interface FixtureGeometry {
  canvasWidthPx: number;
  canvasHeightPx: number;
  artworkWidthPx: number;
  artworkHeightPx: number;
}

/** Small; used with `left_chest` (4in → 1200px), where 400px of artwork is honestly short. */
const SMALL_FIXTURE: FixtureGeometry = {
  canvasWidthPx: 460,
  canvasHeightPx: 220,
  artworkWidthPx: 400,
  artworkHeightPx: 180,
};

/** Used with `full_back`, where the plate really is 3150px (or 3600px at 12in) wide. */
const FULL_BACK_FIXTURE: FixtureGeometry = {
  canvasWidthPx: 900,
  canvasHeightPx: 400,
  artworkWidthPx: 820,
  artworkHeightPx: 340,
};

/** Artwork that already carries more real pixels than a 3in sleeve (900px) needs. */
const ALREADY_LARGE_ENOUGH_FIXTURE: FixtureGeometry = {
  canvasWidthPx: 1100,
  canvasHeightPx: 500,
  artworkWidthPx: 1000,
  artworkHeightPx: 420,
};

function drawArtwork(
  geometry: FixtureGeometry,
  backgroundAlpha: number,
): Buffer {
  const { canvasWidthPx, canvasHeightPx, artworkWidthPx, artworkHeightPx } = geometry;
  const png = new PNG({ width: canvasWidthPx, height: canvasHeightPx });
  const insetX = Math.floor((canvasWidthPx - artworkWidthPx) / 2);
  const insetY = Math.floor((canvasHeightPx - artworkHeightPx) / 2);

  for (let y = 0; y < canvasHeightPx; y += 1) {
    for (let x = 0; x < canvasWidthPx; x += 1) {
      const idx = (canvasWidthPx * y + x) << 2;
      const inside =
        x >= insetX &&
        x < insetX + artworkWidthPx &&
        y >= insetY &&
        y < insetY + artworkHeightPx;
      png.data[idx] = inside ? 20 : 0;
      png.data[idx + 1] = inside ? 90 : 0;
      png.data[idx + 2] = inside ? 60 : 0;
      png.data[idx + 3] = inside ? 255 : backgroundAlpha;
    }
  }
  return PNG.sync.write(png);
}

/** The prepared PNG: artwork on transparency, the shape every prepared upload has. */
function preparedArtworkPng(geometry: FixtureGeometry): Buffer {
  return drawArtwork(geometry, 0);
}

/** The immutable original: the same artwork on an opaque background. */
function originalUploadPng(geometry: FixtureGeometry): Buffer {
  return drawArtwork(geometry, 255);
}

describe("Prepared-upload finalization (Existing Artwork → Print Ready Phase 2)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-prepared-upload-final-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  /**
   * Every scenario in this file shares ONE on-disk store — the local
   * repository is rooted at the process working directory, so `freshRepo()`
   * gives a fresh handle, never a fresh database. A job an earlier scenario
   * deliberately left queued (idempotency scenarios create jobs without ever
   * running them) would otherwise be claimed by the NEXT scenario's worker,
   * and counted against that scenario's provider — quietly turning "was a paid
   * call made?" assertions into assertions about someone else's job.
   *
   * Retiring the queue before each setup makes the claim deterministic: the
   * only claimable job during a scenario is the one that scenario created.
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

  function buildPipeline(
    repo: ProjectRepository,
    provider: FinalArtworkProvider = new FakeReconstructionProvider(),
    localProvider: FinalArtworkProvider = new CountingLocalProvider(),
  ) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      provider,
      createPrintValidationCapability(),
      undefined,
      localProvider,
    );
    return { assets, finalArtwork, worker, provider, localProvider };
  }

  interface PreparationSetup {
    geometry?: FixtureGeometry;
    printPlacement?: PrintPlacement | null;
    intendedPrintWidthIn?: number | null;
    productSummary?: string;
    /** Stop before customer approval, for the "unapproved cannot finalize" scenario. */
    approve?: boolean;
    originalFilename?: string | null;
    /**
     * Sprint A2 (corrected): a customer chat message driven through the real
     * intent-extraction path. Existing Artwork shares the project, brief and
     * conversation with Create New, so the SAME structured field carries an
     * upload customer's production-output request — no ArtworkPreparation
     * column and no fabricated `DesignBriefVersion`. Deterministic resolver
     * only: no provider, no paid call.
     */
    customerMessage?: string;
  }

  /**
   * Drives a project to "an approved prepared upload" — the exact state a
   * customer's "Prepare Print-Ready Artwork" click starts from.
   *
   * Builds the preparation records directly rather than running Phase 1's
   * analyzer/isolation: this suite is about what happens AFTER approval, and
   * Phase 1's own regression suites already prove how that state is reached.
   * The synthetic end-to-end test drives the real Phase 1 path.
   */
  async function setupApprovedPreparation(
    repo: ProjectRepository,
    assets: ReturnType<typeof buildPipeline>["assets"],
    options: PreparationSetup = {},
  ) {
    await retireQueuedJobs(repo);

    const geometry = options.geometry ?? SMALL_FIXTURE;
    const created = await repo.createProject();
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: options.productSummary ?? "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement:
        options.printPlacement === undefined ? "left_chest" : options.printPlacement,
      intendedPrintWidthIn: options.intendedPrintWidthIn ?? null,
    });

    if (options.customerMessage !== undefined) {
      const designBrief = createDesignBriefCapability(repo);
      const extraction = createIntentExtractionCapability().extract({
        brief: await designBrief.getWorkingBrief(projectId),
        phase: "interviewing",
        reply: options.customerMessage,
        pendingSection: null,
        understanding: null,
      });
      for (const proposal of extraction.proposals) {
        await designBrief.applyProposal(projectId, proposal);
      }
    }

    const originalBytes = originalUploadPng(geometry);
    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: originalBytes,
      contentType: "image/png",
      widthPx: geometry.canvasWidthPx,
      heightPx: geometry.canvasHeightPx,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: options.originalFilename ?? "split disturbers.png" },
    });

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: options.originalFilename ?? "split disturbers.png",
      analysis: {
        widthPx: geometry.canvasWidthPx,
        heightPx: geometry.canvasHeightPx,
      },
    });

    const preparedBytes = preparedArtworkPng(geometry);
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedBytes,
      contentType: "image/png",
      widthPx: geometry.canvasWidthPx,
      heightPx: geometry.canvasHeightPx,
      hasTransparency: true,
      kind: "png",
      metadata: { derivedFromAssetId: original.id },
    });

    await repo.updateArtworkPreparation(preparation.id, {
      status: "prepared",
      preparedAssetId: prepared.id,
      preparation: { backgroundRemoved: true },
    });

    if (options.approve === false) {
      return {
        projectId,
        preparationId: preparation.id,
        originalAssetId: original.id,
        originalBytes,
        preparedAssetId: prepared.id,
        preparedBytes,
        artworkVersionId: null,
      };
    }

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
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "approved");

    return {
      projectId,
      preparationId: preparation.id,
      originalAssetId: original.id,
      originalBytes,
      preparedAssetId: prepared.id,
      preparedBytes,
      artworkVersionId: artwork!.id,
      geometry,
    };
  }

  async function latestReport(
    repo: ProjectRepository,
    projectId: string,
    jobId: string,
  ): Promise<PrintValidationReport> {
    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      jobId,
    );
    assert.ok(validation, "expected an authoritative validation run");
    return validation.report as unknown as PrintValidationReport;
  }

  async function productionAssetFor(
    repo: ProjectRepository,
    projectId: string,
    jobId: string,
  ) {
    const assets = await repo.listAssets(projectId);
    return assets.find(
      (asset) => asset.finalArtworkJobId === jobId && asset.productionRole === "production_png",
    );
  }

  // --- A: approved prepared artwork can request finalization ---------------
  it("A: an approved prepared upload can request finalization", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork } = buildPipeline(repo);
    const { projectId, preparationId, artworkVersionId } =
      await setupApprovedPreparation(repo, assets);

    const result = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    assert.equal(result.alreadyRequested, false);
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.sourceKind, "prepared_upload");
    assert.equal(result.job.artworkPreparationId, preparationId);
    assert.equal(result.job.artworkVersionId, artworkVersionId);
    // No fabricated final-direction approval anywhere (Goal 1).
    assert.equal(result.job.finalDirectionApprovalId, null);
    assert.equal(await repo.getActiveFinalDirectionApproval(projectId), null);
    assert.equal(result.productionWidthIn, 4, "the left-chest placement default");

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.project.status, "finalizing");
    // Never dressed up as concept generation (Goal: no GenerationJob).
    assert.deepEqual(await repo.listGenerationJobs(projectId), []);
  });

  // --- B: unapproved preparation cannot finalize ---------------------------
  it("B: a prepared-but-unapproved artwork cannot request finalization", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork } = buildPipeline(repo);
    const { projectId } = await setupApprovedPreparation(repo, assets, {
      approve: false,
    });

    await assert.rejects(
      () => finalArtwork.requestPreparedUploadFinalArtwork(projectId),
      /Approve your prepared artwork/,
    );

    const snapshot = await repo.getProject(projectId);
    assert.notEqual(snapshot!.project.status, "finalizing");
  });

  it("B: a project with no uploaded artwork at all cannot request upload finalization", async () => {
    const repo = await freshRepo();
    const { finalArtwork } = buildPipeline(repo);
    const projectId = (await repo.createProject()).project.id;

    await assert.rejects(
      () => finalArtwork.requestPreparedUploadFinalArtwork(projectId),
      /no uploaded artwork/,
    );
  });

  it("refuses when the print location is not yet known", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork } = buildPipeline(repo);
    const { projectId } = await setupApprovedPreparation(repo, assets, {
      printPlacement: null,
    });

    await assert.rejects(
      () => finalArtwork.requestPreparedUploadFinalArtwork(projectId),
      /where this prints/,
    );
  });

  // --- C: cross-project preparation rejected --------------------------------
  it("C: a job naming another project's preparation never resolves that preparation", async () => {
    const repo = await freshRepo();
    const { assets, worker } = buildPipeline(repo);
    const victim = await setupApprovedPreparation(repo, assets);
    const attacker = await setupApprovedPreparation(repo, assets);

    // Forge the job directly — the capability would never build this, which is
    // exactly why the WORKER has to refuse it independently.
    const forged = await repo.createFinalArtworkJob(attacker.projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId: victim.preparationId,
      artworkVersionId: attacker.artworkVersionId!,
      productionWidthIn: 4,
      requestedProductionOutput: "production_png",
    });

    await worker.processNextJob();

    const failed = await repo.getFinalArtworkJob(forged.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /no longer exists for this project/i);
    assert.equal(
      await productionAssetFor(repo, attacker.projectId, forged.id),
      undefined,
      "no production asset may be created from a cross-project preparation",
    );
  });

  // --- D + F: the prepared asset is the source, and undersized artwork is enhanced
  it("D/F: undersized artwork is enhanced FROM the prepared PNG, never the opaque original", async () => {
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider, local);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    assert.equal(provider.submitCount, 1, "F: undersized artwork requires enhancement");
    assert.equal(local.calls, 0, "the normalization-only path must not run too");

    const productionAsset = await productionAssetFor(repo, setup.projectId, job.id);
    assert.ok(productionAsset);
    assert.equal(
      productionAsset.metadata.sourceAssetId,
      setup.preparedAssetId,
      "D: the transform reads the approved prepared PNG",
    );
    assert.notEqual(productionAsset.metadata.sourceAssetId, setup.originalAssetId);

    const lineage = productionAsset.metadata.uploadedPreserve as Record<string, unknown>;
    assert.equal(lineage.preparedAssetId, setup.preparedAssetId);
    assert.equal(lineage.originalAssetId, setup.originalAssetId);
    assert.equal(lineage.enhancement, "reconstructed");
    assert.equal(
      lineage.sourceBytesSha256,
      createHash("sha256").update(setup.preparedBytes).digest("hex"),
      "the recorded hash is of the exact prepared bytes the transform read",
    );
  });

  // --- E: adequate source skips paid enhancement ---------------------------
  it("E: artwork already large enough skips the paid provider entirely", async () => {
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider, local);
    // A 3in sleeve needs 900px; this artwork carries 1000px of real detail.
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: ALREADY_LARGE_ENOUGH_FIXTURE,
      printPlacement: "sleeve",
    });

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    assert.equal(provider.produceCount, 0, "E: no paid provider call at all");
    assert.equal(provider.submitCount, 0);
    assert.equal(local.calls, 1, "the local normalization-only path ran instead");

    const productionAsset = await productionAssetFor(repo, setup.projectId, job.id);
    assert.ok(productionAsset);
    assert.equal(productionAsset.widthPx, 900);
    const lineage = productionAsset.metadata.uploadedPreserve as Record<string, unknown>;
    assert.equal(lineage.enhancement, "skipped");

    const finished = await repo.getProject(setup.projectId);
    assert.equal(finished!.project.status, "print_ready");
  });

  // --- Sprint A2 (corrected): requested production output, upload workflow --

  it("R/T/U: an upload customer's explicit separations request stops finalization, with no paid provider call", async () => {
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider, local);
    // Deliberately UNDERSIZED artwork: without the output gate this job would
    // reach the paid reconstruction path, so `produceCount === 0` below is a
    // real assertion about ordering, not a vacuous one.
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: SMALL_FIXTURE,
      printPlacement: "left_chest",
      customerMessage: "can you create the color separations from this",
    });

    // R: the request reached the same structured field the Create New path uses.
    assert.equal(
      (await repo.getProject(setup.projectId))?.brief.requestedProductionOutput,
      "screen_print_separations",
    );

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    // U: nothing paid was dispatched, local or hosted.
    assert.equal(provider.produceCount, 0, "no paid provider call");
    assert.equal(provider.submitCount, 0);
    assert.equal(local.calls, 0, "not even the local normalization path ran");

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.lastError ?? "", /does not produce/i);

    // T: cannot reach print_ready, and no plate exists to be downloaded.
    const finished = await repo.getProject(setup.projectId);
    assert.equal(finished!.project.status, "finalization_required");
    assert.ok(!(await productionAssetFor(repo, setup.projectId, job.id)));
  });

  it("R: an upload customer who only MENTIONS screen printing still gets their plate", async () => {
    // Goal 11 of the original sprint, on the Existing Artwork path: the
    // immutable original → prepared upload → Production PNG → validation →
    // download chain must not be broken by a method word.
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: ALREADY_LARGE_ENOUGH_FIXTURE,
      printPlacement: "sleeve",
      customerMessage: "this is for screen printing later, I already have the DST file",
    });

    assert.equal(
      (await repo.getProject(setup.projectId))?.brief.requestedProductionOutput,
      null,
      "context and possession are not production requests",
    );

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    assert.ok(await productionAssetFor(repo, setup.projectId, job.id));
    assert.equal(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
    );
  });

  // --- Sprint A2 Correction 2: production-intent lifecycle, upload workflow -
  // Goal 17 asks for the same lifecycle guarantees as Create New, plus the
  // one that is unique to this path: the enhancement step here can spend real
  // money, so the fence has to sit in front of it.

  it("L: an upload job snapshots the current intent, and size + output both key the job", async () => {
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork } = buildPipeline(repo, provider, local);
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: SMALL_FIXTURE,
      printPlacement: "left_chest",
    });

    const png = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(png.job.requestedProductionOutput, "production_png");

    // M: same preparation, same width, different requested output → a
    // different job. Size and output are independent specifications and both
    // distinguish a deliverable.
    await repo.updateBrief(setup.projectId, {
      requestedProductionOutput: "screen_print_separations",
    });
    const seps = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.notEqual(seps.job.id, png.job.id);
    assert.equal(seps.job.requestedProductionOutput, "screen_print_separations");
    assert.equal(seps.job.productionWidthIn, png.job.productionWidthIn);
  });

  it("N/U: a queued upload job whose intent changed is superseded before any paid work", async () => {
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider, local);
    // Undersized on purpose: without the fence this job reaches the paid
    // reconstruction path, so the zero counts below are real assertions.
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: SMALL_FIXTURE,
      printPlacement: "left_chest",
    });
    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );

    await repo.updateBrief(setup.projectId, {
      requestedProductionOutput: "screen_print_separations",
    });
    await worker.processNextJob();

    assert.equal(provider.produceCount, 0, "no paid reconstruction for a stale job");
    assert.equal(provider.submitCount, 0);
    assert.equal(local.calls, 0);

    const settled = await repo.getFinalArtworkJob(job.id);
    assert.equal(settled?.status, "cancelled");
    assert.match(settled?.lastError ?? "", /superseded/i);
    assert.ok(!(await productionAssetFor(repo, setup.projectId, job.id)));
    assert.notEqual(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
    );
  });

  it("T/O: an upload retraction reuses the superseded job without a second paid submission", async () => {
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider, local);
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: SMALL_FIXTURE,
      printPlacement: "left_chest",
    });
    const first = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );

    // Superseded before it ran — no paid work yet.
    await repo.updateBrief(setup.projectId, {
      requestedProductionOutput: "screen_print_separations",
    });
    await worker.processNextJob();
    assert.equal(provider.submitCount, 0);

    // The customer changes their mind back. The SAME job is revived rather
    // than a second one created, so the (project, preparation, width, output)
    // key still holds and no duplicate paid credit is possible.
    await repo.updateBrief(setup.projectId, {
      requestedProductionOutput: "production_png",
    });
    const again = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    assert.equal(again.job.id, first.job.id);
    assert.equal(again.job.status, "queued");

    await worker.processNextJob();
    assert.equal(
      provider.submitCount,
      1,
      "exactly one paid submission across the whole transition",
    );
    assert.ok(await productionAssetFor(repo, setup.projectId, again.job.id));
    assert.equal(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
    );
  });

  it("H: upload PNG → unsupported → PNG restores print_ready and delivery, with no second paid submission", async () => {
    // Sprint A2 Correction 3, mirrored for Existing Artwork. Both workflows
    // now share one reconciliation boundary, so this proves the shared path
    // rather than a parallel implementation.
    const repo = await freshRepo();
    const provider = new FakeReconstructionProvider();
    const local = new CountingLocalProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider, local);
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: SMALL_FIXTURE,
      printPlacement: "left_chest",
    });
    const conversationService = await import("@/lib/services/conversation-service");

    const original = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();
    assert.equal(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
    );
    const plate = await productionAssetFor(repo, setup.projectId, original.job.id);
    assert.ok(plate);
    assert.equal(provider.submitCount, 1);
    assert.ok(await conversationService.getProductionArtworkUrl(setup.projectId));

    // Unsupported request → the plate stops being the answer.
    await repo.updateBrief(setup.projectId, {
      requestedProductionOutput: "screen_print_separations",
    });
    await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await worker.processNextJob();
    assert.equal(
      await conversationService.getProductionArtworkUrl(setup.projectId),
      null,
    );
    assert.equal(
      (await conversationService.getFinalizationStatus(setup.projectId))?.status,
      "needs_review",
    );

    // Retraction → the same plate answers again, reconciled from evidence.
    await repo.updateBrief(setup.projectId, {
      requestedProductionOutput: "production_png",
    });
    const reused = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    assert.equal(reused.job.id, original.job.id);
    assert.equal(reused.job.status, "completed", "not revived merely to restore state");
    assert.equal(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
    );
    assert.equal(
      (await conversationService.getFinalizationStatus(setup.projectId))?.status,
      "print_ready",
    );
    assert.equal(provider.submitCount, 1, "no second paid reconstruction");
    assert.equal(
      (await productionAssetFor(repo, setup.projectId, original.job.id))?.id,
      plate!.id,
      "the same plate, never a duplicate",
    );
    assert.ok(await conversationService.getProductionArtworkUrl(setup.projectId));
  });

  // --- I/J/K/L: production geometry ----------------------------------------
  it("I/K/L: a standard 10.5in full-back plate is 3150px wide, proportionally tall, at 300 PPI", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: FULL_BACK_FIXTURE,
      printPlacement: "full_back",
    });

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    const productionAsset = await productionAssetFor(repo, setup.projectId, job.id);
    assert.ok(productionAsset);
    assert.equal(productionAsset.widthPx, 3150, "I: 10.5in x 300 PPI");

    const normalization = productionAsset.metadata.normalization as Record<string, unknown>;
    assert.equal(normalization.targetPpi, 300);
    assert.equal(normalization.intendedWidthIn, 10.5);
    assert.equal(normalization.constrainedBy, "width");

    // K: height comes from the artwork's OWN proportions, never a fixed
    // canvas. This fixture is deliberately wide, so a pipeline that squared
    // every plate — or padded one out to the placement envelope — fails here.
    const heightPx = productionAsset.heightPx!;
    const expectedHeight = Math.round(
      3150 *
        ((normalization.trimmedHeightPx as number) /
          (normalization.trimmedWidthPx as number)),
    );
    assert.equal(heightPx, expectedHeight);
    assert.ok(
      heightPx < 3150 * 0.6,
      `wide artwork must produce a wide plate, got ${3150}x${heightPx}`,
    );
    assert.equal(normalization.intendedHeightIn, heightPx / 300);

    // L: 300 PPI written as real pHYs density, not merely claimed.
    const bytes = await assets.downloadAssetBytes(productionAsset.id);
    const density = readPhysicalPixelDensity(bytes!.bytes);
    assert.ok(density);
    assert.equal(density.unitSpecifier, 1);
    assert.ok(
      Math.abs(density.ppiX - 300) < 1 && Math.abs(density.ppiY - 300) < 1,
      `expected ~300 PPI in pHYs, got ${density.ppiX}x${density.ppiY}`,
    );

    const report = await latestReport(repo, setup.projectId, job.id);
    assert.equal(report.profile, "uploaded_preserve");
    assert.equal(report.status, "ready", report.blockingIssues.join("; "));

    const finished = await repo.getProject(setup.projectId);
    assert.equal(finished!.project.status, "print_ready");
  });

  it("J: a 12in target produces a 3600px-wide plate", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets, {
      geometry: FULL_BACK_FIXTURE,
      printPlacement: "full_back",
      intendedPrintWidthIn: 12,
    });

    const { job, productionWidthIn } =
      await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(productionWidthIn, 12);
    await worker.processNextJob();

    const productionAsset = await productionAssetFor(repo, setup.projectId, job.id);
    assert.equal(productionAsset?.widthPx, 3600);

    const report = await latestReport(repo, setup.projectId, job.id);
    assert.equal(report.status, "ready", report.blockingIssues.join("; "));
  });

  // --- M/N via the real pipeline -------------------------------------------
  it("M/N: the plate is print-ready with no Concept Evaluation and no typed wording anywhere", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    const snapshot = await repo.getProject(setup.projectId);
    const artwork = snapshot!.artworkVersions.find(
      (version) => version.id === setup.artworkVersionId,
    );
    assert.equal(artwork!.evaluation, null, "no Concept Evaluation was ever run");
    assert.equal(snapshot!.brief.exactText, null, "no wording was ever typed");

    const report = await latestReport(repo, setup.projectId, job.id);
    assert.equal(report.status, "ready");
    const emitted = report.checks.map((check) => check.check);
    assert.ok(!emitted.includes("concept_evaluation_alignment"));
    assert.ok(!emitted.includes("required_wording_verification"));
    assert.ok(emitted.includes("source_lineage"));
    assert.ok(emitted.includes("preserved_source_geometry"));
    assert.ok(emitted.includes("reconstruction_sufficiency"));
  });

  // --- P/Q/R: assets are separate and immutable -----------------------------
  it("P/Q/R: the production asset is new, and the original and prepared assets are byte-identical afterwards", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);
    const originalHash = createHash("sha256").update(setup.originalBytes).digest("hex");
    const preparedHash = createHash("sha256").update(setup.preparedBytes).digest("hex");

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    const productionAsset = await productionAssetFor(repo, setup.projectId, job.id);
    assert.ok(productionAsset);
    assert.notEqual(productionAsset.id, setup.preparedAssetId, "P: a distinct record");
    assert.notEqual(productionAsset.id, setup.originalAssetId);
    assert.equal(productionAsset.productionRole, "production_png");
    assert.equal(productionAsset.generationJobId, null);

    const originalAfter = await assets.downloadAssetBytes(setup.originalAssetId);
    assert.equal(
      createHash("sha256").update(originalAfter!.bytes).digest("hex"),
      originalHash,
      "Q: the customer's upload is untouched",
    );
    const preparedAfter = await assets.downloadAssetBytes(setup.preparedAssetId);
    assert.equal(
      createHash("sha256").update(preparedAfter!.bytes).digest("hex"),
      preparedHash,
      "R: the prepared artwork is untouched",
    );
  });

  // --- S/T: idempotency -----------------------------------------------------
  it("S/T: a double click, a reload, and two tabs all produce exactly one job", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const first = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const second = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const [raceA, raceB] = await Promise.all([
      finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
      finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
    ]);

    assert.equal(first.alreadyRequested, false);
    assert.equal(second.alreadyRequested, true);
    assert.equal(second.job.id, first.job.id);
    assert.equal(raceA.job.id, first.job.id);
    assert.equal(raceB.job.id, first.job.id);

    const jobs = await repo.listFinalArtworkJobsForPreparation(
      setup.projectId,
      setup.preparationId,
    );
    assert.equal(jobs.length, 1);
  });

  // --- U: provider resume never pays twice ---------------------------------
  it("U: a crash after submission resumes the same paid request instead of submitting a second", async () => {
    const repo = await freshRepo();
    const crashing = new FakeReconstructionProvider({ crashAfterSubmit: true });
    const { assets, finalArtwork, worker } = buildPipeline(repo, crashing);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    const afterCrash = await repo.getFinalArtworkJob(job.id);
    assert.equal(afterCrash?.status, "failed");
    assert.equal(afterCrash?.providerRequestId, "fake-upload-request-1");
    assert.equal(crashing.submitCount, 1);

    // The customer presses the same button again.
    const retry = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(retry.job.id, job.id, "the retry revives the same job, never a second");
    assert.equal(retry.job.status, "queued");

    const resuming = new FakeReconstructionProvider();
    const { worker: resumingWorker } = buildPipeline(repo, resuming);
    await resumingWorker.processNextJob();

    assert.equal(resuming.submitCount, 0, "U: no second paid submission");
    assert.equal(resuming.resumeCount, 1);
    assert.equal(crashing.submitCount, 1, "still exactly one paid request in total");
  });

  // --- V/W: production size is part of the identity -------------------------
  it("V: a completed job is reused only while the production size still matches", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();
    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");

    const again = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(again.job.id, job.id, "same size → the completed verdict stands");
    assert.equal(again.alreadyRequested, true);

    // The completed plate is what a download resolves to, at this size.
    assert.equal(
      await finalArtwork.getCurrentProductionAssetId(setup.projectId),
      (await productionAssetFor(repo, setup.projectId, job.id))!.id,
    );
  });

  it("W: changing the size after a completed plate demands a NEW production run", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const first = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await worker.processNextJob();
    const firstAsset = await productionAssetFor(repo, setup.projectId, first.job.id);
    assert.equal(firstAsset?.widthPx, 1200, "4in left chest at 300 PPI");

    // The customer chooses a bigger print.
    await repo.updateBrief(setup.projectId, { intendedPrintWidthIn: 5 });

    // The 4in plate is never handed over as though it were the 5in one.
    assert.equal(
      await finalArtwork.getCurrentProductionAssetId(setup.projectId),
      null,
      "W: a mismatched plate is withheld, not silently reused",
    );

    const second = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.notEqual(second.job.id, first.job.id, "W: a different size is a different job");
    assert.equal(second.job.productionWidthIn, 5);
    assert.equal(second.alreadyRequested, false);

    await worker.processNextJob();
    const secondAsset = await productionAssetFor(repo, setup.projectId, second.job.id);
    assert.equal(secondAsset?.widthPx, 1500);
    assert.notEqual(secondAsset?.id, firstAsset?.id);

    // The older plate still exists, untouched — it was correct for its size.
    const stillThere = await productionAssetFor(repo, setup.projectId, first.job.id);
    assert.equal(stillThere?.id, firstAsset?.id);
    assert.equal(stillThere?.widthPx, 1200);

    assert.equal(
      await finalArtwork.getCurrentProductionAssetId(setup.projectId),
      secondAsset?.id,
    );
  });

  it("a job completing for a size the customer has since abandoned never claims print_ready", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    // The size changes while the job sits queued.
    await repo.updateBrief(setup.projectId, { intendedPrintWidthIn: 5 });
    await worker.processNextJob();

    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");
    const snapshot = await repo.getProject(setup.projectId);
    assert.notEqual(
      snapshot!.project.status,
      "print_ready",
      "a plate at an abandoned size must never present as the finished file",
    );
  });

  // --- X: failure leaves everything the customer owns intact ----------------
  it("X: a reconstruction failure keeps the prepared approval, the original, and the prepared asset", async () => {
    const repo = await freshRepo();
    const failing = new FailingProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, failing);
    const setup = await setupApprovedPreparation(repo, assets);
    const preparedHash = createHash("sha256").update(setup.preparedBytes).digest("hex");

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /outage/);

    const preparation = await repo.getArtworkPreparation(setup.projectId);
    assert.equal(preparation?.status, "approved", "X: approval survives");
    assert.equal(preparation?.preparedArtworkVersionId, setup.artworkVersionId);
    assert.equal(preparation?.preparedAssetId, setup.preparedAssetId);

    const preparedAfter = await assets.downloadAssetBytes(setup.preparedAssetId);
    assert.equal(
      createHash("sha256").update(preparedAfter!.bytes).digest("hex"),
      preparedHash,
    );
    assert.ok(await assets.downloadAssetBytes(setup.originalAssetId));

    // Nothing claims print-readiness, and no plate was invented.
    const snapshot = await repo.getProject(setup.projectId);
    assert.notEqual(snapshot!.project.status, "print_ready");
    assert.equal(await productionAssetFor(repo, setup.projectId, job.id), undefined);

    // And the customer can retry with the same action.
    const retry = await finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(retry.job.id, job.id);
    assert.equal(retry.job.status, "queued");
  });

  it("Goal 16: a retry after a failure reuses the one production asset rather than creating a second", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();
    const firstAsset = await productionAssetFor(repo, setup.projectId, job.id);

    // Force a second run of the same job.
    await repo.updateFinalArtworkJob(job.id, { status: "queued" });
    await worker.processNextJob();

    const productionAssets = (await repo.listAssets(setup.projectId)).filter(
      (asset) => asset.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1);
    assert.equal(productionAssets[0]!.id, firstAsset!.id);
  });

  // --- Preparation no longer approved --------------------------------------
  it("cancels rather than fails when the prepared artwork is no longer the approved one", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await repo.updateArtworkPreparation(setup.preparationId, {
      preparedArtworkVersionId: "00000000-0000-0000-0000-000000000000",
    });
    await worker.processNextJob();

    const cancelled = await repo.getFinalArtworkJob(job.id);
    assert.equal(cancelled?.status, "cancelled");
    const snapshot = await repo.getProject(setup.projectId);
    assert.notEqual(snapshot!.project.status, "print_ready");
  });

  // --- Goal 5: reconstruction that still lands short fails honestly --------
  it("Goal 5: a reconstruction that cannot reach the target fails validation honestly rather than claiming readiness", async () => {
    const repo = await freshRepo();
    // A 2x reconstruction of 400px of artwork is 800px — short of the 1200px
    // a 4in left-chest print needs at 300 PPI.
    const weak = new FakeReconstructionProvider({ scale: 2 });
    const { assets, finalArtwork, worker } = buildPipeline(repo, weak);
    const setup = await setupApprovedPreparation(repo, assets);

    const { job } = await finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    await worker.processNextJob();

    const report = await latestReport(repo, setup.projectId, job.id);
    assert.notEqual(report.status, "ready");
    assert.equal(
      report.checks.find((check) => check.check === "reconstruction_sufficiency")?.status,
      "fail",
    );

    const snapshot = await repo.getProject(setup.projectId);
    assert.equal(snapshot!.project.status, "finalization_required");

    // No infinite upscale loop: the job is COMPLETE with an honest verdict.
    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");
    assert.equal(weak.submitCount, 1, "exactly one paid attempt, never a retry ladder");
  });

  // --- Z: the create_new path is untouched ---------------------------------
  it("Z: a generated-concept job still carries its approval authority and no upload fields", async () => {
    const repo = await freshRepo();
    const projectId = (await repo.createProject()).project.id;
    const approval = await repo.createFinalDirectionApproval(projectId, {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "brief-1",
    });

    const job = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "generated_concept",
      finalDirectionApprovalId: approval.id,
      artworkVersionId: "artwork-1",
      requestedProductionOutput: "production_png",
    });

    assert.equal(job.sourceKind, "generated_concept");
    assert.equal(job.finalDirectionApprovalId, approval.id);
    assert.equal(job.artworkPreparationId, null);
    assert.equal(job.productionWidthIn, null);
    assert.deepEqual(
      await repo.listFinalArtworkJobsForPreparation(projectId, approval.id),
      [],
      "a create_new job never appears under any preparation",
    );
  });
});
