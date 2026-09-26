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
} from "@/capabilities/final-artwork/production-request-identity";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Bounded FinalArtwork Production-Execution Repair (short-step follow-up) —
 * the two deliverables the implementation contract calls out by name:
 *
 *   1. THE MANDATORY TOPAZ TEST — proves the exact four-invocation state
 *      machine (status -> download -> normalize/upload -> finalize) for
 *      both a RESUME fixture (an existing paid request) and a FRESH
 *      submission fixture, with the exact assertions the contract lists.
 *   2. THE PEDRO-SHAPE REGRESSION — a SYNTHETIC fixture approximating the
 *      real incident's geometry (alpha bounds ~2997x2461, aspect ~1.22:1,
 *      confirmed width 11in) — never production data, never Pedro's actual
 *      bytes — proving the full multi-invocation lifecycle converges
 *      correctly for that exact shape.
 *
 * NO REAL NETWORK: every `fetchImpl` here only ever answers its own known
 * fake Topaz endpoints and throws on anything else. No production writes,
 * no real provider calls, Pedro's own job/bytes are never touched or read.
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

const FIXED_PROCESS_ID = "01a0d701-mandatory-test-process-id";

/** A fake Topaz endpoint set whose status can be reconfigured between claims. */
function buildFakeTopazFetch(reconstructedWidthPx: number, reconstructedHeightPx: number) {
  let submitCount = 0;
  let statusCallCount = 0;
  let downloadCount = 0;
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
      return new Response(JSON.stringify({ url: "https://cdn.example.com/mandatory-output.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://cdn.example.com/mandatory-output.png") {
      downloadCount += 1;
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
    downloadCount: () => downloadCount,
    setStatusMode: (mode: typeof statusMode) => {
      statusMode = mode;
    },
  };
}

describe("Bounded FinalArtwork Production-Execution Repair -- mandatory Topaz lifecycle + Pedro-shape regression", () => {
  let tempDir = "";
  let previousCwd = "";

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-mandatory-lifecycle-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function setupPreparedUpload(
    artworkWidthPx: number,
    options: { placement?: "sleeve" | "full_front"; confirmedWidthIn?: number } = {},
  ) {
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
      printPlacement: options.placement ?? "sleeve",
    });

    const bytes = preparedTransparentPngOfWidth(artworkWidthPx);
    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "mandatory-lifecycle-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "mandatory-lifecycle-fixture.png",
      analysis: { widthPx: CANVAS_PX, heightPx: CANVAS_PX },
    });
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes,
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
    await confirmProductionSizeForTests(repo, projectId, { widthIn: options.confirmedWidthIn ?? 3 });

    return { repo, assets, projectId };
  }

  describe("MANDATORY TOPAZ TEST", () => {
    it("resume fixture: invocation 1 (status -> result_ready), 2 (download -> intermediate), 3 (normalize/upload -> production asset), 4 (validate/transition/complete) -- zero fresh submissions, provider request id unchanged, one download, one intermediate, one production asset", async () => {
      const { repo, assets, projectId } = await setupPreparedUpload(400);
      const expectedRequest = expectedReconstructionRequest(400);
      const { fetchImpl, submitCount, statusCallCount, downloadCount, setStatusMode } = buildFakeTopazFetch(
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
      // Seed an EXISTING paid provider request -- the "resume fixture": this
      // job already has a durable, matching providerKey/providerRequestId,
      // exactly like Pedro's real job.
      await repo.updateFinalArtworkJob(requested.job.id, {
        providerKey: "topaz_transparency_upscale",
        providerRequestId: FIXED_PROCESS_ID,
        providerStatus: "submitted",
      });
      setStatusMode("completed"); // Topaz already finished on its own side.

      // Invocation 1: existing provider request -> status check -> Completed
      // -> durable provider-status checkpoint -> RETURN. No download.
      await worker.processNextJob();
      const afterInvocation1 = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterInvocation1?.status, "recoverable");
      assert.equal(afterInvocation1?.providerStatus, "result_ready");
      assert.equal(afterInvocation1?.providerRequestId, FIXED_PROCESS_ID, "provider request id unchanged");
      assert.equal(submitCount(), 0, "resume fixture: submit count = 0");
      assert.equal(downloadCount(), 0, "invocation 1 must never download");
      const statusCallsAfterInvocation1 = statusCallCount();

      // Invocation 2: same request -> download exactly once -> provider-
      // result intermediate persisted -> checkpoint -> RETURN.
      await worker.processNextJob();
      const afterInvocation2 = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterInvocation2?.status, "recoverable");
      assert.equal(downloadCount(), 1, "download count = 1");
      assert.equal(statusCallCount(), statusCallsAfterInvocation1, "provider status-call count does not repeat after the durable completion checkpoint");
      const assetsAfterInvocation2 = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
      const intermediateAssets = assetsAfterInvocation2.filter(isProviderResultIntermediateAsset);
      assert.equal(intermediateAssets.length, 1, "intermediate asset count = 1");

      // Invocation 3: same intermediate -> NO provider status call, NO
      // provider download -> normalize/upload production asset ->
      // checkpoint -> RETURN.
      await worker.processNextJob();
      const afterInvocation3 = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterInvocation3?.status, "recoverable");
      assert.equal(statusCallCount(), statusCallsAfterInvocation1, "invocation 3 makes no additional status call");
      assert.equal(downloadCount(), 1, "invocation 3 makes no additional download call");
      const assetsAfterInvocation3 = await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id);
      const productionAssets = assetsAfterInvocation3.filter(
        (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
      );
      assert.equal(productionAssets.length, 1, "production asset count = 1");
      const validationAfterInvocation3 = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
      assert.equal(validationAfterInvocation3, null, "invocation 3 must not validate");

      // Invocation 4: same production asset -> validation -> project
      // transition -> completed.
      await worker.processNextJob();
      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "completed", "job completed");
      assert.equal(submitCount(), 0, "still zero submissions across the entire lifecycle");
      assert.equal(downloadCount(), 1, "still exactly one download across the entire lifecycle");

      const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
      assert.ok(validation, "validation correct");

      const project = await repo.getProject(projectId);
      assert.notEqual(project?.project.status, "finalizing", "project transitioned");

      const finalProductionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
        (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
      );
      assert.equal(finalProductionAssets.length, 1, "still exactly one production asset -- never duplicated");
    });

    it("fresh submission fixture: submit count = 1 maximum across the entire lifecycle", async () => {
      const { repo, assets, projectId } = await setupPreparedUpload(400);
      const expectedRequest = expectedReconstructionRequest(400);
      const { fetchImpl, submitCount, setStatusMode } = buildFakeTopazFetch(
        expectedRequest.widthPx,
        expectedRequest.heightPx,
      );
      setStatusMode("completed"); // completes on the very first check, proving the checkpoint fires even then.

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

      await worker.processNextJob(); // submit + status -> result_ready checkpoint
      assert.equal(submitCount(), 1);
      await worker.processNextJob(); // download -> intermediate checkpoint
      assert.equal(submitCount(), 1, "submit count = 1 maximum across the entire lifecycle");
      await worker.processNextJob(); // normalize/upload -> production-asset checkpoint
      assert.equal(submitCount(), 1);
      await worker.processNextJob(); // finalize
      assert.equal(submitCount(), 1, "submit count = 1 maximum across the entire lifecycle");

      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "completed");

      const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
      assert.ok(validation);
    });
  });

  describe("PEDRO-SHAPE REGRESSION (synthetic fixture -- never production data, never Pedro's own bytes)", () => {
    /**
     * Approximates the real incident's geometry: alpha bounds ~2997x2461
     * (aspect ~1.22:1), confirmed width 11in. Built on a canvas comfortably
     * larger than the visible region, exactly like `preparedTransparentPngOfWidth`
     * models every other fixture in this file, just non-square.
     */
    const PEDRO_CANVAS_WIDTH_PX = 3400;
    const PEDRO_CANVAS_HEIGHT_PX = 2800;
    const PEDRO_VISIBLE_WIDTH_PX = 2997;
    const PEDRO_VISIBLE_HEIGHT_PX = 2461; // 2997 / 2461 ~= 1.2178

    function pedroShapedPng(): Buffer {
      const png = new PNG({ width: PEDRO_CANVAS_WIDTH_PX, height: PEDRO_CANVAS_HEIGHT_PX });
      const insetX = Math.floor((PEDRO_CANVAS_WIDTH_PX - PEDRO_VISIBLE_WIDTH_PX) / 2);
      const insetY = Math.floor((PEDRO_CANVAS_HEIGHT_PX - PEDRO_VISIBLE_HEIGHT_PX) / 2);
      for (let y = 0; y < PEDRO_CANVAS_HEIGHT_PX; y += 1) {
        for (let x = 0; x < PEDRO_CANVAS_WIDTH_PX; x += 1) {
          const idx = (PEDRO_CANVAS_WIDTH_PX * y + x) << 2;
          const inArtwork =
            x >= insetX && x < insetX + PEDRO_VISIBLE_WIDTH_PX && y >= insetY && y < insetY + PEDRO_VISIBLE_HEIGHT_PX;
          png.data[idx] = 40;
          png.data[idx + 1] = 60;
          png.data[idx + 2] = 120;
          png.data[idx + 3] = inArtwork ? 255 : 0;
        }
      }
      return PNG.sync.write(png);
    }

    async function setupPedroShapedProject() {
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
        printPlacement: "full_front",
      });

      const bytes = pedroShapedPng();
      const original = await assets.uploadCustomerArtwork(projectId, {
        conceptId: "upload-original",
        bytes,
        contentType: "image/png",
        widthPx: PEDRO_CANVAS_WIDTH_PX,
        heightPx: PEDRO_CANVAS_HEIGHT_PX,
        hasTransparency: false,
        kind: "customer_upload",
        metadata: { originalFilename: "pedro-shape-fixture.png" },
      });
      const preparation = await repo.createArtworkPreparation(projectId, {
        originalAssetId: original.id,
        originalFilename: "pedro-shape-fixture.png",
        analysis: { widthPx: PEDRO_CANVAS_WIDTH_PX, heightPx: PEDRO_CANVAS_HEIGHT_PX },
      });
      const prepared = await assets.uploadCustomerArtwork(projectId, {
        conceptId: `prepared-${preparation.id}`,
        bytes,
        contentType: "image/png",
        widthPx: PEDRO_CANVAS_WIDTH_PX,
        heightPx: PEDRO_CANVAS_HEIGHT_PX,
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
      // Confirmed width 11in -- exactly Pedro's real confirmed width.
      await confirmProductionSizeForTests(repo, projectId, { widthIn: 11 });

      return { repo, assets, projectId, original, prepared };
    }

    it("converges to print-ready across the full multi-invocation lifecycle: same request id, one submission maximum, one intermediate, one production asset, no geometry loop, correct validation, completed job", async () => {
      const { repo, assets, projectId, prepared } = await setupPedroShapedProject();

      // An "echo back exactly what was requested" fake -- mirrors
      // `bounded-topaz-execution.test.ts`'s own `buildEchoingFakeTopazFetch`
      // pattern: reads the real `output_width`/`output_height` straight off
      // the FormData `TopazTransparencyUpscaleProvider.submit()` builds, so
      // this fixture is honored precisely regardless of exactly how the real
      // sizing/safety-margin pipeline resolves the Pedro-shape request's own
      // pixel target -- no risk of a validation rejection from a
      // hand-computed prediction drifting out of sync with the real
      // pipeline's own arithmetic (this is the exact drift that would
      // otherwise make this fixture flaky).
      let nextProcessSeq = 0;
      const statusByProcessId = new Map<string, "processing" | "completed">();
      const dimsByProcessId = new Map<string, { widthPx: number; heightPx: number }>();
      let submitCountTotal = 0;
      let downloadCountTotal = 0;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/tool/async")) {
          submitCountTotal += 1;
          const form = init?.body as FormData;
          const widthPx = Number(form.get("output_width"));
          const heightPx = Number(form.get("output_height"));
          nextProcessSeq += 1;
          const processId = nextProcessSeq === 1 ? FIXED_PROCESS_ID : `pedro-echo-process-${nextProcessSeq}`;
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
          return new Response(JSON.stringify({ url: `https://cdn.example.com/pedro-echo-${processId}.png` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("https://cdn.example.com/pedro-echo-")) {
          downloadCountTotal += 1;
          const processId = url.slice("https://cdn.example.com/pedro-echo-".length, -".png".length);
          const dims = dimsByProcessId.get(processId)!;
          const insetRatio = PEDRO_VISIBLE_WIDTH_PX / PEDRO_CANVAS_WIDTH_PX;
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
              png.data[idx] = 40;
              png.data[idx + 1] = 60;
              png.data[idx + 2] = 120;
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
      const submitCount = () => submitCountTotal;
      const downloadCount = () => downloadCountTotal;
      const setStatusMode = (mode: "processing" | "completed") => {
        if (mode === "completed") statusByProcessId.set(FIXED_PROCESS_ID, "completed");
      };

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

      // Invocation 1: fresh submit + status check -- still processing,
      // exactly like Pedro's own job sat for a period before completing.
      await worker.processNextJob();
      const afterSubmit = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterSubmit?.status, "recoverable");
      assert.equal(afterSubmit?.providerRequestId, FIXED_PROCESS_ID);
      assert.equal(submitCount(), 1, "one submission maximum");

      // The provider genuinely finishes.
      setStatusMode("completed");

      // Invocation 2: status check -> result_ready checkpoint. Never falls
      // through into downloading in this same call (Repair 3's boundary --
      // the exact boundary whose absence stranded Pedro's real job).
      await worker.processNextJob();
      const afterStatusCheckpoint = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(afterStatusCheckpoint?.status, "recoverable");
      assert.equal(afterStatusCheckpoint?.providerStatus, "result_ready");
      assert.equal(afterStatusCheckpoint?.providerRequestId, FIXED_PROCESS_ID, "same request id");
      assert.equal(downloadCount(), 0);

      // Invocation 3: download -> provider-result intermediate persisted.
      // Never falls through into normalizing in this same call (Repair 4's
      // boundary).
      await worker.processNextJob();
      assert.equal(downloadCount(), 1, "one download");
      const intermediates = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
        isProviderResultIntermediateAsset,
      );
      assert.equal(intermediates.length, 1, "one intermediate -- no duplicate from any geometry-prediction disagreement");

      // Invocation 4: normalize/measure/upload the production asset.
      await worker.processNextJob();
      const productionAssetsBeforeFinalize = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
        (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
      );
      assert.equal(productionAssetsBeforeFinalize.length, 1, "one production asset -- no geometry loop duplicating it");

      // Invocation 5: finalize.
      await worker.processNextJob();
      const job = await repo.getFinalArtworkJob(requested.job.id);
      assert.equal(job?.status, "completed", "completed job");
      assert.equal(submitCount(), 1, "one submission maximum across the entire lifecycle");
      assert.equal(downloadCount(), 1, "one download across the entire lifecycle");

      const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job!.id);
      assert.ok(validation, "correct validation");

      const productionAssetsFinal = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
        (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
      );
      assert.equal(productionAssetsFinal.length, 1, "still exactly one production asset");

      // Sanity: this test never touched the real Pedro project/job/bytes.
      assert.notEqual(projectId, "a26ad90d-2f67-41fa-b2de-1341040141e0");
      assert.notEqual(requested.job.id, "67816e21-fa9a-408f-ac45-916e679fd8c4");
      void prepared;
    });
  });
});
