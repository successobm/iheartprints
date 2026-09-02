import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER } from "@/capabilities/final-artwork/production-request-identity";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import type {
  SignReconstructionProvider,
  SignReconstructionProviderInput,
  SignReconstructionProviderOutput,
  SignReconstructionResumeInput,
  SignReconstructionResumeProvider,
} from "@/capabilities/final-artwork/sign-reconstruction-provider";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { createSignPreservationCapability } from "@/capabilities/sign-preservation";
import type {
  SignPreservationSemanticProvider,
  SignPreservationSemanticProviderResult,
  SignPreservationSemanticRequest,
} from "@/capabilities/sign-preservation/sign-preservation-semantic-provider";
import type { ProjectRepository } from "@/lib/db/repository";
import type { FinalArtworkJob, FinalArtworkJobStatus } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  createFinalArtworkWorkerCapability,
  DEFAULT_FINAL_ARTWORK_STALE_JOB_MS,
} from "./final-artwork-worker-capability";

/**
 * Post-Provider Resume Phase (real Signs acceptance incident: a job stuck
 * at `status: "running"` with a stale heartbeat, its own provider-identity
 * columns already cleared by `persistIntermediateReconstruction`'s own
 * unconditional post-persist clear, but a fully valid, durably persisted
 * `pass1_intermediate` asset on file): `resumeSignFromPersistedIntermediate`
 * — a genuinely different lifecycle operation from
 * `recoverExhaustedSignProviderResult` (that one resumes an in-flight
 * provider request; this one requires the provider stage to ALREADY be
 * durably complete and is structurally incapable of ever reaching a
 * provider). Every "success" test here uses THROWING provider doubles for
 * both Topaz (reconstruction) and OpenAI (semantic) — not call-counting
 * spies — so any accidental provider touch fails the test immediately via
 * an uncaught rejection, rather than merely being detectable after the
 * fact.
 */

/** Throws unconditionally from every method — the strongest possible proof a call path never reaches it. */
class ThrowingSignReconstructionProvider
  implements FinalArtworkProvider, SignReconstructionProvider, SignReconstructionResumeProvider
{
  readonly providerKey = "throwing_sign_reconstruction_test_double";

  async produce(_input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    throw new Error("Topaz produce() must never be called from the post-provider resume path");
  }

  async produceSignReconstruction(
    _input: SignReconstructionProviderInput,
  ): Promise<SignReconstructionProviderOutput> {
    throw new Error("Topaz submit (produceSignReconstruction) must never be called from the post-provider resume path");
  }

  async resumeSignReconstruction(
    _input: SignReconstructionResumeInput,
  ): Promise<SignReconstructionProviderOutput> {
    throw new Error("Topaz resume/download must never be called from the post-provider resume path");
  }
}

/** Throws unconditionally — proves the semantic (OpenAI) boundary is never reached by this resume path. */
class ThrowingSignPreservationSemanticProvider implements SignPreservationSemanticProvider {
  readonly providerKey = "throwing_semantic_test_double";
  readonly modelIdentity = "throwing_semantic_test_double_model";
  readonly transportVersion = "throwing_semantic_test_double_transport";

  async compare(
    _request: SignPreservationSemanticRequest,
  ): Promise<SignPreservationSemanticProviderResult> {
    throw new Error("OpenAI/semantic compare() must never be called from the post-provider resume path");
  }
}

