import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createFinalArtworkCapability, LocalRasterInterpolationProvider } from "@/capabilities/final-artwork";
import {
  isReconstructionIntermediateAsset,
  RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
} from "@/capabilities/final-artwork/production-request-identity";
import { ProviderError } from "@/capabilities/providers/provider-error";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import type { FinalArtworkJob, FinalArtworkJobStatus } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  createFinalArtworkWorkerCapability,
  MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
} from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * Exhausted Provider Result Recovery Phase (real Signs acceptance
 * incident): `recoverExhaustedSignProviderResult` — the sanctioned, single-
 * purpose action for a sign job whose normal 5-attempt recovery budget is
 * already exhausted but whose existing paid Topaz request may still be
 * resumable. Every test here proves one of two things: a precondition
 * fails closed with the exact right reason and mutates nothing, OR the
 * capability behaves — provider identity, recovery budget, dispatch count,
 * job state — exactly as documented.
 */
describe("Exhausted Provider Result Recovery Phase", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-exhausted-recovery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /** A planned, authorized, reconstruction-needing sign job — deliberately NOT yet claimed/run. */
  async function buildPreparedProject(assets?: AssetCapability) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets =
      assets ?? createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;

    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(900, 1200)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    const outcome = await signPreparation.planSignRepair(projectId);
    if (outcome.result.status === "planned") {
      await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    }
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    return { repo, assets: realAssets, signPreparation, finalArtwork, projectId, job };
  }

  /**
   * Directly sets a job's persisted fields to simulate the state 5 real
   * recovery cycles would have produced — the actual worker capability
   * (`recoverExhaustedSignProviderResult`) is what's under test here, not
   * the normal recovery loop that would ordinarily reach this state (that
   * loop is already covered in `sign-reconstruction.test.ts`'s own B8/B9
   * suite). Mirrors the established `repo.updateFinalArtworkJob(...)`
   * direct-state-manipulation pattern already used throughout this file's
   * sibling tests for identical reasons.
   */
  async function exhaustJob(
    repo: ProjectRepository,
    job: FinalArtworkJob,
    overrides: {
      status?: FinalArtworkJobStatus;
      providerKey?: string | null;
      providerRequestId?: string | null;
      providerRecoveryAttempts?: number;
    } = {},
  ): Promise<FinalArtworkJob> {
    return repo.updateFinalArtworkJob(job.id, {
      status: overrides.status ?? "failed",
      providerKey: overrides.providerKey === undefined ? "fake_sign_reconstruction_v1" : overrides.providerKey,
      providerRequestId:
        overrides.providerRequestId === undefined ? "existing-topaz-request-1" : overrides.providerRequestId,
      providerStatus: "submitted",
      providerRecoveryAttempts: overrides.providerRecoveryAttempts ?? MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
      lastError: "simulated: exhausted after repeated recovery attempts",
      completedAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------
  // Refusal preconditions — each must fail closed, mutate nothing.
  // -------------------------------------------------------------------

  it("refuses when there is no sign preparation for the project", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const project = await repo.createProject();
    const provider = new FakeSignReconstructionProvider();
    const worker = createFinalArtworkWorkerCapability(repo, realAssets, provider);

    const result = await worker.recoverExhaustedSignProviderResult(project.project.id);
    assert.deepEqual(result, { outcome: "refused", reason: "no_sign_preparation" });
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 0);
  });

  it("refuses when no job matches the current plan key (11: planKey mismatch/stale job fails closed)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, assets, signPreparation, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job);
    // Re-plan with a materially different ordered size -- the preparation's
    // planKey changes, but the exhausted job still carries the OLD one.
    await signPreparation.confirmSignProductionSpec(projectId, 24, 36);
    await signPreparation.planSignRepair(projectId);

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_matching_job" });
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 0);

    const untouched = await repo.getFinalArtworkJob(job.id);
    assert.equal(untouched!.status, "failed", "the stale job itself must not be touched by this refusal");
  });

  it("refuses when the matching job's status is not failed", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { status: "running" });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "job_not_failed" });
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 0);
  });

  it("refuses when the recovery budget is not actually exhausted (1: normal 5/5 exhaustion is a real precondition, not assumed)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerRecoveryAttempts: MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS - 1 });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "recovery_budget_not_exhausted" });
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 0);

    const untouched = await repo.getFinalArtworkJob(job.id);
    assert.equal(untouched!.providerRecoveryAttempts, MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS - 1);
  });

  it("refuses when providerRequestId is missing, even if providerKey is present (2 & 10: missing providerRequestId fails closed)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerRequestId: null });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_existing_provider_request" });
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 0);
  });

  it("refuses when providerKey is missing", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerKey: null });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_existing_provider_request" });
  });

  it("refuses when the configured provider does not support resume-only reads", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job);

    // LocalRasterInterpolationProvider implements neither SignReconstructionProvider
    // nor SignReconstructionResumeProvider -- a real, already-existing provider class,
    // not a specially-crafted stub.
    const localProvider = new LocalRasterInterpolationProvider();
    const worker = createFinalArtworkWorkerCapability(repo, assets, localProvider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "provider_does_not_support_resume" });
  });

  // -------------------------------------------------------------------
  // Behavior once every precondition holds.
  // -------------------------------------------------------------------

  it("resumes exactly the existing request, never submits fresh, preserves the exhausted budget (3, 4, 5, 6: identity/budget/no-fresh-submit)", async () => {
    const provider = new FakeSignReconstructionProvider();
    provider.resumeOnlyBehavior = { kind: "success" };
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerRequestId: "existing-topaz-request-XYZ" });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);

    assert.equal(result.outcome, "attempted");
    assert.equal(provider.dispatchCount, 0, "requirement 4: fresh submit method call count must be ZERO");
    assert.equal(provider.resumeCount, 0, "the NORMAL resume-or-submit contract must never be touched by this path");
    assert.equal(provider.resumeOnlyCallCount, 1, "requirement 3: resumes exactly once");

    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.providerRecoveryAttempts, MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS, "requirement 5: budget stays exactly 5");
  });

  it("provider still processing: clean non-submitting outcome, no fresh request (7)", async () => {
    const provider = new FakeSignReconstructionProvider();
    provider.resumeOnlyBehavior = { kind: "processing" };
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerRequestId: "existing-topaz-request-still-processing" });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.finalStatus, "failed", "a still-processing poll times out cleanly -- not success, not a crash");
    }
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 1);

    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.providerKey, "fake_sign_reconstruction_v1", "still-processing is not a terminal failure -- identity must survive for a later attempt");
    assert.equal(final!.providerRequestId, "existing-topaz-request-still-processing");
    assert.equal(final!.providerRecoveryAttempts, MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS);
    assert.match(final!.lastError!, /^resumeSignReconstruction failed after \d+ms:/);
  });

  it("provider completed: downloads the existing result and continues normal persistence through to completion (8)", async () => {
    const provider = new FakeSignReconstructionProvider();
    provider.resumeOnlyBehavior = { kind: "success" };
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerRequestId: "existing-topaz-request-completed" });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.finalStatus, "completed");
    }
    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeOnlyCallCount, 1);

    const intermediateAssets = (await repo.listAssetsForFinalArtworkJob(projectId, job.id)).filter(
      isReconstructionIntermediateAsset,
    );
    assert.equal(intermediateAssets.length, 1, "the existing result must have been persisted as an intermediate asset");
  });

  it("provider reports terminal failure: clean failure, zero fresh submission, budget still untouched (9)", async () => {
    const provider = new FakeSignReconstructionProvider();
    provider.resumeOnlyBehavior = {
      kind: "throw",
      error: new ProviderError("provider_job_failed", "The fake reconstruction provider reported this request as terminally failed."),
    };
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await exhaustJob(repo, job, { providerRequestId: "existing-topaz-request-dead" });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.finalStatus, "failed");
    }
    assert.equal(provider.dispatchCount, 0, "a terminal failure must never trigger a replacement paid submission");

    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.providerKey, null, "the specific dead request's identity is cleared -- Topaz itself said it's gone");
    assert.equal(final!.providerRequestId, null);
    assert.equal(
      final!.providerRecoveryAttempts,
      MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
      "the budget itself is never reset by this path, even on terminal failure -- a genuinely different rule from the normal resume-or-submit path's own identical-looking reset",
    );
  });

  it("existing intermediate already persisted: idempotent self-heal continuation, provider never called (12)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, assets, projectId, job } = await buildPreparedProject();

    // Simulate: a prior attempt got far enough to persist the intermediate,
    // but crashed before clearing the job's own provider-identity slot --
    // then got exhausted. The self-heal (pre-existing, unmodified logic)
    // must recognize this by matching providerRequestId, exactly as it
    // already does for the normal path.
    const requestId = "existing-topaz-request-already-persisted";
    await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: true,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {
        reconstructionStage: RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
        providerKey: provider.providerKey,
        providerRequestId: requestId,
      },
    });
    await exhaustJob(repo, job, { providerRequestId: requestId });

    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.finalStatus, "completed");
    }
    assert.equal(provider.resumeOnlyCallCount, 0, "requirement 12: no provider call when the result is already durably persisted");
    assert.equal(provider.dispatchCount, 0);

    const intermediateAssets = (await repo.listAssetsForFinalArtworkJob(projectId, job.id)).filter(
      isReconstructionIntermediateAsset,
    );
    assert.equal(intermediateAssets.length, 1, "no duplicate intermediate was created");
  });

  it("a persistence failure after a successful resume fails cleanly, preserves provider identity, and remains safely retryable (13)", async () => {
    const provider = new FakeSignReconstructionProvider();
    provider.resumeOnlyBehavior = { kind: "success" };
    const { repo, projectId, job } = await buildPreparedProject();
    const realAssets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const crashingAssets: AssetCapability = {
      ...realAssets,
      uploadProductionAsset: async () => {
        throw new Error("simulated statement timeout persisting the resumed result");
      },
    };
    await exhaustJob(repo, job, { providerRequestId: "existing-topaz-request-persist-fails" });

    const worker = createFinalArtworkWorkerCapability(repo, crashingAssets, provider);
    const result = await worker.recoverExhaustedSignProviderResult(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.finalStatus, "failed");
    }
    assert.equal(provider.dispatchCount, 0, "the persistence failure happens strictly AFTER a successful resume -- still zero fresh submissions");
    assert.equal(provider.resumeOnlyCallCount, 1);

    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.providerKey, "fake_sign_reconstruction_v1", "a local persistence failure is not proof the provider request failed -- identity must survive");
    assert.equal(final!.providerRequestId, "existing-topaz-request-persist-fails");
    assert.equal(
      final!.providerRecoveryAttempts,
      MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
      "still exactly 5 -- safely retryable again through this same no-submit path, exactly as the requirement names",
    );
  });
});

