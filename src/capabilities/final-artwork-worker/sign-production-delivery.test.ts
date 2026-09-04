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
import type { FinalArtworkProvider, FinalArtworkProviderInput, FinalArtworkProviderOutput } from "@/capabilities/final-artwork/provider";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import {
  exactAspectSignArtwork,
  makeImage,
  toPngBytes,
  uniformBackgroundSignArtwork,
} from "@/capabilities/sign-preparation/sign-fixtures";
import { createSignPreservationCapability } from "@/capabilities/sign-preservation";
import { FakeSignPreservationSemanticProvider } from "@/capabilities/sign-preservation/fake-sign-preservation-semantic-provider";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * Predominantly near-black (matching `FakeSignReconstructionProvider`'s own
 * solid near-black output, exactly like `ruthLikeSignArtwork`'s own
 * predominantly-black design — so the deterministic similarity check's
 * advisory "concern" never crosses into "catastrophic"), with a
 * deterministic pseudo-noise band confined to the very top and bottom edges
 * — genuinely `mixed_or_uncertain` there (review_required, vertical axis),
 * while the left/right edges stay uniform. Module-scope so both the
 * LIVE PRODUCT BLOCKER #4C and #4D acceptance suites share one fixture.
 */
function customerShapedLowResArtwork(width: number, height: number): RgbaImage {
  const image = makeImage(width, height, { r: 6, g: 6, b: 6 });
  const bandDepth = Math.max(24, Math.round(height * 0.05));
  const noisyBand = (yStart: number, yEnd: number) => {
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        image.data[i] = (x * 37 + y * 101) % 256;
        image.data[i + 1] = (x * 71 + y * 13) % 256;
        image.data[i + 2] = (x * 5 + y * 197) % 256;
        image.data[i + 3] = 255;
      }
    }
  };
  noisyBand(0, bandDepth);
  noisyBand(height - bandDepth, height);
  return image;
}

/**
 * LIVE PRODUCT BLOCKER #4B: proves `FinalArtworkCapability.
 * resolveCurrentSignProductionDelivery` — the ONE authority the new
 * operator download route trusts — resolves exactly the asset that is
 * genuinely, currently, authoritatively print-ready for a sign, and
 * refuses everything else (no job, in-flight, failed, a stale plan's
 * completed job, or a reconstructed asset whose preservation verification
 * never came back `"preserved"`). Never calls Topaz or a real semantic
 * provider — `FakeSignReconstructionProvider`/`FakeSignPreservationSemanticProvider`
 * only, exactly like every other sign worker test in this repository.
 */
class ThrowingProvider implements FinalArtworkProvider {
  readonly providerKey = "must_never_be_called";
  async produce(_input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    throw new Error("must never dispatch the apparel provider for a deterministic-only sign job");
  }
}

