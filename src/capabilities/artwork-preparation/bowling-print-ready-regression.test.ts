import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "@/capabilities/final-artwork/production-normalization";
import { readPhysicalPixelDensity } from "@/capabilities/final-artwork/production-png";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { PrintValidationReport } from "@/capabilities/print-validation/contracts";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { approvePreparedArtworkForTests } from "@/test-support/approve-prepared-artwork-for-tests";

import { bowlingStyleArtwork, toPngBytes } from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

/**
 * THE PHASE 2 ACCEPTANCE REGRESSION — the live bowling case, end to end, with
 * no network of any kind.
 *
 * `bowling-upload-regression.test.ts` proves Phase 1 (upload → analysis →
 * background isolation → approval) against the same synthetic fixture. This
 * suite starts where that one stops and drives the REAL Phase 1 capability the
 * whole way, so the handoff between the two phases is exercised rather than
 * assumed:
 *
 *     979x1024 opaque upload, ~923px of visible artwork
 *       → approved prepared transparent PNG
 *       → 10.5in Full Back at 300 PPI  (3150px required)
 *       → enhancement REQUIRED (923 << 3150)
 *       → local stand-in reconstruction
 *       → 3150px-wide production PNG, height from the artwork's own proportions
 *       → uploaded-preserve validation
 *       → print_ready
 *
 * The whole run happens with `fetch`, `http`, `https`, and raw sockets trapped,
 * so an OpenAI call, a Topaz call, or a segmentation call would fail loudly
 * instead of quietly spending money (scenarios AB and AC).
 */

/** The visible artwork's expected production width: 10.5in x 300 PPI. */
const EXPECTED_PLATE_WIDTH_PX = 3150;

/**
 * A local stand-in for the live Topaz Transparency Upscale adapter: the same
 * 4x proportional reconstruction, the same `preservesApprovedContent: false`,
 * the same `"reconstructed"` provenance, and the same shared production
 * normalization afterwards — but pure pixel replication, so it can run inside
 * a network-trapped test.
 */
class LocalStandInReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "local_stand_in_reconstruction";
  submitCount = 0;

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    this.submitCount += 1;
    await input.onProviderRequestSubmitted?.(`stand-in-${this.submitCount}`);

    const source = PNG.sync.read(input.sourceBytes);
    const reconstructed = replicate4x(source);
    const normalized = normalizeProductionRaster(reconstructed, input.sizing);
    if (normalized.status !== "normalized") throw new Error(normalized.reason);
    const encoded = encodeProductionPng(normalized.result);

    return {
      bytes: encoded.bytes,
      contentType: "image/png",
      widthPx: normalized.result.image.width,
      heightPx: normalized.result.image.height,
      hasTransparency: encoded.hasTransparency,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      reconstructedWidthPx: reconstructed.width,
      reconstructedHeightPx: reconstructed.height,
      resolutionProvenance: "reconstructed",
      transformationMethod: "local_stand_in_reconstruction_v1",
      preservesApprovedContent: false,
      providerRequestId: `stand-in-${this.submitCount}`,
      normalization: normalized.result.metadata,
    };
  }
}

function replicate4x(source: PNG): RgbaImage {
  const scale = 4;
  const width = source.width * scale;
  const height = source.height * scale;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = Math.floor(y / scale) * source.width;
    for (let x = 0; x < width; x += 1) {
      const from = (sourceRow + Math.floor(x / scale)) * 4;
      const to = (y * width + x) * 4;
      data[to] = source.data[from]!;
      data[to + 1] = source.data[from + 1]!;
      data[to + 2] = source.data[from + 2]!;
      data[to + 3] = source.data[from + 3]!;
    }
  }
  return { width, height, data };
}

