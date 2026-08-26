import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation/artwork-preparation-capability";
import { describePrintReadySize } from "@/capabilities/shared/print-ready-size";
import { assessHalftoneEligibility } from "@/capabilities/shared/production-treatment";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 27L §22 — REAL-ASSET ACCEPTANCE: the manually-corrected real
 * INCREDI-BOWLS artwork, carried all the way through the print-preparation
 * screen's confirmation flow. Never clicks the actual "Prepare Print-Ready
 * Artwork" action (that would consume a real provider credit) -- this
 * proves ELIGIBILITY/STATE only, exactly as instructed.
 */
const INCREDI_BOWLS_PATH = "C:\\Users\\eric\\Downloads\\e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png";
const EXPECTED_SHA256 = "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";
const hasAsset = existsSync(INCREDI_BOWLS_PATH);

describe("INCREDI-BOWLS real-asset acceptance — Phase 27L print-size confirmation", { skip: !hasAsset }, () => {
  let tempDir = "";
  let previousCwd = "";
  let originalBytes: Buffer;

  before(() => {
    originalBytes = readFileSync(INCREDI_BOWLS_PATH);
    const actualSha256 = createHash("sha256").update(originalBytes).digest("hex");
    assert.equal(actualSha256, EXPECTED_SHA256, "INCREDI-BOWLS asset SHA256 must match before use");

    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-incredi-bowls-print-size-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("manual correction -> Use This Artwork -> print-size confirmation reaches a genuinely eligible, non-contradictory state", async () => {
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

    // Manual correction (Phase 27H/27I/27K path): a couple of real
    // Wand/Eraser operations, then the authoritative "Use This Artwork".
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
    assert.equal(finalizeView.hasPreparedArtwork, true, "manual correction must finalize successfully");

    const preparation = await repo.getArtworkPreparation(projectId);
    const correctedAssetId = preparation!.preparedAssetId;
    assert.ok(correctedAssetId, "a corrected asset must be authoritative");

    // Print-size screen: select Standard Adult via the real route (the
    // Phase 27L fix).
    const route = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    const res = await route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(res.status, 200, await res.clone().text());

    const snapshot = await repo.getProject(projectId);
    const size = describePrintReadySize({
      printPlacement: snapshot!.brief.printPlacement,
      intendedPrintWidthIn: snapshot!.brief.intendedPrintWidthIn,
      artworkWidthPx: null,
      artworkHeightPx: null,
      garmentSizeClass: snapshot!.brief.garmentSizeClass,
      productionSizeConfirmedAt: snapshot!.brief.productionSizeConfirmedAt,
      productionSizeConfirmedWidthIn: snapshot!.brief.productionSizeConfirmedWidthIn,
      productionSizeConfirmedMaxHeightIn: snapshot!.brief.productionSizeConfirmedMaxHeightIn,
    })!;

    // No more contradiction: Standard Adult selected AND genuinely confirmed.
    assert.equal(size.garmentSizeOptions.find((o) => o.value === "adult_standard")!.isSelected, true);
    assert.equal(size.confirmed, true);
    assert.equal(size.widthIn, 10.5);
    assert.equal(size.blockingMessage, null, "the contradictory 'confirm the print size' warning must be gone");

    // The corrected asset must still be the one this screen is about --
    // the manual correction's authority (Phase 27H/27K) must survive
    // reaching the print-size screen; automatic damage must never return.
    const preparationAfter = await repo.getArtworkPreparation(projectId);
    assert.equal(preparationAfter!.preparedAssetId, correctedAssetId, "the manually corrected asset must remain authoritative through print-size confirmation");

    // DTF Halftone eligibility: with an approved prepared source and a
    // resolvable garment colour, the ONLY remaining real prerequisite this
    // check exercises (productionSizeConfirmed) is now satisfied.
    const eligibility = assessHalftoneEligibility({
      productionCategory: "apparel_raster",
      productionSizeConfirmed: size.confirmed,
      preparedSourceAvailable: Boolean(preparationAfter!.preparedAssetId) && preparationAfter!.status === "approved",
      garment: { hex: "#000000", label: "Black", tone: "dark" } as never,
      tone: { visiblePixelCount: 1, midtoneFraction: 1 },
    });
    assert.equal(eligibility.eligible, true, "DTF Halftone must become eligible once size is confirmed and every other real prerequisite is met");

    // Prepare Print-Ready Artwork's exact predicate is satisfied -- but we
    // deliberately never click it (would spend a real provider credit).
    assert.equal(!size.confirmed, false, "Prepare Print-Ready Artwork's disable predicate (!printReadySize.confirmed) must now be false");
  });
});
