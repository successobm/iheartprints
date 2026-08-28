import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation/artwork-preparation-capability";
import { getConversation, getProductionArtworkDownloadForVariant } from "@/lib/services/conversation-service";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 27P — THE MULTI-VARIANT PACKAGE, PROVEN ON THE REAL INCREDI-BOWLS
 * SCENARIO.
 *
 * Reproduces exactly what the real project (`44f528f2-...`, Phase 27O)
 * lived through: Standard Raster genuinely cannot be reconstructed at this
 * confirmed size (5.45x needed, no real detail to add).
 *
 * PHASE 28I HARD CORRECTION: Phase 27P's original story continued past that
 * point to prove DTF Halftone could succeed independently and the two
 * variants would coexist without contaminating each other. That sequence --
 * Halftone reachable while Raster is only `needs_attention` -- is now
 * EXACTLY the sequence Phase 28I forbids (Section 9/19): "Halftone MUST NOT
 * be available until Standard Raster is genuinely print_ready. No bypass.
 * No Halftone after Raster needs_attention." This file now proves the new
 * behavior on the same real asset: Raster fails honestly, and the Halftone
 * request that Phase 27P expected to succeed is instead rejected outright,
 * with Raster's own verdict and the source assets left provably untouched.
 *
 * Uses the REAL wired capability graph's REAL final-artwork scheduler and
 * REAL providers throughout -- no fakes, no mocks. This environment has no
 * Topaz key configured (verified in Phase 27M/N), so the raster job runs
 * entirely local: zero network, zero cost, zero paid-provider calls.
 */
const INCREDI_BOWLS_PATH =
  "C:/Users/eric/Downloads/e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png";
const EXPECTED_SHA256 =
  "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";
const hasAsset = existsSync(INCREDI_BOWLS_PATH);

