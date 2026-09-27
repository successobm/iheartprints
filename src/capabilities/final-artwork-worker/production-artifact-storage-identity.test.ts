import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { StrictUniqueKeyAssetStorageProvider } from "@/capabilities/asset-storage";
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
import {
  GOLDEN_PRODUCTION_ARTIFACT_STEMS,
  productionArtifactStorageFileStem,
} from "@/capabilities/final-artwork/production-artifact-storage-identity";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Provider Intermediate Storage-Key Collision Repair.
 *
 * LIVE INCIDENT (controlled production acceptance of the short-bounded
 * FinalArtwork worker, prepared-upload job `67816e21…`): the worker
 * advanced cleanly through `provider_download_completed` ->
 * `provider_result_intermediate_persisted`, then the NEXT batch reached
 * `normalize_completed` -> `production_asset_upload_started` and died with
 *
 *   uploadProductionAsset.storageUpload failed after 1324ms:
 *   The resource already exists
 *
 * leaving 1 provider-result intermediate, 0 authoritative production
 * assets, and a `failed` job. Root cause: the provider-result intermediate
 * and the authoritative final plate were BOTH uploaded under the same
 * `conceptId` (`prepared-upload-${artworkPreparationId}`) and the same
 * `production.png` filename, so `buildObjectKey` resolved both to the
 * single physical object
 *
 *   projects/<projectId>/concepts/prepared-upload-<prepId>/production.png
 *
 * Storage is create-only (`upsert: false`), so whichever logically
 * distinct artifact wrote first permanently blocked the other. The
 * short-step worker made this reachable by splitting provider download and
 * normalization into separate durable stages — before the split, the
 * intermediate and the plate were never both written in one job's life.
 *
 * Every test here therefore runs on `StrictUniqueKeyAssetStorageProvider`,
 * which reproduces Supabase Storage's real `upsert: false` semantics. The
 * overwrite-friendly filesystem/data-URI providers every other worker suite
 * uses are exactly what hid this class of defect — they must never be
 * substituted back in here.
 *
 * NO REAL NETWORK, no production data, no provider calls: each `fetchImpl`
 * answers only its own fake Topaz endpoints and throws on anything else.
 */

const CANVAS_PX = 1200;

