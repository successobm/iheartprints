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
import { approvePreparedArtworkForTests } from "@/test-support/approve-prepared-artwork-for-tests";

import {
  bowlingStyleArtwork,
  getPixel,
  toPngBytes,
} from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import type { ArtworkAnalysis } from "./contracts";
import { decodePngUpload } from "./image-decode";
import { analyzeArtwork } from "./image-analysis";
import { classifyRepairability } from "./repairability";

/**
 * THE PHASE 1 ACCEPTANCE REGRESSION.
 *
 * The audited real-world case is a customer's bowling logo: a 979x1024 fully
 * opaque PNG with a near-black exterior touching all four edges, a light
 * subject, intentional interior black strokes, and an anti-aliased boundary.
 * The measured properties that made it the reference case:
 *
 *     edge RGB      ≈ 0.78     (near-black)
 *     edge sigma    ≈ 0.53     (essentially flat)
 *     removable     ≈ 593k px  edge-connected exterior at tolerance 12
 *     PRESERVED     ≈ 5,835 px near-black pixels the border cannot reach
 *     artwork bbox  ≈ 923x909
 *
 * That last pair is the whole point. "Remove every black pixel" would delete
 * the customer's line work; only reachability distinguishes the exterior from
 * the interior. This suite asserts that distinction end to end, against a
 * SYNTHETIC fixture reproducing those properties — the customer's own file is
 * deliberately not committed to the repository (see `artwork-fixtures.ts`).
 */
