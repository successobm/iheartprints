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
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * "Fix Topaz Resume/Download Failure" — end-to-end, through the REAL worker
 * pipeline (never a stand-in provider), of the exact live-incident shape:
 * submit succeeds, a provider request id is durably persisted, and the
 * FINAL download step then fails. Proves the full job lifecycle a live
 * "Retry Preparation" click drives: the failed job is revived (same job
 * id), the SAME persisted `providerRequestId` is resumed (never a second
 * `/tool/async` call), and a since-recovered download completes the job
 * normally, all the way through print validation.
 *
 * Mirrors `topaz-provider-selection-and-invocation.test.ts`'s own fixture
 * construction (an approved `prepared_upload` artwork, directly built —
 * automatic background removal is proven correct elsewhere) — deliberately
 * duplicated locally rather than imported, matching this codebase's
 * established per-file fixture convention.
 *
 * NO REAL NETWORK: every `fetchImpl` here only ever answers its own three
 * known fake Topaz endpoints (or the fixed fake CDN URL) and throws on
 * anything else.
 */

const CANVAS_PX = 1200; // 3in sleeve at 300 PPI needs 900px -- comfortably exceeded either way.
const LIVE_INCIDENT_PROCESS_ID = "01a04f6b-180c-7bbb-9e63-49f326c52bb0";

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

/**
 * A fake Topaz endpoint set whose DOWNLOAD behavior can be reconfigured
 * BETWEEN `processNextJob()` calls — modeling exactly "the same transient
 * condition that failed the first attempt has since cleared" (test 2) or
 * "the result is now permanently gone" (test 4), without ever changing
 * what `/tool/async` does (always the SAME fixed process id, so a second
 * call to it is trivially detectable as a real defect).
 */