/**
 * Query-Narrowing Phase (real Signs acceptance incident, reproducible
 * SQLSTATE 57014): `listAssetsForFinalArtworkJob` isolation. The narrow
 * repository method's whole purpose is to never return rows belonging to a
 * different job or a different project than the one asked for.
 */
describe("Query-Narrowing Phase: listAssetsForFinalArtworkJob isolation", () => {
  it("returns only assets for the exact project + finalArtworkJob pair", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const project = await repo.createProject();
    const projectId = project.project.id;
    const jobA = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "sign_preparation",
      signPreparationId: "prep-a",
      signPlanKey: "plan-a",
    });
    const jobB = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "sign_preparation",
      signPreparationId: "prep-b",
      signPlanKey: "plan-b",
    });
    const assetForA = await repo.createAsset(projectId, {
      kind: "generated_artwork",
      storageKey: "a",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 10,
      heightPx: 10,
      hasTransparency: true,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: jobA.id,
      productionRole: "production_png",
    });
    await repo.createAsset(projectId, {
      kind: "generated_artwork",
      storageKey: "b",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 10,
      heightPx: 10,
      hasTransparency: true,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: jobB.id,
      productionRole: "production_png",
    });

    const forA = await repo.listAssetsForFinalArtworkJob(projectId, jobA.id);
    assert.equal(forA.length, 1, "another job in the same project must be excluded");
    assert.equal(forA[0]!.id, assetForA.id);
  });

  it("excludes assets belonging to a different project even if a caller supplied a job id from that project", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const projectOne = await repo.createProject();
    const projectTwo = await repo.createProject();
    const job = await repo.createFinalArtworkJob(projectOne.project.id, {
      sourceKind: "sign_preparation",
      signPreparationId: "prep-1",
      signPlanKey: "plan-1",
    });
    await repo.createAsset(projectOne.project.id, {
      kind: "generated_artwork",
      storageKey: "one",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 10,
      heightPx: 10,
      hasTransparency: true,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
    });

    // Tenant-defense-in-depth: the real job id is correct, but the project
    // id supplied is wrong -- must return nothing, never trust job id alone.
    const crossTenant = await repo.listAssetsForFinalArtworkJob(projectTwo.project.id, job.id);
    assert.equal(crossTenant.length, 0);
  });

  it("returns nothing for a job with no assets, without throwing", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const project = await repo.createProject();
    const job = await repo.createFinalArtworkJob(project.project.id, {
      sourceKind: "sign_preparation",
      signPreparationId: "prep-empty",
      signPlanKey: "plan-empty",
    });
    const result = await repo.listAssetsForFinalArtworkJob(project.project.id, job.id);
    assert.deepEqual(result, []);
  });
});
