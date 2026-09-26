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
  isProviderResultIntermediateAsset,
  isReconstructionIntermediateAsset,
} from "@/capabilities/final-artwork/production-request-identity";
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

    // Bounded FinalArtwork Production-Execution Repair (short-step
    // follow-up): a claim that finds the provider now `Completed` durably
    // checkpoints `providerStatus: "result_ready"` and defers -- it must
    // never fall through into downloading within this same invocation.
    await worker.processNextJob();
    const resultReady = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(resultReady?.status, "recoverable");
    assert.equal(resultReady?.providerStatus, "result_ready", "the status-check step durably checkpoints completion before ever downloading");
    assert.equal(submitCount(), 1, "still no re-submission merely from checking status");

    // A later invocation downloads the (already-confirmed-complete) result
    // and persists it as an internal intermediate -- still not the final
    // production asset, and still not finalized. The paid request's
    // identity is kept intact (never cleared) -- this is the LAST pass, so
    // there is no further submission to make room for.
    await worker.processNextJob();
    const downloaded = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(downloaded?.status, "recoverable");
    assert.equal(downloaded?.providerRequestId, FIXED_PROCESS_ID, "the download checkpoint keeps the paid request's identity intact");
    const afterDownloadAssets = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    assert.equal(
      afterDownloadAssets.filter((a) => a.productionRole === "production_png").length,
      1,
      "the downloaded raw result is persisted (as an internal intermediate), but is never a candidate final production asset",
    );

    // A later invocation normalizes/measures/uploads the production asset
    // from that intermediate and checkpoints -- it does not finalize in the
    // same call (Phase 2's own invariant, now one step further downstream).
    await worker.processNextJob();
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable", "acquiring the provider result checkpoints, it does not finalize in the same call");

    // A final invocation finds the already-checkpointed asset and finalizes.
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerRequestId, FIXED_PROCESS_ID, "still keyed to the ORIGINAL paid request, all the way through finalization");
    assert.equal(submitCount(), 1, "exactly one paid submission across every invocation -- resumed, never resubmitted");

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
    // Fourth invocation: status check finds "Completed" -> checkpoints
    // `providerStatus: "result_ready"` (never downloads in this call).
    await worker.processNextJob();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");
    assert.equal(job?.providerStatus, "result_ready");

    // Fifth invocation: downloads the result and persists the internal
    // intermediate (never normalizes in this call).
    await worker.processNextJob();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");

    // Sixth invocation: normalizes/uploads the production asset and
    // checkpoints (Phase 2 -- does not finalize in the same call).
    await worker.processNextJob();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");

    // Seventh invocation: finds the checkpointed asset and finalizes.
    await worker.processNextJob();

    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
    assert.equal(submitCount(), 1, "still exactly one submission after seven invocations total");
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
    // Actions tick calls `runBatch()`, which — since the One-Job-Per-
    // Invocation Repair — claims and advances AT MOST ONE job per call, no
    // loop). An earlier version of this repair returned a still-pending job
    // straight to "recoverable" with no budget accounting at all, which
    // meant repeated benign pending checks across many separate batches
    // could still charge the SAME still-processing job's recovery budget
    // every single time, and enough batches were enough to exhaust
    // `MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS` and permanently, falsely fail a
    // job that was never actually broken.
    const scheduler = createFinalArtworkSchedulerCapability(worker);

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
    // First batch: status check finds "Completed" -> checkpoints
    // `providerStatus: "result_ready"` (one job, one bounded step, per the
    // One-Job-Per-Invocation Repair).
    await scheduler.runBatch();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");
    assert.equal(job?.providerStatus, "result_ready");

    // Second batch: downloads the result and persists the internal
    // intermediate.
    await scheduler.runBatch();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");

    // Third batch: normalizes/uploads the production asset and checkpoints
    // (Phase 2 -- does not finalize in the same batch).
    await scheduler.runBatch();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable");

    // Fourth batch: finds the checkpointed asset and finalizes.
    await scheduler.runBatch();

    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed", "the job must complete normally once the provider is actually done");
    assert.equal(submitCount(), 1, "completion must never have required a second paid submission");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
    assert.ok(validation, "a job recovered from many benign pending checks must still reach real print validation");
  });

  it("5: two independent jobs each advance correctly across separate, one-job-per-invocation scheduler batches, oldest-due first, until each reaches print-ready (One-Job-Per-Invocation Repair)", async () => {
    // Two independent projects, created in order -- `setup()` builds a
    // fresh `LocalProjectRepository()` each call, but both point at the
    // SAME shared store file for this test's one temp workspace, so a
    // single worker/scheduler sees both projects' jobs.
    //
    // Bounded FinalArtwork Production-Execution Repair (One-Job-Per-
    // Invocation Repair): this test previously modeled an OLDER job whose
    // provider request stayed "Processing" forever, proving a since-removed
    // within-batch exclude-list kept it from starving a newer job. That
    // exclude-list mechanism only ever mattered when ONE HTTP invocation
    // could claim MULTIPLE different jobs — the independent-review finding
    // this repair-cycle closes is exactly that capability itself: `runBatch()`
    // now structurally claims and advances AT MOST ONE job per call (see
    // `final-artwork-scheduler-capability.ts`'s own doc comment), so an
    // invocation never has a "second slot" to reach a newer job with in the
    // first place — every job's own turn now comes from a SEPARATE
    // invocation instead. `claimNextQueuedFinalArtworkJob` claims the
    // oldest-due `queued`/`recoverable` row, so a job that stayed
    // "recoverable" FOREVER (genuinely, permanently stuck at the provider —
    // the pre-existing, deliberately-still-open "what happens to a Topaz
    // request that never reaches Completed/Failed/Cancelled" question this
    // repair does not answer) would now starve every newer job behind it —
    // a real, accepted trade-off of removing the exclude-list workaround,
    // not something this repair set out to solve. What THIS test proves
    // instead is the ordinary, expected case: an older job that is merely
    // taking a normal number of bounded steps (never indefinitely stuck)
    // still lets a newer job take its own turn on ITS OWN separate
    // invocations, interleaved in oldest-due order, with neither job ever
    // starving the other or duplicating any submission.
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
    const scheduler = createFinalArtworkSchedulerCapability(worker);

    // The OLDER job -- created first, so it is always "oldest due" and
    // wins every claim until it reaches a terminal status.
    const olderRequested = await finalArtwork.requestPreparedUploadFinalArtwork(older.projectId);
    // The NEWER job -- created after, so it is never claimed while the
    // older one remains queued/recoverable.
    const newerRequested = await finalArtwork.requestPreparedUploadFinalArtwork(newer.projectId);

    // Invocation 1: claims and submits the OLDER job (fresh submit + status
    // check, still "processing" by construction) -- the newer job is not
    // even looked at yet; it is not "oldest due".
    await scheduler.runBatch();
    const olderAfterInvocation1 = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderAfterInvocation1?.status, "recoverable");
    const newerAfterInvocation1 = await repo.getFinalArtworkJob(newerRequested.job.id);
    assert.equal(newerAfterInvocation1?.status, "queued", "the newer job is untouched while the older one remains the oldest-due claimable row");
    assert.equal(knownProcessIds().length, 1, "only the older job has reached a real provider submission so far");

    // The older job's OWN provider request completes.
    const olderProcessId = knownProcessIds()[0]!;
    markCompleted(olderProcessId);

    // Invocation 2: resumes the older job -- status check finds "Completed",
    // checkpoints `providerStatus: "result_ready"`. Still the oldest-due
    // row (recoverable, created first), so the newer job still waits.
    await scheduler.runBatch();
    const olderAfterInvocation2 = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderAfterInvocation2?.providerStatus, "result_ready");
    assert.equal((await repo.getFinalArtworkJob(newerRequested.job.id))?.status, "queued");

    // Invocation 3: downloads the older job's result, persists the internal
    // intermediate.
    await scheduler.runBatch();
    assert.equal((await repo.getFinalArtworkJob(newerRequested.job.id))?.status, "queued");

    // Invocation 4: normalizes/uploads the older job's production asset and
    // checkpoints (still not finalized).
    await scheduler.runBatch();
    assert.equal((await repo.getFinalArtworkJob(newerRequested.job.id))?.status, "queued");

    // Invocation 5: finalizes the older job -- it is now `"completed"`, no
    // longer queued/recoverable, so it stops being "oldest due" at all.
    await scheduler.runBatch();
    const olderCompleted = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderCompleted?.status, "completed");

    // Invocation 6: the newer job is FINALLY the oldest-due claimable row --
    // claims and submits it (fresh submit + status check, still
    // "processing" by construction).
    await scheduler.runBatch();
    const newerAfterInvocation6 = await repo.getFinalArtworkJob(newerRequested.job.id);
    assert.equal(newerAfterInvocation6?.status, "recoverable");
    assert.equal(knownProcessIds().length, 2, "the newer job now has its OWN, distinct, real provider submission");
    const newerProcessId = knownProcessIds()[1]!;
    assert.notEqual(newerProcessId, olderProcessId);
    markCompleted(newerProcessId);

    // Invocations 7-9: the newer job advances through the SAME
    // status -> download -> normalize/upload -> finalize sequence.
    await scheduler.runBatch(); // status -> result_ready checkpoint
    assert.equal((await repo.getFinalArtworkJob(newerRequested.job.id))?.providerStatus, "result_ready");
    await scheduler.runBatch(); // download -> intermediate checkpoint
    await scheduler.runBatch(); // normalize/upload -> production-asset checkpoint
    await scheduler.runBatch(); // finalize

    const newerCompleted = await repo.getFinalArtworkJob(newerRequested.job.id);
    assert.equal(newerCompleted?.status, "completed", "the newer job reaches completion once it is finally its turn");

    const olderStillCompleted = await repo.getFinalArtworkJob(olderRequested.job.id);
    assert.equal(olderStillCompleted?.status, "completed", "the older job's own completion is untouched by the newer job's later progress");

    assert.equal(submitCountTotal(), 2, "exactly one submission per job across the whole test -- never resubmitted, never duplicated");
    assert.ok(statusCallCountFor(newerProcessId) >= 1, "the newer job's request was genuinely checked");

    const validation = await repo.getLatestProductionAssetValidationForJob(
      newer.projectId,
      newerCompleted!.id,
    );
    assert.ok(validation, "the newer job must still reach real print validation");
  });

  it("6: two-pass pass-1(resume)->pass-2(fresh-submit) transition starts the new request's recovery budget at exactly 0, even with retained genuine-failure charges beforehand (repair-cycle-2 arithmetic regression, now split across the status/download/pass-2-submit steps)", async () => {
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

    // Claim 2: RESUMES pass 1 (attemptClassification = "resume", charging
    // providerRecoveryAttempts 2->3 up front) -- pass 1's status check finds
    // it Completed, and durably checkpoints `providerStatus: "result_ready"`
    // for pass 1 -- never downloading in this same invocation. The charge
    // is neutralized (3->2) at this checkpoint, exactly like the
    // single-pass case.
    await worker.processNextJob();
    const afterPass1StatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterPass1StatusCheckpoint?.status, "recoverable");
    assert.equal(afterPass1StatusCheckpoint?.providerStatus, "result_ready");
    assert.equal(afterPass1StatusCheckpoint?.providerRecoveryAttempts, 2);
    assert.equal(knownProcessIds().length, 1, "still only pass 1 submitted -- a status check is never a dispatch");

    // Claim 3: RESUMES pass 1 again (a SECOND resume-classified claim,
    // charging 2->3 up front again) -- downloads pass 1's now-confirmed
    // result, decides LOCALLY that pass 2 is genuinely needed, and persists
    // pass 1 as the existing `pass1_intermediate` marker (clearing the
    // job's outstanding-request slot) -- still never submitting pass 2 in
    // this same invocation. The charge is neutralized again (3->2).
    await worker.processNextJob();
    const afterPass1Download = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterPass1Download?.status, "recoverable");
    assert.equal(afterPass1Download?.providerRecoveryAttempts, 2);
    assert.equal(afterPass1Download?.providerRequestId, null, "pass 1's identity is retired once its result is durably persisted, freeing the slot for pass 2");
    assert.equal(knownProcessIds().length, 1, "still only pass 1 submitted -- downloading an already-confirmed result is never a dispatch");
    const pass1IntermediateAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      isReconstructionIntermediateAsset,
    );
    assert.equal(pass1IntermediateAssets.length, 1, "pass 1's validated output is durably persisted as the two-pass intermediate");

    // Claim 4: now fresh_execution (pass 1's identity was already cleared) --
    // finds pass 1's persisted intermediate, computes pass 2's request
    // against pass 1's REAL output, and submits pass 2 (a genuinely NEW
    // paid request) + checks it once (still "processing" by construction).
    // `onProviderRequestSubmitted` resets providerRecoveryAttempts to 0 for
    // this brand-new request.
    await worker.processNextJob();

    assert.equal(knownProcessIds().length, 2, "pass 2 must now have been submitted");
    const pass2Id = knownProcessIds()[1]!;
    assert.notEqual(pass2Id, pass1Id);

    const afterPass2Submit = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterPass2Submit?.status, "recoverable");
    assert.equal(afterPass2Submit?.providerRequestId, pass2Id, "the job must now be keyed to pass 2's fresh request");
    // THE regression: without the repair-cycle-2 fix, this would read 2
    // (the stale pre-submission recovery snapshot, 3, refunded by 1) --
    // never the fresh reset's true value.
    assert.equal(
      afterPass2Submit?.providerRecoveryAttempts,
      0,
      "pass 2's brand-new paid request must start its recovery budget at exactly 0, " +
        "never clobbered by refunding the OLD (pass 1) request's retained charges",
    );
    assert.equal(submitCountTotal(), 2, "exactly one submission per pass -- pass 1 resumed, never resubmitted");

    // The job must still be able to complete normally afterward, proving
    // the fix didn't just move the bug rather than eliminate it.
    markCompleted(pass2Id);

    // Claim 5: RESUMES pass 2 -- status check finds it Completed, durably
    // checkpoints `providerStatus: "result_ready"` for pass 2.
    await worker.processNextJob();
    const afterPass2StatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterPass2StatusCheckpoint?.status, "recoverable");
    assert.equal(afterPass2StatusCheckpoint?.providerStatus, "result_ready");

    // Claim 6: RESUMES pass 2 again -- downloads it (pass 2 is always the
    // FINAL pass in this V1 two-pass architecture) and persists the result
    // as the internal "ready to normalize" intermediate.
    await worker.processNextJob();
    const afterPass2Download = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterPass2Download?.status, "recoverable");
    const providerResultIntermediates = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      isProviderResultIntermediateAsset,
    );
    assert.equal(providerResultIntermediates.length, 1);

    // Claim 7: normalizes/measures/uploads the production asset from that
    // intermediate and checkpoints -- pass 2's completion first reaches
    // this checkpoint, still not finalized in the same call.
    await worker.processNextJob();
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable", "pass 2's completion reaches the production-asset checkpoint before finalizing");

    // Claim 8: finalizes.
    await worker.processNextJob();
    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(submitCountTotal(), 2, "completion must never require a third submission");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "a two-pass job recovered through this exact transition must still reach real print validation");
  });

  // --- Phase 2: post-provider durable checkpoint ---------------------------

  it("7: provider completion checkpoints in three separate bounded steps (status, download, normalize/upload) and returns pending WITHOUT running validation/completion in any of them", async () => {
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

    // Step 1: submit + one status check -> already "Completed" -> durably
    // checkpoints `providerStatus: "result_ready"` and returns. Never
    // downloads in this same invocation.
    await worker.processNextJob();

    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable", "checkpointed, not left running and not completed");
    assert.equal(afterStatusCheckpoint?.providerStatus, "result_ready");
    assert.equal(submitCount(), 1, "exactly one submission");

    const assetsAfterStatusCheckpoint = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    assert.equal(assetsAfterStatusCheckpoint.length, 0, "no asset of any kind exists until the result is actually downloaded");

    // This claim was fresh_execution (no prior provider request), so the
    // recovery budget was never charged in the first place -- confirm
    // nothing regressed it.
    assert.equal(afterStatusCheckpoint?.providerRecoveryAttempts, before?.providerRecoveryAttempts ?? 0);

    // Step 2: download-only -> persists the internal, non-customer-facing
    // intermediate and returns. Never normalizes/measures/uploads the
    // production asset in this same invocation.
    await worker.processNextJob();

    const afterDownloadCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterDownloadCheckpoint?.status, "recoverable");
    const assetsAfterDownload = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    assert.equal(assetsAfterDownload.length, 1, "the downloaded result is now durably persisted, as an internal intermediate");
    assert.ok(isProviderResultIntermediateAsset(assetsAfterDownload[0]!), "the download checkpoint's asset is the internal intermediate marker, never the customer deliverable");

    const validationAfterDownload = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
    assert.equal(validationAfterDownload, null, "validation must NOT run merely because the raw result was downloaded");

    // Step 3: normalize/measure/upload the production asset from the
    // intermediate, then checkpoint -- still never validating/completing in
    // the same call.
    await worker.processNextJob();

    const afterAssetCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterAssetCheckpoint?.status, "recoverable", "checkpointed, not left running and not completed");

    const assetsAfterAssetCheckpoint = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    const productionAssets = assetsAfterAssetCheckpoint.filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(productionAssets.length, 1, "the FINAL production asset must already be durably persisted at checkpoint time");

    const validationAfterAssetCheckpoint = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
    assert.equal(validationAfterAssetCheckpoint, null, "validation must NOT run in the same invocation as the asset checkpoint");

    const projectAfterCheckpoint = await repo.getProject(projectId);
    assert.equal(projectAfterCheckpoint?.project.status, "finalizing", "project must not transition in any of the checkpointing invocations");

    // Step 4: a final invocation resumes from the checkpointed asset and finishes.
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(submitCount(), 1, "still exactly one submission after the finalize invocation");

    const finalAssets = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
    assert.equal(
      finalAssets.filter((a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a)).length,
      1,
      "the finalize invocation must reuse the checkpointed asset, never create a second one",
    );

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
    assert.ok(validation, "the finalize invocation must run real PrintValidation");

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "finalizing", "project must transition once validation actually ran");
  });

  it("8: reaching each checkpoint after RESUMING an existing provider request neutralizes that claim's own recovery charge (the exact real-incident shape, now split across the status and download steps)", async () => {
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

    // Claim 1: fresh submission, still processing -- pending. Fresh
    // execution, so no recovery charge yet.
    await worker.processNextJob();
    const afterFresh = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterFresh?.status, "recoverable");
    assert.equal(afterFresh?.providerRequestId, FIXED_PROCESS_ID);
    assert.equal(afterFresh?.providerRecoveryAttempts, 0);

    // Now it's genuinely done at the (fake) provider.
    setStatusMode("completed");

    // Claim 2: RESUMES the persisted request (classification = "resume",
    // charging providerRecoveryAttempts before the check is attempted),
    // finds it Completed, and durably checkpoints `providerStatus:
    // "result_ready"` -- never downloading in this same invocation.
    await worker.processNextJob();

    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable");
    assert.equal(afterStatusCheckpoint?.providerRequestId, FIXED_PROCESS_ID, "still the SAME request -- never resubmitted");
    assert.equal(afterStatusCheckpoint?.providerStatus, "result_ready");
    assert.equal(submitCount(), 1, "exactly one submission across every claim so far");
    // THE regression this test guards: reaching a durable checkpoint after
    // a resume must neutralize (refund) THAT claim's own recovery charge --
    // without this, a healthy job could be charged toward
    // MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS purely for needing another
    // invocation to advance an already-completed provider result one more
    // bounded step.
    assert.equal(
      afterStatusCheckpoint?.providerRecoveryAttempts,
      0,
      "the resume claim's recovery charge must be neutralized once it reaches the durable status checkpoint",
    );

    // Claim 3: RESUMES again (a SECOND resume-classified claim, since the
    // job still carries a matching providerKey/providerRequestId) -- this
    // time downloads the already-confirmed-complete result and persists it
    // as an internal intermediate, again neutralizing its own charge.
    await worker.processNextJob();

    const afterDownloadCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterDownloadCheckpoint?.status, "recoverable");
    assert.equal(
      afterDownloadCheckpoint?.providerRecoveryAttempts,
      0,
      "the second resume claim's own recovery charge must ALSO be neutralized once it reaches the download checkpoint",
    );
    const intermediateAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      isProviderResultIntermediateAsset,
    );
    assert.equal(intermediateAssets.length, 1);

    // Claim 4: finds the intermediate, normalizes/uploads the production
    // asset, and checkpoints -- this claim never touches the provider or
    // either attempt budget at all.
    await worker.processNextJob();
    const afterAssetCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterAssetCheckpoint?.status, "recoverable");

    const productionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
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

    // Reach the FINAL production-asset checkpoint -- now three bounded
    // steps (status -> download -> normalize/upload), each returning the
    // job to "recoverable".
    await worker.processNextJob(); // status check -> result_ready checkpoint
    await worker.processNextJob(); // download -> intermediate checkpoint
    await worker.processNextJob(); // normalize/upload -> asset checkpoint
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable");
    const checkpointedProductionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(checkpointedProductionAssets.length, 1, "the FINAL production asset must already be durably persisted");

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
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(productionAssets.length, 1, "reconciliation must never create a second production asset");

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "finalizing", "the project must reach its correct terminal validation status");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "reconciliation must still run authoritative PrintValidation");
  });

  it("10: the exact real-job recovery-budget case (providerRecoveryAttempts=4, MAX=5): resume charges to 5, checkpoint refunds to 4, next claim resolves the existing asset before any further provider work and completes", async () => {
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

    // Test-side-only instrumentation (no production code touched, no
    // encapsulation weakened): records every `providerRecoveryAttempts`
    // value this job's row is EVER written with, in order, purely by
    // observing the repository's own public write surface. This is what
    // lets the intermediate charged-to-5 state (written, then immediately
    // overwritten by the checkpoint's own refund, within the SAME claim)
    // be proven to have genuinely occurred, rather than merely inferred
    // from the before/after values.
    const recoveryAttemptsWriteHistory: number[] = [];
    const observedRepo: typeof repo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "updateFinalArtworkJob") {
          return async (jobId: string, patch: Parameters<typeof repo.updateFinalArtworkJob>[1]) => {
            if (jobId === requestedJobId && typeof patch.providerRecoveryAttempts === "number") {
              recoveryAttemptsWriteHistory.push(patch.providerRecoveryAttempts);
            }
            return target.updateFinalArtworkJob(jobId, patch);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const worker = createFinalArtworkWorkerCapability(observedRepo, assets, provider, printValidation);

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    const requestedJobId = requested.job.id;

    // Claim 1: fresh submission, still processing -- pending, providerRequestId
    // durably persisted. Mirrors how the real job first acquired its request.
    await worker.processNextJob();
    const afterFresh = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterFresh?.status, "recoverable");
    assert.equal(afterFresh?.providerRequestId, FIXED_PROCESS_ID);

    // Seed EXACTLY the real production job's current state: four prior
    // genuine recovery charges already retained (job
    // 67816e21-fa9a-408f-ac45-916e679fd8c4's actual providerRecoveryAttempts
    // at review time), one below the MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS(5)
    // ceiling -- so the next resume claim is legitimately still allowed.
    await repo.updateFinalArtworkJob(requested.job.id, { providerRecoveryAttempts: 4 });
    recoveryAttemptsWriteHistory.length = 0; // only claim 2's own writes matter below.

    // The provider genuinely finishes.
    setStatusMode("completed");

    // Claim 2: RESUMES the persisted request. Classification is "resume",
    // so the claim charges providerRecoveryAttempts 4 -> 5 up front (at the
    // ceiling) BEFORE attempting anything -- then finds Completed, and
    // durably checkpoints `providerStatus: "result_ready"` (never
    // downloading in this same invocation).
    await worker.processNextJob();

    // Proves the intermediate charged state was REALLY written (not just
    // inferable from before/after), and that it was written strictly
    // before the refund that follows it in the same claim.
    assert.deepEqual(
      recoveryAttemptsWriteHistory,
      [5, 4],
      "claim 2 must durably charge providerRecoveryAttempts to 5 BEFORE the status checkpoint refunds it back to 4 -- both writes, in order",
    );

    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable");
    assert.equal(afterStatusCheckpoint?.providerRequestId, FIXED_PROCESS_ID, "still the SAME request -- never resubmitted, never changed, never a new job");
    assert.equal(afterStatusCheckpoint?.providerStatus, "result_ready");
    assert.equal(submitCount(), 1, "exactly one paid submission across every claim so far");
    // THE exact regression the live incident hit: reaching a durable
    // checkpoint after a resume neutralizes (refunds) that claim's own
    // charge -- the counter returns to its PRE-claim value (4), never left
    // stranded at the ceiling (5) purely for needing another invocation to
    // advance an already-completed provider result one more bounded step.
    assert.equal(
      afterStatusCheckpoint?.providerRecoveryAttempts,
      4,
      "the resume claim's own charge (4->5) is refunded back to 4 at the status checkpoint -- never left at the ceiling",
    );

    // Claim 3: RESUMES again (a SECOND resume-classified claim -- the job
    // still carries the SAME matching providerKey/providerRequestId, now
    // with `providerStatus: "result_ready"`), charging 4 -> 5 up front a
    // SECOND time, downloading the result, persisting it as an internal
    // intermediate, and neutralizing this claim's own charge exactly the
    // same way.
    recoveryAttemptsWriteHistory.length = 0;
    await worker.processNextJob();

    assert.deepEqual(
      recoveryAttemptsWriteHistory,
      [5, 4],
      "claim 3 (the download step) must ALSO durably charge providerRecoveryAttempts to 5 before refunding it back to 4 -- the same real-incident arithmetic applies to every resume-classified bounded step, not only the first",
    );

    const afterDownloadCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterDownloadCheckpoint?.status, "recoverable");
    assert.equal(
      afterDownloadCheckpoint?.providerRecoveryAttempts,
      4,
      "the second resume claim's own charge is ALSO refunded back to 4 at the download checkpoint",
    );
    const intermediateAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      isProviderResultIntermediateAsset,
    );
    assert.equal(intermediateAssets.length, 1);

    // Claim 4: finds the intermediate and normalizes/uploads the production
    // asset -- this claim never classifies a provider attempt at all (no
    // status check, no download), but the Unbounded Normalize Crash-Loop
    // Repair DOES charge and, on this clean success, refund its OWN
    // `providerRecoveryAttempts` unit around the normalize/upload work --
    // net zero, same shape as every other checkpoint in this file, and the
    // exact mechanism that bounds a repeatedly-crashing normalize step
    // instead of retrying it forever.
    recoveryAttemptsWriteHistory.length = 0;
    await worker.processNextJob();
    assert.deepEqual(
      recoveryAttemptsWriteHistory,
      [5, 4],
      "normalizing from an already-downloaded intermediate charges and refunds its OWN recovery-budget unit -- net zero on this clean success",
    );
    const checkpointedAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(checkpointedAssets.length, 1);

    // Claim 5: the NEXT invocation must resolve the already-existing,
    // already-checkpointed production asset via `resolveExistingProductionAsset`
    // -- BEFORE any provider budget check or provider call -- and finalize
    // directly. No additional recovery charge, no additional submission.
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed", "the job completes using its existing recovery budget, no reset, no special-casing");
    assert.equal(submitCount(), 1, "finalizing from the existing asset never required a second paid submission");
    assert.equal(
      completed?.providerRecoveryAttempts,
      4,
      "resolving the existing asset and finalizing never touches the recovery budget at all",
    );

    const finalAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(finalAssets.length, 1, "still exactly the one asset created at the checkpoint -- never a duplicate");
    assert.equal(finalAssets[0]!.id, checkpointedAssets[0]!.id);

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "the job reaches real print validation using its existing recovery budget");

    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "finalizing", "the project transitioned out of finalizing");
  });
});
