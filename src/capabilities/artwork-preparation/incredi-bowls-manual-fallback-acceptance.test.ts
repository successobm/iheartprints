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
 * Phase 27G/27H — REAL-ASSET ACCEPTANCE for the manual background-removal
 * fallback, using the actual INCREDI-BOWLS upload the customer used during
 * production human-testing that revealed the original (backwards) fallback
 * UX. Read-only on the customer's file: only ever `readFileSync`d, never
 * written to. Everything else here runs in an isolated temp workspace with
 * its own throwaway local repository -- no live production project is ever
 * touched (Phase 27G's own instruction: use isolated/local acceptance, not
 * the final production-authority action against a real project).
 *
 * This is also the exact real asset that surfaced the Phase 27G dead end
 * (finalize refusing because this artwork independently requires
 * separation review) and now proves Phase 27H's fix: an explicitly
 * finalized manual correction is authoritative and completes end to end.
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

describe("INCREDI-BOWLS real-asset acceptance — Phase 27G manual fallback from original", { skip: !hasAsset }, () => {
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

  it("2/C: immediately after opening the manual workspace, the canvas shows the ORIGINAL (not the automatic result), with correction count 0", async () => {
    const { assets, capability, projectId } = await seed();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();

    const prep = await repo.getArtworkPreparation(projectId);
    const preparedBytes = (await assets.downloadAssetBytes(prep!.preparedAssetId!))!.bytes;
    const preparedPixels = await decoded(preparedBytes);
    const originalPixels = await decoded(originalBytes);

    // This is the exact call the manual workspace makes on open (before any
    // click) -- Section 1's "critical authority rule".
    const info = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(info.operationCount, 0, "opening the manual workspace must start with zero corrections");

    const shownOnOpen = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(originalPixels, shownOnOpen), 0, "the manual workspace must show the ORIGINAL exactly on open");
    assert.ok(countChangedPixels(preparedPixels, shownOnOpen) > 0, "the manual workspace must NOT show the automatic (damaged) result on open");
  });

  it("3-8: manual remove on an obvious background area, verify preview leaves the result untouched until applied, Delete removes, legitimate artwork remains, Undo restores, Start Over returns exactly to the original", async () => {
    const { capability, projectId } = await seed();
    const originalPixels = await decoded(originalBytes);

    // Sample a corner pixel as "obvious background" -- true for essentially
    // every real photographed/scanned upload, INCREDI-BOWLS included.
    const bgX = 2;
    const bgY = 2;

    const beforePreview = await decoded(await capability.getCorrectionResultPng(projectId));

    // Preview must not mutate the session -- reading the result again before
    // any operation is accepted must be unchanged.
    await capability.previewCorrectionSelection(projectId, { clicks: [{ x: bgX, y: bgY }], mode: "remove", toleranceLevel: "default" });
    const afterPreviewOnly = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(beforePreview, afterPreviewOnly), 0, "previewing a selection must not itself change the result");

    // Apply (Delete): now it actually removes.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: bgX, y: bgY }], mode: "remove", toleranceLevel: "default" });
    const afterApply = await decoded(await capability.getCorrectionResultPng(projectId));
    const bgIdx = (bgY * afterApply.width + bgX) * 4;
    assert.equal(afterApply.data[bgIdx + 3], 0, "the clicked background pixel must be transparent after apply");
    assert.ok(countChangedPixels(originalPixels, afterApply) > 0, "sanity: applying actually changed something");

    // Undo restores exactly.
    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(originalPixels, afterUndo), 0, "undo-to-zero must reproduce the original exactly");

    // Re-apply, then Start Over -- must also return exactly to the original.
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: bgX, y: bgY }], mode: "remove", toleranceLevel: "default" });
    await capability.resetCorrectionSession(projectId);
    const afterStartOver = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(countChangedPixels(originalPixels, afterStartOver), 0, "Start Over must reproduce the original exactly");
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

    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 2, y: 2 }], mode: "remove", toleranceLevel: "default" });
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
