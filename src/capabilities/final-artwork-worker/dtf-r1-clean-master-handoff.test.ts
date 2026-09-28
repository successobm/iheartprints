import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";
import { createArtworkGeometryQualificationCapability } from "@/capabilities/artwork-reconstruction/artwork-geometry-qualification-capability";
import { createRasterReconstructionCapability } from "@/capabilities/artwork-reconstruction/raster-reconstruction-capability";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { resolvePreparedUploadEffectiveSource } from "@/capabilities/final-artwork/prepared-upload-effective-source";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { PrintValidationReport } from "@/capabilities/print-validation/contracts";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * DTF-R1 — CLEAN-MASTER HANDOFF TO DTF PRODUCTION.
 *
 * Acceptance coverage for the ONE thing this phase changes: which artwork
 * the prepared-upload (apparel raster / DTF) production path is allowed to
 * descend from, once the shared artwork recovery lifecycle exists for a
 * project.
 *
 * NO PROVIDER IS REACHABLE HERE, AND THAT IS AN ASSERTION, NOT A SETUP
 * DETAIL. Every scenario wires a counting reconstruction provider and a
 * counting local provider, and the clean-master scenarios assert the
 * reconstruction provider's call count is ZERO — DTF-R1 must never launch
 * a reconstruction of its own, and must never re-run one the recovery
 * lifecycle already performed. The recovery lifecycle itself is built with
 * the REAL fidelity/reconstruction/geometry-qualification capabilities
 * against the REAL local repository, with no OpenAI or Topaz port wired at
 * all, so "zero provider calls" is true by construction as well.
 *
 * THE GOVERNANCE LINE THIS FILE DEFENDS (scenario I). Pedro Back's real
 * production test produced a technically valid plate and still, correctly,
 * ended `finalization_required` because authoritative Print Validation
 * withheld Print Ready on `reconstruction_certification_evidence`. DTF-R1
 * must not weaken that by handing DTF a clean master and letting the plate
 * pass because THIS job happened not to reconstruct anything. No Pedro id
 * appears anywhere in production logic or in this file — the condition is
 * reproduced from its shape, not its identity.
 */
