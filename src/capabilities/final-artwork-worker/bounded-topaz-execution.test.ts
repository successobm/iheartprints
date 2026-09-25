import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkSchedulerCapability } from "@/capabilities/worker-scheduler";
import {
  createFinalArtworkWorkerCapability,
  MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
} from "./final-artwork-worker-capability";

/**
 * Bounded FinalArtwork Production-Execution Repair: end-to-end, through the
 * REAL worker pipeline, proving the single-pass bounded state machine
 * (`TopazTransparencyUpscaleProvider.produceBounded`, wired in via
 * `produceProductionAsset`'s preference for it over the blocking
 * `produce()`). This is the architectural fix the DTF-R1 pre-implementation
 * audit called for: no single worker invocation may block through a
 * multi-minute Topaz poll — every invocation does at most one submit and
 * one status check before returning.
 *
 * Mirrors `topaz-download-resume-recovery.test.ts`'s own fixture
 * construction (an approved `prepared_upload` artwork, directly built) --
 * deliberately duplicated locally rather than imported, matching this
 * codebase's established per-file fixture convention.
 *
 * NO REAL NETWORK: every `fetchImpl` here only ever answers its own three
 * known fake Topaz endpoints and throws on anything else.
 */

const CANVAS_PX = 1200;

function preparedTransparentPngOfWidth(artworkWidthPx: number): Buffer {
  const png = new PNG({ width: CANVAS_PX, height: CANVAS_PX });
  const inset = Math.floor((CANVAS_PX - artworkWidthPx) / 2);
  for (let y = 0; y < CANVAS_PX; y += 1) {
    for (let x = 0; x < CANVAS_PX; x += 1) {
      const idx = (CANVAS_PX * y + x) << 2;
      const inArtwork = x >= inset && x < inset + artworkWidthPx && y >= inset && y < inset + artworkWidthPx;
      png.data[idx] = 10;
      png.data[idx + 1] = 90;
      png.data[idx + 2] = 200;
      png.data[idx + 3] = inArtwork ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function expectedReconstructionRequest(artworkWidthPx: number) {
  const png = PNG.sync.read(preparedTransparentPngOfWidth(artworkWidthPx));
  const outcome = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    PRINT_PLACEMENT_SIZING_POLICY.sleeve,
  );
  if (outcome.status !== "resolved") throw new Error(`fixture is not reconstructible: ${outcome.status}`);
  return outcome.request;
}

const FIXED_PROCESS_ID = "01a0d701-bounded-test-process-id";

/**
 * A fake Topaz endpoint set whose STATUS response can be reconfigured
 * between `processNextJob()` calls -- modeling "still processing" (bounded
 * pending return) followed by "now complete" (a later invocation finishes
 * it), without ever changing what `/tool/async` does (always the SAME
 * fixed process id, so a second call to it is trivially detectable as a
 * real defect -- i.e. a duplicate paid submission).
 */
function buildControllableStatusFakeTopazFetch(reconstructedWidthPx: number, reconstructedHeightPx: number) {
  let submitCount = 0;
  let statusCallCount = 0;
  let statusMode: "processing" | "completed" = "processing";

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/tool/async")) {
      submitCount += 1;
      return new Response(JSON.stringify({ process_id: FIXED_PROCESS_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/status/")) {
      statusCallCount += 1;
      return new Response(JSON.stringify({ status: statusMode === "completed" ? "Completed" : "Processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/download/")) {
      return new Response(JSON.stringify({ url: "https://cdn.example.com/bounded-output.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://cdn.example.com/bounded-output.png") {
      const png = new PNG({ width: reconstructedWidthPx, height: reconstructedHeightPx });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 10;
        png.data[i + 1] = 90;
        png.data[i + 2] = 200;
        png.data[i + 3] = 255;
      }
      return new Response(new Uint8Array(PNG.sync.write(png)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
  }) as typeof fetch;

  return {
    fetchImpl: impl,
    submitCount: () => submitCount,
    statusCallCount: () => statusCallCount,
    setStatusMode: (mode: typeof statusMode) => {
      statusMode = mode;
    },
  };
}

describe("Bounded FinalArtwork Production-Execution Repair -- end-to-end through the real worker", () => {
  let tempDir = "";
  let previousCwd = "";

  // A FRESH temp workspace per test, not per describe: `LocalProjectRepository`
  // persists to one shared JSON file keyed off cwd, and several tests here
  // deliberately leave a job "recoverable" (still pending) as their own
  // final assertion — sharing one store across tests would let an OLDER
  // test's leftover recoverable job get claimed first by a LATER test's
  // own `processNextJob()` call (claim order is oldest-`created_at`-first),
  // silently processing the wrong job entirely.
  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bounded-topaz-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function setup(artworkWidthPx: number) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());

    const { createAcquisitionCapability } = await import("@/capabilities/acquisition");
    const acquisition = createAcquisitionCapability(repo);
    const session = await acquisition.resolveOrCreateSession(null);
    await acquisition.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      shirtColor: "Black",
      printPlacement: "sleeve",
    });

    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: preparedTransparentPngOfWidth(artworkWidthPx),
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "bounded-topaz-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "bounded-topaz-fixture.png",
      analysis: { widthPx: CANVAS_PX, heightPx: CANVAS_PX },
    });
    const preparedBytes = preparedTransparentPngOfWidth(artworkWidthPx);
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedBytes,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: true,
      kind: "png",
      metadata: { derivedFromAssetId: original.id },
    });
    await repo.updateArtworkPreparation(preparation.id, {
      status: "prepared",
      preparedAssetId: prepared.id,
      preparation: { backgroundRemoved: true },
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
        primaryAssetId: prepared.id,
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
    await repo.setProjectStatus(projectId, "approved");
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 3 });

    return { repo, assets, projectId };
  }

  it("1: a fresh submission still processing returns the job to recoverable -- bounded, no production asset, project stays finalizing", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, statusCallCount } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    // statusMode defaults to "processing" -- never flips to "completed" in this test.

    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    const startedAt = Date.now();
    await worker.processNextJob();
    const elapsedMs = Date.now() - startedAt;

    // The whole point of the repair: this invocation must be FAST, never a
    // multi-minute block, regardless of how long the real Topaz job would
    // legitimately take.
    assert.ok(elapsedMs < 5000, `a bounded invocation must return quickly, took ${elapsedMs}ms`);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable", "pending must return the job to recoverable, not leave it running or fail it");
    assert.equal(job?.providerKey, "topaz_transparency_upscale");
    assert.equal(job?.providerRequestId, FIXED_PROCESS_ID, "the paid request id must already be durably persisted");
    assert.equal(job?.providerStatus, "submitted");
    assert.ok(job?.heartbeatAt, "heartbeat must be fresh so the job is not mistaken for abandoned");
    assert.equal(job?.completedAt, null);
    assert.equal(submitCount(), 1, "exactly one paid submission");
    assert.equal(statusCallCount(), 1, "exactly one status check -- never a poll loop");

    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "finalizing", "must never reach print_ready or finalization_required while pending");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
    assert.equal(validation, null, "PrintValidation must never run while the provider job is still pending");
  });

  it("2: a later invocation that finds the same provider request now complete finishes the job -- zero duplicate submissions, real print validation", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setStatusMode } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );

    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();
    const pending = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(pending?.status, "recoverable");

    // The provider job has since finished on Topaz's own side.
    setStatusMode("completed");

    // A second invocation (an immediate wake, or the recovery scheduler)
    // reclaims the SAME job -- `claimNextQueuedFinalArtworkJob` claims
    // `recoverable` rows immediately, no 15-minute wait required.
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerRequestId, FIXED_PROCESS_ID, "still keyed to the ORIGINAL paid request");
    assert.equal(submitCount(), 1, "exactly one paid submission across BOTH invocations -- resumed, never resubmitted");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "a resumed-and-completed reconstruction must still proceed through real print validation");

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "finalizing", "project must have advanced once validation ran");
  });

  it("3: several pending checks across multiple invocations eventually complete without ever duplicating the paid submission", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, statusCallCount, setStatusMode } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );

    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    // Three invocations while still processing -- each one bounded, each a
    // distinct claim (claimNextQueuedFinalArtworkJob reclaims "recoverable"
    // rows immediately), never resubmitting.
    await worker.processNextJob();
    await worker.processNextJob();
    await worker.processNextJob();
    let job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");
    assert.equal(submitCount(), 1, "still exactly one submission after three pending checks");
    assert.equal(statusCallCount(), 3, "one status check per invocation");

    setStatusMode("completed");
    await worker.processNextJob();

    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
    assert.equal(submitCount(), 1, "still exactly one submission after four invocations total");
  });

  it("4: MANY pending checks across real scheduler batches never exhaust the recovery/attempt budgets or falsely fail the job (repair-cycle regression)", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setStatusMode } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );

    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);
    // The REAL scheduler layer, not raw `processNextJob()` calls -- this is
    // the shape production actually uses (an immediate wake or a GitHub
    // Actions tick calls `runBatch()`, which loops up to `maxJobsPerRun`
    // claims with no delay between them). An earlier version of this
    // repair returned a still-pending job straight to "recoverable" with
    // no budget accounting, which meant `runBatch()`'s own tight loop
    // could reclaim and charge the SAME still-processing job's recovery
    // budget up to `maxJobsPerRun` times in a single batch, and a couple of
    // batches were enough to exhaust `MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS`
    // and permanently, falsely fail a job that was never actually broken.
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 5 });

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    // Enough batches that, without the repair-cycle-1 budget refund, this
    // job's `providerRecoveryAttempts` would have been charged well past
    // `MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS` purely from benign pending
    // checks. (With the same-job-twice-in-a-row batch guard also added in
    // this repair cycle, each batch claims this lone stuck job at most
    // twice -- once fresh, then once more as a resume before the guard
    // stops the loop -- so 6 batches comfortably exceeds the ceiling of
    // `MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS` resume-classified claims on the
    // unfixed accounting.)
    for (let batch = 0; batch < 6; batch += 1) {
      await scheduler.runBatch();
    }

    let job = await repo.getFinalArtworkJob(requested.job.id);
    assert.notEqual(job?.status, "failed", "repeated benign pending checks must never falsely fail the job");
    assert.ok(
      job && ["recoverable", "running"].includes(job.status),
      `expected the job still active (recoverable/running), got "${job?.status}"`,
    );
    assert.ok(
      (job?.providerRecoveryAttempts ?? 0) < MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
      `providerRecoveryAttempts must stay below the ceiling for benign pending checks, got ${job?.providerRecoveryAttempts}`,
    );
    assert.equal(submitCount(), 1, "still exactly one paid submission after many pending batches");

    // The provider job finishes for real -- the SAME job must still be able
    // to complete normally, proving the budget was never actually spent.
    setStatusMode("completed");
    await scheduler.runBatch();

    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed", "the job must complete normally once the provider is actually done");
    assert.equal(submitCount(), 1, "completion must never have required a second paid submission");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
    assert.ok(validation, "a job recovered from many benign pending checks must still reach real print validation");
  });
});
