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

  it("1: download failing on every bounded attempt fails the job honestly and preserves the paid provider request id", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildResumableFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    setDownloadMode("fail_transiently"); // fails EVERY attempt within the bounded local retry too

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
    const { errorCalls } = await captureConsoleError(() => worker.processNextJob());

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job?.status, "failed");
    assert.match(job?.lastError ?? "", /could not be fetched/i);
    assert.equal(job?.providerKey, "topaz_transparency_upscale", "provider identity must be preserved, never cleared, for a download failure");
    assert.equal(job?.providerRequestId, LIVE_INCIDENT_PROCESS_ID, "the paid request id must be preserved so a retry can resume it");
    assert.equal(submitCount(), 1, "exactly one paid submission, despite the download failing");

    // --- Phase 4 observability -------------------------------------------
    assert.equal(errorCalls.length, 1, "exactly one failure log for this one failed job");
    const [, details] = errorCalls[0] as [string, Record<string, unknown>];
    assert.equal(details.projectId, projectId);
    assert.equal(details.finalArtworkJobId, requested.job.id);
    assert.equal(details.providerKey, "topaz_transparency_upscale");
    assert.equal(details.providerRequestId, LIVE_INCIDENT_PROCESS_ID);
    assert.equal(details.stage, "download");
    assert.match(String(details.sanitizedError), /could not be fetched/i);
    assert.equal(details.submittedNewPaidRequest, true, "this attempt genuinely made the one fresh submission");
    assert.equal(details.attemptedResume, false, "this was a first attempt, not a resume");
    // Never a secret, a URL, or a stack trace.
    assert.doesNotMatch(JSON.stringify(details), /test-key-not-real/);
    assert.doesNotMatch(JSON.stringify(details), /cdn\.example\.com/);
  });

  it("2: retrying after that failure resumes the SAME job and SAME provider request, and a since-recovered download completes it -- zero duplicate paid submissions", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, setDownloadMode } = buildResumableFakeTopazFetch(
      expectedRequest.widthPx,
      expectedRequest.heightPx,
    );
    setDownloadMode("fail_transiently");

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
    const failed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(failed?.status, "failed");

    // The user clicks "Retry Preparation" -- the SAME action that started
    // finalization, reviving the SAME job (Goal 21: no separate retry
    // endpoint). The underlying condition has since cleared.
    setDownloadMode("succeed");
    const retried = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(retried.job.id, requested.job.id, "retry must revive the SAME job, never create a new one");

    await worker.processNextJob();

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