describe("Bowling acceptance regression — approved prepared artwork → print-ready", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;
  const originalNetConnect = net.Socket.prototype.connect;
  let networkAttempts: string[] = [];

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bowling-print-ready-"));
    process.chdir(tempDir);

    const trap = (label: string) =>
      ((...args: unknown[]) => {
        networkAttempts.push(`${label}:${String(args[0])}`);
        throw new Error(`Network access is forbidden here (${label})`);
      }) as never;

    globalThis.fetch = trap("fetch");
    http.request = trap("http.request");
    https.request = trap("https.request");
    http.get = trap("http.get");
    https.get = trap("https.get");
    net.Socket.prototype.connect = trap("net.connect");
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    http.get = originalHttpGet;
    https.get = originalHttpsGet;
    net.Socket.prototype.connect = originalNetConnect;
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("produces a 10.5in, 300 DPI, transparent, tightly-trimmed print-ready PNG from the customer's own artwork", async () => {
    networkAttempts = [];

    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const preparation = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );
    const reconstruction = new LocalStandInReconstructionProvider();
    const local = new LocalRasterInterpolationProvider();
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      reconstruction,
      createPrintValidationCapability(),
      undefined,
      local,
    );

    const projectId = (await repo.createProject()).project.id;

    // --- Phase 1, through the real capability ------------------------------
    const uploadedBytes = toPngBytes(bowlingStyleArtwork());
    const uploadedHash = createHash("sha256").update(uploadedBytes).digest("hex");

    await preparation.uploadOriginal(projectId, {
      bytes: uploadedBytes,
      declaredContentType: "image/png",
      filename: "split disturbers.png",
    });
    const withContext = await preparation.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_back",
    });
    assert.equal(
      withContext.customer.enhancementNeeded,
      true,
      "the customer is told up front that this artwork needs enhancing",
    );

    await preparation.prepareBackground(projectId);
    const approved = await approvePreparedArtworkForTests(preparation, projectId);
    assert.equal(approved.approved, true);

    const preparationRow = await repo.getArtworkPreparation(projectId);
    assert.ok(preparationRow?.preparedAssetId);
    assert.ok(preparationRow?.preparedArtworkVersionId);
    const preparedBytes = (await assets.downloadAssetBytes(
      preparationRow.preparedAssetId,
    ))!.bytes;
    const preparedHash = createHash("sha256").update(preparedBytes).digest("hex");

    // Intelligent Separation Phase 10 (Goal 9): this fixture has a
    // consequential region, so `approvePreparedArtworkForTests` routed
    // approval through `approveSeparationMaster` rather than the legacy
    // path. Confirm `preparedAssetId` really is THAT master — carrying
    // `separationLineage` — not an asset the legacy path could have
    // produced, before trusting everything downstream to have been built
    // from it.
    const preparedAsset = await repo.getAssetById(preparationRow.preparedAssetId);
    assert.ok(
      preparedAsset?.metadata.separationLineage,
      "preparedAssetId must be the approved separation master, carrying its lineage",
    );

    // --- Phase 2 -----------------------------------------------------------
    // Print'em All Phase 1 (Goal 6): approving the PREPARED ARTWORK is not
    // approving the PRINT SIZE. Production is unavailable until a human
    // confirms the physical size — the exact gate whose absence let a live
    // Topaz credit be spent against a width nobody had chosen.
    await assert.rejects(
      () => finalArtwork.requestPreparedUploadFinalArtwork(projectId),
      /Confirm the print size before preparation/,
      "no production work is enqueued before the size is confirmed",
    );

    await confirmProductionSizeForTests(repo, projectId);

    const request = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(
      request.productionWidthIn,
      10.5,
      "the confirmed standard adult Full Back recommendation",
    );
    assert.equal(request.job.sourceKind, "prepared_upload");
    assert.equal(request.job.artworkPreparationId, preparationRow.id);
    assert.equal(
      (await repo.getProject(projectId))!.project.status,
      "finalizing",
      "the project is honestly 'being prepared', never still 'interviewing'",
    );

    const { processedJobId } = await worker.processNextJob();
    assert.equal(processedJobId, request.job.id);

    // --- Enhancement was required, and happened ----------------------------
    assert.equal(
      reconstruction.submitCount,
      1,
      "923px of artwork cannot fill a 3150px target — enhancement is required",
    );

    // --- The deliverable ---------------------------------------------------
    const productionAsset = (await repo.listAssets(projectId)).find(
      (asset) =>
        asset.finalArtworkJobId === request.job.id &&
        asset.productionRole === "production_png",
    );
    assert.ok(productionAsset, "a production asset exists");
    assert.equal(productionAsset.widthPx, EXPECTED_PLATE_WIDTH_PX);
    assert.equal(productionAsset.hasTransparency, true);
    assert.equal(productionAsset.contentType, "image/png");

    const normalization = productionAsset.metadata.normalization as Record<string, unknown>;
    assert.equal(normalization.targetPpi, 300);
    assert.equal(normalization.intendedWidthIn, 10.5);
    assert.equal(normalization.constrainedBy, "width");
    // Tightly trimmed: the artwork fills the plate, with only the small
    // artwork-edge safety margin around it.
    assert.ok(
      (normalization.artworkOccupancy as number) > 0.95,
      `expected a tight crop, got occupancy ${normalization.artworkOccupancy}`,
    );

    // Height is the artwork's own proportion — never a fixed canvas. The
    // bowling subject is very slightly taller than it is wide.
    const heightPx = productionAsset.heightPx!;
    const sourceRatio =
      (normalization.trimmedHeightPx as number) /
      (normalization.trimmedWidthPx as number);
    assert.equal(heightPx, Math.round(EXPECTED_PLATE_WIDTH_PX * sourceRatio));
    assert.ok(
      heightPx > 3000 && heightPx < 3200,
      `expected a near-square plate for this artwork, got ${EXPECTED_PLATE_WIDTH_PX}x${heightPx}`,
    );

    // 300 PPI is written into the file, not merely claimed about it.
    const producedBytes = (await assets.downloadAssetBytes(productionAsset.id))!.bytes;
    const density = readPhysicalPixelDensity(producedBytes);
    assert.ok(density);
    assert.equal(density.unitSpecifier, 1);
    assert.ok(Math.abs(density.ppiX - 300) < 1, `pHYs says ${density.ppiX} PPI`);

    // --- Uploaded-preserve validation --------------------------------------
    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      request.job.id,
    );
    const report = validation!.report as unknown as PrintValidationReport;
    assert.equal(report.profile, "uploaded_preserve");
    assert.equal(report.status, "ready", report.blockingIssues.join("; "));

    const emitted = report.checks.map((check) => check.check);
    assert.ok(emitted.includes("source_lineage"));
    assert.ok(emitted.includes("preserved_source_geometry"));
    assert.ok(emitted.includes("reconstruction_sufficiency"));
    assert.ok(!emitted.includes("required_wording_verification"));
    assert.ok(!emitted.includes("concept_evaluation_alignment"));
    assert.ok(!emitted.includes("brief_provenance"));

    // --- Lineage: the PREPARED artwork was the source, never the original ---
    const lineage = productionAsset.metadata.uploadedPreserve as Record<string, unknown>;
    assert.equal(lineage.preparedAssetId, preparationRow.preparedAssetId);
    assert.equal(lineage.originalAssetId, preparationRow.originalAssetId);
    assert.equal(lineage.sourceBytesSha256, preparedHash);
    assert.equal(lineage.enhancement, "reconstructed");
    assert.equal(productionAsset.metadata.sourceAssetId, preparationRow.preparedAssetId);

    // --- Nothing the customer owns was touched -----------------------------
    const originalAfter = await assets.downloadAssetBytes(preparationRow.originalAssetId);
    assert.equal(
      createHash("sha256").update(originalAfter!.bytes).digest("hex"),
      uploadedHash,
      "the immutable original upload is byte-identical",
    );
    const preparedAfter = await assets.downloadAssetBytes(preparationRow.preparedAssetId);
    assert.equal(
      createHash("sha256").update(preparedAfter!.bytes).digest("hex"),
      preparedHash,
      "the approved prepared artwork is byte-identical",
    );
    assert.notEqual(productionAsset.id, preparationRow.preparedAssetId);
    assert.notEqual(productionAsset.id, preparationRow.originalAssetId);

    // --- Customer-visible state --------------------------------------------
    const finished = await repo.getProject(projectId);
    assert.equal(finished!.project.status, "print_ready");
    assert.equal(
      await finalArtwork.getCurrentProductionAssetId(projectId),
      productionAsset.id,
    );

    // --- AB / AC: no creative generation, and no network at all -------------
    assert.deepEqual(
      await repo.listGenerationJobs(projectId),
      [],
      "AB: uploaded artwork is never routed through concept generation",
    );
    assert.equal(finished!.designBriefVersions.length, 0, "no brief was ever approved");
    assert.equal(await repo.getActiveFinalDirectionApproval(projectId), null);
    const artwork = finished!.artworkVersions;
    assert.equal(artwork.length, 1);
    assert.equal(artwork[0]!.kind, "prepared_upload");
    assert.equal(artwork[0]!.evaluation, null, "no Concept Evaluation ever ran");
    assert.equal(artwork[0]!.providerKey, null);

    assert.deepEqual(networkAttempts, [], "AC: zero network calls in the whole run");
  });
});
