import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2H Part 2A/2B: polling status facade.
 * `submitDesignBriefDecision`/`regenerateConcepts` themselves are already
 * covered elsewhere (design-brief-decision.test.ts,
 * conversation-revision.test.ts) — this file is scoped to
 * `getGenerationStatus`, which Sprint 2H Part 2B made strictly read-only:
 * it no longer dispatches a worker (removed along with
 * `triggerGenerationWorker`) and no longer recovers abandoned jobs as a
 * side effect of being polled — see `capabilities/worker-scheduler/` for
 * where that responsibility now lives.
 */
describe("conversation-service — generation status polling (Sprint 2H Part 2A)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-genstatus-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("returns null for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getGenerationStatus } = await import("./conversation-service");
    assert.equal(await getGenerationStatus("00000000-0000-0000-0000-000000000000"), null);
  });

  it("reports 'idle' before any generation has been requested", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { startConversation, getGenerationStatus } = await import("./conversation-service");

    const created = await startConversation();
    assert.deepEqual(await getGenerationStatus(created.project.id), { status: "idle" });
  });

  it("reports 'generating' immediately after approval, then 'ready' once the worker completes — never blocking on the provider itself", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
      getGenerationStatus,
    } = await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });

    const enqueued = await submitDesignBriefDecision(projectId, "approve");
    assert.equal(enqueued.conversation.phase, "generating");
    assert.deepEqual(await getGenerationStatus(projectId), { status: "generating" });
    assert.equal(
      getCapabilityGraph().workerScheduler.hasActiveBatch(),
      false,
      "automated tests must not auto-trigger the local worker after enqueue",
    );

    await getCapabilityGraph().generationWorker.processNextJob();
    assert.deepEqual(await getGenerationStatus(projectId), { status: "ready" });
  });

  it("no longer exports triggerGenerationWorker or drainGenerationWorkersForTests — generation is never dispatched from this module", async () => {
    const conversationService = await import("./conversation-service");
    assert.equal("triggerGenerationWorker" in conversationService, false);
    assert.equal("drainGenerationWorkersForTests" in conversationService, false);
  });

  it("automated-test polling never starts a local batch for a queued attempts=0 job", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getGenerationStatus } =
      await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    await getGenerationStatus(projectId);
    await getGenerationStatus(projectId);

    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);
    const repo = (await import("@/lib/db")).getProjectRepository();
    const [job] = await repo.listGenerationJobs(projectId);
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 0);
  });

  it("polling never recovers an abandoned running job — that stays 'generating', unresolved, until the independent worker runs", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getGenerationStatus } =
      await import("./conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const repo = (await import("@/lib/db")).getProjectRepository();
    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);

    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repo.updateGenerationJob(job.id, {
      status: "running",
      startedAt: longAgo,
      heartbeatAt: longAgo,
    });

    // Polling repeatedly must never flip the stale job to "recoverable" —
    // recovery is exclusively the independent worker's job now.
    await getGenerationStatus(projectId);
    await getGenerationStatus(projectId);
    await getGenerationStatus(projectId);

    const stillRunning = await repo.getGenerationJob(job.id);
    assert.equal(stillRunning?.status, "running");
    assert.deepEqual(await getGenerationStatus(projectId), { status: "generating" });

    // Only once the independent worker actually runs does the job resolve.
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    await getCapabilityGraph().workerScheduler.runBatch();
    assert.deepEqual(await getGenerationStatus(projectId), { status: "ready" });
  });
});

