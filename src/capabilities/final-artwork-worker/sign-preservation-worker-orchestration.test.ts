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
import {
  ruthLikeSignArtwork,
  stripedPerimeterBandArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import {
  buildCombinedVerificationAlgorithmVersion,
  createSignPreservationCapability,
  SIGN_PRESERVATION_SEMANTIC_CATEGORIES,
  type SignPreservationCapability,
  type SignPreservationSemanticAnswer,
} from "@/capabilities/sign-preservation";
import { SIGN_PRESERVATION_TRANSPORT_VERSION_NONE } from "@/capabilities/sign-preservation/contracts";
import { FakeSignPreservationSemanticProvider } from "@/capabilities/sign-preservation/fake-sign-preservation-semantic-provider";
import type {
  SignPreservationSemanticProvider,
  SignPreservationSemanticProviderResult,
  SignPreservationSemanticRequest,
} from "@/capabilities/sign-preservation/sign-preservation-semantic-provider";
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

    // FinalArtworkCapability's own existing revive-a-failed-job path — the
    // SAME thing "Prepare artwork"/"Try again" does in the real product.
    const revived = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    // LIVE PRODUCT BLOCKER #4F: the real recovery requirement — the EXISTING
    // job is revived in place, never a second FinalArtworkJob.
    assert.equal(revived.job.id, job.id, "recovery must reuse the SAME FinalArtworkJob, never create a new one");
    semanticProvider.behavior = { kind: "all_same" };
    await built.worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 2, "one failed attempt + one successful attempt");
    // LIVE PRODUCT BLOCKER #4F: the real recovery requirement — a failed
    // preservation attempt must never cause a second Topaz reconstruction.
    // `resolveExistingProductionAsset` finds the already-persisted, already-
    // geometry-adapted final asset (excluding the marked intermediate) and
    // the worker's own "recovered/retried job" branch recomputes evidence
    // from its recorded metadata instead of re-executing reconstruction.
    assert.equal(
      reconstructionProvider.dispatchCount,
      1,
      "a preservation-only retry must never resubmit reconstruction — the existing final asset is reused",
    );
    const retriedJob = await built.repo.getFinalArtworkJob(job.id);
    assert.equal(retriedJob!.status, "completed");

    const assetsAfterRetry = (await built.repo.listAssets(built.projectId)).filter(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.equal(
      assetsAfterRetry.length,
      1,
      "exactly the one original final asset must exist — recovery must never produce a duplicate",
    );
    assert.equal(assetsAfterRetry[0]!.id, finalAsset!.id, "the SAME final asset must be reused, never regenerated");
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

/**
 * Semantic Worker Wiring Phase: the acceptance proof this phase exists
 * for — a plan using ONLY `reconstruct_perimeter_structure` (no
 * `reconstruct_resolution`, zero Topaz involvement) travels the REAL
 * capability path (upload → confirm spec → `planSignRepair` → authorize →
 * `requestSignFinalArtwork` → the real worker) all the way to
 * `print_ready` when every deterministic + semantic preservation category
 * is affirmative, and is correctly refused otherwise. Every test here uses
 * `FakeSignPreservationSemanticProvider` (or a purpose-built inline fake
 * satisfying the identical `SignPreservationSemanticProvider` contract) —
 * never Topaz, never a real multimodal provider.
 */
describe("Semantic Worker Wiring Phase: reconstruct_perimeter_structure end-to-end through the real worker", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-perimeter-worker-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * Answers every category "same" except `overrideCategory`, which gets
   * `overrideAnswer` — lets each negative test vary EXACTLY one category
   * (usually `perimeter_edge_alignment`) without touching the rest,
   * mirroring `FakeSignPreservationSemanticProvider`'s own
   * `CHANGED_CATEGORY_FOR_BEHAVIOR` shape but supporting any answer value
   * (in particular `cannot_determine`, which the shared fake only ever
   * produces for `wording`).
   */
  class InlineSemanticProvider implements SignPreservationSemanticProvider {
    readonly providerKey = "inline-fake-sign-preservation-semantic";
    readonly modelIdentity: string;
    readonly transportVersion = SIGN_PRESERVATION_TRANSPORT_VERSION_NONE;
    dispatchCount = 0;
    constructor(
      private readonly overrideCategory: (typeof SIGN_PRESERVATION_SEMANTIC_CATEGORIES)[number],
      private readonly overrideAnswer: SignPreservationSemanticAnswer["answer"],
      modelIdentity = "inline-fake-model-v1",
    ) {
      this.modelIdentity = modelIdentity;
    }
    async compare(_request: SignPreservationSemanticRequest): Promise<SignPreservationSemanticProviderResult> {
      this.dispatchCount += 1;
      return {
        answers: SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
          category,
          answer: category === this.overrideCategory ? this.overrideAnswer : ("same" as const),
          reason:
            category === this.overrideCategory
              ? `inline fake: deliberately ${this.overrideAnswer} for this test`
              : "inline fake: unchanged",
          regionReference: null,
        })),
        providerRequestId: `inline-fake-${this.dispatchCount}`,
        rawResponseSummary: { fixture: "inline-override" },
        tokenUsage: { inputTokens: 1000, outputTokens: 55 },
      };
    }
  }

  async function build(reconstructionProvider: FakeSignReconstructionProvider, semanticProvider: SignPreservationSemanticProvider) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const signPreservation = createSignPreservationCapability(repo, realAssets, semanticProvider);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      realAssets,
      reconstructionProvider,
      undefined,
      undefined,
      undefined,
      signPreservation,
    );
    const project = await repo.createProject();
    return { repo, assets: realAssets, signPreparation, finalArtwork, signPreservation, worker, projectId: project.project.id };
  }

  /**
   * `stripedPerimeterBandArtwork(1800, 2700)` at a 12x24in order: 150/112.5
   * PPI (clears the 100 PPI minimum — never also triggers `reconstruct_
   * resolution`), aspect-mismatched so the planner extends vertically
   * (top/bottom), and the top band is the reconstructable accent/fill
   * stripe `sign-repair-planner.test.ts`'s own "production-aware perimeter
   * reconstruction" suite already proves is admitted as `reconstruct_
   * perimeter_structure`, `overallRisk: review_required`. Goes through the
   * REAL `signPreparation.planSignRepair` — proving the capability-level
   * `perimeterBands` wiring this phase also completed, not a hand-built
   * plan bypassing it.
   */
  async function perimeterOnlyPlanReadyForFinalArtwork(
    reconstructionProvider: FakeSignReconstructionProvider,
    semanticProvider: SignPreservationSemanticProvider,
  ) {
    const built = await build(reconstructionProvider, semanticProvider);
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(stripedPerimeterBandArtwork(1800, 2700)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 12, 24);
    const { result } = await built.signPreparation.planSignRepair(built.projectId);
    assert.equal(result.status, "planned", "the real capability must admit reconstruct_perimeter_structure on its own");
    assert.ok(
      result.plan!.steps.some((step) => step.kind === "reconstruct_perimeter_structure"),
      "sanity: this is genuinely the perimeter-only plan shape, not some other admitted plan",
    );
    assert.ok(
      !result.plan!.steps.some((step) => step.kind === "reconstruct_resolution"),
      "sanity: never combined with bounded (Topaz) reconstruction — this proves the semantic dispatch is NOT merely riding along on that gate",
    );
    await built.signPreparation.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    const { job } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    return { ...built, job };
  }

  it("1: authorized plan -> deterministic perimeter reconstruction -> semantic verification (affirmative) -> perimeter_edge_alignment 'same' -> PrintValidation -> print_ready", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, job, worker } = await perimeterOnlyPlanReadyForFinalArtwork(
      reconstructionProvider,
      semanticProvider,
    );

    await worker.processNextJob();

    // Zero Topaz — this plan never contains reconstruct_resolution.
    assert.equal(reconstructionProvider.dispatchCount, 0, "a perimeter-only plan must never dispatch bounded reconstruction");
    // Exactly one semantic call — the core fix this phase makes: semantic
    // verification is now triggered for a plan gated on `reconstruct_
    // perimeter_structure` alone.
    assert.equal(semanticProvider.dispatchCount, 1);

    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed");

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation!.status, "ready");
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    const substrateCheck = checks.find((c) => c.check === "substrate_boundary_semantics");
    assert.equal(substrateCheck?.status, "pass");
  });

  it("2: semantic perimeter_edge_alignment 'changed' -> NOT print_ready (finalization_required), substrate_boundary_semantics fails", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "changed_perimeter_alignment" };
    const { repo, projectId, job, worker } = await perimeterOnlyPlanReadyForFinalArtwork(
      reconstructionProvider,
      semanticProvider,
    );

    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
    assert.equal(project!.project.status, "finalization_required");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation!.status, "finalization_required");
    const checks = (validation!.report as { checks: Array<{ check: string; status: string; reason: string }> }).checks;
    const substrateCheck = checks.find((c) => c.check === "substrate_boundary_semantics");
    assert.equal(substrateCheck?.status, "fail");
    assert.match(substrateCheck!.reason, /concluded "changed"/i);
  });

  it("3: semantic perimeter_edge_alignment 'cannot_determine' -> NOT print_ready (an inconclusive answer never authorizes)", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new InlineSemanticProvider("perimeter_edge_alignment", "cannot_determine");
    const { repo, projectId, job, worker } = await perimeterOnlyPlanReadyForFinalArtwork(
      reconstructionProvider,
      semanticProvider,
    );

    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation!.status, "finalization_required");
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(checks.find((c) => c.check === "substrate_boundary_semantics")?.status, "fail");
  });

  it("4: a structurally missing perimeter_edge_alignment answer never silently reaches print_ready — the malformed provider attempt fails the job instead of fabricating an answer", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    // `malformed_result` drops the LAST category — `perimeter_edge_alignment`
    // is deliberately the last entry in `SIGN_PRESERVATION_SEMANTIC_
    // CATEGORIES`, so this is exactly "the perimeter answer is missing",
    // not an arbitrary unrelated category.
    semanticProvider.behavior = { kind: "malformed_result" };
    const { repo, projectId, job, worker } = await perimeterOnlyPlanReadyForFinalArtwork(
      reconstructionProvider,
      semanticProvider,
    );

    await worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 1, "the attempt was made");
    const failedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(failedJob!.status, "failed", "a structurally invalid answer set is an incomplete attempt, never a fabricated completion");

    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation, null, "PrintValidation is never even reached for an incomplete preservation attempt");
  });

  it("5: a changed PROTECTED INTERIOR category (wording) blocks print_ready even though perimeter_edge_alignment itself is affirmative", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "changed_wording" };
    const { repo, projectId, job, worker } = await perimeterOnlyPlanReadyForFinalArtwork(
      reconstructionProvider,
      semanticProvider,
    );

    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation!.status, "finalization_required");
    // The perimeter check itself is unaffected — proving this is a
    // DIFFERENT, independent blocking reason, not a mislabeled perimeter
    // failure.
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(checks.find((c) => c.check === "substrate_boundary_semantics")?.status, "pass");
  });

  it("6: idempotent rerun after a perimeter-only success reuses the persisted preservation record — no duplicate semantic dispatch, no duplicate job, no duplicate asset", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, job, worker } = await perimeterOnlyPlanReadyForFinalArtwork(
      reconstructionProvider,
      semanticProvider,
    );
    await worker.processNextJob();
    assert.equal(semanticProvider.dispatchCount, 1);

    await repo.updateFinalArtworkJob(job.id, { status: "recoverable", completedAt: null });
    await worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 1, "the recovered run reused the persisted preservation record");
    assert.equal(reconstructionProvider.dispatchCount, 0);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const assetsAfterRerun = (await repo.listAssets(projectId)).filter(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png",
    );
    assert.equal(assetsAfterRerun.length, 1, "no duplicate final asset from the idempotent rerun");
  });
});
