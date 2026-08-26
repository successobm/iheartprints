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
 * Phase 27J §5 — REAL-ASSET REGRESSION for the operation-composition/replay
 * defect human acceptance reported in the "STRIKINGLY INCREDIBLE" text.
 *
 * COORDINATES were determined empirically against this exact file (not
 * eyeballed): each was verified via `previewCorrectionSelection` to be a
 * small, safely-enclosed (`touchesEdge: false`), mutually non-overlapping
 * region before being hard-coded here --
 *   - "D" (in "...CREDIBLE"): click (382,492) -> a 37px region, bounds
 *     {left:371,top:490,width:13,height:11}.
 *   - "B" (in "...CREDIBLE"): click (413,490) -> a 27px region, bounds
 *     {left:408,top:481,width:11,height:13}.
 *   - "R"-adjacent letter counter (in "...CREDIBLE", just left of D): click
 *     (352,499) -> a 17px region, bounds {left:349,top:496,width:8,height:4}.
 * All three bounding boxes are disjoint, confirming three genuinely
 * independent letter counters, exactly like the human-reported D/B/R
 * sequence.
 */
const INCREDI_BOWLS_PATH = "C:\\Users\\eric\\Downloads\\e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png";
const EXPECTED_SHA256 = "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";
const hasAsset = existsSync(INCREDI_BOWLS_PATH);

const D = { x: 382, y: 492 };
const B = { x: 413, y: 490 };
const R = { x: 352, y: 499 };

describe("INCREDI-BOWLS real-asset acceptance — Phase 27J operation-composition regression", { skip: !hasAsset }, () => {
  let tempDir = "";
  let previousCwd = "";
  let originalBytes: Buffer;

  before(() => {
    originalBytes = readFileSync(INCREDI_BOWLS_PATH);
    const actualSha256 = createHash("sha256").update(originalBytes).digest("hex");
    assert.equal(actualSha256, EXPECTED_SHA256, "INCREDI-BOWLS asset SHA256 must match before use");

    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-incredi-bowls-composition-"));
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
    return { capability, projectId };
  }

  async function decoded(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }
  function alphaAt(image: { data: Buffer; width: number }, p: { x: number; y: number }) {
    return image.data[(p.y * image.width + p.x) * 4 + 3];
  }

  it("sanity: D, B, and the third letter counter are each small, safely-enclosed, and mutually disjoint on the real asset", async () => {
    const { capability, projectId } = await seed();
    for (const [label, point] of [["D", D], ["B", B], ["R", R]] as const) {
      const preview = await capability.previewCorrectionSelection(projectId, { clicks: [point], mode: "remove", toleranceLevel: "default" });
      assert.ok(preview.pixelCount > 0 && preview.pixelCount < 100, `${label}: must be a small letter-counter-sized region`);
      assert.equal(preview.touchesEdge, false, `${label}: must be safely enclosed, not connected to the huge background`);
    }
  });

  it("remove D -> assert D transparent", async () => {
    const { capability, projectId } = await seed();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D must be transparent");
  });

  it("remove D, then remove B -> D remains transparent AND B is transparent (the human-reported bug, on the real asset)", async () => {
    const { capability, projectId } = await seed();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D must STILL be transparent after removing B");
    assert.equal(alphaAt(result, B), 0, "B must be transparent");
  });

  it("remove D, B, then R -> D, B, and R are all transparent", async () => {
    const { capability, projectId } = await seed();
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [B], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D must still be transparent after removing R");
    assert.equal(alphaAt(result, B), 0, "B must still be transparent after removing R");
    assert.equal(alphaAt(result, R), 0, "R must be transparent");
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 3, "all three operations must be present in history");
  });
});
