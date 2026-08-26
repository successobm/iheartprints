import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";

/**
 * Phase 27I §H — REAL-ASSET ACCEPTANCE for the new toolbox (Restore Fill,
 * Restore Brush, Eraser), using the exact real INCREDI-BOWLS upload.
 * Read-only on the customer's file; isolated local repo throughout, no
 * live production project touched (same discipline as
 * `incredi-bowls-manual-fallback-acceptance.test.ts` from Phase 27G/H).
 *
 * COORDINATES USED HERE were determined empirically against this exact
 * file (image is 584x640) -- NOT guessed, NOT visually eyeballed into the
 * test: (292,300) sits on the dark mask/ball-edge transition, and its
 * WAND RESTORE tolerance behaviour was probed directly (see the Phase 27I
 * report): Less=1px, Default=21px (safely enclosed), More=258,084px
 * spanning the ENTIRE canvas and touching the border -- a real,
 * reproduced instance of exactly the connectivity trap this phase exists
 * to work around, on the exact real asset. (292,250)/(270,230)/etc. sit
 * solidly inside the bowling ball's own dark fill, confirmed by direct
 * pixel sampling.
 */
const INCREDI_BOWLS_PATH = "C:\\Users\\eric\\Downloads\\e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png";
const EXPECTED_SHA256 = "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";
const hasAsset = existsSync(INCREDI_BOWLS_PATH);

function countChangedPixels(a: { data: Buffer; width: number; height: number }, b: { data: Buffer; width: number; height: number }) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
      changed += 1;
    }
  }
  return changed;
}

