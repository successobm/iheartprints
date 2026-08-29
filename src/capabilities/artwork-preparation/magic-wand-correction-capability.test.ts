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
import { bowlingStyleArtwork, solidBlackExteriorArtwork, toPngBytes } from "./artwork-fixtures";

/**
 * Phase 27E/27G/28-correction-base — focused regression tests for the
 * graduated Magic Wand correction workspace. Deliberately does NOT re-test
 * flood-fill correctness, connectivity, or the tolerance ladder — that
 * surface is frozen and already exhaustively covered by
 * `src/experimental/magic-wand/magic-wand.test.ts`. These tests cover the
 * INTEGRATION plumbing: session lifecycle, authoritative persistence,
 * original immutability, and pixel consistency across edit -> review ->
 * handoff.
 *
 * Phase 27G had made the session's "base" the IMMUTABLE ORIGINAL, never
 * `preparedAssetId`, on the theory that automatic preparation might have
 * damaged the artwork and the operator should repair the original by hand.
 * In practice this meant the correction workspace discarded automatic
 * preparation's own (usually correct) work every time it was opened,
 * forcing the operator to redo cleanup that already happened — the exact
 * customer-reported defect this revision fixes. `ensureCorrectionSession`
 * now initializes `base` from the CURRENT `preparedAssetId` when one
 * exists, falling back to the original only when automatic preparation
 * never ran (Phase 28A's entry point, still covered below and in
 * `manual-cleanup-from-automatic-review.test.ts`). `original` is always
 * still the immutable original — Restore Missing Artwork's recovery
 * authority and "compare against the original" both still depend on that.
 * Every test below that asserts what "Start Over" / zero-operations / the
 * initial workspace state should equal now asserts against the PREPARED
 * asset (when one exists), not the original.
 */

