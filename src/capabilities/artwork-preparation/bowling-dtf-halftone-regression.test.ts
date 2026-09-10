import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConversationCapability } from "@/capabilities/conversation";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import type { FinalArtworkProvider } from "@/capabilities/final-artwork/provider";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";

// Resolved BEFORE any test in this file chdir's into a temp workspace.
const ROOT = process.cwd();
const BOWLING_ORIGINAL = path.resolve(
  ROOT,
  ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png",
);
const hasBowling = existsSync(BOWLING_ORIGINAL);

/**
 * False Print-Ready Guard interaction with Phase 28I's raster-first Halftone
 * gate: an undersized bowling separation master can produce a reconstructed
 * Standard Raster plate, but automatic Print Ready is withheld — and Halftone
 * therefore remains gated until Standard Raster is genuinely print_ready.
 *
 * ISOLATION: a fresh `LocalProjectRepository` in a throwaway temp directory.
 * Never touches the live project `563b1ef4-1525-455b-ba81-9a21105a2b9c`.
 */
describe(
  "Bowling DTF halftone regression — separation-approved master through the real worker",
  { skip: !hasBowling },
  () => {
    let tempDir = "";
    let previousCwd = "";

    before(() => {
      previousCwd = process.cwd();
      tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bowling-halftone-"));
      process.chdir(tempDir);
    });

    after(async () => {
      await cleanupTempWorkspace(tempDir, previousCwd);
    });

    it("undersized bowling Standard Raster is withheld from Print Ready, so Halftone remains gated", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const { ArtworkFinalizationRasterNotReadyError } = await import(
        "@/capabilities/final-artwork/raster-not-ready-error"
      );
      const repo = new LocalProjectRepository();
      const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
      const designBrief = createDesignBriefCapability(repo);
      const preparation = createArtworkPreparationCapability(repo, assets, designBrief);
      const finalArtwork = createFinalArtworkCapability(repo);
      const acquisition = createAcquisitionCapability(repo);
      const conversation = createConversationCapability({
        repo,
        designBrief,
        acquisition,
        finalArtwork,
      } as never);
      // Local stand-in reconstruction — Topaz is never reached. Geometry can
      // succeed; the False Print-Ready Guard still withholds Print Ready.
      class FakeReconstructionProvider implements FinalArtworkProvider {
        readonly providerKey = "fake_bowling_reconstruction";
        async produce(input: import("@/capabilities/final-artwork/provider").FinalArtworkProviderInput) {
          const { PNG: Pngjs } = await import("pngjs");
          const {
            encodeProductionPng,
            normalizeProductionRaster,
          } = await import("@/capabilities/final-artwork/production-normalization");
          const source = Pngjs.sync.read(input.sourceBytes);
          const scale = 5;
          const reconstructed = new Pngjs({
            width: source.width * scale,
            height: source.height * scale,
          });
          for (let y = 0; y < reconstructed.height; y += 1) {
            for (let x = 0; x < reconstructed.width; x += 1) {
              const sx = Math.min(source.width - 1, Math.floor(x / scale));
              const sy = Math.min(source.height - 1, Math.floor(y / scale));
              const si = (sy * source.width + sx) << 2;
              const di = (y * reconstructed.width + x) << 2;
              reconstructed.data[di] = source.data[si]!;
              reconstructed.data[di + 1] = source.data[si + 1]!;
              reconstructed.data[di + 2] = source.data[si + 2]!;
              reconstructed.data[di + 3] = source.data[si + 3]!;
            }
          }
          const normalized = normalizeProductionRaster(
            {
              width: reconstructed.width,
              height: reconstructed.height,
              data: reconstructed.data,
            },
            input.sizing,
          );
          if (normalized.status !== "normalized") throw new Error(normalized.reason);
          const encoded = encodeProductionPng(normalized.result);
          return {
            bytes: encoded.bytes,
            contentType: "image/png" as const,
            widthPx: normalized.result.image.width,
            heightPx: normalized.result.image.height,
            hasTransparency: encoded.hasTransparency,
            nativeWidthPx: source.width,
            nativeHeightPx: source.height,
            reconstructedWidthPx: reconstructed.width,
            reconstructedHeightPx: reconstructed.height,
            resolutionProvenance: "reconstructed" as const,
            transformationMethod: "fake_bowling_reconstruction_v1",
            preservesApprovedContent: false,
            providerRequestId: "fake-bowling-1",
            normalization: normalized.result.metadata,
          };
        }
      }
      const reconstruction = new FakeReconstructionProvider();
      const worker = createFinalArtworkWorkerCapability(
        repo,
        assets,
        reconstruction,
        createPrintValidationCapability(),
      );

      const session = await acquisition.resolveOrCreateSession(null);
      await repo.grantInternalEntitlement(session.id);
      const projectId = (await repo.createProject(session.id)).project.id;

      const originalBytes = readFileSync(BOWLING_ORIGINAL);
      await preparation.uploadOriginal(projectId, {
        bytes: originalBytes,
        declaredContentType: "image/png",
        filename: "Bowling_Logo.png",
      });
      await preparation.setProductionContext(projectId, {
        productSummary: "T-shirts for our bowling team",
        productColor: "Black",
        printPlacement: "full_front",
      });
      await preparation.prepareBackground(projectId);

      const review = await preparation.getSeparationReview(projectId);
      const ids = review.regionMap.consequentialRegions.map((r) => r.regionId).sort((a, b) => a - b);
      const SUBSTRATE_IDS = new Set([1, 140]);
      await preparation.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: review.regionMap.regionMapHash,
        decisions: ids.map((regionId) => ({
          regionId,
          intent: SUBSTRATE_IDS.has(regionId) ? ("substrate" as const) : ("ink" as const),
        })),
      });
      const proposal = review.regionMap.inBoundsProposal;
      if (proposal) {
        await preparation.submitProposalDecision(projectId, {
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          proposalHash: proposal.proposalHash,
          decision: "remove_with_exceptions",
        });
      }
      await preparation.approveSeparationMaster(projectId);
      await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5 });

      // Standard Raster first (Phase 28I). Undersized → reconstructed →
      // certification withhold → finalization_required, never print_ready.
      const standard = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      await worker.processNextJob();
      const afterStandard = await repo.getProject(projectId);
      assert.equal(afterStandard!.project.status, "finalization_required");
      const standardValidation = await repo.getLatestProductionAssetValidationForJob(
        projectId,
        standard.job.id,
      );
      assert.equal(standardValidation?.status, "finalization_required");

      // Halftone remains gated until Standard Raster is genuinely print_ready.
      await conversation.selectProductionTreatment(projectId, { treatment: "halftone_dtf" });
      await assert.rejects(
        () => finalArtwork.requestPreparedUploadFinalArtwork(projectId),
        (error: unknown) =>
          error instanceof ArtworkFinalizationRasterNotReadyError &&
          /Standard Raster is Print Ready/i.test(error.message),
      );
    });
  },
);
