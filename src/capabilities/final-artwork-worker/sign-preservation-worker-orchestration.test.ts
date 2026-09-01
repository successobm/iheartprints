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
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import { ruthLikeSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import {
  buildCombinedVerificationAlgorithmVersion,
  createSignPreservationCapability,
  type SignPreservationCapability,
} from "@/capabilities/sign-preservation";
import { FakeSignPreservationSemanticProvider } from "@/capabilities/sign-preservation/fake-sign-preservation-semantic-provider";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * Signs Phase S4.2A.1: proves the REAL `FinalArtworkWorkerCapability`
 * orchestration seam — final reconstructed asset → deterministic
 * preservation → semantic preservation → PrintValidation — rather than
 * `SignPreservationCapability` in isolation (already exhaustively covered
 * by `sign-preservation-capability.test.ts`). Every test here uses
 * `FakeSignReconstructionProvider` and `FakeSignPreservationSemanticProvider`
 * — no test in this file, or anywhere in this repository, ever calls
 * Topaz or a real semantic/multimodal provider.
 */
describe("Signs Phase S4.2A.1: preservation verification wired through the real worker", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-preservation-worker-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(
    reconstructionProvider: FakeSignReconstructionProvider,
    semanticProvider: FakeSignPreservationSemanticProvider,
    assetsOverride?: AssetCapability,
  ) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets =
      assetsOverride ??
      createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const signPreservation = createSignPreservationCapability(repo, realAssets, semanticProvider);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      realAssets,
      reconstructionProvider,
      undefined, // printValidation — real default, untouched by this phase
      undefined, // conceptEvaluation — real default, irrelevant to signs
      undefined, // localNormalizationProvider — real default, apparel-only
      signPreservation,
    );
    const project = await repo.createProject();
    return { repo, assets: realAssets, signPreparation, finalArtwork, signPreservation, worker, projectId: project.project.id };
  }

  /** Ruth-shaped: 1024x1536 source, 18x24in ordered, actual reconstruction 4096x6144 -> final 4608x6144, 256px/256px black extension. */
  async function ruthShapedFinalAsset(
    reconstructionProvider: FakeSignReconstructionProvider,
    semanticProvider: FakeSignPreservationSemanticProvider,
    assetsOverride?: AssetCapability,
  ) {
    const built = await build(reconstructionProvider, semanticProvider, assetsOverride);
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);
    await built.signPreparation.planSignRepair(built.projectId);
    // LIVE PRODUCT BLOCKER #4: this fixture's plan is `review_required`
    // (test 7, below) — `requestSignFinalArtwork` now refuses to enqueue
    // without a sufficient authorization. "operator" is the ONLY actor
    // sufficient for `review_required`, and this suite exists to test
    // preservation-verification orchestration, not authorization itself
    // (that has its own dedicated suite) — authorize unconditionally here.
    await built.signPreparation.authorizeSignRepairPlan(built.projectId, {
      authorizedBy: "operator",
    });
    const { job } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    reconstructionProvider.behavior = { kind: "oversized_but_valid", widthPx: 4096, heightPx: 6144 };
    await built.worker.processNextJob();

    const finalAsset = (await built.repo.listAssets(built.projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the Ruth-shaped final asset must exist before the worker orchestration test proceeds");
    return { ...built, job, finalAsset: finalAsset! };
  }

  it("1: the real worker path dispatches exactly one semantic call and persists a completed preservation record", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };

    const { job, finalAsset, repo } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);

    assert.equal(semanticProvider.dispatchCount, 1);
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed", "the worker still reaches its normal terminal state");

    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      semanticProvider.providerKey,
      semanticProvider.modelIdentity,
      semanticProvider.transportVersion,
    );
    const stored = await repo.getSignPreservationVerification(finalAsset.id, combinedVersion);
    assert.ok(stored, "the worker actually persisted a preservation record, not just called the capability");
    assert.equal(stored!.status, "preserved");
  });

  it("2: a recovered/re-processed job with a completed identity reuses the existing preservation row — dispatch count stays one", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };

    const { job, repo, worker } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    assert.equal(semanticProvider.dispatchCount, 1);

    // Simulate a worker crash/recovery cycle — reclaim the same job.
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 1, "the recovered run reused the persisted preservation record");
    assert.equal(reconstructionProvider.dispatchCount, 1, "and never re-dispatched reconstruction either");
  });

  it("3: structurally invalid deterministic evidence reached through the worker -> zero semantic dispatches", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" }; // would certify 'preserved' if ever asked — must never be asked

    const { job, repo, assets, finalAsset } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);

    // A pure test-harness technique — never touches the actually-persisted
    // asset — that makes the final asset's bytes unreadable for exactly
    // this one re-processing pass, forcing deterministic structural
    // authority to be invalid without corrupting anything real.
    const brokenAssets: AssetCapability = {
      ...assets,
      async downloadAssetBytes(id: string) {
        if (id === finalAsset.id) return null;
        return assets.downloadAssetBytes(id);
      },
    };
    // A DISTINCT model identity from the setup's own `semanticProvider` —
    // otherwise this test would find (and idempotently reuse) the
    // ALREADY-PERSISTED "preserved" record `ruthShapedFinalAsset`'s own
    // successful first run just created, never reaching the broken path
    // at all.
    const brokenSemantic = new FakeSignPreservationSemanticProvider("broken-path-model");
    brokenSemantic.behavior = { kind: "all_same" };
    const brokenSignPreservation: SignPreservationCapability = createSignPreservationCapability(
      repo,
      brokenAssets,
      brokenSemantic,
    );
    const brokenWorker = createFinalArtworkWorkerCapability(
      repo,
      brokenAssets,
      reconstructionProvider,
      undefined,
      undefined,
      undefined,
      brokenSignPreservation,
    );

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await brokenWorker.processNextJob();

    assert.equal(brokenSemantic.dispatchCount, 0, "structural authority was invalid — never consult the semantic provider");
    assert.equal(reconstructionProvider.dispatchCount, 1, "and certainly never re-dispatch reconstruction either");

    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      brokenSemantic.providerKey,
      brokenSemantic.modelIdentity,
      brokenSemantic.transportVersion,
    );
    const stored = await repo.getSignPreservationVerification(finalAsset.id, combinedVersion);
    assert.ok(stored);
    assert.equal(stored!.status, "unknown");
  });

  it("4: semantic 'cannot_determine' persists a completed 'unknown' record through the worker; rerun reuses it, dispatch count stays one", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "cannot_determine" };

    const { job, repo, worker, finalAsset } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    assert.equal(semanticProvider.dispatchCount, 1);

    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      semanticProvider.providerKey,
      semanticProvider.modelIdentity,
      semanticProvider.transportVersion,
    );
    const stored = await repo.getSignPreservationVerification(finalAsset.id, combinedVersion);
    assert.ok(stored, "a completed (cannot_determine-driven unknown) record IS persisted through the worker");
    assert.equal(stored!.status, "unknown");

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();
    assert.equal(semanticProvider.dispatchCount, 1, "rerun reused the completed record — no re-dispatch");
  });

  it("5: a transient semantic provider failure leaves the job retryable, persists nothing, and a later invocation may dispatch again", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "provider_timeout" };

    const built = await build(reconstructionProvider, semanticProvider);
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);
    await built.signPreparation.planSignRepair(built.projectId);
    // LIVE PRODUCT BLOCKER #4: see the identical note in `ruthShapedFinalAsset`.
    await built.signPreparation.authorizeSignRepairPlan(built.projectId, {
      authorizedBy: "operator",
    });
    const { job } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    reconstructionProvider.behavior = { kind: "oversized_but_valid", widthPx: 4096, heightPx: 6144 };
    await built.worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 1, "the attempt was made");
    const failedJob = await built.repo.getFinalArtworkJob(job.id);
    assert.equal(failedJob!.status, "failed", "existing infrastructure-failure semantics — retryable, never a fabricated completion");
    assert.match(failedJob!.lastError ?? "", /[Pp]reservation/);

    const finalAsset = (await built.repo.listAssets(built.projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the final asset itself is unaffected — only the preservation attempt failed");
    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      semanticProvider.providerKey,
      semanticProvider.modelIdentity,
      semanticProvider.transportVersion,
    );
    const stored = await built.repo.getSignPreservationVerification(finalAsset!.id, combinedVersion);
    assert.equal(stored, null, "the transient failure persisted nothing");

    // FinalArtworkCapability's own existing revive-a-failed-job path.
    await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    semanticProvider.behavior = { kind: "all_same" };
    await built.worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 2, "one failed attempt + one successful attempt");
    const retriedJob = await built.repo.getFinalArtworkJob(job.id);
    assert.equal(retriedJob!.status, "completed");
  });

  it("6: LIVE PRODUCT BLOCKER #4D — an OPERATOR-AUTHORIZED review_required plan with a 'preserved' record and a proven S3C geometry adaptation NOW reaches print_ready", async () => {
    // This fixture's plan is `review_required`, and `ruthShapedFinalAsset`
    // authorizes it as "operator" (the only actor sufficient for that risk
    // class) BEFORE enqueueing — Blocker #4's own gate (risk authorization)
    // and Blocker #3B's own gate (preservation) both pass here.
    //
    // Before LIVE PRODUCT BLOCKER #4D, this fixture landed on
    // `finalization_required` for a THIRD, independent reason: the fake
    // reconstruction provider's `oversized_but_valid` behavior (4096x6144)
    // returns a genuinely different size than the plan's own recorded step
    // requested (2448x3672), so Signs Phase S3C's adaptive-geometry
    // mechanism re-derives the `extend_uniform_background` step's own
    // pixel amounts — an honest, deterministic, plan-faithful adaptation,
    // NOT an unmodified replay. `executedStepsMatchPlan` is correctly
    // `false` for that (unchanged by this phase) — but Blocker #4D adds
    // the SEPARATE, independently-verified `executedGeometryAdaptation`
    // path PrintValidation now checks: the actual reconstruction (4096x6144)
    // IS exactly proportional to the requested (2448x3672) — both axes
    // exactly 4x, well within tolerance — AND the executed step's kind
    // (`extend_uniform_background`), axis (`horizontal`, forced by Ruth's
    // own aspect mismatch), and fill colour are IDENTICAL to the approved
    // plan's own recorded step — only `leadingPx`/`trailingPx` differ,
    // which is exactly the ONE thing S3C is permitted to re-derive. That
    // is a genuinely plan-faithful execution, not a bypass, so this is the
    // CORRECT new outcome, not merely a changed assertion.
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };

    const { repo, projectId, job, finalAsset } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation!.status, "ready");
    const executedPlanCheck = (
      validation!.report as { checks: Array<{ check: string; status: string; reason: string }> }
    ).checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(executedPlanCheck!.status, "pass");

    // The final asset's own dimensions are the ADAPTED geometry (4608x6144
    // — the actual 4096x6144 reconstruction plus 256px/256px black
    // extension on each side), never the plan's own STALE predicted
    // numbers (which assumed a 2448x3672 reconstruction).
    assert.equal(finalAsset.widthPx, 4608);
    assert.equal(finalAsset.heightPx, 6144);
  });

  it("7: review_required plan risk is a static planning fact, unaffected by authorization or preservation status", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };

    const { repo, projectId } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    const preparation = await repo.getSignPreparation(projectId);
    // The PLAN's own risk classification never changes — authorization is
    // a separate, additional fact (`authorizedPlanKey`/`authorizedBy`),
    // never a rewrite of what the planner itself concluded.
    assert.equal(preparation!.plan!.overallRisk, "review_required");
    assert.equal(preparation!.authorizedBy, "operator");
    assert.equal(preparation!.authorizedPlanKey, preparation!.planKey);
  });

  it("6b: the SAME review_required plan WITHOUT authorization is refused before any job can even be enqueued", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const built = await build(reconstructionProvider, semanticProvider);
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);
    await built.signPreparation.planSignRepair(built.projectId);

    // No authorization call — this is the REAL customer's exact situation.
    await assert.rejects(() => built.finalArtwork.requestSignFinalArtwork(built.projectId));
    assert.equal(reconstructionProvider.dispatchCount, 0, "unauthorized: zero Topaz calls");
    assert.equal(semanticProvider.dispatchCount, 0, "unauthorized: zero semantic calls");
  });

  it("9: a non-reconstructed (native-resolution) rigid sign never dispatches semantic preservation", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(
      reconstructionProvider,
      semanticProvider,
    );
    const { exactAspectSignArtwork } = await import("@/capabilities/sign-preparation/sign-fixtures");
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(2700, 3600)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await signPreparation.planSignRepair(projectId);
    // LIVE PRODUCT BLOCKER #4: see the identical note in `ruthShapedFinalAsset`.
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 0, "a native-resolution plan needs no preservation question asked");
    assert.equal(reconstructionProvider.dispatchCount, 0);
    void repo;
  });

  it("10: zero Topaz/reconstruction calls are introduced by the preservation stage itself", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    assert.equal(reconstructionProvider.dispatchCount, 1, "exactly the one production reconstruction — none from preservation");
    assert.equal(reconstructionProvider.resumeCount, 0);
  });
});
