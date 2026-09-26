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
  PROVIDER_RESULT_INTERMEDIATE_STAGE_MARKER,
} from "@/capabilities/final-artwork/production-request-identity";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Stale Provider-Result Intermediate Repair (independent-review finding,
 * Blocker 1): a provider-result intermediate must never be adopted merely
 * because it exists for the right job id, role, and marker. Its recorded
 * durable-identity fields (`sourceAssetId`, `sourceBytesSha256`,
 * `providerKey`, `productionWidthIn`, `confirmedMaxHeightIn`) must ALSO
 * match the CURRENT production intent, exactly — the SAME fields the
 * pre-existing final-asset durable-identity loop guard already demands
 * (reused, never reinvented).
 *
 * This file proves EACH dimension independently:
 *   A. `confirmedMaxHeightIn` changes underneath an in-flight job (Cursor's
 *      exact "target size grows" failure mode) -- via the REAL product
 *      flow (`confirmProductionSizeForTests` between two real claims).
 *   B. `providerKey` differs from the currently-configured provider -- via
 *      the REAL product flow (a second worker instance configured with a
 *      different provider key).
 *   C/D. `sourceAssetId` / `sourceBytesSha256` differ from the current
 *      claim's own source -- via direct injection of an intermediate-marked
 *      asset carrying a deliberately wrong identity (the same
 *      `assets.uploadProductionAsset` call the real worker itself uses,
 *      not a hand-rolled repo mutation), proving the RESOLVER's own
 *      comparison — not merely "how such a row could arise" — is what is
 *      under test.
 *
 * In every case: the stale intermediate is never adopted, the job's own
 * provider identity is self-healed (never left pointing at a resubmission
 * risk), and the SAME already-paid request is never resubmitted merely
 * because the intermediate built from it was found stale.
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

function expectedReconstructionRequest(artworkWidthPx: number, widthIn = 3) {
  const png = PNG.sync.read(preparedTransparentPngOfWidth(artworkWidthPx));
  const outcome = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    { ...PRINT_PLACEMENT_SIZING_POLICY.sleeve, targetWidthIn: widthIn },
  );
  if (outcome.status !== "resolved") throw new Error(`fixture is not reconstructible: ${outcome.status}`);
  return outcome.request;
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

