import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
  uniformBackgroundSignArtwork,
} from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * Signs Phase S2 (deterministic-only) regression coverage: for any plan
 * that does NOT require bounded provider reconstruction (Signs Phase S3A),
 * ZERO provider calls are made. `ThrowingProvider` below is the apparel
 * `FinalArtworkProvider` this worker still requires structurally, and it
 * throws the instant `produce()` is ever invoked — and it implements no
 * `SignReconstructionProvider` capability at all, so a plan that DID need
 * reconstruction would fail closed (infrastructure failure, zero dispatch)
 * rather than silently proceeding. Every deterministic-only scenario below
 * proves zero provider calls by never triggering that throw or that
 * failure.
 */
class ThrowingProvider implements FinalArtworkProvider {
  readonly providerKey = "must_never_be_called";
  async produce(_input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    throw new Error("S2 must never dispatch any provider for a sign job");
  }
}

describe("Signs Phase S2: rigid-sign finalization", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-final-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(provider: FinalArtworkProvider = new ThrowingProvider()) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const project = await repo.createProject();
    return { repo, assets, signPreparation, finalArtwork, worker, projectId: project.project.id };
  }

  async function uploadConfirmPlan(
    signPreparation: ReturnType<typeof createSignPreparationCapability>,
    projectId: string,
    image: ReturnType<typeof uniformBackgroundSignArtwork>,
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

  it("1/21: exact-aspect, sufficient resolution — no unnecessary repair, reaches print_ready", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    // 1800x2400 @ 12x16in = exactly 150 PPI, exact 3:4 aspect.
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      exactAspectSignArtwork(1800, 2400),
      12,
      16,
    );
    assert.equal(outcome.result.status, "planned");
    assert.equal(outcome.result.plan!.steps.length, 0);
    assert.equal(outcome.result.plan!.overallRisk, "auto_safe");

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    assert.equal(job.sourceKind, "sign_preparation");
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const validations = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validations!.status, "ready");
  });

  it("2: uniform-background aspect mismatch, resolvable without provider — AUTO_SAFE, reaches print_ready", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    // 1000x1500 (2:3) on 8x10in: contain = 6.667x10in @ EXACTLY 150 PPI
    // (the target) — no reconstruction AND no downsample is needed;
    // extension is AUTO_SAFE because the fixture's edges are provably
    // uniform.
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      uniformBackgroundSignArtwork(1000, 1500),
      8,
      10,
    );
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["extend_uniform_background"]);
    assert.equal(plan.overallRisk, "auto_safe");

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const assets = await repo.listAssets(projectId);
    const produced = assets.find((a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png");
    assert.ok(produced);
    assert.equal(produced!.widthPx, plan.expectedOutputWidthPx);
    assert.equal(produced!.heightPx, plan.expectedOutputHeightPx);
    assert.equal(produced!.hasTransparency, false);
  });

  it("3/23: low-resolution exact-aspect — Signs Phase S3A bounded reconstruction, one mocked dispatch, no print_ready", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    // 900x1200 @ 18x24in = 50 PPI — needs reconstruction, no aspect repair
    // (900:1200 already matches 18:24 exactly).
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
    assert.equal(plan.overallRisk, "auto_safe");

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "exactly one mocked paid dispatch");
    assert.equal(provider.resumeCount, 0);

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");

    const project = await repo.getProject(projectId);
    assert.notEqual(
      project!.project.status,
      "print_ready",
      "reconstructed provenance must block print_ready pending S4 preservation verification",
    );

    const produced = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(produced, "the deterministic plate completes despite print_ready being blocked");
    assert.equal(produced!.widthPx, plan.expectedOutputWidthPx);
    assert.equal(produced!.heightPx, plan.expectedOutputHeightPx);
    const rigidSignMeta = (produced!.metadata as { rigidSign: Record<string, unknown> }).rigidSign;
    assert.equal(rigidSignMeta.resolutionProvenance, "reconstructed");
    assert.equal(rigidSignMeta.providerKey, provider.providerKey);

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.notEqual(validation!.status, "ready");
  });

  it("4/22: Ruth-shaped fixture — Signs Phase S3A bounded reconstruction + deterministic pad, exact math, review requirement intact, no print_ready", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);
    const outcome = await uploadConfirmPlan(signPreparation, projectId, ruthLikeSignArtwork(), 18, 24);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution", "pad_uniform_background"]);
    assert.equal(plan.overallRisk, "review_required");
    assert.ok(plan.defects.includes("foreground_reaches_extension_edge"));
    // Exact S0 audit math: 1024x1536 @ 64 native PPI -> 150 PPI target ->
    // 2.390625x -> 2448x3672 reconstructed -> 153px/side pad -> 2754x3672.
    const reconstructStep = plan.steps[0]!;
    assert.equal(reconstructStep.params.requestedWidthPx, 2448);
    assert.equal(reconstructStep.params.requestedHeightPx, 3672);
    assert.equal(plan.expectedOutputWidthPx, 2754);
    assert.equal(plan.expectedOutputHeightPx, 3672);

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.equal(provider.dispatchCount, 1, "exactly one mocked paid dispatch");
    assert.equal(provider.resumeCount, 0);

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");

    const produced = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(produced, "the deterministic pad step still completes the plate");
    assert.equal(produced!.widthPx, 2754);
    assert.equal(produced!.heightPx, 3672);
    assert.equal(produced!.hasTransparency, false);
    const rigidSignMeta = (produced!.metadata as { rigidSign: Record<string, unknown> }).rigidSign;
    assert.equal(rigidSignMeta.resolutionProvenance, "reconstructed");
    assert.equal(rigidSignMeta.reconstructedWidthPx, 2448);
    assert.equal(rigidSignMeta.reconstructedHeightPx, 3672);
    assert.equal(rigidSignMeta.nativeWidthPx, 1024);
    assert.equal(rigidSignMeta.nativeHeightPx, 1536);

    // print_ready remains blocked — the rigid-sign validation gate
    // (`resolutionProvenance === "reconstructed"`) refuses readiness
    // unconditionally, independent of the review requirement below.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.notEqual(validation!.status, "ready");

    // The review requirement is still on record, unaffected by the fact
    // that execution now proceeds past it.
    const persistedPrep = await repo.getSignPreparation(projectId);
    assert.ok((persistedPrep!.plan as { defects: string[] }).defects.includes("foreground_reaches_extension_edge"));
  });

  it("5/9: a corrupted source hash in the persisted plan refuses before any transformation", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    await uploadConfirmPlan(signPreparation, projectId, uniformBackgroundSignArtwork(1000, 1500), 6, 8);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Corrupt the persisted plan's own source hash directly (simulating
    // tampering/corruption between planning and execution) while leaving
    // `planKey` at its stale, now-disagreeing value — the plan-identity
    // recompute must catch this before any pixel is touched.
    const preparation = await repo.getSignPreparation(projectId);
    const corruptedPlan = { ...(preparation!.plan as Record<string, unknown>), sourceSha256: "f".repeat(64) };
    await repo.updateSignPreparation(preparation!.id, { plan: corruptedPlan });

    await worker.processNextJob();
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    assert.match(completed!.lastError ?? "", /identity verification/i);
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
    const asset = (await repo.listAssets(projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png",
    );
    assert.equal(asset, undefined);
  });

  it("10: an ordered-size change after planning (without re-planning) refuses at execution", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    await uploadConfirmPlan(signPreparation, projectId, uniformBackgroundSignArtwork(1000, 1500), 6, 8);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Re-confirm a DIFFERENT ordered size without re-planning — the
    // preparation's `orderedWidthIn`/`orderedHeightIn` now disagree with
    // the persisted plan's own recorded ordered size, while `status` stays
    // "planned" and `planKey` is untouched.
    await signPreparation.confirmSignProductionSpec(projectId, 10, 14);

    await worker.processNextJob();
    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed");
    assert.match(completed!.lastError ?? "", /ordered size|policy/i);
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
  });

  it("8: a re-plan supersedes the queued job rather than executing it under the old plan key", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    await uploadConfirmPlan(signPreparation, projectId, uniformBackgroundSignArtwork(1000, 1500), 6, 8);
    const { job: firstJob } = await finalArtwork.requestSignFinalArtwork(projectId);

    // Re-plan against a different confirmed size (which itself first
    // requires re-confirming), producing a NEW plan key while the first
    // job stays bound to the old one.
    await signPreparation.confirmSignProductionSpec(projectId, 8, 10);
    await signPreparation.planSignRepair(projectId);

    await worker.processNextJob();
    const superseded = await repo.getFinalArtworkJob(firstJob.id);
    assert.equal(superseded!.status, "cancelled");
    assert.notEqual(superseded!.lastError, null);
  });

  it("14: two sequential requests for the same plan are idempotent — one job, reused", async () => {
    const { worker, finalArtwork, signPreparation, projectId } = await build();
    await uploadConfirmPlan(signPreparation, projectId, uniformBackgroundSignArtwork(1000, 1500), 6, 8);
    const first = await finalArtwork.requestSignFinalArtwork(projectId);
    const second = await finalArtwork.requestSignFinalArtwork(projectId);
    assert.equal(first.job.id, second.job.id);
    assert.equal(second.alreadyRequested, true);
    // `claimNextQueuedFinalArtworkJob` claims the oldest due job GLOBALLY
    // (mirrors the apparel worker's real cross-project claim), so a job
    // left queued here would intercept a later test's own claim. Drain it,
    // exactly as a real deployed worker eventually would.
    await worker.processNextJob();
  });

  it("recovery: a retried job with an existing production asset reuses it — no re-execution, no duplicate asset, equivalent evidence", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      uniformBackgroundSignArtwork(1000, 1500),
      8,
      10,
    );
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    const firstRun = await repo.getFinalArtworkJob(job.id);
    assert.equal(firstRun!.status, "completed");
    const project1 = await repo.getProject(projectId);
    assert.equal(project1!.project.status, "print_ready");

    const assetsAfterFirst = await repo.listAssets(projectId);
    const producedAssets = assetsAfterFirst.filter(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png",
    );
    assert.equal(producedAssets.length, 1);
    const originalAsset = producedAssets[0]!;
    const originalWidthPx = originalAsset.widthPx;
    const originalHeightPx = originalAsset.heightPx;
    const originalMetadata = JSON.stringify(originalAsset.metadata);

    // Simulate a worker crash/retry AFTER the asset was already produced —
    // exactly the case `Goal 16`'s idempotency guarantee exists for. Reset
    // the job to `recoverable` (never touching the already-produced asset)
    // and reclaim it.
    await repo.updateFinalArtworkJob(job.id, {
      status: "recoverable",
      completedAt: null,
    });
    // `processNextJob` claims the oldest due (queued OR recoverable) job —
    // the same claim path a real crash-recovery cycle uses.
    await worker.processNextJob();

    const secondRun = await repo.getFinalArtworkJob(job.id);
    assert.equal(secondRun!.status, "completed");
    const project2 = await repo.getProject(projectId);
    assert.equal(project2!.project.status, "print_ready");

    // No duplicate production asset — idempotent reuse, not re-execution.
    const assetsAfterSecond = await repo.listAssets(projectId);
    const producedAfterSecond = assetsAfterSecond.filter(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png",
    );
    assert.equal(producedAfterSecond.length, 1);
    assert.equal(producedAfterSecond[0]!.id, originalAsset.id);
    assert.equal(producedAfterSecond[0]!.widthPx, originalWidthPx);
    assert.equal(producedAfterSecond[0]!.heightPx, originalHeightPx);
    assert.equal(JSON.stringify(producedAfterSecond[0]!.metadata), originalMetadata);

    // Lineage/plan identity survive recovery unchanged.
    const recoveredJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(recoveredJob!.signPreparationId, job.signPreparationId);
    assert.equal(recoveredJob!.signPlanKey, plan.planKey);
    const rigidSignMeta = (producedAfterSecond[0]!.metadata as { rigidSign: Record<string, unknown> }).rigidSign;
    assert.equal(rigidSignMeta.sourceAssetId, plan.sourceAssetId);
    assert.equal(rigidSignMeta.sourceSha256, plan.sourceSha256);
    assert.equal(rigidSignMeta.planKey, plan.planKey);

    // Authoritative validation ran again (append-only — a second row is
    // expected and harmless) and produced an equivalent, still-ready verdict.
    const latestValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(latestValidation!.status, "ready");
    assert.equal(latestValidation!.assetId, originalAsset.id);
  });

  it("24: dormant signage category is never touched by the sign finalization path", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    const outcome = await uploadConfirmPlan(
      signPreparation,
      projectId,
      exactAspectSignArtwork(1800, 2400),
      12,
      16,
    );
    assert.equal(outcome.result.status, "planned");
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    const report = (
      await repo.getLatestProductionAssetValidationForJob(projectId, job.id)
    )!.report as { requirements: { category: string } };
    assert.equal(report.requirements.category, "rigid_sign_raster");
    assert.notEqual(report.requirements.category, "signage");
  });
});
