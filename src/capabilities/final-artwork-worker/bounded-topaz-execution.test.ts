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

/**
 * Bounded FinalArtwork Production-Execution Repair (liveness): a fake
 * Topaz endpoint set that assigns a FRESH process id per submission
 * (rather than one fixed id for the whole test), with independently
 * controllable per-process status -- defaulting to permanently
 * "Processing" unless explicitly marked "Completed". Models two or more
 * DIFFERENT jobs' provider requests in flight at once, which
 * `buildControllableStatusFakeTopazFetch`'s single fixed id cannot.
 */
function buildMultiRequestFakeTopazFetch(reconstructedWidthPx: number, reconstructedHeightPx: number) {
  let nextProcessSeq = 0;
  const statusByProcessId = new Map<string, "processing" | "completed">();
  const submitCountByProcessId = new Map<string, number>();
  const statusCallCountByProcessId = new Map<string, number>();

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/tool/async")) {
      nextProcessSeq += 1;
      const processId = `multi-process-${nextProcessSeq}`;
      submitCountByProcessId.set(processId, (submitCountByProcessId.get(processId) ?? 0) + 1);
      statusByProcessId.set(processId, "processing");
      return new Response(JSON.stringify({ process_id: processId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/status/")) {
      const processId = url.split("/status/")[1]!;
      statusCallCountByProcessId.set(processId, (statusCallCountByProcessId.get(processId) ?? 0) + 1);
      const mode = statusByProcessId.get(processId) ?? "processing";
      return new Response(JSON.stringify({ status: mode === "completed" ? "Completed" : "Processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/download/")) {
      const processId = url.split("/download/")[1]!;
      return new Response(JSON.stringify({ url: `https://cdn.example.com/bounded-output-${processId}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://cdn.example.com/bounded-output-")) {
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
    submitCountTotal: () => [...submitCountByProcessId.values()].reduce((a, b) => a + b, 0),
    statusCallCountFor: (processId: string) => statusCallCountByProcessId.get(processId) ?? 0,
    markCompleted: (processId: string) => {
      statusByProcessId.set(processId, "completed");
    },
    knownProcessIds: () => [...submitCountByProcessId.keys()],
  };
}

/**
 * Repair-cycle-2 regression (Fix A -- recovery-budget refund arithmetic):
 * an "echo back exactly what was requested" fake -- each submission's
 * `/download/` result is sized to EXACTLY the `output_width`/`output_height`
 * this exact submission asked for (read straight off the real `FormData`
 * `TopazTransparencyUpscaleProvider.submit()` builds, never a hand-computed
 * guess), so a genuine two-pass job's pass 1 and pass 2 requests are always
 * honored precisely regardless of the confirmed print size/source fixture
 * used to drive it through the real worker -- no risk of a validation
 * rejection from a hardcoded dimension drifting out of sync with the real
 * sizing policy's own arithmetic.
 *
 * `insetRatio` matters: a real reconstruction upscales proportionally, so
 * its visible-content-to-canvas ratio stays constant across passes. A
 * uniformly opaque fake output (visible content = the whole canvas) would
 * make every pass look immediately sufficient and never trigger pass 2 --
 * this fake instead reproduces the SAME centered-square-inset shape
 * `preparedTransparentPngOfWidth` uses, scaled to each requested canvas
 * size, so `resolveReconstructionRequest` measures the same relative
 * "still not enough" gap after pass 1 that a real reconstruction would.
 */
function buildEchoingFakeTopazFetch(insetRatio: number) {
  let nextProcessSeq = 0;
  const statusByProcessId = new Map<string, "processing" | "completed">();
  const dimsByProcessId = new Map<string, { widthPx: number; heightPx: number }>();
  const submitCountByProcessId = new Map<string, number>();

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/tool/async")) {
      const form = init?.body as FormData;
      const widthPx = Number(form.get("output_width"));
      const heightPx = Number(form.get("output_height"));
      nextProcessSeq += 1;
      const processId = `echo-process-${nextProcessSeq}`;
      submitCountByProcessId.set(processId, (submitCountByProcessId.get(processId) ?? 0) + 1);
      statusByProcessId.set(processId, "processing");
      dimsByProcessId.set(processId, { widthPx, heightPx });
      return new Response(JSON.stringify({ process_id: processId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/status/")) {
      const processId = url.split("/status/")[1]!;
      const mode = statusByProcessId.get(processId) ?? "processing";
      return new Response(JSON.stringify({ status: mode === "completed" ? "Completed" : "Processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/download/")) {
      const processId = url.split("/download/")[1]!;
      return new Response(JSON.stringify({ url: `https://cdn.example.com/echo-output-${processId}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://cdn.example.com/echo-output-")) {
      const processId = url.slice("https://cdn.example.com/echo-output-".length, -".png".length);
      const dims = dimsByProcessId.get(processId)!;
      const png = new PNG({ width: dims.widthPx, height: dims.heightPx });
      const visibleWidthPx = Math.round(dims.widthPx * insetRatio);
      const visibleHeightPx = Math.round(dims.heightPx * insetRatio);
      const insetX = Math.floor((dims.widthPx - visibleWidthPx) / 2);
      const insetY = Math.floor((dims.heightPx - visibleHeightPx) / 2);
      for (let y = 0; y < dims.heightPx; y += 1) {
        for (let x = 0; x < dims.widthPx; x += 1) {
          const idx = (dims.widthPx * y + x) << 2;
          const inArtwork =
            x >= insetX && x < insetX + visibleWidthPx && y >= insetY && y < insetY + visibleHeightPx;
          png.data[idx] = 10;
          png.data[idx + 1] = 90;
          png.data[idx + 2] = 200;
          png.data[idx + 3] = inArtwork ? 255 : 0;
        }
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
    submitCountTotal: () => [...submitCountByProcessId.values()].reduce((a, b) => a + b, 0),
    markCompleted: (processId: string) => {
      statusByProcessId.set(processId, "completed");
    },
    knownProcessIds: () => [...submitCountByProcessId.keys()],
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
    // `recoverable` rows immediately, no 15-minute wait required. Under the
    // Phase 2 post-provider checkpoint, THIS invocation acquires and
    // durably persists the production asset, then checkpoints back to
    // "recoverable" rather than also finalizing in the same call.
    await worker.processNextJob();
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable", "acquiring the provider result checkpoints, it does not finalize in the same call");

    // A third invocation finds the already-checkpointed asset and finalizes.
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerRequestId, FIXED_PROCESS_ID, "still keyed to the ORIGINAL paid request");
    assert.equal(submitCount(), 1, "exactly one paid submission across ALL THREE invocations -- resumed, never resubmitted");

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
    // Fourth invocation: acquires and checkpoints the production asset
    // (Phase 2 -- does not finalize in the same call).
    await worker.processNextJob();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");

    // Fifth invocation: finds the checkpointed asset and finalizes.
    await worker.processNextJob();

    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
    assert.equal(submitCount(), 1, "still exactly one submission after five invocations total");
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
    // First batch: acquires and checkpoints the production asset (Phase 2
    // -- the batch's own exclude-list guard means this same batch cannot
    // also reach the finalize step, since nothing else is queued).
    await scheduler.runBatch();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");

    // Second batch: finds the checkpointed asset and finalizes.
    await scheduler.runBatch();

    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed", "the job must complete normally once the provider is actually done");
    assert.equal(submitCount(), 1, "completion must never have required a second paid submission");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
    assert.ok(validation, "a job recovered from many benign pending checks must still reach real print validation");
  });

  it("5: an indefinitely-pending older job does not starve a newer, unrelated job within the same batch (liveness repair)", async () => {
    // Two independent projects, created in order -- `setup()` builds a
    // fresh `LocalProjectRepository()` each call, but both point at the
    // SAME shared store file for this test's one temp workspace, so a
    // single worker/scheduler sees both projects' jobs.
    const older = await setup(400);
    const newer = await setup(400);
    const { repo, assets } = newer;

    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCountTotal, statusCallCountFor, markCompleted, knownProcessIds } =
      buildMultiRequestFakeTopazFetch(expectedRequest.widthPx, expectedRequest.heightPx);

    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 5 });

    // The OLDER job -- its provider request will be marked "Processing"
    // forever in this test, modeling an indefinitely-pending Topaz job.
    const olderRequested = await finalArtwork.requestPreparedUploadFinalArtwork(older.projectId);
    // The NEWER job -- created after, so it is never the "oldest due" row.
    const newerRequested = await finalArtwork.requestPreparedUploadFinalArtwork(newer.projectId);

    // First batch: claims and submits the older job (fresh, iteration 1),
    // reclaims it once more as a resume check (iteration 2, still
    // pending) -- WITHOUT the liveness repair, the batch would stop there
    // (or keep re-claiming the same stuck job) and never reach the newer
    // one at all within this batch.
    await scheduler.runBatch();

    const olderAfterBatch1 = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderAfterBatch1?.status, "recoverable", "the indefinitely-pending job stays recoverable, never failed");

    const newerAfterBatch1 = await repo.getFinalArtworkJob(newerRequested.job.id);
    assert.notEqual(
      newerAfterBatch1?.status,
      "queued",
      "the newer job must have been claimed and progressed within the SAME batch, not left untouched behind the stuck older job",
    );

    // The newer job's own provider request completes quickly.
    assert.equal(knownProcessIds().length, 2, "both jobs must have reached a real, distinct provider submission");
    const newerProcessId = knownProcessIds()[1]!;
    markCompleted(newerProcessId);

    // A second batch lets the newer job's own already-submitted request
    // resolve -- within this same batch the older job is reclaimed first
    // (still stuck), then the newer job is reclaimed and reaches the
    // Phase 2 checkpoint (asset acquired, but not yet finalized), while
    // the older one is STILL never marked completed -- proving the older
    // job's indefinite pendingness never blocked the newer one's progress.
    await scheduler.runBatch();

    const newerAfterBatch2 = await repo.getFinalArtworkJob(newerRequested.job.id);
    assert.equal(newerAfterBatch2?.status, "recoverable", "the newer job reaches the checkpoint within batch 2");

    const olderAfterBatch2 = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderAfterBatch2?.status, "recoverable", "the older job remains legitimately pending, not failed or abandoned");

    // A third batch finalizes the newer job from its already-checkpointed
    // production asset.
    await scheduler.runBatch();

    const newerAfterBatch3 = await repo.getFinalArtworkJob(newerRequested.job.id);
    assert.equal(newerAfterBatch3?.status, "completed", "the newer job must reach completion despite the older one remaining stuck");

    const olderAfterBatch3 = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderAfterBatch3?.status, "recoverable", "the older job remains legitimately pending, not failed or abandoned");

    assert.equal(submitCountTotal(), 2, "exactly one submission per job across the whole test -- never resubmitted");
    assert.ok(statusCallCountFor(newerProcessId) >= 1, "the newer job's request was genuinely checked");

    const validation = await repo.getLatestProductionAssetValidationForJob(
      newer.projectId,
      newerAfterBatch3!.id,
    );
    assert.ok(validation, "the newer job must still reach real print validation");
  });

  it("6: two-pass pass-1(resume)->pass-2(fresh-submit) transition starts the new request's recovery budget at exactly 0, even with retained genuine-failure charges beforehand (repair-cycle-2 arithmetic regression)", async () => {
    // A small inset relative to the 1200x1200 canvas against sleeve sizing
    // (3in @ 300 PPI = 900px target) empirically routes through two-pass
    // (planStandardRasterReconstruction: pass 1 at the 4x ceiling against
    // the source's full 1200x1200 frame, still short of 900px against a
    // 150px visible inset once accounting for its own alpha-trim margin).
    const artworkWidthPx = 150;
    const { repo, assets, projectId } = await setup(artworkWidthPx);

    const { fetchImpl, submitCountTotal, markCompleted, knownProcessIds } = buildEchoingFakeTopazFetch(
      artworkWidthPx / CANVAS_PX,
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

    // Claim 1: fresh execution -- submits PASS 1 and checks it once (still
    // "processing" by construction), returns pending. Confirms the fixture
    // genuinely routes through two-pass (a single "echo-process-*" id is
    // submitted for pass 1 only at this point).
    await worker.processNextJob();
    assert.equal(knownProcessIds().length, 1, "pass 1 must be the only submission so far");
    const pass1Id = knownProcessIds()[0]!;

    // Simulate two RETAINED genuine-failure charges already accumulated
    // against this exact pass-1 request from earlier real worker crashes
    // (mid-resume process deaths -- never reaching the benign-pending
    // refund line at all) -- the exact precondition reviewer 2 identified
    // as missing coverage. Seeded directly rather than replaying two real
    // crashes, which this fixture cannot otherwise simulate.
    await repo.updateFinalArtworkJob(requested.job.id, { providerRecoveryAttempts: 2 });

    // Pass 1 has genuinely finished at the (fake) provider.
    markCompleted(pass1Id);

    // Claim 2: RESUMES pass 1 (existingProviderRequest matches, so
    // attemptClassification is fixed as "resume" for this whole claim,
    // charging providerRecoveryAttempts 2->3 up front) -- pass 1's status
    // check finds it Completed, downloads it, and the SAME invocation
    // immediately submits a genuinely NEW pass-2 request (submittedNewPaidRequest
    // becomes true mid-claim), whose own onProviderRequestSubmitted hook
    // resets providerRecoveryAttempts to 0. Pass 2's own status check
    // (still "processing") returns the overall claim as pending.
    await worker.processNextJob();

    assert.equal(knownProcessIds().length, 2, "pass 2 must now have been submitted");
    const pass2Id = knownProcessIds()[1]!;
    assert.notEqual(pass2Id, pass1Id);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");
    assert.equal(job?.providerRequestId, pass2Id, "the job must now be keyed to pass 2's fresh request");
    // THE regression: without the repair-cycle-2 fix, this would read 2
    // (the stale pre-submission recovery snapshot, 3, refunded by 1) --
    // never the fresh reset's true value.
    assert.equal(
      job?.providerRecoveryAttempts,
      0,
      "pass 2's brand-new paid request must start its recovery budget at exactly 0, " +
        "never clobbered by refunding the OLD (pass 1) request's retained charges",
    );
    assert.equal(submitCountTotal(), 2, "exactly one submission per pass -- pass 1 resumed, never resubmitted");

    // The job must still be able to complete normally afterward, proving
    // the fix didn't just move the bug rather than eliminate it.
    markCompleted(pass2Id);
    await worker.processNextJob();
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable", "pass 2's completion first reaches the Phase 2 checkpoint");

    await worker.processNextJob();
    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(submitCountTotal(), 2, "completion must never require a third submission");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "a two-pass job recovered through this exact transition must still reach real print validation");
  });

  // --- Phase 2: post-provider durable checkpoint ---------------------------

  it("7: provider completion checkpoints the production asset and returns pending WITHOUT running validation/completion in the same invocation", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setStatusMode } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    // The provider is already "Completed" the instant it's asked -- proves
    // the checkpoint fires even on the very first status check, not only
    // after several pending polls.
    setStatusMode("completed");

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
    const before = await repo.getFinalArtworkJob(requested.job.id);

    await worker.processNextJob();

    const afterCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterCheckpoint?.status, "recoverable", "checkpointed, not left running and not completed");
    assert.equal(submitCount(), 1, "exactly one submission");

    const assetsAfterCheckpoint = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    const productionAssets = assetsAfterCheckpoint.filter((a) => a.productionRole === "production_png");
    assert.equal(productionAssets.length, 1, "the production asset must already be durably persisted at checkpoint time");

    const validationAfterCheckpoint = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
    assert.equal(validationAfterCheckpoint, null, "validation must NOT run in the same invocation as the checkpoint");

    const projectAfterCheckpoint = await repo.getProject(projectId);
    assert.equal(projectAfterCheckpoint?.project.status, "finalizing", "project must not transition in the checkpointing invocation");

    // This claim was fresh_execution (no prior provider request), so the
    // recovery budget was never charged in the first place -- confirm
    // nothing regressed it.
    assert.equal(afterCheckpoint?.providerRecoveryAttempts, before?.providerRecoveryAttempts ?? 0);

    // A second invocation resumes from the checkpointed asset and finishes.
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(submitCount(), 1, "still exactly one submission after the finalize invocation");

    const finalAssets = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    assert.equal(
      finalAssets.filter((a) => a.productionRole === "production_png").length,
      1,
      "the finalize invocation must reuse the checkpointed asset, never create a second one",
    );

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
    assert.ok(validation, "the finalize invocation must run real PrintValidation");

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "finalizing", "project must transition once validation actually ran");
  });

  it("8: reaching the checkpoint after RESUMING an existing provider request neutralizes that claim's recovery charge (the exact real-incident shape)", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setStatusMode } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    // Still processing on the first (fresh) claim -- checkpoints to pending
    // with a real persisted providerRequestId, exactly like the live
    // incident this repair addresses.

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

    // Claim 1: fresh submission, still processing -- pending.
    await worker.processNextJob();
    const afterFresh = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterFresh?.status, "recoverable");
    assert.equal(afterFresh?.providerRequestId, FIXED_PROCESS_ID);

    // Now it's genuinely done at the (fake) provider.
    setStatusMode("completed");

    // Claim 2: RESUMES the persisted request (classification = "resume",
    // charging providerRecoveryAttempts before the resume is attempted),
    // finds it Completed, uploads the production asset, and checkpoints.
    await worker.processNextJob();

    const afterCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterCheckpoint?.status, "recoverable");
    assert.equal(afterCheckpoint?.providerRequestId, FIXED_PROCESS_ID, "still the SAME request -- never resubmitted");
    assert.equal(submitCount(), 1, "exactly one submission across both claims");
    // THE regression this test guards: reaching the checkpoint after a
    // resume must neutralize (refund) that claim's recovery charge --
    // without this, a healthy job could be charged toward
    // MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS purely for needing a second
    // invocation to acquire an already-completed provider result.
    assert.equal(
      afterCheckpoint?.providerRecoveryAttempts,
      0,
      "the resume claim's recovery charge must be neutralized once it reaches the durable checkpoint",
    );

    const productionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1);

    // Finalize.
    await worker.processNextJob();
    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(submitCount(), 1, "completion never required a second submission");
  });

  it("9: a job stuck running with an already-checkpointed production asset (simulating an interruption anywhere during finalize) safely reconciles to completed and print-ready via ordinary reclaim -- no special-casing, no manual DB edit", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setStatusMode } = buildControllableStatusFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    setStatusMode("completed");

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

    // Reach the checkpoint (production asset durably exists; job "recoverable").
    await worker.processNextJob();
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable");

    // Simulate a real invocation that claimed the job (running, fresh
    // heartbeat) and was interrupted SOMEWHERE during finalize -- before
    // this repair's reordering, the riskiest such window was "after
    // completed, before project transition"; generically, ANY interruption
    // during finalize leaves the job "running" with a stale heartbeat and
    // the asset already durable, which is what we reproduce directly here
    // rather than depending on timing to land in one exact sub-window.
    await repo.updateFinalArtworkJob(checkpointed!.id, {
      status: "running",
      heartbeatAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });

    // Ordinary recovery: the stale sweep reclaims it, and because the
    // production asset already exists, the very next claim routes straight
    // to finalize (no re-acquisition, no re-submission).
    await worker.recoverAbandonedJobs();
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed", "reconciled to completed via ordinary reclaim, no manual edit");
    assert.equal(submitCount(), 1, "reconciliation must never resubmit to the provider");

    const productionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(productionAssets.length, 1, "reconciliation must never create a second production asset");

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "finalizing", "the project must reach its correct terminal validation status");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "reconciliation must still run authoritative PrintValidation");
  });
});
