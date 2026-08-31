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

  it("6: a 'preserved' preservation record does NOT make the project print_ready — S4.4 has not occurred", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };

    const { repo, projectId } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
    assert.equal(project!.project.status, "finalization_required");
  });

  it("7: review_required plan risk remains unresolved after a 'preserved' preservation record — this phase never approves it", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };

    const { repo, projectId } = await ruthShapedFinalAsset(reconstructionProvider, semanticProvider);
    const preparation = await repo.getSignPreparation(projectId);
    assert.equal(preparation!.plan!.overallRisk, "review_required");
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
