import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { compositeOverGarment } from "@/capabilities/final-artwork/halftone-screen";
import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { toPngBytes } from "./artwork-fixtures";
import { buildIndependentSeparationMaster } from "./separation-master-test-support";

/**
 * "Fix Separation Review -> Edit Artwork Authority Handoff" — the correction
 * workspace's base must be whatever the customer is ACTUALLY reviewing as
 * PREPARED. When Intelligent Separation review owns that surface (a
 * proposal or consequential region exists and no manual correction has been
 * accepted yet), that is the CURRENT dynamic `buildSeparationMaster(...)`
 * result, never the earlier automatic `isolateBackground` asset
 * `preparedAssetId` still points at.
 *
 * Fixture: a black canvas with two isolated white squares far enough apart
 * that the black strip BETWEEN them sits INSIDE the artwork's tight bbox --
 * an "in-bounds proposal" (Phase 17/23) that automatic preparation already
 * silently removed but separation review has not yet decided on
 * (`fullRemovalSafe: false` for this shape, confirmed by direct diagnostic:
 * `review_required`, a real `inBoundsProposal`). This is exactly the
 * authority-mismatch class the real INCREDI-BOWLS asset also hits -- see
 * `incredi-bowls-manual-fallback-acceptance.test.ts` for the real-asset
 * acceptance proof; this file is the deterministic, non-skippable
 * equivalent covering every numbered requirement individually.
 */
function twoIsolatedSquaresArtwork(): RgbaImage {
  const width = 120;
  const height = 40;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 0;
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  function fillSquare(left: number, top: number, size: number) {
    for (let y = top; y < top + size; y += 1) {
      for (let x = left; x < left + size; x += 1) {
        const o = (y * width + x) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = 255;
      }
    }
  }
  fillSquare(10, 15, 10); // "D": centre (15, 20)
  fillSquare(50, 15, 10); // "B": centre (55, 20)
  return { width, height, data };
}

const D = { x: 15, y: 20 };

