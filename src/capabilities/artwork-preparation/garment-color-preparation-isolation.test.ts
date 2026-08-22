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

import { bowlingStyleArtwork, getPixel, toPngBytes } from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";

/**
 * GARMENT COLOUR IS NOT AN AUTHORITY OVER CUSTOMER PIXELS.
 *
 * Garment colour is real production context. It drives garment preview, the
 * DTF halftone tonal reference, and production-treatment decisions, and it
 * must keep doing so. What it must NEVER do is decide which of the customer's
 * pixels get deleted.
 *
 * The concrete incident this guards against: a black-background logo prepared
 * for a WHITE shirt, where it looked as though the design's own black had
 * been erased "because the shirt is white". It had not — background isolation
 * never reads the brief, so the prepared bytes are the same on any garment.
 * That independence was true only by construction, and nothing tested it, so
 * a future change could wire garment colour into the preparation path and no
 * suite would notice. This one would.
 *
 * The assertion is deliberately the strongest available: BYTE IDENTITY. The
 * whole pipeline is local, deterministic pixel math with no provider, no
 * randomness and no clock, so anything weaker than an identical SHA-256 would
 * be understating what the contract actually guarantees.
 */
describe("Garment colour cannot influence background preparation", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-garment-isolation-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * One full Existing Artwork preparation whose ONLY varying input is the
   * garment colour the customer stated during the interview.
   */
  async function prepareOnGarment(productColor: string) {
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
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "bowling logo.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor,
      printPlacement: "full_front",
    });

    const view = await capability.prepareBackground(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    const bytes = (await assets.downloadAssetBytes(preparation!.preparedAssetId!))!
      .bytes;

    return {
      view,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      record: preparation!.preparation!,
      image: decodePngUpload(bytes).image,
      snapshot: await repo.getProject(projectId),
    };
  }

  it("produces byte-identical prepared artwork on a white and a black garment", async () => {
    const white = await prepareOnGarment("White");
    const black = await prepareOnGarment("Black");

    assert.equal(
      white.sha256,
      black.sha256,
      "garment colour must not change a single prepared byte",
    );
    assert.equal(Buffer.compare(white.bytes, black.bytes), 0);
  });

  it("removes and preserves exactly the same pixels regardless of garment colour", async () => {
    const white = await prepareOnGarment("White");
    const black = await prepareOnGarment("Black");

    // Every mask pass reports the same counts — not just the same total.
    // A future contaminating change could hold the pixel count constant while
    // moving work between passes, so each is pinned individually.
    for (const key of [
      "exteriorPixelsRemoved",
      "interiorBackgroundColoredPixelsPreserved",
      "enclosedCavityRegionsRemoved",
      "enclosedCavityPixelsRemoved",
      "enclosedCavityRegionsPreserved",
      "speckleIslandsRemoved",
      "specklePixelsRemoved",
    ] as const) {
      assert.equal(
        white.record[key],
        black.record[key],
        `${key} must not depend on garment colour`,
      );
    }

    assert.deepEqual(white.record.backgroundColor, black.record.backgroundColor);
    assert.equal(white.record.tolerance, black.record.tolerance);
  });

  it("keeps the design's own interior black on a WHITE garment", async () => {
    // The incident report was specifically "black artwork vanished because I
    // said white shirt". These are the fixture's intentional interior strokes:
    // background-coloured, but unreachable from the border.
    const white = await prepareOnGarment("White");

    for (const [x, y] of [
      [489, 302],
      [489, 502],
      [489, 702],
      [302, 511],
      [682, 511],
    ] as const) {
      const pixel = getPixel(white.image, x, y);
      assert.equal(pixel.a, 255, `interior line work at ${x},${y} must survive`);
      assert.ok(
        pixel.r < 40,
        `interior line work at ${x},${y} must stay dark, got ${pixel.r}`,
      );
    }

    assert.ok(
      (white.record.interiorBackgroundColoredPixelsPreserved as number) > 4_000,
      "the bulk of interior background-coloured line work must be preserved",
    );
  });

  it("still makes the exterior background transparent on a WHITE garment", async () => {
    const white = await prepareOnGarment("White");

    for (const [x, y] of [
      [0, 0],
      [978, 0],
      [0, 1023],
      [978, 1023],
    ] as const) {
      assert.equal(
        getPixel(white.image, x, y).a,
        0,
        `exterior at ${x},${y} must be removed`,
      );
    }

    assert.equal(white.record.backgroundRemoved, true);
    assert.ok((white.record.exteriorPixelsRemoved as number) > 300_000);
  });

  it("preserves the subject and non-background colour on either garment", async () => {
    const white = await prepareOnGarment("White");
    const black = await prepareOnGarment("Black");

    for (const prepared of [white, black]) {
      // Light subject body.
      assert.equal(getPixel(prepared.image, 489, 511).a, 255);
      // Gold accent — a colour that is neither background nor subject white.
      const gold = getPixel(prepared.image, 489, 850);
      assert.equal(gold.a, 255);
      assert.ok(gold.r > 150 && gold.b < 120, "gold accent must survive intact");

      // Geometry is never altered by preparation.
      assert.equal(prepared.image.width, 979);
      assert.equal(prepared.image.height, 1024);
      assert.equal(prepared.record.aspectRatioPreserved, true);
    }
  });

  it("keeps garment colour available as production context for later stages", async () => {
    // The fix for pixel contamination must NOT be "delete shirtColor". DTF
    // halftone needs it as a tonal reference, so it has to survive on the
    // brief and stay readable from the preparation view.
    const white = await prepareOnGarment("White");
    const black = await prepareOnGarment("Black");

    assert.equal(white.snapshot!.brief.shirtColor, "White");
    assert.equal(black.snapshot!.brief.shirtColor, "Black");
    assert.equal(white.view.productColor, "White");
    assert.equal(black.view.productColor, "Black");
  });

  it("leaves prepared artwork independently approvable and cleanup still available", async () => {
    const white = await prepareOnGarment("White");

    assert.equal(white.view.hasPreparedArtwork, true);
    assert.equal(white.view.approved, false);
    assert.equal(
      white.view.guidedCleanup.available,
      true,
      "Clean Up Background must remain available for residue",
    );
  });
});
