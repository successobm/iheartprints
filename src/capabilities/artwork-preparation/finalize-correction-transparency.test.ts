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
  alreadyTransparentArtwork,
  createCanvas,
  fillRect,
  NEAR_BLACK,
  setPixel,
  solidBlackExteriorArtwork,
  toPngBytes,
  WHITE,
} from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { artworkHasTransparency } from "./image-analysis";

/**
 * Pre-DTF integrity: `finalizeCorrection` must persist `hasTransparency`
 * from the actual correction output pixels — never hardcode `true` because
 * the correction workflow conceptually supports transparency.
 */
describe("finalizeCorrection transparency measurement", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-finalize-transparency-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function uploadReady(bytes: Buffer) {
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
      productColor: "Black",
      printPlacement: "full_front",
    });
    // Starts the correction session from the immutable original (Phase 27G).
    await capability.getCorrectionResultPng(projectId);
    return { repo, assets, capability, projectId };
  }

  it("A: correction result with real transparent pixels persists hasTransparency true", async () => {
    const { repo, assets, capability, projectId } = await uploadReady(
      toPngBytes(solidBlackExteriorArtwork()),
    );

    await capability.acceptCorrectionOperation(projectId, {
      clicks: [{ x: 2, y: 2 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const prepared = (await assets.listAssets(projectId)).find(
      (a) => a.id === preparation!.preparedAssetId,
    );
    assert.ok(prepared);
    assert.equal(prepared!.hasTransparency, true);

    const downloaded = (await assets.downloadAssetBytes(prepared!.id))!.bytes;
    assert.equal(artworkHasTransparency(decodePngUpload(downloaded).image), true);
  });

  it("B: fully opaque correction result persists hasTransparency false", async () => {
    const opaque = createCanvas(80, 80, WHITE);
    fillRect(opaque, 20, 20, 40, 40, NEAR_BLACK);
    assert.equal(artworkHasTransparency(opaque), false);

    const { repo, assets, capability, projectId } = await uploadReady(toPngBytes(opaque));
    await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const prepared = (await assets.listAssets(projectId)).find(
      (a) => a.id === preparation!.preparedAssetId,
    );
    assert.ok(prepared);
    assert.equal(prepared!.hasTransparency, false);
  });

  it("C: zero-operation correction on opaque source must NOT magically become transparent", async () => {
    const opaque = createCanvas(64, 64, NEAR_BLACK);
    fillRect(opaque, 16, 16, 32, 32, WHITE);
    assert.equal(artworkHasTransparency(opaque), false);

    const { repo, assets, capability, projectId } = await uploadReady(toPngBytes(opaque));
    // No acceptCorrectionOperation — zero operations.
    await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.status, "approved");
    const prepared = (await assets.listAssets(projectId)).find(
      (a) => a.id === preparation!.preparedAssetId,
    );
    assert.ok(prepared);
    assert.equal(
      prepared!.hasTransparency,
      false,
      "zero-op finalize must not hardcode hasTransparency true on opaque pixels",
    );

    const lineage = prepared!.metadata as { correctionLineage?: { operations?: unknown[] } };
    assert.equal(lineage.correctionLineage?.operations?.length ?? -1, 0);
  });

  it("D: existing genuinely transparent corrected artwork remains accepted with hasTransparency true", async () => {
    const transparent = alreadyTransparentArtwork();
    assert.equal(artworkHasTransparency(transparent), true);

    const { repo, assets, capability, projectId } = await uploadReady(toPngBytes(transparent));
    await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const prepared = (await assets.listAssets(projectId)).find(
      (a) => a.id === preparation!.preparedAssetId,
    );
    assert.ok(prepared);
    assert.equal(prepared!.hasTransparency, true);
    assert.equal(preparation!.status, "approved");
  });

  it("partial-alpha pixels count as transparency (same semantic as image-analysis)", async () => {
    const image = createCanvas(40, 40, WHITE);
    setPixel(image, 10, 10, { r: 20, g: 20, b: 20, a: 128 });
    assert.equal(artworkHasTransparency(image), true);

    const { repo, assets, capability, projectId } = await uploadReady(toPngBytes(image));
    await capability.finalizeCorrection(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    const prepared = (await assets.listAssets(projectId)).find(
      (a) => a.id === preparation!.preparedAssetId,
    );
    assert.equal(prepared!.hasTransparency, true);
  });
});