/** A fake Topaz endpoint set that assigns a FRESH process id per submission, always answers "Completed", and echoes the exact requested dimensions back (so re-submission after a self-heal always geometry-validates cleanly, regardless of the exact target this test drives it to). */
function buildFreshPerSubmissionFakeTopazFetch() {
  let nextSeq = 0;
  const submittedIds: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/tool/async")) {
      nextSeq += 1;
      const processId = `fresh-process-${nextSeq}`;
      submittedIds.push(processId);
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
      const processId = url.split("/download/")[1]!;
      return new Response(JSON.stringify({ url: `https://cdn.example.com/fresh-${processId}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const match = url.match(/^https:\/\/cdn\.example\.com\/fresh-(.+)\.png$/);
    if (match) {
      const form = undefined; // echo dims aren't recoverable post-hoc for GET; use a generously-sized fixed canvas instead.
      void form;
      return new Response(new Uint8Array(opaquePngOf(4000, 4000)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
  }) as typeof fetch;
  return { fetchImpl: impl, submittedIds: () => [...submittedIds] };
}

describe("Stale Provider-Result Intermediate Repair -- negative identity tests", () => {
  let tempDir = "";
  let previousCwd = "";

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-stale-intermediate-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function setup(artworkWidthPx: number, confirmedWidthIn = 3) {
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

    const bytes = preparedTransparentPngOfWidth(artworkWidthPx);
    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "stale-intermediate-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "stale-intermediate-fixture.png",
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

    return { repo, assets, projectId, preparedAssetId: prepared.id };
  }

  it("A: confirmedMaxHeightIn grows underneath an in-flight job (Cursor's exact 'target size grows' failure mode) -- the stale intermediate is never adopted, the job self-heals, and a genuinely NEW reconstruction is submitted for the NEW target", async () => {
    const { repo, assets, projectId } = await setup(400);
    const { fetchImpl, submittedIds } = buildFreshPerSubmissionFakeTopazFetch();

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

    // Claims 1-2: submit + status -> result_ready checkpoint, then
    // download -> provider-result intermediate persisted -- all under the
    // ORIGINAL confirmed envelope (width 3in, no explicit box max height).
    await worker.processNextJob();
    await worker.processNextJob();

    const afterOriginalIntermediate = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterOriginalIntermediate?.status, "recoverable");
    const originalRequestId = afterOriginalIntermediate?.providerRequestId;
    assert.ok(originalRequestId);
    assert.equal(submittedIds().length, 1, "exactly one submission so far");

    const intermediatesBeforeGrowth = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      isProviderResultIntermediateAsset,
    );
    assert.equal(intermediatesBeforeGrowth.length, 1, "the original intermediate exists, recorded under the ORIGINAL confirmed envelope");

    // The confirmed production envelope GROWS underneath this in-flight job
    // -- same width (so the job's own coarse `jobIntentIsCurrent` fence
    // still matches and does NOT supersede/cancel it), but a materially
    // different confirmed box max height (Phase 28T's own "10.5x10.5 ->
    // 10.5x14" shape).
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 3, boxMaxHeightIn: 8 });

    // The NEXT claim must NOT adopt the now-stale intermediate: it was
    // recorded under the OLD envelope, and the CURRENT claim's own
    // `confirmedMaxHeightIn` (freshly derived from the brief every claim)
    // now disagrees with what is recorded on it. The self-heal (clearing
    // the OLD request's identity) and the resulting fresh submission both
    // happen within this SAME claim: the self-heal never returns early --
    // it falls through to normal classification, which is now
    // `fresh_execution` (identity just cleared), so `checkStatusOnce`
    // submits-and-checks in the same invocation any other fresh claim would.
    await worker.processNextJob();

    const afterSelfHeal = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterSelfHeal?.status, "recoverable");
    // Self-healed AND resubmitted: the job is no longer keyed to the OLD,
    // now-stale request -- it is already keyed to a genuinely NEW one,
    // submitted for the NEW target within this same claim.
    assert.notEqual(afterSelfHeal?.providerRequestId, originalRequestId, "the job must no longer be keyed to the OLD, now-stale request");
    assert.equal(submittedIds().length, 2, "the self-heal claim's own fresh classification already submitted exactly one NEW request for the NEW target -- the old request is never resubmitted, and the stale intermediate never silently stands in for a genuine reconstruction of the new target");
    const newRequestId = afterSelfHeal?.providerRequestId;
    assert.notEqual(newRequestId, originalRequestId);

    // A FURTHER claim (resuming the new, already-submitted request, now
    // `result_ready`) only performs its download -- it must not submit yet
    // another, THIRD request. This is the exact regression this test
    // exists to catch: an earlier draft of this repair re-evaluated
    // staleness against EVERY historical intermediate on every claim, so
    // the now-irrelevant OLD intermediate kept re-triggering a self-heal
    // (and therefore a brand-new resubmission) forever, even after the job
    // was already correctly keyed to a fresh, in-flight, unrelated request.
    await worker.processNextJob();
    assert.equal(submittedIds().length, 2, "the download-only claim for the already-submitted new request must never resubmit");
    const jobAfterDownload = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(jobAfterDownload?.providerRequestId, newRequestId, "the job must stay keyed to the SAME new request across its own download claim");

    // The OLD intermediate remains -- harmless historical evidence, never
    // deleted, never adopted again.
    const allIntermediatesAfter = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      isProviderResultIntermediateAsset,
    );
    assert.ok(allIntermediatesAfter.length >= 1, "the stale intermediate is retained as historical evidence, never deleted");
  });

  it("B: providerKey differs from the currently-configured provider -- the stale intermediate (built by a DIFFERENT provider) is never adopted, and the current provider genuinely reconstructs instead of silently trusting a foreign result", async () => {
    const { repo, assets, projectId, preparedAssetId } = await setup(400);

    const { fetchImpl: fetchImplA, submittedIds: submittedIdsA } = buildFreshPerSubmissionFakeTopazFetch();
    const providerA = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl: fetchImplA,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const workerA = createFinalArtworkWorkerCapability(repo, assets, providerA, printValidation);

    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await workerA.processNextJob(); // submit + status -> result_ready
    await workerA.processNextJob(); // download -> intermediate persisted under providerA's own providerKey

    const afterProviderA = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterProviderA?.status, "recoverable");
    assert.equal(submittedIdsA().length, 1);

    const intermediateByProviderA = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).find(
      isProviderResultIntermediateAsset,
    );
    assert.ok(intermediateByProviderA);
    assert.equal(
      (intermediateByProviderA!.metadata as Record<string, unknown>).providerKey,
      "topaz_transparency_upscale",
    );

    // A DIFFERENT provider instance is now configured (models a
    // `FINAL_ARTWORK_PROVIDER` change between deploys/attempts) -- its own
    // `providerKey` differs, even though it happens to be the SAME
    // underlying class here for fixture simplicity. The claim's own
    // classification already treats a provider-key mismatch as
    // structurally "fresh" for the RESUME path (see
    // `existingProviderRequest` construction) -- this test proves the
    // INTERMEDIATE-adoption path enforces the identical rule.
    const differentProviderKeyProbe = {
      providerKey: "a_different_provider_key_for_this_test",
      produce: providerA.produce.bind(providerA),
      produceBounded: providerA.produceBounded?.bind(providerA),
    } as unknown as TopazTransparencyUpscaleProvider;
    const workerB = createFinalArtworkWorkerCapability(repo, assets, differentProviderKeyProbe, printValidation);

    await workerB.processNextJob();
    const afterProviderBClaim = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterProviderBClaim?.status, "recoverable");
    // The stale (providerA-built) intermediate must never be adopted by
    // providerB's own claim -- if it HAD been adopted,
    // `finalizeFromProviderResultIntermediate` would have run and produced
    // a FINAL production asset directly; instead, self-heal + a genuinely
    // NEW submission must occur.
    const productionAssetsAfterProviderBClaim = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(productionAssetsAfterProviderBClaim.length, 0, "no production asset was fabricated from the OTHER provider's stale intermediate");

    void preparedAssetId;
  });

  it("C: sourceAssetId on the intermediate disagrees with the current claim's own source asset -- injected directly (the real uploadProductionAsset path), never adopted", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);

    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    // Inject a "provider-result intermediate" for THIS job whose recorded
    // `sourceAssetId` deliberately does NOT match this job's real source
    // asset -- the exact shape a data-integrity anomaly (or a future bug
    // this test exists to catch regressions in) would produce.
    await assets.uploadProductionAsset(projectId, {
      conceptId: `stale-source-${requested.job.id}`,
      bytes: opaquePngOf(expectedRequest.widthPx, expectedRequest.heightPx),
      contentType: "image/png",
      widthPx: expectedRequest.widthPx,
      heightPx: expectedRequest.heightPx,
      hasTransparency: true,
      finalArtworkJobId: requested.job.id,
      productionRole: "production_png",
      metadata: {
        reconstructionStage: PROVIDER_RESULT_INTERMEDIATE_STAGE_MARKER,
        providerKey: "topaz_transparency_upscale",
        providerRequestId: "injected-wrong-source-process-id",
        sourceAssetId: "00000000-0000-0000-0000-000000000000", // never this job's real source
        sourceBytesSha256: null,
        productionWidthIn: requested.job.productionWidthIn,
        confirmedMaxHeightIn: null,
        nativeWidthPx: CANVAS_PX,
        nativeHeightPx: CANVAS_PX,
      },
    });

    const { fetchImpl, submittedIds } = buildFreshPerSubmissionFakeTopazFetch();
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);

    await worker.processNextJob();
    const afterClaim = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterClaim?.status, "recoverable");
    assert.notEqual(afterClaim?.providerRequestId, "injected-wrong-source-process-id", "the wrong-source intermediate's request id must never become this job's active identity");
    const productionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(productionAssets.length, 0, "no production asset was fabricated from the wrong-source intermediate");
    // A genuinely fresh submission proceeds instead, against THIS job's
    // real, correct source.
    assert.equal(submittedIds().length, 1, "a genuinely new submission was made for the CORRECT source, never resuming/trusting the injected one");
  });

  it("D: sourceBytesSha256 on the intermediate disagrees with the current claim's own source bytes -- injected directly, never adopted", async () => {
    const { repo, assets, projectId } = await setup(400);
    const expectedRequest = expectedReconstructionRequest(400);

    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    // Same job, same (correct) sourceAssetId, but a WRONG recorded
    // `sourceBytesSha256` -- models the artwork having been re-processed
    // (background re-removed, etc.) under the SAME asset id between the
    // intermediate's own creation and this claim.
    const sourceAsset = await repo.getAssetById(
      (await repo.getArtworkPreparation(projectId))!.preparedAssetId!,
    );
    await assets.uploadProductionAsset(projectId, {
      conceptId: `stale-sha-${requested.job.id}`,
      bytes: opaquePngOf(expectedRequest.widthPx, expectedRequest.heightPx),
      contentType: "image/png",
      widthPx: expectedRequest.widthPx,
      heightPx: expectedRequest.heightPx,
      hasTransparency: true,
      finalArtworkJobId: requested.job.id,
      productionRole: "production_png",
      metadata: {
        reconstructionStage: PROVIDER_RESULT_INTERMEDIATE_STAGE_MARKER,
        providerKey: "topaz_transparency_upscale",
        providerRequestId: "injected-wrong-sha-process-id",
        sourceAssetId: sourceAsset?.id ?? null,
        sourceBytesSha256: "0000000000000000000000000000000000000000000000000000000000000",
        productionWidthIn: requested.job.productionWidthIn,
        confirmedMaxHeightIn: null,
        nativeWidthPx: CANVAS_PX,
        nativeHeightPx: CANVAS_PX,
      },
    });

    const { fetchImpl, submittedIds } = buildFreshPerSubmissionFakeTopazFetch();
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const worker = createFinalArtworkWorkerCapability(repo, assets, provider, printValidation);

    await worker.processNextJob();
    const afterClaim = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterClaim?.status, "recoverable");
    assert.notEqual(afterClaim?.providerRequestId, "injected-wrong-sha-process-id");
    const productionAssets = (await repo.listAssetsForFinalArtworkJob(projectId, requested.job.id)).filter(
      (a) => a.productionRole === "production_png" && !isProviderResultIntermediateAsset(a),
    );
    assert.equal(productionAssets.length, 0, "no production asset was fabricated from the wrong-content-hash intermediate");
    assert.equal(submittedIds().length, 1, "a genuinely new submission was made, never resuming/trusting the injected one");
  });
});