describe("Post-Provider Resume Phase: resumeSignFromPersistedIntermediate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-post-provider-resume-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /** A planned, authorized, reconstruction-needing sign job — deliberately NOT yet claimed/run. */
  async function buildPreparedProject() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
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

    return { repo, assets, signPreparation, finalArtwork, projectId, job };
  }

  /** Persists a durable `pass1_intermediate` asset for `job`, mirroring exactly what `persistIntermediateReconstruction` itself writes. */
  async function persistIntermediateFor(
    assets: AssetCapability,
    projectId: string,
    job: FinalArtworkJob,
    providerRequestId: string,
    overrides: { metadata?: Record<string, unknown> } = {},
  ) {
    return assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: true,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: overrides.metadata ?? {
        reconstructionStage: RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
        providerKey: "topaz_transparency_upscale",
        providerRequestId,
      },
    });
  }

  /**
   * Existing Final-Asset Reuse Phase: persists a FINAL (non-intermediate)
   * production asset for `job` — mirrors what `reconstruct_parametric_frame`
   * itself would have already produced. Deliberately carries no
   * `reconstructionStage` marker, so `isReconstructionIntermediateAsset`
   * (and therefore `resolveExistingProductionAsset`) never mistakes it for
   * the pass1 intermediate.
   */
  async function persistFinalAssetFor(assets: AssetCapability, projectId: string, job: FinalArtworkJob) {
    return assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-final`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2700)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2700,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {
        rigidSign: {
          planKey: "sign-repair-plan:v1:test",
          providerKey: "topaz_transparency_upscale",
        },
      },
    });
  }

  /** Puts a job into the exact real-incident shape: provider stage complete, identity cleared, stuck at a given status/heartbeat age. */
  async function stallJobPostPersist(
    repo: ProjectRepository,
    job: FinalArtworkJob,
    overrides: {
      status?: FinalArtworkJobStatus;
      heartbeatAgeMs?: number;
      providerRecoveryAttempts?: number;
    } = {},
  ): Promise<FinalArtworkJob> {
    const heartbeatAgeMs = overrides.heartbeatAgeMs ?? DEFAULT_FINAL_ARTWORK_STALE_JOB_MS + 60_000;
    return repo.updateFinalArtworkJob(job.id, {
      status: overrides.status ?? "running",
      startedAt: new Date(Date.now() - heartbeatAgeMs).toISOString(),
      heartbeatAt: new Date(Date.now() - heartbeatAgeMs).toISOString(),
      providerKey: null,
      providerRequestId: null,
      providerStatus: null,
      providerRecoveryAttempts: overrides.providerRecoveryAttempts ?? 5,
      lastError: null,
      completedAt: null,
    });
  }

  function buildWorker(repo: ProjectRepository, assets: AssetCapability, useThrowingSemantic = true) {
    const reconstructionProvider = new ThrowingSignReconstructionProvider();
    const signPreservation = useThrowingSemantic
      ? createSignPreservationCapability(repo, assets, new ThrowingSignPreservationSemanticProvider())
      : undefined;
    const worker = signPreservation
      ? createFinalArtworkWorkerCapability(repo, assets, reconstructionProvider, undefined, undefined, undefined, signPreservation)
      : createFinalArtworkWorkerCapability(repo, assets, reconstructionProvider);
    return { worker, reconstructionProvider };
  }

  // -------------------------------------------------------------------
  // Refusal preconditions — each must fail closed, mutate nothing, touch no provider.
  // -------------------------------------------------------------------

  it("refuses when there is no sign preparation for the project", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const project = await repo.createProject();
    const { worker } = buildWorker(repo, assets);

    const result = await worker.resumeSignFromPersistedIntermediate(project.project.id);
    assert.deepEqual(result, { outcome: "refused", reason: "no_sign_preparation" });
  });

  it("refuses when there is no plan yet", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const project = await repo.createProject();
    await signPreparation.uploadSignArtwork(project.project.id, {
      bytes: toPngBytes(exactAspectSignArtwork(900, 1200)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(project.project.id);
    assert.deepEqual(result, { outcome: "refused", reason: "no_plan" });
  });

  it("refuses on current-plan mismatch — a re-plan since the job was enqueued leaves no matching job (wrong-lineage: current plan mismatch)", async () => {
    const { repo, assets, signPreparation, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "historical-request-1");
    await stallJobPostPersist(repo, job);
    // Re-plan with a materially different ordered size -- the preparation's
    // planKey changes, but the stalled job still carries the OLD one.
    await signPreparation.confirmSignProductionSpec(projectId, 24, 36);
    await signPreparation.planSignRepair(projectId);

    const { worker, reconstructionProvider } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_matching_job" });

    const untouched = await repo.getFinalArtworkJob(job.id);
    assert.equal(untouched!.status, "running", "the stale job itself must not be touched by this refusal");
    void reconstructionProvider;
  });

  it("refuses for a job status that isn't reclaimable (e.g. completed)", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date().toISOString() });

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "job_status_not_reclaimable" });
  });

  it("refuses to steal a running job whose heartbeat is still fresh (a genuinely active worker must not be stolen)", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "historical-request-1");
    await stallJobPostPersist(repo, job, { heartbeatAgeMs: 5_000 });

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "active_worker_still_fresh" });

    const untouched = await repo.getFinalArtworkJob(job.id);
    assert.equal(untouched!.status, "running");
  });

  it("refuses when no persisted intermediate exists for this job (missing intermediate)", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await stallJobPostPersist(repo, job);
    // Deliberately never persisted an intermediate.

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_persisted_intermediate" });
  });

  it("refuses when the only persisted asset belongs to a DIFFERENT job (wrong job intermediate)", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    const otherJob = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "sign_preparation",
      signPreparationId: "other-prep",
      signPlanKey: "other-plan-key",
    });
    await persistIntermediateFor(assets, projectId, otherJob, "historical-request-1");
    await stallJobPostPersist(repo, job);

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_persisted_intermediate" });
  });

  it("refuses when the only persisted asset belongs to a DIFFERENT project (wrong project intermediate)", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    const otherProject = await repo.createProject();
    await persistIntermediateFor(assets, otherProject.project.id, job, "historical-request-1");
    await stallJobPostPersist(repo, job);

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_persisted_intermediate" });
  });

  it("refuses when the intermediate's own lineage is malformed (marker present but no recorded providerRequestId)", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "unused", {
      metadata: { reconstructionStage: RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER },
    });
    await stallJobPostPersist(repo, job);

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.deepEqual(result, { outcome: "refused", reason: "no_persisted_intermediate" });
  });

  // -------------------------------------------------------------------
  // Behavior once every precondition holds — zero provider contact proofs.
  // -------------------------------------------------------------------

  it("resumes a stale running job from its persisted intermediate — SAME job, zero Topaz/OpenAI contact, budget untouched", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "historical-topaz-request-1");
    await stallJobPostPersist(repo, job, { providerRecoveryAttempts: 5 });

    const { worker } = buildWorker(repo, assets);
    // Throwing doubles for BOTH Topaz and OpenAI — if this resolves at all
    // rather than rejecting, neither was ever touched.
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.jobId, job.id, "requirement 1: operates on the SAME FinalArtworkJob");
    }

    const jobsForPrep = await repo.listFinalArtworkJobsForSignPreparation(
      projectId,
      (await repo.getSignPreparation(projectId))!.id,
    );
    assert.equal(jobsForPrep.length, 1, "requirement 2: no new FinalArtworkJob was created");

    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.providerRecoveryAttempts, 5, "requirement 5/6: providerRecoveryAttempts neither reset nor incremented");
  });

  it("resumes a failed job (not just running) from its persisted intermediate, with the same zero-provider-contact guarantee", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "historical-topaz-request-1");
    await stallJobPostPersist(repo, job, { status: "failed", providerRecoveryAttempts: 5 });

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.jobId, job.id);
    }
    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.providerRecoveryAttempts, 5);
  });

  it("a fresh startedAt is set only when reclaiming from failed; a stale running lease keeps its original startedAt", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "historical-topaz-request-1");
    const staleStartedAt = new Date(Date.now() - DEFAULT_FINAL_ARTWORK_STALE_JOB_MS - 120_000).toISOString();
    await repo.updateFinalArtworkJob(job.id, {
      status: "running",
      startedAt: staleStartedAt,
      heartbeatAt: staleStartedAt,
      providerKey: null,
      providerRequestId: null,
      providerStatus: null,
      providerRecoveryAttempts: 5,
    });

    const { worker } = buildWorker(repo, assets);
    await worker.resumeSignFromPersistedIntermediate(projectId);

    const final = await repo.getFinalArtworkJob(job.id);
    assert.equal(final!.startedAt, staleStartedAt, "a reclaimed running lease preserves its true original start time");
  });

  it("duplicate invocation is safe — a second call never duplicates the intermediate, never touches a provider, never creates a second job", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    // This fixture's synthetic intermediate bytes are not a geometrically
    // plan-compliant reconstruction (a real Topaz result is never
    // fabricated here — see this phase's own zero-provider-contact design),
    // so downstream deterministic verification legitimately rejects it and
    // the job lands back at "failed" — itself one of the two reclaimable
    // states this operation supports (Phase 6: "failed + valid intermediate
    // if legitimate"). A duplicate invocation while still reclaimable is
    // therefore expected to be ALLOWED (a legitimate retry), not refused —
    // what this test actually proves is that neither call ever touches a
    // provider and neither ever duplicates the intermediate or the job.
    await persistIntermediateFor(assets, projectId, job, "historical-topaz-request-1");
    await stallJobPostPersist(repo, job, { providerRecoveryAttempts: 5 });

    const { worker } = buildWorker(repo, assets);
    const first = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.equal(first.outcome, "attempted");

    const second = await worker.resumeSignFromPersistedIntermediate(projectId);
    // Both throwing provider doubles are shared across both calls — if
    // either call had touched Topaz or OpenAI, this line would never be
    // reached (an uncaught rejection would fail the test first).
    assert.equal(second.outcome, "attempted", "a legitimate retry while still reclaimable is allowed");

    const jobsForPrep = await repo.listFinalArtworkJobsForSignPreparation(
      projectId,
      (await repo.getSignPreparation(projectId))!.id,
    );
    assert.equal(jobsForPrep.length, 1, "no second FinalArtworkJob was created across two invocations");

    const intermediateAssets = (await repo.listAssetsForFinalArtworkJob(projectId, job.id)).filter(
      (asset) =>
        asset.productionRole === "production_png" &&
        (asset.metadata as Record<string, unknown> | null)?.reconstructionStage ===
          RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
    );
    assert.equal(intermediateAssets.length, 1, "the intermediate itself was never duplicated across two invocations");
  });

  it("a job intermediate whose recorded providerRequestId is a non-empty string is accepted regardless of the job's own (already-null) provider fields — provenance lives in the asset now", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    const persisted = await persistIntermediateFor(assets, projectId, job, "historical-topaz-request-distinct");
    await stallJobPostPersist(repo, job, { providerRecoveryAttempts: 5 });

    const { worker } = buildWorker(repo, assets);
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);
    assert.equal(result.outcome, "attempted");
    assert.equal(
      (persisted.metadata as Record<string, unknown>).providerRequestId,
      "historical-topaz-request-distinct",
      "sanity: the intermediate's own provenance is the historical Topaz request, untouched",
    );
  });

  // -------------------------------------------------------------------
  // Existing Final-Asset Reuse Phase: the parametric-frame reconstruction
  // itself (a purely local, non-provider operation) must never re-run once
  // a final production asset already exists for this job — proven here at
  // the resume-capability layer, not just relying on
  // `resolveExistingProductionAsset`'s own pre-existing short-circuit
  // implicitly.
  // -------------------------------------------------------------------

  it("an existing final production asset is reused — reconstruction is never re-executed, no duplicate asset, zero provider contact", async () => {
    const { repo, assets, projectId, job } = await buildPreparedProject();
    await persistIntermediateFor(assets, projectId, job, "historical-topaz-request-1");
    const existingFinal = await persistFinalAssetFor(assets, projectId, job);
    await stallJobPostPersist(repo, job, { providerRecoveryAttempts: 5 });

    const { worker } = buildWorker(repo, assets);
    // Both Topaz and OpenAI doubles remain throwing — if reconstruction (or
    // anything provider-facing) were re-executed, this would fail via an
    // uncaught rejection before ever reaching the assertions below.
    const result = await worker.resumeSignFromPersistedIntermediate(projectId);

    assert.equal(result.outcome, "attempted");
    if (result.outcome === "attempted") {
      assert.equal(result.jobId, job.id, "same FinalArtworkJob");
    }

    const jobAssets = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    const finalCandidates = jobAssets.filter(
      (a) =>
        a.productionRole === "production_png" &&
        (a.metadata as Record<string, unknown> | null)?.reconstructionStage !==
          RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
    );
    assert.equal(finalCandidates.length, 1, "no duplicate final production asset was created");
    assert.equal(finalCandidates[0]!.id, existingFinal.id, "the SAME existing final asset was reused, not replaced");

    const finalJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(finalJob!.providerRecoveryAttempts, 5, "providerRecoveryAttempts untouched");
  });
});
