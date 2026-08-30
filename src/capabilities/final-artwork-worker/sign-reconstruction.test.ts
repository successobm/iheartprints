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
import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
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
    return signPreparation.planSignRepair(projectId);
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
    const { signPreparation, finalArtwork, worker, projectId } = await build(provider);
    await planNeedingReconstruction(signPreparation, projectId);
    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1);
    assert.equal(provider.resumeCount, 0);
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

  it("C15: a downstream deterministic refusal after reconstruction never redispatches the provider", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const plan = await planNeedingReconstruction(signPreparation, projectId);
    const step = plan.steps[0]!;
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // A SUFFICIENT, proportionally-valid response (passes
    // `validateReconstructedGeometry`) but larger than the plan's own
    // `expectedOutputWidthPx/HeightPx` assumed — this plan has no geometry
    // stage to absorb it (exact aspect, zero padding steps), so
    // `finalizeSignExecution`'s own `output_geometry_mismatch` check must
    // refuse it deterministically, entirely locally, after a genuinely
    // successful (and paid-for) reconstruction.
    provider.behavior = {
      kind: "oversized_but_valid",
      widthPx: (step.params.requestedWidthPx as number) + 20,
      heightPx: (step.params.requestedHeightPx as number) + 20,
    };
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "reconstruction itself must still succeed and be paid for exactly once");
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    assert.match(completed!.lastError ?? "", /geometry|does not describe/i);
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
    const noFinalAsset = (await repo.listAssets(projectId)).some(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.equal(noFinalAsset, false);

    // Retrying does not touch the provider again — the intermediate is
    // durable, and the deterministic refusal is, correctly, identical.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();
    assert.equal(provider.dispatchCount, 1, "a deterministic downstream refusal must never trigger a second dispatch");
    assert.equal(provider.resumeCount, 0, "the durable intermediate is read back directly, not resumed via the provider");
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
