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
import { decodePngUpload } from "./image-decode";
import { bowlingStyleArtwork, solidBlackExteriorArtwork, toPngBytes } from "./artwork-fixtures";

/**
 * Phase 27I — TOOLBOX V1: capability-level integration tests for the three
 * NEW tools (Restore Fill, Restore Brush, Eraser) through the real session/
 * replay/finalize architecture, exactly as Magic Wand is already tested in
 * `magic-wand-correction-capability.test.ts`. Deliberately reuses that same
 * harness shape rather than inventing a parallel one.
 */
describe("Phase 27I: correction toolbox (Fill, Brush, Eraser)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-toolbox-"));
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

  async function seeded(image = solidBlackExteriorArtwork()) {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(image);
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "artwork.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
    await capability.prepareBackground(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    const preparedAssetId = preparation!.preparedAssetId!;
    const preparedBytes = (await assets.downloadAssetBytes(preparedAssetId))!.bytes;
    return { repo, assets, capability, projectId, originalBytes, preparedBytes, preparedAssetId };
  }

  async function decodedPixels(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }
  function pixelsEqual(a: { data: Buffer }, b: { data: Buffer }) {
    return Buffer.compare(a.data, b.data) === 0;
  }

  // ---------------------------------------------------------------------
  // Restore Fill: D, E, F, G
  // ---------------------------------------------------------------------

  it("D/F/G: Fill restores an enclosed missing pocket original-byte-exact, and touches nothing outside it", async () => {
    const { capability, projectId, originalBytes } = await seeded();
    const originalPixels = await decodedPixels(originalBytes);

    // Punch a small, radius-bounded hole inside the artwork with Eraser
    // first, so there is something for Fill to find -- deliberately NOT a
    // Wand remove, which would flood-fill the ENTIRE uniformly-coloured
    // white square (this fixture's only foreground content) and merge it
    // with the already-removed background, leaving no enclosed pocket at
    // all. (40,40) sits on the white square -- see
    // `solidBlackExteriorArtwork`'s own doc comment.
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 40, y: 40 }], radius: 4 });
    const afterRemove = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const idx = (40 * afterRemove.width + 40) * 4;
    assert.equal(afterRemove.data[idx + 3], 0, "sanity: the area must actually be missing before Fill runs");

    const preview = await capability.previewCorrectionSelection(projectId, { tool: "restore_fill", click: { x: 40, y: 40 } });
    assert.notEqual(preview.pixelCount, 0, "Fill must find the missing pocket");
    assert.ok(!preview.refused, "an enclosed pocket must not be refused");

    await capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: { x: 40, y: 40 } });
    const afterFill = await decodedPixels(await capability.getCorrectionResultPng(projectId));

    // F: original-byte-exact at the restored pixels.
    assert.equal(afterFill.data[idx], originalPixels.data[idx]);
    assert.equal(afterFill.data[idx + 1], originalPixels.data[idx + 1]);
    assert.equal(afterFill.data[idx + 2], originalPixels.data[idx + 2]);
    assert.equal(afterFill.data[idx + 3], originalPixels.data[idx + 3]);

    // G: pixels far outside the filled pocket are untouched vs. right before Fill ran.
    const farIdx = (5 * afterFill.width + 5) * 4;
    assert.equal(afterFill.data[farIdx], afterRemove.data[farIdx]);
    assert.equal(afterFill.data[farIdx + 3], afterRemove.data[farIdx + 3]);
  });

  it("E: Fill refuses a border-connected (unsafe) area with plain-language guidance, and applies nothing", async () => {
    const { repo, capability, projectId, preparedAssetId } = await seeded();
    // (1,1) sits in the fixture's black exterior, which is connected to the
    // canvas border by construction -- remove it with Wand, then Fill must
    // refuse the resulting border-connected transparent region.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 1, y: 1 }], mode: "remove", toleranceLevel: "default" });

    const preview = await capability.previewCorrectionSelection(projectId, { tool: "restore_fill", click: { x: 1, y: 1 } });
    assert.equal(preview.refused, true);
    assert.match(preview.refusalReason ?? "", /isn't enclosed/i);
    assert.match(preview.refusalReason ?? "", /Brush/i);

    await assert.rejects(
      () => capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: { x: 1, y: 1 } }),
      /isn't enclosed/i,
      "accept must refuse too, not just preview -- the gate is server-side, not just in the UI",
    );

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, preparedAssetId, "a refused Fill must not repoint the authoritative asset");
  });

  it("clicking a non-missing point with Fill finds nothing to restore", async () => {
    const { capability, projectId } = await seeded();
    const preview = await capability.previewCorrectionSelection(projectId, { tool: "restore_fill", click: { x: 40, y: 40 } });
    assert.equal(preview.pixelCount, 0);
    assert.ok(!preview.refused);
  });

  // ---------------------------------------------------------------------
  // Restore Brush: H, J
  // ---------------------------------------------------------------------

  it("H: Brush restores original pixels exactly along a multi-point stroke, RGB and alpha both", async () => {
    const { capability, projectId, originalBytes } = await seeded();
    const originalPixels = await decodedPixels(originalBytes);

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const afterRemove = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const idx = (40 * afterRemove.width + 40) * 4;
    assert.equal(afterRemove.data[idx + 3], 0, "sanity: missing before brush runs");

    await capability.acceptCorrectionOperation(projectId, {
      tool: "restore_brush",
      points: [{ x: 36, y: 40 }, { x: 40, y: 40 }, { x: 44, y: 40 }],
      radius: 6,
    });
    const afterBrush = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    for (const x of [36, 40, 44]) {
      const i = (40 * afterBrush.width + x) * 4;
      assert.equal(afterBrush.data[i], originalPixels.data[i], `R at x=${x} must match original exactly`);
      assert.equal(afterBrush.data[i + 1], originalPixels.data[i + 1], `G at x=${x} must match original exactly`);
      assert.equal(afterBrush.data[i + 2], originalPixels.data[i + 2], `B at x=${x} must match original exactly`);
      assert.equal(afterBrush.data[i + 3], originalPixels.data[i + 3], `A at x=${x} must match original exactly`);
    }
  });

  it("J: one Brush stroke is exactly one undo unit -- undo removes the WHOLE stroke, not one sampled point", async () => {
    const { capability, projectId } = await seeded();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const beforeBrush = await decodedPixels(await capability.getCorrectionResultPng(projectId));

    await capability.acceptCorrectionOperation(projectId, {
      tool: "restore_brush",
      points: [{ x: 36, y: 40 }, { x: 38, y: 40 }, { x: 40, y: 40 }, { x: 42, y: 40 }, { x: 44, y: 40 }],
      radius: 6,
    });
    const info = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(info.operationCount, 2, "Wand remove + one brush stroke = exactly 2 operations");

    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(beforeBrush, afterUndo), "undo must revert the ENTIRE stroke in one step");
  });

  // ---------------------------------------------------------------------
  // Eraser: K, L, M
  // ---------------------------------------------------------------------

  it("K/L: Eraser lowers alpha only within the stroke footprint, never touching RGB or unrelated pixels", async () => {
    const { capability, projectId } = await seeded();
    const before = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    // (50,50) sits on the white square, which starts opaque in the prepared
    // base -- (5,5)'s background is already removed by automatic
    // preparation before this session even starts.
    const strokeIdx = (50 * before.width + 50) * 4;
    const rgbBefore = [before.data[strokeIdx], before.data[strokeIdx + 1], before.data[strokeIdx + 2]];
    assert.equal(before.data[strokeIdx + 3], 255, "artwork starts opaque in the prepared base");

    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 50, y: 50 }], radius: 3 });
    const after = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.equal(after.data[strokeIdx + 3], 0, "erased pixel must become transparent");
    assert.deepEqual([after.data[strokeIdx], after.data[strokeIdx + 1], after.data[strokeIdx + 2]], rgbBefore, "erase must only ever change alpha, never RGB");

    // L: an unrelated far-away pixel (still on the square, outside the stroke radius) must be completely unchanged.
    const farIdx = (60 * after.width + 60) * 4;
    assert.deepEqual(
      [after.data[farIdx], after.data[farIdx + 1], after.data[farIdx + 2], after.data[farIdx + 3]],
      [before.data[farIdx], before.data[farIdx + 1], before.data[farIdx + 2], before.data[farIdx + 3]],
      "unrelated pixels far from the stroke must be byte-identical",
    );
  });

  it("M: one Eraser stroke is exactly one undo unit", async () => {
    const { capability, projectId } = await seeded();
    const before = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    await capability.acceptCorrectionOperation(projectId, {
      tool: "erase_brush",
      points: [{ x: 5, y: 5 }, { x: 7, y: 5 }, { x: 9, y: 5 }],
      radius: 3,
    });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1);
    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(before, afterUndo));
  });

  // ---------------------------------------------------------------------
  // Session-wide invariants: P, Q, R, S, T
  // ---------------------------------------------------------------------

  it("P: Start Over reproduces the PREPARED base exactly, even after a mix of every new tool", async () => {
    const { capability, projectId, preparedBytes } = await seeded();
    const preparedPixels = await decodedPixels(preparedBytes);

    // Eraser (not Wand remove) punches the hole Fill then restores -- a Wand
    // remove would flood-fill the entire uniformly-coloured square and merge
    // it with the already-removed background, leaving no enclosed pocket.
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 40, y: 40 }], radius: 4 });
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: { x: 40, y: 40 } });
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [{ x: 41, y: 41 }], radius: 4 });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 5, y: 5 }], radius: 3 });

    await capability.resetCorrectionSession(projectId);
    const afterReset = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(preparedPixels, afterReset), "Start Over must reproduce the PREPARED base exactly regardless of which tools were used");
  });

  it("Q: undoing every operation one at a time (undo-to-zero) reproduces the PREPARED base exactly", async () => {
    const { capability, projectId, preparedBytes } = await seeded();
    const preparedPixels = await decodedPixels(preparedBytes);

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [{ x: 40, y: 40 }], radius: 4 });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 5, y: 5 }], radius: 3 });

    await capability.undoCorrectionOperation(projectId);
    await capability.undoCorrectionOperation(projectId);
    await capability.undoCorrectionOperation(projectId);
    const afterUndoToZero = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(preparedPixels, afterUndoToZero), "undo-to-zero must reproduce the PREPARED base exactly across mixed tools");
  });

  it("R: mixed-tool replay is deterministic -- Wand -> Brush -> Eraser -> Fill recomputes to the same bytes every time", async () => {
    const { capability, projectId } = await seeded();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [{ x: 40, y: 40 }], radius: 6 });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 5, y: 5 }], radius: 3 });
    // Remove a fresh enclosed patch, then Fill it back -- exercises all four tools in one session.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 41, y: 41 }], mode: "remove", toleranceLevel: "less" });

    const first = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const second = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const third = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(first, second));
    assert.ok(pixelsEqual(second, third));
  });

  it("S: stale/invalid tool inputs fail closed rather than silently applying something", async () => {
    const { capability, projectId } = await seeded();
    await assert.rejects(() => capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [], radius: 6 }));
    await assert.rejects(() => capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [{ x: 1, y: 1 }], radius: 0 }));
    await assert.rejects(() => capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [{ x: 1, y: 1 }], radius: -3 }));
    await assert.rejects(() => capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: { x: -1, y: -1 } as { x: number; y: number } }));
  });

  it("T: Final Review (getCorrectionResultPng) equals the persisted asset after Use This Artwork, for a mixed-tool session", async () => {
    const { repo, assets, capability, projectId } = await seeded();
    // Eraser (not Wand remove) so the hole Fill restores stays enclosed --
    // see "P"'s comment above.
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 40, y: 40 }], radius: 4 });
    await capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: { x: 40, y: 40 } });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 5, y: 5 }], radius: 3 });

    const reviewed = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const persisted = await decodedPixels((await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes);
    assert.ok(pixelsEqual(reviewed, persisted), "Final Review and the persisted asset must be byte-identical");
  });

  // ---------------------------------------------------------------------
  // Phase 27H interaction: U, V
  // ---------------------------------------------------------------------

  it("U: a mixed-tool manual session finalizes and remains authoritative under Phase 27H even for artwork that independently requires separation review", async () => {
    const { capability, projectId } = await seeded(bowlingStyleArtwork());
    const review = await capability.getSeparationReview(projectId);
    assert.notEqual(review.state, "review_not_required", "sanity: this fixture requires separation review");

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 6, y: 6 }], radius: 2 });

    const view = await capability.finalizeCorrection(projectId);
    assert.equal(view.hasPreparedArtwork, true, "finalize must succeed despite the pending separation review (Phase 27H authority)");

    const after = await capability.getSeparationReview(projectId);
    assert.equal(after.state, "review_not_required", "operator must not be sent back to the old review after a mixed-tool manual override");
  });

  it("V: the automatic path remains fully gated -- approvePreparedArtwork still refuses for separation-review artwork untouched by any manual tool", async () => {
    const { capability, projectId } = await seeded(bowlingStyleArtwork());
    await assert.rejects(
      () => capability.approvePreparedArtwork(projectId),
      /confirmation before it can be used/i,
    );
  });

  it("garment colour has zero effect on toolbox correction pixels", async () => {
    const black = await seeded();
    const white = await (async () => {
      const { repo, capability } = await harness();
      const projectId = (await repo.createProject()).project.id;
      const originalBytes = toPngBytes(solidBlackExteriorArtwork());
      await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "artwork.png" });
      await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "White", printPlacement: "full_front" });
      await capability.prepareBackground(projectId);
      return { capability, projectId };
    })();

    for (const { capability, projectId } of [black, white]) {
      await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
      await capability.acceptCorrectionOperation(projectId, { tool: "restore_brush", points: [{ x: 40, y: 40 }], radius: 6 });
    }
    const blackResult = await decodedPixels(await black.capability.getCorrectionResultPng(black.projectId));
    const whiteResult = await decodedPixels(await white.capability.getCorrectionResultPng(white.projectId));
    assert.ok(pixelsEqual(blackResult, whiteResult), "garment colour must have zero effect on correction pixels");
  });
});