describe("conversation-service — finalization status polling", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-finalization-status-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function projectWithSelectedConcept() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const conversationService = await import("./conversation-service");
    const { startConversation, handleUserMessage, submitDesignBriefDecision, selectConcept } =
      conversationService;

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");
    await getCapabilityGraph().generationWorker.processNextJob();

    const generated = await conversationService.getConversation(projectId);
    const [concept] = generated!.artworkVersions;
    await selectConcept(projectId, concept!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default here.
    await conversationService.confirmSelectedDirection(projectId, concept!.id);

    return { projectId, artworkVersionId: concept!.id, conversationService };
  }

  it("returns null for a project that does not exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getFinalizationStatus } = await import("./conversation-service");
    assert.equal(
      await getFinalizationStatus("00000000-0000-0000-0000-000000000000"),
      null,
    );
  });

  it("reports not_requested before finalization is requested", async () => {
    const { projectId, conversationService } = await projectWithSelectedConcept();
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "not_requested",
    });
  });

  it("reports preparing after approveFinalDirection, then print_ready once persisted", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });

    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "print_ready");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "print_ready",
    });
    const snapshot = await conversationService.getConversation(projectId);
    assert.equal(snapshot?.finalization.status, "print_ready");
  });

  it("reports needs_review once PrintProject.status is finalization_required", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();

    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().setProjectStatus(projectId, "finalization_required");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "needs_review",
    });
  });

  it("E/J: repeated polls never enqueue a second FinalArtworkJob (automated tests stay read-only)", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    assert.ok(approval);
    const job = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
    assert.ok(job);
    assert.equal(job.status, "queued");

    await conversationService.getFinalizationStatus(projectId);
    await conversationService.getFinalizationStatus(projectId);
    await conversationService.getFinalizationStatus(projectId);

    const stillQueued = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
    assert.equal(stillQueued?.id, job.id);
    assert.equal(stillQueued?.status, "queued");
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("G: customer-safe status view never includes job/provider/storage internals", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const view = await conversationService.getFinalizationStatus(projectId);
    assert.deepEqual(Object.keys(view ?? {}), ["status"]);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("finalArtworkJobId"), false);
    assert.equal(serialized.includes("storageKey"), false);
    assert.equal(serialized.includes("topaz"), false);
    assert.equal(serialized.includes("provider"), false);
  });

  async function currentGeneratedJob(projectId: string) {
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    assert.ok(approval);
    const job = await repo.getFinalArtworkJobByApprovalId(projectId, approval.id);
    assert.ok(job);
    return { repo, job };
  }

  it("finalizing + queued reports preparing", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { job } = await currentGeneratedJob(projectId);
    assert.equal(job.status, "queued");
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("finalizing + running reports preparing", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { repo, job } = await currentGeneratedJob(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "running" });
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("finalizing + recoverable reports preparing", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { repo, job } = await currentGeneratedJob(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "recoverable" });
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("finalizing + failed reports retryable_failure without leaking internals", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { repo, job } = await currentGeneratedJob(projectId);
    await repo.updateFinalArtworkJob(job.id, {
      status: "failed",
      lastError: "Production asset could not be persisted: fetch failed",
      providerKey: "topaz_transparency_upscale",
      providerRequestId: "019ff909-already-submitted",
    });

    const view = await conversationService.getFinalizationStatus(projectId);
    assert.deepEqual(view, { status: "retryable_failure" });
    const snapshot = await conversationService.getConversation(projectId);
    assert.equal(snapshot?.finalization.status, "retryable_failure");
    const serialized = JSON.stringify(view) + JSON.stringify(snapshot?.finalization);
    assert.equal(serialized.includes("fetch failed"), false);
    assert.equal(serialized.includes("topaz"), false);
    assert.equal(serialized.includes(job.id), false);
    assert.equal(serialized.includes("019ff909-already-submitted"), false);
    assert.equal(serialized.includes("lastError"), false);
  });

  it("retryable_failure reuses Prepare and preserves job identity + providerRequestId", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { repo, job } = await currentGeneratedJob(projectId);
    await repo.updateFinalArtworkJob(job.id, {
      status: "failed",
      lastError: "Production asset could not be persisted: fetch failed",
      providerKey: "topaz_transparency_upscale",
      providerRequestId: "already-submitted-id",
    });

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "retryable_failure",
    });

    await conversationService.approveFinalDirection(projectId, artworkVersionId);

    const revived = await repo.getFinalArtworkJob(job.id);
    assert.equal(revived?.id, job.id);
    assert.equal(revived?.status, "queued");
    assert.equal(revived?.providerRequestId, "already-submitted-id");
    assert.equal(revived?.providerKey, "topaz_transparency_upscale");
    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("print_ready overrides a stale failed FinalArtworkJob", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { repo, job } = await currentGeneratedJob(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "failed", lastError: "stale" });
    await repo.setProjectStatus(projectId, "print_ready");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "print_ready",
    });
  });

  it("finalization_required remains needs_review even if a job is failed", async () => {
    const { projectId, artworkVersionId, conversationService } =
      await projectWithSelectedConcept();
    await conversationService.approveFinalDirection(projectId, artworkVersionId);
    const { repo, job } = await currentGeneratedJob(projectId);
    await repo.updateFinalArtworkJob(job.id, { status: "failed", lastError: "stale" });
    await repo.setProjectStatus(projectId, "finalization_required");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "needs_review",
    });
  });

  it("a newer running job overrides an older failed job on the same preparation", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const conversationService = await import("./conversation-service");
    const started = await conversationService.startConversation();
    const projectId = started.project.id;
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: "00000000-0000-0000-0000-000000000001",
      originalFilename: "logo.png",
      analysis: { widthPx: 1000, heightPx: 1000 },
    });
    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: null,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);
    await repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });

    const failed = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId: preparation.id,
      artworkVersionId: artwork!.id,
      productionWidthIn: 10.5,
      requestedProductionOutput: "production_png",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const running = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId: preparation.id,
      artworkVersionId: artwork!.id,
      productionWidthIn: 12,
      requestedProductionOutput: "production_png",
    });
    await repo.updateFinalArtworkJob(failed.id, { status: "failed", lastError: "old" });
    await repo.updateFinalArtworkJob(running.id, { status: "running" });
    await repo.setProjectStatus(projectId, "finalizing");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "preparing",
    });
  });

  it("prepared_upload finalizing + failed reports retryable_failure", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const conversationService = await import("./conversation-service");
    const started = await conversationService.startConversation();
    const projectId = started.project.id;
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: "00000000-0000-0000-0000-000000000002",
      originalFilename: "logo.png",
      analysis: { widthPx: 1000, heightPx: 1000 },
    });
    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
      },
    ]);
    await repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    const job = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId: preparation.id,
      artworkVersionId: artwork!.id,
      productionWidthIn: 10.5,
      requestedProductionOutput: "production_png",
    });
    await repo.updateFinalArtworkJob(job.id, {
      status: "failed",
      lastError: "Production asset could not be persisted: fetch failed",
    });
    await repo.setProjectStatus(projectId, "finalizing");

    assert.deepEqual(await conversationService.getFinalizationStatus(projectId), {
      status: "retryable_failure",
    });
  });
});