describe("DTF-R1 — Production-Qualified Clean Master handoff to DTF production", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-dtf-r1-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * A reconstruction provider that must never be called on any DTF-R1 path.
   * It throws rather than returning a plausible result, so a silent
   * duplicate-reconstruction regression fails loudly instead of producing a
   * quietly-wrong plate.
   */
  class NeverCalledReconstructionProvider implements FinalArtworkProvider {
    readonly providerKey = "dtf_r1_never_called_reconstruction";
    calls = 0;
    async produce(): Promise<FinalArtworkProviderOutput> {
      this.calls += 1;
      throw new Error("DTF-R1 must never dispatch a reconstruction provider");
    }
  }

  /** Counts calls without changing behavior, so "which provider ran" is observable. */
  class CountingLocalProvider implements FinalArtworkProvider {
    readonly providerKey = "local_raster_interpolation";
    calls = 0;
    private readonly inner = new LocalRasterInterpolationProvider();
    async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
      this.calls += 1;
      return this.inner.produce(input);
    }
  }

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  /**
   * One on-disk store is shared by every scenario (the local repository is
   * rooted at the process working directory), so a job an earlier scenario
   * deliberately left queued would otherwise be claimed by the next
   * scenario's worker and counted against ITS provider. Same isolation
   * discipline as `prepared-upload-finalization.test.ts`.
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

  function buildPipeline(repo: ProjectRepository) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const qualification = createArtworkGeometryQualificationCapability(
      repo,
      assets,
      reconstruction,
    );
    const provider = new NeverCalledReconstructionProvider();
    const localProvider = new CountingLocalProvider();
    const finalArtwork = createFinalArtworkCapability(repo, undefined, qualification);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      provider,
      createPrintValidationCapability(),
      undefined,
      localProvider,
      undefined,
      qualification,
    );
    return {
      assets,
      fidelity,
      reconstruction,
      qualification,
      finalArtwork,
      worker,
      provider,
      localProvider,
    };
  }

  // --- fixtures ------------------------------------------------------------

  /** A solid rectangle inset on a uniform field — opaque when `alpha` is 255. */
  function rectPng(
    canvasWidthPx: number,
    canvasHeightPx: number,
    artworkWidthPx: number,
    artworkHeightPx: number,
    backgroundAlpha: number,
  ): Buffer {
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
        png.data[idx] = inside ? 20 : 250;
        png.data[idx + 1] = inside ? 90 : 250;
        png.data[idx + 2] = inside ? 60 : 250;
        png.data[idx + 3] = inside ? 255 : backgroundAlpha;
      }
    }
    return PNG.sync.write(png);
  }

  /**
   * The customer's immutable original: artwork on an opaque background.
   *
   * Deliberately sized so its PREPARED derivative already carries more real
   * pixels than a 4in/300 PPI left-chest plate needs (1300px visible against
   * a 1200px target). Nothing on any DTF-R1 path may reach a reconstruction
   * provider, so the baseline scenario must not need one either — a fixture
   * that did would be testing enhancement, not source selection.
   */
  const ORIGINAL_CANVAS = { w: 1400, h: 640, aw: 1300, ah: 560 };
  /**
   * The recovered candidate: deliberately LARGE, so the clean master it
   * qualifies into already carries more real pixels than a 4in/300 PPI
   * left-chest plate needs. That is what makes scenario I meaningful — the
   * DTF job's own enhancement step honestly records `"skipped"`, and Print
   * Ready must STILL be withheld because the pixels were manufactured
   * upstream.
   */
  const CANDIDATE_CANVAS = { w: 2000, h: 900, aw: 1800, ah: 800 };

  function originalUploadPng(): Buffer {
    return rectPng(ORIGINAL_CANVAS.w, ORIGINAL_CANVAS.h, ORIGINAL_CANVAS.aw, ORIGINAL_CANVAS.ah, 255);
  }
  function preparedArtworkPng(): Buffer {
    return rectPng(ORIGINAL_CANVAS.w, ORIGINAL_CANVAS.h, ORIGINAL_CANVAS.aw, ORIGINAL_CANVAS.ah, 0);
  }
  function candidatePng(): Buffer {
    return rectPng(CANDIDATE_CANVAS.w, CANDIDATE_CANVAS.h, CANDIDATE_CANVAS.aw, CANDIDATE_CANVAS.ah, 255);
  }

  /** Drives a project to exactly "an approved prepared upload, size confirmed". */
  async function setupApprovedPreparation(
    repo: ProjectRepository,
    assets: ReturnType<typeof buildPipeline>["assets"],
  ) {
    await retireQueuedJobs(repo);

    const created = await repo.createProject();
    const projectId = created.project.id;
    await repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
      intendedPrintWidthIn: null,
    });

    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: originalUploadPng(),
      contentType: "image/png",
      widthPx: ORIGINAL_CANVAS.w,
      heightPx: ORIGINAL_CANVAS.h,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "team-logo.png" },
    });

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "team-logo.png",
      analysis: { widthPx: ORIGINAL_CANVAS.w, heightPx: ORIGINAL_CANVAS.h },
    });

    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedArtworkPng(),
      contentType: "image/png",
      widthPx: ORIGINAL_CANVAS.w,
      heightPx: ORIGINAL_CANVAS.h,
      hasTransparency: true,
      kind: "png",
      metadata: { derivedFromAssetId: original.id },
    });
    await repo.updateArtworkPreparation(preparation.id, {
      status: "prepared",
      preparedAssetId: prepared.id,
      preparation: { backgroundRemoved: true },
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
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "approved");
    await confirmProductionSizeForTests(repo, projectId);

    return {
      projectId,
      preparationId: preparation.id,
      originalAssetId: original.id,
      preparedAssetId: prepared.id,
      artworkVersionId: artwork!.id,
    };
  }

  const SOURCE_SHA = "a".repeat(64);

  /** Contract -> reconstruction job requested. The lifecycle has BEGUN, nothing is resolved. */
  async function beginRecoveryLifecycle(
    built: ReturnType<typeof buildPipeline> & { repo: ProjectRepository },
    projectId: string,
    originalAssetId: string,
  ) {
    const proposed = await built.fidelity.proposeContract(projectId, {
      sourceAssetId: originalAssetId,
      sourceSha256: SOURCE_SHA,
    });
    const contract = await built.fidelity.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SOURCE_SHA,
      confirmedWording: [],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await built.reconstruction.requestReconstruction(projectId, {
      sourceAssetId: originalAssetId,
      currentSourceSha256: SOURCE_SHA,
      fidelityContractId: contract.id,
    });
    return { contract, job };
  }

  /**
   * The full recovery lineage: contract -> job -> completed candidate ->
   * customer-approved -> geometry-qualified -> CONFIRMED. The only state in
   * which `getCurrentProductionQualifiedMaster` returns anything.
   */
  async function buildConfirmedMaster(
    built: ReturnType<typeof buildPipeline> & { repo: ProjectRepository },
    projectId: string,
    originalAssetId: string,
    candidateLabel = "recovered-candidate",
  ) {
    const { contract, job } = await beginRecoveryLifecycle(built, projectId, originalAssetId);
    const uploaded = await built.assets.uploadConceptImage(projectId, {
      conceptId: candidateLabel,
      bytes: candidatePng(),
      contentType: "image/png",
      widthPx: CANDIDATE_CANVAS.w,
      heightPx: CANDIDATE_CANVAS.h,
      hasTransparency: false,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    await built.repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId: uploaded.primary.id,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await built.reconstruction.approveCandidate(projectId, job.id, {
      confirmedBy: "customer",
    });
    await built.qualification.ensureQualification(projectId, approved.id);
    const confirmed = await built.qualification.confirmQualification(projectId, "customer");
    assert.equal(confirmed.qualificationStatus, "confirmed");
    assert.ok(confirmed.derivedAssetId, "a confirmed master must carry a derivative");
    return { contract, job: approved, master: confirmed, derivedAssetId: confirmed.derivedAssetId! };
  }

  /**
   * Runs the worker until the named job reaches a terminal state.
   *
   * A single `processNextJob()` is NOT a whole job: the Bounded
   * FinalArtwork Production-Execution Repair deliberately stops after the
   * post-provider durable checkpoint and leaves the job `"recoverable"` for
   * the next invocation to finish (validation, completion). Draining is
   * therefore the honest way to say "run this job", and it also means a
   * scenario that blocks on the FIRST pass is observably different from one
   * that merely needs a second — a fixed call count would hide that.
   */
  async function drainJob(
    worker: ReturnType<typeof buildPipeline>["worker"],
    repo: ProjectRepository,
    jobId: string,
    maxPasses = 6,
  ) {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const job = await repo.getFinalArtworkJob(jobId);
      if (
        job &&
        (job.status === "completed" || job.status === "failed" || job.status === "cancelled")
      ) {
        return job;
      }
      const { processedJobId } = await worker.processNextJob();
      if (!processedJobId) break;
    }
    const job = await repo.getFinalArtworkJob(jobId);
    assert.ok(job, "the job must still exist after draining");
    return job!;
  }

  async function productionAssetFor(repo: ProjectRepository, projectId: string, jobId: string) {
    const all = await repo.listAssets(projectId);
    return all.find(
      (asset) => asset.finalArtworkJobId === jobId && asset.productionRole === "production_png",
    );
  }

  function recordedLineage(asset: { metadata: unknown }) {
    return (asset.metadata as Record<string, unknown>).uploadedPreserve as {
      preparedAssetId: string;
      sourceAuthority?: string;
      originalAssetId: string;
      enhancement: string;
    };
  }

  async function latestReport(
    repo: ProjectRepository,
    projectId: string,
    jobId: string,
  ): Promise<PrintValidationReport> {
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, jobId);
    assert.ok(validation, "expected an authoritative validation run");
    return validation.report as unknown as PrintValidationReport;
  }

  // =========================================================================
  // A — NORMAL / NO RECOVERY: existing DTF behavior is preserved exactly
  // =========================================================================

  it("A: with no recovery lifecycle the resolver returns preparedAssetId and DTF finalizes from it", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    const preparation = await repo.getArtworkPreparation(setup.projectId);
    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      preparedAssetId: preparation!.preparedAssetId!,
    });
    assert.equal(resolved.status, "prepared");
    assert.equal(resolved.status === "prepared" && resolved.assetId, setup.preparedAssetId);
    assert.equal(
      resolved.status === "prepared" && resolved.authority,
      "prepared_upload",
    );

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(requested.job.status, "queued");
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "a production plate is produced exactly as before DTF-R1");
    const lineage = recordedLineage(asset!);
    assert.equal(lineage.preparedAssetId, setup.preparedAssetId);
    assert.equal(lineage.sourceAuthority, "prepared_upload");
    assert.equal(built.provider.calls, 0, "no reconstruction provider is ever dispatched");
  });

  it("A: the resolver also returns preparedAssetId when the lifecycle capability is simply absent", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    const resolved = await resolvePreparedUploadEffectiveSource(repo, undefined, {
      projectId: setup.projectId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "prepared");
  });

  // =========================================================================
  // B — RECOVERY STARTED / NO PQCM: DTF blocks, never falls back
  // =========================================================================

  it("B: a begun-but-unresolved recovery blocks the DTF request — preparedAssetId is NOT a fallback", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "blocked");
    assert.match(
      resolved.status === "blocked" ? resolved.reason : "",
      /image recovery review/,
    );

    await assert.rejects(
      () => built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
      /image recovery review/,
    );

    // No job was created at all, so nothing can later be finalized from the
    // pre-recovery source by a worker that never knew about recovery.
    const jobs = await repo.listFinalArtworkJobsForPreparation(
      setup.projectId,
      setup.preparationId,
    );
    assert.deepEqual(jobs, []);
  });

  it("B: an APPROVED reconstruction whose geometry is still pending confirmation is not eligible", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    const { job } = await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    const uploaded = await built.assets.uploadConceptImage(setup.projectId, {
      conceptId: "pending-candidate",
      bytes: candidatePng(),
      contentType: "image/png",
      widthPx: CANDIDATE_CANVAS.w,
      heightPx: CANDIDATE_CANVAS.h,
      hasTransparency: false,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    await repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId: uploaded.primary.id,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await built.reconstruction.approveCandidate(setup.projectId, job.id, {
      confirmedBy: "customer",
    });
    // Qualified, with a real derivative asset on file — but NOT confirmed.
    const qualification = await built.qualification.ensureQualification(
      setup.projectId,
      approved.id,
    );
    assert.equal(qualification.qualificationStatus, "normalized_pending_confirmation");
    assert.ok(qualification.derivedAssetId, "a derivative genuinely exists at this point");

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(
      resolved.status,
      "blocked",
      "pixels existing is not authority — see the phase's own governance requirement",
    );
    await assert.rejects(
      () => built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
      /image recovery review/,
    );
  });

  it("B: the resolver fails CLOSED when a lifecycle exists but no qualification capability is wired", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    const resolved = await resolvePreparedUploadEffectiveSource(repo, undefined, {
      projectId: setup.projectId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "blocked");
  });

  it("B: a job queued BEFORE recovery began is blocked by the worker, not finalized from the stale source", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // Requested while the project was still perfectly ordinary.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(requested.job.status, "queued");

    // Recovery begins in the gap between request and execution.
    await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    await drainJob(built.worker, repo, requested.job.id);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job!.status, "completed");
    assert.match(job!.lastError ?? "", /image recovery review/);
    assert.equal(
      await productionAssetFor(repo, setup.projectId, requested.job.id),
      undefined,
      "no plate may be produced from the pre-recovery source",
    );
    const snapshot = await repo.getProject(setup.projectId);
    assert.equal(snapshot!.project.status, "finalization_required");
    assert.equal(built.provider.calls, 0);
    assert.equal(built.localProvider.calls, 0, "no transform runs at all when authority is unresolved");
  });

  // =========================================================================
  // C — CURRENT PQCM: the master supersedes preparedAssetId
  // =========================================================================

  it("C: a current clean master is selected instead of preparedAssetId, end to end", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "master");
    assert.equal(resolved.status === "master" && resolved.assetId, derivedAssetId);
    assert.notEqual(derivedAssetId, setup.preparedAssetId);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "a plate is produced from the clean master");

    // F — PROVENANCE: the plate names the asset the transform actually read,
    // and names which authority it belongs to.
    const lineage = recordedLineage(asset!);
    assert.equal(lineage.preparedAssetId, derivedAssetId);
    assert.notEqual(lineage.preparedAssetId, setup.preparedAssetId);
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(lineage.originalAssetId, setup.originalAssetId);

    // ...and authoritative validation judged that SAME lineage — never one
    // asset validated while another was printed.
    const report = await latestReport(repo, setup.projectId, requested.job.id);
    assert.equal(report.artworkVersionId, setup.artworkVersionId);
    const validation = await repo.getLatestProductionAssetValidationForJob(
      setup.projectId,
      requested.job.id,
    );
    assert.equal(validation!.assetId, asset!.id);

    // H — no duplicate reconstruction, ever.
    assert.equal(built.provider.calls, 0);

    // G — HISTORICAL IMMUTABILITY: the preparation record is untouched.
    const preparation = await repo.getArtworkPreparation(setup.projectId);
    assert.equal(preparation!.preparedAssetId, setup.preparedAssetId);
    assert.equal(preparation!.originalAssetId, setup.originalAssetId);
  });

  // =========================================================================
  // D — STALE / INVALID PQCM
  // =========================================================================

  it("D: a master whose fidelity authority is superseded after the request is never used by the worker", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);

    // Authority moves in the gap between request and execution — the
    // customer corrects what their artwork says. A confirmed fidelity
    // contract is immutable, so a correction is a NEW contract, and the
    // master approved under the old one stops being current the moment it
    // lands. Nothing about the derivative asset itself changes; what
    // changes is whether anything still authorizes it.
    await built.fidelity.proposeContract(setup.projectId, {
      sourceAssetId: setup.originalAssetId,
      sourceSha256: SOURCE_SHA,
    });
    assert.equal(
      await built.qualification.getCurrentProductionQualifiedMaster(setup.projectId),
      null,
      "a superseded chain resolves to nothing, never to a stale row",
    );

    await drainJob(built.worker, repo, requested.job.id);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job!.status, "completed");
    assert.match(job!.lastError ?? "", /image recovery review/);
    assert.equal(
      await productionAssetFor(repo, setup.projectId, requested.job.id),
      undefined,
      "neither the superseded master nor preparedAssetId may be used",
    );
    assert.equal(built.provider.calls, 0);
    assert.equal(built.localProvider.calls, 0);
    // The superseded derivative asset still exists; existence is not authority.
    assert.ok(await repo.getAssetById(derivedAssetId));
  });

  // =========================================================================
  // E — REQUEST/WORKER CHANGE (TOCTOU)
  // =========================================================================

  it("E: a request that resolved preparedAssetId is executed against the master that became current", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // Request time: no lifecycle at all, so the request legitimately
    // resolves the prepared asset.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const atRequest = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(atRequest.status, "prepared");

    // ...and the whole recovery lifecycle resolves before the worker runs.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );

    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "the worker produces from the CURRENT authority");
    const lineage = recordedLineage(asset!);
    assert.equal(
      lineage.preparedAssetId,
      derivedAssetId,
      "the worker must not blindly use the request-time source",
    );
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(built.provider.calls, 0);
  });

  it("E: a plate this job already produced from a superseded source is never adopted on retry", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // First attempt: ordinary project, plate produced from preparedAssetId.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);
    const firstAsset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(firstAsset);
    assert.equal(recordedLineage(firstAsset!).preparedAssetId, setup.preparedAssetId);

    // Recovery resolves afterwards, and the job is revived the way a
    // crash-recovery sweep would revive it.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    await repo.updateFinalArtworkJob(requested.job.id, {
      status: "queued",
      lastError: null,
      completedAt: null,
    });

    await drainJob(built.worker, repo, requested.job.id);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job!.status, "completed");
    assert.match(job!.lastError ?? "", /authoritative source changed/);
    // The stale plate was neither re-validated nor re-delivered, and no new
    // plate was silently produced beside it.
    const assetsForJob = (await repo.listAssets(setup.projectId)).filter(
      (asset) =>
        asset.finalArtworkJobId === requested.job.id &&
        asset.productionRole === "production_png",
    );
    assert.equal(assetsForJob.length, 1);
    assert.equal(recordedLineage(assetsForJob[0]!).preparedAssetId, setup.preparedAssetId);
    assert.notEqual(recordedLineage(assetsForJob[0]!).preparedAssetId, derivedAssetId);
    assert.equal(built.provider.calls, 0);
  });

  // =========================================================================
  // I — GOVERNANCE: the Pedro-class boundary
  // =========================================================================

  it("I: a plate built from a clean master is produced but NEVER automatically print_ready", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    await buildConfirmedMaster(built, setup.projectId, setup.originalAssetId);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "the technical work genuinely succeeds — that is the point");

    // This job honestly did no reconstruction of its own: the master already
    // carried enough pixels. Without `sourceAuthority` that is exactly how
    // an uncertified reconstruction would have reached Print Ready.
    assert.equal(recordedLineage(asset!).enhancement, "skipped");
    assert.equal(built.provider.calls, 0);

    const report = await latestReport(repo, setup.projectId, requested.job.id);
    assert.notEqual(report.status, "print_ready");
    const certification = report.checks.find(
      (check) => check.check === "reconstruction_certification_evidence",
    );
    assert.ok(certification, "the certification question must be asked");
    assert.equal(certification!.status, "fail");
    assert.equal(certification!.severity, "blocking");
    assert.match(certification!.reason, /recovered clean master/);
    assert.ok(
      report.requiredTransformations.includes("require_human_review"),
      "human review is required, exactly as the Pedro-class condition demands",
    );

    const snapshot = await repo.getProject(setup.projectId);
    assert.equal(snapshot!.project.status, "finalization_required");

    // Source lineage still passes on its own terms — the plate is
    // well-formed, it simply is not certified.
    const lineage = report.checks.find((check) => check.check === "source_lineage");
    assert.equal(lineage!.status, "pass");
    assert.match(lineage!.reason, /recovered clean master/);
  });
});
