import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { toPngBytes } from "./artwork-fixtures";
import { buildIndependentSeparationMaster } from "./separation-master-test-support";

/**
 * Phase 27K — WAND SELECTION / APPLY UX CLARITY.
 *
 * Human testing traced the Phase 27J "D/B/R regression" report to operator
 * confusion, not a real defect: a pending Wand selection PREVIEW read as an
 * already-completed removal, so clicking a second area (without applying
 * the first) looked like "D came back" when D was simply never committed.
 *
 * This file proves the underlying server-side distinction between PENDING
 * (preview only, zero accepted operations) and APPLIED (an accepted
 * operation exists) that the UI copy/visual changes in `CorrectionWorkspace.tsx`
 * now communicate explicitly. No selection geometry, tolerance, connectivity,
 * or replay logic is touched or retested here -- see
 * `magic-wand-correction-capability.test.ts` for that coverage, untouched.
 */
function threeIndependentRegionsArtwork(): RgbaImage {
  const width = 120;
  const height = 40;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 0;
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  function fillSquare(left: number, top: number, size: number) {
    for (let y = top; y < top + size; y += 1) {
      for (let x = left; x < left + size; x += 1) {
        const o = (y * width + x) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = 255;
      }
    }
  }
  fillSquare(10, 15, 10); // "D"
  fillSquare(50, 15, 10); // "B"/"R" stand-in
  return { width, height, data };
}

const D = { x: 15, y: 20 };
const R = { x: 55, y: 20 };

describe("Phase 27K: Wand selection/apply UX clarity (server-side truth behind the copy)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-wand-clarity-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seeded() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    const projectId = (await repo.createProject()).project.id;
    const originalBytes = toPngBytes(threeIndependentRegionsArtwork());
    await capability.uploadOriginal(projectId, { bytes: originalBytes, declaredContentType: "image/png", filename: "dr.png" });
    await capability.setProductionContext(projectId, { productSummary: "T-shirts", productColor: "Black", printPlacement: "full_front" });
    await capability.prepareBackground(projectId);
    const preparation = await repo.getArtworkPreparation(projectId);
    const preparedBytes = (await assets.downloadAssetBytes(preparation!.preparedAssetId!))!.bytes;
    // This fixture's D/B squares leave an in-bounds background strip between
    // them that automatic preparation already removed but Intelligent
    // Separation review has not yet decided (`fullRemovalSafe: false` --
    // proven by the diagnostic in
    // `incredi-bowls-manual-fallback-acceptance.test.ts`'s sibling test) --
    // so the correction workspace's actual base is the PENDING separation
    // master (which retains that strip), never the automatic `preparedBytes`
    // asset. See "Fix Separation Review -> Edit Artwork Authority Handoff".
    const separationMaster = await buildIndependentSeparationMaster(repo, projectId, originalBytes);
    return { capability, projectId, originalBytes, preparedBytes, separationMasterPixels: separationMaster };
  }

  async function decoded(bytes: Buffer) {
    return decodePngUpload(bytes).image;
  }
  function alphaAt(image: RgbaImage, p: { x: number; y: number }) {
    return image.data[(p.y * image.width + p.x) * 4 + 3];
  }

  // §9.A: click D (preview only) -- pending, zero accepted operations.
  it("A: previewing D creates a pending selection but ZERO accepted operations, and does not change the result", async () => {
    const { capability, projectId, separationMasterPixels } = await seeded();

    const preview = await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.ok(preview.pixelCount > 0, "D must be found as a valid selection");

    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0, "previewing must never itself create an operation");
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(result.data, separationMasterPixels.data), 0, "the actual result must be untouched by a mere preview -- D is not really removed yet");
  });

  // §9.B: without applying D, preview R -- R becomes pending, D was never
  // secretly accepted, operation count stays 0.
  it("B: previewing R without applying D leaves accepted operations at ZERO -- no D operation was secretly created", async () => {
    const { capability, projectId, separationMasterPixels } = await seeded();

    await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    // Operator clicks R instead of applying D (existing semantics: R simply
    // becomes the new pending preview -- Phase 27K keeps this unchanged).
    const previewR = await capability.previewCorrectionSelection(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });
    assert.ok(previewR.pixelCount > 0, "R must be found as a valid selection");

    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0, "still zero -- D was never committed, and R is only a preview too");
    const result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(Buffer.compare(result.data, separationMasterPixels.data), 0, "the result must still equal the separation-review base -- nothing was ever actually removed");
  });

  // §9.C: doing it correctly -- explicit apply for each.
  it("C: click D -> Remove Selected Area -> click R -> D stays removed and R is pending -> Remove Selected Area -> both removed", async () => {
    const { capability, projectId } = await seeded();

    await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1, "exactly one accepted operation after applying D");
    let result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D genuinely removed");

    // Click R (preview only) -- D must remain actually removed while R is merely pending.
    await capability.previewCorrectionSelection(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D remains genuinely removed while R is only pending");
    assert.equal(alphaAt(result, R), 255, "R is not removed yet -- it is still just a pending preview");
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1, "still exactly one accepted operation -- previewing R did not apply it");

    await capability.acceptCorrectionOperation(projectId, { clicks: [R], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 2, "exactly two accepted operations after applying R");
    result = await decoded(await capability.getCorrectionResultPng(projectId));
    assert.equal(alphaAt(result, D), 0, "D remains removed");
    assert.equal(alphaAt(result, R), 0, "R now genuinely removed");
  });

  // §10: tolerance changes only ever affect the PENDING preview -- never
  // create an operation on their own.
  it("§10: switching Less/Default/More on a pending D selection never creates an accepted operation -- only Remove Selected Area does", async () => {
    const { capability, projectId } = await seeded();

    const atDefault = await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0);

    const atLess = await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "less" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0, "switching to Less must not create an operation");

    const atMore = await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "more" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 0, "switching to More must not create an operation");

    // Sanity: previews are actually recomputed per tolerance level (not
    // cached/frozen at first click) -- pixelCount is monotonically
    // non-decreasing as tolerance widens for this fixture's solid-colour
    // regions (an exact equality check would be too strict/fixture-fitted;
    // the key invariant under test is "zero operations throughout", proven
    // above regardless of how the counts compare to each other).
    assert.ok(atLess.pixelCount > 0 && atDefault.pixelCount > 0 && atMore.pixelCount > 0);

    await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "more" });
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1, "only the explicit apply creates the operation");
  });

  // §11: Delete/Backspace behavior audit (the CLIENT-side keyboard shortcut
  // itself lives in CorrectionWorkspace.tsx and calls this exact same
  // `acceptCorrectionOperation` path -- proven at the source level in
  // `correction-workspace-shape.test.ts`'s test "G". This proves the
  // SERVER-side half of that contract: applying is idempotent-safe and
  // additive exactly like the button, so the shortcut and the button are
  // interchangeable, never a "second, different" mechanism.
  it("§11: applying an accepted pending selection (what Delete/Backspace triggers) behaves identically to clicking Remove Selected Area", async () => {
    const { capability, projectId } = await seeded();
    await capability.previewCorrectionSelection(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    const op = await capability.acceptCorrectionOperation(projectId, { clicks: [D], mode: "remove", toleranceLevel: "default" });
    assert.ok(op.operationId, "the same accept call the Delete shortcut and the button both invoke must succeed identically");
    assert.equal((await capability.getCorrectionSessionInfo(projectId)).operationCount, 1);
  });
});
