import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { solidBlackExteriorArtwork, toPngBytes } from "./artwork-fixtures";

/**
 * Phase 27E — focused regression tests for the graduated Magic Wand
 * correction workspace. Deliberately does NOT re-test flood-fill
 * correctness, connectivity, or the tolerance ladder — that surface is
 * frozen and already exhaustively covered by
 * `src/experimental/magic-wand/magic-wand.test.ts` (Phase 27C/27D, run
 * unchanged as regression coverage). These tests cover the INTEGRATION
 * plumbing: session lifecycle, authoritative persistence, original
 * immutability, and pixel consistency across edit -> review -> handoff.
 */

describe("Phase 27E: Magic Wand correction workspace", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-correction-workspace-"));
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

  /** Seeds a project through upload -> context -> prepareBackground, exactly like the easy-artwork path in separation-decision-workflow.test.ts. Returns with a real `preparedAssetId` set. */
  async function seededWithPreparedArtwork() {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(solidBlackExteriorArtwork());
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "artwork.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
    await capability.prepareBackground(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    return { repo, assets, capability, projectId, originalBytes, preparedAssetId: preparation!.preparedAssetId! };
  }

  async function decodedPixels(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }
  function pixelsEqual(a: { data: Buffer }, b: { data: Buffer }) {
    return Buffer.compare(a.data, b.data) === 0;
  }

  // 1/2: Done Editing is a pure client-side navigation in this architecture
  // -- there is no server call bound to it at all (see CorrectionWorkspace's
  // onDoneEditing prop, which only flips local UI state). The closest
  // thing to a server call at that moment is the read-only `.../result`
  // fetch Final Review makes, which must never mutate anything.
  it("1/2: reading the current correction result (what 'Done Editing' -> Final Review displays) never mutates the authoritative prepared artwork", async () => {
    const { repo, capability, projectId, preparedAssetId } = await seededWithPreparedArtwork();
    await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    await capability.getCorrectionResultPng(projectId); // the "Done Editing" / Final Review read
    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, preparedAssetId, "preparedAssetId must be untouched by preview/read calls");
    assert.equal(preparation!.status, "prepared", "status must be untouched -- no auto-approval");
  });

  // 3: Back to Editing preserves corrections
  it("3: the session's accepted operations survive across repeated preview/result reads (simulating navigating Editing <-> Review <-> Editing)", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    const afterFirstOp = await capability.getCorrectionResultPng(projectId);
    // Simulate "Done Editing" (read) then "Back to Editing" (read again) --
    // neither is a mutating call, so the accepted operation must still be there.
    await capability.getCorrectionResultPng(projectId);
    await capability.getCorrectionResultPng(projectId);
    const stillThere = await capability.getCorrectionResultPng(projectId);
    assert.ok(pixelsEqual(await decodedPixels(afterFirstOp), await decodedPixels(stillThere)), "operations must not be dropped by navigation-only reads");
  });

  // 4/19: Use This Artwork performs the authoritative persistence/handoff
  it("4/19: Use This Artwork uploads a NEW asset, creates a matching prepared_upload ArtworkVersion, and repoints preparedAssetId/preparedArtworkVersionId together", async () => {
    const { repo, capability, projectId, preparedAssetId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    const view = await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.notEqual(preparation!.preparedAssetId, preparedAssetId, "must be a NEW asset, never the same id");
    assert.equal(preparation!.status, "approved");
    assert.ok(preparation!.preparedArtworkVersionId, "must have a prepared_upload ArtworkVersion");

    const snapshot = await repo.getProject(projectId);
    const version = snapshot!.artworkVersions.find((v) => v.id === preparation!.preparedArtworkVersionId);
    assert.ok(version, "the ArtworkVersion referenced by preparedArtworkVersionId must actually exist");
    assert.equal(version!.kind, "prepared_upload");
    // THE critical final-artwork-worker invariant (Phase 27E report): the
    // version's primaryAssetId must match preparedAssetId exactly, or
    // finalization would fail downstream with "unverified source".
    assert.equal(version!.primaryAssetId, preparation!.preparedAssetId);
    assert.equal(view.hasPreparedArtwork, true);
  });

  // 5/20: original asset immutable
  it("5/20: the original asset's SHA256 and bytes are unchanged before and after a full correction + finalize", async () => {
    const { repo, assets, capability, projectId, originalBytes } = await seededWithPreparedArtwork();
    const preparationBefore = await repo.getArtworkPreparation(projectId);
    const beforeSha = createHash("sha256").update(originalBytes).digest("hex");

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    await capability.finalizeCorrection(projectId);

    const downloaded = await assets.downloadAssetBytes(preparationBefore!.originalAssetId);
    const afterSha = createHash("sha256").update(downloaded!.bytes).digest("hex");
    assert.equal(afterSha, beforeSha, "original bytes must be byte-for-byte unchanged");
    assert.equal(Buffer.compare(downloaded!.bytes, originalBytes), 0);

    const preparationAfter = await repo.getArtworkPreparation(projectId);
    assert.equal(preparationAfter!.originalAssetId, preparationBefore!.originalAssetId, "originalAssetId itself must never be repointed");
  });

  // 6/21/22/23: pixel consistency across edit -> review -> persisted -> downstream
  it("6/21/22/23: the exact pixels shown during editing are the exact pixels persisted and handed to the downstream ArtworkVersion", async () => {
    const { repo, assets, capability, projectId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });

    // A: what the edit canvas / Final Review would show (same endpoint).
    const reviewedBytes = await capability.getCorrectionResultPng(projectId);
    const reviewedPixels = await decodedPixels(reviewedBytes);

    // C/D: what actually gets persisted and handed downstream.
    await capability.finalizeCorrection(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    const persistedDownload = await assets.downloadAssetBytes(preparation!.preparedAssetId!);
    const persistedPixels = await decodedPixels(persistedDownload!.bytes);

    assert.ok(pixelsEqual(reviewedPixels, persistedPixels), "reviewed pixels must be byte-identical to the persisted asset's pixels");

    const snapshot = await repo.getProject(projectId);
    const version = snapshot!.artworkVersions.find((v) => v.id === preparation!.preparedArtworkVersionId);
    assert.equal(version!.primaryAssetId, preparation!.preparedAssetId, "the downstream ArtworkVersion must point at the SAME persisted asset");
  });

  // 7/24: mixed Restore + Remove replay
  it("7/24: a session containing both a Remove and a Restore operation applies BOTH effects correctly", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    // Remove: the white square (currently opaque, occupies (30,30)-(90,90)) becomes transparent.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    // Restore: the black background (currently transparent outside the square) comes back from the original.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });

    const result = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const bgIdx = (5 * result.width + 5) * 4;
    const squareIdx = (40 * result.width + 40) * 4;
    assert.equal(result.data[bgIdx + 3], 255, "background must be restored (opaque) after the Restore op");
    assert.equal(result.data[bgIdx], 0, "restored background pixel must match the original's near-black value exactly");
    assert.equal(result.data[squareIdx + 3], 0, "the white square must remain removed (transparent) -- Restore must not have brought it back");
  });

  // 8/25: Undo remains correct
  it("8/25: Undo removes exactly the most recently accepted operation and nothing else", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const afterOp1 = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });

    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(afterOp1, afterUndo), "undo must revert exactly to the state after only the first operation");
  });

  // 9/26: Start Over remains correct
  it("9/26: Start Over resets to the session's base (the current prepared asset) exactly, never the original, never mutating anything", async () => {
    const { repo, assets, capability, projectId, preparedAssetId } = await seededWithPreparedArtwork();
    const baseBytes = (await assets.downloadAssetBytes(preparedAssetId))!.bytes;
    const basePixels = await decodedPixels(baseBytes);

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    await capability.resetCorrectionSession(projectId);

    const afterReset = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(basePixels, afterReset), "Start Over must reproduce the base prepared asset exactly");

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, preparedAssetId, "Start Over must not touch preparedAssetId");
  });

  // 10: no second automatic removal occurs
  it("10: with zero accepted operations, the correction result is pixel-identical to the CURRENT prepared asset -- proving no removal was recomputed", async () => {
    const { assets, capability, projectId, preparedAssetId } = await seededWithPreparedArtwork();
    const baseBytes = (await assets.downloadAssetBytes(preparedAssetId))!.bytes;
    const basePixels = await decodedPixels(baseBytes);
    const resultPixels = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(basePixels, resultPixels), "zero operations must reproduce the existing prepared asset exactly, not a freshly recomputed removal");
  });

  // 12: low-resolution/enhancement requirement stays independent
  it("12: correcting the artwork never touches the persisted analysis/enhancement verdict", async () => {
    const { repo, capability, projectId } = await seededWithPreparedArtwork();
    const before = await repo.getArtworkPreparation(projectId);
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    await capability.finalizeCorrection(projectId);
    const after = await repo.getArtworkPreparation(projectId);
    assert.deepEqual(after!.analysis, before!.analysis, "finalizeCorrection must never rewrite the analysis verdict -- that stays a separate, independent concern");
  });

  // 14: historical correction-operation replay remains deterministic
  it("14: recomputing the same session twice (no state change in between) yields byte-identical results", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    const first = await capability.getCorrectionResultPng(projectId);
    const second = await capability.getCorrectionResultPng(projectId);
    assert.ok(pixelsEqual(await decodedPixels(first), await decodedPixels(second)), "replay must be deterministic");
  });

  it("fails closed with no prepared artwork to correct", async () => {
    const { repo, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, { bytes: toPngBytes(solidBlackExteriorArtwork()), declaredContentType: "image/png", filename: "artwork.png" });
    await assert.rejects(() => capability.previewCorrectionSelection(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" }));
    await assert.rejects(() => capability.finalizeCorrection(projectId));
  });

  // 3 (regression): "Back to Editing" must report the TRUE operation count,
  // not a client-only counter that resets on remount.
  it("3 regression: getCorrectionSessionInfo reports the true operation count even after operations were accepted in an earlier call", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0);
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 2, "must reflect both accepted operations, exactly what a remounted workspace needs to display correctly");
  });

  it("does not persist a mask -- accepted operations are raw clicks/mode/tolerance only", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    const op = await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });
    assert.ok(op.operationId);
    assert.equal(op.algorithmVersion, "magic-wand:v1");
    // The public return shape carries no mask/pixel data at all.
    assert.deepEqual(Object.keys(op).sort(), ["algorithmVersion", "operationId"]);
  });
});