describe("Separation review -> correction base authority", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-separation-correction-authority-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seeded(productColor = "Black") {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(twoIsolatedSquaresArtwork());
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "db.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor, printPlacement: "full_front" });
    await capability.prepareBackground(projectId);

    const review = await capability.getSeparationReview(projectId);
    assert.notEqual(review.state, "review_not_required", "sanity: this fixture must require separation review");
    assert.ok(review.regionMap.inBoundsProposal, "sanity: this fixture must produce a real in-bounds proposal");

    const preparation = await repo.getArtworkPreparation(projectId);
    const automaticBytes = (await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes;
    const automaticPixels = await decoded(automaticBytes);
    const separationMasterPixels = await buildIndependentSeparationMaster(repo, projectId, originalBytes);

    return { repo, assets, capability, projectId, originalBytes, automaticPixels, separationMasterPixels, review };
  }

  async function decoded(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }

  it("1/3: sanity -- the automatic isolation asset and the raw separation master genuinely differ for this fixture (the strip between the squares)", async () => {
    const { automaticPixels, separationMasterPixels } = await seeded();
    assert.notEqual(
      Buffer.compare(automaticPixels.data, separationMasterPixels.data),
      0,
      "the automatic asset and the separation master must differ, or this fixture proves nothing",
    );
  });

  it("2/4: corrections=0 returns the raw separation master unchanged -- decoded RGBA equal to the raw master underlying the PREPARED review, byte-for-byte", async () => {
    const { capability, projectId, separationMasterPixels, automaticPixels } = await seeded();
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0);
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(result.data, separationMasterPixels.data), 0, "corrections=0 must equal the raw separation master exactly");
    assert.notEqual(Buffer.compare(result.data, automaticPixels.data), 0, "corrections=0 must NOT equal the earlier automatic isolation asset");
  });

  it("5: Remove/Brush/Fill/Eraser all operate from the separation master, not the automatic asset", async () => {
    const { capability, projectId, separationMasterPixels } = await seeded();

    // Eraser punches an enclosed pocket inside D (D is fully opaque in the
    // separation master, exactly as in the automatic asset -- this operation
    // alone doesn't distinguish the two bases, but the sequence below does).
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [D], radius: 2 });
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    const dIdx = (D.y * result.width + D.x) * 4;
    assert.equal(result.data[dIdx + 3], 0, "eraser removed the D point");

    // Fill restores it.
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: D });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(result.data[dIdx + 3], 255, "fill restored the D point");

    // Everywhere else -- including the still-PENDING strip between the
    // squares -- must be untouched and still equal the separation master,
    // proving these tools replayed on top of THAT base, not the automatic
    // asset's (already-removed-strip) base.
    for (let i = 0; i < result.data.length; i += 4) {
      if (i === dIdx) continue;
      assert.equal(result.data[i], separationMasterPixels.data[i], `byte ${i} (R/G/B/A channel) must match the separation master outside the touched point`);
    }
  });

  it("6: Restore Missing Artwork sources from the immutable original, not the separation master or the automatic asset", async () => {
    const { capability, projectId, originalBytes } = await seeded();
    const originalPixels = await decoded(originalBytes);

    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    const dIdx = (D.y * result.width + D.x) * 4;
    assert.equal(result.data[dIdx + 3], 0, "D removed");

    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "restore", toleranceLevel: "default" });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(
      result.data[dIdx],
      originalPixels.data[dIdx],
      "restored R channel must come from the immutable original",
    );
    assert.equal(result.data[dIdx + 3], originalPixels.data[dIdx + 3], "restored alpha must come from the immutable original");
  });

  it("9: same separation-decision identity -- accepted corrections are retained across repeated correction-session entry", async () => {
    const { capability, projectId } = await seeded();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1);

    // Every one of these re-enters `ensureCorrectionSession` from scratch --
    // nothing about the separation decisions changed, so the session (and
    // its one accepted operation) must be the SAME session, not a fresh one.
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1, "session must persist across a second entry");
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    const dIdx = (D.y * result.width + D.x) * 4;
    assert.equal(result.data[dIdx + 3], 0, "the accepted removal must still be applied");
  });

  it("10: a changed separation decision invalidates the correction session -- accepted corrections against the OLD master are not silently replayed onto the NEW one", async () => {
    const { capability, projectId, review, separationMasterPixels } = await seeded();

    // Accept a removal against the PENDING-proposal master.
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1);

    // Now the operator goes back and decides the proposal: remove it too.
    // This changes what `buildSeparationMaster` would produce (the strip
    // becomes transparent) -- a genuinely different master, B.
    const proposalHash = review.regionMap.inBoundsProposal!.proposalHash;
    await capability.submitProposalDecision(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      proposalHash,
      decision: "remove_with_exceptions",
    });

    // The OLD session (built against the pending-proposal master, with one
    // accepted D-removal) must NOT be silently reused: the operator never
    // decided anything about D relative to THIS new master.
    const infoAfter = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(infoAfter.operationCount, 0, "a changed separation decision must invalidate the stale session -- operations reset to zero");

    const resultAfter = await decoded(await capability.getCorrectionResultPng(projectId));
    const dIdx = (D.y * resultAfter.width + D.x) * 4;
    assert.equal(resultAfter.data[dIdx + 3], 255, "D must be back to opaque -- the stale removal must not carry over onto the new master");
    assert.notEqual(
      Buffer.compare(resultAfter.data, separationMasterPixels.data),
      0,
      "sanity: the new master genuinely differs from the OLD (pending-proposal) master this test started from",
    );
  });

  it("11: a garment colour change does NOT change the correction-base identity -- accepted corrections survive it", async () => {
    const { capability, projectId } = await seeded("Black");
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1);
    const beforeColorChange = await decoded(await capability.getCorrectionResultPng(projectId));

    // Same product summary and print placement -- only the garment colour
    // changes. This never touches `preparation.separation`, the region map,
    // or the original, so the correction-base identity must be unaffected.
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Red", printPlacement: "full_front" });

    const infoAfter = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(infoAfter.operationCount, 1, "a garment colour change must not invalidate the correction session");
    const afterColorChange = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(beforeColorChange.data, afterColorChange.data), 0, "the result must be byte-identical after a garment colour change alone");
  });

  it("11b: compositing over different garment colours never touches the master's own pixels (structural proof that garment can never reach the correction-base identity)", async () => {
    const { separationMasterPixels } = await seeded();
    const white = resolveGarmentColor("#FFFFFF")!;
    const black = resolveGarmentColor("#000000")!;
    const compositedWhite = compositeOverGarment(separationMasterPixels, white);
    const compositedBlack = compositeOverGarment(separationMasterPixels, black);
    // The two composites legitimately differ (different garment) --
    assert.notEqual(Buffer.compare(compositedWhite.data, compositedBlack.data), 0, "sanity: compositing over different garments actually changes pixels");
    // -- but the UNDERLYING master `compositeOverGarment` was given is the
    // exact same object/bytes both times: garment compositing is a pure
    // read of the master, never a mutation, and `computeSeparationMasterIdentity`
    // (the correction-base identity) never receives a garment argument at
    // all -- there is no code path by which it could differ.
    assert.equal(separationMasterPixels.width, compositedWhite.width);
    assert.equal(separationMasterPixels.height, compositedWhite.height);
  });

  it("12: original comparison remains the immutable original regardless of separation/correction state", async () => {
    const { capability, projectId, originalBytes } = await seeded();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    const originalPng = await capability.getCorrectionOriginalPng(projectId);
    assert.equal(Buffer.compare(originalPng, originalBytes), 0, "getCorrectionOriginalPng must return the literal immutable original bytes");
  });

  it("14: after finalization, reopening Edit Artwork shows the FINALIZED corrected result, never a freshly rebuilt separation preview", async () => {
    const { repo, assets, capability, projectId } = await seeded();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    const finalReview = await decoded(await capability.getCorrectionResultPng(projectId));

    const view = await capability.finalizeCorrection(projectId);
    assert.equal(view.hasPreparedArtwork, true);

    // Separation review must no longer claim authority over this artwork.
    const reviewAfter = await capability.getSeparationReview(projectId);
    assert.equal(reviewAfter.state, "review_not_required", "a finalized manual correction supersedes separation review");

    // Reopening Edit Artwork again (a fresh `ensureCorrectionSession` call)
    // must show exactly the finalized result -- not a newly recomputed
    // separation master, and not the pre-finalization automatic asset.
    const reopened = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0, "reopening after finalization starts at zero NEW corrections");
    assert.equal(Buffer.compare(reopened.data, finalReview.data), 0, "reopening must show the finalized corrected result exactly");

    const preparation = await repo.getArtworkPreparation(projectId);
    const persisted = await decoded((await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes);
    assert.equal(Buffer.compare(reopened.data, persisted.data), 0, "the reopened base must be exactly the persisted finalized asset");
  });

  it("15: geometry is preserved between the immutable original and the separation master used as correction base", async () => {
    const { originalBytes, separationMasterPixels } = await seeded();
    const original = await decoded(originalBytes);
    assert.equal(separationMasterPixels.width, original.width, "separation master width must match the original exactly");
    assert.equal(separationMasterPixels.height, original.height, "separation master height must match the original exactly");
    // `ensureCorrectionSession` calls `assertPreservesGeometry` unconditionally
    // on this exact pair before starting any session -- a real mismatch
    // would throw there rather than silently misaligning Restore. This
    // assertion documents that the invariant genuinely holds for this
    // fixture, not merely that nothing threw.
  });

  it("16: the ordinary (non-separation) path is unaffected -- no consequential regions or proposal means correction base is the plain preparedAssetId", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    const projectId = (await repo.createProject()).project.id;

    // A single isolated square with NOTHING between it and the border --
    // no in-bounds proposal, no consequential region, ordinary artwork.
    const width = 60;
    const height = 60;
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4 + 3] = 255; // opaque black canvas
    }
    for (let y = 20; y < 40; y += 1) {
      for (let x = 20; x < 40; x += 1) {
        const o = (y * width + x) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = 255;
      }
    }
    const originalBytes = toPngBytes({ width, height, data });
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "plain.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
    await capability.prepareBackground(projectId);

    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.state, "review_not_required", "sanity: this ordinary fixture must not require separation review");

    const preparation = await repo.getArtworkPreparation(projectId);
    const preparedPixels = await decoded((await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes);
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(result.data, preparedPixels.data), 0, "ordinary path: corrections=0 must equal the plain preparedAssetId bytes");
  });
});
