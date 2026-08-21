import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import {
  createFinalArtworkCapability,
  LocalRasterInterpolationProvider,
} from "@/capabilities/final-artwork";
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
import {
  createConceptEvaluationCapability,
  type ConceptEvaluationProvider,
  type ConceptEvaluationRequest,
  type ConceptEvaluationResult,
} from "@/capabilities/concept-evaluation";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { ConceptEvaluation, PrintPlacement } from "@/lib/domain/types";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

/**
 * Sprint 2M Phase 2E: a fake RECONSTRUCTION provider (never a real Topaz
 * call) that exercises the paid-call idempotency contract
 * (`existingProviderRequest` / `onProviderRequestSubmitted`) and always
 * reports `preservesApprovedContent: false` — exactly like the real Topaz
 * adapter — so it exercises the independent production-verification path.
 */
class FakeReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "fake_topaz_reconstruction";
  submitCount = 0;
  resumeCount = 0;

  constructor(
    public behavior: {
      hasTransparency?: boolean;
      crashAfterSubmit?: boolean;
    } = {},
  ) {}

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    const resumed = input.existingProviderRequest?.providerKey === this.providerKey;
    let requestId: string;
    if (resumed) {
      this.resumeCount += 1;
      requestId = input.existingProviderRequest!.providerRequestId;
    } else {
      this.submitCount += 1;
      requestId = `fake-request-${this.submitCount}`;
      await input.onProviderRequestSubmitted?.(requestId);
      if (this.behavior.crashAfterSubmit) {
        throw new Error("simulated worker crash after paid submission");
      }
    }

    const source = PNG.sync.read(input.sourceBytes);
    const hasTransparency = this.behavior.hasTransparency ?? true;

    // Print-Ready Normalization Phase 1: a faithful stand-in for Topaz —
    // "reconstruct" proportionally (2x here, for test cost), then run the
    // SAME shared production normalization the real adapter runs, so this
    // test exercises the real trim/size/encode path rather than a
    // hand-built canvas.
    const reconstructed = reconstructForFake(source, hasTransparency);
    const normalized = normalizeProductionRaster(reconstructed, input.sizing);
    if (normalized.status !== "normalized") {
      throw new Error(normalized.reason);
    }
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
      transformationMethod: "fake_topaz_reconstruction_v1",
      preservesApprovedContent: false,
      providerRequestId: requestId,
      normalization: normalized.result.metadata,
    };
  }
}

/**
 * Builds a "reconstructed" raster from the source fixture: 2x dimensions,
 * with the source's own transparent border preserved (so alpha trimming has
 * something real to trim) and an opaque — or, for the opaque-output scenario,
 * fully opaque — artwork region.
 */
function reconstructForFake(source: PNG, hasTransparency: boolean): RgbaImage {
  const scale = 2;
  const width = source.width * scale;
  const height = source.height * scale;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIdx =
        (Math.min(source.height - 1, Math.floor(y / scale)) * source.width +
          Math.min(source.width - 1, Math.floor(x / scale))) *
        4;
      const idx = (y * width + x) * 4;
      data[idx] = 5;
      data[idx + 1] = 5;
      data[idx + 2] = 5;
      data[idx + 3] = hasTransparency ? source.data[sourceIdx + 3] : 255;
    }
  }
  return { width, height, data };
}

/**
 * A provider that deliberately produces the PRE-normalization deliverable
 * shape: artwork centred inside a large fixed transparent canvas, with
 * normalization metadata honestly describing that padding. Exists so the
 * dead-canvas validation rule is proven against the exact defect the
 * Print-Ready Production Output Audit found, rather than only against
 * hand-written summary numbers.
 */
class DeadCanvasProvider implements FinalArtworkProvider {
  readonly providerKey = "fake_dead_canvas";

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    const source = PNG.sync.read(input.sourceBytes);
    const widthPx = Math.round(input.sizing.targetWidthIn * input.sizing.targetPpi);
    const heightPx = Math.round(input.sizing.maxHeightIn * input.sizing.targetPpi);

    // Artwork covering ~half the canvas, centred — the audited shape.
    const artworkWidth = Math.round(widthPx * 0.7);
    const artworkHeight = Math.round(heightPx * 0.7);
    const left = Math.floor((widthPx - artworkWidth) / 2);
    const top = Math.floor((heightPx - artworkHeight) / 2);
    const canvas = new PNG({ width: widthPx, height: heightPx });
    for (let y = top; y < top + artworkHeight; y += 1) {
      for (let x = left; x < left + artworkWidth; x += 1) {
        const idx = (y * widthPx + x) * 4;
        canvas.data[idx + 3] = 255;
      }
    }

    return {
      bytes: PNG.sync.write(canvas),
      contentType: "image/png",
      widthPx,
      heightPx,
      hasTransparency: true,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      reconstructedWidthPx: source.width * 4,
      reconstructedHeightPx: source.height * 4,
      resolutionProvenance: "reconstructed",
      transformationMethod: "fake_dead_canvas_v1",
      preservesApprovedContent: true,
      providerRequestId: null,
      normalization: {
        strategy: "width_constrained_preserve_aspect",
        sourceWidthPx: source.width,
        sourceHeightPx: source.height,
        alphaThreshold: 8,
        alphaBBoxWidthPx: artworkWidth,
        alphaBBoxHeightPx: artworkHeight,
        trimmedWidthPx: widthPx,
        trimmedHeightPx: heightPx,
        requestedMarginPx: 0,
        appliedMarginPx: { left: 0, top: 0, right: 0, bottom: 0 },
        artworkOccupancy: (artworkWidth * artworkHeight) / (widthPx * heightPx),
        transparentPaddingFraction:
          1 - (artworkWidth * artworkHeight) / (widthPx * heightPx),
        sourceFullyOpaque: false,
        trimmedAspectRatio: widthPx / heightPx,
        outputAspectRatio: widthPx / heightPx,
        outputWidthPx: widthPx,
        outputHeightPx: heightPx,
        targetWidthIn: input.sizing.targetWidthIn,
        targetPpi: input.sizing.targetPpi,
        intendedWidthIn: widthPx / input.sizing.targetPpi,
        intendedHeightIn: heightPx / input.sizing.targetPpi,
        constrainedBy: "width",
        effectivePpiWidth: input.sizing.targetPpi,
        effectivePpiHeight: input.sizing.targetPpi,
        densityPixelsPerMetre: null,
        contentScale: 1,
      },
    };
  }
}

/** Fake `ConceptEvaluationProvider` used to control PRODUCTION-asset re-verification independently of the source concept's own persisted evaluation. */
class FakeProductionEvaluationProvider implements ConceptEvaluationProvider {
  readonly providerKey = "fake_production_evaluation";
  constructor(private readonly result: ConceptEvaluationResult) {}
  async evaluate(_request: ConceptEvaluationRequest): Promise<ConceptEvaluationResult> {
    return this.result;
  }
}

function passingProductionEvaluationResult(): ConceptEvaluationResult {
  return {
    overallScore: 95,
    passed: true,
    confidence: 95,
    status: "passed",
    criteria: [
      { key: "required_wording", score: 100, passed: true, confidence: 95, notes: null },
    ],
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
  };
}