function preparedTransparentPngOfWidth(artworkWidthPx: number): Buffer {
  const png = new PNG({ width: CANVAS_PX, height: CANVAS_PX });
  const inset = Math.floor((CANVAS_PX - artworkWidthPx) / 2);
  for (let y = 0; y < CANVAS_PX; y += 1) {
    for (let x = 0; x < CANVAS_PX; x += 1) {
      const idx = (CANVAS_PX * y + x) << 2;
      const inArtwork =
        x >= inset && x < inset + artworkWidthPx && y >= inset && y < inset + artworkWidthPx;
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
  if (outcome.status !== "resolved") {
    throw new Error(`fixture is not reconstructible: ${outcome.status}`);
  }
  return outcome.request;
}

/** Pedro's own shape: an existing paid request this repair must never resubmit. */
const EXISTING_PAID_PROCESS_ID = "01a0d701-storage-identity-fixture";

function buildFakeTopazFetch(
  reconstructedWidthPx: number,
  reconstructedHeightPx: number,
  insetRatio: number = 400 / CANVAS_PX,
) {
  let submitCount = 0;
  let downloadCount = 0;

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/tool/async")) {
      submitCount += 1;
      return new Response(JSON.stringify({ process_id: EXISTING_PAID_PROCESS_ID }), {
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
      return new Response(JSON.stringify({ url: "https://cdn.example.com/storage-identity.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://cdn.example.com/storage-identity.png") {
      downloadCount += 1;
      const png = new PNG({ width: reconstructedWidthPx, height: reconstructedHeightPx });
      const visibleWidthPx = Math.round(reconstructedWidthPx * insetRatio);
      const visibleHeightPx = Math.round(reconstructedHeightPx * insetRatio);
      const insetX = Math.floor((reconstructedWidthPx - visibleWidthPx) / 2);
      const insetY = Math.floor((reconstructedHeightPx - visibleHeightPx) / 2);
      for (let y = 0; y < reconstructedHeightPx; y += 1) {
        for (let x = 0; x < reconstructedWidthPx; x += 1) {
          const idx = (reconstructedWidthPx * y + x) << 2;
          const inArtwork =
            x >= insetX &&
            x < insetX + visibleWidthPx &&
            y >= insetY &&
            y < insetY + visibleHeightPx;
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
    submitCount: () => submitCount,
    downloadCount: () => downloadCount,
  };
}

function opaquePngOf(widthPx: number, heightPx: number): Buffer {
  const png = new PNG({ width: widthPx, height: heightPx });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 90;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A fake Topaz endpoint set that mints a FRESH process id per submission —
 * what the double-shrink fixture needs, since its whole point is a job that
 * self-heals off a stale request and submits a genuinely new one. Mirrors
 * `stale-provider-result-intermediate.test.ts`'s own fake (generously-sized
 * fixed output canvas, so every target this drives to still
 * geometry-validates).
 */
function buildFreshPerSubmissionFakeTopazFetch() {
  let submitCount = 0;
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/tool/async")) {
      submitCount += 1;
      return new Response(JSON.stringify({ process_id: `fresh-process-${submitCount}` }), {
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
      const processId = url.split("/download/")[1]!;
      return new Response(JSON.stringify({ url: `https://cdn.example.com/fresh-${processId}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/^https:\/\/cdn\.example\.com\/fresh-.+\.png$/.test(url)) {
      return new Response(new Uint8Array(opaquePngOf(4000, 4000)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
  }) as typeof fetch;
  return { fetchImpl: impl, submitCount: () => submitCount };
}

describe("Provider Intermediate Storage-Key Collision Repair -- production-artifact storage identity under upsert:false", () => {
  let tempDir = "";
  let previousCwd = "";

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-storage-identity-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function setupPreparedUpload(artworkWidthPx: number, confirmedWidthIn = 3) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

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

    const bytes = preparedTransparentPngOfWidth(artworkWidthPx);
    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "storage-identity-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "storage-identity-fixture.png",
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
    await confirmProductionSizeForTests(repo, projectId, { widthIn: confirmedWidthIn });

    return { repo, assets, storage, projectId, preparationId: preparation.id };
  }

  /**
   * The exact production incident, end to end, on create-only storage: a
   * prepared-upload job with an ALREADY-PAID provider request resumes,
   * checkpoints its provider status, downloads and durably persists the
   * provider-result intermediate, then normalizes and uploads the
   * authoritative plate.
   *
   * Before the repair this reproduced the live failure verbatim. After the
   * repair the same four invocations converge, because the intermediate and
   * the plate no longer share one physical object key.
   */
  it("the live incident: resumed prepared-upload job persists a provider-result intermediate, then uploads its authoritative plate -- the two must occupy DISTINCT physical storage keys and the job must converge", async () => {
    const { repo, assets, storage, projectId, preparationId } = await setupPreparedUpload(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, downloadCount } = buildFakeTopazFetch(
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
    // Pedro's shape exactly: an existing, already-PAID provider request.
    await repo.updateFinalArtworkJob(requested.job.id, {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: EXISTING_PAID_PROCESS_ID,
      providerStatus: "submitted",
    });

    // Invocation 1: status check -> result_ready checkpoint.
    await worker.processNextJob();
    const afterStatus = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterStatus?.providerStatus, "result_ready");

    // Invocation 2: download -> provider-result intermediate persisted.
    await worker.processNextJob();
    const afterDownload = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(
      afterDownload?.status,
      "recoverable",
      "the intermediate persists cleanly -- the collision was never on THIS write",
    );
    const intermediates = (
      await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)
    ).filter(isProviderResultIntermediateAsset);
    assert.equal(intermediates.length, 1, "exactly one provider-result intermediate");
    const intermediateKey = intermediates[0]!.storageKey;
    assert.ok(
      storage.has(intermediateKey!),
      "the intermediate's bytes genuinely landed in create-only storage",
    );

    // Invocation 3: readback -> normalize -> upload the authoritative plate.
    // THIS is where production died with "The resource already exists".
    await worker.processNextJob();
    const afterUpload = await repo.getFinalArtworkJob(requested.job.id);
    assert.notEqual(
      afterUpload?.status,
      "failed",
      `the authoritative plate upload must not collide with its own job's intermediate; lastError=${afterUpload?.lastError ?? "(none)"}`,
    );

    const finalPlates = (
      await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)
    ).filter(
      (asset) =>
        asset.productionRole === "production_png" &&
        !isProviderResultIntermediateAsset(asset) &&
        !isReconstructionIntermediateAsset(asset),
    );
    assert.equal(finalPlates.length, 1, "exactly one authoritative production plate");
    const finalPlateKey = finalPlates[0]!.storageKey;

    // The contract this repair exists to establish.
    assert.notEqual(
      finalPlateKey,
      intermediateKey,
      "the provider-result intermediate and the authoritative plate must never share one physical storage object",
    );
    assert.ok(
      storage.has(intermediateKey!),
      "the historical intermediate's bytes are still intact -- never overwritten, never deleted to make room",
    );
    assert.ok(storage.has(finalPlateKey!), "the authoritative plate's bytes genuinely landed");
    assert.ok(
      intermediateKey!.includes(`prepared-upload-${preparationId}`),
      "both artifacts stay grouped under the same stable internal preparation grouping -- the fix separates artifact CLASS, not the job's grouping",
    );
    assert.ok(finalPlateKey!.includes(`prepared-upload-${preparationId}`));

    // Invocation 4: validation -> transition -> completed.
    await worker.processNextJob();
    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed", "the job converges");

    // Provider discipline is untouched by this repair.
    assert.equal(submitCount(), 0, "a resumed paid request is never resubmitted");
    assert.equal(downloadCount(), 1, "exactly one provider download across the whole lifecycle");

    // The intermediate never becomes the customer's deliverable.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, requested.job.id);
    assert.ok(validation);
    assert.equal(
      validation!.assetId,
      finalPlates[0]!.id,
      "validation attaches to the authoritative plate, never to the intermediate",
    );
  });

  /**
   * THE DEPLOYMENT SHAPE. Independent-review finding: the live-incident
   * test above reproduces the failure from scratch, so by the time its
   * plate uploads, its intermediate already sits at the NEW
   * `provider-result-intermediate-{digest}.png` key. The job this repair
   * exists to rescue does not look like that — its intermediate was
   * written by the PRE-REPAIR code and sits at the LEGACY bare
   * `.../production.png`, which is exactly the key the plate used to want.
   *
   * That is the case that must work on the day this deploys, so it is
   * pinned here rather than reasoned about: the legacy intermediate is
   * adopted from its DB row (never from a recomputed path), its bytes are
   * read back from the legacy key untouched, the plate lands somewhere
   * else, and no provider is contacted.
   */
  it("legacy intermediate at the pre-repair `production.png` key: adopted from its DB row, read back intact, and the new plate lands elsewhere -- zero provider calls", async () => {
    const { repo, assets, storage, projectId, preparationId } = await setupPreparedUpload(400);
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, submitCount, downloadCount } = buildFakeTopazFetch(
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
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      provider,
      createPrintValidationCapability(),
    );

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await repo.updateFinalArtworkJob(requested.job.id, {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: EXISTING_PAID_PROCESS_ID,
      providerStatus: "submitted",
    });

    // Claims 1-2 produce a GENUINE worker-written intermediate, so its
    // durable identity metadata is real rather than hand-authored.
    await worker.processNextJob();
    await worker.processNextJob();
    const genuine = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).find(
      isProviderResultIntermediateAsset,
    );
    assert.ok(genuine, "a genuine provider-result intermediate was persisted");

    // Rewrite it into the PRE-REPAIR shape: same bytes, same identity
    // metadata, but living at the bare legacy key the old code produced.
    const intermediateBytes = await storage.download(genuine!.storageKey!);
    await storage.delete(genuine!.storageKey!);
    await assets.deleteAsset(genuine!.id);
    const legacy = await assets.uploadProductionAsset(projectId, {
      conceptId: `prepared-upload-${preparationId}`,
      // Deliberately omitted -- this is what the pre-repair code did.
      bytes: intermediateBytes,
      contentType: "image/png",
      widthPx: genuine!.widthPx,
      heightPx: genuine!.heightPx,
      hasTransparency: true,
      finalArtworkJobId: requested.job.id,
      productionRole: "production_png",
      metadata: genuine!.metadata as Record<string, unknown>,
    });
    const legacyKey = `projects/${projectId}/concepts/prepared-upload-${preparationId}/production.png`;
    assert.equal(legacy.storageKey, legacyKey, "the fixture really is at the pre-repair key");

    // Claim 3: readback + normalize + upload the plate.
    await worker.processNextJob();
    const afterUpload = await repo.getFinalArtworkJob(requested.job.id);
    assert.notEqual(
      afterUpload?.status,
      "failed",
      `the plate must not collide with a LEGACY-keyed intermediate; lastError=${afterUpload?.lastError ?? "(none)"}`,
    );

    const plates = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (asset) =>
        asset.productionRole === "production_png" &&
        !isProviderResultIntermediateAsset(asset) &&
        !isReconstructionIntermediateAsset(asset),
    );
    assert.equal(plates.length, 1, "exactly one authoritative plate");
    assert.notEqual(plates[0]!.storageKey, legacyKey, "the plate never wants the legacy key again");
    assert.deepEqual(
      await storage.download(legacyKey),
      intermediateBytes,
      "the legacy intermediate's bytes are untouched -- adopted by DB row, never overwritten or re-keyed",
    );

    // Claim 4: validation -> completed.
    await worker.processNextJob();
    assert.equal((await repo.getFinalArtworkJob(requested.job.id))?.status, "completed");
    assert.equal(submitCount(), 0, "a legacy-keyed resume submits nothing");
    assert.equal(downloadCount(), 1, "and re-downloads nothing after its original download");
  });

  /**
   * Double-Shrink Repair, now on create-only storage: the SAME paid
   * provider result is legitimately re-persisted as a SECOND intermediate
   * when the confirmed production envelope changes underneath an in-flight
   * job, and a self-healed job submits a genuinely new request whose result
   * is a THIRD. Under the old single-key scheme every one of those writes
   * after the first was a hard "The resource already exists"; the data-URI
   * backend the pre-existing stale-intermediate suite runs on could never
   * have caught it.
   */
  it("double shrink: an envelope change mid-flight persists a SECOND provider-result intermediate at its own key -- no collision, and the first intermediate survives byte-intact as historical evidence", async () => {
    const { repo, assets, storage, projectId } = await setupPreparedUpload(400);
    const { fetchImpl, submitCount } = buildFreshPerSubmissionFakeTopazFetch();

    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      provider,
      createPrintValidationCapability(),
    );

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    // Claims 1-2: submit + status, then download -> intermediate #1, all
    // under the ORIGINAL confirmed envelope.
    await worker.processNextJob();
    await worker.processNextJob();
    const firstIntermediates = (
      await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)
    ).filter(isProviderResultIntermediateAsset);
    assert.equal(firstIntermediates.length, 1);
    const firstKey = firstIntermediates[0]!.storageKey!;
    const firstBytes = await storage.download(firstKey);

    // The confirmed envelope GROWS underneath the in-flight job -- same
    // width (so the job is not superseded), materially different confirmed
    // box max height. The recorded intermediate is now stale.
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 3, boxMaxHeightIn: 8 });

    // Claim 3 self-heals and resubmits for the NEW target; claim 4 downloads
    // it and persists intermediate #2. Under the old scheme claim 4 died.
    await worker.processNextJob();
    await worker.processNextJob();

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.notEqual(
      job?.status,
      "failed",
      `the second intermediate must not collide with the first; lastError=${job?.lastError ?? "(none)"}`,
    );
    assert.equal(submitCount(), 2, "exactly one genuinely new submission for the new target");

    const allIntermediates = (
      await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)
    ).filter(isProviderResultIntermediateAsset);
    assert.equal(allIntermediates.length, 2, "both intermediates are durably recorded");
    const keys = new Set(allIntermediates.map((a) => a.storageKey));
    assert.equal(keys.size, 2, "two logically distinct intermediates occupy two physical objects");
    assert.deepEqual(
      await storage.download(firstKey),
      firstBytes,
      "the first envelope's intermediate is byte-identical -- never overwritten to make room for the second",
    );
  });

  /**
   * Retry idempotency, proven at the boundary this repair actually changed.
   * A deterministic stem is the whole basis for
   * `uploadStorageWithSelfHealAndBoundedRetry`'s "did my own prior attempt
   * already land here?" check: re-uploading the SAME logical artifact must
   * recompute the SAME key and adopt the landed object rather than throwing
   * — while a DIFFERENT logical artifact in the same grouping must get its
   * own object.
   */
  it("same-artifact retry is idempotent and cross-artifact writes are separate: one grouping holds a pass-1 intermediate, a provider-result intermediate and a plate, each retryable onto its own object", async () => {
    const { repo, assets, storage, projectId } = await setupPreparedUpload(400);
    const grouping = "prepared-upload-shared-grouping";
    const bytes = preparedTransparentPngOfWidth(400);

    const stems = {
      pass1: productionArtifactStorageFileStem({
        artifactClass: "pass1_intermediate",
        identity: ["topaz_transparency_upscale", "request-a"],
      }),
      providerResult: productionArtifactStorageFileStem({
        artifactClass: "provider_result_intermediate",
        identity: ["request-a", "topaz_transparency_upscale", "asset-1", "sha-1", 3, null],
      }),
      plate: productionArtifactStorageFileStem({
        artifactClass: "final_plate",
        identity: ["asset-1", "reconstructed", "request-a", 900, 900],
      }),
    };

    async function upload(stem: string, jobId: string) {
      return assets.uploadProductionAsset(projectId, {
        conceptId: grouping,
        storageArtifactFileStem: stem,
        bytes,
        contentType: "image/png",
        widthPx: CANVAS_PX,
        heightPx: CANVAS_PX,
        hasTransparency: true,
        finalArtworkJobId: jobId,
        productionRole: "production_png",
        metadata: {},
      });
    }

    const uploadedKeys: string[] = [];
    for (const [label, stem] of Object.entries(stems)) {
      const asset = await upload(stem, `job-${label}`);
      uploadedKeys.push(asset.storageKey!);
    }
    assert.equal(
      new Set(uploadedKeys).size,
      3,
      "three semantically distinct artifacts in ONE grouping folder occupy three physical objects",
    );

    // Same logical artifact, uploaded again (the crash-between-storage-and-
    // DB shape): the deterministic key means the prior bytes are found and
    // adopted -- no throw, same object, no duplicate storage write.
    const uploadsBeforeRetry = storage.uploadCount;
    const retried = await upload(stems.providerResult, "job-providerResult");
    assert.equal(
      retried.storageKey,
      uploadedKeys[1],
      "a retry of the SAME logical artifact resolves to the SAME physical object",
    );
    assert.equal(
      storage.uploadCount,
      uploadsBeforeRetry,
      "create-only storage accepted no second write -- the landed object was adopted",
    );

    const retriedPlate = await upload(stems.plate, "job-plate");
    assert.equal(retriedPlate.storageKey, uploadedKeys[2], "the plate retry is equally idempotent");

    // Independent-review finding: `uploadProductionAsset` still creates a
    // row per call, so storage idempotency is NOT row idempotency. Asserted
    // rather than glossed, so the division of responsibility stays explicit:
    // this layer guarantees one OBJECT per logical artifact, and each
    // caller's own durable adoption check (`resolveExistingProductionAsset`,
    // `resolveExistingProviderResultIntermediate`) is what keeps it from
    // reaching here twice for the same artifact in the first place.
    const rowsForRetriedArtifact = (
      await repo.listAssetsForFinalArtworkJob(projectId, "job-providerResult")
    ).filter((a) => a.storageKey === uploadedKeys[1]);
    assert.equal(
      rowsForRetriedArtifact.length,
      2,
      "two rows, ONE object -- the bytes were never duplicated, which is this layer's guarantee",
    );
  });
});

