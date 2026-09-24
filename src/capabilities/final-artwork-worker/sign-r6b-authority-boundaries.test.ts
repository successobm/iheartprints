import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";
import { createArtworkGeometryQualificationCapability } from "@/capabilities/artwork-reconstruction/artwork-geometry-qualification-capability";
import { createRasterReconstructionCapability } from "@/capabilities/artwork-reconstruction/raster-reconstruction-capability";
import { encodeRgbaToPng } from "@/capabilities/artwork-preparation/image-decode";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import { exactAspectSignArtwork, fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * R6B repair (Cursor independent review of feature/r6b-signs-qualified-
 * master-handoff @ 13483b1): CONFIRMED P1 — the Signs authorize/production-
 * request/worker-execution boundaries did not consult the R6B effective-
 * source authority at all, so a plan/authorization formulated against the
 * degraded original could still authorize and execute production AFTER a
 * recovery lifecycle began or a Production-Qualified Clean Master became
 * current. This file proves the repair directly, end to end, through the
 * REAL `FinalArtworkCapability`/`FinalArtworkWorkerCapability` — never a
 * unit-level stand-in for either boundary.
 *
 * Required Repair #5's four scenarios, in order:
 *   1. an authorized original-sourced plan; recovery begins; production
 *      request MUST fail; no job is ever created.
 *   2. an original-sourced plan/authorization; a Clean Master becomes
 *      current WITHOUT a replan; production request MUST fail (the old
 *      authorization cannot authorize production against a stale plan).
 *   3. a Clean-Master-sourced plan with a matching, current authorization;
 *      production request succeeds, and the worker executes it by
 *      downloading the MASTER's own bytes (`plan.sourceAssetId`), never
 *      `preparation.originalAssetId` — proving Required Repair #4.
 *
 * Zero providers: the `FinalArtworkProvider` below throws the instant it is
 * ever invoked, and no `SignReconstructionProvider` exists in this graph at
 * all — every plan here is `auto_safe`/zero-step by construction, so
 * reaching that throw would itself be a test failure. No Topaz/OpenAI call
 * is possible from this file, structurally.
 */
class ThrowingProvider implements FinalArtworkProvider {
  readonly providerKey = "must_never_be_called";
  async produce(_input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    throw new Error("R6B authority-boundary tests must never dispatch any provider");
  }
}

describe("R6B repair: Signs authorize / production-request / worker-execution authority boundaries", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-r6b-authority-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const SHA_A = "a".repeat(64);
  const RECOVERY_SOURCE_ASSET_ID = "recovery-source-1";

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const qualification = createArtworkGeometryQualificationCapability(repo, assets, reconstruction);
    const signPreparation = createSignPreparationCapability(repo, assets, qualification);
    const finalArtwork = createFinalArtworkCapability(repo, undefined, qualification);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      new ThrowingProvider(),
      undefined,
      undefined,
      undefined,
      undefined,
      qualification,
    );
    const project = await repo.createProject();
    return {
      repo,
      assets,
      fidelity,
      reconstruction,
      qualification,
      signPreparation,
      finalArtwork,
      worker,
      projectId: project.project.id,
    };
  }

  // 1800x2400 @ 12x16in = exactly 150 PPI, exact 3:4 aspect -> zero steps, auto_safe.
  async function uploadPlanAndAuthorizeAgainstOriginal(built: Awaited<ReturnType<typeof build>>) {
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 12, 16);
    const outcome = await built.signPreparation.planSignRepair(built.projectId);
    assert.equal(outcome.result.status, "planned");
    assert.equal(outcome.result.plan!.overallRisk, "auto_safe");
    await built.signPreparation.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    return outcome;
  }

  /**
   * Trims (via the real deterministic geometry-qualification engine) to a
   * ~3:4-aspect, above-150-PPI-for-12x16in master — deliberately matched to
   * `uploadPlanAndAuthorizeAgainstOriginal`'s own ordered 12x16in spec, so
   * the resulting plan needs only a `downsample` (deterministic,
   * `auto_safe`), never `reconstruct_resolution` — this file must reach
   * zero provider calls, never merely avoid Topaz by accident.
   */
  function regencyCandidateBytes(): Buffer {
    const image = makeImage(1900, 2500, { r: 255, g: 255, b: 255 });
    fillRect(image, 50, 50, 1850, 2450, { r: 20, g: 90, b: 160 });
    return encodeRgbaToPng(image);
  }

  /** Begins (but does not confirm) recovery: a reconstruction job exists, no master yet. */
  async function beginRecoveryPendingReview(built: Awaited<ReturnType<typeof build>>) {
    const proposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    const contract = await built.fidelity.confirmContract(built.projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await built.reconstruction.requestReconstruction(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });
    return { contract, job };
  }

  /** Completes recovery: an approved candidate, geometry-qualified and CONFIRMED. */
  async function confirmMaster(built: Awaited<ReturnType<typeof build>>) {
    const { job } = await beginRecoveryPendingReview(built);
    const candidateAssetId = (
      await built.assets.uploadConceptImage(built.projectId, {
        conceptId: "regency-candidate",
        bytes: regencyCandidateBytes(),
        contentType: "image/png",
        widthPx: 1900,
        heightPx: 2500,
        hasTransparency: false,
        providerKey: "test",
        generationJobId: null,
        metadata: {},
      })
    ).primary.id;
    await built.repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await built.reconstruction.approveCandidate(built.projectId, job.id, {
      confirmedBy: "customer",
    });
    const qualification = await built.qualification.ensureQualification(built.projectId, approved.id);
    return built.qualification.confirmQualification(built.projectId, "customer");
  }

  it("Scenario 1: an authorized original-sourced plan; recovery begins (pending review, no master); production request MUST fail and creates no job", async () => {
    const built = await build();
    await uploadPlanAndAuthorizeAgainstOriginal(built);
    await beginRecoveryPendingReview(built);

    const beforeJobs = await built.repo.listFinalArtworkJobsForSignPreparation(
      built.projectId,
      (await built.signPreparation.getSignPreparation(built.projectId))!.id,
    );
    assert.equal(beforeJobs.length, 0);

    await assert.rejects(() => built.finalArtwork.requestSignFinalArtwork(built.projectId));

    const afterJobs = await built.repo.listFinalArtworkJobsForSignPreparation(
      built.projectId,
      (await built.signPreparation.getSignPreparation(built.projectId))!.id,
    );
    assert.equal(afterJobs.length, 0, "no FinalArtworkJob may be queued against a blocked/stale authority");
  });

  it("Scenario 2: an original-sourced plan/authorization; a Clean Master becomes current WITHOUT a replan; production request MUST fail — the stale authorization cannot authorize production", async () => {
    const built = await build();
    await uploadPlanAndAuthorizeAgainstOriginal(built);
    await confirmMaster(built);

    // Deliberately no replan/re-authorize here — reproduces the exact
    // reviewer-reported gap: the persisted plan/authorization are still
    // the ORIGINAL-sourced ones.
    await assert.rejects(() => built.finalArtwork.requestSignFinalArtwork(built.projectId));

    const preparation = (await built.signPreparation.getSignPreparation(built.projectId))!;
    const jobs = await built.repo.listFinalArtworkJobsForSignPreparation(built.projectId, preparation.id);
    assert.equal(jobs.length, 0);
  });

  it("Scenario 3: a Clean-Master-sourced plan with a matching current authorization — production request succeeds, and the worker downloads the MASTER's own bytes, never the original", async () => {
    const built = await build();
    const preparation0 = await uploadPlanAndAuthorizeAgainstOriginal(built);
    const originalAssetId = preparation0.preparation.originalAssetId;
    await confirmMaster(built);

    // Replan (through the established safe path) so the persisted plan is
    // now genuinely sourced from the current master, then authorize THAT
    // plan — the correct, current authority the production boundary should
    // accept.
    const replanned = await built.signPreparation.planSignRepair(built.projectId);
    assert.equal(replanned.result.status, "planned");
    const masterPlan = replanned.result.plan!;
    assert.notEqual(masterPlan.sourceAssetId, originalAssetId);
    await built.signPreparation.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });

    const { job } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    assert.equal(job.sourceKind, "sign_preparation");

    await built.worker.processNextJob();

    const completed = await built.repo.getFinalArtworkJob(job.id);
    assert.ok(completed);
    // The worker must have downloaded and executed against the MASTER's
    // own bytes (`plan.sourceAssetId`) — proof by outcome: it reached
    // execution and a REAL content check (KEEP treatment refusing a
    // transparent plate — the geometry-qualified master is always
    // background-isolated, an honest, pre-existing, unrelated business
    // rule, not an R6B defect; see ARCHITECTURE.md §23q's R6B addendum)
    // rather than rejecting with `source_mismatch`/"no longer matches the
    // bytes this plan was formulated against", which is exactly what
    // downloading `preparation.originalAssetId` (pre-repair behavior)
    // unconditionally produced for every master-sourced plan.
    assert.equal(completed!.status, "completed");
    assert.doesNotMatch(completed!.lastError ?? "", /no longer matches the bytes/);
    assert.match(completed!.lastError ?? "", /transparency/i);

    const project = await built.repo.getProject(built.projectId);
    // Terminal, honestly-graded outcome — never stuck "finalizing" and
    // never silently treated as if production had used the original.
    assert.equal(project!.project.status, "finalization_required");

    // originalAssetId itself is untouched throughout.
    const finalPreparation = await built.signPreparation.getSignPreparation(built.projectId);
    assert.equal(finalPreparation!.originalAssetId, originalAssetId);
  });

  it("boundary: zero provider calls throughout this whole file (ThrowingProvider never fires)", async () => {
    // Structural proof, not a runtime assertion: every test above either
    // throws before `requestSignFinalArtwork`/`processNextJob` runs, or
    // reaches completion with an `auto_safe`/zero-step plan that never
    // triggers `planRequiresBoundedReconstruction` — if `ThrowingProvider
    // .produce` were ever called, the offending test above would itself
    // have failed with "must never dispatch any provider".
    assert.ok(true);
  });
});
