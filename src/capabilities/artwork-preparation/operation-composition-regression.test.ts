import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { toPngBytes, bowlingStyleArtwork } from "./artwork-fixtures";
import { buildIndependentSeparationMaster } from "./separation-master-test-support";

/**
 * Phase 27J — REGRESSION for the operation-composition/replay defect human
 * acceptance found on the real INCREDI-BOWLS artwork: removing a second
 * independent region (B) silently un-does an earlier accepted removal (D).
 *
 * Deterministic fixture first (this file), then the same sequence against
 * the real asset (`incredi-bowls-operation-composition-acceptance.test.ts`).
 *
 * Fixture: a black canvas with THREE independent white squares ("D", "B",
 * "R"), far enough apart that none are colour- or spatially-connected to
 * one another -- each is its own isolated flood-fill region, exactly like
 * three separate letter counters in real text.
 */
function threeIndependentRegionsArtwork(): RgbaImage {
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
  // D, B, R -- each a 10x10 white square, 30px apart, none touching.
  fillSquare(10, 15, 10); // "D": centre (15,20)
  fillSquare(50, 15, 10); // "B": centre (55,20)
  fillSquare(90, 15, 10); // "R": centre (95,20)
  return { width, height, data };
}

const D = { x: 15, y: 20 };
const B = { x: 55, y: 20 };
const R = { x: 95, y: 20 };