function failingProductionEvaluationResult(): ConceptEvaluationResult {
  return {
    overallScore: 20,
    passed: false,
    confidence: 90,
    status: "failed",
    criteria: [
      { key: "required_wording", score: 0, passed: false, confidence: 90, notes: "missing on reconstructed output" },
    ],
    warnings: [],
    recommendations: [],
    missingRequirements: ["required wording"],
    matchedRequirements: [],
    providerMetadata: {},
  };
}

/**
 * Sprint 2M Phase 2C — Goal 19 acceptance coverage. Uses a real, valid PNG
 * fixture (opaque colored square on a transparent canvas) so the worker
 * exercises a genuine `pngjs` decode/resample/encode cycle end to end,
 * mirroring Goal 18's "deterministic fixture representing a real current
 * concept" requirement. No paid provider call anywhere in this file (Goal
 * 20/W) — `LocalRasterInterpolationProvider` is local/deterministic and
 * `PrintValidationCapability` is pure.
 */
/**
 * Print-Ready Normalization Phase 1: the default source size for scenarios
 * that expect a genuinely print-ready sleeve plate. The fixture's visible
 * artwork is only 80% of its canvas, and production sizing is now measured
 * against the TRIMMED artwork, so a 1024px fixture's ~820px of real artwork no
 * longer honestly covers a 3in sleeve at 300 PPI (900px). 1400px does
 * (~1120px of artwork), which is the point: sufficiency is judged on artwork
 * pixels, never on padded canvas pixels.
 */
const DEFAULT_SOURCE_PX = 1400;

