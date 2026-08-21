import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import { PlaceholderConceptProvider } from "@/capabilities/providers";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";

import { createFinalArtworkCapability } from "./final-artwork-capability";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

describe("FinalArtworkCapability.requestFinalArtwork (Sprint 2M Phase 2B)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-final-artwork-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  function buildPipeline(repo: Awaited<ReturnType<typeof freshRepo>>) {
    const provider = new PlaceholderConceptProvider();
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const conceptGeneration = createConceptGenerationCapability(repo, provider.providerKey);
    const worker = createGenerationWorkerCapability(repo, provider, promptTranslation, assets);
    return { conceptGeneration, worker };
  }

  /** Drives a project all the way to "concepts_ready" with one concept selected. */
  async function projectWithSelectedConcept(
    repo: Awaited<ReturnType<typeof freshRepo>>,
  ) {
    const { conceptGeneration, worker } = buildPipeline(repo);
    const created = await repo.createProject();
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      printPlacement: "full_back",
    });

    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(projectId);

    await conceptGeneration.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();

    const afterGeneration = await repo.getProject(projectId);
    const [firstConcept] = afterGeneration!.artworkVersions;
    await repo.selectArtworkVersion(projectId, firstConcept!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is never
    // final approval — most scenarios in this file are about what happens
    // once the customer HAS confirmed, so confirm by default here; the
    // dedicated "not yet confirmed" test explicitly un-confirms instead.
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });
    // Print'em All Phase 1: production work now requires an explicit human
    // confirmation of the physical print size. These scenarios are about what
    // happens once finalization is authorized, so they perform that
    // confirmation here — the same act a customer performs on the size card.
    await confirmProductionSizeForTests(repo, projectId);

    return { projectId, versionId: version.id, artworkId: firstConcept!.id, worker, conceptGeneration };
  }

  // --- C: explicit approval targets exact ArtworkVersion ------------------
  it("C: records an active approval for the exact selected ArtworkVersion and enqueues a queued job", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, versionId, artworkId } = await projectWithSelectedConcept(repo);

    const result = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    assert.equal(result.approval.artworkVersionId, artworkId);
    assert.equal(result.approval.designBriefVersionId, versionId);
    assert.equal(result.approval.status, "active");
    assert.equal(result.job.finalDirectionApprovalId, result.approval.id);
    assert.equal(result.job.artworkVersionId, artworkId);
    assert.equal(result.job.status, "queued");
    assert.equal(result.alreadyRequested, false);

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalizing");
  });

  // --- D: cross-project rejection ------------------------------------------
  it("D: rejects an ArtworkVersion id that belongs to another project", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { artworkId: artworkFromProjectOne } = await projectWithSelectedConcept(repo);
    const { projectId: projectTwoId } = await projectWithSelectedConcept(repo);

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectTwoId, artworkFromProjectOne),
      /not found/i,
    );
  });

  // --- E/F/Q/R: idempotency -------------------------------------------------
  it("E/F: double request for the same artwork is idempotent — no duplicate approval or job", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    const first = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    const second = await finalArtwork.requestFinalArtwork(projectId, artworkId);

    assert.equal(second.approval.id, first.approval.id);
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.alreadyRequested, true);

    const active = await repo.getActiveFinalDirectionApproval(projectId);
    assert.equal(active?.id, first.approval.id);
    const job = await repo.getFinalArtworkJobByApprovalId(projectId, first.approval.id);
    assert.equal(job?.id, first.job.id);
  });

  // --- Not selected ----------------------------------------------------------
  it("rejects approving a concept that is not the project's current selection", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, worker } = await projectWithSelectedConcept(repo);
    void worker;

    const snapshot = await repo.getProject(projectId);
    const unselected = snapshot!.artworkVersions.find((a) => !a.isSelected);
    assert.ok(unselected, "expected a second, unselected concept to exist");

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, unselected!.id),
      /select this concept/i,
    );
  });

  // --- Missing / unknown artwork -----------------------------------------
  it("rejects an unknown artworkVersionId", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId } = await projectWithSelectedConcept(repo);

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, "00000000-0000-0000-0000-000000000000"),
      /not found/i,
    );
  });

  // --- Stale relative to working brief -------------------------------------
  it("rejects approval when the working brief has drifted past the approved concept without regenerating", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    // A concept-relevant field changes without a new approved brief version
    // / regeneration — the selected concept no longer reflects the brief.
    await repo.updateBrief(projectId, { shirtColor: "Forest Green" });

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, artworkId),
      /not yet reflected/i,
    );
  });

  // --- G/H/I: obsolete batch rejected; old approval superseded, not deleted --
  it("G/H/I: approving an obsolete (previous-batch) concept is rejected; regeneration supersedes a prior approval without deleting it", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId, conceptGeneration, worker } =
      await projectWithSelectedConcept(repo);

    const firstApproval = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(firstApproval.approval.status, "active");

    // Customer revises, then explicitly regenerates — a new concept batch
    // is produced against a new approved brief version.
    await repo.updateBrief(projectId, { designDescription: "A fox mascot instead" });
    const designBrief = createDesignBriefCapability(repo);
    const newVersion = await designBrief.approveWorkingBrief(projectId);
    await conceptGeneration.regenerateAfterRevision(projectId, newVersion.id);
    await worker.processNextJob();

    // I: the prior approval is historical/superseded, never deleted.
    const supersededRow = await repo.getActiveFinalDirectionApproval(projectId);
    assert.equal(supersededRow, null);

    // G: approving the now-obsolete original concept is rejected.
    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, artworkId),
      /earlier design direction/i,
    );

    // H: a new ArtworkVersion requires its own, brand-new approval.
    const afterRegeneration = await repo.getProject(projectId);
    const newBatch = afterRegeneration!.artworkVersions.filter(
      (a) => a.designBriefVersionId === newVersion.id,
    );
    assert.ok(newBatch.length > 0);
    await repo.selectArtworkVersion(projectId, newBatch[0]!.id);
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });
    // Print'em All Phase 1: production work now requires an explicit human
    // confirmation of the physical print size. These scenarios are about what
    // happens once finalization is authorized, so they perform that
    // confirmation here — the same act a customer performs on the size card.
    await confirmProductionSizeForTests(repo, projectId);
    const secondApproval = await finalArtwork.requestFinalArtwork(projectId, newBatch[0]!.id);
    assert.notEqual(secondApproval.approval.id, firstApproval.approval.id);
    assert.equal(secondApproval.approval.status, "active");
  });

  // --- Sprint 2M Phase 2G, Goal 6: server-side revision-pending gate ------
  it("L: refuses to create an approval/job while a revision is pending, even if the UI is bypassed", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    await repo.updateProject(projectId, { revisionPending: true });

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, artworkId),
      /reviewed before/i,
    );

    // No approval, no job, and no internal lifecycle terminology leaked
    // into the rejection.
    const active = await repo.getActiveFinalDirectionApproval(projectId);
    assert.equal(active, null);
    try {
      await finalArtwork.requestFinalArtwork(projectId, artworkId);
      assert.fail("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      assert.doesNotMatch(message, /revisionPending|FinalDirectionApproval|FinalArtworkJob/);
    }
  });

  it("Live Acceptance Corrective Pass (Section 2): refuses to finalize a merely-selected concept that was never explicitly confirmed", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    // Undo the helper's default confirmation — this test is specifically
    // about the unconfirmed state.
    await repo.updateProject(projectId, { finalDirectionConfirmed: false });

    await assert.rejects(
      () => finalArtwork.requestFinalArtwork(projectId, artworkId),
      /confirm this is your final direction/i,
    );

    const active = await repo.getActiveFinalDirectionApproval(projectId);
    assert.equal(active, null);

    // Explicit confirmation unblocks it.
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });
    // Print'em All Phase 1: production work now requires an explicit human
    // confirmation of the physical print size. These scenarios are about what
    // happens once finalization is authorized, so they perform that
    // confirmation here — the same act a customer performs on the size card.
    await confirmProductionSizeForTests(repo, projectId);
    const result = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(result.approval.status, "active");
  });

  it("clearing revisionPending allows the same artwork to be requested afterward", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    await repo.updateProject(projectId, { revisionPending: true });
    await assert.rejects(() => finalArtwork.requestFinalArtwork(projectId, artworkId));

    await repo.updateProject(projectId, { revisionPending: false });
    const result = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(result.approval.status, "active");
  });

  // --- Sprint 2M Phase 2G, Goal 8: repeat Prepare is idempotent and truthful --
  it("S: repeat Prepare on an already-completed job returns the existing ready state, never re-enters 'finalizing'", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    const first = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(first.job.status, "queued");

    // Simulate FinalArtworkWorkerCapability having already completed this
    // job and truthfully transitioned the project to print_ready.
    await repo.updateFinalArtworkJob(first.job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "print_ready");

    const repeat = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(repeat.alreadyRequested, true);
    assert.equal(repeat.job.status, "completed");

    const project = await repo.getProject(projectId);
    // Must remain the worker's own truthful terminal state — never
    // stomped back to "finalizing" with no claimable job left (Goal 8).
    assert.equal(project?.project.status, "print_ready");
  });

  it("T: repeat Prepare on a needs_review (finalization_required) job returns that truthful state", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    const first = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await repo.updateFinalArtworkJob(first.job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "finalization_required");

    const repeat = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(repeat.job.status, "completed");

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalization_required");
  });

  it("U: a failed job is revived to queued on retry and legitimately re-enters finalizing (not stranded)", async () => {
    const repo = await freshRepo();
    const finalArtwork = createFinalArtworkCapability(repo);
    const { projectId, artworkId } = await projectWithSelectedConcept(repo);

    const first = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    await repo.updateFinalArtworkJob(first.job.id, {
      status: "failed",
      lastError: "simulated infrastructure failure",
      providerKey: "topaz_transparency_upscale",
      providerRequestId: "already-submitted-id",
    });
    await repo.setProjectStatus(projectId, "finalizing");

    const retry = await finalArtwork.requestFinalArtwork(projectId, artworkId);
    assert.equal(retry.job.id, first.job.id); // same job, revived — never duplicated
    assert.equal(retry.job.status, "queued");
    assert.equal(retry.job.providerKey, "topaz_transparency_upscale");
    assert.equal(retry.job.providerRequestId, "already-submitted-id");

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalizing");
  });
});
