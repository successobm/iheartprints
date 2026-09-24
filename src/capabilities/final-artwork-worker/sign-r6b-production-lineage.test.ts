import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import type { SignPreservationCapability } from "@/capabilities/sign-preservation";
import type { SignPreservationVerification } from "@/lib/domain/types";
import { exactAspectSignArtwork, fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * R6B repair (Cursor independent review, NEW false-lineage P1): the worker
 * was independently found to execute correctly from `plan.sourceAssetId`
 * (the prior authority-boundary repair) but then WRITE
 * `preparation.originalAssetId` as the production asset's own
 * `sourceAssetId` metadata unconditionally — an impossible identity for a
 * master-sourced plan (an asset id paired with a DIFFERENT asset's hash),
 * which `RigidSignPlanEvidence` then fed straight into PrintValidation's
 * preservation-identity check, structurally blocking a correctly
 * master-sourced job from ever certifying ready.
 *
 * This file proves the corrected lineage end to end, through the REAL
 * `SignPreparationCapability`/`FinalArtworkCapability`/
 * `FinalArtworkWorkerCapability`/`PrintValidationCapability` — never a
 * unit-level stand-in for the identity check itself. Two test doubles are
 * used, both explicitly permitted by the review and both zero-network:
 *
 *   - `FakeSignReconstructionProvider` (existing, Signs Phase S3A's own
 *     test double) — the ordered size deliberately needs
 *     `reconstruct_resolution`, so `planRequiresSemanticPreservationVerification`
 *     is genuinely exercised, not trivially skipped.
 *   - A stub `SignPreservationCapability` — this repo's own REAL semantic
 *     preservation provider is forced to a safe, never-`"preserved"`
 *     placeholder under `isAutomatedTestEnvironment()` (by design, so no
 *     test can accidentally fabricate a false-positive semantic verdict),
 *     which means NO test in this codebase can reach `status: "preserved"`
 *     through the real capability at all. The stub supplies a
 *     deterministic `"preserved"` verdict with identity fields resolved
 *     the SAME way the real `resolvePreservationContext` does
 *     (`plan.sourceAssetId`/`plan.sourceSha256`/`plan.planKey`, read fresh
 *     from the persisted preparation, never hardcoded) — proving the
 *     REST of the chain agrees with it, which is exactly what this test
 *     is for.
 */
describe("R6B repair: Signs production asset/preservation lineage records the ACTUAL execution source, never originalAssetId unconditionally", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-r6b-lineage-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const SHA_A = "a".repeat(64);
  const RECOVERY_SOURCE_ASSET_ID = "recovery-source-1";

  function buildStubPreservation(
    repo: ProjectRepository,
    assets: ReturnType<typeof createAssetCapability>,
    projectId: string,
  ): SignPreservationCapability {
    const ALGORITHM_VERSION = "fake-preservation-v1";
    return {
      async verifyDeterministicPreservation(): Promise<SignPreservationVerification> {
        throw new Error("not used by this test");
      },
      async verifyPreservation(finalAssetId: string): Promise<SignPreservationVerification> {
        const preparation = (await repo.getSignPreparation(projectId))!;
        // Resolved fresh from the persisted plan — the SAME source of
        // truth `resolvePreservationContext` itself uses (never hardcoded
        // in this test), so a regression that reintroduces the
        // `originalAssetId`-unconditionally bug would make THIS stub's own
        // identity disagree with the production asset's metadata too.
        const plan = preparation.plan as unknown as { sourceAssetId: string; sourceSha256: string; planKey: string };
        const finalDownloaded = await assets.downloadAssetBytes(finalAssetId);
        const finalAssetSha256 = createHash("sha256").update(finalDownloaded!.bytes).digest("hex");
        return {
          id: "fake-verification-1",
          projectId,
          signPreparationId: preparation.id,
          sourceAssetId: plan.sourceAssetId,
          sourceSha256: plan.sourceSha256,
          intermediateAssetId: "fake-intermediate",
          finalAssetId,
          finalAssetSha256,
          planKey: plan.planKey,
          verificationAlgorithmVersion: ALGORITHM_VERSION,
          deterministicEvidence: {},
          semanticEvidence: null,
          status: "preserved",
          reasons: [],
          createdAt: new Date().toISOString(),
        };
      },
      resolveCurrentVerificationAlgorithmVersion(): string {
        return ALGORITHM_VERSION;
      },
    };
  }

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const qualification = createArtworkGeometryQualificationCapability(repo, assets, reconstruction);
    const signPreparation = createSignPreparationCapability(repo, assets, qualification);
    const finalArtwork = createFinalArtworkCapability(repo, undefined, qualification);
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const project = await repo.createProject();
    const preservation = buildStubPreservation(repo, assets, project.project.id);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      reconstructionProvider,
      undefined,
      undefined,
      undefined,
      preservation,
      qualification,
    );
    return {
      repo,
      assets,
      fidelity,
      reconstruction,
      qualification,
      signPreparation,
      finalArtwork,
      worker,
      reconstructionProvider,
      projectId: project.project.id,
    };
  }

  /**
   * Trims to ~900x1200 @ 18x24in = 50 PPI, exact 0.75 aspect — a single
   * `reconstruct_resolution` step, matching Signs Phase S3A's own
   * `planNeedingReconstruction` fixture shape, so
   * `planRequiresSemanticPreservationVerification` is genuinely true.
   */
  function candidateBytes(): Buffer {
    const image = makeImage(1000, 1300, { r: 255, g: 255, b: 255 });
    fillRect(image, 50, 50, 934, 1234, { r: 20, g: 90, b: 160 });
    return encodeRgbaToPng(image);
  }

  it("a master-sourced, reconstruction-requiring plan records CORRECT production/preservation lineage and can certify print_ready", async () => {
    const built = await build();

    const uploaded = await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);
    const originalAssetId = uploaded.originalAssetId;

    // Full recovery lineage -> a confirmed Production-Qualified Clean Master.
    const contractProposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    const contract = await built.fidelity.confirmContract(built.projectId, contractProposed.id, {
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
    const candidateAssetId = (
      await built.assets.uploadConceptImage(built.projectId, {
        conceptId: "lineage-candidate",
        bytes: candidateBytes(),
        contentType: "image/png",
        widthPx: 1000,
        heightPx: 1300,
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
    const confirmed = await built.qualification.confirmQualification(built.projectId, "customer");
    assert.equal(qualification.id, confirmed.id);
    assert.ok(confirmed.derivedAssetId);

    // The master is transparent by construction (R6A) — REMOVE treatment
    // is required to survive the opacity gate. Safe to set while a master
    // is current (the readiness check for it is skipped entirely; see
    // `assertBackgroundTreatmentReadyToPlan`'s own doc).
    await built.signPreparation.setSignBackgroundTreatment(built.projectId, "remove");

    const replanned = await built.signPreparation.planSignRepair(built.projectId);
    assert.equal(replanned.result.status, "planned");
    const plan = replanned.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution"]);
    assert.equal(plan.sourceAssetId, confirmed.derivedAssetId);
    assert.notEqual(plan.sourceAssetId, originalAssetId);

    await built.signPreparation.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    const { job: fjob } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    await built.worker.processNextJob();

    // Zero network/paid calls — the fake provider's own counters prove it.
    assert.equal(built.reconstructionProvider.dispatchCount, 1);

    const completed = await built.repo.getFinalArtworkJob(fjob.id);
    assert.equal(completed!.status, "completed");
    assert.equal(completed!.lastError, null);

    const project = await built.repo.getProject(built.projectId);
    assert.equal(project!.project.status, "print_ready");

    // 8/9: the production asset's OWN recorded lineage matches the plan's
    // actual source — never `originalAssetId` unconditionally.
    const producedAssets = await built.repo.listAssets(built.projectId);
    const finalAsset = producedAssets.find(
      (a) =>
        a.finalArtworkJobId === fjob.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the actual final production asset must exist");
    const rigidSign = (finalAsset!.metadata as { rigidSign?: { sourceAssetId?: string; sourceSha256?: string } })
      .rigidSign;
    assert.ok(rigidSign);
    assert.equal(rigidSign!.sourceAssetId, confirmed.derivedAssetId);
    assert.notEqual(rigidSign!.sourceAssetId, originalAssetId);

    const masterDownloaded = await built.assets.downloadAssetBytes(confirmed.derivedAssetId!);
    const actualMasterSha256 = createHash("sha256").update(masterDownloaded!.bytes).digest("hex");
    assert.equal(rigidSign!.sourceSha256, actualMasterSha256);
    assert.equal(rigidSign!.sourceSha256, plan.sourceSha256);

    // 10: historical provenance is untouched.
    const finalPreparation = await built.signPreparation.getSignPreparation(built.projectId);
    assert.equal(finalPreparation!.originalAssetId, originalAssetId);

    // 11/12: the preservation record and PrintValidation's own binding
    // check both agree on the SAME source identity, and the check PASSES
    // (never merely "not blocking for an unrelated reason").
    const validation = await built.repo.getLatestProductionAssetValidationForJob(built.projectId, fjob.id);
    assert.ok(validation);
    assert.equal(validation!.status, "ready");
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    const identityCheck = checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.ok(identityCheck);
    assert.equal(identityCheck!.status, "pass");
  });

  it("R6B repair (Important P2): a reconstruction-requiring plan against a transparent master under KEEP treatment refuses BEFORE any paid dispatch — zero provider calls", async () => {
    const built = await build();

    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);

    const contractProposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    const contract = await built.fidelity.confirmContract(built.projectId, contractProposed.id, {
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
    const candidateAssetId = (
      await built.assets.uploadConceptImage(built.projectId, {
        conceptId: "keep-transparent-master-candidate",
        bytes: candidateBytes(),
        contentType: "image/png",
        widthPx: 1000,
        heightPx: 1300,
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
    await built.qualification.ensureQualification(built.projectId, approved.id);
    const confirmed = await built.qualification.confirmQualification(built.projectId, "customer");

    // Deliberately KEEP (the default) — never set to "remove" — while the
    // effective source (the master) is transparent by construction.
    const replanned = await built.signPreparation.planSignRepair(built.projectId);
    assert.equal(replanned.result.status, "planned");
    const plan = replanned.result.plan!;
    assert.equal(plan.backgroundTreatment, "keep");
    assert.ok(
      plan.steps.some((s) => s.kind === "reconstruct_resolution"),
      "this scenario must actually need bounded reconstruction to prove the pre-dispatch guard",
    );
    assert.equal(plan.sourceAssetId, confirmed.derivedAssetId);

    await built.signPreparation.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    const { job: fjob } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    await built.worker.processNextJob();

    // The whole point: zero dispatches, proven by the fake provider's own
    // counter, never merely "the job happened to fail for some reason".
    assert.equal(built.reconstructionProvider.dispatchCount, 0);
    assert.equal(built.reconstructionProvider.resumeCount, 0);

    const completed = await built.repo.getFinalArtworkJob(fjob.id);
    assert.equal(completed!.status, "completed");
    assert.match(completed!.lastError ?? "", /before any paid reconstruction dispatch/);

    const project = await built.repo.getProject(built.projectId);
    assert.equal(project!.project.status, "finalization_required");
  });
});