function buildFixturePng(size = DEFAULT_SOURCE_PX): Buffer {
  const png = new PNG({ width: size, height: size });
  const margin = Math.floor(size * 0.1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
      png.data[idx] = 10;
      png.data[idx + 1] = 10;
      png.data[idx + 2] = 10;
      png.data[idx + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function conceptEvaluationFixture(
  overrides: Partial<ConceptEvaluation> = {},
): ConceptEvaluation {
  return {
    overallScore: 90,
    passed: true,
    confidence: 90,
    criteria: [
      { key: "required_wording", score: 100, passed: true, confidence: 90, notes: null },
    ],
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
    ...overrides,
  };
}

describe("FinalArtworkWorkerCapability (Sprint 2M Phase 2C)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-final-artwork-worker-"));
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
    provider: FinalArtworkProvider = new LocalRasterInterpolationProvider(),
    conceptEvaluationProvider?: ConceptEvaluationProvider,
  ) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = conceptEvaluationProvider
      ? createFinalArtworkWorkerCapability(
          repo,
          assets,
          provider,
          printValidation,
          createConceptEvaluationCapability(conceptEvaluationProvider),
        )
      : createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);
    return { assets, finalArtwork, worker };
  }

  interface SetupOptions {
    printPlacement?: PrintPlacement | null;
    productSummary?: string;
    designDescription?: string;
    withSourceAsset?: boolean;
    sourceBytesOverride?: Buffer;
    evaluationOverrides?: Partial<ConceptEvaluation>;
    /**
     * Sprint A2 (corrected): a customer message to drive through the REAL
     * intent-extraction path before the brief is approved, so a test can
     * prove the conversation → structured brief state → finalization → worker
     * chain rather than hand-setting the field. Uses the deterministic
     * resolver only — no provider, no paid call.
     */
    customerMessage?: string;
  }

  /** Drives a project to "a real selected concept with a real generated PNG asset", the exact state a customer's "Prepare Print-Ready Artwork" click starts from. */
  async function setupProjectWithConcept(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    assets: ReturnType<typeof buildPipeline>["assets"],
    options: SetupOptions = {},
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: options.productSummary ?? "T-shirt",
      designDescription: options.designDescription ?? "A bear mascot",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      printPlacement: options.printPlacement === undefined ? "sleeve" : options.printPlacement,
    });

    const designBrief = createDesignBriefCapability(repo);

    // Sprint A2 (corrected): the real authority path — a customer message is
    // interpreted ONCE, here, and persisted on the working brief. Nothing
    // downstream re-reads the sentence; the worker reads the stored value.
    if (options.customerMessage !== undefined) {
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

    const version = await designBrief.approveWorkingBrief(projectId);

    let primaryAssetId: string | null = null;
    if (options.withSourceAsset !== false) {
      const { primary } = await assets.uploadConceptImage(projectId, {
        conceptId: randomUUID(),
        bytes: options.sourceBytesOverride ?? buildFixturePng(),
        contentType: "image/png",
        widthPx: DEFAULT_SOURCE_PX,
        heightPx: DEFAULT_SOURCE_PX,
        hasTransparency: true,
        providerKey: "test",
        generationJobId: null,
        metadata: {},
      });
      primaryAssetId = primary.id;
    }

    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "concept",
        title: "Concept 1",
        summary: "A bear mascot design",
        placeholderLabel: "Concept 1",
        accentColor: "#000000",
        designBriefVersionId: version.id,
        generationJobId: null,
        primaryAssetId,
        thumbnailAssetId: null,
        providerKey: "test",
        evaluationStatus: "passed",
        evaluation: conceptEvaluationFixture(options.evaluationOverrides),
        evaluationEvaluatedAt: new Date().toISOString(),
        evaluationProviderKey: "test",
      },
    ]);
    await repo.selectArtworkVersion(projectId, artwork!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default so this file's scenarios
    // (all about what the worker does once finalization is authorized)
    // continue to exercise `requestFinalArtwork` the same way as before.
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });
    // Print'em All Phase 1: production work now requires an explicit human
    // confirmation of the physical print size. These scenarios are about what
    // happens once finalization is authorized, so they perform that
    // confirmation here — the same act a customer performs on the size card.
    await confirmProductionSizeForTests(repo, projectId);

    return { projectId, versionId: version.id, artworkId: artwork!.id, primaryAssetId };
  }

  // --- A: queued → claimed atomically ---------------------------------
  it("A: a queued job is atomically claimed and runs to completion", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets);

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(job.status, "queued");

    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, job.id);

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
  });

  // --- B: double worker claim does not duplicate ------------------------
  it("B: two workers racing for one job — exactly one claims it", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);

    const workerA = buildPipeline(repo).worker;
    const workerB = buildPipeline(repo).worker;

    const [resultA, resultB] = await Promise.all([
      workerA.processNextJob(),
      workerB.processNextJob(),
    ]);
    const claimed = [resultA.processedJobId, resultB.processedJobId].filter(
      (id): id is string => id !== null,
    );
    assert.equal(claimed.length, 1, "exactly one worker should have claimed the job");

    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1, "no duplicate production asset");
  });

  // --- C: exact active FinalDirectionApproval required -------------------
  it("C: a job referencing a nonexistent approval fails cleanly", async () => {
    const repo = await freshRepo();
    const { assets, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets);

    const job = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "generated_concept",
      finalDirectionApprovalId: "00000000-0000-0000-0000-000000000000",
      artworkVersionId: artworkId,
      requestedProductionOutput: "production_png",
      productionWidthIn: 10.5,
    });

    await worker.processNextJob();
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /no longer exists/i);
  });

  // --- D: superseded approval rejected ------------------------------------
  it("D: a job whose approval was superseded before it ran is cancelled, not processed", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets);
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    await repo.supersedeActiveFinalDirectionApproval(projectId);

    await worker.processNextJob();
    const cancelled = await repo.getFinalArtworkJob(job.id);
    assert.equal(cancelled?.status, "cancelled");

    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 0, "no production asset for a superseded approval");
  });

  // --- E: source concept asset required -----------------------------------
  it("E: a concept with no source image asset fails cleanly instead of fabricating one", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      withSourceAsset: false,
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    await worker.processNextJob();
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /no source image asset/i);
  });

  // --- F: cross-project source rejected -----------------------------------
  it("F: a concept whose primaryAssetId resolves to another project's asset is rejected, never used", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);

    const otherProject = await repo.createProject();
    const { primary: foreignAsset } = await assets.uploadConceptImage(otherProject.project.id, {
      conceptId: randomUUID(),
      bytes: buildFixturePng(1024),
      contentType: "image/png",
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });

    const created = await repo.createProject();
    const projectId = created.project.id;
    await repo.updateBrief(projectId, {
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      printPlacement: "sleeve",
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(projectId);

    // Simulated corrupted provenance: this project's concept points at
    // another project's asset id (never possible through the normal
    // generation pipeline, but the worker must defend against it anyway).
    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "concept",
        title: "Concept 1",
        summary: "x",
        placeholderLabel: "Concept 1",
        accentColor: "#000000",
        designBriefVersionId: version.id,
        primaryAssetId: foreignAsset.id,
        evaluationStatus: "passed",
        evaluation: conceptEvaluationFixture(),
        evaluationEvaluatedAt: new Date().toISOString(),
        evaluationProviderKey: "test",
      },
    ]);
    await repo.selectArtworkVersion(projectId, artwork!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default so this file's scenarios
    // (all about what the worker does once finalization is authorized)
    // continue to exercise `requestFinalArtwork` the same way as before.
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });
    // Print'em All Phase 1: production work now requires an explicit human
    // confirmation of the physical print size. These scenarios are about what
    // happens once finalization is authorized, so they perform that
    // confirmation here — the same act a customer performs on the size card.
    await confirmProductionSizeForTests(repo, projectId);

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artwork!.id);
    await worker.processNextJob();

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /could not be resolved for this project/i);
  });

  // --- G: target print dimensions resolved correctly ----------------------
  it("G: sleeve resolves to 900px wide (3in); full-back resolves to 3150px wide (10.5in), with height from the artwork", async () => {
    const repoA = await freshRepo();
    const { assets: assetsA, finalArtwork: finalArtworkA, worker: workerA } = buildPipeline(repoA);
    const sleeve = await setupProjectWithConcept(repoA, assetsA, { printPlacement: "sleeve" });
    await finalArtworkA.requestFinalArtwork(sleeve.projectId, sleeve.artworkId);
    await workerA.processNextJob();
    const sleeveAsset = (await repoA.listAssets(sleeve.projectId)).find(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(sleeveAsset?.widthPx, 900);
    assert.equal(sleeveAsset?.heightPx, 900);

    const repoB = await freshRepo();
    const { assets: assetsB, finalArtwork: finalArtworkB, worker: workerB } = buildPipeline(repoB);
    const fullBack = await setupProjectWithConcept(repoB, assetsB, { printPlacement: "full_back" });
    await finalArtworkB.requestFinalArtwork(fullBack.projectId, fullBack.artworkId);
    await workerB.processNextJob();
    const fullBackAsset = (await repoB.listAssets(fullBack.projectId)).find(
      (a) => a.productionRole === "production_png",
    );
    // 10.5in at 300 PPI. The fixture's artwork is square, so the plate is
    // square too — NEVER forced to the old fixed 3600x4200 canvas.
    assert.equal(fullBackAsset?.widthPx, 3150);
    assert.equal(fullBackAsset?.heightPx, 3150);
    assert.notEqual(fullBackAsset?.heightPx, 4200);
  });

  /**
   * Live Acceptance Cleanup — Issue 5, end to end.
   *
   * The customer's chosen production WIDTH is authoritative, and the 300-DPI
   * guarantee holds at whatever they chose. The width reaches the worker only
   * through persisted production intent (`TShirtDesignBrief.intendedPrintWidthIn`)
   * — there is no size parameter anywhere on the finalize request path, so a
   * stale or forged request cannot override it, and nothing is ever inferred
   * from the pixels the generator happened to produce.
   */
  /* ---------------------------------------------------------------------
   * Print'em All Phase 1 — the create_new path uses the SAME production size
   * authority as the upload path, and is fenced the same way.
   * ------------------------------------------------------------------- */

  it("P1/J: a create_new project with no confirmed size creates no job and reaches no provider", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    // Deliberately NOT confirmed — `setupProjectWithConcept` confirms by
    // default, so this scenario opts out to reproduce the unconfirmed state.
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "full_back",
    });
    await repo.updateBrief(projectId, {
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
    });

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, artworkId),
      /Confirm the print size before preparation/,
    );

    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, null, "no job exists to be claimed");
    const plate = (await repo.listAssets(projectId)).find(
      (asset) => asset.productionRole === "production_png",
    );
    assert.equal(plate, undefined);
  });

  it("M: a create_new job queued for one confirmed size is superseded when a different one is confirmed", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "full_front",
    });

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(job.productionWidthIn, 10.5, "bound to the confirmed size at enqueue");

    // The operator confirms a bigger print while the job sits queued.
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 12 });

    await worker.processNextJob();

    // Goal 12: the old job must not dispatch. It is superseded before any
    // provider — local or paid — is contacted, and produces nothing.
    const settled = await repo.getFinalArtworkJob(job.id);
    assert.equal(settled?.status, "cancelled");
    assert.match(settled?.lastError ?? "", /No provider work was performed/);
    assert.equal(
      (await repo.listAssets(projectId)).some(
        (asset) => asset.finalArtworkJobId === job.id,
      ),
      false,
    );

    // And the reverse direction is stale too: a job for 12in does not become
    // current again just because the number moved back down.
    const bigger = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.notEqual(bigger.job.id, job.id, "a different size is a different job");
    assert.equal(bigger.job.productionWidthIn, 12);

    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5 });
    await worker.processNextJob();
    assert.equal(
      (await repo.getFinalArtworkJob(bigger.job.id))?.status,
      "cancelled",
    );
  });

  it("18/20: a chosen 12in width produces a 3600px-wide plate at 300 DPI", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "full_front",
    });

    // Print'em All Phase 1 (Goal 11): a deliberate 12in oversize is CONFIRMED
    // and honored — never quietly pulled back to the 10.5in standard adult
    // recommendation. The recommendation and the technical limit (4-14in on a
    // full front) are separate things, and only the second one bounds this.
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 12 });

    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const plate = (await repo.listAssets(projectId)).find(
      (asset) => asset.productionRole === "production_png",
    );
    assert.equal(plate?.widthPx, 3600, "12in x 300 PPI");
    // The fixture artwork is square, so the plate is too.
    assert.equal(plate?.heightPx, 3600);
    // And never the standard default the customer chose away from.
    assert.notEqual(plate?.widthPx, 3150);

    const normalization = plate!.metadata.normalization as Record<string, unknown>;
    assert.equal(normalization.targetWidthIn, 12);
    assert.equal(normalization.intendedWidthIn, 12);
    assert.equal(normalization.targetPpi, 300);
    // Effective resolution is arithmetic on the plate itself, never a claim.
    assert.equal(
      (plate!.widthPx as number) / (normalization.intendedWidthIn as number),
      300,
    );
  });

  it("22: with no chosen width the placement default still applies, unchanged", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "full_front",
    });

    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const plate = (await repo.listAssets(projectId)).find(
      (asset) => asset.productionRole === "production_png",
    );
    assert.equal(plate?.widthPx, 3150, "10.5in x 300 PPI");
  });

  // --- Print-Ready Normalization Phase 1: plate geometry and metadata -------
  it("the production plate is trimmed to the artwork, carries 300-PPI density, and records its own geometry", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const asset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    )!;
    const normalization = (asset.metadata as Record<string, unknown>)
      .normalization as Record<string, unknown>;

    assert.equal(normalization.strategy, "width_constrained_preserve_aspect");
    assert.equal(normalization.intendedWidthIn, 3);
    assert.equal(normalization.intendedHeightIn, 3);
    assert.equal(normalization.targetPpi, 300);
    // The fixture is 1400px with a 10% transparent border on each side.
    assert.equal(normalization.alphaBBoxWidthPx, 1120);
    assert.equal(normalization.trimmedWidthPx, 1136, "1120 + 8px safety margin per edge");
    assert.ok((normalization.artworkOccupancy as number) > 0.97);

    const bytes = await assets.downloadAssetBytes(asset.id);
    const density = readPhysicalPixelDensity(bytes!.bytes);
    assert.equal(density?.pixelsPerMetreX, 11811, "~300 PPI in pixels per metre");

    // N: the normalized plate passes authoritative validation, including every
    // new normalization check.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation?.status, "ready");
    const report = validation!.report as { checks: { check: string; status: string }[] };
    for (const check of [
      "production_normalization",
      "alpha_bound_artwork",
      "transparent_dead_canvas",
      "physical_width_policy",
      "aspect_ratio_preserved",
      "effective_resolution",
    ]) {
      assert.equal(
        report.checks.find((c) => c.check === check)?.status,
        "pass",
        `${check} should pass for a correctly normalized plate`,
      );
    }
    assert.equal(
      report.checks.find((c) => c.check === "density_metadata")?.status,
      "pass",
    );
  });

  // --- O: the approved creative source is never modified --------------------
  it("O: the approved concept's own asset bytes are untouched by production normalization", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId, primaryAssetId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });

    const before = await assets.downloadAssetBytes(primaryAssetId!);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();
    const after = await assets.downloadAssetBytes(primaryAssetId!);

    assert.deepEqual(after!.bytes, before!.bytes, "creative source bytes are unchanged");
    assert.deepEqual(before!.bytes, buildFixturePng(), "and still the original fixture");

    const sourceAsset = await repo.getAssetById(primaryAssetId!);
    assert.equal(sourceAsset?.widthPx, DEFAULT_SOURCE_PX);
    assert.equal(sourceAsset?.productionRole, null);
  });

  // --- M: excessive transparent dead canvas fails validation ---------------
  it("M: a plate that is mostly transparent dead canvas fails validation and never reaches print_ready", async () => {
    const repo = await freshRepo();
    // A provider that skips normalization entirely and emits the old-style
    // fixed padded canvas — exactly the shape the Print-Ready Production
    // Output Audit found in production.
    const { assets, finalArtwork, worker } = buildPipeline(repo, new DeadCanvasProvider());
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation?.status, "finalization_required");
    const report = validation!.report as { checks: { check: string; status: string }[] };
    assert.equal(
      report.checks.find((c) => c.check === "transparent_dead_canvas")?.status,
      "fail",
    );

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
    assert.notEqual(project?.project.status, "print_ready");
  });

  // --- H/Q: effective-resolution honesty; not-ready never sets print_ready --
  it("H/Q: an interpolated-upscale full-back production asset is honestly finalization_required, never print_ready", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "full_back",
    });
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
    assert.notEqual(project?.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      (await repo.getFinalArtworkJobByApprovalId(
        projectId,
        (await repo.getActiveFinalDirectionApproval(projectId))!.id,
      ))!.id,
    );
    assert.equal(validation?.status, "finalization_required");
    const report = validation!.report as { checks: { check: string; status: string }[] };
    const effectiveResolution = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(effectiveResolution?.status, "fail");
  });

  // --- I/J/M: production asset provenance and validation scoping ----------
  it("I/J/M: production asset carries finalArtworkJobId + productionRole; validation targets the production asset, never the source", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId, primaryAssetId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const productionAsset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    );
    assert.ok(productionAsset);
    assert.equal(productionAsset?.finalArtworkJobId, job.id);
    assert.equal(productionAsset?.productionRole, "production_png");
    assert.notEqual(productionAsset?.id, primaryAssetId);

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation?.assetId, productionAsset!.id);
    assert.notEqual(validation?.assetId, primaryAssetId);
  });

  // --- L: required-wording failure prevents print_ready --------------------
  it("L: a concept whose required wording failed Concept Evaluation never reaches print_ready even at native resolution", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
      evaluationOverrides: {
        criteria: [
          { key: "required_wording", score: 10, passed: false, confidence: 90, notes: "missing" },
        ],
      },
    });
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "print_ready");
    assert.equal(project?.project.status, "finalization_required");
  });

  // --- N: nothing before finalization ever sets print_ready/needs review ---
  it("N: requesting final artwork alone (before the worker runs) never sets print_ready or finalization_required", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets);
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalizing");

    // Cleanup only: `claimNextQueuedFinalArtworkJob` claims the globally
    // oldest queued job (by design — mirrors the generation worker's
    // cross-project claim). Leaving this job queued would let a later
    // test's worker claim it instead of its own newly-created job, since
    // every test in this file shares one on-disk local store. Cancelling
    // it directly (never running the worker) keeps this test's "before the
    // worker runs" assertion honest while not polluting later tests.
    await repo.updateFinalArtworkJob(job.id, { status: "cancelled" });
  });

  // --- O: unsupported OUTPUT REQUEST never reaches print_ready -------------
  // Sprint A2 split the original O in two. It used to assert that the words
  // "Embroidered patch on a T-shirt" made a garment design unfinalizable —
  // the exact defect this sprint removed. Mentioning a decoration method is
  // context (O1); asking for a stitch file is an unsupported request (O2).

  it("O1: an embroidery MENTION still produces the raster Production PNG and reaches print_ready", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      productSummary: "Embroidered patch on a T-shirt",
      printPlacement: "left_chest",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");

    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(
      productionAssets.length,
      1,
      "a decoration-method mention must not cost the customer their Production PNG",
    );

    // print_ready keeps its one meaning: this PNG passed authoritative
    // validation for the supported RASTER profile. It is not, and is never
    // described as, a digitized embroidery file.
    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "print_ready");
  });

  // Sprint A2 (corrected) — Goal 15: the REAL authority chain, end to end.
  // A customer sentence is interpreted once at the conversation layer,
  // persisted as structured brief state, survives brief approval, and is what
  // the worker gate reads. Nothing here re-interprets prose at finalization.
  it("O2: a chat request for embroidery digitization persists and stops finalization at the worker", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      productSummary: "T-shirt",
      printPlacement: "left_chest",
      customerMessage: "please digitize this for embroidery and send me the DST",
    });

    // Q/P: the interpretation became durable structured state — and survived
    // brief approval, which happens after it in `setupProjectWithConcept`.
    const afterApproval = await repo.getProject(projectId);
    assert.equal(
      afterApproval?.brief.requestedProductionOutput,
      "embroidery_digitization",
      "the customer's request must be persisted, not re-derived later",
    );

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.lastError ?? "", /does not produce/i);
    assert.match(completed?.lastError ?? "", /embroidery_digitization/i);

    // S: cannot reach print_ready.
    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
    assert.notEqual(project?.project.status, "print_ready");

    // U: no production asset, so no provider work was dispatched for it.
    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(
      productionAssets.length,
      0,
      "never answers a request for a stitch file with a raster PNG",
    );

    // Goal 10: a deterministic unsupported request is not a retryable
    // provider failure. The job is `completed`, so the customer view is the
    // terminal `needs_review` rather than `retryable_failure`, polling stops,
    // and nothing auto-retries or enqueues a duplicate.
    assert.notEqual(completed?.status, "failed");

    // Running the worker again must find nothing to do — a completed
    // determination is terminal, never re-queued or retried.
    await worker.processNextJob();
    const stillCompleted = await repo.getFinalArtworkJob(job.id);
    assert.equal(stillCompleted?.status, "completed");
    assert.equal(stillCompleted?.attempts, completed?.attempts);
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      0,
    );
  });

  it("O2b: a customer can retract the request and then finalize normally", async () => {
    // The decisive reason this field lives on the mutable working brief
    // rather than a frozen approved snapshot: one sentence must never strand
    // a project permanently.
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      productSummary: "T-shirt",
      printPlacement: "left_chest",
      customerMessage: "can you make the color separations",
    });
    assert.equal(
      (await repo.getProject(projectId))?.brief.requestedProductionOutput,
      "screen_print_separations",
    );

    const designBrief = createDesignBriefCapability(repo);
    const retraction = createIntentExtractionCapability().extract({
      brief: await designBrief.getWorkingBrief(projectId),
      phase: "interviewing",
      reply: "never mind the separations, just give me the PNG",
      pendingSection: null,
      understanding: null,
    });
    for (const proposal of retraction.proposals) {
      await designBrief.applyProposal(projectId, proposal);
    }
    assert.equal(
      (await repo.getProject(projectId))?.brief.requestedProductionOutput,
      "production_png",
    );

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");
    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1, "retraction restores the normal path");
  });

  it("O2c: chat that only MENTIONS a method never blocks finalization", async () => {
    // The regression that started this sprint, proven through the real path.
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      productSummary: "T-shirt",
      printPlacement: "left_chest",
      customerMessage:
        "I need a logo for a screen printed t-shirt, and no separations are needed since I already have the DST file",
    });

    assert.equal(
      (await repo.getProject(projectId))?.brief.requestedProductionOutput,
      null,
      "decoration context, negation, and possession are not production requests",
    );

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");
    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1);
    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
  });

  it("O3: a non-apparel product is refused as out of product scope, not as an unbuilt production profile", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      productSummary: "Vinyl banner for a grand opening",
      printPlacement: "left_chest",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.lastError ?? "", /outside the iHeartPrints product scope/i);

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");

    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 0);
  });

  // --- P: validation ready → project print_ready ---------------------------
  it("P: a sleeve concept whose native resolution already meets the target validates ready and reaches print_ready", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "print_ready");

    const asset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    );
    const meta = asset?.metadata as Record<string, unknown>;
    assert.equal(meta.resolutionProvenance, "native");
  });

  // --- R: idempotent retry --------------------------------------------------
  it("R: reprocessing an already-completed job's production asset never creates a duplicate", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const firstAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(firstAssets.length, 1);
    const firstAssetId = firstAssets[0]!.id;

    // Simulate a retried/recovered claim of the same job.
    await repo.updateFinalArtworkJob(job.id, { status: "queued" });
    await worker.processNextJob();

    const secondAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(secondAssets.length, 1, "no duplicate production asset on retry");
    assert.equal(secondAssets[0]!.id, firstAssetId, "the same asset is reused");

    // Print-Ready Normalization Phase 1 (P): the reused plate's own persisted
    // normalization geometry is read back, so the retry re-reaches the SAME
    // honest verdict instead of re-deriving or losing it.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation?.status, "ready");
    const report = validation!.report as { checks: { check: string; status: string }[] };
    assert.equal(
      report.checks.find((c) => c.check === "production_normalization")?.status,
      "pass",
    );
    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "print_ready");
  });

  // --- Print-Ready Normalization Phase 1: pre-normalization plates ----------
  it("a production asset predating normalization is honestly reported as needing re-preparation, and is never deleted or rewritten", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    // A plate created before this phase: real bytes, real provenance, but no
    // recorded production geometry. Seeded directly so the worker takes its
    // idempotent "reuse the existing production asset" path (Goal 16) against
    // pre-normalization metadata.
    const legacyBytes = buildFixturePng(900);
    const legacyAsset = await assets.uploadProductionAsset(projectId, {
      conceptId: job.finalDirectionApprovalId!,
      bytes: legacyBytes,
      contentType: "image/png",
      widthPx: 900,
      heightPx: 900,
      hasTransparency: true,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {
        transformationMethod: "local_raster_contain_resample_v1",
        providerKey: "local_raster_interpolation",
        resolutionProvenance: "native",
        nativeWidthPx: 1400,
        nativeHeightPx: 1400,
        reconstructedWidthPx: null,
        reconstructedHeightPx: null,
        preservesApprovedContent: true,
        providerRequestId: null,
      },
    });

    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.lastError ?? "", /predates print-ready normalization/i);

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");

    // The existing asset is untouched — never invalidated, deleted, or
    // regenerated by this phase.
    const stillThere = await repo.getAssetById(legacyAsset.id);
    assert.ok(stillThere);
    assert.deepEqual(
      (await assets.downloadAssetBytes(legacyAsset.id))!.bytes,
      legacyBytes,
    );
    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1, "no replacement plate was produced");
  });

  // --- S: stale-job recovery -------------------------------------------------
  it("S: a job abandoned mid-run (stale heartbeat) is recovered and completes on the next claim", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    const claimed = await repo.claimNextQueuedFinalArtworkJob();
    assert.equal(claimed?.id, job.id);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateFinalArtworkJob(job.id, { heartbeatAt: longAgo, startedAt: longAgo });

    const { recoveredCount } = await worker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recoveredCount, 1);

    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, job.id);

    const finished = await repo.getFinalArtworkJob(job.id);
    assert.equal(finished?.status, "completed");
  });

  // --- T: failed finalization preserves source concept and approval --------
  it("T: a transformation failure preserves the source concept and approval, and can be retried", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
      sourceBytesOverride: Buffer.from("not actually a png"),
    });
    const { job, approval } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    await worker.processNextJob();
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");

    const snapshot = await repo.getProject(projectId);
    const artwork = snapshot!.artworkVersions.find((a) => a.id === artworkId);
    assert.ok(artwork, "source concept still exists");

    const stillActive = await repo.getActiveFinalDirectionApproval(projectId);
    assert.equal(stillActive?.id, approval.id);
    assert.equal(stillActive?.status, "active");

    // Retry path: requesting final artwork again revives the failed job.
    const retried = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(retried.job.id, job.id);
    const revived = await repo.getFinalArtworkJob(job.id);
    assert.equal(revived?.status, "queued");

    // Cleanup only (see N's comment): drain the revived job so it doesn't
    // get claimed ahead of a later test's own job in the shared store.
    await repo.updateFinalArtworkJob(job.id, { status: "cancelled" });
  });

  // --- U: storage keys/internal ids remain customer-hidden ------------------
  it("U: the customer snapshot never exposes production asset ids, job ids, or storage keys, whether print_ready or needs_review", async () => {
    const repo = await freshRepo();
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const conversationService = await import("@/lib/services/conversation-service");
    const snapshot = await conversationService.getConversation(projectId);
    assert.equal(snapshot?.finalization.status, "print_ready");

    const productionAsset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    )!;
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(productionAsset.id), false);
    assert.equal(serialized.includes(productionAsset.storageKey ?? " "), false);
    assert.equal(serialized.includes("finalArtworkJobId"), false);
    assert.deepEqual(Object.keys(snapshot!.finalization), ["status"]);
  });

  // =========================================================================
  // Sprint A2 Correction 2 — production-intent lifecycle (Goals 5/6/7/16)
  // =========================================================================
  //
  // `requestedProductionOutput` is mutable by design: customers change their
  // minds. Every test below is a moment where that mutability could produce a
  // lie — a job spending money on work nobody wants, or claiming `print_ready`
  // for a question that is no longer being asked.

  /**
   * Every test in this describe shares one local DB, and the worker claims
   * the globally-oldest queued job rather than a specific project's. These
   * lifecycle tests each drive the worker deliberately, so anything left
   * queued by an earlier test has to be retired first or it would be claimed
   * instead. (Mirrors `prepared-upload-finalization.test.ts`'s own helper.)
   */
  async function retireQueuedJobs(
    repo: Awaited<ReturnType<typeof freshRepo>>,
  ): Promise<void> {
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

  /** Change the project's CURRENT production intent, as a conversation turn would. */
  async function setCurrentIntent(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    projectId: string,
    requestedProductionOutput: "production_png" | "screen_print_separations" | null,
  ) {
    await repo.updateBrief(projectId, { requestedProductionOutput });
  }

  async function customerStatus(projectId: string) {
    const conversationService = await import("@/lib/services/conversation-service");
    return (await conversationService.getFinalizationStatus(projectId))?.status;
  }

  it("K: a create_new job snapshots the current intent at enqueue and never re-reads it", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(job.requestedProductionOutput, "production_png");

    // The project's intent moves; the JOB's does not.
    await setCurrentIntent(repo, projectId, "screen_print_separations");
    const reread = await repo.getFinalArtworkJob(job.id);
    assert.equal(reread?.requestedProductionOutput, "production_png");
  });

  it("C/N/P: a queued PNG job whose intent changed before the worker runs is superseded, not run", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    await setCurrentIntent(repo, projectId, "screen_print_separations");
    await worker.processNextJob();

    const settled = await repo.getFinalArtworkJob(job.id);
    // `cancelled`, never `failed`: nothing broke, and `failed` is the one
    // status the customer view reads as "try again".
    assert.equal(settled?.status, "cancelled");
    assert.match(settled?.lastError ?? "", /superseded/i);

    // N/P: no plate, and no print_ready claim.
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      0,
    );
    assert.notEqual((await repo.getProject(projectId))?.project.status, "print_ready");

    // Q: the customer sees their CURRENT (unsupported) request's state.
    assert.equal(await customerStatus(projectId), "needs_review");
  });

  it("F/P: a PNG job that finishes producing after the intent changed never claims print_ready", async () => {
    // The post-provider case (Goal 5D): the work is already done and paid
    // for. It is not thrown away — but it does not get to answer a question
    // nobody asked. The plate stays; the claim does not happen.
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    // Change the intent from inside the provider call — i.e. after dispatch,
    // before the status transition. This is the exact race Codex found.
    const racingWorker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      {
        providerKey: "racing_local",
        async produce(input) {
          await setCurrentIntent(repo, projectId, "screen_print_separations");
          return new LocalRasterInterpolationProvider().produce(input);
        },
      },
      createPrintValidationCapability(),
    );
    await racingWorker.processNextJob();

    // The plate really was produced — this is not a test of "nothing ran".
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      1,
    );
    // …and it did NOT flip the project to print_ready.
    assert.notEqual((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "needs_review");
    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");

    void worker;
  });

  it("G/Q/R: an existing print_ready PNG stops answering a new unsupported request, and returns when retracted", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();
    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "print_ready");

    // G: the customer now asks for separations.
    await setCurrentIntent(repo, projectId, "screen_print_separations");
    assert.equal(
      await customerStatus(projectId),
      "needs_review",
      "a stale print_ready must not answer a new, unmet request",
    );
    // The artifact itself is NOT destroyed — only its claim to be the answer.
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      1,
    );
    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");

    // R: they change their mind back. The already-produced plate answers again.
    await setCurrentIntent(repo, projectId, "production_png");
    assert.equal(await customerStatus(projectId), "print_ready");
  });

  it("I: PNG → unsupported → PNG reuses the existing job rather than paying again", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const first = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    await setCurrentIntent(repo, projectId, "screen_print_separations");
    const unsupported = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.notEqual(
      unsupported.job.id,
      first.job.id,
      "M: a different requested output is a different job, never the PNG job reinterpreted",
    );
    assert.equal(unsupported.job.requestedProductionOutput, "screen_print_separations");
    await worker.processNextJob();
    assert.notEqual((await repo.getProject(projectId))?.project.status, "print_ready");

    await setCurrentIntent(repo, projectId, "production_png");
    const back = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(back.job.id, first.job.id, "the original PNG job is reused");

    // Exactly one plate ever existed — no duplicate production work.
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      1,
    );
  });

  it("H: a completed unsupported job never blocks a retraction to PNG", async () => {
    // The scenario Codex found broken: the unsupported job was returned as
    // "already requested", so nothing ever ran and the project was stuck.
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    await setCurrentIntent(repo, projectId, "screen_print_separations");
    const unsupported = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();
    assert.equal((await repo.getFinalArtworkJob(unsupported.job.id))?.status, "completed");
    assert.equal(await customerStatus(projectId), "needs_review");

    await setCurrentIntent(repo, projectId, "production_png");
    // The unsupported job is not the current one, so the customer is offered
    // the action again rather than a stale verdict.
    assert.equal(await customerStatus(projectId), "not_requested");

    const png = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.notEqual(png.job.id, unsupported.job.id);
    await worker.processNextJob();

    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "print_ready");
  });

  it("J: a stale tab's finalize request cannot restore an outdated intent", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });

    // Tab B changes the intent. Tab A, still showing the old UI, clicks
    // Prepare. The server's persisted authority — not the caller — decides.
    await setCurrentIntent(repo, projectId, "screen_print_separations");
    const staleTabRequest = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    assert.equal(
      staleTabRequest.job.requestedProductionOutput,
      "screen_print_separations",
      "the job is bound to the CURRENT server-side intent, not the tab's stale view",
    );
    await worker.processNextJob();
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      0,
    );
    assert.equal(await customerStatus(projectId), "needs_review");
  });

  it("B/S: an unreadable stored intent fails closed and leaks nothing", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    // A value written by a newer deploy that this build has never heard of.
    await repo.updateBrief(projectId, {
      requestedProductionOutput:
        "holographic_foil_separations" as unknown as "production_png",
    });

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    // No plate, no print_ready — never a silent downgrade to "they must have
    // wanted a PNG".
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      0,
    );
    assert.notEqual((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "needs_review");

    // S: the unreadable value never reaches the customer.
    const conversationService = await import("@/lib/services/conversation-service");
    const snapshot = await conversationService.getConversation(projectId);
    const serialized = JSON.stringify(snapshot?.finalization);
    assert.equal(serialized.includes("holographic_foil_separations"), false);
    assert.equal(serialized.includes("unrecognized"), false);
    void job;
  });

  // -------------------------------------------------------------------------
  // Sprint A2 Correction 3 — completed-job reuse + delivery authority
  // -------------------------------------------------------------------------

  /** Counts production calls so "was work repeated?" is observable. */
  class CountingProvider implements FinalArtworkProvider {
    readonly providerKey = "local_raster_interpolation";
    submitCount = 0;
    private readonly inner = new LocalRasterInterpolationProvider();
    async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
      this.submitCount += 1;
      return this.inner.produce(input);
    }
  }

  it("A/B/C/D/M/N: PNG → unsupported → PNG restores print_ready, reusing the plate with no second submission", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const provider = new CountingProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, provider);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const conversationService = await import("@/lib/services/conversation-service");

    // --- PNG produced and validated -----------------------------------------
    const original = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();
    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(provider.submitCount, 1);

    const plates = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(plates.length, 1);
    const originalPlateId = plates[0]!.id;
    // CASE A: delivery available for the current request.
    assert.ok(await conversationService.getProductionArtworkUrl(projectId));

    // --- customer asks for something we do not produce ----------------------
    await setCurrentIntent(repo, projectId, "screen_print_separations");
    const unsupported = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.notEqual(unsupported.job.id, original.job.id);
    await worker.processNextJob();

    assert.equal(await customerStatus(projectId), "needs_review");
    // E/F/CASE B: the historical plate still EXISTS, and is no longer offered
    // as fulfillment of a request it does not answer.
    assert.equal(
      (await repo.listAssets(projectId)).filter(
        (a) => a.productionRole === "production_png",
      ).length,
      1,
    );
    assert.equal(await conversationService.getProductionArtworkUrl(projectId), null);
    assert.equal(await conversationService.getProductionArtworkDownload(projectId), null);
    // O: the OLDEST job for this approval is the PNG job and it has an asset —
    // resolving by "oldest" would wrongly hand it over. Intent decides.
    assert.equal(await finalArtwork.getCurrentProductionAssetId(projectId), null);

    // --- they change their mind back ----------------------------------------
    await setCurrentIntent(repo, projectId, "production_png");
    const reused = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(reused.job.id, original.job.id, "C: the original PNG job is reused");
    assert.equal(reused.job.status, "completed", "Goal 4: not revived to queued/running");

    // A: authoritative state is restored from the completed job's evidence.
    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "print_ready");

    // B/M: no second production submission anywhere in the round trip.
    assert.equal(provider.submitCount, 1);
    // N/C: the same single plate, never a duplicate.
    const platesAfter = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(platesAfter.length, 1);
    assert.equal(platesAfter[0]!.id, originalPlateId);

    // D/CASE C: delivery works again, pointing at the same plate.
    assert.equal(await finalArtwork.getCurrentProductionAssetId(projectId), originalPlateId);
    const delivered = await conversationService.getProductionArtworkUrl(projectId);
    assert.ok(delivered);
    assert.ok(await conversationService.getProductionArtworkDownload(projectId));
    // No internal identifier rides along with the deliverable.
    const serialized = JSON.stringify(delivered);
    for (const internal of [
      originalPlateId,
      original.job.id,
      "production_png",
      "screen_print_separations",
      "apparel_raster",
    ]) {
      assert.equal(serialized.includes(internal), false, `leaked ${internal}`);
    }
  });

  it("K/L: the unsupported job never poisons the PNG job, and never borrows its plate", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });

    await setCurrentIntent(repo, projectId, "screen_print_separations");
    const unsupported = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();
    // L: an unsupported request is satisfied by nothing, including a PNG.
    assert.equal(await finalArtwork.getCurrentProductionAssetId(projectId), null);

    // K: retracting leaves the PNG path completely unobstructed.
    await setCurrentIntent(repo, projectId, "production_png");
    const png = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.notEqual(png.job.id, unsupported.job.id);
    await worker.processNextJob();

    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "print_ready");
    assert.ok(await finalArtwork.getCurrentProductionAssetId(projectId));
  });

  it("I: a completed matching job WITHOUT ready validation never restores print_ready", async () => {
    // Goal 12, and the whole reason reconciliation reads the validation record
    // rather than the job status: `completed` only means the worker reached a
    // conclusion. Here it concluded the plate is not print-ready.
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    // full_front needs an interpolated upscale from this source, so validation
    // honestly lands short of ready.
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "full_front",
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    assert.equal((await repo.getFinalArtworkJob(job.id))?.status, "completed");
    assert.equal(
      (await repo.getProject(projectId))?.project.status,
      "finalization_required",
    );

    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      job.id,
    );
    assert.notEqual(validation?.status, "ready");

    // Re-requesting must NOT reconcile this into print_ready.
    const again = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(again.job.id, job.id);
    assert.equal(
      (await repo.getProject(projectId))?.project.status,
      "finalization_required",
    );
    assert.equal(await customerStatus(projectId), "needs_review");
    // …and nothing is delivered for an unvalidated plate.
    assert.equal(await finalArtwork.getCurrentProductionAssetId(projectId), null);
  });

  it("J/G: delivery resolves through the current-intent job, not the oldest approval job", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    const png = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    await setCurrentIntent(repo, projectId, "screen_print_separations");
    await finalArtwork.requestFinalArtwork(projectId, artworkId);

    // Both jobs belong to the same approval; the PNG one is oldest and owns
    // the only plate. The deprecated oldest-job helper still returns it —
    // which is exactly why delivery no longer goes through that helper.
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    const oldest = await repo.getFinalArtworkJobByApprovalId(projectId, approval!.id);
    assert.equal(oldest?.id, png.job.id);
    assert.equal(await finalArtwork.getCurrentProductionAssetId(projectId), null);
  });

  it("A/W: a legacy job with no bound intent still behaves as a Production PNG job", async () => {
    const repo = await freshRepo();
    await retireQueuedJobs(repo);
    const { assets, finalArtwork, worker } = buildPipeline(repo);
    const { projectId, artworkId } = await setupProjectWithConcept(repo, assets, {
      printPlacement: "sleeve",
    });
    // A historical project's brief predates the column entirely.
    await setCurrentIntent(repo, projectId, null);
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    // The job's bound intent is IMMUTABLE — `UpdateFinalArtworkJobInput`
    // deliberately cannot express a change to it, which is why this test
    // cannot (and must not) mutate it. A legacy row's NULL and a new row's
    // `"production_png"` are normalized to the same key on read, so the
    // legacy half of this scenario is pinned in the domain unit tests
    // (`normalizeProductionIntent` / `productionIntentMatches`) rather than
    // faked here by writing a value the schema treats as write-once.
    assert.equal(job.requestedProductionOutput, "production_png");

    await worker.processNextJob();
    assert.equal((await repo.getProject(projectId))?.project.status, "print_ready");
    assert.equal(await customerStatus(projectId), "print_ready");
  });
});

