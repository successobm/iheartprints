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
 * confirmed size (5.45x needed, no real detail to add), DTF Halftone
 * genuinely succeeds on the SAME approved source at the SAME size. Proves
 * the two coexist, neither masquerades as the other, and switching which
 * treatment is currently configured never mutates either's completed state
 * (Section 15's regression, verbatim).
 *
 * Uses the REAL wired capability graph's REAL final-artwork scheduler and
 * REAL providers throughout -- no fakes, no mocks. This environment has no
 * Topaz key configured (verified in Phase 27M/N), so both jobs run entirely
 * local: zero network, zero cost, zero paid-provider calls.
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

  it("Raster refuses honestly, Halftone succeeds, neither masquerades as the other across repeated treatment switches", async () => {
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

    // --- B/A/Q/R: RUN DTF HALFTONE (succeeds, zero paid calls, own validation unchanged) ---
    const halftoneRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.notEqual(
      halftoneRequest.job.id,
      rasterRequest.job.id,
      "A: raster and halftone must be genuinely separate, coexisting jobs",
    );
    await graph.finalArtworkScheduler.runBatch();
    const halftoneJob = (await repo.getFinalArtworkJob(halftoneRequest.job.id))!;
    assert.equal(halftoneJob.status, "completed");
    assert.equal(halftoneJob.providerKey, null, "R: local providers never persist a providerKey (no external request identity)");

    const halftoneValidation = await repo.getLatestProductionAssetValidationForJob(projectId, halftoneJob.id);
    assert.equal(halftoneValidation?.status, "ready", "Q: halftone's own validation is unchanged from Phase 27N's proof");
    const halftoneChecks = (halftoneValidation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(halftoneChecks.find((c) => c.check === "halftone_tonal_sufficiency")?.status, "pass");
    assert.equal(halftoneChecks.find((c) => c.check === "halftone_screen_geometry")?.status, "pass");
    assert.equal(halftoneChecks.find((c) => c.check === "halftone_final_size_generation")?.status, "pass");

    snapshot = (await getConversation(projectId))!;
    raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;
    assert.equal(halftone.status, "print_ready");
    assert.equal(raster.status, "needs_attention", "J: raster's own prior failure is unaffected by halftone succeeding");
    // I: halftone metadata displays the correct real settings.
    assert.deepEqual(halftone.halftone, { lpi: 35, angleDeg: 45, dotShape: "round" });

    // --- C/B: SWITCH BACK TO STANDARD RASTER, then back to HALFTONE, repeatedly ---
    for (let i = 0; i < 3; i += 1) {
      await treatmentRoute.POST(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ treatment: "standard_raster" }),
        }),
        { params: Promise.resolve({ projectId }) },
      );
      snapshot = (await getConversation(projectId))!;
      raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
      halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;
      assert.equal(raster.status, "needs_attention", "C: raster keeps its own state while re-selected");
      assert.equal(halftone.status, "print_ready", "B: the completed halftone output survives switching to raster");

      await treatmentRoute.POST(
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
      snapshot = (await getConversation(projectId))!;
      raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
      halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;
      assert.equal(halftone.status, "print_ready", "halftone remains print_ready across repeated re-selection");
      assert.equal(raster.status, "needs_attention", "raster remains needs_attention throughout");
    }

    // F: the completed-file identity never depends on the CURRENT selector.
    // The brief is currently on halftone_dtf (last loop iteration); the
    // package still reports BOTH variants by their own true identity.
    const finalBrief = (await repo.getProject(projectId))!.brief;
    assert.equal(finalBrief.productionTreatment, "halftone_dtf");
    assert.equal(raster.treatment, "standard_raster");
    assert.equal(raster.label, "Standard Raster");
    assert.equal(halftone.treatment, "halftone_dtf");
    assert.equal(halftone.label, "DTF Halftone");

    // --- G/H: DOWNLOAD IDENTITY -- each variant's download returns THAT variant's asset ---
    const rasterDownload = await getProductionArtworkDownloadForVariant(projectId, "standard_raster");
    assert.equal(rasterDownload, null, "G: raster never became print_ready, so it must never be downloadable");

    const halftoneDownload = await getProductionArtworkDownloadForVariant(projectId, "halftone_dtf");
    assert.ok(halftoneDownload, "H: the successfully-generated halftone file must be downloadable");
    const halftoneAssetBytes = (await assets.downloadAssetBytes(halftone.finalAssetId!))!.bytes;
    assert.equal(
      createHash("sha256").update(halftoneDownload!.bytes).digest("hex"),
      createHash("sha256").update(halftoneAssetBytes).digest("hex"),
      "H: the downloaded bytes are exactly the halftone variant's own asset -- never raster's, never 'whichever is current'",
    );
    assert.match(halftoneDownload!.filename, /dtf-halftone/);

    // K: requesting the SAME variant/configuration again reuses the completed job.
    const halftoneAgain = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(halftoneAgain.job.id, halftoneJob.id, "K: an unchanged halftone configuration must reuse the completed job");
    assert.equal(halftoneAgain.alreadyRequested, true);

    // L: a MATERIALLY DIFFERENT halftone configuration (different LPI) is a
    // genuinely different variant, not silently merged into the same job/output.
    await treatmentRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          treatment: "halftone_dtf",
          halftone: { lpi: 45, angleDeg: 45, dotShape: "round", midtone: 1, chokePx: 0 },
        }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    const differentLpiRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.notEqual(
      differentLpiRequest.job.id,
      halftoneJob.id,
      "L: 35 LPI and 45 LPI must never be presented as the same output",
    );
    await graph.finalArtworkScheduler.runBatch();
    // The ORIGINAL 35 LPI job/asset are untouched by this new, separate job.
    const originalHalftoneJobStill = (await repo.getFinalArtworkJob(halftoneJob.id))!;
    assert.equal(originalHalftoneJobStill.status, "completed");
    assert.equal(originalHalftoneJobStill.id, halftoneJob.id);

    // M/N: source authority and original immutability survive everything above.
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

  it("E: a Halftone-specific failure does not contaminate Raster's own status/reason", async () => {
    // A small synthetic square, deliberately too low-detail for a 55 LPI
    // screen at 10.5in (tonal PPI well under the LPI it would need to
    // support) -- exercises `halftone_tonal_sufficiency`'s REAL, unmodified
    // rule with a genuinely different underlying source than the main test,
    // so this failure's own reason can be proven independent of Raster's.
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

    // Halftone at the maximum supported LPI -- fails tonal sufficiency for
    // THIS small source (a real, unmodified validation outcome).
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
    const halftoneRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const halftoneJob = (await repo.getFinalArtworkJob(halftoneRequest.job.id))!;
    assert.equal(halftoneJob.status, "completed");
    const halftoneValidation = await repo.getLatestProductionAssetValidationForJob(projectId, halftoneJob.id);
    const halftoneChecks = (halftoneValidation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(
      halftoneChecks.find((c) => c.check === "halftone_tonal_sufficiency")?.status,
      "fail",
      "this fixture must genuinely fail tonal sufficiency for this test to prove anything",
    );

    const snapshot = (await getConversation(projectId))!;
    const raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    const halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;

    assert.equal(raster.status, "needs_attention");
    assert.equal(halftone.status, "needs_attention");
    // The two failures are independent facts: neither variant's job id,
    // reason, or asset is shared with the other's.
    assert.notEqual(raster.finalArtworkJobId, halftone.finalArtworkJobId);
    assert.notEqual(raster.attentionReason, halftone.attentionReason);
    assert.doesNotMatch(raster.attentionReason ?? "", /tonal/i);
    assert.doesNotMatch(halftone.attentionReason ?? "", /enhancement/i);
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