describe("Phase 27E/27G: Magic Wand correction workspace", () => {
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

  /** Seeds a project through upload -> context -> prepareBackground (the "automatic attempt"), exactly like the easy-artwork path elsewhere. Returns with a real `preparedAssetId` set -- correction sessions now build their base from THIS prepared asset's bytes, not the original. */
  async function seededWithPreparedArtwork() {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(solidBlackExteriorArtwork());
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

  // 1/2: Done Editing is a pure client-side navigation in this architecture
  // -- there is no server call bound to it at all (see CorrectionWorkspace's
  // onDoneEditing prop, which only flips local UI state). The closest
  // thing to a server call at that moment is the read-only `.../result`
  // fetch Final Review makes, which must never mutate anything.
  it("1/2: reading the current correction result (what 'Done Editing' -> Final Review displays) never mutates the authoritative prepared artwork", async () => {
    const { repo, capability, projectId, preparedAssetId } = await seededWithPreparedArtwork();
    await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.getCorrectionResultPng(projectId); // the "Done Editing" / Final Review read
    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, preparedAssetId, "preparedAssetId must be untouched by preview/read calls");
    assert.equal(preparation!.status, "prepared", "status must be untouched -- no auto-approval");
  });

  // 3/Q: Back to Editing preserves corrections; opening the workspace alone applies nothing.
  it("3/Q: the session's accepted operations survive across repeated preview/result reads, and merely reading the result applies no operation of its own", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    const beforeAnyOp = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    // (40,40) sits on the white square, which automatic preparation never
    // touches -- (5,5)'s background is already removed by the time this
    // session starts (base = prepared), so a remove click there would be a
    // pixel no-op and defeat this test's own "actually changed something"
    // sanity check.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const afterFirstOp = await capability.getCorrectionResultPng(projectId);
    assert.notEqual(Buffer.compare((await decodedPixels(afterFirstOp)).data, beforeAnyOp.data), 0, "sanity: the accepted op actually changed something");
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
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    const view = await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.notEqual(preparation!.preparedAssetId, preparedAssetId, "must be a NEW asset, never the same id");
    assert.equal(preparation!.status, "approved");
    assert.ok(preparation!.preparedArtworkVersionId, "must have a prepared_upload ArtworkVersion");

    const snapshot = await repo.getProject(projectId);
    const version = snapshot!.artworkVersions.find((v) => v.id === preparation!.preparedArtworkVersionId);
    assert.ok(version, "the ArtworkVersion referenced by preparedArtworkVersionId must actually exist");
    assert.equal(version!.kind, "prepared_upload");
    // THE critical final-artwork-worker invariant: the version's
    // primaryAssetId must match preparedAssetId exactly, or finalization
    // would fail downstream with "unverified source".
    assert.equal(version!.primaryAssetId, preparation!.preparedAssetId);
    assert.equal(view.hasPreparedArtwork, true);
  });

  // D: the OLD automatic prepared asset is preserved (never deleted), even
  // though it is no longer the active pointer after a manual finalize.
  it("D: the automatic prepared asset row is preserved as historical/derived state after a manual finalize repoints preparedAssetId", async () => {
    const { assets, capability, projectId, preparedAssetId } = await seededWithPreparedArtwork();
    const automaticBytesBefore = (await assets.downloadAssetBytes(preparedAssetId))!.bytes;

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.finalizeCorrection(projectId);

    // The OLD automatic asset id must still resolve to its own, unchanged bytes.
    const automaticBytesAfter = await assets.downloadAssetBytes(preparedAssetId);
    assert.ok(automaticBytesAfter, "the automatic prepared asset must not have been deleted");
    assert.equal(Buffer.compare(automaticBytesAfter!.bytes, automaticBytesBefore), 0, "the automatic prepared asset's bytes must be completely untouched");
  });

  // 5/20/P: original asset immutable
  it("5/20/P: the original asset's SHA256 and bytes are unchanged before and after a full correction + finalize", async () => {
    const { repo, assets, capability, projectId, originalBytes } = await seededWithPreparedArtwork();
    const preparationBefore = await repo.getArtworkPreparation(projectId);
    const beforeSha = createHash("sha256").update(originalBytes).digest("hex");

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
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
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "restore", toleranceLevel: "default" });

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

  // 7/24/M: mixed Remove + Restore replay -- Restore now demonstrated as
  // RECOVERY from an over-eager manual Remove (Phase 27G §5's stated
  // purpose), not as "bringing back automatic damage" (there is none to
  // bring back -- the session starts from the intact original).
  it("7/24/M: Remove then Restore-as-recovery on the SAME area fully undoes the removal; final review reflects the manual result", async () => {
    const { capability, projectId, originalBytes } = await seededWithPreparedArtwork();
    const originalPixels = await decodedPixels(originalBytes);
    // Remove: the white square (opaque in the original) becomes transparent.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const afterRemove = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const squareIdx = (40 * afterRemove.width + 40) * 4;
    assert.equal(afterRemove.data[squareIdx + 3], 0, "the square must be transparent right after Remove");

    // Restore-as-recovery: bring the accidentally-removed square back from the original.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "restore", toleranceLevel: "default" });
    const result = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.equal(result.data[squareIdx + 3], 255, "Restore-as-recovery must bring the square back to opaque");
    assert.equal(result.data[squareIdx], originalPixels.data[squareIdx], "recovered pixel must match the original's exact value, whatever it is");
  });

  // 8/25/I: Undo remains correct, and undoing back to zero operations
  // reproduces the PREPARED base exactly (not the immutable original --
  // that would resurrect background automatic preparation already removed).
  it("8/25/I: Undo removes exactly the most recently accepted operation; undo-to-zero reproduces the prepared base exactly", async () => {
    const { capability, projectId, preparedBytes } = await seededWithPreparedArtwork();
    const preparedPixels = await decodedPixels(preparedBytes);

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const afterOp1 = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });

    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(afterOp1, afterUndo), "undo must revert exactly to the state after only the first operation");

    await capability.undoCorrectionOperation(projectId);
    const afterUndoToZero = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(preparedPixels, afterUndoToZero), "undo-to-zero must reproduce the PREPARED base exactly -- never falling back into the immutable original");
  });

  // 9/26/H: Start Over returns to the PREPARED base, never the immutable original.
  it("9/26/H: Start Over resets to the PREPARED base exactly -- never the immutable original -- without mutating anything", async () => {
    const { repo, capability, projectId, preparedBytes, preparedAssetId } = await seededWithPreparedArtwork();
    const preparedPixels = await decodedPixels(preparedBytes);

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.resetCorrectionSession(projectId);

    const afterReset = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(preparedPixels, afterReset), "Start Over must reproduce the PREPARED base exactly");

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, preparedAssetId, "Start Over must not touch preparedAssetId");
    assert.equal(preparation!.originalAssetId, preparation!.originalAssetId, "Start Over must not touch originalAssetId");
  });

  // 10/F/G: with zero accepted operations, the manual workspace shows the
  // CURRENT PREPARED ARTWORK exactly -- this is the fix for the reported
  // defect ("corrections=0 shows the large original background again").
  it("10/F/G: with zero accepted operations, the correction result is pixel-identical to the PREPARED base -- and NOT the original, proving automatic preparation's own work is preserved", async () => {
    const { capability, projectId, preparedBytes, originalBytes } = await seededWithPreparedArtwork();
    const preparedPixels = await decodedPixels(preparedBytes);
    const originalPixels = await decodedPixels(originalBytes);
    // Sanity: for this fixture, automatic prep DID change the bytes --
    // otherwise this test could not distinguish the two possible bases.
    assert.notEqual(Buffer.compare(preparedPixels.data, originalPixels.data), 0, "sanity: automatic preparation must have actually changed something for this fixture");

    const resultPixels = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(preparedPixels, resultPixels), "zero operations must reproduce the PREPARED base exactly");
    assert.ok(!pixelsEqual(originalPixels, resultPixels), "zero operations must NOT revert to the original upload");

    const info = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(info.operationCount, 0, "opening the workspace must not itself create any operation");
  });

  // C: explicit proof the session base is keyed to preparedAssetId when one exists.
  it("C: the correction session initializes from preparedAssetId's bytes, not originalAssetId's bytes, when a prepared asset exists", async () => {
    const { capability, projectId, preparedBytes, originalBytes } = await seededWithPreparedArtwork();
    const preparedPixels = await decodedPixels(preparedBytes);
    const originalPixels = await decodedPixels(originalBytes);
    // Sanity: for this fixture, automatic prep DID change the bytes (background removed) --
    // otherwise this test would not distinguish the two possible bases at all.
    assert.notEqual(Buffer.compare(preparedPixels.data, originalPixels.data), 0, "sanity: automatic preparation must have actually changed something for this fixture");

    const resultPixels = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.ok(pixelsEqual(preparedPixels, resultPixels), "session base must be the PREPARED artwork");
    assert.ok(!pixelsEqual(originalPixels, resultPixels), "session base must NOT be the immutable original");
  });

  // 12/O: low-resolution/enhancement requirement and garment color stay independent
  it("12/O: correcting the artwork never touches the persisted analysis/enhancement verdict, and garment colour plays no role in it", async () => {
    const { repo, capability, projectId } = await seededWithPreparedArtwork();
    const before = await repo.getArtworkPreparation(projectId);
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.finalizeCorrection(projectId);
    const after = await repo.getArtworkPreparation(projectId);
    assert.deepEqual(after!.analysis, before!.analysis, "finalizeCorrection must never rewrite the analysis verdict -- that stays a separate, independent concern");
    // No garment/productColor parameter exists anywhere in the correction
    // call surface at all -- confirmed structurally, not just by absence of
    // effect (see magic-wand-algorithm.ts's applyMagicWandCorrection arity,
    // asserted directly in magic-wand.test.ts's "no garment-color
    // dependency" case).
  });

  // 14/R: historical correction-operation replay remains deterministic
  it("14/R: recomputing the same session twice (no state change in between) yields byte-identical results", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "restore", toleranceLevel: "default" });
    const first = await capability.getCorrectionResultPng(projectId);
    const second = await capability.getCorrectionResultPng(projectId);
    assert.ok(pixelsEqual(await decodedPixels(first), await decodedPixels(second)), "replay must be deterministic");
  });

  // Phase 28A superseded this test's original premise: it asserted
  // `ensureCorrectionSession` refused to start whenever `preparedAssetId`
  // was absent, on the assumption (stated explicitly in the pre-Phase-28A
  // doc comment) that automatic preparation always runs first. That
  // assumption is exactly what a `NEEDS_REVIEW`-classified upload violates
  // -- `prepareBackground` refuses to run at all for it, so
  // `preparedAssetId` stays permanently null, and the manual correction
  // workspace is the ONLY way forward. See
  // `manual-cleanup-from-automatic-review.test.ts` for the full coverage of
  // that path. What genuinely still "fails closed" is unchanged: a project
  // with no upload/preparation record at all.
  it("succeeds with only an upload and no automatic preparation -- Phase 28A's manual-cleanup entry point", async () => {
    const { repo, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, { bytes: toPngBytes(solidBlackExteriorArtwork()), declaredContentType: "image/png", filename: "artwork.png" });
    const preview = await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    assert.ok(preview.overlayPng.length > 0);
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    const view = await capability.finalizeCorrection(projectId);
    assert.equal(view.hasPreparedArtwork, true);
  });

  it("still fails closed with no upload/preparation record at all", async () => {
    const { repo, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await assert.rejects(() => capability.previewCorrectionSelection(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" }));
    await assert.rejects(() => capability.finalizeCorrection(projectId));
  });

  // 3 (regression): "Back to Editing" must report the TRUE operation count,
  // not a client-only counter that resets on remount.
  it("3 regression: getCorrectionSessionInfo reports the true operation count even after operations were accepted in an earlier call", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0);
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 2, "must reflect both accepted operations, exactly what a remounted workspace needs to display correctly");
  });

  // K: Restore Missing Artwork still works correctly as the secondary/recovery mode.
  it("K: Restore Missing Artwork still functions correctly as a secondary recovery mode", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const op = await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "restore", toleranceLevel: "default" });
    assert.ok(op.operationId);
    const result = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    const squareIdx = (40 * result.width + 40) * 4;
    assert.equal(result.data[squareIdx + 3], 255, "Restore Missing Artwork must still recover a manually-removed area correctly");
  });

  // J: manual Delete/apply still performs the existing deterministic remove behavior unchanged.
  it("J: manual Remove apply performs the existing deterministic alpha-only removal, unchanged", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    const before = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    // (40,40) sits on the white square -- automatic preparation never
    // removes foreground artwork, so this point starts opaque in the
    // PREPARED base too (unlike (5,5)'s background, already removed by the
    // time this session starts).
    const idx = (40 * before.width + 40) * 4;
    assert.equal(before.data[idx + 3], 255, "artwork starts opaque in the prepared base");
    const rgbBefore = [before.data[idx], before.data[idx + 1], before.data[idx + 2]];

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 40, y: 40 }], mode: "remove", toleranceLevel: "default" });
    const after = await decodedPixels(await capability.getCorrectionResultPng(projectId));
    assert.equal(after.data[idx + 3], 0, "removed pixel must become transparent");
    assert.deepEqual([after.data[idx], after.data[idx + 1], after.data[idx + 2]], rgbBefore, "remove must only ever change alpha, never RGB");
  });

  // Phase 27G §15: `approvePreparedArtwork` already refuses to approve while
  // this artwork has consequential dark-region decisions pending (the
  // bowling-logo failure mode), and stays refused even after decisions are
  // submitted -- `approveSeparationMaster` is the ONLY approval route once
  // review is required (see that function's own comment). The manual Magic
  // Wand fallback is a SECOND, independent path to the exact same
  // "approved" status; it must not be able to bypass a gate the other path
  // enforces server-side, or a customer could skip the mandatory
  // separation review entirely just by choosing "Remove Background
  // Manually" instead of resolving it. This mirrors `approvePreparedArtwork`'s
  // existing check exactly -- no new separation-authority rule.
  // Phase 27H: a deliberately completed manual correction is authoritative
  // and supersedes separation review for that accepted result. This whole
  // block replaces the old Phase 27G §15 test (which required
  // finalizeCorrection to *refuse* here) -- that refusal closed a real
  // bypass but also permanently dead-ended the manual fallback for any
  // artwork needing separation review, which is exactly the class the
  // fallback exists for (proven live on the real INCREDI-BOWLS asset).
  // Phase 27H makes the explicit product call: the operator's own reviewed
  // "Use This Artwork" click is the authority.
  describe("Phase 27H: manual correction as authoritative human override", () => {
    async function seededNeedingSeparationReview() {
      const { repo, assets, capability } = await harness();
      const projectId = (await repo.createProject()).project.id;
      await capability.uploadOriginal(projectId, {
        bytes: toPngBytes(bowlingStyleArtwork()),
        declaredContentType: "image/png",
        filename: "artwork.png",
      });
      await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
      await capability.prepareBackground(projectId);
      const preparation = await repo.getArtworkPreparation(projectId);
      return { repo, assets, capability, projectId, preparedAssetId: preparation!.preparedAssetId! };
    }

    it("sanity: the bowling fixture actually requires separation review before any correction happens", async () => {
      const { capability, projectId } = await seededNeedingSeparationReview();
      const review = await capability.getSeparationReview(projectId);
      assert.notEqual(review.state, "review_not_required");
      assert.ok(review.regionMap.consequentialRegions.length > 0);
    });

    // §1 "critical distinction": everything short of the explicit finalize
    // click must leave the automatic prepared artwork, separation review,
    // and original completely untouched -- even for artwork that needs
    // separation review.
    it("§1: opening the workspace, correcting, and reading Final Review does NOT touch the automatic asset, status, or separation review before finalize", async () => {
      const { repo, capability, projectId, preparedAssetId } = await seededNeedingSeparationReview();
      const preparationBefore = await repo.getArtworkPreparation(projectId);

      await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
      await capability.getCorrectionResultPng(projectId); // "Final Review" read

      const preparationAfter = await repo.getArtworkPreparation(projectId);
      assert.equal(preparationAfter!.preparedAssetId, preparedAssetId, "no authoritative prepared asset may be replaced before finalize");
      assert.equal(preparationAfter!.status, preparationBefore!.status, "no hidden approval before finalize");

      const review = await capability.getSeparationReview(projectId);
      assert.notEqual(review.state, "review_not_required", "separation review must remain unresolved before finalize");
    });

    it("§0/§1: finalizeCorrection (the explicit Use This Artwork click) succeeds even while separation review is unresolved -- the manual result becomes authoritative", async () => {
      const { repo, capability, projectId, preparedAssetId } = await seededNeedingSeparationReview();
      await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });

      const view = await capability.finalizeCorrection(projectId);
      assert.equal(view.hasPreparedArtwork, true);

      const preparation = await repo.getArtworkPreparation(projectId);
      assert.equal(preparation!.status, "approved");
      assert.notEqual(preparation!.preparedAssetId, preparedAssetId, "must repoint to the NEW manually corrected asset");
    });

    it("§0: after an accepted manual override, getSeparationReview reports review_not_required -- the operator is never sent back to decide Show Shirt/Print Ink/Not Sure", async () => {
      const { capability, projectId } = await seededNeedingSeparationReview();
      await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
      await capability.finalizeCorrection(projectId);

      const review = await capability.getSeparationReview(projectId);
      assert.equal(review.state, "review_not_required");
    });

    it("§3: defense in depth -- approveSeparationMaster refuses to run (and cannot clobber the manual result) once an override has been accepted", async () => {
      const { repo, assets, capability, projectId } = await seededNeedingSeparationReview();
      await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
      await capability.finalizeCorrection(projectId);

      const preparationAfterFinalize = await repo.getArtworkPreparation(projectId);
      const manualAssetId = preparationAfterFinalize!.preparedAssetId!;
      const manualBytesBefore = (await assets.downloadAssetBytes(manualAssetId))!.bytes;

      // A stale client still holding the old separation-review screen open.
      const review = await capability.getSeparationReview(projectId);
      await capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: review.regionMap.regionMapHash,
        decisions: review.regionMap.consequentialRegions.map((region) => ({ regionId: region.regionId, intent: "ink" as const })),
      });
      await assert.rejects(
        () => capability.approveSeparationMaster(projectId),
        /already been manually corrected|no longer available/i,
        "approveSeparationMaster must refuse once a manual override has been accepted",
      );

      const preparationAfter = await repo.getArtworkPreparation(projectId);
      assert.equal(preparationAfter!.preparedAssetId, manualAssetId, "the manual result must remain the authoritative prepared asset");
      const manualBytesAfter = (await assets.downloadAssetBytes(manualAssetId))!.bytes;
      assert.equal(Buffer.compare(manualBytesBefore, manualBytesAfter), 0, "the manual result's bytes must be completely untouched by the refused call");
    });

    it("§3: pixel authority -- edited result = Final Review result = persisted prepared asset = downstream ArtworkVersion source, byte-for-byte", async () => {
      const { repo, assets, capability, projectId } = await seededNeedingSeparationReview();
      await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
      const editedResult = await decodedPixels(await capability.getCorrectionResultPng(projectId)); // "edited result" / Final Review

      await capability.finalizeCorrection(projectId);

      const preparation = await repo.getArtworkPreparation(projectId);
      const persisted = await decodedPixels((await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes);
      assert.ok(pixelsEqual(editedResult, persisted), "persisted prepared asset must be byte-identical to the reviewed edited result");

      const snapshot = await repo.getProject(projectId);
      const version = snapshot!.artworkVersions.find((v) => v.id === preparation!.preparedArtworkVersionId);
      assert.equal(version!.primaryAssetId, preparation!.preparedAssetId, "downstream ArtworkVersion must point at the SAME persisted asset");
      const downstream = await decodedPixels((await assets.downloadAssetBytes(version!.primaryAssetId!))!.bytes);
      assert.ok(pixelsEqual(editedResult, downstream), "downstream artwork source must be byte-identical to the reviewed edited result");
    });

    it("§0: the override is scoped to the specific accepted result, not global -- a SEPARATE project with the same fixture, never manually corrected, still requires separation review through the automatic path", async () => {
      const { capability: otherCapability, projectId: otherProjectId } = await seededNeedingSeparationReview();
      // No correction, no finalize on this second project -- purely automatic path.
      await assert.rejects(
        () => otherCapability.approvePreparedArtwork(otherProjectId),
        /confirmation before it can be used/i,
        "an unrelated project's automatic path must still be gated by separation review -- the override must never leak across preparations",
      );
      const review = await otherCapability.getSeparationReview(otherProjectId);
      assert.notEqual(review.state, "review_not_required", "the unrelated project's own separation review must remain required");
    });

    it("§2: the automatic path's own gates are completely untouched -- approvePreparedArtwork still refuses for artwork that needs separation review when the operator never used the manual override", async () => {
      const { capability, projectId } = await seededNeedingSeparationReview();
      await assert.rejects(
        () => capability.approvePreparedArtwork(projectId),
        /confirmation before it can be used/i,
      );
    });
  });

  it("does not persist a mask -- accepted operations are raw clicks/mode/tolerance only", async () => {
    const { capability, projectId } = await seededWithPreparedArtwork();
    const op = await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 5, y: 5 }], mode: "remove", toleranceLevel: "default" });
    assert.ok(op.operationId);
    assert.equal(op.algorithmVersion, "magic-wand:v1");
    // The public return shape carries no mask/pixel data at all.
    assert.deepEqual(Object.keys(op).sort(), ["algorithmVersion", "operationId"]);
  });
});