describe("Bowling acceptance regression — uploaded artwork → prepared artwork", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bowling-upload-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  function analyzeFixture(placement: "full_front" | null): ArtworkAnalysis {
    return analyzeArtwork({
      image: bowlingStyleArtwork(),
      format: "image/png",
      byteSize: 512_000,
      declaresAlphaChannel: false,
      printPlacement: placement,
      intendedPrintWidthIn: null,
    });
  }

  it("reproduces the audited source properties", () => {
    const analysis = analyzeFixture(null);

    assert.equal(analysis.widthPx, 979);
    assert.equal(analysis.heightPx, 1024);
    assert.equal(analysis.fullyOpaque, true);
    assert.equal(analysis.hasTransparency, false);

    // Near-black exterior, essentially flat.
    assert.ok(
      analysis.edge.meanColor.r < 2,
      `edge mean should be near-black, got ${analysis.edge.meanColor.r}`,
    );
    assert.ok(
      analysis.edge.maxChannelStandardDeviation < 1.5,
      `edge sigma should be tiny, got ${analysis.edge.maxChannelStandardDeviation}`,
    );
    // A genuinely flat export keeps the audited baseline tolerance of 12.
    assert.equal(analysis.backgroundTolerance, 12);
    assert.equal(analysis.backgroundIsEdgeConnected, true);
    assert.ok(analysis.backgroundConfidence > 0.9);
  });

  it("would remove a large edge-connected exterior while preserving interior black", () => {
    const analysis = analyzeFixture(null);
    const totalPixels = 979 * 1024;

    const removable = Math.round(analysis.exteriorMaskFraction * totalPixels);
    assert.ok(
      removable > 300_000 && removable < 700_000,
      `expected a large but bounded removable exterior, got ${removable}`,
    );

    // The number that matters most: near-black pixels the border cannot reach.
    assert.ok(
      analysis.disconnectedBackgroundColoredPixels > 4_000,
      `interior black line work must be preserved, got ${analysis.disconnectedBackgroundColoredPixels}`,
    );
  });

  it("bounds the visible artwork at roughly the audited size", () => {
    const analysis = analyzeFixture(null);
    assert.ok(analysis.artworkBounds);

    const { width, height } = analysis.artworkBounds!;
    assert.ok(width > 900 && width <= 979, `artwork width ${width}`);
    assert.ok(height > 880 && height <= 1024, `artwork height ${height}`);
  });

  it("classifies as repairable, and identifies that enhancement is required for 10.5\" @ 300", () => {
    const analysis = analyzeFixture("full_front");
    const assessment = classifyRepairability(analysis);

    // The background IS safely removable — that is what "repairable" means
    // here, and it is independent of resolution.
    assert.equal(assessment.backgroundTreatment, "remove_exterior");
    assert.equal(assessment.canPrepareAutomatically, true);

    // And the artwork is honestly too small for the production target.
    const sufficiency = analysis.pixelSufficiency!;
    assert.equal(sufficiency.targetWidthIn, 10.5);
    assert.equal(sufficiency.targetPpi, 300);
    assert.equal(sufficiency.requiredWidthPx, 3150);
    assert.ok(sufficiency.availableWidthPx < 1000);
    assert.equal(sufficiency.sufficient, false);

    assert.equal(assessment.enhancementRequired, true);
    assert.equal(assessment.classification, "REQUIRES_ENHANCEMENT");
    assert.ok(assessment.reasons.includes("uniform_exterior_background"));
    assert.ok(assessment.reasons.includes("insufficient_pixels_for_target"));
  });

  it("prepares a transparent PNG that keeps the design and leaves the original untouched", async () => {
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
    const uploadedBytes = toPngBytes(bowlingStyleArtwork());
    const uploadedHash = createHash("sha256").update(uploadedBytes).digest("hex");

    await capability.uploadOriginal(projectId, {
      bytes: uploadedBytes,
      declaredContentType: "image/png",
      filename: "3 sons bowling logo.png",
    });
    const contextView = await capability.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_front",
    });

    assert.equal(
      contextView.customer.backgroundMessage,
      "Your artwork has a solid background that can be removed automatically.",
    );
    assert.equal(contextView.customer.enhancementNeeded, true);
    assert.match(
      contextView.customer.resolutionMessage!,
      /We'll need to enhance it before creating the final print-ready file\./,
    );

    const prepared = await capability.prepareBackground(projectId);
    assert.equal(prepared.hasPreparedArtwork, true);

    const preparation = await repo.getArtworkPreparation(projectId);
    const preparedBytes = await assets.downloadAssetBytes(
      preparation!.preparedAssetId!,
    );
    const decoded = decodePngUpload(preparedBytes!.bytes);

    // Exterior removed on every edge.
    assert.equal(getPixel(decoded.image, 0, 0).a, 0);
    assert.equal(getPixel(decoded.image, 978, 0).a, 0);
    assert.equal(getPixel(decoded.image, 0, 1023).a, 0);
    assert.equal(getPixel(decoded.image, 978, 1023).a, 0);

    // Subject intact.
    assert.equal(getPixel(decoded.image, 489, 511).a, 255);

    // Intentional interior black strokes intact and still black.
    const stroke = getPixel(decoded.image, 489, 302);
    assert.equal(stroke.a, 255);
    assert.ok(stroke.r < 40, `interior stroke should stay dark, got ${stroke.r}`);

    // Aspect ratio and dimensions preserved exactly.
    assert.equal(decoded.image.width, 979);
    assert.equal(decoded.image.height, 1024);
    const record = preparation!.preparation!;
    assert.equal(record.aspectRatioPreserved, true);
    assert.equal(record.backgroundRemoved, true);
    assert.ok((record.exteriorPixelsRemoved as number) > 300_000);
    assert.ok(
      (record.interiorBackgroundColoredPixelsPreserved as number) > 4_000,
      "interior line work must be reported as preserved",
    );
    assert.ok(
      (record.decontaminatedPixels as number) > 0,
      "an anti-aliased boundary over near-black must be decontaminated",
    );

    // The uploaded original is byte-identical.
    const originalAfter = await assets.downloadAssetBytes(
      preparation!.originalAssetId,
    );
    assert.equal(
      createHash("sha256").update(originalAfter!.bytes).digest("hex"),
      uploadedHash,
    );

    // Approval hands Phase 2 a prepared_upload ArtworkVersion, and claims
    // nothing about print readiness.
    const approved = await approvePreparedArtworkForTests(capability, projectId);
    assert.equal(approved.approved, true);
    assert.equal(approved.customer.enhancementNeeded, true);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.artworkVersions[0]!.kind, "prepared_upload");
    assert.notEqual(snapshot!.project.status, "print_ready");
  });
});