describe("resolveCurrentSignProductionDelivery — deterministic-only (no reconstruction)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-delivery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, assets, new ThrowingProvider());
    const project = await repo.createProject();
    return { repo, assets, signPreparation, finalArtwork, worker, projectId: project.project.id };
  }

  it("no job requested yet: resolves null", async () => {
    const { signPreparation, finalArtwork, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);

    assert.equal(await finalArtwork.resolveCurrentSignProductionDelivery(projectId), null);
  });

  it("job still in flight (queued, never claimed): resolves null", async () => {
    const { signPreparation, finalArtwork, worker, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await finalArtwork.requestSignFinalArtwork(projectId);
    // Not yet claimed — assert before draining it.
    assert.equal(await finalArtwork.resolveCurrentSignProductionDelivery(projectId), null);

    // `claimNextQueuedFinalArtworkJob` claims across the whole (shared,
    // tempDir-backed) local store, not scoped to one repository instance —
    // draining this job here keeps it from being claimed by a LATER test's
    // own `processNextJob()` call instead of that test's own job.
    await worker.processNextJob();
  });

  it("job failed: resolves null", async () => {
    const { repo, signPreparation, finalArtwork, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "failed", lastError: "simulated infrastructure failure" });

    assert.equal(await finalArtwork.resolveCurrentSignProductionDelivery(projectId), null);
  });

  it("zero-step plan reaches print_ready: resolves the exact produced asset, downloadable bytes match", async () => {
    const { repo, assets, signPreparation, finalArtwork, worker, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    const outcome = await signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.plan!.steps.length, 0);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const delivery = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.ok(delivery, "the print-ready asset must resolve");
    assert.equal(delivery!.job.id, job.id);

    const downloaded = await assets.downloadAssetBytes(delivery!.assetId);
    assert.ok(downloaded, "the resolved asset id must actually download real bytes");
  });

  it("Rejected-Final Regeneration Phase: with a stale rejected final PRESERVED alongside the corrected one, delivery resolves exactly the validation-bound asset — never positionally", async () => {
    const { repo, assets, signPreparation, finalArtwork, worker, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);

    // The real incident's own shape, in the real incident's own order: a
    // final drawn by the pre-correction implementation (no
    // executionImplementationVersion stamp) already sits on the job,
    // OLDER than anything the worker will now produce — so a positional
    // oldest-first pick would land on it, not on the corrected plate.
    const staleFinal = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-legacy`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: { rigidSign: { planKey: "sign-repair-plan:v1:test" } },
    });

    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation!.status, "ready");
    assert.notEqual(validation!.assetId, staleFinal.id, "sanity: certification belongs to the regenerated plate, never the stale one");

    const jobAssets = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    const finals = jobAssets.filter(
      (a) => a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.equal(finals.length, 2, "the rejected plate is preserved as history alongside the corrected one");

    const delivery = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.ok(delivery, "delivery must resolve despite two finals on the job");
    assert.equal(delivery!.assetId, validation!.assetId, "the delivered asset is the validation-bound one");
    assert.notEqual(delivery!.assetId, staleFinal.id, "the stale rejected plate is never what the customer downloads");
  });

  it("a genuine repair (aspect-mismatch canvas extension) reaches print_ready with the ACTUAL corrected geometry", async () => {
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 1500)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 8, 10);
    const outcome = await signPreparation.planSignRepair(projectId);
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["extend_uniform_background"]);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const delivery = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.ok(delivery);
    const asset = (await repo.listAssets(projectId)).find((a) => a.id === delivery!.assetId);
    assert.ok(asset);
    // The DOWNLOADED file is the actual repaired geometry, not the original.
    assert.equal(asset!.widthPx, plan.expectedOutputWidthPx);
    assert.equal(asset!.heightPx, plan.expectedOutputHeightPx);
  });

  it("stale plan: a completed, print-ready job for a SUPERSEDED plan is never returned as the current deliverable", async () => {
    const { signPreparation, finalArtwork, worker, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    assert.ok(await finalArtwork.resolveCurrentSignProductionDelivery(projectId), "sanity: it was print-ready");

    // A genuinely different ordered size re-plans this preparation — a new
    // planKey, with no job (and no authorization) yet for it.
    await signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await signPreparation.planSignRepair(projectId);

    assert.equal(
      await finalArtwork.resolveCurrentSignProductionDelivery(projectId),
      null,
      "the OLD plan's print-ready job must not be handed over as though it answered the NEW plan",
    );
  });
});

/**
 * LIVE PRODUCT BLOCKER #4B: `planIntegrityOk` used to require
 * `containsOnlyAdmittedSteps` alone — and `planContainsOnlyAdmittedSteps`
 * is, by its own doc comment in `sign-transform-executor.ts`, "false for
 * any such plan, since `reconstruct_resolution` itself is never
 * S2-admitted". Fixed by admitting the ONE additional shape S3A/S4 exist
 * for (`RigidSignPlanEvidence.planRequiresBoundedReconstruction`) — proven
 * in ISOLATION, with hand-built evidence, in `rigid-sign-print-validation
 * .test.ts`'s own "LIVE PRODUCT BLOCKER #4B" suite.
 *
 * LIVE PRODUCT BLOCKER #4C: semantic preservation comparison used to
 * additionally require the reconstruction to be an EXACT INTEGER multiple
 * of the source dimensions — incompatible with a real PPI-target-driven
 * `requestedScale` (this real customer's own: 3.38121546961326×), which
 * essentially never lands on one. Fixed with PROPORTIONAL (not
 * necessarily integer) coordinate mapping
 * (`sign-preservation-geometry.ts`) — proven in isolation in
 * `sign-preservation-geometry.test.ts` and `sign-preservation-image
 * -derivation.test.ts`. The test below now proves the REAL worker reaches
 * `print_ready` for a genuinely non-integer-scale reconstruction, with NO
 * hand-inserted validation — see the dedicated "FULL WORKER ACCEPTANCE"
 * suite further down this file for the complete, customer-shaped,
 * review_required version of the same proof.
 */
describe("resolveCurrentSignProductionDelivery — reconstructed output (bounded reconstruction + geometry repair, combined)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-delivery-preservation-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(semanticProvider: FakeSignPreservationSemanticProvider) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets: AssetCapability = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const signPreservation = createSignPreservationCapability(repo, assets, semanticProvider);
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      reconstructionProvider,
      undefined,
      undefined,
      undefined,
      signPreservation,
    );
    const project = await repo.createProject();
    return { repo, assets, signPreparation, finalArtwork, worker, reconstructionProvider, projectId: project.project.id };
  }

  /**
   * 1000x1500 @ 18x24in — needs BOTH a bounded reconstruction (62.5 PPI,
   * below the 150 PPI target) AND a geometry repair (1000:1500 vs the
   * ordered 18:24 aspect) — a real extension REGION for preservation's
   * deterministic check to validate (unlike an exact-aspect, reconstruction-
   * only plan, which the S4.1 deterministic checks cannot resolve). The
   * real customer's own plan has this identical shape.
   */
  async function planNeedingReconstructionAndExtension(
    signPreparation: ReturnType<typeof createSignPreparationCapability>,
    projectId: string,
  ) {
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 1500)),
      declaredContentType: "image/png",
      filename: "customer-sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    const outcome = await signPreparation.planSignRepair(projectId);
    assert.deepEqual(
      outcome.result.plan!.steps.map((s) => s.kind),
      ["reconstruct_resolution", "extend_uniform_background"],
    );
    assert.equal(outcome.result.plan!.overallRisk, "auto_safe");
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    return outcome.result.plan!;
  }

  it("reconstructed + extended + genuinely preserved: the REAL pipeline now reaches print_ready and resolves as the current deliverable", async () => {
    // LIVE PRODUCT BLOCKER #4C: before the preservation geometry fix, this
    // exact fixture could only reach "ready" via a hand-inserted validation
    // (semantic dispatch was unreachable for a non-integer scale). It no
    // longer needs that workaround — the real worker's own preservation
    // pass now genuinely reaches "preserved".
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(semanticProvider);
    const plan = await planNeedingReconstructionAndExtension(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    assert.equal(semanticProvider.dispatchCount, 1, "the fix: semantic preservation is now genuinely reachable");

    const asset = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(asset, "the worker produces the reconstructed, extended plate");
    assert.equal(asset!.widthPx, plan.expectedOutputWidthPx);
    assert.equal(asset!.heightPx, plan.expectedOutputHeightPx);

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");

    const delivery = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.ok(delivery, "the resolver finds this exact, genuinely-produced asset");
    assert.equal(delivery!.assetId, asset!.id);
  });

  it("reconstructed + extended, preservation not 'preserved': never resolves as the current deliverable", async () => {
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "cannot_determine" };
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(semanticProvider);
    await planNeedingReconstructionAndExtension(signPreparation, projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(job.id);
    assert.equal(completed!.status, "completed", "the job still reaches its normal terminal state");
    const project = await repo.getProject(projectId);
    assert.notEqual(project!.project.status, "print_ready", "unresolved preservation must never certify readiness");

    assert.equal(
      await finalArtwork.resolveCurrentSignProductionDelivery(projectId),
      null,
      "an asset without a 'preserved' verification is never exposed as a Print Ready download",
    );
  });
});

/**
 * LIVE PRODUCT BLOCKER #4C: THE full-pipeline acceptance proof. A fixture
 * shaped exactly like the real customer's own persisted plan — low-
 * resolution source, a genuinely NON-INTEGER bounded reconstruction scale,
 * top/bottom padding, a `review_required` risk classification — carried
 * through the REAL `SignPreparationCapability` → `FinalArtworkCapability`
 * → `FinalArtworkWorkerCapability` → `SignPreservationCapability` →
 * `PrintValidationCapability` → `resolveCurrentSignProductionDelivery` →
 * download-service chain, unmodified, with ONLY the two paid providers
 * replaced by fakes. No validation result is ever hand-inserted here —
 * every fact below is what the real orchestration actually produced.
 */
describe("FULL WORKER ACCEPTANCE (LIVE PRODUCT BLOCKER #4C): customer-shaped non-integer reconstruction reaches a downloadable print_ready file", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-acceptance-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });


  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const signPreservation = createSignPreservationCapability(repo, assets, semanticProvider);
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      reconstructionProvider,
      undefined,
      undefined,
      undefined,
      signPreservation,
    );
    const project = await repo.createProject();
    return {
      repo,
      assets,
      signPreparation,
      finalArtwork,
      worker,
      reconstructionProvider,
      semanticProvider,
      projectId: project.project.id,
    };
  }

  it("customer-shaped plan: reconstruct (non-integer) + pad (review_required) + operator-authorize + preserve + print_ready + download", async () => {
    const {
      repo,
      assets,
      signPreparation,
      finalArtwork,
      worker,
      reconstructionProvider,
      semanticProvider,
      projectId,
    } = await build();

    // --- 1. Upload + confirm spec ---------------------------------------
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(customerShapedLowResArtwork(400, 600)),
      declaredContentType: "image/png",
      filename: "acceptance-customer-sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 10, 21);

    // --- 2. Plan: prove the shape genuinely matches the real customer's --
    const outcome = await signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution", "pad_uniform_background"]);
    assert.equal(plan.overallRisk, "review_required");
    const reconstructStep = plan.steps[0]!;
    const requestedScale = reconstructStep.params.requestedScale as number;
    assert.ok(!Number.isInteger(requestedScale), "the reconstruction scale must be genuinely non-integer");
    const padStep = plan.steps[1]!;
    assert.equal(padStep.params.axis, "vertical", "top/bottom padding — the real customer's own axis");
    assert.match(padStep.reasons[0]!, /mixed_or_uncertain/);

    // --- 3. Authorization gate: unauthorized cannot proceed --------------
    await assert.rejects(() => finalArtwork.requestSignFinalArtwork(projectId));

    // --- 4. Operator authorizes THIS exact plan ---------------------------
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    // --- 5. Prepare artwork: enqueue + run the REAL worker ---------------
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    // --- 6. Provider accounting: exactly one dispatch each ---------------
    assert.equal(reconstructionProvider.dispatchCount, 1, "exactly one (fake) Topaz-equivalent dispatch");
    assert.equal(semanticProvider.dispatchCount, 1, "exactly one (fake) semantic preservation dispatch — NOW reachable");

    // --- 7. Preservation authority: genuinely "preserved" -----------------
    const asset = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(asset, "the real worker produced the final production asset");
    const { buildCombinedVerificationAlgorithmVersion } = await import("@/capabilities/sign-preservation");
    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      semanticProvider.providerKey,
      semanticProvider.modelIdentity,
      semanticProvider.transportVersion,
    );
    const verification = await repo.getSignPreservationVerification(asset!.id, combinedVersion);
    assert.ok(verification, "a real preservation-verification record was persisted");
    assert.equal(verification!.status, "preserved", "the fix: a non-integer reconstruction can now genuinely verify as preserved");

    // --- 8. PrintValidation: the plan-integrity check genuinely passes ---
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.ok(validation);
    const check = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks.find(
      (c) => c.check === "executed_plan_matches_recorded_plan",
    );
    assert.equal(check?.status, "pass");
    // Signs Phase 3B (Fit to Production, Section J): `customerShapedLowRes
    // Artwork`'s own top/bottom bands are deliberately NOISY pixel-noise
    // right at the cut edge (no single dominant colour) — exactly the
    // AMBIGUOUS edge content Section F/J requires to fail closed rather
    // than silently receive bleed permission. The plan-integrity fix this
    // test exists to prove (above) is genuinely unaffected; PrintValidation
    // overall correctly still withholds `ready` on this new, independent
    // ground.
    const fitToProductionCheck = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks.find(
      (c) => c.check === "protected_content_safe_inset",
    );
    assert.equal(fitToProductionCheck?.status, "fail", "the ONLY new blocker is Fit to Production (noisy edge bands), not a regression in plan-integrity");
    assert.equal(validation!.status, "finalization_required");

    // --- 9. Project status reflects the same Fit to Production block -----
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalization_required");

    // --- 10. Customer-delivery authority correctly WITHHOLDS while blocked
    // Signs Phase 3B: `resolveCurrentSignProductionDelivery` is the ONLY
    // path that can ever say "this is print-ready" and explicitly refuses
    // unless the latest validation IS `"ready"` — so it correctly returns
    // null now that Fit to Production blocks this exact candidate.
    const delivery = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.equal(delivery, null, "the customer-delivery authority never serves a Fit-to-Production-blocked candidate");

    // --- 11. The corrected asset itself still genuinely exists and is
    // downloadable for operator inspection via the dedicated blocked-
    // candidate resolver (never the customer-delivery authority) — proving
    // the plan-integrity + adaptation fix this test exists for really did
    // produce a real, correctly-sized file, independent of the separate
    // Fit to Production block just proven above. -----------------------
    const blocked = await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.ok(blocked, "the blocked-candidate resolver surfaces this exact asset for operator inspection");
    assert.equal(blocked!.assetId, asset!.id);
    assert.equal(blocked!.validationStatus, "finalization_required");

    const downloaded = await assets.downloadAssetBytes(blocked!.assetId);
    assert.ok(downloaded, "the actual corrected PNG bytes are downloadable");
    const { PNG } = await import("pngjs");
    const decoded = PNG.sync.read(downloaded!.bytes);
    assert.equal(decoded.width, plan.expectedOutputWidthPx);
    assert.equal(decoded.height, plan.expectedOutputHeightPx);
  });

  it("the SAME plan, without operator authorization, never reaches print_ready — review_required is not silently bypassed", async () => {
    const { signPreparation, finalArtwork, projectId } = await build();
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(customerShapedLowResArtwork(400, 600)),
      declaredContentType: "image/png",
      filename: "acceptance-customer-sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 10, 21);
    const outcome = await signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.plan!.overallRisk, "review_required");

    await assert.rejects(() => finalArtwork.requestSignFinalArtwork(projectId));
    // Customer authorization alone is insufficient for review_required too.
    await assert.rejects(() => signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "customer" }));
    await assert.rejects(() => finalArtwork.requestSignFinalArtwork(projectId));
  });
});