describe("toCustomerFinalizationView", () => {
  it("derives customer status from project status and the current job", async () => {
    const { toCustomerFinalizationView } = await import("./conversation-service");

    assert.deepEqual(toCustomerFinalizationView("finalizing", "queued"), {
      status: "preparing",
    });
    assert.deepEqual(toCustomerFinalizationView("finalizing", "running"), {
      status: "preparing",
    });
    assert.deepEqual(toCustomerFinalizationView("finalizing", "recoverable"), {
      status: "preparing",
    });
    // Sprint A2 Correction 2 (Goal 19): a cancelled/superseded job used to
    // read as "preparing" forever — nothing was going to move it, so the
    // customer polled an animation that never resolved. It now reads as
    // "not requested", which restores the Prepare action they need.
    assert.deepEqual(toCustomerFinalizationView("finalizing", "cancelled"), {
      status: "not_requested",
    });
    assert.deepEqual(toCustomerFinalizationView("finalizing", null), {
      status: "preparing",
    });
    assert.deepEqual(toCustomerFinalizationView("finalizing", "failed"), {
      status: "retryable_failure",
    });
    assert.deepEqual(toCustomerFinalizationView("print_ready", "failed"), {
      status: "print_ready",
    });
    assert.deepEqual(
      toCustomerFinalizationView("finalization_required", "failed"),
      { status: "needs_review" },
    );
    assert.deepEqual(toCustomerFinalizationView("approved", "failed"), {
      status: "not_requested",
    });
  });
});