describe("Phase 27J: operation-composition/replay regression (D/B/R fixture)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-op-composition-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seeded() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(threeIndependentRegionsArtwork());
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "dbr.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
    await capability.prepareBackground(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    const preparedBytes = (await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes;
    // The D/B/R fixture's in-bounds gaps between the squares are not
    // `fullRemovalSafe`, so this artwork requires Intelligent Separation
    // review and the correction workspace's real base is the PENDING
    // separation master (which retains those gaps), never the automatic
    // `preparedBytes` asset -- see "Fix Separation Review -> Edit Artwork
    // Authority Handoff".
    const separationMaster = await buildIndependentSeparationMaster(repo, projectId, originalBytes);
    return { repo, assets, capability, projectId, originalBytes, preparedBytes, separationMasterPixels: separationMaster };
  }

  async function decoded(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }
  function alphaAt(image: RgbaImage, p: { x: number; y: number }) {
    return image.data[(p.y * image.width + p.x) * 4 + 3];
  }

  it("A-G: accepted Wand remove operations compose cumulatively -- removing B must not restore D, removing R must not restore D or B", async () => {
    const { capability, projectId } = await seeded();

    // B: accept remove D.
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    // C: assert D transparent.
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "C: D must be transparent after removing D");

    // D: accept remove B.
    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    // E: assert D still transparent, B transparent.
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "E: D must STILL be transparent after removing B -- this is the human-reported bug");
    assert.equal(alphaAt(result, B), 0, "E: B must be transparent after removing B");

    // F: accept remove R.
    await capability.acceptCorrectionOperation(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });
    // G: assert D, B still transparent, R transparent.
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "G: D must still be transparent after removing R");
    assert.equal(alphaAt(result, B), 0, "G: B must still be transparent after removing R");
    assert.equal(alphaAt(result, R), 0, "G: R must be transparent after removing R");
  });

  it("§9: reverse composition -- Undo 1/2/3 in reverse order restores R, then B, then D, ending byte-identical to the prepared base", async () => {
    const { capability, projectId, separationMasterPixels } = await seeded();

    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });

    // Undo 1 -> R restored, D+B remain removed.
    await capability.undoCorrectionOperation(projectId);
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "Undo 1: D remains removed");
    assert.equal(alphaAt(result, B), 0, "Undo 1: B remains removed");
    assert.equal(alphaAt(result, R), 255, "Undo 1: R must be restored");

    // Undo 2 -> B restored, D remains removed.
    await capability.undoCorrectionOperation(projectId);
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "Undo 2: D remains removed");
    assert.equal(alphaAt(result, B), 255, "Undo 2: B must be restored");

    // Undo 3 -> D restored, result == original byte-for-byte.
    await capability.undoCorrectionOperation(projectId);
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 255, "Undo 3: D must be restored");
    assert.equal(Buffer.compare(result.data, separationMasterPixels.data), 0, "Undo 3: result must equal the separation-review base byte-for-byte");
  });

  it("§10: mixed-tool composition -- Wand remove D -> Brush restore unrelated pixels -> Eraser punch an enclosed pocket in R -> Fill restore it -> Wand remove B, every prior operation remains present, then reverse-Undo restores each in turn", async () => {
    const { capability, projectId, separationMasterPixels } = await seeded();

    // Wand remove D.
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D removed");

    // Brush restore some background pixels -- already removed by automatic
    // preparation (base = prepared), so this is a legitimate no-op-on-bytes
    // operation, still its own history entry.
    const brushPoint = { x: 5, y: 5 };
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [brushPoint], radius: 3 });

    // Eraser punches a small hole INSIDE the still-fully-opaque R square
    // (not a background point -- the exterior background is already one
    // huge border-connected transparent region by the time this session
    // starts, so a hole punched there would never be enclosed). R is
    // otherwise untouched throughout this test, so an eraser hole here
    // stays genuinely enclosed for Fill to find.
    const eraserPoint = { x: 94, y: 19 };
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [eraserPoint], radius: 3 });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, eraserPoint), 0, "eraser point removed");
    assert.equal(alphaAt(result, D), 0, "D remains removed after Brush+Eraser");

    // Fill restore the enclosed pocket just punched in R.
    const fillPreview = await capability.previewCorrectionSelection(projectId, { tool: "restore_fill", click: eraserPoint });
    assert.ok(!fillPreview.refused, "sanity: the eraser-created hole must be enclosed and fillable");
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: eraserPoint });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, eraserPoint), 255, "Fill restored the eraser point");
    assert.equal(alphaAt(result, D), 0, "D STILL remains removed after Fill -- this is the composition invariant under test");

    // Wand remove B.
    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D remains removed after the final Wand op");
    assert.equal(alphaAt(result, B), 0, "B removed");
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 5, "all five mixed-tool operations must be present in history");

    // Reverse: Undo each of the 5 operations in turn, ending at the prepared base.
    for (let i = 0; i < 5; i += 1) {
      await capability.undoCorrectionOperation(projectId);
    }
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(result.data, separationMasterPixels.data), 0, "undoing all 5 mixed-tool operations must reproduce the separation-review base exactly");
  });

  it("§13: Start Over after D+B+R reproduces the prepared base exactly, and a fresh D removal afterward has no ghost B/R state", async () => {
    const { capability, projectId, separationMasterPixels } = await seeded();

    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });

    await capability.resetCorrectionSession(projectId);
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(result.data, separationMasterPixels.data), 0, "Start Over must reproduce the separation-review base exactly");
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0, "Start Over must clear operation history to zero");

    // Fresh D removal after Start Over -- confirm no ghost B/R state.
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "fresh D removal must apply");
    assert.equal(alphaAt(result, B), 255, "no ghost B removal must survive Start Over");
    assert.equal(alphaAt(result, R), 255, "no ghost R removal must survive Start Over");
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1, "history must contain exactly the one fresh operation");
  });

  it("§14: tool-switch does not reset accepted operation history -- Wand remove D -> switch Brush -> switch back to Wand -> remove B; D remains removed", async () => {
    // Tool switching is a pure CLIENT-side concept (`activeTool` state in
    // CorrectionWorkspace.tsx) -- nothing server-side to "switch". This
    // test proves the underlying invariant the UI depends on: the
    // capability's accepted-operation history is never touched by anything
    // other than accept/undo/reset, so no matter what the client's local
    // `activeTool` does between calls, prior history survives.
    const { capability, projectId } = await seeded();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D removed");

    // "Switch to Brush" and back -- no server calls happen for a pure tool
    // switch (see `selectTool` in CorrectionWorkspace.tsx), so nothing to
    // call here; merely re-reading the result must not change anything.
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "re-reading the result between tool switches must not change D's state");

    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D must remain removed after a tool switch followed by a new operation");
    assert.equal(alphaAt(result, B), 0, "B removed");
  });

  it("§11/§15: cumulative D+B+R survives Done Editing -> Final Review -> Use This Artwork, and remains authoritative under Phase 27H even for artwork that independently requires separation review", async () => {
    const { repo, assets, capability, projectId } = await (async () => {
      const { repo, assets, capability } = await (async () => {
        const { LocalProjectRepository } = await import("@/lib/db/local-store");
        const r = new LocalProjectRepository();
        const a = createAssetCapability(r, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
        const c = createArtworkPreparationCapability(r, a, createDesignBriefCapability(r));
        return { repo: r, assets: a, capability: c };
      })();
      const projectId = (await repo.createProject()).project.id;
      await capability.uploadOriginal(projectId, {
        bytes: toPngBytes(bowlingStyleArtwork()),
        declaredContentType: "image/png",
        filename: "dbr-separation.png",
      });
      await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
      await capability.prepareBackground(projectId);
      return { repo, assets, capability, projectId };
    })();

    const review = await capability.getSeparationReview(projectId);
    assert.notEqual(review.state, "review_not_required", "sanity: this fixture requires separation review");

    // D/B/R-style sequence: three independent clicks, each its own operation.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 6, y: 6 }], radius: 1 });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 7, y: 7 }], radius: 1 });

    const finalReview = await decoded(await capability.getCorrectionResultPng(projectId));
    const view = await capability.finalizeCorrection(projectId);
    assert.equal(view.hasPreparedArtwork, true, "finalize must succeed despite pending separation review (Phase 27H authority)");

    const preparation = await repo.getArtworkPreparation(projectId);
    const persisted = await decoded((await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes);
    assert.equal(Buffer.compare(finalReview.data, persisted.data), 0, "persisted asset must equal Final Review's cumulative result exactly -- no earlier operation may disappear during finalization");

    const snapshot = await repo.getProject(projectId);
    const version = snapshot!.artworkVersions.find((v) => v.id === preparation!.preparedArtworkVersionId);
    const downstream = await decoded((await assets.downloadAssetBytes(version!.primaryAssetId!))!.bytes);
    assert.equal(Buffer.compare(finalReview.data, downstream.data), 0, "downstream ArtworkVersion source must equal the cumulative result exactly");

    const reviewAfter = await capability.getSeparationReview(projectId);
    assert.equal(reviewAfter.state, "review_not_required", "the accepted cumulative manual result must remain authoritative -- never routed back into the old separation review");
  });
});