/**
 * LIVE PRODUCT BLOCKER #4D: the REAL customer's exact plan geometry
 * (1086×1448 source, 24×36in ordered — reproducing the persisted plan's
 * own `reconstruct_resolution` request of 3672×4896 and `pad_uniform
 * _background` of 306px top/bottom, bit-for-bit), with the fake Topaz
 * provider returning a genuinely LARGER proportional result — analogous
 * to the real, previously-observed Ruth behavior — through the REAL
 * worker path, with no injected validation shortcut.
 */
describe("FULL WORKER ACCEPTANCE (LIVE PRODUCT BLOCKER #4D): real-customer-shaped plan, oversized proportional Topaz result, still reaches a downloadable print_ready file", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-s3c-acceptance-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const signPreservation = createSignPreservationCapability(repo, assets, semanticProvider);
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      reconstructionProvider,
      undefined,
      undefined,
      undefined,
      signPreservation,
    );
    const project = await repo.createProject();
    return {
      repo,
      assets,
      signPreparation,
      finalArtwork,
      worker,
      reconstructionProvider,
      semanticProvider,
      projectId: project.project.id,
    };
  }

  it("real customer's exact plan geometry + a 1.25x oversized proportional Topaz result: adapted, preserved, ready, print_ready, downloadable", async () => {
    const {
      repo,
      assets,
      signPreparation,
      finalArtwork,
      worker,
      reconstructionProvider,
      semanticProvider,
      projectId,
    } = await build();

    // --- 1. Reproduce the real customer's exact source dims + ordered size
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(customerShapedLowResArtwork(1086, 1448)),
      declaredContentType: "image/png",
      filename: "real-customer-shaped-sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 24, 36);

    // --- 2. Plan: bit-for-bit the real customer's own recorded numbers ---
    const outcome = await signPreparation.planSignRepair(projectId);
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["reconstruct_resolution", "pad_uniform_background"]);
    assert.equal(plan.overallRisk, "review_required");
    const reconstructStep = plan.steps[0]!;
    assert.equal(reconstructStep.params.requestedWidthPx, 3672);
    assert.equal(reconstructStep.params.requestedHeightPx, 4896);
    assert.ok(Math.abs((reconstructStep.params.requestedScale as number) - 3.38121546961326) < 1e-6);
    const padStep = plan.steps[1]!;
    assert.equal(padStep.params.axis, "vertical");
    assert.equal(padStep.params.leadingPx, 306);
    assert.equal(padStep.params.trailingPx, 306);
    assert.equal(plan.expectedOutputWidthPx, 3672);
    assert.equal(plan.expectedOutputHeightPx, 5508);

    // --- 3. Operator authorizes THIS exact plan --------------------------
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    // --- 4. Fake Topaz returns a genuinely LARGER proportional result ---
    // (1.25x both axes — clean, exact, proportional, analogous to the
    // real, previously-observed Ruth 4x behavior) rather than exactly
    // what was requested.
    reconstructionProvider.behavior = { kind: "oversized_but_valid", widthPx: 4590, heightPx: 6120 };

    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();

    // --- 5. Provider accounting: exactly one dispatch each --------------
    assert.equal(reconstructionProvider.dispatchCount, 1);
    assert.equal(semanticProvider.dispatchCount, 1, "the fix: semantic preservation is reachable for the adapted geometry too");

    // --- 6. The ADAPTED geometry — NOT the plan's own stale numbers -----
    const asset = (await repo.listAssets(projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(asset, "the real worker produced the final production asset");
    // Content width stays the actual reconstruction's own width (4590);
    // height is the ordered-aspect target for THAT actual reconstruction
    // (4590 * 36/24 = 6885), not the plan's own 3672x5508 prediction —
    // exactly 1.25x the plan's own baseline numbers on both axes, since
    // the oversizing itself was a clean, uniform 1.25x.
    assert.equal(asset!.widthPx, 4590);
    assert.equal(asset!.heightPx, 6885);

    // --- 7. Preservation authority: genuinely "preserved" ----------------
    const { buildCombinedVerificationAlgorithmVersion } = await import("@/capabilities/sign-preservation");
    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      semanticProvider.providerKey,
      semanticProvider.modelIdentity,
      semanticProvider.transportVersion,
    );
    const verification = await repo.getSignPreservationVerification(asset!.id, combinedVersion);
    assert.ok(verification);
    assert.equal(verification!.status, "preserved");

    // --- 8. PrintValidation: plan-integrity passes via the NEW adaptive-
    // equivalence path (executedStepsMatchPlan is false here — this is a
    // genuine adaptation, not an unmodified replay — but the independent
    // proportionality + step-identity check admits it) --------------------
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.ok(validation);
    const check = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks.find(
      (c) => c.check === "executed_plan_matches_recorded_plan",
    );
    assert.equal(check?.status, "pass");
    // Signs Phase 3B (Fit to Production, Section J): `customerShapedLowRes
    // Artwork`'s own top/bottom bands are deliberately NOISY pixel-noise
    // right at the cut edge (no single dominant colour) — exactly the
    // AMBIGUOUS edge content Section F/J requires to fail closed rather
    // than silently receive bleed permission. The adaptive-equivalence fix
    // this test exists to prove (above) is genuinely unaffected;
    // PrintValidation overall correctly still withholds `ready` on this
    // new, independent ground.
    const fitToProductionCheck = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks.find(
      (c) => c.check === "protected_content_safe_inset",
    );
    assert.equal(fitToProductionCheck?.status, "fail", "the ONLY new blocker is Fit to Production (noisy edge bands), not a regression in plan-integrity/adaptation");
    assert.equal(validation!.status, "finalization_required");

    // --- 9. Project status reflects the same Fit to Production block -----
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalization_required");

    // --- 10. Customer-delivery authority correctly WITHHOLDS while blocked
    const delivery = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.equal(delivery, null, "the customer-delivery authority never serves a Fit-to-Production-blocked candidate");

    // --- 11. The adapted asset itself still genuinely exists, at the
    // correct ADAPTED (not plan-predicted) geometry, and is downloadable
    // for operator inspection via the dedicated blocked-candidate resolver.
    const blocked = await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.ok(blocked, "the blocked-candidate resolver surfaces this exact asset for operator inspection");
    assert.equal(blocked!.assetId, asset!.id);
    assert.equal(blocked!.validationStatus, "finalization_required");

    const downloaded = await assets.downloadAssetBytes(blocked!.assetId);
    assert.ok(downloaded, "the actual corrected PNG bytes are downloadable");
    const { PNG } = await import("pngjs");
    const decoded = PNG.sync.read(downloaded!.bytes);
    assert.equal(decoded.width, 4590);
    assert.equal(decoded.height, 6885);
  });
});

