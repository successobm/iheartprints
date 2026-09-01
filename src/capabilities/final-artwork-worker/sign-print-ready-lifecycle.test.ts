import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import { ruthLikeSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { createSignPreservationCapability } from "@/capabilities/sign-preservation";
import { FakeSignPreservationSemanticProvider } from "@/capabilities/sign-preservation/fake-sign-preservation-semantic-provider";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

/**
 * Print-Ready Lifecycle Phase: `reconcileSignPrintReadyStatus` — the
 * supported operation for correcting a project whose `PrintProject.status`
 * says `"print_ready"` but whose ready asset's own plan is no longer the
 * preparation's current one. Every test uses `FakeSignReconstructionProvider`
 * / `FakeSignPreservationSemanticProvider` — never Topaz, never a real
 * semantic provider.
 */
describe("Print-Ready Lifecycle Phase: reconcileSignPrintReadyStatus", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-print-ready-lifecycle-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(
    reconstructionProvider: FakeSignReconstructionProvider,
    semanticProvider: FakeSignPreservationSemanticProvider,
  ) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const signPreservation = createSignPreservationCapability(repo, assets, semanticProvider);
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
    return { repo, assets, signPreparation, finalArtwork, worker, projectId: project.project.id };
  }

  /** Ruth-shaped, driven all the way to a real print_ready via the real worker — the SAME fixture the other Signs worker suites use. */
  async function ruthReadyProject(
    reconstructionProvider: FakeSignReconstructionProvider,
    semanticProvider: FakeSignPreservationSemanticProvider,
  ) {
    const built = await build(reconstructionProvider, semanticProvider);
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);
    await built.signPreparation.planSignRepair(built.projectId);
    await built.signPreparation.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    const { job } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    reconstructionProvider.behavior = { kind: "oversized_but_valid", widthPx: 4096, heightPx: 6144 };
    await built.worker.processNextJob();

    const project = await built.repo.getProject(built.projectId);
    assert.equal(project!.project.status, "print_ready", "sanity: the fixture must actually reach print_ready");

    const finalAsset = (await built.repo.listAssets(built.projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png" && !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "sanity: a real final asset must exist");
    return { ...built, job, finalAsset: finalAsset! };
  }

  it("1: a genuinely still-current ready plan is left alone — invalidated: false, status stays print_ready", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, worker } = await ruthReadyProject(reconstructionProvider, semanticProvider);

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, false);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready");
  });

  it("2: a project that never was print_ready -> no-op", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const { repo, worker, projectId } = await build(reconstructionProvider, semanticProvider);

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, false);
    assert.match(result.reason, /not currently print_ready/i);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "intake");
  });

  it("3: a project with no sign preparation at all -> no-op, even if (hypothetically) print_ready", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const { repo, worker, projectId } = await build(reconstructionProvider, semanticProvider);
    await repo.setProjectStatus(projectId, "print_ready");

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, false);
    assert.match(result.reason, /no sign preparation/i);
  });

  it("4: a nonexistent project -> no-op", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const { worker } = await build(reconstructionProvider, semanticProvider);

    const result = await worker.reconcileSignPrintReadyStatus("00000000-0000-0000-0000-000000000000");
    assert.equal(result.invalidated, false);
  });

  it("5: CORE CASE — the current plan supersedes the ready asset's plan (a genuine re-plan under a different confirmed spec) -> invalidated, finalization_required", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, worker, job, signPreparation } = await ruthReadyProject(
      reconstructionProvider,
      semanticProvider,
    );
    const readyPlanKey = job.signPlanKey;

    // A genuine re-plan under a DIFFERENT confirmed spec — the real
    // capability path, never a hand-poked plan/planKey.
    await signPreparation.confirmSignProductionSpec(projectId, 12, 18);
    const { result: replanResult, preparation: replanned } = await signPreparation.planSignRepair(projectId);
    assert.notEqual(replanned.planKey, readyPlanKey, "sanity: the re-plan must genuinely differ from the ready asset's plan");

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, true);
    assert.match(result.reason, /superseded/i);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalization_required");
    void replanResult;
  });

  it("6: preparation currently has NO plan at all (a corrected re-plan lands on blocked) -> invalidated, finalization_required", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, worker, preparation } = await ruthReadyProject(reconstructionProvider, semanticProvider).then(
      async (built) => ({ ...built, preparation: await built.repo.getSignPreparation(built.projectId) }),
    );
    void preparation;

    // Simulate the real incident's exact shape: a corrected re-evaluation
    // recorded `plan: null, planKey: null` — the SAME fields
    // `planSignRepair` itself writes on a blocked outcome (it never touches
    // `status` in that case either), applied directly here as fixture
    // setup (never as a "fix" for a real project).
    await repo.updateSignPreparation((await repo.getSignPreparation(projectId))!.id, {
      plan: null,
      planKey: null,
    });

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, true);
    assert.match(result.reason, /no plan at all/i);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalization_required");
  });

  it("7: print_ready with no completed job backed by a ready validation at all -> fails closed, invalidated", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const { repo, worker, projectId, signPreparation } = await build(reconstructionProvider, semanticProvider);
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await signPreparation.planSignRepair(projectId);
    // No authorization, no job, no validation — yet the project SAYS
    // print_ready (a corrupted/impossible state by any real code path,
    // exactly the kind of thing this function must fail closed on).
    await repo.setProjectStatus(projectId, "print_ready");

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, true);
    assert.match(result.reason, /not backed by any completed job/i);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalization_required");
  });

  it("8: idempotent — a second reconciliation after invalidation is a pure no-op", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, worker, signPreparation } = await ruthReadyProject(reconstructionProvider, semanticProvider);
    await signPreparation.confirmSignProductionSpec(projectId, 12, 18);
    await signPreparation.planSignRepair(projectId);

    const first = await worker.reconcileSignPrintReadyStatus(projectId);
    assert.equal(first.invalidated, true);
    const projectAfterFirst = await repo.getProject(projectId);
    assert.equal(projectAfterFirst!.project.status, "finalization_required");
    const updatedAtAfterFirst = projectAfterFirst!.project.updatedAt;

    const second = await worker.reconcileSignPrintReadyStatus(projectId);
    assert.equal(second.invalidated, false, "already finalization_required — nothing left to invalidate");
    assert.match(second.reason, /not currently print_ready/i);
    const projectAfterSecond = await repo.getProject(projectId);
    assert.equal(projectAfterSecond!.project.status, "finalization_required");
    assert.equal(
      projectAfterSecond!.project.updatedAt,
      updatedAtAfterFirst,
      "no unnecessary second write — the timestamp must not move on a pure no-op",
    );
  });

  it("9: idempotent — repeated reconciliation of a STILL-CURRENT ready plan never mutates anything", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, worker } = await ruthReadyProject(reconstructionProvider, semanticProvider);

    await worker.reconcileSignPrintReadyStatus(projectId);
    const projectAfterFirst = await repo.getProject(projectId);
    assert.equal(projectAfterFirst!.project.status, "print_ready");
    const updatedAtAfterFirst = projectAfterFirst!.project.updatedAt;

    await worker.reconcileSignPrintReadyStatus(projectId);
    const projectAfterSecond = await repo.getProject(projectId);
    assert.equal(projectAfterSecond!.project.status, "print_ready");
    assert.equal(projectAfterSecond!.project.updatedAt, updatedAtAfterFirst);
  });

  it("10: HISTORICAL ARTIFACTS PRESERVED — invalidation never deletes/rewrites the ready job, asset, validation, preservation record, or authorization", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { repo, projectId, worker, job, finalAsset, signPreparation } = await ruthReadyProject(
      reconstructionProvider,
      semanticProvider,
    );
    const validationBefore = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const preparationBefore = await repo.getSignPreparation(projectId);
    // A fresh read of the completed job BEFORE reconciliation — `job`
    // itself is the pre-processing enqueue snapshot `requestSignFinalArtwork`
    // returned, whose `completedAt` is still null by construction.
    const jobBefore = await repo.getFinalArtworkJob(job.id);
    assert.ok(validationBefore);
    assert.equal(validationBefore!.status, "ready");
    assert.equal(jobBefore!.status, "completed");

    await signPreparation.confirmSignProductionSpec(projectId, 12, 18);
    await signPreparation.planSignRepair(projectId);
    const result = await worker.reconcileSignPrintReadyStatus(projectId);
    assert.equal(result.invalidated, true);

    // The historical job, exactly as it completed.
    const jobAfter = await repo.getFinalArtworkJob(job.id);
    assert.equal(jobAfter!.status, "completed");
    assert.equal(jobAfter!.signPlanKey, job.signPlanKey, "the job's own frozen plan identity is never rewritten");
    assert.equal(jobAfter!.completedAt, jobBefore!.completedAt, "the historical job's completion timestamp is never rewritten");

    // The historical production asset — still resolvable, byte-identical id.
    const assetAfter = await repo.listAssets(projectId).then((all) => all.find((a) => a.id === finalAsset.id));
    assert.ok(assetAfter, "the historical production asset row still exists");

    // The historical validation row — untouched, still says "ready" (never
    // rewritten to "failed"; it was a TRUE record of what was true then).
    const validationAfter = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validationAfter!.id, validationBefore!.id, "no new validation row was created for the old job");
    assert.equal(validationAfter!.status, "ready", "history is never rewritten to say the OLD validation failed");

    // The historical authorization the OLD (now-superseded) plan carried —
    // still on file, but structurally can never authorize a NEW plan
    // (`authorizedPlanKey` binds to the plan it was granted for).
    assert.equal(preparationBefore!.authorizedBy, "operator");
    assert.equal(preparationBefore!.authorizedPlanKey, job.signPlanKey);
    const preparationAfter = await repo.getSignPreparation(projectId);
    assert.notEqual(
      preparationAfter!.authorizedPlanKey,
      preparationAfter!.planKey,
      "the OLD authorization can never authorize the NEW (current) plan — it binds to a plan key that is no longer current",
    );
  });

  it("11: never sets print_ready itself — reconciliation is a one-directional (revoke-only) operation", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    const { repo, worker, projectId } = await build(reconstructionProvider, semanticProvider);
    // A project sitting at some ordinary non-ready status.
    await repo.setProjectStatus(projectId, "finalizing");

    const result = await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(result.invalidated, false);
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalizing", "reconciliation never promotes a project TO print_ready");
  });

  it("12: zero provider/reconstruction calls from reconciliation itself", async () => {
    const reconstructionProvider = new FakeSignReconstructionProvider();
    const semanticProvider = new FakeSignPreservationSemanticProvider();
    semanticProvider.behavior = { kind: "all_same" };
    const { projectId, worker } = await ruthReadyProject(reconstructionProvider, semanticProvider);
    const dispatchBefore = reconstructionProvider.dispatchCount;
    const semanticDispatchBefore = semanticProvider.dispatchCount;

    await worker.reconcileSignPrintReadyStatus(projectId);

    assert.equal(reconstructionProvider.dispatchCount, dispatchBefore);
    assert.equal(semanticProvider.dispatchCount, semanticDispatchBefore, "reconciliation never re-dispatches semantic verification either");
  });
});
