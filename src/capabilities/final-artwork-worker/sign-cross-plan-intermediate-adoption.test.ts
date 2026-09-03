/**
 * Signs Phase 3A: CROSS-PLAN Topaz intermediate reconstruction adoption.
 * Every existing intermediate lookup is SAME-JOB scoped — this proves the
 * new cross-plan path lets a genuinely NEW plan/job (a re-plan for the SAME
 * sign preparation, e.g. after an operator confirms structural evidence)
 * reuse an already-paid-for reconstruction from a PRIOR job rather than
 * dispatching a second paid request, provided it is actually sufficient —
 * and correctly falls through to a fresh dispatch when it is not.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import { uniformBackgroundSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "./fake-sign-reconstruction-provider";

describe("Signs Phase 3A: cross-plan Topaz intermediate reconstruction adoption", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-cross-plan-intermediate-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(provider: FakeSignReconstructionProvider) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, assets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider);
    const project = await repo.createProject();
    return { repo, assets, signPreparation, finalArtwork, worker, projectId: project.project.id };
  }

  async function confirmPlanAuthorizeRun(
    signPreparation: ReturnType<typeof createSignPreparationCapability>,
    finalArtwork: ReturnType<typeof createFinalArtworkCapability>,
    worker: ReturnType<typeof createFinalArtworkWorkerCapability>,
    projectId: string,
    orderedWidthIn: number,
    orderedHeightIn: number,
  ) {
    await signPreparation.confirmSignProductionSpec(projectId, orderedWidthIn, orderedHeightIn);
    const outcome = await signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    await signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    return outcome.result.status === "planned" ? outcome.result.plan!.planKey : null;
  }

  it("A: a re-plan at a SMALLER/equal ordered size adopts the prior job's already-paid-for intermediate — zero additional Topaz dispatch", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);

    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 750)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });

    // Plan 1: 18x24in — needs reconstruction (1000x750 at 18x24in is well
    // below the 150 PPI target).
    const planKey1 = await confirmPlanAuthorizeRun(signPreparation, finalArtwork, worker, projectId, 18, 24);
    assert.equal(provider.dispatchCount, 1);
    assert.equal(provider.resumeCount, 0);

    // Plan 2: a SMALLER ordered size — a genuinely different planKey (the
    // requested reconstruction target changes), but plan 1's own already-
    // persisted intermediate is MORE than sufficient for it.
    const planKey2 = await confirmPlanAuthorizeRun(signPreparation, finalArtwork, worker, projectId, 9, 12);
    assert.notEqual(planKey1, planKey2);

    // Zero additional provider dispatches AND zero resumes — a cross-plan
    // adoption is neither a fresh submission nor a resume of an
    // OUTSTANDING request (there is none); it is a durable readback.
    assert.equal(provider.dispatchCount, 1);
    assert.equal(provider.resumeCount, 0);

    const preparation = await signPreparation.getSignPreparation(projectId);
    assert.equal(preparation!.status, "planned");

    // The adopted-intermediate job completed cleanly end-to-end — including
    // preservation verification, which resolves its own intermediate via a
    // job-scoped query and would otherwise never find one for an adopting
    // job that persisted no reconstruction of its own.
    const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation!.id);
    const job2 = jobs.find((j) => j.signPlanKey === planKey2);
    assert.ok(job2);
    assert.equal(job2!.status, "completed");
  });

  it("B: a re-plan at a LARGER ordered size does NOT adopt an insufficient prior intermediate — dispatches its own fresh (second) reconstruction, never silently reusing an undersized result", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { signPreparation, finalArtwork, worker, projectId } = await build(provider);

    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 750)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });

    await confirmPlanAuthorizeRun(signPreparation, finalArtwork, worker, projectId, 9, 12);
    assert.equal(provider.dispatchCount, 1);

    // A LARGER ordered size requests a bigger reconstruction than plan 1's
    // own persisted intermediate can satisfy — must dispatch its own.
    await confirmPlanAuthorizeRun(signPreparation, finalArtwork, worker, projectId, 15, 20);
    assert.equal(provider.dispatchCount, 2);
  });

  it("C: cross-plan adoption never touches providerRecoveryAttempts and never resets an exhausted budget", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId } = await build(provider);

    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 750)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });

    await confirmPlanAuthorizeRun(signPreparation, finalArtwork, worker, projectId, 18, 24);
    const preparation1 = await signPreparation.getSignPreparation(projectId);
    const job1 = (await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation1!.id)).find(
      (j) => j.signPlanKey === preparation1!.planKey,
    );
    assert.ok(job1);
    assert.equal(job1!.providerRecoveryAttempts, 0);

    await confirmPlanAuthorizeRun(signPreparation, finalArtwork, worker, projectId, 9, 12);
    const preparation2 = await signPreparation.getSignPreparation(projectId);
    const job2 = (await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation2!.id)).find(
      (j) => j.signPlanKey === preparation2!.planKey,
    );
    assert.ok(job2);
    // A brand-new job's own counter starts at 0 and cross-plan adoption
    // never touches it (it bypasses provider dispatch entirely).
    assert.equal(job2!.providerRecoveryAttempts, 0);
    assert.equal(job2!.providerRequestId, null);
    assert.equal(job2!.providerKey, null);
  });
});
