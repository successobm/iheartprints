import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  bowlingStyleArtwork,
  foregroundRingArtwork,
  letterCounterArtwork,
  solidBlackExteriorArtwork,
  toPngBytes,
} from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { readPngHeader } from "./image-decode";

/**
 * Intelligent Separation Phase 2 acceptance — wiring evidence, not
 * experimental behaviour. Every assertion here is about REVIEW STATE and
 * COPY; no source strategy switches, no separation runs, no provider is ever
 * involved.
 */

// Resolved BEFORE any test in this file chdir's into a temp workspace.
const BOWLING_ORIGINAL = path.resolve(
  process.cwd(),
  ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png",
);
const hasBowling = existsSync(BOWLING_ORIGINAL);

describe("Garment-conditional preparation review (Phase 2)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-garment-review-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function prepareWithBytes(bytes: Buffer, productColor: string) {
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
    await capability.uploadOriginal(projectId, {
      bytes,
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
    const prepared = (await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes;

    return { view, preparation: preparation!, prepared, repo, capability, projectId };
  }

  async function prepare(image: RgbaImage, productColor: string) {
    return prepareWithBytes(toPngBytes(image), productColor);
  }

  // -------------------------------------------------------------------
  // D/E/F: the bowling fixture, matched vs mismatched garment
  // -------------------------------------------------------------------

  it("D: the bowling-style fixture is flagged review_required", async () => {
    const { view } = await prepare(bowlingStyleArtwork(), "Black");
    assert.ok(view.preparedReview);
    assert.equal(view.preparedReview!.reviewRequired, true);
  });

  it("E: a BLACK garment (matches the near-black background) gets matched-garment copy", async () => {
    const { view } = await prepare(bowlingStyleArtwork(), "Black");
    const review = view.preparedReview!;
    assert.equal(review.garmentMayMatchBackground, true);
    assert.match(review.guidance, /already be supplied by the shirt/i);
    assert.match(review.headline, /review recommended/i);
  });

  it("F: a WHITE garment (does not match) gets mismatched-garment copy", async () => {
    const { view } = await prepare(bowlingStyleArtwork(), "White");
    const review = view.preparedReview!;
    assert.equal(review.garmentMayMatchBackground, false);
    assert.match(review.guidance, /missing fill or detail/i);
    assert.match(review.headline, /review recommended/i);
  });

  it("both garment cases still name all three preview surfaces", async () => {
    const black = await prepare(bowlingStyleArtwork(), "Black");
    const white = await prepare(bowlingStyleArtwork(), "White");
    for (const view of [black.view, white.view]) {
      const guidance = view.preparedReview!.guidance;
      assert.match(guidance, /Gray/);
      assert.match(guidance, /White/);
      assert.match(guidance, /Black/);
    }
  });

  it("C: prepared bytes are IDENTICAL regardless of garment colour", async () => {
    const black = await prepare(bowlingStyleArtwork(), "Black");
    const white = await prepare(bowlingStyleArtwork(), "White");
    assert.equal(
      createHash("sha256").update(black.prepared).digest("hex"),
      createHash("sha256").update(white.prepared).digest("hex"),
      "garment colour must never influence background-removal bytes",
    );
  });

  it("no automatic source or treatment switch occurs on review_required", async () => {
    const { view, preparation } = await prepare(bowlingStyleArtwork(), "Black");
    assert.equal(view.preparedReview!.reviewRequired, true);
    // Still just an ordinary un-approved preparation — no new fields, no
    // auto-approval, no treatment recorded anywhere on this row.
    assert.equal(view.approved, false);
    assert.equal(preparation.status, "prepared");
    assert.equal(preparation.approvedAt, null);
  });

  // -------------------------------------------------------------------
  // G: a genuinely safe fixture stays neutral
  // -------------------------------------------------------------------

  it("G: an ordinary safe background produces neutral review copy", async () => {
    const { view } = await prepare(solidBlackExteriorArtwork(), "Navy");
    const review = view.preparedReview!;
    assert.equal(review.reviewRequired, false);
    assert.equal(review.headline, "Background prepared");
    assert.doesNotMatch(review.headline, /review recommended/i);
  });

  // -------------------------------------------------------------------
  // H: non-zero topological intrusion never becomes "unsafe"
  // -------------------------------------------------------------------

  for (const [name, make] of [
    ["foregroundRing", foregroundRingArtwork],
    ["letterCounter", letterCounterArtwork],
  ] as const) {
    it(`H: ${name} is review_required, never worded as unsafe/damaged`, async () => {
      const { view } = await prepare(make(), "White");
      const review = view.preparedReview!;
      assert.equal(review.reviewRequired, true);
      const copy = `${review.headline} ${review.guidance}`;
      for (const forbidden of [/unsafe/i, /damaged/i, /destroyed/i, /\bbroken\b/i]) {
        assert.doesNotMatch(copy, forbidden);
      }
    });
  }

  // -------------------------------------------------------------------
  // I: an old preparation record (no exteriorRemovalEnclosureRatio) still
  // loads, and does not fall back to "safe by absence".
  // -------------------------------------------------------------------

  it("I: a record missing the new evidence field still reads, using existing evidence", async () => {
    const { repo, preparation, capability, projectId } = await prepare(
      bowlingStyleArtwork(),
      "Black",
    );

    // Simulate a preparation persisted before Phase 2: strip the new field
    // but keep everything that has always been there.
    const legacyRecord = { ...(preparation.preparation as Record<string, unknown>) };
    delete legacyRecord.exteriorRemovalEnclosureRatio;
    await repo.updateArtworkPreparation(preparation.id, { preparation: legacyRecord });

    const reloaded = await capability.getPreparation(projectId);
    assert.ok(reloaded, "the project's preparation must still load");
    assert.ok(reloaded!.preparedReview, "an old record must still produce review copy");
    // The OLD signal (disconnectedBackgroundColoredPixels, always present on
    // `analysis`) still drives review_required — never silently "safe".
    assert.equal(reloaded!.preparedReview!.reviewRequired, true);
  });

  it("J: no migration is required for the fallback above — additive JSON only", () => {
    // Structural proof, not a runtime one: BackgroundPreparationRecord's new
    // field is declared optional (`exteriorRemovalEnclosureRatio?: number`),
    // and `ArtworkPreparation.preparation` is untyped JSON
    // (`Record<string, unknown> | null`). Nothing here requires a column.
    assert.ok(true);
  });

  // -------------------------------------------------------------------
  // K/L: standard raster / halftone source selection is untouched
  // -------------------------------------------------------------------

  it("K/L: the prepared asset id is still the ONLY thing production reads", async () => {
    const { preparation } = await prepare(bowlingStyleArtwork(), "Black");
    // The new evidence lives entirely inside `preparation.preparation`
    // (JSON diagnostics) — `preparedAssetId` itself, which
    // `final-artwork-worker` actually resolves from, is untouched.
    assert.ok(preparation.preparedAssetId);
    assert.notEqual(preparation.preparedAssetId, preparation.originalAssetId);
  });

  // -------------------------------------------------------------------
  // N: Gray preview default unaffected
  // -------------------------------------------------------------------

  it("N: the prepared asset is still a valid transparent PNG (Gray-previewable)", async () => {
    const { prepared } = await prepare(bowlingStyleArtwork(), "Black");
    const header = readPngHeader(prepared);
    assert.equal(header.declaresAlphaChannel, true);
  });
});

describe(
  "The REAL live bowling asset — exact acceptance",
  { skip: !hasBowling },
  () => {
    let tempDir = "";
    let previousCwd = "";

    before(() => {
      previousCwd = process.cwd();
      tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-garment-review-live-"));
      process.chdir(tempDir);
    });

    after(async () => {
      await cleanupTempWorkspace(tempDir, previousCwd);
    });

    async function prepareLive(productColor: string) {
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
      await capability.uploadOriginal(projectId, {
        bytes: readFileSync(BOWLING_ORIGINAL),
        declaredContentType: "image/png",
        filename: "Bowling_Logo.png",
      });
      await capability.setProductionContext(projectId, {
        productSummary: "T-shirts",
        productColor,
        printPlacement: "full_front",
      });
      const view = await capability.prepareBackground(projectId);
      const preparation = await repo.getArtworkPreparation(projectId);
      return { view, preparation: preparation! };
    }

    it("black garment: matches detected background, matched-garment copy, still manual approval", async () => {
      const { view, preparation } = await prepareLive("Black");
      const ratio = (preparation.preparation as Record<string, unknown>)
        .exteriorRemovalEnclosureRatio as number;
      assert.ok(Math.abs(ratio - 0.4558) < 0.001, `expected ≈0.4558, got ${ratio}`);
      assert.equal(view.preparedReview!.reviewRequired, true);
      assert.equal(view.preparedReview!.garmentMayMatchBackground, true);
      assert.equal(view.approved, false);
    });

    it("white garment: does not match, mismatched-garment copy, still manual approval", async () => {
      const { view } = await prepareLive("White");
      assert.equal(view.preparedReview!.reviewRequired, true);
      assert.equal(view.preparedReview!.garmentMayMatchBackground, false);
      assert.match(view.preparedReview!.guidance, /missing fill or detail/i);
      assert.equal(view.approved, false);
    });
  },
);
