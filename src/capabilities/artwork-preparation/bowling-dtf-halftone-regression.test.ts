import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConversationCapability } from "@/capabilities/conversation";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import type { FinalArtworkProvider, FinalArtworkProviderOutput } from "@/capabilities/final-artwork/provider";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { PrintValidationReport } from "@/capabilities/print-validation/contracts";
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

/** A reconstruction provider that must never be reached — a halftone job never needs it. */
class ForbiddenReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "forbidden_reconstruction";
  async produce(): Promise<FinalArtworkProviderOutput> {
    throw new Error("PAID/TOPAZ RECONSTRUCTION PROVIDER WAS CALLED — the halftone path must never reach it");
  }
}

/**
 * Intelligent Separation Phase 10, Goal 10: DTF HALFTONE E2E, with UNCHANGED
 * DEFAULTS (35 LPI, 45°, round, midtone 1, choke 0), through the real
 * separation-approved bowling asset — the exact real-shape case Goal 7
 * establishes (region 1 = badge disc → Show Shirt, region 73 = banner →
 * Print Ink, region 140 = letter counter → Show Shirt).
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

    it("produces a validated, print-ready DTF halftone plate — exact LPI, correct dims, no Topaz, exterior areas carry no ink", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
      const designBrief = createDesignBriefCapability(repo);
      const preparation = createArtworkPreparationCapability(repo, assets, designBrief);
      const finalArtwork = createFinalArtworkCapability(repo);
      const acquisition = createAcquisitionCapability(repo);
      // Only `selectProductionTreatment` is exercised here, and its own
      // implementation touches exactly `repo`, `acquisition`, `finalArtwork`,
      // and `designBrief` — see `conversation-capability.ts`. The other
      // dependencies this capability normally needs (intent extraction,
      // concept generation, ...) are never reached by that one method, so a
      // narrow stub mirrors `halftone-production.test.ts`'s precedent of
      // stubbing only what a single exercised method needs.
      const conversation = createConversationCapability({
        repo,
        designBrief,
        acquisition,
        finalArtwork,
      } as never);
      const reconstruction = new ForbiddenReconstructionProvider();
      const worker = createFinalArtworkWorkerCapability(
        repo,
        assets,
        reconstruction,
        createPrintValidationCapability(),
      );

      // Print'em All Phase 2 (production treatment selection) is internal-only.
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

      // --- Operator separation review: 1 -> Show Shirt, 73 -> Print Ink, 140 -> Show Shirt, remaining -> Print Ink ---
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
      // Phase 23: this real asset also carries a unified in-bounds proposal
      // — a separate axis from the region decisions above (Phase 22B Issue
      // 2). `remove_with_exceptions` with no taps matches this test's own
      // "exterior areas carry no ink" expectation, exactly like the sibling
      // P/Q/R/S sizing test on the same asset in
      // `separation-decision-workflow.test.ts`.
      const proposal = review.regionMap.inBoundsProposal;
      if (proposal) {
        await preparation.submitProposalDecision(projectId, {
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          proposalHash: proposal.proposalHash,
          decision: "remove_with_exceptions",
        });
      }
      const approvedSeparation = await preparation.approveSeparationMaster(projectId);
      assert.equal(approvedSeparation.isProductionAuthoritative, true);

      const preparationRow = await repo.getArtworkPreparation(projectId);
      const separationMasterBytes = (await assets.downloadAssetBytes(preparationRow!.preparedAssetId!))!.bytes;

      await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5 });

      // DTF Halftone, UNCHANGED DEFAULTS — no `halftone` field means the
      // domain applies `recommendedHalftoneSettings` (35 LPI, 45°, round,
      // midtone 1, choke 0px) verbatim.
      await conversation.selectProductionTreatment(projectId, { treatment: "halftone_dtf" });
      const afterTreatment = await repo.getProject(projectId);
      assert.equal(afterTreatment!.brief.productionTreatment, "halftone_dtf");
      assert.equal(afterTreatment!.brief.halftoneSettings?.lpi, 35);
      assert.equal(afterTreatment!.brief.halftoneSettings?.angleDeg, 45);
      assert.equal(afterTreatment!.brief.halftoneSettings?.dotShape, "round");
      assert.equal(afterTreatment!.brief.halftoneSettings?.midtone, 1);
      assert.equal(afterTreatment!.brief.halftoneSettings?.chokePx, 0);

      const request = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      const { processedJobId } = await worker.processNextJob();
      assert.equal(processedJobId, request.job.id);

      const finished = await repo.getProject(projectId);
      assert.equal(finished!.project.status, "print_ready", "the halftone plate reached print_ready");

      const productionAsset = (await repo.listAssets(projectId)).find(
        (asset) => asset.finalArtworkJobId === request.job.id && asset.productionRole === "production_png",
      );
      assert.ok(productionAsset, "a production asset exists");

      // --- E: exact LPI, on an unrounded cell pitch (never quietly rounded to a different frequency) ---
      const halftoneMeta = productionAsset!.metadata.halftone as Record<string, number> | undefined;
      assert.ok(halftoneMeta, "halftone production evidence must be recorded");
      assert.ok(Math.abs(Number(halftoneMeta!.achievedLpi) - 35) < 1e-9, `expected 35 LPI, got ${halftoneMeta!.achievedLpi}`);
      assert.ok(Math.abs(Number(halftoneMeta!.cellPx) - 300 / 35) < 1e-9);

      // --- Correct dims: 10.5in at 300 PPI, tight-crop plate, never a fixed/full canvas ---
      assert.equal(productionAsset!.widthPx, 3150);
      assert.ok(productionAsset!.heightPx! > 0 && productionAsset!.heightPx! < 3300);
      assert.equal(halftoneMeta!.screenWidthPx, productionAsset!.widthPx);
      assert.equal(halftoneMeta!.screenHeightPx, productionAsset!.heightPx);

      // --- Print validation actually ran and is "ready" ---
      const validation = await repo.getLatestProductionAssetValidationForJob(projectId, request.job.id);
      const report = validation!.report as unknown as PrintValidationReport;
      assert.equal(report.status, "ready", report.blockingIssues.join("; "));

      // --- No Topaz / no paid reconstruction: the forbidden provider was never invoked ---
      // (it throws synchronously if it ever is — reaching this line is itself the proof)

      // --- Exterior / Show-Shirt areas carry no ink; Print-Ink areas are printable ---
      const plateBytes = (await assets.downloadAssetBytes(productionAsset!.id))!.bytes;
      const plate = PNG.sync.read(plateBytes);
      let opaque = 0;
      let transparent = 0;
      for (let i = 3; i < plate.data.length; i += 4) {
        if (plate.data[i] === 0) transparent += 1;
        else if (plate.data[i] === 255) opaque += 1;
      }
      assert.ok(opaque > 0, "the banner (Print Ink) must produce printable dots");
      assert.ok(transparent > 0, "the badge disc and letter counter (Show Shirt) must carry no ink at all");

      // --- The separation master, not a re-derived preparation, was the plate's source ---
      const lineage = productionAsset!.metadata.uploadedPreserve as Record<string, unknown> | undefined;
      assert.equal(lineage?.preparedAssetId, preparationRow!.preparedAssetId);
      assert.equal(
        lineage?.sourceBytesSha256,
        createHash("sha256").update(separationMasterBytes).digest("hex"),
      );
    });
  },
);