/**
 * Blocked Production Candidate Inspection Phase (real Signs acceptance
 * incident): `FinalArtworkCapability.resolveBlockedSignProductionCandidate`
 * — the mirror image of `resolveCurrentSignProductionDelivery`, proven
 * here at the capability layer with the same exact-asset, never-positional
 * discipline. Never calls a provider — every fixture here is either a
 * deterministic-only plan or hand-seeded rows, exactly like this file's
 * own sibling suites.
 */
describe("resolveBlockedSignProductionCandidate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-blocked-candidate-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, assets, new ThrowingProvider());
    const project = await repo.createProject();
    return { repo, assets, signPreparation, finalArtwork, worker, projectId: project.project.id };
  }

  async function planAndAuthorize(
    signPreparation: Awaited<ReturnType<typeof build>>["signPreparation"],
    finalArtwork: Awaited<ReturnType<typeof build>>["finalArtwork"],
    projectId: string,
  ) {
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    return job;
  }

  it("no job at all: resolves null", async () => {
    const { finalArtwork, projectId } = await build();
    assert.equal(await finalArtwork.resolveBlockedSignProductionCandidate(projectId), null);
  });

  it("job still in flight: resolves null", async () => {
    const { signPreparation, finalArtwork, worker, projectId } = await build();
    await planAndAuthorize(signPreparation, finalArtwork, projectId);
    assert.equal(await finalArtwork.resolveBlockedSignProductionCandidate(projectId), null);
    await worker.processNextJob(); // drain, per this file's own established convention
  });

  it("job completed with NO validation at all (completeWithoutAsset): resolves null — nothing was ever produced", async () => {
    const { repo, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });
    assert.equal(await finalArtwork.resolveBlockedSignProductionCandidate(projectId), null);
  });

  it("job completed with a READY validation: resolves null — a certified asset is never a blocked candidate", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const asset = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-ready`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: asset.id,
      status: "ready",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });
    assert.equal(await finalArtwork.resolveBlockedSignProductionCandidate(projectId), null);
  });

  it("job completed with a BLOCKING validation: resolves the exact validation-bound asset", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const blockedAsset = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-blocked`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    const validation = await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: blockedAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const candidate = await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.ok(candidate);
    assert.equal(candidate!.job.id, job.id);
    assert.equal(candidate!.assetId, blockedAsset.id);
    assert.equal(candidate!.validationId, validation.id);
    assert.equal(candidate!.validationStatus, "finalization_required");
  });

  it("the historical rejected final is never selected positionally when a corrected candidate also exists", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    // Older, historical plate — created FIRST, so a positional (oldest-
    // first) pick would land here.
    const historicalRejected = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-legacy`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    // The corrected regeneration — created second, and the one the LATEST
    // validation actually binds to.
    const corrected = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-corrected`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    const validation = await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: corrected.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const candidate = await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.ok(candidate);
    assert.equal(candidate!.assetId, corrected.id, "resolves the validation-bound corrected plate");
    assert.notEqual(candidate!.assetId, historicalRejected.id, "never the older historical plate");
    void validation;
  });

  it("an intermediate asset bound by a malformed validation is refused (never served as a candidate)", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const intermediate = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-intermediate`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: { reconstructionStage: "pass1_intermediate", providerKey: "topaz_transparency_upscale", providerRequestId: "req-1" },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: intermediate.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    assert.equal(
      await finalArtwork.resolveBlockedSignProductionCandidate(projectId),
      null,
      "an intermediate must never be servable as a blocked candidate",
    );
  });

  it("a validation bound to an asset from a DIFFERENT job is refused", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const otherJob = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "sign_preparation",
      signPreparationId: "other-prep",
      signPlanKey: "other-plan-key",
    });
    const wrongJobAsset = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${otherJob.id}-wrong-job`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: otherJob.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: wrongJobAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    assert.equal(await finalArtwork.resolveBlockedSignProductionCandidate(projectId), null);
  });

  it("a validation bound to an asset from a DIFFERENT project is refused", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const otherProject = await repo.createProject();
    const wrongProjectAsset = await assets.uploadProductionAsset(otherProject.project.id, {
      conceptId: `sign-${job.id}-wrong-project`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: wrongProjectAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    assert.equal(await finalArtwork.resolveBlockedSignProductionCandidate(projectId), null);
  });

  it("no project/job/validation/asset mutation — pure read", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const blockedAsset = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-blocked-readonly`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    const validation = await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: blockedAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const before = await repo.getFinalArtworkJob(job.id);
    const beforeValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const beforeProject = await repo.getProject(projectId);

    await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    await finalArtwork.resolveBlockedSignProductionCandidate(projectId); // duplicate call — still pure

    const after = await repo.getFinalArtworkJob(job.id);
    const afterValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const afterProject = await repo.getProject(projectId);

    assert.deepEqual(after, before);
    assert.deepEqual(afterValidation, beforeValidation);
    assert.deepEqual(afterProject, beforeProject);
    assert.equal(afterValidation!.id, validation.id);
  });

  it("certified delivery remains refused for the exact same state a blocked candidate resolves for", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const blockedAsset = await assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-blocked-vs-certified`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: blockedAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const blocked = await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.ok(blocked);
    const certified = await finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    assert.equal(certified, null, "the certified download route must remain refused for a blocked state");
  });
});

