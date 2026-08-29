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
import { buildIndependentSeparationMaster } from "./separation-master-test-support";

/**
 * Phase 27G/27H/28-correction-base/28-separation-handoff — REAL-ASSET
 * ACCEPTANCE for the manual correction workspace, using the actual
 * INCREDI-BOWLS upload the customer used during production human-testing.
 * Read-only on the customer's file: only ever `readFileSync`d, never written
 * to. Everything else here runs in an isolated temp workspace with its own
 * throwaway local repository -- no live production project is ever touched.
 *
 * This is also the exact real asset that surfaced THREE defects in sequence:
 *
 *   - Phase 27G/27H: `finalizeCorrection` refusing because this artwork
 *     independently requires separation review -- fixed by making an
 *     explicitly finalized manual correction authoritative regardless.
 *   - The correction-base defect Phase 28-correction-base fixed: opening
 *     Edit Artwork re-initialized the correction session from the immutable
 *     ORIGINAL upload (Phase 27G's own choice, made for a different reason)
 *     rather than from what automatic preparation had already produced,
 *     forcing the operator to redo cleanup automatic preparation already
 *     completed.
 *   - "Fix Separation Review -> Edit Artwork Authority Handoff" (this
 *     revision): this asset independently requires separation review (see
 *     the DIAGNOSTIC test below) -- so once the prior fix landed, opening
 *     Edit Artwork showed the STALE automatic `preparedAssetId` (the plain
 *     `isolateBackground` output) while the review screen the operator had
 *     just been looking at showed the LIVE `buildSeparationMaster` preview.
 *     The tests below now assert the FULLY FIXED behavior: opening the
 *     workspace shows the CURRENT dynamic separation master -- exactly what
 *     `SeparationReviewPanel` labels PREPARED -- and Undo/Start Over return
 *     to THAT, never to the original AND never to the earlier automatic
 *     isolation asset.
 *
 * Skips entirely if the file isn't present on this machine, exactly like
 * every other real-asset acceptance test in this repo.
 */
const INCREDI_BOWLS_PATH = "C:\\Users\\eric\\Downloads\\e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png";
const EXPECTED_SHA256 = "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";
const hasAsset = existsSync(INCREDI_BOWLS_PATH);

function countChangedPixels(a: { data: Buffer; width: number; height: number }, b: { data: Buffer; width: number; height: number }) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

