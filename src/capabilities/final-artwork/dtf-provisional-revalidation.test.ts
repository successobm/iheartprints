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
import type { FinalArtworkProvider, FinalArtworkProviderInput } from "@/capabilities/final-artwork/provider";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker/final-artwork-worker-capability";

/**
 * "Restore Completed Print-Ready Download Flow While Preserving Feature
 * Integrity Diagnostics" — proves, end to end through the REAL capability
 * graph (never a stand-in for `resolvePreparedUploadJob`/
 * `resolveSatisfiedProductionDelivery`/`produceProductionAsset`), that:
 *
 *   1. A completed job whose LATEST validation is not "ready" is eligible
 *      for revalidation via the SAME "Retry Preparation" action
 *      (`requestPreparedUploadFinalArtwork`) that already revives a
 *      genuinely `"failed"` job — even when it is NOT stale for the
 *      current target.
 *   2. Revalidation NEVER invokes the reconstruction provider — proven with
 *      a provider wrapper that throws if `.produce()` is ever called at
 *      all, across the ENTIRE test, both on the original run and on every
 *      revalidation.
 *   3. Revalidation reuses the EXACT SAME production asset id — never a
 *      second one.
 *   4. The download-eligibility resolver
 *      (`getCurrentProductionAssetId`/`resolveCurrentProductionDelivery`)
 *      correctly tracks the CURRENT latest validation: unavailable while a
 *      non-ready row is latest, available again once revalidation produces
 *      a "ready" one.
 *
 * The fixture is a source that ALREADY satisfies its production target
 * (mirrors `topaz-provider-selection-and-invocation.test.ts`'s own test 2),
 * so the ordinary, unmodified `resolveExistingProductionAsset` short-circuit
 * — ALREADY proven safe by Phase 28T's own tests — is what makes "no
 * provider call" true on revalidation, not anything new invented here.
 */

const CANVAS_PX = 1200; // 3in sleeve at 300 PPI needs 900px -- comfortably satisfied by a 1000px artwork.

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

/** Counts and (optionally) forbids calls to `.produce()` — mirrors `topaz-provider-selection-and-invocation.test.ts`'s own helper. */
function countingProvider(providerKey: string, options: { forbid?: boolean } = {}) {
  let calls = 0;
  const wrapped: FinalArtworkProvider = {
    providerKey,
    produce: async (_input: FinalArtworkProviderInput) => {
      calls += 1;
      if (options.forbid) {
        throw new Error("FORBIDDEN: no reconstruction provider call is ever expected in this test");
      }
      throw new Error("unreachable: this provider stub has no real implementation");
    },
  };
  return { wrapped, callCount: () => calls };
}

describe("Restore Completed Print-Ready Download Flow -- revalidation without a provider call", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-dtf-revalidation-"));
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
      metadata: { originalFilename: "dtf-revalidation-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "dtf-revalidation-fixture.png",
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

  it("a completed job stuck at finalization_required due only to a stale (superseded-policy) validation row revalidates via Retry Preparation -- same asset, zero provider calls, ready, downloadable", async () => {
    const { repo, assets, projectId } = await setup(1000); // sufficient source -- reconstruction never required
    const { wrapped: forbiddenProvider, callCount } = countingProvider("topaz_transparency_upscale", { forbid: true });

    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const worker = createFinalArtworkWorkerCapability(repo, assets, forbiddenProvider, printValidation);

    // --- 1. The genuine, original run: sufficient source, no provider call, completes ready.
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const afterFirstRun = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterFirstRun?.status, "completed");
    assert.equal(callCount(), 0, "a sufficient source must never reach the reconstruction provider");

    const originalAssetId = await finalArtwork.getCurrentProductionAssetId(projectId);
    assert.ok(originalAssetId, "the original run must produce a downloadable production asset");
    const originalDelivery = await finalArtwork.resolveCurrentProductionDelivery(projectId);
    assert.equal(originalDelivery?.assetId, originalAssetId);

    // --- 2. Simulate "this job was completed under an OLDER policy that
    // treated some finding as blocking" -- append a NEWER, non-ready
    // validation row for the SAME job + SAME asset. A genuine, realistic
    // report (built via the real PrintValidationCapability against a
    // deliberately-failing input), never a hand-typed fake shape.
    const staleReport = printValidation.validateArtwork({
      artworkVersionId: "unrelated-fixture-artwork-id",
      validationProfile: "uploaded_preserve",
      designBriefVersionId: null,
      currentApprovedDesignBriefVersionId: null,
      printPlacement: "sleeve",
      productSummary: "T-shirts",
      designDescription: null,
      conceptEvaluationStatus: null,
      conceptEvaluation: null,
      intendedPrintWidthIn: 3,
      requestedProductionOutput: null,
      primaryAsset: {
        contentType: "image/png",
        widthPx: 900,
        heightPx: 900,
        hasTransparency: false, // the deliberately-failing fact
        vectorAssetId: null,
        resolutionProvenance: "native",
        nativeWidthPx: 900,
        nativeHeightPx: 900,
      },
      productionNormalization: null,
      productionTreatment: undefined,
      halftone: null,
      dtfFeatureIntegrity: null,
    } as Parameters<typeof printValidation.validateArtwork>[0]);
    assert.notEqual(staleReport.status, "ready", "sanity: the injected stale report is genuinely non-ready");

    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: afterFirstRun!.id,
      assetId: originalAssetId!,
      status: staleReport.status,
      report: staleReport as unknown as Record<string, unknown>,
    });

    // --- 3. Download must now correctly reflect the stale non-ready state.
    const duringStaleWindow = await finalArtwork.getCurrentProductionAssetId(projectId);
    assert.equal(duringStaleWindow, null, "a non-ready latest validation must make the asset undownloadable");

    // --- 4. Retry Preparation: revives the job (NOT stale-for-target, but
    // its latest validation is not ready) -- the exact new eligibility this
    // task adds.
    const retried = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(retried.alreadyRequested, false, "a non-ready completed job must be revived, not returned as-is");
    assert.equal(retried.job.id, requested.job.id, "revalidation reuses the SAME job -- never a new one");

    // --- 5. The worker reclaims it. `resolveExistingProductionAsset` (the
    // FIRST thing `produceProductionAsset` checks, before any provider or
    // attempt-budget logic) finds the SAME still-matching asset and
    // short-circuits straight to re-running PrintValidation against it.
    await worker.processNextJob();

    const afterRevalidation = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(afterRevalidation?.status, "completed");
    assert.equal(callCount(), 0, "revalidation must NEVER invoke the reconstruction provider");

    const revalidatedAssetId = await finalArtwork.getCurrentProductionAssetId(projectId);
    assert.equal(revalidatedAssetId, originalAssetId, "revalidation must reuse the EXACT SAME production asset -- never a second one");

    const finalValidation = await repo.getLatestProductionAssetValidationForJob(projectId, afterRevalidation!.id);
    assert.equal(finalValidation?.status, "ready");
    assert.equal(finalValidation?.assetId, originalAssetId);

    const finalDelivery = await finalArtwork.resolveCurrentProductionDelivery(projectId);
    assert.equal(finalDelivery?.assetId, originalAssetId, "the asset must be downloadable again after revalidation");
  });
});