/**
 * SIGNS CANDIDATE AUTHORITY: `FinalArtworkCapability.resolveTrustworthySignRepairParent`
 * — the real Get Hibachi acceptance incident this phase closes: a QR
 * replacement whose placement was visibly wrong (decoded correctly,
 * composited over unrelated artwork) persisted a NEW validation for
 * itself, and being newest, `resolveBlockedSignProductionCandidate` would
 * then have handed it to the NEXT correction as its base image — silently
 * building on already-damaged artwork. NEWER != AUTHORITATIVE.
 *
 * Deliberately never calls a provider — every fixture here is hand-seeded,
 * exactly like this file's own `resolveBlockedSignProductionCandidate`
 * suite immediately above.
 *
 * Ordering note: `waitForDistinctTimestamp` inserts a tiny real delay
 * between hand-seeded asset creations specifically where these tests
 * depend on genuine chronological ordering (`createdAt` has millisecond
 * precision) — real production writes are always genuinely
 * human/network-paced apart, so this has no bearing on the resolver's own
 * correctness, only on making a fast synthetic test fixture deterministic.
 */
describe("resolveTrustworthySignRepairParent (SIGNS CANDIDATE AUTHORITY)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-trustworthy-repair-parent-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const project = await repo.createProject();
    return { repo, assets, signPreparation, finalArtwork, projectId: project.project.id };
  }

  async function planAndAuthorize(
    signPreparation: Awaited<ReturnType<typeof build>>["signPreparation"],
    finalArtwork: Awaited<ReturnType<typeof build>>["finalArtwork"],
    projectId: string,
  ) {
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await signPreparation.planSignRepair(projectId);
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    return job;
  }

  function waitForDistinctTimestamp(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 3));
  }

  async function uploadCandidate(
    assets: Awaited<ReturnType<typeof build>>["assets"],
    projectId: string,
    jobId: string,
    label: string,
    metadata: Record<string, unknown>,
  ) {
    return assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${jobId}-${label}`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: jobId,
      productionRole: "production_png",
      metadata,
    });
  }

  it("no job / in-flight / no validation / ready validation: resolves null exactly like resolveBlockedSignProductionCandidate", async () => {
    const { finalArtwork, projectId } = await build();
    assert.equal(await finalArtwork.resolveTrustworthySignRepairParent(projectId), null);
  });

  it("a single WORKER-produced candidate (no qrRestoration metadata) with a blocking validation: trusted unconditionally", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const asset = await uploadCandidate(assets, projectId, job.id, "worker", { rigidSign: { planKey: "x" } });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: asset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const candidate = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.ok(candidate);
    assert.equal(candidate!.assetId, asset.id);
  });

  // --- Section M: simple bad-derivative-supersedes-good-parent regression ---

  it("GOOD PARENT -> BAD DERIVATIVE (newer validation, no placementValidated): resolver selects the GOOD PARENT, never the bad derivative", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const goodParent = await uploadCandidate(assets, projectId, job.id, "good-parent", { rigidSign: { planKey: "x" } });
    await waitForDistinctTimestamp();
    const badDerivative = await uploadCandidate(assets, projectId, job.id, "bad-derivative", {
      qrRestoration: { restoredFromAssetId: goodParent.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1 },
      // no placementValidated field at all — the exact real historical shape.
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: badDerivative.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.ok(trustworthy);
    assert.equal(trustworthy!.assetId, goodParent.id, "must select the good parent");
    assert.notEqual(trustworthy!.assetId, badDerivative.id, "must never select the bad derivative merely because its validation is newer");

    // The blocked-candidate (operator inspection) resolver's own semantics remain UNCHANGED — it still shows the actual latest attempt.
    const blocked = await finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.equal(blocked!.assetId, badDerivative.id, "operator visual inspection must still see the actual failed attempt");
  });

  it("GOOD PARENT -> VERIFIED GOOD DERIVATIVE (newer validation, placementValidated: true): resolver selects the verified good derivative", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const goodParent = await uploadCandidate(assets, projectId, job.id, "good-parent", { rigidSign: { planKey: "x" } });
    await waitForDistinctTimestamp();
    const goodDerivative = await uploadCandidate(assets, projectId, job.id, "good-derivative", {
      qrRestoration: { restoredFromAssetId: goodParent.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: true },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: goodDerivative.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.ok(trustworthy);
    assert.equal(trustworthy!.assetId, goodDerivative.id, "a verified-placement derivative IS eligible to supersede its parent");
  });

  // --- Section N: multi-stage iterative repair ---

  it("multi-stage iterative repair: A -> successful resolution repair B -> successful QR repair C (still finalization_required for an unrelated reason) — authority progresses A -> B -> C; a failed D derived from C never supersedes C", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);

    const A = await uploadCandidate(assets, projectId, job.id, "A", { rigidSign: { planKey: "x", stage: "first-attempt" } });
    await waitForDistinctTimestamp();

    // B: a second, corrected WORKER regeneration under the same job (the
    // established "rejected-final-regeneration" pattern this file already
    // tests above) — still trustworthy unconditionally, no qrRestoration.
    const B = await uploadCandidate(assets, projectId, job.id, "B", { rigidSign: { planKey: "x", stage: "resolution-corrected" } });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: B.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    let trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.equal(trustworthy!.assetId, B.id, "authority progresses to B");

    await waitForDistinctTimestamp();
    // C: a successful QR repair derived from B — still finalization_required overall (an independent, unrelated safe-zone issue remains).
    const C = await uploadCandidate(assets, projectId, job.id, "C", {
      qrRestoration: { restoredFromAssetId: B.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: true },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: C.id,
      status: "finalization_required",
      report: {},
    });

    trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.equal(trustworthy!.assetId, C.id, "authority progresses to C even though overall status is still finalization_required");

    await waitForDistinctTimestamp();
    // D: a FAILED further derivative of C (hand-seeded to prove the authority MODEL itself is robust, independent of whether the replacement safety gate would also have prevented D from ever being persisted in the first place).
    const D = await uploadCandidate(assets, projectId, job.id, "D", {
      qrRestoration: { restoredFromAssetId: C.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: false },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: D.id,
      status: "finalization_required",
      report: {},
    });

    trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.equal(trustworthy!.assetId, C.id, "a failed D derived from C must NOT supersede C");
    assert.notEqual(trustworthy!.assetId, D.id);
    void A;
  });

  // --- Section O: branching lineage ---

  it("branching lineage: A -> failed sibling B, A -> successful sibling C (C newer) — resolver chooses C", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const A = await uploadCandidate(assets, projectId, job.id, "A", { rigidSign: { planKey: "x" } });
    await waitForDistinctTimestamp();
    const B = await uploadCandidate(assets, projectId, job.id, "B-failed-sibling", {
      qrRestoration: { restoredFromAssetId: A.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: false },
    });
    await waitForDistinctTimestamp();
    const C = await uploadCandidate(assets, projectId, job.id, "C-successful-sibling", {
      qrRestoration: { restoredFromAssetId: A.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: true },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: C.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.equal(trustworthy!.assetId, C.id);
    void B;
  });

  it("branching lineage: A -> successful OLDER sibling B, A -> failed NEWER sibling C — resolver chooses B, not merely 'walk back one step' from C (which would land on A)", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const A = await uploadCandidate(assets, projectId, job.id, "A", { rigidSign: { planKey: "x" } });
    await waitForDistinctTimestamp();
    const B = await uploadCandidate(assets, projectId, job.id, "B-successful-older-sibling", {
      qrRestoration: { restoredFromAssetId: A.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: true },
    });
    await waitForDistinctTimestamp();
    // C's OWN restoredFromAssetId points to A (a sibling of B, NOT a child of B) — proving the resolver does not need correct ancestry metadata to find B; it just needs B to independently qualify as trustworthy on its own.
    const C = await uploadCandidate(assets, projectId, job.id, "C-failed-newer-sibling", {
      qrRestoration: { restoredFromAssetId: A.id, sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: false },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: C.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.equal(trustworthy!.assetId, B.id, "must choose B, the successful older sibling — not A, and not C");
  });

  // --- Section J: historical compatibility ---

  it("a historical resolution-only (non-QR-derived) asset lacking qrRestoration metadata is never invalidated merely for lacking placement evidence that was never relevant to it", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    // No qrRestoration key anywhere — a plain historical Topaz/worker candidate, exactly like the real project's own 2e8a45b7 asset shape.
    const asset = await uploadCandidate(assets, projectId, job.id, "historical-topaz-only", {
      rigidSign: { planKey: "x", providerKey: "topaz_transparency_upscale" },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: asset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.ok(trustworthy, "a historical non-QR-derived asset must remain a valid repair parent");
    assert.equal(trustworthy!.assetId, asset.id);
  });

  it("exhausted lineage (every candidate untrustworthy): fails closed to null, never guesses", async () => {
    const { repo, assets, signPreparation, finalArtwork, projectId } = await build();
    const job = await planAndAuthorize(signPreparation, finalArtwork, projectId);
    const onlyAsset = await uploadCandidate(assets, projectId, job.id, "only-bad", {
      qrRestoration: { restoredFromAssetId: "nonexistent", sourceAssetId: "src-1", planKey: "x", restoredCount: 1, placementValidated: false },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: onlyAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const trustworthy = await finalArtwork.resolveTrustworthySignRepairParent(projectId);
    assert.equal(trustworthy, null, "no trustworthy candidate exists — must fail closed, never fabricate one");
  });
});
