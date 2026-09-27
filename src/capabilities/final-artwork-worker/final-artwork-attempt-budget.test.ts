import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import type { FinalArtworkProvider, FinalArtworkProviderInput, FinalArtworkProviderOutput } from "@/capabilities/final-artwork/provider";
import {
  resolveMaximalSinglePassRequest,
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import {
  createFinalArtworkWorkerCapability,
  MAX_FINAL_ARTWORK_ATTEMPTS,
  MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
} from "./final-artwork-worker-capability";

/**
 * "Separate Provider Recovery Attempt Budget" — proves the corrected
 * FinalArtworkJob attempt lifecycle: a claim capable of a fresh paid
 * submission is bounded by MAX_FINAL_ARTWORK_ATTEMPTS exactly as before;
 * a claim that can only resume an existing, matching, already-paid
 * provider request is bounded by its OWN separate
 * MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS instead, so generic claim attempts
 * consumed by infrastructure/readback failures can never block recovery of
 * an already-billed result -- and a resume can never silently become a
 * fresh paid submit.
 *
 * Uses a SYNTHETIC provider request id throughout, never the real live
 * incident's id, and NEVER makes a real network call -- every `fetchImpl`
 * here only ever answers its own known fake Topaz endpoints.
 *
 * Fixture construction mirrors `topaz-provider-selection-and-invocation
 * .test.ts` / `topaz-download-resume-recovery.test.ts` (duplicated locally,
 * per this codebase's established per-file convention).
 */

const CANVAS_PX = 1200; // 3in sleeve at 300 PPI needs 900px.
const SYNTHETIC_PROCESS_ID = "synthetic-test-process-id-0001";

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

/** Generalizes `preparedTransparentPngOfWidth` to an arbitrary square canvas -- used to build plausible two-pass reconstruction outputs whose alpha bbox scales proportionally with the canvas, like a real proportional upscale would. */
function syntheticReconstructedPng(canvasPx: number, artworkWidthPx: number): Buffer {
  const png = new PNG({ width: canvasPx, height: canvasPx });
  const inset = Math.floor((canvasPx - artworkWidthPx) / 2);
  for (let y = 0; y < canvasPx; y += 1) {
    for (let x = 0; x < canvasPx; x += 1) {
      const idx = (canvasPx * y + x) << 2;
      const inArtwork = x >= inset && x < inset + artworkWidthPx && y >= inset && y < inset + artworkWidthPx;
      png.data[idx] = 10;
      png.data[idx + 1] = 90;
      png.data[idx + 2] = 200;
      png.data[idx + 3] = inArtwork ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function pngBytesOf(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 90;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

type DownloadMode = "succeed" | "fail_transiently" | "permanently_gone";

/** A fake Topaz endpoint set for a SINGLE reconstruction pass, with a caller-chosen (synthetic) process id and a download mode reconfigurable between `processNextJob()` calls. */
function buildSinglePassFakeTopazFetch(
  processId: string,
  reconstructedWidthPx: number,
  reconstructedHeightPx: number,
) {
  const calls: string[] = [];
  let submitCount = 0;
  let imageAttemptCount = 0;
  let downloadMode: DownloadMode = "succeed";

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);

    if (url.endsWith("/tool/async")) {
      submitCount += 1;
      return new Response(JSON.stringify({ process_id: processId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/status/")) {
      return new Response(JSON.stringify({ status: "Completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/download/")) {
      if (downloadMode === "permanently_gone") {
        return new Response(JSON.stringify({ error: "gone" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ url: `https://cdn.example.com/${processId}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `https://cdn.example.com/${processId}.png`) {
      imageAttemptCount += 1;
      if (downloadMode === "fail_transiently") {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return new Response(new Uint8Array(pngBytesOf(reconstructedWidthPx, reconstructedHeightPx)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
  }) as typeof fetch;

  return {
    fetchImpl: impl,
    calls,
    submitCount: () => submitCount,
    imageAttemptCount: () => imageAttemptCount,
    setDownloadMode: (mode: DownloadMode) => {
      downloadMode = mode;
    },
  };
}

interface TwoPassSpec {
  processId: string;
  bytes: Buffer;
}

/**
 * A fake Topaz endpoint set for a TWO-PASS reconstruction — two independent
 * process ids, each with its own reconfigurable download mode and its own
 * fixed returned bytes. Mirrors
 * `topaz-transparency-upscale-provider.test.ts`'s own `buildTwoPassFakeFetch`
 * (duplicated locally, worker-level, per this codebase's convention).
 */
function buildTwoPassFakeTopazFetch(pass1: TwoPassSpec, pass2: TwoPassSpec) {
  const calls: string[] = [];
  let submitCount = 0;
  const submittedIds: string[] = [];
  const downloadModes = new Map<string, DownloadMode>([
    [pass1.processId, "succeed"],
    [pass2.processId, "succeed"],
  ]);
  const specs = new Map([
    [pass1.processId, pass1],
    [pass2.processId, pass2],
  ]);

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);

    if (url.endsWith("/tool/async")) {
      submitCount += 1;
      // First submission is always pass 1; any submission after pass 1's
      // identity has already been recorded is pass 2 -- mirrors the real
      // provider's own strictly-sequential pass1-then-pass2 behavior.
      const id = submittedIds.includes(pass1.processId) ? pass2.processId : pass1.processId;
      submittedIds.push(id);
      return new Response(JSON.stringify({ process_id: id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/status/")) {
      return new Response(JSON.stringify({ status: "Completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/download/")) {
      const id = url.split("/download/")[1]!;
      if (downloadModes.get(id) === "permanently_gone") {
        return new Response(JSON.stringify({ error: "gone" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ url: `https://cdn.example.com/${id}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const match = url.match(/^https:\/\/cdn\.example\.com\/(.+)\.png$/);
    if (match) {
      const id = match[1]!;
      const spec = specs.get(id);
      if (!spec) throw new Error(`unexpected download for unknown process id ${id}`);
      if (downloadModes.get(id) === "fail_transiently") {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return new Response(new Uint8Array(spec.bytes), { status: 200, headers: { "content-type": "image/png" } });
    }
    throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
  }) as typeof fetch;

  return {
    fetchImpl: impl,
    calls,
    submitCount: () => submitCount,
    submittedIds: () => [...submittedIds],
    setDownloadMode: (processId: string, mode: DownloadMode) => downloadModes.set(processId, mode),
  };
}

/** A minimal fake `FinalArtworkProvider` with NO paid-request concept at all — mirrors `local_raster_interpolation`'s shape for test 13 (non-Topaz providers unaffected). */
function neverPaidProvider(output: Partial<FinalArtworkProviderOutput> = {}): { provider: FinalArtworkProvider; callCount: () => number } {
  let calls = 0;
  const provider: FinalArtworkProvider = {
    providerKey: "local_raster_interpolation",
    produce: async (_input: FinalArtworkProviderInput) => {
      calls += 1;
      return {
        bytes: pngBytesOf(900, 900),
        contentType: "image/png",
        widthPx: 900,
        heightPx: 900,
        hasTransparency: true,
        nativeWidthPx: 1200,
        nativeHeightPx: 1200,
        reconstructedWidthPx: null,
        reconstructedHeightPx: null,
        resolutionProvenance: "interpolated_upscale",
        transformationMethod: "local_raster_contain_resample_v1",
        preservesApprovedContent: true,
        providerRequestId: null,
        normalization: {
          strategy: "contain",
          alphaBBoxWidthPx: 900,
          alphaBBoxHeightPx: 900,
          trimmedWidthPx: 900,
          trimmedHeightPx: 900,
          artworkOccupancy: 1,
          targetWidthIn: 3,
          targetPpi: 300,
          intendedWidthIn: 3,
          sourceWidthPx: 900,
          sourceHeightPx: 900,
          outputWidthPx: 900,
          outputHeightPx: 900,
          appliedSafetyMarginPx: 0,
        } as unknown as FinalArtworkProviderOutput["normalization"],
        ...output,
      };
    },
  };
  return { provider, callCount: () => calls };
}

describe("Separate Provider Recovery Attempt Budget", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-attempt-budget-"));
    process.chdir(tempDir);
  });

  after(async () => {
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
      metadata: { originalFilename: "attempt-budget-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "attempt-budget-fixture.png",
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

  // --- 1: fresh job, no provider request -----------------------------------
  it("1: a fresh job with no provider request accounts normally and is allowed to submit within budget", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Bounded FinalArtwork Production-Execution Repair (short-step
    // follow-up): the provider's own completion is now its own checkpoint
    // (status -> "result_ready"), downloading is its own checkpoint (an
    // internal intermediate asset), and normalizing/uploading the
    // production asset is a THIRD checkpoint before finalizing -- four
    // invocations total to drain a fresh job to "completed". Also drains
    // the job to a terminal state so it cannot be mistakenly reclaimed by a
    // LATER test sharing this same on-disk store.
    await worker.processNextJob(); // status check -> result_ready checkpoint
    await worker.processNextJob(); // download -> intermediate checkpoint
    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
    assert.equal(job?.attempts, 1);
    assert.equal(job?.providerRecoveryAttempts, 0, "a fresh submission never spends the recovery budget");
    assert.equal(submitCount(), 1);
  });

  // --- 2: fresh job exceeds fresh-execution limit --------------------------
  it("2: a job with no provider request whose generic attempts already exceed the fresh-execution budget is rejected before any submit", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, calls } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Seed exactly the live incident's shape: generic attempts already at
    // the ceiling, no provider request yet (a job that has never reached a
    // provider at all, e.g. every prior attempt died before submit).
    await repo.updateFinalArtworkJob(requested.job.id, { attempts: MAX_FINAL_ARTWORK_ATTEMPTS });

    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "failed");
    assert.match(job?.lastError ?? "", /exceeded maximum finalization attempts/i);
    assert.equal(job?.attempts, MAX_FINAL_ARTWORK_ATTEMPTS + 1);
    assert.equal(submitCount(), 0, "no provider submission may ever occur once the fresh-execution budget is exhausted");
    assert.equal(calls.length, 0, "no Topaz endpoint of any kind is contacted -- the refusal happens before any network call");
  });

  // --- 3: existing valid provider request, generic attempts already high --
  it("3: an existing valid provider request is resumed even when generic attempts already exceed the fresh-execution budget", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Exactly the live incident's shape: generic attempts already exceeds
    // MAX_FINAL_ARTWORK_ATTEMPTS, but a valid, matching provider request exists.
    await repo.updateFinalArtworkJob(requested.job.id, {
      attempts: MAX_FINAL_ARTWORK_ATTEMPTS + 1,
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      providerStatus: "submitted",
      providerRecoveryAttempts: 0,
    });

    // Bounded FinalArtwork Production-Execution Repair (short-step
    // follow-up): the resume now advances in THREE separate, individually
    // recovery-budget-neutralizing checkpoints (status -> download ->
    // normalize/upload) before a fourth invocation finalizes.
    await worker.processNextJob(); // resume: status check -> result_ready checkpoint
    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable");
    assert.equal(
      afterStatusCheckpoint?.providerRecoveryAttempts,
      0,
      "reaching the status checkpoint refunds the charge this resume claim made -- this is the exact real-incident regression",
    );

    await worker.processNextJob(); // resume: download -> intermediate checkpoint
    const afterDownloadCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterDownloadCheckpoint?.status, "recoverable");
    assert.equal(afterDownloadCheckpoint?.providerRecoveryAttempts, 0, "reaching the download checkpoint ALSO refunds that claim's own charge");

    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable");
    assert.equal(checkpointed?.providerRecoveryAttempts, 0, "normalizing from the intermediate never touches the recovery budget");

    await worker.processNextJob(); // finalize

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed", "resume must be allowed despite the exhausted fresh-execution budget");
    assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID);
    assert.equal(job?.providerRecoveryAttempts, 0, "finalizing from the already-checkpointed asset never touches the recovery budget");
    assert.equal(submitCount(), 0, "resuming must never submit a fresh paid request");
  });

  // --- 4: resume download transient failure --------------------------------
  it("4: a resume whose download transiently fails defers to a later invocation WITHOUT failing the job outright, but DOES spend one recovery attempt (Blocker 2 correction: a controlled, complete claim that caught a transient error is bounded by the SAME ceiling a genuine failure already is -- never an unconditional free pass)", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(requested.job.id, {
      attempts: MAX_FINAL_ARTWORK_ATTEMPTS + 1,
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      providerStatus: "submitted",
      providerRecoveryAttempts: 0,
    });

    // Claim 1: resume, status check only -- finds "Completed" and
    // checkpoints `providerStatus: "result_ready"`. The download failure
    // mode configured below is never even reached by this claim.
    await worker.processNextJob();
    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable");
    assert.equal(afterStatusCheckpoint?.providerStatus, "result_ready");
    assert.equal(afterStatusCheckpoint?.providerRecoveryAttempts, 0);

    // Claim 2: resume, download step -- an ECONNRESET (ProviderError
    // classification "network", stage "download") is a controlled,
    // COMPLETE claim (the catch block ran; a decision was made), never an
    // interrupted one (contrast the Pedro-class gateway kill, which never
    // reaches any code at all). Deferred to a later invocation -- never
    // failed outright, never resubmitted -- but this claim's own recovery
    // charge is NOT refunded: an unconditional free pass here is exactly
    // what let a PERSISTENT transient condition defer forever with the
    // budget never moving (Blocker 2). A single blip still only costs the
    // SAME one unit a genuine failure of this claim would have cost.
    setDownloadMode("fail_transiently");
    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable", "a transient download hiccup defers to a later invocation -- it must never fail the job outright");
    assert.equal(job?.providerKey, "topaz_transparency_upscale", "provider identity preserved");
    assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID);
    assert.equal(
      job?.providerRecoveryAttempts,
      1,
      "Blocker 2: a transient hiccup on a resume claim IS bounded by the recovery budget -- exactly one unit spent, never refunded for free",
    );
    assert.equal(submitCount(), 0, "still never a paid submission -- only status/download were attempted, both non-billable reads");

    // The condition clears -- the SAME job, on a LATER claim, completes
    // normally with zero duplicate submissions. The ONE genuine hiccup's
    // charge is retained (never touched again), exactly like a genuine
    // failure's charge would be.
    setDownloadMode("succeed");
    await worker.processNextJob(); // download -> intermediate checkpoint
    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerRecoveryAttempts, 1, "the one transient hiccup's charge is retained even after the job completes normally");
    assert.equal(submitCount(), 0, "zero paid submissions across the entire deferred-then-recovered lifecycle");
  });

  // --- 4b: persistent transient conditions eventually reach a bounded terminal outcome ---
  it("4b: a PERSISTENT transient condition (never a single blip) is NOT an unbounded loop -- repeated status timeouts, then repeated download timeouts, each eventually exhaust the recovery budget and fail the job explicitly, without ever resubmitting", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, calls } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
      // A tiny but real per-call timeout -- the exact mechanism this repair
      // added to `fetchStatus()`/`download()`'s metadata fetch, which
      // previously had none at all.
      statusTimeoutMs: 5,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(requested.job.id, {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      providerStatus: "submitted",
      providerRecoveryAttempts: 0,
    });

    // A fake whose /status/ endpoint HANGS until aborted -- it never
    // resolves or rejects ON ITS OWN, so the ONLY thing that can ever end
    // the call is this adapter's own `statusTimeoutMs`-bounded
    // `AbortController` (which this fake DOES respect, exactly like a real
    // `fetch` would). This is exactly "repeated status timeout": every
    // single claim times out the SAME way, with no external clock
    // advancing anything for it.
    const hangingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/status/")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const hangingProvider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl: hangingFetch,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
      statusTimeoutMs: 5,
    });
    const hangingWorker = createFinalArtworkWorkerCapability(repo, assets, hangingProvider, createPrintValidationCapability());

    for (let i = 1; i <= MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS; i += 1) {
      await hangingWorker.processNextJob();
      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "recoverable", `repeated status timeout ${i} defers -- never fails the job outright while budget remains`);
      assert.equal(job?.providerRecoveryAttempts, i, `status-timeout deferral ${i} spends exactly one recovery unit`);
      assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID, "never resubmitted while the status endpoint keeps timing out");
    }
    assert.equal(submitCount(), 0, "a persistently-timing-out status endpoint must never be papered over with a fresh paid submission");

    // One more claim: the recovery budget is now exhausted -- the SAME
    // "could not be recovered" terminal failure a truly broken/genuinely-
    // failing request would already reach, reached here purely from
    // repeated (never single) transient timeouts.
    await hangingWorker.processNextJob();
    const exhausted = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(exhausted?.status, "failed");
    assert.match(exhausted?.lastError ?? "", /could not be recovered after/i);
    assert.equal(exhausted?.providerRecoveryAttempts, MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS);
    assert.equal(submitCount(), 0);

    // A genuinely different real-world shape of the SAME class of problem:
    // repeated DOWNLOAD timeouts (never status) also converge on the same
    // bounded outcome -- proven independently on a FRESH job/request so the
    // two scenarios never interact.
    const requested2 = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    const SECOND_PROCESS_ID = "synthetic-test-process-id-0002";
    await repo.updateFinalArtworkJob(requested2.job.id, {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SECOND_PROCESS_ID,
      // Already past the status checkpoint -- this scenario is specifically
      // about the DOWNLOAD step's own repeated timeout.
      providerStatus: "result_ready",
      providerRecoveryAttempts: 0,
    });
    const hangingDownloadFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/download/") && !url.startsWith("https://cdn.example.com/")) {
        // The metadata call succeeds (returns a result URL) -- the actual
        // bytes fetch is what hangs (until aborted) below.
        return new Response(JSON.stringify({ url: `https://cdn.example.com/${SECOND_PROCESS_ID}.png` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `https://cdn.example.com/${SECOND_PROCESS_ID}.png`) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
    }) as typeof fetch;
    const hangingDownloadProvider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl: hangingDownloadFetch,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
      downloadTimeoutMs: 5,
    });
    const hangingDownloadWorker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      hangingDownloadProvider,
      createPrintValidationCapability(),
    );

    for (let i = 1; i <= MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS; i += 1) {
      await hangingDownloadWorker.processNextJob();
      const job = await repo.getFinalArtworkJob(requested2.job.id);
      assert.equal(job?.status, "recoverable", `repeated download-bytes timeout ${i} defers -- never fails the job outright while budget remains`);
      assert.equal(job?.providerRecoveryAttempts, i, `download-timeout deferral ${i} spends exactly one recovery unit`);
    }
    await hangingDownloadWorker.processNextJob();
    const exhausted2 = await repo.getFinalArtworkJob(requested2.job.id);
    assert.equal(exhausted2?.status, "failed");
    assert.match(exhausted2?.lastError ?? "", /could not be recovered after/i);
  });

  // --- 5: resume eventually succeeds ---------------------------------------
  it("5: after a GENUINE resume failure (a malformed download, never a mere transport hiccup), a later retry with the same provider request succeeds -- zero duplicate submissions, pipeline continues to output", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(requested.job.id, {
      attempts: MAX_FINAL_ARTWORK_ATTEMPTS + 1,
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      // Already past the status-check checkpoint (a genuinely transient
      // network blip during THAT step is Repair 8's own concern, covered by
      // test 4) -- this test is specifically about a GENUINE download-step
      // failure (`permanently_gone`, a 404 -> `malformed_response`, never
      // `network`/`rate_limited`/`unavailable`/`timeout`), which correctly
      // still spends a recovery attempt.
      providerStatus: "result_ready",
      providerRecoveryAttempts: 0,
    });
    setDownloadMode("permanently_gone");
    await worker.processNextJob();
    const afterGenuineFailure = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterGenuineFailure?.status, "failed");
    assert.equal(afterGenuineFailure?.providerRecoveryAttempts, 1, "a genuinely malformed/gone download result correctly spends a recovery attempt");

    // The user clicks Retry Preparation once the underlying condition clears.
    setDownloadMode("succeed");
    const retried = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(retried.job.id, requested.job.id, "retry revives the SAME job");
    // Bounded FinalArtwork Production-Execution Repair (short-step
    // follow-up): this retry's resume downloads successfully and
    // checkpoints the internal intermediate -- and, per the refund
    // contract, NEUTRALIZES the recovery charge THIS (successful) claim
    // made, leaving only the FIRST (genuinely failed) claim's charge
    // retained. Two further invocations are required to normalize/upload
    // and then finalize.
    await worker.processNextJob();
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable");
    assert.equal(
      checkpointed?.providerRecoveryAttempts,
      1,
      "only the first, genuinely-failed claim's charge survives -- the successful resume's own charge is refunded at the checkpoint",
    );

    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
    assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID, "the completed job is keyed to the SAME provider request throughout");
    assert.equal(job?.providerRecoveryAttempts, 1, "the retained genuine-failure charge is never touched by finalizing from the checkpointed asset");
    assert.equal(submitCount(), 0, "zero paid submissions across the entire failed-then-recovered lifecycle");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
    assert.ok(validation, "a resumed-and-recovered reconstruction proceeds through real print validation");
  });

  // --- 6: recovery budget exhausted -----------------------------------------
  it("6: exhausting the recovery budget against an existing provider request fails explicitly, without any fresh paid submission", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, calls } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(requested.job.id, {
      attempts: MAX_FINAL_ARTWORK_ATTEMPTS + 10,
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      providerStatus: "submitted",
      providerRecoveryAttempts: MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
    });

    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "failed");
    assert.match(job?.lastError ?? "", /could not be recovered after/i);
    assert.equal(job?.providerKey, "topaz_transparency_upscale", "identity preserved even at exhaustion -- never silently discarded");
    assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID);
    assert.equal(job?.providerRecoveryAttempts, MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS, "the budget is not spent further once already exhausted");
    assert.equal(submitCount(), 0, "an exhausted recovery budget must never fall back to a fresh paid submission");
    assert.equal(calls.length, 0, "the refusal happens before any Topaz endpoint is contacted -- no wasted poll/download either");
  });

  // --- 6b: Unbounded Normalize Crash-Loop Repair (independent-review -------
  // finding, Blocker 3): distinct from test 6 above, which exhausts the
  // ORIGINAL top-level ceiling in `produceProductionAsset` for a job that
  // never even reached a downloaded intermediate. This proves the SEPARATE
  // ceiling `finalizeFromProviderResultIntermediate` itself checks, for a
  // job that HAS a real, genuinely-downloaded, valid intermediate -- the
  // exact "already-downloaded result, but normalizing it keeps crashing"
  // shape Blocker 3 exists for. A true process death cannot be staged
  // inside a single synchronous test process; the durable STATE N real
  // crashes would leave behind (the charge from each, with nothing after it
  // ever running) is reproduced directly, mirroring test 6's own established
  // technique for the sibling ceiling.
  it("6b: repeated crash-during-normalize against an already-downloaded intermediate reaches a bounded terminal failure -- the ceiling check fires BEFORE any storage/provider work, never an unbounded retry loop", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, calls } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Claim 1: submit + status -> result_ready checkpoint.
    await worker.processNextJob();
    // Claim 2: download -> a REAL, valid, geometry-checked intermediate is
    // durably persisted. `providerRecoveryAttempts` is untouched by this
    // step (only `finalizeFromProviderResultIntermediate` ever charges it).
    await worker.processNextJob();
    const afterDownload = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterDownload?.status, "recoverable");
    assert.equal(afterDownload?.providerRecoveryAttempts, 0);
    assert.equal(submitCount(), 1);
    const callsAfterDownload = calls.length;

    // The durable state exactly N real, repeated crashes-during-normalize
    // would leave behind: each one charged the counter (before attempting
    // any risky work) and then the process died before anything else ran.
    await repo.updateFinalArtworkJob(requested.job.id, {
      providerRecoveryAttempts: MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
    });

    // The NEXT real claim must refuse -- explicitly, terminally -- without
    // ever touching storage or the provider again.
    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "failed", "a normalize crash-loop reaches a bounded terminal outcome, never retries forever");
    assert.match(job?.lastError ?? "", /could not be normalized after/i);
    assert.equal(job?.providerKey, "topaz_transparency_upscale", "identity preserved even at exhaustion -- the intermediate itself is never discarded");
    assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID);
    assert.equal(job?.providerRecoveryAttempts, MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS, "the budget is not spent further once already exhausted");
    assert.equal(submitCount(), 1, "an exhausted normalize-recovery budget must never fall back to a fresh paid submission");
    assert.equal(calls.length, callsAfterDownload, "the refusal happens before any further Topaz endpoint contact -- the already-downloaded intermediate is never re-fetched either");
  });

  // --- 7: permanently unavailable provider result --------------------------
  it("7: a permanently-gone provider result fails explicitly on every retry and never resubmits, until the recovery budget itself is exhausted", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const finalArtwork = createFinalArtworkCapability(repo);

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(requested.job.id, {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      // Seeded past the status-check checkpoint -- this test is specifically
      // about the DOWNLOAD step's own genuine (never transient) failure mode
      // exhausting the recovery budget; the status-check step's own
      // Repair-8 handling is covered by test 4.
      providerStatus: "result_ready",
      providerRecoveryAttempts: 0,
    });

    // A fake Topaz endpoint that always reports the result permanently
    // gone — exactly like a persistent provider-side condition would
    // behave across every subsequent retry in this test.
    const gone = buildSinglePassFakeTopazFetch(SYNTHETIC_PROCESS_ID, expectedRequest.widthPx, expectedRequest.heightPx);
    gone.setDownloadMode("permanently_gone");
    const goneProvider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl: gone.fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const goneWorker = createFinalArtworkWorkerCapability(repo, assets, goneProvider, createPrintValidationCapability());

    for (let i = 1; i <= MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS; i += 1) {
      await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      await goneWorker.processNextJob();
      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "failed");
      assert.equal(job?.providerRecoveryAttempts, i, `recovery attempt ${i} spent`);
      assert.equal(job?.providerRequestId, SYNTHETIC_PROCESS_ID, "never resubmitted while permanently gone");
    }
    assert.equal(gone.submitCount(), 0, "a permanently-gone result must never be papered over with a fresh paid submission");

    // One more retry: the recovery budget is now exhausted -- explicit,
    // distinct failure, without even contacting the (still-gone) endpoint.
    await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    const callsBefore = gone.calls.length;
    await goneWorker.processNextJob();
    const finalJob = await repo.getFinalArtworkJob(requested.job.id);
    assert.match(finalJob?.lastError ?? "", /could not be recovered after/i);
    assert.equal(gone.calls.length, callsBefore, "the exhaustion refusal contacts no Topaz endpoint at all");
    assert.equal(gone.submitCount(), 0);
  });

  // --- 9: worker recovery/abandoned job path --------------------------------
  it("9: a job recovered from an abandoned 'running' state back to 'recoverable' is correctly classified as resume on its next real claim", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount } = buildSinglePassFakeTopazFetch(
      SYNTHETIC_PROCESS_ID,
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
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Simulate a worker that claimed the job, submitted, and then crashed
    // (heartbeat never updated again) -- exactly the scenario
    // `recoverAbandonedFinalArtworkJobs` exists for. `attempts`/
    // `providerRecoveryAttempts` are untouched by that recovery step itself
    // (only `status` flips) -- proven directly below.
    await repo.updateFinalArtworkJob(requested.job.id, {
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      attempts: MAX_FINAL_ARTWORK_ATTEMPTS + 1,
      providerKey: "topaz_transparency_upscale",
      providerRequestId: SYNTHETIC_PROCESS_ID,
      providerStatus: "submitted",
      providerRecoveryAttempts: 0,
    });

    const recovery = await worker.recoverAbandonedJobs(15 * 60 * 1000);
    assert.equal(recovery.recoveredCount, 1);
    const recovered = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(recovered?.status, "recoverable");
    assert.equal(recovered?.attempts, MAX_FINAL_ARTWORK_ATTEMPTS + 1, "abandoned-job recovery never touches the attempt counters itself");
    assert.equal(recovered?.providerRecoveryAttempts, 0);

    // The NEXT real claim (a "recoverable" job is directly claimable) must
    // classify as resume, exactly as it would have before the crash. Under
    // this repair, that resume advances one bounded step at a time
    // (status -> download -> normalize/upload), each refunding its own
    // recovery charge, before a final invocation finalizes.
    await worker.processNextJob(); // resume: status check -> result_ready checkpoint
    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable");
    assert.equal(afterStatusCheckpoint?.providerRecoveryAttempts, 0, "the successful resume's own charge is refunded at the status checkpoint");

    await worker.processNextJob(); // resume: download -> intermediate checkpoint
    const checkpointed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(checkpointed?.status, "recoverable");
    assert.equal(checkpointed?.providerRecoveryAttempts, 0, "the successful resume's own charge is ALSO refunded at the download checkpoint");

    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize
    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
    assert.equal(job?.providerRecoveryAttempts, 0);
    assert.equal(submitCount(), 0, "resuming after abandoned-job recovery must never submit a fresh paid request");
  });

  // --- 13: non-Topaz provider behavior unchanged ----------------------------
  it("13: a provider with no paid-request concept is completely unaffected by the recovery-budget model", async () => {
    const { repo, assets, projectId } = await setup(1000); // sufficient source -- reconstruction not even required
    const { provider, callCount } = neverPaidProvider();
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    // Even with generic attempts already past the fresh-execution ceiling,
    // a provider that never sets a providerKey/providerRequestId is always
    // classified fresh_execution -- unaffected by the recovery model, and
    // still correctly gated by the SAME, unchanged, pre-existing ceiling.
    await repo.updateFinalArtworkJob(requested.job.id, { attempts: MAX_FINAL_ARTWORK_ATTEMPTS });
    await worker.processNextJob();
    // Phase 2 (post-provider durable checkpoint): drain to a terminal
    // state regardless of outcome, so this job is never left claimable
    // and cannot be mistakenly picked up by a later test sharing this
    // same on-disk store.
    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.providerRecoveryAttempts, 0, "a provider with no paid-request concept never spends the recovery budget");
    assert.equal(job?.providerKey, null);
    assert.equal(job?.providerRequestId, null);
    // Whether this attempt succeeds or is itself refused depends only on
    // whether reconstruction was needed at all for a 1000px source -- the
    // point under test is that `providerRecoveryAttempts` never moves and
    // classification is always fresh_execution when there is no provider
    // request. Either outcome is acceptable; the assertion above is what matters.
    void callCount;
  });

  // --- 8: two-pass Topaz -----------------------------------------------------
  describe("Two-pass Topaz", () => {
    const TWO_PASS_ARTWORK_WIDTH_PX = 150; // ~6x total need at sleeve sizing -- comfortably two-pass-eligible (>4x, <=8x).
    const PASS1_ID = "synthetic-pass1-id";
    const PASS2_ID = "synthetic-pass2-id";

    function buildTwoPassSpecs() {
      const pass1Request = resolveMaximalSinglePassRequest({ width: CANVAS_PX, height: CANVAS_PX });
      const pass1ArtworkWidthPx = Math.round(TWO_PASS_ARTWORK_WIDTH_PX * pass1Request.scale);
      const pass1Bytes = syntheticReconstructedPng(pass1Request.widthPx, pass1ArtworkWidthPx);

      const pass1Png = PNG.sync.read(pass1Bytes);
      const pass2Outcome = resolveReconstructionRequest(
        { width: pass1Png.width, height: pass1Png.height, data: pass1Png.data },
        PRINT_PLACEMENT_SIZING_POLICY.sleeve,
      );
      if (pass2Outcome.status !== "resolved") throw new Error(`pass 2 fixture is not reconstructible: ${pass2Outcome.status}`);
      assert.ok(pass2Outcome.request.scale > 1, "sanity: pass 2 must genuinely be needed for this fixture");
      const pass2ArtworkWidthPx = Math.round(pass1ArtworkWidthPx * pass2Outcome.request.scale);
      const pass2Bytes = syntheticReconstructedPng(pass2Outcome.request.widthPx, pass2ArtworkWidthPx);

      return {
        pass1: { processId: PASS1_ID, bytes: pass1Bytes },
        pass2: { processId: PASS2_ID, bytes: pass2Bytes },
      };
    }

    it("8a: a transient pass-1 download failure defers (never fails the job outright) and resumes PASS 1 (never jumps to pass 2), spending exactly one recovery attempt (Blocker 2); once recovered, pass 2 submits fresh and completes -- each pass submitted exactly once", async () => {
      const { repo, assets, projectId } = await setup(TWO_PASS_ARTWORK_WIDTH_PX);
      const { pass1, pass2 } = buildTwoPassSpecs();
      const fake = buildTwoPassFakeTopazFetch(pass1, pass2);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key-not-real",
        fetchImpl: fake.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
      });
      const finalArtwork = createFinalArtworkCapability(repo);
      const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

      const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

      // Claim 1: fresh submit + status check for pass 1 -- the fixture's
      // status endpoint answers "Completed" immediately, so this checkpoints
      // `providerStatus: "result_ready"` for pass 1 without ever attempting
      // a download yet.
      await worker.processNextJob();
      const afterPass1StatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterPass1StatusCheckpoint?.status, "recoverable");
      assert.equal(afterPass1StatusCheckpoint?.providerRequestId, PASS1_ID);
      assert.equal(fake.submitCount(), 1, "only pass 1 was ever submitted so far");

      // Claim 2: resume pass 1, download step -- an ECONNRESET is a
      // transient infrastructure hiccup (never a genuine failure): it
      // defers to a later invocation WITHOUT failing the job outright and
      // WITHOUT ever touching pass 1's identity -- but (Blocker 2
      // correction) DOES spend one recovery attempt, exactly like a
      // genuine failure of this same claim would.
      fake.setDownloadMode(PASS1_ID, "fail_transiently");
      await worker.processNextJob();
      const afterTransientHiccup = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterTransientHiccup?.status, "recoverable", "a transient download hiccup must never fail the job outright");
      assert.equal(afterTransientHiccup?.providerRequestId, PASS1_ID, "pass 1's own identity is preserved -- never accidentally jumps to pass 2");
      assert.equal(afterTransientHiccup?.providerRecoveryAttempts, 1, "Blocker 2: a transient hiccup IS bounded by the recovery budget -- one unit spent");
      assert.equal(fake.submitCount(), 1, "still only pass 1 submitted -- a deferred download is never a dispatch");

      // Retry: the underlying condition clears. Claim 3 downloads pass 1's
      // result for real and persists it as the two-pass intermediate.
      fake.setDownloadMode(PASS1_ID, "succeed");
      await worker.processNextJob();

      // Claim 4: now fresh_execution (pass 1's identity was retired once its
      // result was durably persisted) -- submits pass 2 fresh against pass
      // 1's REAL output, and checks it once (also immediately "Completed").
      await worker.processNextJob();
      const afterPass2StatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterPass2StatusCheckpoint?.providerRequestId, PASS2_ID, "the job is now keyed to pass 2's fresh request");
      assert.deepEqual(fake.submittedIds(), [PASS1_ID, PASS2_ID], "exactly one submission for each pass, in order -- no duplicates");
      assert.equal(fake.submitCount(), 2);

      // Claim 5: downloads pass 2's result and persists it as the
      // ready-to-normalize intermediate. Claim 6: normalizes/uploads the
      // production asset. Claim 7: finalizes.
      await worker.processNextJob();
      await worker.processNextJob();
      await worker.processNextJob();

      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "completed");
      assert.equal(job?.providerRequestId, PASS2_ID, "the completed job is keyed to pass 2's own request, not pass 1's retired one");
      assert.equal(fake.submitCount(), 2, "still exactly one submission per pass across the entire recovered lifecycle");

      const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
      assert.ok(validation, "a recovered two-pass reconstruction proceeds through real print validation");
    });

    it("8b: a transient pass-2 download failure (after pass 1 already durably persisted) defers and resumes PASS 2 without resubmitting either pass, spending exactly one recovery attempt (Blocker 2)", async () => {
      const { repo, assets, projectId } = await setup(TWO_PASS_ARTWORK_WIDTH_PX);
      const { pass1, pass2 } = buildTwoPassSpecs();
      const fake = buildTwoPassFakeTopazFetch(pass1, pass2);
      const provider = new TopazTransparencyUpscaleProvider({
        apiKey: "test-key-not-real",
        fetchImpl: fake.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
      });
      const finalArtwork = createFinalArtworkCapability(repo);
      const worker = createFinalArtworkWorkerCapability(repo, assets, provider, createPrintValidationCapability());

      const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

      // Claims 1-3 drive pass 1 to its durable intermediate and pass 2 to
      // its own "result_ready" checkpoint, exactly as in test 8a's
      // non-failing lead-up.
      await worker.processNextJob(); // pass 1: submit + status -> result_ready checkpoint
      await worker.processNextJob(); // pass 1: download -> pass1_intermediate persisted
      await worker.processNextJob(); // pass 2: submit + status -> result_ready checkpoint
      assert.deepEqual(fake.submittedIds(), [PASS1_ID, PASS2_ID], "both passes were genuinely submitted once each so far");

      const assetsAfterLeadUp = await repo.listAssets(projectId);
      const intermediatesAfterLeadUp = assetsAfterLeadUp.filter(
        (a) => (a.metadata as Record<string, unknown> | undefined)?.reconstructionStage,
      );
      assert.equal(intermediatesAfterLeadUp.length, 1, "pass 1's intermediate exists; pass 2's has not been downloaded yet");

      // Claim 4: resume pass 2, download step -- an ECONNRESET is a
      // transient infrastructure hiccup: it defers to a later invocation
      // WITHOUT failing the job outright and WITHOUT resubmitting either
      // pass -- but (Blocker 2 correction) DOES spend one recovery attempt.
      fake.setDownloadMode(PASS2_ID, "fail_transiently");
      await worker.processNextJob();
      const afterTransientHiccup = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterTransientHiccup?.status, "recoverable", "a transient download hiccup must never fail the job outright");
      assert.equal(afterTransientHiccup?.providerRequestId, PASS2_ID, "pass 1 already completed and persisted -- the job's identity belongs to pass 2");
      assert.equal(afterTransientHiccup?.providerRecoveryAttempts, 1, "Blocker 2: a transient hiccup IS bounded by the recovery budget -- one unit spent");

      // Retry: pass 2's download recovers.
      fake.setDownloadMode(PASS2_ID, "succeed");
      await worker.processNextJob(); // resume pass 2: download -> provider-result intermediate persisted
      await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
      await worker.processNextJob(); // finalize

      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "completed");
      assert.equal(job?.providerRequestId, PASS2_ID);
      assert.equal(fake.submitCount(), 2, "still exactly one submission per pass across the entire recovered lifecycle -- pass 1 is never resubmitted merely because pass 2's download hiccuped");

      const assetsList = await repo.listAssets(projectId);
      const intermediates = assetsList.filter((a) => (a.metadata as Record<string, unknown> | undefined)?.reconstructionStage);
      assert.equal(intermediates.length, 2, "pass 1's two-pass intermediate AND pass 2's ready-to-normalize intermediate, each persisted exactly once");
    });
  });
});
