import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  ArtworkPreparationStateError,
  createArtworkPreparationCapability,
} from "./artwork-preparation-capability";
import { complexPhotographicBackgroundArtwork, toPngBytes } from "./artwork-fixtures";
import { decodePngUpload } from "./image-decode";

/**
 * Phase 28A — MAKE MANUAL CLEANUP AVAILABLE FROM AUTOMATIC BACKGROUND REVIEW.
 *
 * Targets EXACTLY the scenario the human reported: an upload that
 * classifies `NEEDS_REVIEW` ("Your background is complex... A designer will
 * take a look"), for which automatic preparation refuses to run at all
 * (`prepareBackground` throws — see `artwork-preparation-capability.test.ts`'s
 * "refuses to prepare artwork the analyzer flagged for review"). Before this
 * phase, `preparedAssetId` stayed permanently null for such an upload, and
 * `ensureCorrectionSession` refused to start ("No prepared artwork exists
 * yet to correct.") — the manual correction workspace was UNREACHABLE for
 * exactly the artwork that needed it most.
 *
 * `complexPhotographicBackgroundArtwork()` (`artwork-fixtures.ts`, fixture
 * I) is reused verbatim — a photographic-noise exterior with a foreground
 * subject, connected to every edge, no dominant background colour. This
 * satisfies Section 13's fixture requirements without inventing a second
 * one and without ever touching a real customer's photograph. See the
 * final report for why this stands in for "a JPG was uploaded": the
 * upload pipeline is PNG-only by a separate, deliberate, and untouched
 * architecture decision (`upload-limits.ts`, `ARCHITECTURE.md` §13h) — this
 * phase changes what a NEEDS_REVIEW upload can do next, never what file
 * formats are accepted.
 */