describe("Provider Intermediate Storage-Key Collision Repair -- the storage-identity contract itself", () => {
  it("is deterministic: the same (class, identity) always yields the same stem", () => {
    const identity = ["request-a", "topaz", "asset-1", "sha-1", 10.5, null];
    assert.equal(
      productionArtifactStorageFileStem({ artifactClass: "provider_result_intermediate", identity }),
      productionArtifactStorageFileStem({ artifactClass: "provider_result_intermediate", identity }),
      "no clock, counter or random term may enter a production artifact's storage key",
    );
  });

  it("separates artifact CLASSES even when their identity tuples are identical", () => {
    const identity = ["same", "identity", "tuple"];
    const stems = (
      ["pass1_intermediate", "provider_result_intermediate", "final_plate"] as const
    ).map((artifactClass) => productionArtifactStorageFileStem({ artifactClass, identity }));
    assert.equal(new Set(stems).size, 3, "the live incident's exact failure mode: class must be part of identity");
  });

  it("separates IDENTITIES within one class -- including a changed envelope, a changed source and a changed request", () => {
    const base = ["request-a", "topaz", "asset-1", "sha-1", 10.5, 10.5] as const;
    const variants = [
      [...base],
      ["request-b", "topaz", "asset-1", "sha-1", 10.5, 10.5],
      ["request-a", "topaz", "asset-2", "sha-1", 10.5, 10.5],
      ["request-a", "topaz", "asset-1", "sha-2", 10.5, 10.5],
      ["request-a", "topaz", "asset-1", "sha-1", 14, 10.5],
      ["request-a", "topaz", "asset-1", "sha-1", 10.5, 14],
    ];
    const stems = variants.map((identity) =>
      productionArtifactStorageFileStem({ artifactClass: "provider_result_intermediate", identity }),
    );
    assert.equal(new Set(stems).size, variants.length, "every identity dimension must move the key");
  });

  it("never collapses distinguishable identity values: null, undefined, a number and their string spellings are all different keys", () => {
    const stems = [
      [null],
      [undefined],
      [10.5],
      ["10.5"],
      ["null"],
      ["a", "b"],
      ["ab"],
    ].map((identity) => productionArtifactStorageFileStem({ artifactClass: "final_plate", identity }));
    assert.equal(
      new Set(stems).size,
      stems.length,
      "a naive join would alias an absent confirmed height with the literal string 'null', and ['a','b'] with ['ab']",
    );
  });

  /**
   * The encoding's field separator is a byte that cannot appear inside an
   * identity value, and it is BUILT (`String.fromCharCode`) rather than
   * written into the source, precisely because a literal or an escape for
   * it is the kind of thing a formatter, an editor or a careless cleanup
   * silently removes. Nothing would throw if that happened: every other
   * test in this file asserts only self-consistency and pairwise
   * distinctness, all of which still hold under a different separator.
   *
   * What would happen instead is worse and silent — every already-written
   * object becomes unfindable, a job that crashed between its storage write
   * and its `createAsset` row recomputes a DIFFERENT key on resume, and the
   * earlier object is orphaned with no cleanup path able to reach it. These
   * literal expected stems are the tripwire for that.
   */
  it("golden stems: the encoding produces these exact keys -- a silent change to it strands every object already written", () => {
    for (const golden of GOLDEN_PRODUCTION_ARTIFACT_STEMS) {
      assert.equal(
        productionArtifactStorageFileStem({
          artifactClass: golden.artifactClass,
          identity: golden.identity,
        }),
        golden.stem,
        `${golden.artifactClass}: changing an artifact's storage identity strands every object written under the old one -- this needs a deliberate decision and a migration story for in-flight jobs, never a fixture update`,
      );
    }
  });

  /**
   * A field boundary must be impossible to forge from a field's own
   * CONTENT. This is not hypothetical bookkeeping: an earlier draft of this
   * encoding used a control-byte separator, and this exact test caught that
   * `["a", "b"]` and `["a<sep>s:b"]` hashed identically — any separator a
   * value can contain, a value can smuggle. Length prefixing removed the
   * hole entirely; these cases pin that it stays removed.
   */
  it("a field's own content can never forge a field boundary", () => {
    const tuples: readonly (readonly unknown[])[] = [
      ["a", "b"],
      ["ab"],
      ["a", "", "b"],
      ["", "ab"],
      ["3:s:x"],
      ["3", "s:x"],
      ["s:a", "s:b"],
      ["s:as:b"],
    ];
    const stems = tuples.map((identity) =>
      productionArtifactStorageFileStem({ artifactClass: "final_plate", identity }),
    );
    assert.equal(new Set(stems).size, tuples.length, "every distinct tuple must hash distinctly");
  });

  it("encodes a non-primitive identity value faithfully rather than collapsing it to null", () => {
    // `sourceBytesSha256` arrives typed `unknown`; the adoption check
    // compares it raw, so the key must not be coarser than that comparison.
    const stems = [{ a: 1 }, { a: 2 }, null, "[object Object]"].map((identity) =>
      productionArtifactStorageFileStem({
        artifactClass: "provider_result_intermediate",
        identity: [identity],
      }),
    );
    assert.equal(new Set(stems).size, 4);
  });

  it("keeps the authoritative plate recognizable in a storage listing", () => {
    assert.match(
      productionArtifactStorageFileStem({ artifactClass: "final_plate", identity: ["x"] }),
      /^production-[0-9a-f]{12}$/,
    );
    assert.match(
      productionArtifactStorageFileStem({ artifactClass: "provider_result_intermediate", identity: ["x"] }),
      /^provider-result-intermediate-[0-9a-f]{12}$/,
    );
    assert.match(
      productionArtifactStorageFileStem({ artifactClass: "pass1_intermediate", identity: ["x"] }),
      /^pass1-intermediate-[0-9a-f]{12}$/,
    );
  });
});
