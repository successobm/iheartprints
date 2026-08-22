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
import {
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_BACKGROUNDS,
} from "@/components/chat/preview-background";

import {
  bowlingStyleArtwork,
  solidBlackExteriorArtwork,
  toPngBytes,
} from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import {
  describeApprovedPreparation,
  describePreparedArtworkReview,
} from "./preparation-copy";

/**
 * WE DO NOT PROMISE THE PREPARED DESIGN IS UNCHANGED.
 *
 * The audit that produced this suite proved the promise was false. Background
 * isolation removes pixels that match the background colour AND are reachable
 * from the image border; a design element drawn in that colour and touching
 * the background is, at the pixel level, the background, and goes with it. On
 * the bowling logo that took the black keylines around the lettering.
 *
 * The algorithm is correct and is NOT changed here. What changes is that the
 * product stops claiming more than the algorithm can deliver, and points the
 * customer at an inspection surface that does not lie to them.
 *
 * Two separate truths have to survive together:
 *
 *   THE ORIGINAL UPLOAD IS UNTOUCHED     <- still absolute, still stated
 *   THE PREPARED ASSET IS REVIEWABLE     <- no categorical preservation claim
 */
describe("Prepared artwork review is truthful", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-prepared-review-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function prepare(
    image: Parameters<typeof toPngBytes>[0],
    productColor = "White",
  ) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );

    const projectId = (await repo.createProject()).project.id;
    const uploadedBytes = toPngBytes(image);
    await capability.uploadOriginal(projectId, {
      bytes: uploadedBytes,
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor,
      printPlacement: "full_front",
    });

    const view = await capability.prepareBackground(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    const prepared = (await assets.downloadAssetBytes(
      preparation!.preparedAssetId!,
    ))!.bytes;
    const original = (await assets.downloadAssetBytes(
      preparation!.originalAssetId,
    ))!.bytes;

    return {
      capability,
      repo,
      projectId,
      view,
      uploadedBytes,
      original,
      prepared,
      preparedSha: createHash("sha256").update(prepared).digest("hex"),
      record: preparation!.preparation!,
    };
  }

  // ---------------------------------------------------------------------
  // The advisory, and the evidence behind it
  // ---------------------------------------------------------------------

  it("raises a review notice when the design shares the background's colour", async () => {
    const bowling = await prepare(bowlingStyleArtwork());

    // The trigger must be the recorded evidence, not the filename or a guess.
    assert.ok(
      (bowling.record.interiorBackgroundColoredPixelsPreserved as number) > 0,
      "this fixture must actually contain background-coloured design content",
    );

    const review = bowling.view.preparedReview;
    assert.ok(review, "a prepared asset must carry review copy");
    assert.equal(review.sharesBackgroundColor, true);
    assert.match(review.headline, /review recommended/i);
    // Names all three surfaces, because the point is to go look.
    assert.match(review.guidance, /Gray/);
    assert.match(review.guidance, /White/);
    assert.match(review.guidance, /Black/);
  });

  it("stays neutral when the design shares no colour with the background", async () => {
    const plain = await prepare(solidBlackExteriorArtwork());

    assert.equal(plain.record.interiorBackgroundColoredPixelsPreserved, 0);

    const review = plain.view.preparedReview!;
    assert.equal(review.sharesBackgroundColor, false);
    assert.doesNotMatch(review.headline, /review recommended/i);
    assert.match(review.guidance, /review/i);
  });

  it("derives the notice purely from recorded evidence, never from the image", () => {
    // Pure function, exercised directly: the decision must be a reading of the
    // record and nothing else, so it can never drift into re-measuring pixels.
    assert.equal(
      describePreparedArtworkReview({
        interiorBackgroundColoredPixelsPreserved: 1,
      }).sharesBackgroundColor,
      true,
    );
    assert.equal(
      describePreparedArtworkReview({
        interiorBackgroundColoredPixelsPreserved: 0,
      }).sharesBackgroundColor,
      false,
    );
    // Missing / malformed evidence must fall back to the neutral copy rather
    // than throwing or inventing a warning.
    assert.equal(describePreparedArtworkReview(null).sharesBackgroundColor, false);
    assert.equal(describePreparedArtworkReview({}).sharesBackgroundColor, false);
    assert.equal(
      describePreparedArtworkReview({
        interiorBackgroundColoredPixelsPreserved: "lots",
      }).sharesBackgroundColor,
      false,
    );
  });

  it("never claims the prepared design is unchanged or preserved", async () => {
    const bowling = await prepare(bowlingStyleArtwork());

    const preparedFacingCopy = [
      bowling.view.preparedReview!.headline,
      bowling.view.preparedReview!.guidance,
      describeApprovedPreparation(true).summary,
      describeApprovedPreparation(false).summary,
    ].join(" ");

    for (const forbidden of [
      /\bunchanged\b/i,
      /preserved your artwork/i,
      /nothing about your design was changed/i,
      /only the background/i,
    ]) {
      assert.doesNotMatch(
        preparedFacingCopy,
        forbidden,
        `prepared-artwork copy must not claim: ${forbidden}`,
      );
    }
  });

  it("still tells the customer their ORIGINAL upload is untouched", async () => {
    const bowling = await prepare(bowlingStyleArtwork());

    // Not just wording — the bytes really are identical.
    assert.equal(
      createHash("sha256").update(bowling.original).digest("hex"),
      createHash("sha256").update(bowling.uploadedBytes).digest("hex"),
      "the uploaded original must be byte-identical after preparation",
    );
  });

  // ---------------------------------------------------------------------
  // Preview background is presentation, and only presentation
  // ---------------------------------------------------------------------

  it("defaults inspection to Gray and keeps White and Black available", () => {
    assert.equal(DEFAULT_PREVIEW_BACKGROUND, "gray");
    assert.ok(PREVIEW_BACKGROUNDS.includes("white"));
    assert.ok(PREVIEW_BACKGROUNDS.includes("black"));
  });

  it("has no preview-background input anywhere in the preparation contract", async () => {
    const bowling = await prepare(bowlingStyleArtwork());

    // The strongest available statement that preview cannot mutate artwork:
    // the server-side view carries no preview-background field at all, so
    // there is nothing for a client selection to round-trip into.
    const serialized = JSON.stringify(bowling.view);
    assert.doesNotMatch(serialized, /previewBackground/i);
    for (const surface of PREVIEW_BACKGROUNDS) {
      assert.equal(
        bowling.view.productColor,
        "White",
        `garment colour must not be confused with the ${surface} preview surface`,
      );
    }
  });

  it("never persists a preview surface as the garment colour", async () => {
    // "gray" is a preview surface, never a shirt. Preparing must leave the
    // customer's stated garment colour exactly as they gave it.
    const bowling = await prepare(bowlingStyleArtwork(), "White");
    const snapshot = await bowling.repo.getProject(bowling.projectId);

    assert.equal(snapshot!.brief.shirtColor, "White");
    assert.notEqual(snapshot!.brief.shirtColor, "gray");
    assert.equal(bowling.view.productColor, "White");
  });

  it("produces identical prepared bytes no matter the garment colour", async () => {
    const white = await prepare(bowlingStyleArtwork(), "White");
    const black = await prepare(bowlingStyleArtwork(), "Black");

    assert.equal(white.preparedSha, black.preparedSha);
    // Pinned: this task changed copy and presentation only. If background
    // isolation ever moves, this is the assertion that says so out loud.
    assert.equal(
      white.preparedSha,
      "b54947f2a681b76ba5814f8066c9b8fc2395e3ff70f25dec9095e68ef4a44615",
      "prepared pixel output must not have changed",
    );
  });

  it("keeps Clean Up Background available for residue and never auto-approves", async () => {
    const bowling = await prepare(bowlingStyleArtwork());

    assert.equal(bowling.view.guidedCleanup.available, true);
    assert.equal(bowling.view.approved, false);
    assert.notEqual(bowling.view.status, "approved");
  });
});