function buildResumableFakeTopazFetch(reconstructedWidthPx: number, reconstructedHeightPx: number) {
  const calls: string[] = [];
  let submitCount = 0;
  let imageAttemptCount = 0;
  let downloadMode: "succeed" | "fail_transiently" | "permanently_gone" = "succeed";

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);

    if (url.endsWith("/tool/async")) {
      submitCount += 1;
      return new Response(JSON.stringify({ process_id: LIVE_INCIDENT_PROCESS_ID }), {
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
      return new Response(JSON.stringify({ url: "https://cdn.example.com/output.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://cdn.example.com/output.png") {
      imageAttemptCount += 1;
      if (downloadMode === "fail_transiently") {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
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
    calls,
    submitCount: () => submitCount,
    imageAttemptCount: () => imageAttemptCount,
    setDownloadMode: (mode: typeof downloadMode) => {
      downloadMode = mode;
    },
  };
}

/** Captures every `console.error` call made during `fn()`, then restores it — regardless of whether `fn()` throws. */
async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; errorCalls: unknown[][] }> {
  const original = console.error;
  const errorCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  try {
    const result = await fn();
    return { result, errorCalls };
  } finally {
    console.error = original;
  }
}

describe("Fix Topaz Resume/Download Failure -- end-to-end through the real worker", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-topaz-download-resume-"));
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
      metadata: { originalFilename: "topaz-download-resume-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "topaz-download-resume-fixture.png",
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

  it("1: a download that fails on the bounded download claim defers to a later invocation WITHOUT failing the job (Repair 8) -- the ECONNRESET shape is a transient hiccup, never a genuine failure", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildResumableFakeTopazFetch(
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

    // Claim 1: fresh submit + status check -- the fixture's status endpoint
    // answers "Completed" immediately, so this checkpoints `providerStatus:
    // "result_ready"` without ever attempting a download.
    await worker.processNextJob();
    const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatusCheckpoint?.status, "recoverable");
    assert.equal(afterStatusCheckpoint?.providerRequestId, LIVE_INCIDENT_PROCESS_ID);

    // Claim 2: resume, download step -- an ECONNRESET is exactly the
    // transient-infrastructure shape Repair 8 exists for: caught and
    // deferred, never failing the job, never spending the recovery budget.
    setDownloadMode("fail_transiently");
    const { errorCalls } = await captureConsoleError(() => worker.processNextJob());

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "recoverable", "a transient download hiccup must never fail the job outright");
    assert.equal(job?.providerKey, "topaz_transparency_upscale", "provider identity must be preserved, never cleared, for a transient download hiccup");
    assert.equal(job?.providerRequestId, LIVE_INCIDENT_PROCESS_ID, "the paid request id must be preserved so a later claim can resume it");
    assert.equal(job?.providerRecoveryAttempts, 0, "a transient hiccup must never spend the recovery budget");
    assert.equal(submitCount(), 1, "exactly one paid submission, despite the download hiccuping");

    // --- Repair 8 observability -------------------------------------------
    // No FAILURE log for this — it never failed. The deferral itself is
    // logged distinctly (`logFinalArtworkBoundedTransientDeferral`, via
    // `console.warn`), captured separately below.
    assert.equal(errorCalls.length, 0, "a transient, deferred hiccup must never log as a job failure");

    // Drain the job to a terminal state so it cannot be mistakenly reclaimed
    // by a LATER test sharing this same on-disk store.
    setDownloadMode("succeed");
    await worker.processNextJob(); // download -> intermediate checkpoint
    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize
    const drained = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(drained?.status, "completed");
  });

  it("1b: the SAME transient-deferral logs a distinct, whitelisted-field warning (never a failure log)", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, setDownloadMode } = buildResumableFakeTopazFetch(
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
    await worker.processNextJob(); // status check -> result_ready checkpoint

    setDownloadMode("fail_transiently");
    const original = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      await worker.processNextJob();
    } finally {
      console.warn = original;
    }

    const deferralCall = warnCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("transient poll/download hiccup"),
    );
    assert.ok(deferralCall, "the deferral must be logged distinctly from a failure");
    const [, details] = deferralCall as [string, Record<string, unknown>];
    assert.equal(details.projectId, projectId);
    assert.equal(details.finalArtworkJobId, requested.job.id);
    assert.equal(details.providerKey, "topaz_transparency_upscale");
    assert.equal(details.providerRequestId, LIVE_INCIDENT_PROCESS_ID);
    assert.equal(details.stage, "download");
    // Never a secret, a URL, or a stack trace.
    assert.doesNotMatch(JSON.stringify(details), /test-key-not-real/);
    assert.doesNotMatch(JSON.stringify(details), /cdn\.example\.com/);

    // Drain the job to a terminal state so it cannot be mistakenly reclaimed
    // by a LATER test sharing this same on-disk store.
    setDownloadMode("succeed");
    await worker.processNextJob(); // download -> intermediate checkpoint
    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize
    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "completed");
  });

  it("2: retrying after a GENUINE download failure (never a mere transient hiccup -- that's test 1) resumes the SAME job and SAME provider request, and a since-recovered download completes it -- zero duplicate paid submissions", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildResumableFakeTopazFetch(
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
    await worker.processNextJob(); // status check -> result_ready checkpoint

    // A genuinely malformed/gone result (never `network`/`rate_limited`/
    // `unavailable`/`timeout` -- Repair 8's transient-deferral carve-out
    // never applies here) correctly fails the job outright.
    setDownloadMode("permanently_gone");
    await worker.processNextJob();
    const failed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(failed?.status, "failed");

    // The user clicks "Retry Preparation" -- the SAME action that started
    // finalization, reviving the SAME job (Goal 21: no separate retry
    // endpoint). The underlying condition has since cleared.
    setDownloadMode("succeed");
    const retried = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(retried.job.id, requested.job.id, "retry must revive the SAME job, never create a new one");

    await worker.processNextJob(); // resume: download -> intermediate checkpoint
    // Bounded FinalArtwork Production-Execution Repair (short-step
    // follow-up): the retry's download checkpoints the internal
    // intermediate; normalize/upload is its own further checkpoint before
    // finalizing -- and, per this describe block's shared on-disk store (no
    // `retireQueuedJobs` helper exists in this file), leaving this job
    // undrained would make it the OLDEST claimable job and silently steal
    // test 3's own `processNextJob()` calls below.
    await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
    await worker.processNextJob(); // finalize

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerRequestId, LIVE_INCIDENT_PROCESS_ID, "the completed job is still keyed to the ORIGINAL paid request");
    assert.equal(submitCount(), 1, "exactly one paid submission across BOTH attempts -- the retry must resume, never resubmit");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "a resumed-and-recovered reconstruction must still proceed through real print validation");
  });

  it("3: a permanently-gone provider result fails clearly and is never silently resubmitted, even across repeated retries", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildResumableFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    setDownloadMode("permanently_gone");

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
    await worker.processNextJob(); // status check -> result_ready checkpoint (Topaz's own status is genuinely "Completed"; only the download is gone)
    await worker.processNextJob();
    let job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "failed");
    assert.match(job?.lastError ?? "", /no longer available/i);
    assert.equal(job?.providerRequestId, LIVE_INCIDENT_PROCESS_ID, "identity preserved -- a gone result is never treated as grounds to discard it and start over");

    // A second "Retry Preparation" click, with the result STILL gone.
    await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();
    job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "failed");
    assert.equal(submitCount(), 1, "a permanently-gone result must never be silently papered over with a fresh paid submission, no matter how many retries");
  });
});
