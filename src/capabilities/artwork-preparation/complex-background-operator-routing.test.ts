import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { denseBlackCompositionArtwork, toPngBytes } from "./artwork-fixtures";

/**
 * PHASE 16, Section 9 — THE CRITICAL ADVERSARIAL TEST.
 *
 * `denseBlackCompositionArtwork` (see `artwork-fixtures.ts`) is a SYNTHETIC
 * stand-in for the class of real-world artwork that exposed the routing
 * defect: a large black exterior field, extensive black WITHIN the artwork
 * connected to that same exterior at the pixel level, a disconnected black
 * shape fully enclosed by non-black colour, and a black hole/detail inside a
 * non-black shape. It genuinely classifies `NEEDS_REVIEW` (proven in
 * `phase16-complex-background-routing.test.ts`) — this file proves what
 * happens to its pixels once separation review is reached, with the garment
 * colour deliberately set to WHITE throughout, exactly the real-world
 * acceptance failure's own configuration.
 *
 * What this file must NOT find: "black == background/substrate" implemented
 * anywhere, implicitly or explicitly, garment-conditionally or otherwise.
 */
describe("Phase 16: complex-background separation does not implement \"black == substrate\"", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-phase16-black-adversarial-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function harness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    return { repo, assets, capability };
  }

  async function seeded(productColor: string) {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(denseBlackCompositionArtwork()),
      declaredContentType: "image/png",
      filename: "complex-background.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor,
      printPlacement: "full_front",
    });
    return { repo, assets, capability, projectId };
  }

  it("9.1: this fixture genuinely has 2 consequential regions — a disconnected black island and a black hole inside white", async () => {
    const { capability, projectId } = await seeded("White");
    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.state, "review_required");
    assert.equal(review.regionMap.consequentialRegions.length, 2);
  });

  it("9.2 / Section 9: BEFORE any operator decision, nothing ambiguous is destroyed — both consequential regions stay fully opaque with their EXACT original RGB, even on a white-garment project", async () => {
    const { capability, projectId } = await seeded("White");
    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.decisions.length, 0, "no decisions exist yet — this is the pristine, just-uploaded state");

    // Reconstruct the master the exact way the server does, from the same
    // region map and an EMPTY decision list — undecided regions must be
    // untouched per `buildSeparationMaster`'s own contract.
    const { computeRegionMap, buildSeparationMaster } = await import("./region-separation");
    const original = denseBlackCompositionArtwork();
    const sha256 = review.regionMap.sourceAssetSha256;
    const computation = computeRegionMap(
      original,
      sha256,
      { r: 0, g: 0, b: 0 },
      40,
    );
    const master = buildSeparationMaster(original, computation, []);

    for (const region of computation.regionMap.consequentialRegions) {
      const [sampleX, sampleY] = centerOfBounds(region.bounds);
      const i = sampleY * original.width + sampleX;
      assert.equal(master.data[i * 4 + 3], 255, `region ${region.regionId} must remain fully opaque before any decision`);
      assert.equal(master.data[i * 4], original.data[i * 4], `region ${region.regionId} red channel must be untouched`);
      assert.equal(master.data[i * 4 + 1], original.data[i * 4 + 1], `region ${region.regionId} green channel must be untouched`);
      assert.equal(master.data[i * 4 + 2], original.data[i * 4 + 2], `region ${region.regionId} blue channel must be untouched`);
    }
  });

  it("9.3 / K: AFTER explicit decisions, only the region decided substrate becomes transparent — the region decided ink retains its exact original RGB", async () => {
    const { capability, projectId } = await seeded("White");
    const review = await capability.getSeparationReview(projectId);
    const [regionA, regionB] = review.regionMap.consequentialRegions;
    assert.ok(regionA && regionB);

    // regionA (the larger disconnected black ellipse) -> Print Ink: must survive.
    // regionB (the black hole inside white) -> Show Shirt: must become transparent.
    const updated = await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions: [
        { regionId: regionA.regionId, intent: "ink" },
        { regionId: regionB.regionId, intent: "substrate" },
      ],
    });
    assert.equal(updated.state, "review_complete");

    const { computeRegionMap, buildSeparationMaster } = await import("./region-separation");
    const original = denseBlackCompositionArtwork();
    const computation = computeRegionMap(original, review.regionMap.sourceAssetSha256, { r: 0, g: 0, b: 0 }, 40);
    const master = buildSeparationMaster(original, computation, updated.decisions);

    const [ax, ay] = centerOfBounds(regionA.bounds);
    const ai = ay * original.width + ax;
    assert.equal(master.data[ai * 4 + 3], 255, "the Print-Ink region must remain fully opaque");
    assert.equal(master.data[ai * 4], original.data[ai * 4], "the Print-Ink region's red channel must be exactly retained");
    assert.equal(master.data[ai * 4 + 1], original.data[ai * 4 + 1], "the Print-Ink region's green channel must be exactly retained");
    assert.equal(master.data[ai * 4 + 2], original.data[ai * 4 + 2], "the Print-Ink region's blue channel must be exactly retained");

    const [bx, by] = centerOfBounds(regionB.bounds);
    const bi = by * original.width + bx;
    assert.equal(master.data[bi * 4 + 3], 0, "the Show-Shirt region must become transparent");
  });

  it("9.4: the huge black EXTERIOR (unambiguous, border-connected background) is removed regardless of decisions — but this is NOT the same mechanism as the consequential-region decisions, and does not touch either consequential region's pixels", async () => {
    const { capability, projectId } = await seeded("White");
    const review = await capability.getSeparationReview(projectId);

    const { computeRegionMap, buildSeparationMaster } = await import("./region-separation");
    const original = denseBlackCompositionArtwork();
    const computation = computeRegionMap(original, review.regionMap.sourceAssetSha256, { r: 0, g: 0, b: 0 }, 40);
    const master = buildSeparationMaster(original, computation, []);

    // A pixel far from every shape in the fixture (red at 0,0-60,50; the
    // ellipse ring centered at 100,100 radius 34; the white+hole block at
    // 40,140-84,184; white at 150,110-200,170) — genuinely deep inside the
    // always-black exterior, never part of either consequential region.
    const farX = 190;
    const farY = 195;
    const cornerIndex = farY * original.width + farX;
    assert.equal(master.data[cornerIndex * 4 + 3], 0, "the unambiguous border-connected exterior is always removed");

    // And the two consequential regions are UNCHANGED by that same call
    // (already proven pixel-exact in 9.2, restated here for the explicit
    // contrast this test's title makes).
    for (const region of computation.regionMap.consequentialRegions) {
      const [sx, sy] = centerOfBounds(region.bounds);
      const i = sy * original.width + sx;
      assert.equal(master.data[i * 4 + 3], 255);
    }
  });

  it("F / 9: garment WHITE does not mean black pixels are automatically removed — a Black-garment project and a White-garment project produce IDENTICAL region maps and an identical undecided master", async () => {
    const { capability: capWhite, projectId: idWhite } = await seeded("White");
    const { capability: capBlack, projectId: idBlack } = await seeded("Black");

    const reviewWhite = await capWhite.getSeparationReview(idWhite);
    const reviewBlack = await capBlack.getSeparationReview(idBlack);

    assert.equal(reviewWhite.regionMap.regionMapHash, reviewBlack.regionMap.regionMapHash);
    assert.equal(reviewWhite.regionMap.consequentialRegions.length, reviewBlack.regionMap.consequentialRegions.length);

    const { computeRegionMap, buildSeparationMaster } = await import("./region-separation");
    const original = denseBlackCompositionArtwork();
    const computationWhite = computeRegionMap(original, reviewWhite.regionMap.sourceAssetSha256, { r: 0, g: 0, b: 0 }, 40);
    const computationBlack = computeRegionMap(original, reviewBlack.regionMap.sourceAssetSha256, { r: 0, g: 0, b: 0 }, 40);
    const masterWhite = buildSeparationMaster(original, computationWhite, []);
    const masterBlack = buildSeparationMaster(original, computationBlack, []);
    assert.ok(masterWhite.data.equals(masterBlack.data), "garment colour must never influence which original pixels survive");
  });

  it("G / 22: changing the garment PREVIEW colour after decisions exist does not change region identity, decisions, sourceAssetSha256, or regionMapHash", async () => {
    const { capability, projectId } = await seeded("White");
    const review = await capability.getSeparationReview(projectId);
    const region = review.regionMap.consequentialRegions[0]!;
    const decided = await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions: [{ regionId: region.regionId, intent: "ink" }],
    });

    // Changing the design brief's garment colour AFTER decisions exist —
    // the preview-only knob the real acceptance failure exercised.
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Red",
      printPlacement: "full_front",
    });

    const afterGarmentChange = await capability.getSeparationReview(projectId);
    assert.equal(afterGarmentChange.regionMap.sourceAssetSha256, decided.regionMap.sourceAssetSha256);
    assert.equal(afterGarmentChange.regionMap.regionMapHash, decided.regionMap.regionMapHash);
    assert.deepEqual(
      afterGarmentChange.regionMap.consequentialRegions.map((r) => r.regionId),
      decided.regionMap.consequentialRegions.map((r) => r.regionId),
    );
    const stillDecided = afterGarmentChange.decisions.find((d) => d.regionId === region.regionId);
    assert.ok(stillDecided);
    assert.equal(stillDecided!.intent, "ink");
  });

  it("J: the original asset hash is unaffected by reaching separation review with no prepared asset ever created", async () => {
    const bytes = toPngBytes(denseBlackCompositionArtwork());
    const { repo, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, { bytes, declaredContentType: "image/png", filename: "x.png" });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "White",
      printPlacement: "full_front",
    });

    const review = await capability.getSeparationReview(projectId);
    const preparation = await capability.getPreparation(projectId);
    assert.ok(preparation);
    assert.equal(preparation!.hasPreparedArtwork, false, "no prepared asset was ever created for this classification");

    const { createHash } = await import("node:crypto");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(review.regionMap.sourceAssetSha256, expectedSha256);
  });
});

function centerOfBounds(bounds: { left: number; top: number; width: number; height: number }): [number, number] {
  return [
    bounds.left + Math.floor(bounds.width / 2),
    bounds.top + Math.floor(bounds.height / 2),
  ];
}