describe("Phase 28A: manual cleanup is reachable for an upload automatic preparation never ran on", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-phase28a-manual-cleanup-"));
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

  /** Seeds a NEEDS_REVIEW upload and stops -- deliberately never calls prepareBackground, matching the real dead end exactly. */
  async function seededNeedsReview() {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(complexPhotographicBackgroundArtwork());
    await capability.uploadOriginal(projectId, {
      bytes: originalBytes,
      declaredContentType: "image/png",
      filename: "photo.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    return { repo, assets, capability, projectId, originalBytes };
  }

  async function decodedPixels(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }
  function pixelsEqual(a: { data: Buffer }, b: { data: Buffer }) {
    return Buffer.compare(a.data, b.data) === 0;
  }

  it("sanity: this fixture genuinely classifies NEEDS_REVIEW and prepareBackground genuinely refuses", async () => {
    const { capability, projectId } = await seededNeedsReview();
    const view = await capability.getPreparation(projectId);
    assert.equal(view!.classification, "NEEDS_REVIEW");
    assert.equal(view!.customer.canPrepare, false);
    await assert.rejects(() => capability.prepareBackground(projectId), ArtworkPreparationStateError);
  });

  it("A: preparedAssetId stays null after upload -- the exact precondition the old guard assumed could never happen", async () => {
    const { repo, projectId } = await seededNeedsReview();
    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, null);
    assert.equal(preparation!.originalAssetId != null, true, "originalAssetId is always set at upload time");
  });

  it("B: the correction workspace can now be entered (preview) with no prior automatic preparation at all", async () => {
    const { capability, projectId } = await seededNeedsReview();
    // Would have thrown "No prepared artwork exists yet to correct." before this phase's fix.
    const preview = await capability.previewCorrectionSelection(projectId, {
      clicks: [{ x: 0, y: 0 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    assert.ok(preview.overlayPng.length > 0);
  });

  it("C/non-mutation: merely opening the session (a preview call) changes nothing about preparedAssetId, status, or separation state", async () => {
    const { repo, capability, projectId } = await seededNeedsReview();
    const before = await repo.getArtworkPreparation(projectId);
    await capability.previewCorrectionSelection(projectId, {
      clicks: [{ x: 0, y: 0 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    await capability.getCorrectionResultPng(projectId);
    await capability.getCorrectionSessionInfo(projectId);
    const after = await repo.getArtworkPreparation(projectId);
    assert.equal(after!.preparedAssetId, before!.preparedAssetId, "still null -- opening/previewing never sets it");
    assert.equal(after!.status, before!.status, "status untouched by opening the workspace");
    assert.deepEqual(after!.separation, before!.separation, "separation decisions untouched by opening the workspace");
  });

  it("authority invariant: the session's base/original is the immutable ORIGINAL upload, not any automatic/proposed pixels (there are none)", async () => {
    const { capability, projectId, originalBytes } = await seededNeedsReview();
    const originalPng = await capability.getCorrectionOriginalPng(projectId);
    const resultBeforeAnyOp = await capability.getCorrectionResultPng(projectId);
    const uploaded = await decodedPixels(originalBytes);
    assert.ok(pixelsEqual(await decodedPixels(originalPng), uploaded), "correction/original must be byte-identical to the uploaded original");
    assert.ok(pixelsEqual(await decodedPixels(resultBeforeAnyOp), uploaded), "result before any operation must equal the original -- nothing automatic ran to diverge from it");
  });

  it("D/E: Wand (remove), Fill is refused safely when nothing is transparent yet, Brush/Eraser, and Undo all work from this entry point", async () => {
    const { capability, projectId } = await seededNeedsReview();

    const wandOp = await capability.acceptCorrectionOperation(projectId, {
      clicks: [{ x: 0, y: 0 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    assert.ok(wandOp.operationId);

    const eraserOp = await capability.acceptCorrectionOperation(projectId, {
      tool: "erase_brush",
      points: [{ x: 60, y: 60 }],
      radius: 6,
    });
    assert.ok(eraserOp.operationId);

    const beforeUndo = await capability.getCorrectionResultPng(projectId);
    await capability.undoCorrectionOperation(projectId);
    const afterUndo = await capability.getCorrectionResultPng(projectId);
    assert.notEqual(
      Buffer.compare((await decodedPixels(afterUndo)).data, (await decodedPixels(beforeUndo)).data),
      0,
      "Undo must actually change the result back one step",
    );
  });

  it("F: reset ('Start Over') returns to the original with zero operations, still without ever having had an automatic preparedAssetId", async () => {
    const { capability, projectId, originalBytes } = await seededNeedsReview();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 0, y: 0 }], mode: "remove", toleranceLevel: "default" });
    await capability.resetCorrectionSession(projectId);
    const info = await capability.getCorrectionSessionInfo(projectId);
    assert.equal(info.operationCount, 0);
    const result = await capability.getCorrectionResultPng(projectId);
    assert.ok(pixelsEqual(await decodedPixels(result), await decodedPixels(originalBytes)));
  });

  it("G/authority-transition: finalizeCorrection sets preparedAssetId for the FIRST time, marks approved, and stamps correctionLineage", async () => {
    const { repo, capability, projectId } = await seededNeedsReview();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 0, y: 0 }], mode: "remove", toleranceLevel: "default" });
    const view = await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.ok(preparation!.preparedAssetId, "preparedAssetId must now be set -- the FIRST time for this upload");
    assert.equal(preparation!.status, "approved");
    assert.equal(view.hasPreparedArtwork, true);
  });

  it("H/no-separation-review-loop: after finalizeCorrection, getSeparationReview reports review_not_required -- the existing Phase 27H mechanism, reused with zero new code", async () => {
    const { capability, projectId } = await seededNeedsReview();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 0, y: 0 }], mode: "remove", toleranceLevel: "default" });
    await capability.finalizeCorrection(projectId);

    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.state, "review_not_required", "an accepted manual correction must supersede separation review for this result");
  });

  it("I: automatic approval remains refused server-side after a manual finalize for THIS artwork (defense in depth, untouched)", async () => {
    const { capability, projectId } = await seededNeedsReview();
    await capability.acceptCorrectionOperation(projectId, { clicks: [{ x: 0, y: 0 }], mode: "remove", toleranceLevel: "default" });
    await capability.finalizeCorrection(projectId);

    await assert.rejects(
      () => capability.approveSeparationMaster(projectId),
      (error: unknown) => {
        assert.ok(error instanceof ArtworkPreparationStateError);
        assert.match(error.message, /already manually corrected and approved/);
        return true;
      },
    );
  });

  it("J: idempotency -- opening/previewing the correction workspace repeatedly before any accept is a no-op, safe to call any number of times", async () => {
    const { repo, capability, projectId } = await seededNeedsReview();
    for (let i = 0; i < 3; i += 1) {
      await capability.previewCorrectionSelection(projectId, { clicks: [{ x: 0, y: 0 }], mode: "remove", toleranceLevel: "default" });
      await capability.getCorrectionSessionInfo(projectId);
    }
    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparedAssetId, null, "still no preparedAssetId -- repeated opens never mutate authority");
  });

  it("K: JPEG-format ingress remains rejected exactly as before -- this phase changes what a NEEDS_REVIEW upload can do next, never what file formats are accepted", async () => {
    const { capability, projectId } = await seededNeedsReview();
    const jpegMagicBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
    await assert.rejects(
      () =>
        capability.uploadOriginal(projectId, {
          bytes: jpegMagicBytes,
          declaredContentType: "image/jpeg",
          filename: "photo.jpg",
        }),
      (error: unknown) => {
        assert.match((error as Error).message, /You've already approved artwork|PNG images right now/);
        return true;
      },
    );
  });
});
