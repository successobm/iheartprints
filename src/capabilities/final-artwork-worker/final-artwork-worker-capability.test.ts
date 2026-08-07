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
import {
  createFinalArtworkCapability,
  LocalRasterInterpolationProvider,
} from "@/capabilities/final-artwork";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { ConceptEvaluation, PrintPlacement } from "@/lib/domain/types";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Sprint 2M Phase 2C — Goal 19 acceptance coverage. Uses a real, valid PNG
 * fixture (opaque colored square on a transparent canvas) so the worker
 * exercises a genuine `pngjs` decode/resample/encode cycle end to end,
 * mirroring Goal 18's "deterministic fixture representing a real current
 * concept" requirement. No paid provider call anywhere in this file (Goal
 * 20/W) — `LocalRasterInterpolationProvider` is local/deterministic and
 * `PrintValidationCapability` is pure.
 */
function buildFixturePng(size = 1024): Buffer {
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

  function buildPipeline(repo: Awaited<ReturnType<typeof freshRepo>>) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      new LocalRasterInterpolationProvider(),
      printValidation,
    );
    return { assets, finalArtwork, worker };
  }

  interface SetupOptions {
    printPlacement?: PrintPlacement | null;
    productSummary?: string;
    designDescription?: string;
    withSourceAsset?: boolean;
    sourceBytesOverride?: Buffer;
    evaluationOverrides?: Partial<ConceptEvaluation>;
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
    const version = await designBrief.approveWorkingBrief(projectId);

    let primaryAssetId: string | null = null;
    if (options.withSourceAsset !== false) {
      const { primary } = await assets.uploadConceptImage(projectId, {
        conceptId: randomUUID(),
        bytes: options.sourceBytesOverride ?? buildFixturePng(1024),
        contentType: "image/png",
        widthPx: 1024,
        heightPx: 1024,
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
      finalDirectionApprovalId: "00000000-0000-0000-0000-000000000000",
      artworkVersionId: artworkId,
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

    const { job } = await finalArtwork.requestFinalArtwork(projectId, artwork!.id);
    await worker.processNextJob();

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /could not be resolved for this project/i);
  });

  // --- G: target print dimensions resolved correctly ----------------------
  it("G: full-back placement resolves to 3600x4200px; sleeve resolves to 900x900px", async () => {
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
    assert.equal(fullBackAsset?.widthPx, 3600);
    assert.equal(fullBackAsset?.heightPx, 4200);
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

  // --- O: unsupported production method never reaches print_ready ---------
  it("O: an embroidery (unsupported) production method completes honestly without ever reaching print_ready", async () => {
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
    assert.match(completed?.lastError ?? "", /unsupported production method/i);

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
    assert.notEqual(project?.project.status, "print_ready");

    const productionAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 0, "never fabricates an asset for an unsupported method");
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
});