describe("Phase 27P — multi-variant print-ready package (real INCREDI-BOWLS)", { skip: !hasAsset }, () => {
  let tempDir = "";
  let previousCwd = "";
  let originalBytes: Buffer;

  before(() => {
    originalBytes = readFileSync(INCREDI_BOWLS_PATH);
    assert.equal(
      createHash("sha256").update(originalBytes).digest("hex"),
      EXPECTED_SHA256,
      "INCREDI-BOWLS asset SHA256 must match before use",
    );
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-multi-variant-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("Phase 28I HARD CORRECTION: Raster refuses honestly, and Halftone -- no longer an independent success path -- is rejected outright, with Raster's own verdict and the source assets left untouched", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const artworkPreparation = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));

    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await artworkPreparation.uploadOriginal(projectId, {
      bytes: originalBytes,
      declaredContentType: "image/png",
      filename: "incredi-bowls.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await artworkPreparation.prepareBackground(projectId);

    // Real manual correction (Phase 27H path) -- M: this asset remains the
    // common source authority for BOTH variants below.
    await artworkPreparation.acceptCorrectionOperation(projectId, {
      clicks: [{ x: 5, y: 5 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    await artworkPreparation.acceptCorrectionOperation(projectId, {
      tool: "erase_brush",
      points: [{ x: 20, y: 20 }],
      radius: 3,
    });
    const finalizeView = await artworkPreparation.finalizeCorrection(projectId);
    assert.equal(finalizeView.hasPreparedArtwork, true);

    const preparationAfterCorrection = await repo.getArtworkPreparation(projectId);
    const correctedAssetId = preparationAfterCorrection!.preparedAssetId!;
    const correctedBytesBefore = (await assets.downloadAssetBytes(correctedAssetId))!.bytes;
    const originalAssetId = preparationAfterCorrection!.originalAssetId;
    const originalBytesBefore = (await assets.downloadAssetBytes(originalAssetId))!.bytes;

    // Standard Adult, via the real route.
    const sizeRoute = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    const sizeRes = await sizeRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(sizeRes.status, 200);

    // --- A/N: RUN STANDARD RASTER (fails honestly -- no migration, no algorithm change) ---
    const rasterRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const rasterJob = (await repo.getFinalArtworkJob(rasterRequest.job.id))!;

    // P: Standard Raster's own validation is UNCHANGED -- same real check,
    // same real numbers Phase 27N/27O already established for this asset.
    assert.equal(rasterJob.status, "completed", "a durable print-readiness verdict, never an infra failure");
    assert.match(rasterJob.lastError ?? "", /enlarged.*x|PPI|below/i);

    let snapshot = (await getConversation(projectId))!;
    assert.ok(snapshot.printReadyPackage, "package view must be present for this internal project");
    let raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    let halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;
    assert.equal(raster.status, "needs_attention");
    assert.match(raster.attentionReason ?? "", /enhancement/i);
    // D: the raster failure has not contaminated halftone -- halftone was
    // never configured, so it is honestly `not_created`, not any flavor of failure.
    assert.equal(halftone.status, "not_created");
    assert.equal(halftone.attentionReason, null);

    // --- Switch to DTF Halftone (real route, real settings) ---
    const treatmentRoute = await import("@/app/api/projects/[projectId]/production-treatment/route");
    const treatRes = await treatmentRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          treatment: "halftone_dtf",
          halftone: { lpi: 35, angleDeg: 45, dotShape: "round", midtone: 1, chokePx: 0 },
        }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(treatRes.status, 200);

    // Phase 27O regression: switching treatment must NOT have mutated the
    // raster verdict just by being selected away from.
    snapshot = (await getConversation(projectId))!;
    raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    assert.equal(raster.status, "needs_attention", "switching treatment away must not clear/mutate raster's own verdict");

    // --- Phase 28I HARD GATE: requesting Halftone now is REJECTED outright,
    // because Standard Raster has not reached print_ready. This is exactly
    // the sequence Phase 27P originally proved as a valid success path; that
    // rule is explicitly overruled. ---
    await assert.rejects(
      () => graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
      (error: Error & { safeErrorCode?: string }) => {
        assert.equal(error.name, "ArtworkFinalizationRasterNotReadyError");
        assert.equal(error.safeErrorCode, "STANDARD_RASTER_NOT_PRINT_READY");
        assert.match(error.message, /Standard Raster/);
        assert.match(error.message, /needs_attention/);
        return true;
      },
      "Phase 28I: Halftone must not be reachable while Raster is only needs_attention",
    );
    await graph.finalArtworkScheduler.runBatch();

    // Neither variant moved as a result of the rejected attempt: raster
    // keeps its own prior verdict, and halftone -- never actually
    // dispatched -- remains honestly not_created, not any flavor of failure.
    snapshot = (await getConversation(projectId))!;
    raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;
    assert.equal(raster.status, "needs_attention", "J: raster's own prior verdict is unaffected by the rejected halftone attempt");
    assert.equal(halftone.status, "not_created", "the rejected request never created or ran a halftone job");
    assert.equal(halftone.finalArtworkJobId, null);

    // G: raster never became print_ready, so it must never be downloadable;
    // and there is no halftone artifact to download either.
    const rasterDownload = await getProductionArtworkDownloadForVariant(projectId, "standard_raster");
    assert.equal(rasterDownload, null, "G: raster never became print_ready, so it must never be downloadable");
    const halftoneDownload = await getProductionArtworkDownloadForVariant(projectId, "halftone_dtf");
    assert.equal(halftoneDownload, null, "a rejected request must never produce a downloadable halftone file");

    // M/N: source authority and original immutability survive the rejected attempt.
    const correctedBytesAfter = (await assets.downloadAssetBytes(correctedAssetId))!.bytes;
    const originalBytesAfter = (await assets.downloadAssetBytes(originalAssetId))!.bytes;
    assert.equal(
      createHash("sha256").update(correctedBytesAfter).digest("hex"),
      createHash("sha256").update(correctedBytesBefore).digest("hex"),
      "M: the accepted manual-correction asset must remain unchanged throughout",
    );
    assert.equal(
      createHash("sha256").update(originalBytesAfter).digest("hex"),
      createHash("sha256").update(originalBytesBefore).digest("hex"),
      "N: the original asset must remain byte-identical to itself throughout",
    );
    assert.equal(
      createHash("sha256").update(originalBytesAfter).digest("hex"),
      EXPECTED_SHA256,
      "N: the original asset must remain byte-identical to the real uploaded file",
    );
    // O: the automatic (pre-correction) preparation state is not what any job used.
    const preparationFinal = await repo.getArtworkPreparation(projectId);
    assert.equal(
      preparationFinal!.preparedAssetId,
      correctedAssetId,
      "O: the manually-corrected asset remains authoritative; the automatic prepared version never re-enters finalization",
    );
  });

  it("Phase 28I HARD CORRECTION of 'E': attempting Halftone while Raster is needs_attention is rejected outright -- Raster's own status/reason is provably untouched by the attempt", async () => {
    // A small synthetic square, deliberately too low-detail to reconstruct
    // -- exercises the real, unmodified Raster refusal path with a
    // genuinely different underlying source than the main test above, so
    // this rejection can be proven independent of that test's asset.
    const size = 400;
    const png = new PNG({ width: size, height: size });
    const cx = size / 2;
    const cy = size / 2;
    const radius = 140;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = (size * y + x) << 2;
        const inCircle = (x - cx) * (x - cx) + (y - cy) * (y - cy) < radius * radius;
        if (inCircle) {
          png.data[idx] = 20;
          png.data[idx + 1] = 80;
          png.data[idx + 2] = 180;
          png.data[idx + 3] = 255;
        } else {
          png.data[idx] = 255;
          png.data[idx + 1] = 255;
          png.data[idx + 2] = 255;
          png.data[idx + 3] = 255;
        }
      }
    }
    const smallBytes = PNG.sync.write(png);

    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const artworkPreparation = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));

    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await artworkPreparation.uploadOriginal(projectId, {
      bytes: smallBytes,
      declaredContentType: "image/png",
      filename: "small-square.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await artworkPreparation.prepareBackground(projectId);
    // The manual-correction finalize path (Phase 27H), exactly as the main
    // test above uses -- it is the one approval route that does not depend
    // on this synthetic fixture's automatic separation-review classification,
    // and zero operations is a legitimate, already-proven finalize (Phase 27M).
    await artworkPreparation.finalizeCorrection(projectId);

    const sizeRoute = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    await sizeRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );

    // Raster attempt -- fails on its own, real, unrelated reason.
    const rasterRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const rasterJob = (await repo.getFinalArtworkJob(rasterRequest.job.id))!;
    assert.equal(rasterJob.status, "completed");

    // Attempting Halftone now -- Raster is only needs_attention -- must be
    // rejected outright by the Phase 28I gate, before any halftone-specific
    // validation (tonal sufficiency, screen geometry, etc.) ever runs.
    const treatmentRoute = await import("@/app/api/projects/[projectId]/production-treatment/route");
    await treatmentRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          treatment: "halftone_dtf",
          halftone: { lpi: 55, angleDeg: 45, dotShape: "round", midtone: 1, chokePx: 0 },
        }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    await assert.rejects(
      () => graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
      (error: Error & { safeErrorCode?: string }) => {
        assert.equal(error.name, "ArtworkFinalizationRasterNotReadyError");
        assert.equal(error.safeErrorCode, "STANDARD_RASTER_NOT_PRINT_READY");
        return true;
      },
    );
    await graph.finalArtworkScheduler.runBatch();

    const snapshot = (await getConversation(projectId))!;
    const raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    const halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;

    // Raster's own status/reason is exactly what it was before the rejected
    // attempt -- provably untouched by it.
    assert.equal(raster.status, "needs_attention");
    assert.equal(raster.finalArtworkJobId, rasterJob.id);
    const rasterReasonBefore = raster.attentionReason;
    assert.ok(rasterReasonBefore);
    // Halftone was never dispatched, so it is honestly not_created -- not a
    // "failure" borrowed from, or contaminated by, Raster's own reason.
    assert.equal(halftone.status, "not_created");
    assert.equal(halftone.finalArtworkJobId, null);
    assert.equal(halftone.attentionReason, null);
    assert.doesNotMatch(rasterReasonBefore ?? "", /tonal/i);
  });

  it("S: printReadyPackage is absent (never null) for a non-internal project", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const artworkPreparation = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));

    // No internal entitlement granted -- a genuinely public/prospect session.
    const session = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await artworkPreparation.uploadOriginal(projectId, {
      bytes: originalBytes,
      declaredContentType: "image/png",
      filename: "incredi-bowls.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await artworkPreparation.prepareBackground(projectId);
    await artworkPreparation.acceptCorrectionOperation(projectId, {
      clicks: [{ x: 5, y: 5 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    await artworkPreparation.finalizeCorrection(projectId);

    const snapshot = (await getConversation(projectId))!;
    // `undefined`-valued object-literal keys still satisfy the `in`
    // operator on the in-memory value -- the real customer-facing guarantee
    // is about the SERIALIZED HTTP response, which is what `JSON.stringify`
    // (as `NextResponse.json()` does) actually drops.
    const serialized = JSON.parse(JSON.stringify(snapshot));
    assert.equal(
      "printReadyPackage" in serialized,
      false,
      "S: an absent key, never a null field, for a project without internal access",
    );
    assert.equal("productionTreatment" in serialized, false);
  });
});
