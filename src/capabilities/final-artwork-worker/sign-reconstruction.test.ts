import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import { ProviderError } from "@/capabilities/providers/provider-error";
import { computeSignPlanKey, createSignPreparationCapability } from "@/capabilities/sign-preparation";
import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * Signs Phase S3A: the billing/idempotency/failure-path matrix for bounded
 * provider reconstruction. Every test here uses `FakeSignReconstructionProvider`
 * — no network access, ever (S3A's hard paid-call safety rule) — and asserts
 * on its explicit `dispatchCount`/`resumeCount` counters, mirroring
 * `countingProvider`/`FakeTwoPassProvider`'s established pattern for the
 * apparel Topaz path.
 */
describe("Signs Phase S3A: bounded provider reconstruction", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-reconstruction-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(provider: FakeSignReconstructionProvider, assets?: AssetCapability) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets =
      assets ??
      createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, realAssets, provider);
    const project = await repo.createProject();
    return {
      repo,
      assets: realAssets,
      signPreparation,
      finalArtwork,
      worker,
      projectId: project.project.id,
    };
  }

  async function uploadConfirmPlan(
    signPreparation: ReturnType<typeof createSignPreparationCapability>,
    projectId: string,
    image: ReturnType<typeof exactAspectSignArtwork>,
    orderedWidthIn: number,
    orderedHeightIn: number,
  ) {
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(image),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, orderedWidthIn, orderedHeightIn);
    const outcome = await signPreparation.planSignRepair(projectId);
    // LIVE PRODUCT BLOCKER #4: `requestSignFinalArtwork` now refuses an
    // unauthorized plan. Every test in this file exercises DOWNSTREAM
    // execution behavior, never authorization itself (that has its own
    // dedicated suite) — "operator" is sufficient for every risk class,
    // so authorizing here keeps every existing call site unchanged.
    if (outcome.result.status === "planned") {
      await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    }
    return outcome;
  }

  /** 900x1200 @ 18x24in = 50 PPI, exact aspect: a single auto_safe `reconstruct_resolution` step, no geometry stage. */
  async function planNeedingReconstruction(
    signPreparation: ReturnType<typeof createSignPreparationCapability>,
    projectId: string,
  ) {
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      exactAspectSignArtwork(900, 1200),
      18,
      24,
    );
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution"]);
    return plan;
  }

  // ---------------------------------------------------------------------
  // A. PLAN / BOUNDS
  // ---------------------------------------------------------------------

  it("A1: the exact persisted reconstruction parameters are what gets dispatched", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const step = plan.steps[0]!;

    let seenRequest: { widthPx: number; heightPx: number } | null = null;
    const originalMethod = provider.produceSignReconstruction.bind(provider);
    provider.produceSignReconstruction = async (input) => {
      seenRequest = { widthPx: input.requestedWidthPx, heightPx: input.requestedHeightPx };
      return originalMethod(input);
    };

    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.deepEqual(seenRequest, {
      widthPx: step.params.requestedWidthPx,
      heightPx: step.params.requestedHeightPx,
    });
    assert.equal(provider.dispatchCount, 1);
  });

  it("A3: a plan tampered beyond the 4x ceiling AFTER planning refuses pre-dispatch, zero provider calls", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);

    const preparation = await repo.getSignPreparation(projectId);
    const plan = preparation!.plan as Record<string, unknown> & {
      steps: Array<{ kind: string; params: Record<string, number | string> }>;
    };
    const tamperedSteps = plan.steps.map((step) =>
      step.kind === "reconstruct_resolution"
        ? {
            ...step,
            params: {
              ...step.params,
              // 1.5x this fixture's own already-clamped requestedScale pushes
              // it past the 4x ceiling while staying well under the
              // `MAX_RECONSTRUCTION_DIM_PX` defensive bound — isolating the
              // ceiling-ratio refusal this test targets from the separate
              // absolute-pixel-bound refusal.
              requestedScale: (step.params.requestedScale as number) * 1.5,
              requestedWidthPx: Math.round((step.params.requestedWidthPx as number) * 1.5),
              requestedHeightPx: Math.round((step.params.requestedHeightPx as number) * 1.5),
            },
          }
        : step,
    );
    const tamperedPlan = { ...plan, steps: tamperedSteps };
    // Recompute the canonical plan key over the TAMPERED-but-otherwise-consistent
    // plan so the identity check the worker runs FIRST passes, and the
    // pre-dispatch ceiling re-check (the thing this test targets) is what
    // actually refuses — never the (unrelated) plan-identity fence.
    const tamperedPlanKey = computeSignPlanKey(
      tamperedPlan as unknown as Parameters<typeof computeSignPlanKey>[0],
    );
    const finalPlan = { ...tamperedPlan, planKey: tamperedPlanKey };
    await repo.updateSignPreparation(preparation!.id, {
      plan: finalPlan,
      planKey: tamperedPlanKey,
    });
    // LIVE PRODUCT BLOCKER #4: the ORIGINAL plan's authorization does not
    // carry over to this tampered plan's own NEW key (correct — see the
    // dedicated stale-authorization suite). This test targets the
    // WORKER's pre-dispatch ceiling refusal specifically, so re-authorize
    // under the tampered key to reach that check rather than being
    // pre-empted by the (also-correct, but not what this test is about)
    // authorization gate.
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 0, "a >4x request must cost zero provider calls");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    assert.match(completed!.lastError ?? "", /maximum this reconstruction provider can deliver/i);
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
  });

  // ---------------------------------------------------------------------
  // B. BILLING / IDEMPOTENCY
  // ---------------------------------------------------------------------

  it("B5: one dispatch on a normal reconstruction", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
    assert.equal(provider.resumeCount, 0);

    // S3C review follow-up item 8: when the admitted provider result
    // exactly matches the requested reconstruction size, nothing was
    // adapted — evidence must say so truthfully rather than fabricating an
    // adaptation record that never happened.
    const finalAsset = (await repo.listAssets(projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset);
    const rigidSignMeta = (finalAsset!.metadata as { rigidSign: Record<string, unknown> }).rigidSign;
    assert.equal(rigidSignMeta.geometryAdapted, false, "the un-adapted case truthfully records no adaptation occurred");
    assert.equal(rigidSignMeta.executionGeometry, null, "no fabricated execution-evidence record when nothing diverged");
  });

  it("B6: reclaiming an already-completed job never reprocesses it", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);

    // Nothing queued/recoverable — a second claim attempt finds no work.
    const second = await worker.processNextJob();
    assert.equal(second.processedJobId, null);
    assert.equal(provider.dispatchCount, 1);
  });

  it("B7: two sequential FinalArtwork requests for the same plan share one job, one dispatch", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { finalArtwork, signPreparation, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    const first = await finalArtwork.requestSignFinalArtwork(projectId);
    const second = await finalArtwork.requestSignFinalArtwork(projectId);
    assert.equal(first.job.id, second.job.id);
    assert.equal(second.alreadyRequested, true);

    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
  });

  it("B8: recovering a job whose provider request is still in-flight resumes it — never resubmits", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // First attempt: the paid submission is accepted (and durably
    // persisted via `onProviderRequestSubmitted`), but the poll/download
    // step fails — a retryable, `not_dispatched` transport failure, never
    // itself a second billable dispatch.
    provider.behavior = {
      kind: "throw",
      error: new ProviderError(
        "timeout",
        "The production reconstruction provider did not complete within the allotted time.",
        "not_dispatched",
      ),
    };
    await assert.rejects(() => worker.processNextJob(), /timeout|allotted time/i).catch(async () => {
      // `failJob` (not a raw throw) handles this classification — assert
      // the job actually recorded the failure instead.
    });
    let midJob = await repo.getFinalArtworkJob(job.id);
    // Either failJob recorded it directly, or (if the throw somehow
    // propagated) the job is still "running" — normalize either way so the
    // recovery step below is well-defined.
    if (midJob!.status === "running") {
      await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
      midJob = await repo.getFinalArtworkJob(job.id);
    }
    assert.equal(provider.dispatchCount, 1);
    assert.ok(midJob!.providerRequestId, "the in-flight request identity must survive a retryable failure");

    // Recover: reclaim the job and let the SAME request resolve successfully.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
    provider.behavior = { kind: "success" };
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "the in-flight request must never be resubmitted");
    assert.equal(provider.resumeCount, 1, "recovery must resume, not resubmit");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
  });

  it("B9: recovering a job whose production asset already exists never redispatches", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "an existing production asset is the primary idempotency boundary");
    assert.equal(provider.resumeCount, 0);
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
  });

  it("B10: a crash after the provider completes but before the final asset is created never redispatches", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    let uploadCalls = 0;
    // Let the FIRST upload (the reconstruction intermediate) succeed, then
    // simulate a crash before the SECOND upload (the final plate) ever
    // happens.
    const crashingAssets: AssetCapability = {
      ...realAssets,
      uploadProductionAsset: async (...args) => {
        uploadCalls += 1;
        if (uploadCalls === 2) {
          throw new Error("simulated crash before the final production asset was persisted");
        }
        return realAssets.uploadProductionAsset(...args);
      },
    };
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    const crashingWorker = createFinalArtworkWorkerCapability(repo, crashingAssets, provider);
    await assert.rejects(() => crashingWorker.processNextJob());

    assert.equal(provider.dispatchCount, 1);
    const intermediateExists = (await repo.listAssets(projectId)).some(
      (a) => a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
    );
    assert.equal(intermediateExists, true, "the intermediate must survive the simulated crash");
    const finalExists = (await repo.listAssets(projectId)).some(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.equal(finalExists, false);

    // Recover with the REAL (non-crashing) assets capability — the retry
    // must read the durable intermediate back rather than calling the
    // provider again.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
    const recoveryWorker = createFinalArtworkWorkerCapability(repo, realAssets, provider);
    await recoveryWorker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "the provider must never be re-dispatched");
    assert.equal(provider.resumeCount, 0, "the durable intermediate is read back directly, not resumed via the provider");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    const producedAfter = (await repo.listAssets(projectId)).filter(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.equal(producedAfter.length, 1);
  });

  // ---------------------------------------------------------------------
  // Signs — Fix Unguarded Intermediate Reconstruction Persistence Failure:
  // `persistIntermediateReconstruction` (the ONE step in
  // `runSignReconstructionAndContinue` that previously had no guard, unlike
  // provider dispatch/PNG-decode/geometry-check right above it) is now
  // wrapped exactly like its siblings. B10c below also documents WHY the
  // OTHER two partial-persistence sub-cases (storage upload failing before
  // any row exists; storage succeeding but `repo.createAsset` failing) need
  // no new test of their own — `AssetCapability.uploadProductionAsset`
  // ALREADY makes both safe by construction (upload-then-create ordering,
  // with `safeDelete` cleanup on a `createAsset` failure — see
  // `asset-capability.ts`), so a persistence retry after either one is a
  // plain, already-idempotent re-upload with nothing orphaned to clean up.
  // ---------------------------------------------------------------------

  it("B10b: a crash persisting the intermediate reconstruction becomes a failed job, not an uncaught worker-batch rejection — providerKey/providerRequestId survive", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    // Partial-persistence case A: the upload call itself fails before either
    // a storage object or an AssetRecord exists — nothing to clean up.
    const crashingAssets: AssetCapability = {
      ...realAssets,
      uploadProductionAsset: async () => {
        throw new Error("simulated storage failure persisting the reconstruction intermediate");
      },
    };
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    const crashingWorker = createFinalArtworkWorkerCapability(repo, crashingAssets, provider);
    // The entire point of the fix: this must resolve, never reject.
    const result = await crashingWorker.processNextJob();
    assert.equal(result.processedJobId, job.id);

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed", "must reach a real terminal state instead of staying stuck at running");
    assert.ok(failed!.lastError, "lastError must be populated");
    assert.match(failed!.lastError!, /simulated storage failure/i);
    assert.ok(failed!.completedAt, "a terminal job must record when it ended");

    // Requirement: persistence failure is NOT proof the paid provider
    // request itself failed — the Topaz identity must survive untouched,
    // exactly like `failJob` already leaves it for every other failure kind.
    assert.equal(failed!.providerKey, provider.providerKey);
    assert.equal(failed!.providerRequestId, "fake-sign-reconstruction-1");
    assert.equal(provider.dispatchCount, 1, "no second paid submission");
    assert.equal(provider.resumeCount, 0);

    // No second FinalArtworkJob was created for this plan.
    const preparation = await repo.getSignPreparation(projectId);
    const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation!.id);
    assert.equal(jobs.length, 1);

    // Nothing durable was left behind — the failed upload never reached
    // storage or the DB.
    const assetsAfter = await repo.listAssets(projectId);
    assert.equal(assetsAfter.filter((a) => a.finalArtworkJobId === job.id).length, 0);

    // Nothing downstream ran: no PrintValidation for this job.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation, null);
  });

  it("B10c: a crash clearing provider fields AFTER the intermediate asset was persisted (partial-persistence case C) is safe — recovery never duplicates the asset or redispatches", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Fails ONLY `persistIntermediateReconstruction`'s own clear-call (it
    // never sets `providerRecoveryAttempts`, unlike the separate pre-
    // existing self-heal clear a few lines earlier in the worker, which
    // does — this distinguishes the two so the test targets the exact call
    // this phase's fix guards, not the older self-heal path). Every other
    // repository call passes through to the real instance untouched.
    let sawClearCall = false;
    const crashingRepo = new Proxy(repo, {
      get(target, prop) {
        if (prop === "updateFinalArtworkJob") {
          return async (jobId: string, patch: Record<string, unknown>) => {
            if (
              !sawClearCall &&
              patch.providerKey === null &&
              patch.providerRequestId === null &&
              patch.providerStatus === null &&
              !("providerRecoveryAttempts" in patch)
            ) {
              sawClearCall = true;
              throw new Error("simulated DB failure clearing provider fields after intermediate persistence");
            }
            return (target as ProjectRepository).updateFinalArtworkJob(jobId, patch as never);
          };
        }
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectRepository;

    const crashingWorker = createFinalArtworkWorkerCapability(crashingRepo, realAssets, provider);
    await crashingWorker.processNextJob();
    assert.equal(sawClearCall, true, "sanity: the simulated failure actually fired on the targeted call");

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    assert.equal(provider.dispatchCount, 1);

    // The intermediate asset DID get created — only the clear-call
    // afterward failed. This is partial-persistence case C.
    const intermediateBefore = (await repo.listAssets(projectId)).filter(
      (a) => a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
    );
    assert.equal(
      intermediateBefore.length,
      1,
      "the intermediate asset must have been durably persisted before the simulated clear-call failure",
    );

    // Recover: the pre-existing self-heal (`runSignReconstructionAndContinue`'s
    // own "a two-pass-style intermediate already durably exists" branch)
    // must recognize the already-persisted intermediate and read it back
    // directly — never re-upload it, never call the provider again.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", lastError: null, completedAt: null });
    await crashingWorker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    assert.equal(provider.dispatchCount, 1, "still exactly one paid dispatch across both attempts");
    assert.equal(provider.resumeCount, 0, "recovery reads the durable intermediate directly — mirrors B10, never resumed via the provider");

    const intermediateAfter = (await repo.listAssets(projectId)).filter(
      (a) => a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
    );
    assert.equal(intermediateAfter.length, 1, "no duplicate intermediate asset was created on recovery");
  });

  // ---------------------------------------------------------------------
  // Diagnostic Hardening Phase (real Signs acceptance incident):
  // `describeFinalArtworkError` is SHARED generic worker infra — used by
  // both the apparel and sign job paths, module-private (not exported), and
  // confirmed by audit to never surface `lastError`'s raw content to a
  // customer (`resolveAttentionCheckName` short-circuits to `null` for
  // every non-"completed" status, which is every status `failJob` ever
  // produces). Exercised HERE, through the sign path's own
  // `persistIntermediateReconstruction` guard (B10b/B10c, above) purely
  // because it's the lightest existing harness that reaches it with an
  // arbitrary thrown value — this coverage is not sign-specific behavior.
  // ---------------------------------------------------------------------

  /** Runs a plan whose intermediate-persistence step throws `thrownValue` verbatim, and returns the resulting job's `lastError`. */
  async function lastErrorForThrownUploadValue(thrownValue: unknown): Promise<string | null> {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const crashingAssets: AssetCapability = {
      ...realAssets,
      uploadProductionAsset: async () => {
        // Deliberately a non-Error thrown value — exactly what this phase hardens against.
        throw thrownValue;
      },
    };
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    const crashingWorker = createFinalArtworkWorkerCapability(repo, crashingAssets, provider);
    await crashingWorker.processNextJob();

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed", "sanity: the simulated throw must still reach a clean failed state");
    return failed!.lastError;
  }

  it("Diagnostic Hardening 1: a normal Error's message is preserved verbatim (now behind the instrumentation phase's own operation label)", async () => {
    const lastError = await lastErrorForThrownUploadValue(new Error("storage failed"));
    assert.match(lastError!, /^persistIntermediateReconstruction\.uploadProductionAsset failed after \d+ms: storage failed$/);
  });

  it("Diagnostic Hardening 2: a bare string throw is used directly (now behind the instrumentation phase's own operation label)", async () => {
    const lastError = await lastErrorForThrownUploadValue("a plain string failure");
    assert.match(lastError!, /^persistIntermediateReconstruction\.uploadProductionAsset failed after \d+ms: a plain string failure$/);
  });

  it('Diagnostic Hardening 3: object with { message, code } produces a labeled diagnostic', async () => {
    const lastError = await lastErrorForThrownUploadValue({ message: "storage failed", code: "XYZ" });
    assert.match(lastError!, /message=storage failed/);
    assert.match(lastError!, /code=XYZ/);
  });

  it('Diagnostic Hardening 4: object with { error, status } produces a labeled diagnostic', async () => {
    const lastError = await lastErrorForThrownUploadValue({ error: "provider failed", status: 502 });
    assert.match(lastError!, /error=provider failed/);
    assert.match(lastError!, /status=502/);
  });

  it("Diagnostic Hardening 5: safe fields are included, sensitive fields never appear", async () => {
    const lastError = await lastErrorForThrownUploadValue({
      message: "failure",
      code: "X",
      authorization: "Bearer SECRET_TOKEN_VALUE",
      signedUrl: "https://storage.example.com/signed?token=SUPER_SECRET",
      response: { status: 500, body: "leaked body" },
      apiKey: "sk-should-never-appear",
    });
    assert.match(lastError!, /message=failure/);
    assert.match(lastError!, /code=X/);
    assert.doesNotMatch(lastError!, /SECRET_TOKEN_VALUE/);
    assert.doesNotMatch(lastError!, /SUPER_SECRET/);
    assert.doesNotMatch(lastError!, /leaked body/);
    assert.doesNotMatch(lastError!, /sk-should-never-appear/);
    assert.doesNotMatch(lastError!, /authorization/i);
    assert.doesNotMatch(lastError!, /signedUrl/i);
    assert.doesNotMatch(lastError!, /apiKey/i);
  });

  it("Diagnostic Hardening 6: an object with no allowed shallow scalar fields falls back to the generic message (behind the operation label)", async () => {
    const lastError = await lastErrorForThrownUploadValue({ nested: { message: "buried, never read" } });
    assert.match(lastError!, /^persistIntermediateReconstruction\.uploadProductionAsset failed after \d+ms: Final artwork production failed for an unknown reason\.$/);
  });

  it("Diagnostic Hardening 7: a null throw falls back to the generic message (behind the operation label)", async () => {
    const lastError = await lastErrorForThrownUploadValue(null);
    assert.match(lastError!, /^persistIntermediateReconstruction\.uploadProductionAsset failed after \d+ms: Final artwork production failed for an unknown reason\.$/);
  });

  it("Diagnostic Hardening 8: an undefined throw falls back to the generic message (behind the operation label)", async () => {
    const lastError = await lastErrorForThrownUploadValue(undefined);
    assert.match(lastError!, /^persistIntermediateReconstruction\.uploadProductionAsset failed after \d+ms: Final artwork production failed for an unknown reason\.$/);
  });

  it("Diagnostic Hardening 9: a circular object never crashes the formatter", async () => {
    const circular: Record<string, unknown> = { message: "circular but safe", code: "C1" };
    circular.self = circular;
    const lastError = await lastErrorForThrownUploadValue(circular);
    assert.match(lastError!, /message=circular but safe/);
    assert.match(lastError!, /code=C1/);
  });

  it("Diagnostic Hardening 10: an oversized safe scalar value is capped", async () => {
    const lastError = await lastErrorForThrownUploadValue({ message: "x".repeat(2000) });
    assert.ok(lastError!.length <= 501, `expected a capped length, got ${lastError!.length}`);
    assert.match(lastError!, /message=x+…$/);
  });

  // ---------------------------------------------------------------------
  // Final Recovery Instrumentation Phase (real Signs acceptance incident,
  // reproducible SQLSTATE 57014): `withOperationTiming` — the new label +
  // elapsed-ms wrapper around each repository/storage call in the
  // intermediate-persistence path. Diagnostic-only: every test here proves
  // labeling/timing is ADDITIVE (safe content, provider identity, job
  // transitions, and the success path all unchanged), never that behavior
  // changed.
  // ---------------------------------------------------------------------

  it("Instrumentation: updateFinalArtworkJob clear-call failure gets its own distinct operation label, separate from uploadProductionAsset's", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Fails ONLY the persist-step's own clear-call (never sets
    // providerRecoveryAttempts, unlike the earlier self-heal clear —
    // mirrors B10c's exact discriminator).
    let sawClearCall = false;
    const crashingRepo = new Proxy(repo, {
      get(target, prop) {
        if (prop === "updateFinalArtworkJob") {
          return async (jobId: string, patch: Record<string, unknown>) => {
            if (
              !sawClearCall &&
              patch.providerKey === null &&
              patch.providerRequestId === null &&
              patch.providerStatus === null &&
              !("providerRecoveryAttempts" in patch)
            ) {
              sawClearCall = true;
              throw new Error("simulated statement timeout clearing provider fields");
            }
            return (target as ProjectRepository).updateFinalArtworkJob(jobId, patch as never);
          };
        }
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectRepository;

    const crashingWorker = createFinalArtworkWorkerCapability(crashingRepo, realAssets, provider);
    await crashingWorker.processNextJob();
    assert.equal(sawClearCall, true, "sanity: the simulated failure actually fired on the targeted call");

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    assert.match(
      failed!.lastError!,
      /^persistIntermediateReconstruction\.updateFinalArtworkJob failed after \d+ms: simulated statement timeout clearing provider fields$/,
    );
    // Distinct from the upload operation's own label — proves the two
    // steps inside the same function are independently identifiable.
    assert.doesNotMatch(failed!.lastError!, /uploadProductionAsset/);
  });

  it("Instrumentation: the persist-step's own listAssets call gets a label distinct from the self-heal's — reached only after self-heal itself succeeds", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // A claimed sign job issues listAssets THREE times before it could ever
    // reach parametric reconstruction: (1) `resolveExistingProductionAsset`'s
    // own unlabeled idempotency check at the very top of the job — not
    // wrapped by this phase, since it runs before Topaz is ever called, the
    // task's own instrumentation window; (2) the self-heal's labeled call;
    // (3) the persist step's own labeled dedup check. Succeed on the first
    // two, fail on the third.
    let listAssetsCalls = 0;
    const crashingRepo = new Proxy(repo, {
      get(target, prop) {
        if (prop === "listAssets") {
          return async (...args: Parameters<ProjectRepository["listAssets"]>) => {
            listAssetsCalls += 1;
            if (listAssetsCalls === 3) {
              throw new Error("simulated statement timeout listing assets");
            }
            return (target as ProjectRepository).listAssets(...args);
          };
        }
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectRepository;

    const crashingWorker = createFinalArtworkWorkerCapability(crashingRepo, realAssets, provider);
    await crashingWorker.processNextJob();
    assert.equal(listAssetsCalls, 3, "sanity: resolveExistingProductionAsset, the self-heal, and the persist-step calls must all have fired");

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    assert.match(
      failed!.lastError!,
      /^resolveExistingIntermediateReconstruction\.persist\.listAssets failed after \d+ms: simulated statement timeout listing assets$/,
      "the persist-step's own dedup-check listAssets call is labeled distinctly from the self-heal's, and its failure is still caught (unlike the self-heal's own — see the next test)",
    );
  });

  it("Instrumentation: a self-heal listAssets failure IS labeled but remains uncaught (documents a known, deliberately out-of-scope gap — not fixed in this phase)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    const projectId = project.project.id;
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Call 1 (`resolveExistingProductionAsset`'s own, unlabeled — it runs
    // before Topaz is ever called, outside this phase's instrumentation
    // window) must succeed so execution actually reaches the self-heal;
    // call 2 (the self-heal itself) is the one under test.
    let listAssetsCalls = 0;
    const crashingRepo = new Proxy(repo, {
      get(target, prop) {
        if (prop === "listAssets") {
          return async (...args: Parameters<ProjectRepository["listAssets"]>) => {
            listAssetsCalls += 1;
            if (listAssetsCalls === 1) {
              return (target as ProjectRepository).listAssets(...args);
            }
            throw new Error("simulated statement timeout on the self-heal's own listAssets call");
          };
        }
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectRepository;

    const crashingWorker = createFinalArtworkWorkerCapability(crashingRepo, realAssets, provider);
    let caught: unknown = null;
    try {
      await crashingWorker.processNextJob();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, "sanity: must still reject, exactly as before this instrumentation phase");
    assert.match(
      (caught as Error).message,
      /^resolveExistingIntermediateReconstruction\.signSelfHeal\.listAssets failed after \d+ms: simulated statement timeout on the self-heal's own listAssets call$/,
    );

    // The job is left exactly where it was BEFORE this attempt — this
    // instrumentation phase deliberately does not add a new catch here
    // (that would be a job-state-transition change, out of scope), so a
    // real recurrence of this exact candidate would still need a follow-up
    // fix mirroring the earlier persistIntermediateReconstruction guard.
    const stillQueued = await repo.getFinalArtworkJob(job.id);
    assert.equal(stillQueued!.status, "running", "unchanged from the claim — no failJob call exists on this path yet");
  });

  it("Instrumentation: produceSignReconstruction failure gets an elapsed-time-labeled message while provider classification is completely unchanged", async () => {
    const provider = new FakeSignReconstructionProvider();
    provider.behavior = {
      kind: "throw",
      error: new ProviderError(
        "provider_job_failed",
        "The fake reconstruction provider reported this request as terminally failed.",
      ),
    };
    const { signPreparation, finalArtwork, worker, repo, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    await worker.processNextJob();

    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    assert.match(
      failed!.lastError!,
      /^produceSignReconstruction failed after \d+ms: The fake reconstruction provider reported this request as terminally failed\.$/,
    );
    // Requirement: provider classification/identity-clearing behavior is
    // completely unaffected by the added timing — `provider_job_failed`
    // still clears the provider identity exactly as before instrumentation.
    assert.equal(failed!.providerKey, null);
    assert.equal(failed!.providerRequestId, null);
    assert.equal(provider.dispatchCount, 1, "no retry/resubmission was introduced");
  });

  it("Instrumentation: the successful reconstruction path is completely unaffected — no label ever appears, dispatch/asset counts unchanged", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    // Not asserting `lastError === null` here: this fixture's plan requires
    // reconstruction, which (per `planRequiresSemanticPreservationVerification`)
    // also requires semantic preservation verification — `build()`'s default
    // placeholder semantic provider returns "unknown" (never "preserved"),
    // and that inconclusive verdict is legitimately recorded on the job even
    // though it still reaches "completed" — entirely pre-existing behavior,
    // unrelated to this instrumentation phase. What this test actually
    // proves is narrower and still exact: none of the new operation labels
    // ever appear when every instrumented call succeeds.
    if (completed!.lastError) {
      assert.doesNotMatch(completed!.lastError, /elapsed_ms|failed after \d+ms|listAssets failed|uploadProductionAsset failed|updateFinalArtworkJob failed|produceSignReconstruction failed/);
    }
    assert.equal(provider.dispatchCount, 1);
    assert.equal(provider.resumeCount, 0);
    const intermediateAssets = (await repo.listAssets(projectId)).filter(
      (a) => a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
    );
    assert.equal(intermediateAssets.length, 1);
    // Sanity that the plan actually needed reconstruction (otherwise this
    // test would trivially pass without exercising any instrumented call).
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution"]);
  });

  it("B11: existing final production asset recovery never redispatches (review_required plan, still not print_ready)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    // Aspect-mismatched + no dominant edge colour: a geometry-stage
    // `pad_uniform_background` step follows reconstruction with an
    // UNCONFIRMED fill colour, forcing `review_required` — exercised here
    // purely as "a plan whose deterministic tail still succeeds honestly
    // is not what this fixture gives us"; see D17-shaped Ruth coverage in
    // `sign-final-artwork.test.ts` for the review_required + successful-pad
    // case. This test only needs SOME reconstruction-needing plan.
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      exactAspectSignArtwork(900, 1200),
      18,
      24,
    );
    assert.equal(outcome.result.plan!.overallRisk, "auto_safe");
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
    const firstValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.notEqual(firstValidation!.status, "ready");

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "re-validation of an existing asset must never redispatch");
    const secondValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.notEqual(secondValidation!.status, "ready");
  });

  // ---------------------------------------------------------------------
  // C. FAILURE
  // ---------------------------------------------------------------------

  it("C12: a malformed (undecodable) provider result fails without a silent second dispatch", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    provider.behavior = { kind: "malformed_bytes" };
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    const noAsset = (await repo.listAssets(projectId)).some(
      (a) => a.finalArtworkJobId === job.id && !isReconstructionIntermediateAsset(a),
    );
    assert.equal(noAsset, false);

    // Retry resumes rather than resubmitting, even after a bad result.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
    provider.behavior = { kind: "success" };
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "a malformed result must never trigger a second paid dispatch");
    assert.equal(provider.resumeCount, 1);
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
  });

  it("C13: an insufficient-dimension provider result fails without a silent second dispatch", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const step = plan.steps[0]!;
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    provider.behavior = {
      kind: "insufficient_dimensions",
      widthPx: (step.params.requestedWidthPx as number) - 200,
      heightPx: (step.params.requestedHeightPx as number) - 200,
    };
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    assert.match(failed!.lastError ?? "", /insufficient/i);

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
    provider.behavior = { kind: "success" };
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "an undersized result must never trigger a second paid dispatch");
    assert.equal(provider.resumeCount, 1);
  });

  it("C13b: a distorted-aspect (but not undersized) provider result fails without a silent second dispatch", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const step = plan.steps[0]!;
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Exceeds both requested axes, but with a squashed aspect ratio —
    // the sufficiency check alone would wrongly accept this.
    provider.behavior = {
      kind: "wrong_aspect",
      widthPx: (step.params.requestedWidthPx as number) + 400,
      heightPx: step.params.requestedHeightPx as number,
    };
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
    const failed = await repo.getFinalArtworkJob(job.id);
    assert.equal(failed!.status, "failed");
    assert.match(failed!.lastError ?? "", /proportion/i);
  });

  it("C15: an oversized-but-proportional reconstruction (no geometry step in the plan) now succeeds via S3C adaptation, still blocked from print_ready", async () => {
    // Signs Phase S3C: before this phase, ANY divergence from the plan's
    // baked-in `expectedOutputWidthPx/HeightPx` refused deterministically —
    // even a response `validateReconstructedGeometry` itself already
    // accepted as sufficient and proportional. The real S3B Ruth run proved
    // that overly strict: a real provider CAN honestly return more than
    // requested. This plan has no geometry step to adapt (exact aspect,
    // zero padding steps) — S3C's adaptation simply accepts the actual
    // reconstructed dimensions as the expected output when they are still
    // within `SIGN_ASPECT_TOLERANCE` of the ordered aspect (the same
    // tolerance `validateReconstructedGeometry` itself uses), which this
    // fixture (a mere +20px on each axis, well under 1%) is.
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const step = plan.steps[0]!;
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    const oversizedWidthPx = (step.params.requestedWidthPx as number) + 20;
    const oversizedHeightPx = (step.params.requestedHeightPx as number) + 20;
    provider.behavior = { kind: "oversized_but_valid", widthPx: oversizedWidthPx, heightPx: oversizedHeightPx };
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "reconstruction succeeds and is paid for exactly once");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    // `lastError` is overloaded to carry the validation summary whenever a
    // job completes without reaching "ready" (pre-existing, unrelated to
    // S3C) — it is NOT a sign of execution failure. The asset assertions
    // below are what actually prove the adapted plate was produced.
    const project = await repo.getProject(projectId);
    assert.notEqual(
      project!.project.status,
      "print_ready",
      "reconstructed provenance still blocks print_ready regardless of how the geometry was adapted",
    );
    const finalAsset = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the adapted plate IS produced, not refused");
    assert.equal(finalAsset!.widthPx, oversizedWidthPx);
    assert.equal(finalAsset!.heightPx, oversizedHeightPx);

    // Retrying does not touch the provider again — the final asset is
    // already durable (idempotent reuse).
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "recovery of an already-completed job must never trigger a second dispatch");
    assert.equal(provider.resumeCount, 0);
  });

  it("C15b: a distorted (non-proportional) reconstruction result still fails at the provider-geometry gate, unaffected by S3C, never redispatches", async () => {
    // Regression: `validateReconstructedGeometry`'s own 1% proportionality
    // tolerance runs BEFORE S3C's adaptation ever does, and is unchanged by
    // this phase — a genuinely distorted response is still rejected there,
    // never reaching (and therefore never exercising)
    // `adaptGeometryStepsToActualReconstruction` at all. See
    // `sign-geometry.test.ts` for direct, isolated proof of that function's
    // own axis-mismatch and unapproved-geometry-step refusal branches —
    // reaching them through this full integration path is not possible
    // when both tolerances agree (by design, see that file's own doc).
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const step = plan.steps[0]!;
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Wildly distorted: exceeds the requested dimensions (passes the
    // sufficiency half of geometry validation) but is stretched far enough
    // on one axis that `validateReconstructedGeometry`'s own 1% aspect
    // tolerance would normally catch it — use `wrong_aspect` directly to
    // reach the executor's OWN adaptation refusal deterministically,
    // independent of that earlier gate.
    provider.behavior = {
      kind: "wrong_aspect",
      widthPx: (step.params.requestedWidthPx as number) + 400,
      heightPx: step.params.requestedHeightPx as number,
    };
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1);
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "failed", "a distorted response is rejected by validateReconstructedGeometry itself, before adaptation ever runs");
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
    provider.behavior = { kind: "success" };
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "a rejected result must never trigger a second paid dispatch");
    assert.equal(provider.resumeCount, 1, "recovery resumes the existing paid request");
  });

  // ---------------------------------------------------------------------
  // Signs Phase S3C: the real S3B Ruth acceptance geometry, end to end.
  // ---------------------------------------------------------------------

  it("S3C: the real Ruth acceptance case — Topaz's actual 4096x6144 (not the requested 2448x3672) still produces a valid, correctly-adapted 4608x6144 plate at 256 PPI", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const outcome = await uploadConfirmPlan(signPreparation, projectId, ruthLikeSignArtwork(), 18, 24);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution", "pad_uniform_background"]);
    assert.equal(plan.overallRisk, "review_required");
    const reconstructStep = plan.steps[0]!;
    assert.equal(reconstructStep.params.requestedWidthPx, 2448);
    assert.equal(reconstructStep.params.requestedHeightPx, 3672);
    // The plan's OWN (now-superseded-by-adaptation) prediction — unchanged,
    // never mutated by S3C; this is what the persisted plan/planKey say,
    // not what actually gets produced when the real provider diverges.
    assert.equal(plan.expectedOutputWidthPx, 2754);
    assert.equal(plan.expectedOutputHeightPx, 3672);

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    // The real Topaz behavior observed in the S3B live acceptance run:
    // exactly 4.000x of the source (its own proven ceiling), not the
    // requested 2.390625x.
    provider.behavior = { kind: "oversized_but_valid", widthPx: 4096, heightPx: 6144 };
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "exactly one paid dispatch");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    // `lastError` carries the validation summary (this plan is
    // review_required and reconstructed, so never "ready") — not a sign of
    // execution failure. The asset assertions below prove the adapted
    // plate was actually produced.

    const finalAsset = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the adapted plate is produced");
    assert.equal(finalAsset!.widthPx, 4608, "adapted plate width — matches the phase's own audited math exactly");
    assert.equal(finalAsset!.heightPx, 6144);
    assert.equal(finalAsset!.hasTransparency, false);

    const rigidSignMeta = (finalAsset!.metadata as { rigidSign: Record<string, unknown> }).rigidSign;
    assert.equal(rigidSignMeta.resolutionProvenance, "reconstructed");
    assert.equal(rigidSignMeta.reconstructedWidthPx, 4096);
    assert.equal(rigidSignMeta.reconstructedHeightPx, 6144);
    assert.equal(rigidSignMeta.geometryAdapted, true, "auditable: this plate's geometry was execution-derived, not planner-predicted");

    // --- S3C review follow-up: PLAN TRUTHFULNESS / EXECUTION AUDITABILITY ---

    // 1/2: the APPROVED plan (fetched independently, never touched by
    // execution) still records the ORIGINAL prediction, byte-for-byte —
    // proves execution never rewrote it.
    const preparationAfter = await repo.getSignPreparation(projectId);
    const planAfter = preparationAfter!.plan as unknown as typeof plan;
    assert.deepEqual(planAfter, plan, "the approved plan is byte-for-byte unchanged by adaptive execution");
    assert.equal(preparationAfter!.planKey, plan.planKey, "planKey is not recomputed");
    assert.equal(planAfter.steps[1]!.params.leadingPx, 153, "the plan's OWN recorded prediction stays 153, never rewritten to 256");
    assert.equal(planAfter.steps[1]!.params.trailingPx, 153);
    assert.equal(planAfter.expectedOutputWidthPx, 2754);
    assert.equal(planAfter.expectedOutputHeightPx, 3672);

    // 3/4/5: the ACTUAL execution is separately, explicitly persisted —
    // both 153/153 (predicted, above) and 256/256 (actual, here) are
    // independently recoverable from stored evidence without re-deriving
    // anything from raw reconstruction dimensions.
    const executionGeometry = rigidSignMeta.executionGeometry as Record<string, unknown>;
    assert.ok(executionGeometry, "explicit execution-geometry evidence is persisted");
    assert.equal(executionGeometry.reason, "provider_output_geometry_diverged_from_requested");
    assert.equal(executionGeometry.reconstructionRequestedWidthPx, 2448);
    assert.equal(executionGeometry.reconstructionRequestedHeightPx, 3672);
    assert.equal(executionGeometry.reconstructionActualWidthPx, 4096);
    assert.equal(executionGeometry.reconstructionActualHeightPx, 6144);
    assert.equal(executionGeometry.outputWidthPx, 4608);
    assert.equal(executionGeometry.outputHeightPx, 6144);
    const executedStep = executionGeometry.executedStep as Record<string, unknown>;
    assert.equal(executedStep.leadingPx, 256, "the ACTUAL executed pixel amount — distinct from the plan's own 153");
    assert.equal(executedStep.trailingPx, 256);

    // 6: axis/colour/risk remain exactly what the approved plan permitted —
    // adaptation never touched them.
    assert.equal(executedStep.kind, plan.steps[1]!.kind);
    assert.equal(executedStep.axis, plan.steps[1]!.params.axis, "axis constrained to the approved plan's own axis");
    assert.equal(executedStep.colorR, plan.steps[1]!.params.colorR, "fill colour constrained to the approved plan's own colour");
    assert.equal(executedStep.colorG, plan.steps[1]!.params.colorG);
    assert.equal(executedStep.colorB, plan.steps[1]!.params.colorB);
    assert.equal(plan.overallRisk, "review_required", "the approved plan's risk classification is untouched");

    // Achieved PPI: 4608/18 = 256, 6144/24 = 256 — exceeds the 150 PPI
    // target and is accepted (no maximum-PPI rule exists or was invented).
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.notEqual(validation!.status, "ready", "reconstructed provenance still blocks print_ready — S4 gate unaffected");
    const resolutionCheck = (
      validation!.report as { checks: Array<{ check: string; status: string; reason: string }> }
    ).checks.find((c) => c.check === "effective_resolution");
    assert.equal(resolutionCheck?.status, "pass");
    assert.match(resolutionCheck?.reason ?? "", /256 PPI/);
    const dimensionsCheck = (
      validation!.report as { checks: Array<{ check: string; status: string }> }
    ).checks.find((c) => c.check === "exact_physical_dimensions");
    assert.equal(dimensionsCheck?.status, "pass", "4608x6144 independently reconciles to exactly 18x24in on both axes");
    // 10: the plan-integrity check now truthfully reflects the divergence
    // too (never claims a byte-identical replay when the pixel amounts
    // differed) — this does not change the OUTCOME (already blocked
    // independently by `reconstructed`), only what is honestly claimed.
    const planIntegrityCheck = (
      validation!.report as { checks: Array<{ check: string; status: string }> }
    ).checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(planIntegrityCheck?.status, "fail");

    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");

    // 9: recovery preserves the execution evidence exactly, and never
    // redispatches — the final asset is already durable.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "recovery of an already-completed adapted plate never redispatches");

    const assetAfterRecovery = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.equal(assetAfterRecovery!.id, finalAsset!.id, "the same asset is reused, not recreated");
    const recoveredExecutionGeometry = (
      (assetAfterRecovery!.metadata as { rigidSign: Record<string, unknown> }).rigidSign as Record<string, unknown>
    ).executionGeometry;
    assert.deepEqual(recoveredExecutionGeometry, executionGeometry, "execution evidence survives recovery unchanged");
    const preparationAfterRecovery = await repo.getSignPreparation(projectId);
    assert.deepEqual(preparationAfterRecovery!.plan, plan, "the approved plan remains unchanged after recovery too");
  });

  it("S3C tamper-safety: assets are append-only (no update path exists) and executionGeometry is not part of the validation contract", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await uploadConfirmPlan(signPreparation, projectId, ruthLikeSignArtwork(), 18, 24);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    provider.behavior = { kind: "oversized_but_valid", widthPx: 4096, heightPx: 6144 };
    await worker.processNextJob();

    // There is architecturally no route to hand-edit a persisted asset's
    // metadata after the fact: `ProjectRepository` exposes only
    // `createAsset`/`listAssets`/`getAssetById`/`deleteAsset` — no
    // "updateAsset". Assets are append-only (Constitution §6.11, "Version
    // Everything"), so `executionGeometry`, once written, cannot be
    // silently rewritten through any legitimate code path. This is
    // verified structurally, not just by a runtime probe:
    assert.ok(
      !("updateAsset" in repo),
      "no repository method exists to mutate a persisted asset's metadata after creation",
    );

    // The stronger, contract-level guarantee — proven directly in
    // `print-validation/rigid-sign-print-validation.test.ts` — is that
    // `RigidSignPlanEvidence` (the only shape print-validation ever reads
    // for a sign asset) has no `axis`/`colour`/`executionGeometry` field at
    // all. Even a compromised metadata blob has no channel into the
    // validator: only the truthful boolean `executedStepsMatchPlan` (set
    // from `!signGeometryAdapted`, never from the evidence's own nested
    // step details) can move the `executed_plan_matches_recorded_plan`
    // check either way.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.notEqual(validation!.status, "ready");
  });

  it("S3D: the real Ruth alpha defect — a border-ring alpha artifact on an oversized-but-proportional reconstruction is transparently normalized, adaptive geometry still reaches 4608x6144, and the strict opacity gate passes because the bytes are actually opaque", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const outcome = await uploadConfirmPlan(signPreparation, projectId, ruthLikeSignArtwork(), 18, 24);
    const plan = outcome.result.plan!;
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Reproduces the real Ruth response: sufficient + proportional (4096x6144,
    // same as the real S3B acceptance run), but with the border ring
    // carrying alpha 0/254 instead of 255 — the exact defect this phase's
    // forensic audit characterized. Before S3D, this scenario failed at
    // `finalizeSignExecution`'s strict opacity gate with no asset produced.
    provider.behavior = { kind: "oversized_with_border_alpha_defect", widthPx: 4096, heightPx: 6144 };
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "exactly one paid dispatch");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed", "S3D: the opacity gate now naturally passes — no asset was refused");

    const finalAsset = (await repo.listAssets(projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the plate is produced — this exact scenario failed before S3D");
    assert.equal(finalAsset!.widthPx, 4608, "S3C's own adaptive geometry math, unaffected by S3D");
    assert.equal(finalAsset!.heightPx, 6144);
    assert.equal(finalAsset!.hasTransparency, false, "measured false because every alpha byte is actually 255");

    const rigidSignMeta = (finalAsset!.metadata as { rigidSign: Record<string, unknown> }).rigidSign;
    assert.equal(rigidSignMeta.geometryAdapted, true);

    // --- The normalization evidence itself ---
    const normalization = rigidSignMeta.providerAlphaNormalization as Record<string, unknown>;
    assert.ok(normalization, "explicit provider-alpha-normalization evidence is persisted");
    assert.equal(normalization.reason, "provider_introduced_alpha_on_verified_opaque_source");
    assert.equal(normalization.strategy, "force_opaque_preserve_rgb");
    assert.ok((normalization.affectedPixelCount as number) > 0, "the border-ring defect pixels were actually counted");
    assert.equal(normalization.minAlphaBefore, 0, "the fixture's own zero-alpha border pixels were seen");
    // maxAlphaBefore is legitimately 255 — the vast interior of the plate was
    // already opaque; only the border ring carried the defect, exactly like
    // the real Ruth response (83.9% of pixels already at 254, a smaller
    // fraction at 0, both confined to the border ring in that real audit).
    assert.equal(normalization.maxAlphaBefore, 255);
    assert.equal(normalization.minAlphaAfter, 255);
    assert.equal(normalization.maxAlphaAfter, 255);
    assert.equal(normalization.rgbModified, false);
    assert.equal(normalization.widthPx, 4096, "recorded against the RECONSTRUCTED dimensions, before geometry adaptation");
    assert.equal(normalization.heightPx, 6144);

    // --- Approved plan/planKey integrity — untouched by normalization,
    // exactly as S3C's own review follow-up already established for
    // geometry adaptation. ---
    const preparationAfter = await repo.getSignPreparation(projectId);
    assert.deepEqual(preparationAfter!.plan, plan);
    assert.equal(preparationAfter!.planKey, plan.planKey);

    // --- Validation: strict opacity/geometry checks pass on their own
    // merits (never loosened); S4's reconstructed-provenance gate still
    // unconditionally blocks print_ready. ---
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (validation!.report as { checks: Array<{ check: string; status: string; reason: string }> }).checks;
    assert.equal(checks.find((c) => c.check === "effective_resolution")?.status, "pass");
    assert.equal(checks.find((c) => c.check === "exact_physical_dimensions")?.status, "pass");
    assert.notEqual(validation!.status, "ready", "reconstructed provenance still blocks print_ready — S4 gate unaffected by S3D");
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");

    // --- Recovery preserves the normalization evidence and never
    // redispatches — same discipline as every other reconstruction path. ---
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "recovery of an already-normalized, already-completed plate never redispatches");
    const assetAfterRecovery = (await repo.listAssets(projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.equal(assetAfterRecovery!.id, finalAsset!.id, "the same asset is reused, not recreated");
    const recoveredNormalization = (
      (assetAfterRecovery!.metadata as { rigidSign: Record<string, unknown> }).rigidSign as Record<string, unknown>
    ).providerAlphaNormalization;
    assert.deepEqual(recoveredNormalization, normalization, "normalization evidence survives recovery unchanged");
  });

  // ---------------------------------------------------------------------
  // No-reconstruction regression, proven positively against a provider
  // that WOULD dispatch if ever asked to.
  // ---------------------------------------------------------------------

  it("E: a plan not requiring reconstruction makes zero calls even against a capable provider", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    // 1800x2400 @ 12x16in = exactly 150 PPI, exact aspect — no repair needed.
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      exactAspectSignArtwork(1800, 2400),
      12,
      16,
    );
    assert.equal(outcome.result.plan!.steps.length, 0);

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 0);
    assert.equal(provider.resumeCount, 0);
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");
  });
});