describe("FinalArtworkWorkerCapability — Topaz-shaped reconstruction provider (Sprint 2M Phase 2E)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-final-artwork-worker-topaz-"));
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
    provider: FinalArtworkProvider,
    conceptEvaluationProvider?: ConceptEvaluationProvider,
  ) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = conceptEvaluationProvider
      ? createFinalArtworkWorkerCapability(
          repo,
          assets,
          provider,
          printValidation,
          createConceptEvaluationCapability(conceptEvaluationProvider),
        )
      : createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);
    return { assets, finalArtwork, worker };
  }

  async function setupFullBackConcept(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    assets: ReturnType<typeof buildPipeline>["assets"],
    evaluationOverrides: Partial<ConceptEvaluation> = {},
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await repo.updateBrief(projectId, {
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
      exactText: "My 3 Sons",
      shirtColor: "Navy",
      printPlacement: "full_back",
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(projectId);

    const { primary } = await assets.uploadConceptImage(projectId, {
      conceptId: randomUUID(),
      bytes: buildFixturePng(1024),
      contentType: "image/png",
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });

    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "concept",
        title: "Concept 1",
        summary: "A bear mascot design",
        placeholderLabel: "Concept 1",
        accentColor: "#000000",
        designBriefVersionId: version.id,
        generationJobId: null,
        primaryAssetId: primary.id,
        thumbnailAssetId: null,
        providerKey: "test",
        evaluationStatus: "passed",
        evaluation: conceptEvaluationFixture(evaluationOverrides),
        evaluationEvaluatedAt: new Date().toISOString(),
        evaluationProviderKey: "test",
      },
    ]);
    await repo.selectArtworkVersion(projectId, artwork!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default so this file's scenarios
    // (all about what the worker does once finalization is authorized)
    // continue to exercise `requestFinalArtwork` the same way as before.
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });
    // Print'em All Phase 1: production work now requires an explicit human
    // confirmation of the physical print size. These scenarios are about what
    // happens once finalization is authorized, so they perform that
    // confirmation here — the same act a customer performs on the size card.
    await confirmProductionSizeForTests(repo, projectId);

    return { projectId, artworkId: artwork!.id };
  }

  // --- K/L: reconstructed provenance + three distinct dimensions -----------
  it("K/L: reports reconstructed provenance truthfully, keeping source/reconstructed/final-canvas as three distinct measurements", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider();
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const asset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    );
    assert.ok(asset);
    const meta = asset!.metadata as Record<string, unknown>;
    assert.equal(meta.resolutionProvenance, "reconstructed");
    assert.equal(meta.nativeWidthPx, 1024);
    assert.equal(meta.nativeHeightPx, 1024);
    assert.equal(meta.reconstructedWidthPx, 2048);
    assert.equal(meta.reconstructedHeightPx, 2048);
    // Normalized full-back plate — distinct from both source (1024) and
    // reconstructed (2048) dimensions, sized to 10.5in at 300 PPI with height
    // from the artwork's own (square) proportions, never a fixed 4200px canvas.
    assert.equal(asset!.widthPx, 3150);
    assert.equal(asset!.heightPx, 3150);
    assert.notEqual(asset!.heightPx, 4200);
  });

  // --- M: source eligibility gate prevents a paid call --------------------
  it("M: a source concept that already failed required-wording evaluation is rejected BEFORE any provider call", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider();
    const { assets, finalArtwork, worker } = buildPipeline(repo, reconstructionProvider);
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets, {
      criteria: [
        { key: "required_wording", score: 0, passed: false, confidence: 90, notes: "missing" },
      ],
    });
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    assert.equal(reconstructionProvider.submitCount, 0, "never spends a paid call on an ineligible source");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.lastError ?? "", /already found required wording missing/i);

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
    assert.notEqual(project?.project.status, "print_ready");

    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 0);
  });

  // --- N/U: crash after paid submission never causes a duplicate paid call --
  it("N/U: a worker crash immediately after paid submission is resumed on retry, never re-submitted", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ crashAfterSubmit: true });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    await worker.processNextJob();
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");
    // The paid request identity survived the crash — this is what makes
    // resuming (rather than resubmitting) possible.
    assert.equal(failed?.providerKey, "fake_topaz_reconstruction");
    assert.equal(failed?.providerRequestId, "fake-request-1");
    assert.equal(reconstructionProvider.submitCount, 1);

    // Customer retries via the existing "Prepare Print-Ready Artwork" action.
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    reconstructionProvider.behavior = { crashAfterSubmit: false };
    await worker.processNextJob();

    assert.equal(reconstructionProvider.submitCount, 1, "exactly one paid submission across both attempts");
    assert.equal(reconstructionProvider.resumeCount, 1, "the second attempt resumed the existing request");

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed?.status, "completed");
  });

  // --- O/S: production wording passes → authoritative ready → print_ready --
  it("O/S: independent production wording verification passing reaches print_ready", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ hasTransparency: true });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "print_ready");
  });

  // --- P/T: production wording fails → finalization_required, never inherited from the source concept's own (passing) evaluation --
  it("P/T: independent production wording verification failing blocks print_ready even though the SOURCE concept's own evaluation passed", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ hasTransparency: true });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(failingProductionEvaluationResult()),
    );
    // The source concept's OWN evaluation passes required wording — proving
    // this is never inherited across reconstruction (Goal 7).
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
    assert.notEqual(project?.project.status, "print_ready");
  });

  // --- R: production alpha failure blocks print_ready ------------------------
  it("R: an opaque reconstructed output blocks print_ready even when wording verification passes", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ hasTransparency: false });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const report = validation!.report as { checks: { check: string; status: string }[] };
    const transparency = report.checks.find((c) => c.check === "transparency");
    assert.equal(transparency?.status, "fail");
  });

  // --- X: production validation persisted against the production asset -----
  it("X: authoritative validation is persisted against the production asset, never the source concept asset", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ hasTransparency: true });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    const { job } = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const productionAsset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    )!;
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation?.assetId, productionAsset.id);
    assert.equal(validation?.status, "ready");
  });

  // --- W: stale/superseded approval never becomes print_ready even with a reconstruction provider --
  it("W: a superseded approval never reaches print_ready even after a completed reconstruction", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ hasTransparency: true });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);

    await repo.supersedeActiveFinalDirectionApproval(projectId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "print_ready");
  });

  // --- Y: customer snapshot never exposes provider request ids -------------
  it("Y: the customer snapshot never contains the provider request id or provider key", async () => {
    const repo = await freshRepo();
    const reconstructionProvider = new FakeReconstructionProvider({ hasTransparency: true });
    const { assets, finalArtwork, worker } = buildPipeline(
      repo,
      reconstructionProvider,
      new FakeProductionEvaluationProvider(passingProductionEvaluationResult()),
    );
    const { projectId, artworkId } = await setupFullBackConcept(repo, assets);
    await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await worker.processNextJob();

    const conversationService = await import("@/lib/services/conversation-service");
    const snapshot = await conversationService.getConversation(projectId);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("fake-request-1"), false);
    assert.equal(serialized.includes("fake_topaz_reconstruction"), false);
    assert.equal(serialized.includes("providerRequestId"), false);
    assert.deepEqual(Object.keys(snapshot!.finalization), ["status"]);
  });
});