describe("INCREDI-BOWLS real-asset acceptance — manual correction workspace starts from the reviewed separation master", { skip: !hasAsset }, () => {
  let tempDir = "";
  let previousCwd = "";
  let originalBytes: Buffer;

  before(() => {
    // Read BEFORE chdir -- the path is absolute, but this keeps the file
    // read unambiguous regardless of working directory.
    originalBytes = readFileSync(INCREDI_BOWLS_PATH);
    const actualSha256 = createHash("sha256").update(originalBytes).digest("hex");
    assert.equal(actualSha256, EXPECTED_SHA256, "INCREDI-BOWLS asset SHA256 must match before use");

    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-incredi-bowls-acceptance-"));
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

  it("1: automatic preparation runs and visibly changes pixels vs. the original (demonstrating why the fallback exists)", async () => {
    const { repo, assets, projectId } = await seed();
    const preparation = await repo.getArtworkPreparation(projectId);
    assert.ok(preparation!.preparedAssetId, "automatic preparation must have produced a prepared asset");

    const preparedBytes = (await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes;
    const originalPixels = await decoded(originalBytes);
    const preparedPixels = await decoded(preparedBytes);

    const changed = countChangedPixels(originalPixels, preparedPixels);
    assert.ok(changed > 0, "sanity: automatic preparation must have changed at least some pixels for this real asset");
  });

  it("2/C: immediately after opening the manual workspace, the canvas shows the CURRENT dynamic separation master -- the same raster labeled PREPARED on the review screen, not the original AND not the earlier automatic isolation asset", async () => {
    const { assets, capability, projectId } = await seed();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();

    const prep = await repo.getArtworkPreparation(projectId);
    const automaticBytes = (await assets.downloadAssetBytes(prep!.preparedAssetId!))!.bytes;
    const automaticPixels = await decoded(automaticBytes);
    const originalPixels = await decoded(originalBytes);
    // Independently reconstructed via the SAME pure functions the review
    // screen's `/separation/image?mode=master` uses -- see
    // `buildIndependentSeparationMaster`'s own doc comment for why this is
    // an independent call site, not a re-test of the fix against itself.
    const separationMasterPixels = await buildIndependentSeparationMaster(repo, projectId, originalBytes);

    // This is the exact call the manual workspace makes on open (before any
    // click) -- Section 1's "critical authority rule".
    const info = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(info.operationCount, 0, "opening the manual workspace must start with zero corrections");

    // THE FIX under acceptance test here: opening Edit Artwork must show
    // exactly what the separation review screen is ALREADY labeling
    // PREPARED -- never the large original black background again, and
    // never the earlier automatic isolation asset the operator was never
    // actually looking at.
    const shownOnOpen = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(separationMasterPixels, shownOnOpen), 0, "the manual workspace must show the CURRENT dynamic separation master exactly on open");
    assert.ok(countChangedPixels(originalPixels, shownOnOpen) > 0, "the manual workspace must NOT revert to the original upload on open");
    assert.ok(
      countChangedPixels(automaticPixels, shownOnOpen) > 0,
      "sanity: for this real asset the separation master and the earlier automatic isolation asset actually differ, so this test would have caught the reported authority-handoff defect",
    );
  });

  it("3-8: manual remove on the artwork, verify preview leaves the result untouched until applied, Delete removes, legitimate artwork remains, Undo restores, Start Over returns exactly to the separation-review base", async () => {
    const { capability, projectId } = await seed();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const preparedPixels = await buildIndependentSeparationMaster(repo, projectId, originalBytes);

    // A point solidly inside the bowling ball's own dark fill (per
    // `incredi-bowls-toolbox-acceptance.test.ts`'s header comment) -- the
    // exterior background is already removed by automatic preparation
    // before this session starts (base = prepared), so a click there would
    // be a pixel no-op and prove nothing about "manual remove still works".
    const artX = 270;
    const artY = 230;

    const beforePreview = await decoded(await capability.getCorrectionResultPng(projectId));

    // Preview must not mutate the session -- reading the result again before
    // any operation is accepted must be unchanged.
    await capability.previewCorrectionSelection(projectId, { clicks: [{ x: artX, y: artY }], mode: "remove", toleranceLevel: "default" });
    const afterPreviewOnly = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(beforePreview, afterPreviewOnly), 0, "previewing a selection must not itself change the result");

    // Apply (Delete): now it actually removes.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: artX, y: artY }], mode: "remove", toleranceLevel: "default" });
    const afterApply = await decoded(await capability.getCorrectionResultPng(projectId));
    const artIdx = (artY * afterApply.width + artX) * 4;
    assert.equal(afterApply.data[artIdx + 3], 0, "the clicked artwork pixel must be transparent after apply");
    assert.ok(countChangedPixels(preparedPixels, afterApply) > 0, "sanity: applying actually changed something relative to the prepared base");

    // Undo restores exactly to the prepared base.
    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(preparedPixels, afterUndo), 0, "undo-to-zero must reproduce the prepared base exactly");

    // Re-apply, then Start Over -- must also return exactly to the prepared base.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: artX, y: artY }], mode: "remove", toleranceLevel: "default" });
    await capability.resetCorrectionSession(projectId);
    const afterStartOver = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(preparedPixels, afterStartOver), 0, "Start Over must reproduce the prepared base exactly");
  });

  it("DIAGNOSTIC: does the real INCREDI-BOWLS asset itself trigger mandatory separation review?", async () => {
    // Not a Phase 27G pass/fail criterion by itself -- this documents WHY
    // the next test's outcome is what it is, for the final report.
    const { capability, projectId } = await seed();
    const review = await capability.getSeparationReview(projectId);
    console.log(
      `[INCREDI-BOWLS diagnostic] separation review state: ${review.state}` +
        (review.state !== "review_not_required"
          ? `, consequential regions: ${review.regionMap.consequentialRegions.length}, inBoundsProposal: ${review.regionMap.inBoundsProposal !== null}`
          : ""),
    );
  });

  it("9/M (Phase 27H): Done Editing -> Final Review reflects the MANUAL result, and Use This Artwork finalizes it despite this real asset's own separation-review requirement", async () => {
    const { repo, assets, capability, projectId } = await seed();
    const preparationBefore = await repo.getArtworkPreparation(projectId);
    const automaticAssetId = preparationBefore!.preparedAssetId!;
    const automaticBytes = (await assets.downloadAssetBytes(automaticAssetId))!.bytes;
    const automaticPixels = await decoded(automaticBytes);

    // A point solidly inside the bowling ball's own dark fill -- the
    // exterior background is already removed by automatic preparation
    // before this session starts (base = prepared), so a click there would
    // be a pixel no-op and could never demonstrate "the manual result
    // differs from the automatic result".
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 270, y: 230 }], mode: "remove", toleranceLevel: "default" });
    const manualResult = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.ok(countChangedPixels(automaticPixels, manualResult) > 0, "the manual result must differ from the automatic result");

    // Sanity: this real asset independently requires separation review too
    // (confirmed by the diagnostic above). Phase 27G left finalize refusing
    // here as a dead end; Phase 27H's product decision makes the operator's
    // explicit "Use This Artwork" click authoritative regardless.
    const reviewBefore = await capability.getSeparationReview(projectId);
    assert.notEqual(reviewBefore.state, "review_not_required", "sanity: this real asset must still require separation review going in");

    const view = await capability.finalizeCorrection(projectId);
    assert.equal(view.hasPreparedArtwork, true, "finalize must succeed -- the manual override supersedes this asset's separation-review requirement");

    const preparationAfter = await repo.getArtworkPreparation(projectId);
    assert.notEqual(preparationAfter!.preparedAssetId, automaticAssetId, "finalize must repoint to a NEW asset, not the automatic one");

    const finalBytes = (await assets.downloadAssetBytes(preparationAfter!.preparedAssetId!))!.bytes;
    const finalPixels = await decoded(finalBytes);
    assert.equal(countChangedPixels(manualResult, finalPixels), 0, "the persisted final asset must be byte-identical to the reviewed manual result");

    // The operator must not be sent back to decide Show Shirt/Print
    // Ink/Not Sure for this same artwork now that it's been manually
    // reviewed and accepted.
    const reviewAfter = await capability.getSeparationReview(projectId);
    assert.equal(reviewAfter.state, "review_not_required", "separation review must no longer be demanded after the manual override is accepted");

    // The automatic asset must remain preserved, untouched.
    const automaticAfter = (await assets.downloadAssetBytes(automaticAssetId))!.bytes;
    assert.equal(countChangedPixels(automaticPixels, await decoded(automaticAfter)), 0, "the automatic prepared asset must remain preserved and unchanged");
  });
});