describe("INCREDI-BOWLS real-asset acceptance — Phase 27I toolbox (Fill, Brush, Eraser)", { skip: !hasAsset }, () => {
  let tempDir = "";
  let previousCwd = "";
  let originalBytes: Buffer;

  before(() => {
    originalBytes = readFileSync(INCREDI_BOWLS_PATH);
    const actualSha256 = createHash("sha256").update(originalBytes).digest("hex");
    assert.equal(actualSha256, EXPECTED_SHA256, "INCREDI-BOWLS asset SHA256 must match before use");

    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-incredi-bowls-toolbox-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seed() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "incredi-bowls.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
    await capability.prepareBackground(projectId);
    return { repo, assets, capability, projectId };
  }

  async function decoded(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }

  it("1-3: Magic Wand cannot safely restore near the ball without also reconnecting to the ENTIRE background -- reproduced on the real asset", async () => {
    const { capability, projectId } = await seed();
    // Remove a small, deliberate defect right at the mask/ball edge.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 292, y: 300 }], mode: "remove", toleranceLevel: "default" });

    const less = await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 292, y: 300 }], mode: "restore", toleranceLevel: "less" });
    const def = await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 292, y: 300 }], mode: "restore", toleranceLevel: "default" });
    const more = await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 292, y: 300 }], mode: "restore", toleranceLevel: "more" });

    assert.ok(less.pixelCount >= 1 && less.pixelCount < 100, "Less must under-restore or restore only a tiny area");
    assert.ok(def.pixelCount > 0 && !def.touchesEdge, "Default restores a small, safely enclosed area");
    assert.ok(more.touchesEdge === true, "More must reconnect to the border-touching exterior background");
    assert.ok(more.pixelCount > 200_000, "More's restore selection balloons to cover essentially the whole canvas");
    assert.ok(more.pixelCount > def.pixelCount * 1000, "the jump from Default to More is catastrophic, not a gradual widening");
  });

  it("4/RESTORE FILL: Fill safely identifies and restores an enclosed defect deep inside the ball's own fill, original-byte-exact", async () => {
    const { capability, projectId } = await seed();
    const originalPixels = await decoded(originalBytes);

    // Punch a small, deliberately isolated hole solidly inside the ball
    // with Eraser (no colour-connectivity risk at all), then use Fill.
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 292, y: 250 }], radius: 4 });
    const damaged = await decoded(await capability.getCorrectionResultPng(projectId));
    const idx = (250 * damaged.width + 292) * 4;
    assert.equal(damaged.data[idx + 3], 0, "sanity: the ball defect must actually be missing");

    const preview = await capability.previewCorrectionSelection(projectId, { tool: "restore_fill", click: { x: 292, y: 250 } });
    assert.ok(!preview.refused, "an isolated defect inside the ball must be found enclosed, not refused");
    assert.ok(preview.pixelCount > 0);

    await capability.acceptCorrectionOperation(projectId, { tool: "restore_fill", click: { x: 292, y: 250 } });
    const restored = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(restored.data[idx], originalPixels.data[idx], "R must match original exactly");
    assert.equal(restored.data[idx + 1], originalPixels.data[idx + 1], "G must match original exactly");
    assert.equal(restored.data[idx + 2], originalPixels.data[idx + 2], "B must match original exactly");
    assert.equal(restored.data[idx + 3], originalPixels.data[idx + 3], "A must match original exactly");

    // No unwanted surrounding background returns: a point on the ball just
    // outside the erased/filled circle must be completely unaffected.
    const nearbyIdx = (250 * restored.width + 300) * 4;
    assert.deepEqual(
      [restored.data[nearbyIdx], restored.data[nearbyIdx + 1], restored.data[nearbyIdx + 2], restored.data[nearbyIdx + 3]],
      [damaged.data[nearbyIdx], damaged.data[nearbyIdx + 1], damaged.data[nearbyIdx + 2], damaged.data[nearbyIdx + 3]],
      "pixels outside the filled pocket must be byte-identical to right before Fill ran",
    );
  });

  it("4b/RESTORE FILL refusal: Fill correctly refuses the huge border-connected background hole, with understandable guidance", async () => {
    const { capability, projectId } = await seed();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    const preview = await capability.previewCorrectionSelection(projectId, { tool: "restore_fill", click: { x: 5, y: 5 } });
    assert.equal(preview.refused, true);
    assert.match(preview.refusalReason ?? "", /isn't enclosed/i);
    assert.match(preview.refusalReason ?? "", /Brush/i, "the refusal must point the operator at the guaranteed fallback");
  });

  it("5/RESTORE BRUSH: Brush restores the missing black bowling-ball fill exactly, without restoring the surrounding removed background", async () => {
    const { capability, projectId } = await seed();
    const originalPixels = await decoded(originalBytes);

    // Remove the whole exterior AND damage a patch of the ball itself --
    // reproducing "automatic-style" over-removal in one manual session.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 280, y: 240 }, { x: 300, y: 250 }, { x: 292, y: 262 }], radius: 10 });

    const damaged = await decoded(await capability.getCorrectionResultPng(projectId));
    const ballIdx = (250 * damaged.width + 290) * 4;
    assert.equal(damaged.data[ballIdx + 3], 0, "sanity: the ball patch must actually be missing before Brush runs");

    await capability.acceptCorrectionOperation(projectId, {
      tool: "restore_brush",
      points: [{ x: 280, y: 240 }, { x: 300, y: 250 }, { x: 292, y: 262 }],
      radius: 10,
    });
    const restored = await decoded(await capability.getCorrectionResultPng(projectId));

    // 23: black artwork visibly returns, byte-identical to the original.
    assert.equal(restored.data[ballIdx], originalPixels.data[ballIdx]);
    assert.equal(restored.data[ballIdx + 1], originalPixels.data[ballIdx + 1]);
    assert.equal(restored.data[ballIdx + 2], originalPixels.data[ballIdx + 2]);
    assert.equal(restored.data[ballIdx + 3], originalPixels.data[ballIdx + 3]);

    // 23: the surrounding UNWANTED background (removed at step 1, far from
    // the brushed ball patch) remains transparent -- Brush never touched it.
    const bgIdx = (5 * restored.width + 5) * 4;
    assert.equal(restored.data[bgIdx + 3], 0, "the unwanted background must remain removed -- Brush must not resurrect it");

    // No invented RGB anywhere outside the brushed footprint: a point on
    // the ball just outside the brush radius stays exactly as damaged.
    const outsideBrushIdx = (250 * restored.width + 330) * 4;
    assert.deepEqual(
      [restored.data[outsideBrushIdx], restored.data[outsideBrushIdx + 1], restored.data[outsideBrushIdx + 2], restored.data[outsideBrushIdx + 3]],
      [damaged.data[outsideBrushIdx], damaged.data[outsideBrushIdx + 1], damaged.data[outsideBrushIdx + 2], damaged.data[outsideBrushIdx + 3]],
    );
  });

  it("6/ERASER: removes a small remaining unwanted artifact; neighbouring desired artwork is untouched; Undo restores exactly", async () => {
    const { capability, projectId } = await seed();
    const before = await decoded(await capability.getCorrectionResultPng(projectId));
    // A point on the pure-black exterior, far from any artwork -- stand-in
    // for "a small remaining unwanted background artifact".
    const artifactIdx = (20 * before.width + 20) * 4;
    assert.equal(before.data[artifactIdx + 3], 255, "sanity: still opaque before erasing");

    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 20, y: 20 }], radius: 5 });
    const afterErase = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(afterErase.data[artifactIdx + 3], 0, "artifact removed");

    // Neighbouring desired artwork (the ball, far away) is unchanged.
    const ballIdx = (250 * afterErase.width + 292) * 4;
    assert.equal(afterErase.data[ballIdx + 3], 255, "the ball must be completely unaffected by an unrelated eraser stroke");

    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(before, afterUndo), 0, "Undo must restore exactly");
  });

  it("7: Done Editing -> Final Review -> Back to Editing -> one more correction -> Done Editing -> Use This Artwork remains authoritative under Phase 27H and does not route back into the 18-region separation review", async () => {
    const { repo, assets, capability, projectId } = await seed();

    // Sanity: this real asset independently requires the old separation review.
    const reviewBefore = await capability.getSeparationReview(projectId);
    assert.notEqual(reviewBefore.state, "review_not_required");

    // First correction, then "Done Editing" (a pure client-side navigation
    // -- the closest server equivalent is the read-only Final Review fetch).
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 20, y: 20 }], radius: 5 });
    const finalReview1 = await decoded(await capability.getCorrectionResultPng(projectId));

    // "Back to Editing" -> one more correction.
    await capability.acceptCorrectionOperation(projectId, { tool: "erase_brush", points: [{ x: 30, y: 30 }], radius: 5 });
    const finalReview2 = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.notEqual(countChangedPixels(finalReview1, finalReview2), 0, "sanity: the second correction actually changed something");

    // "Use This Artwork".
    const view = await capability.finalizeCorrection(projectId);
    assert.equal(view.hasPreparedArtwork, true);

    const preparation = await repo.getArtworkPreparation(projectId);
    const persisted = await decoded((await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes);
    assert.equal(countChangedPixels(finalReview2, persisted), 0, "the persisted asset must be byte-identical to the last reviewed result");

    const reviewAfter = await capability.getSeparationReview(projectId);
    assert.equal(reviewAfter.state, "review_not_required", "the accepted manual result must remain authoritative -- never routed back into the old separation review");
  });
});
