import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { compositeOverGarment } from "@/capabilities/final-artwork/halftone-screen";
import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { VISIBLE_ALPHA_THRESHOLD } from "./pixel-metrics";

// Resolved BEFORE any test in this file chdir's into a temp workspace.
const ROOT = process.cwd();
const BOWLING_ORIGINAL = path.resolve(
  ROOT,
  ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png",
);
const hasBowling = existsSync(BOWLING_ORIGINAL);

/**
 * Intelligent Separation Phase 10, Goal 7: BOWLING LIVE-SHAPE UI ACCEPTANCE.
 *
 * `region-separation.test.ts`'s "O" test already proved these pixel
 * properties against the raw `computeRegionMap`/`buildSeparationMaster`
 * functions directly. This file proves the same outcome through the
 * OPERATOR-FACING SURFACE instead — `getSeparationReview` →
 * `submitRegionDecisions` → `approveSeparationMaster`, the exact sequence
 * `SeparationReviewPanel` drives — and then re-derives every pixel property
 * from the APPROVED ASSET'S OWN ENCODED PNG BYTES (downloaded and re-decoded,
 * not read from the in-memory master), so a PNG encode/decode defect could
 * not hide behind an in-memory-only proof.
 *
 * ISOLATION (explicit constraint): every project here is a fresh
 * `LocalProjectRepository` in a throwaway temp directory. This never reads,
 * writes, or references the live project `563b1ef4-1525-455b-ba81-9a21105a2b9c`.
 */
describe(
  "Bowling live-shape UI acceptance — the real asset, through the operator-facing surface",
  { skip: !hasBowling },
  () => {
    let tempDir = "";
    let previousCwd = "";

    before(() => {
      previousCwd = process.cwd();
      tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bowling-live-shape-ui-"));
      process.chdir(tempDir);
    });

    after(async () => {
      await cleanupTempWorkspace(tempDir, previousCwd);
    });

    async function approvedBowling(productColor: string) {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
      const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));

      const projectId = (await repo.createProject()).project.id;
      const originalBytes = readFileSync(BOWLING_ORIGINAL);
      assert.equal(
        createHash("sha256").update(originalBytes).digest("hex"),
        "99ee94fcc89884415e7188d8bc06f804cc5222ec4652fb68ee75c0e0a080afa5",
        "the fixture on disk must be the exact audited file every other bowling test pins",
      );

      await capability.uploadOriginal(projectId, {
        bytes: originalBytes,
        declaredContentType: "image/png",
        filename: "Bowling_Logo.png",
      });
      await capability.setProductionContext(projectId, {
        productSummary: "T-shirts for our bowling team",
        productColor,
        printPlacement: "full_front",
      });
      await capability.prepareBackground(projectId);

      // What an operator sees first, through GET .../separation.
      const review = await capability.getSeparationReview(projectId);
      const ids = review.regionMap.consequentialRegions.map((r) => r.regionId).sort((a, b) => a - b);

      // Region 1 → Show Shirt, 73 → Print Ink, 140 → Show Shirt, remaining → Print Ink.
      const SUBSTRATE_IDS = new Set([1, 140]);
      let submitted = await capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: review.regionMap.regionMapHash,
        decisions: ids.map((regionId) => ({
          regionId,
          intent: SUBSTRATE_IDS.has(regionId) ? ("substrate" as const) : ("ink" as const),
        })),
      });

      // Phase 23: this real asset now also carries a unified in-bounds
      // proposal — a SEPARATE axis from the region decisions above (Phase
      // 22B Issue 2), so `review_complete` is only reached once it too is
      // explicitly resolved. `preserve_all` leaves every pixel this file
      // already asserts on (badge, banner, letter counter, tagline, finger
      // holes) exactly as this suite has always expected. `submitted` is
      // re-pointed at this call's response so "reaches review_complete"
      // reflects the FINAL state of both axes, not just the region axis.
      if (review.regionMap.inBoundsProposal) {
        submitted = await capability.submitProposalDecision(projectId, {
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          proposalHash: review.regionMap.inBoundsProposal.proposalHash,
          decision: "preserve_all",
        });
      }

      const approved = await capability.approveSeparationMaster(projectId);
      const preparation = await repo.getArtworkPreparation(projectId);
      const approvedAssetId = preparation!.preparedAssetId!;
      const downloaded = await assets.downloadAssetBytes(approvedAssetId);
      const approvedImage = decodePngUpload(downloaded!.bytes).image;

      return { review, submitted, approved, approvedImage, originalImage: decodePngUpload(originalBytes).image, ids };
    }

    it("region 1 (badge), 73 (banner), and 140 (letter counter) are exactly the consequential regions an operator is asked about", async () => {
      const { ids } = await approvedBowling("Black");
      assert.ok(ids.includes(1) && ids.includes(73) && ids.includes(140));
      // The full, exact set — a changed count here is a real change in what
      // the operator is asked to decide, not a rounding difference.
      assert.deepEqual(ids, [1, 57, 58, 67, 73, 82, 106, 115, 127, 140, 141]);
    });

    it("submitting decisions through the capability reaches review_complete, and approval is production-authoritative", async () => {
      const { submitted, approved } = await approvedBowling("Black");
      assert.equal(submitted.state, "review_complete");
      assert.equal(submitted.pendingRegionIds.length, 0);
      assert.equal(approved.state, "review_complete");
      assert.equal(approved.isProductionAuthoritative, true);
    });

    it("the APPROVED ASSET'S OWN PNG BYTES show the badge disc (region 1) fully transparent", async () => {
      const { approved, approvedImage } = await approvedBowling("Black");
      // Re-derive region membership independently from the approved asset's
      // lineage rather than trusting the in-memory computation — the
      // lineage IS the region map this decision set was made against.
      const lineageDecisions = (approved.decisions ?? []) as Array<{ regionId: number; intent: string }>;
      assert.ok(lineageDecisions.some((d) => d.regionId === 1 && d.intent === "substrate"));

      const { computeRegionMap } = await import("./region-separation");
      const originalBytes = readFileSync(BOWLING_ORIGINAL);
      const decoded = decodePngUpload(originalBytes);
      const { analyzeArtwork } = await import("./image-analysis");
      const analysis = analyzeArtwork({
        image: decoded.image,
        format: "image/png",
        byteSize: originalBytes.length,
        declaresAlphaChannel: decoded.header.declaresAlphaChannel,
        printPlacement: "full_front",
        intendedPrintWidthIn: 10.5,
      });
      const computation = computeRegionMap(
        decoded.image,
        "bowling-sha",
        analysis.estimatedBackgroundColor,
        analysis.backgroundTolerance,
      );

      let discCleared = 0;
      let discTotal = 0;
      for (let i = 0; i < computation.label.length; i += 1) {
        if (computation.label[i] !== 1) continue;
        discTotal += 1;
        if (approvedImage.data[i * 4 + 3] === 0) discCleared += 1;
      }
      assert.equal(discCleared, discTotal, "the badge disc must be fully transparent in the APPROVED PNG bytes");

      // The letter counter (region 140) likewise.
      let counterCleared = 0;
      let counterTotal = 0;
      for (let i = 0; i < computation.label.length; i += 1) {
        if (computation.label[i] !== 140) continue;
        counterTotal += 1;
        if (approvedImage.data[i * 4 + 3] === 0) counterCleared += 1;
      }
      assert.equal(counterCleared, counterTotal, "the letter counter must be fully transparent in the APPROVED PNG bytes");
    });

    it("the banner (region 73) and every remaining region keep their exact original RGB — printable ink, byte for byte", async () => {
      const { approvedImage, originalImage } = await approvedBowling("Black");

      const { computeRegionMap } = await import("./region-separation");
      const originalBytes = readFileSync(BOWLING_ORIGINAL);
      const decoded = decodePngUpload(originalBytes);
      const { analyzeArtwork } = await import("./image-analysis");
      const analysis = analyzeArtwork({
        image: decoded.image,
        format: "image/png",
        byteSize: originalBytes.length,
        declaresAlphaChannel: decoded.header.declaresAlphaChannel,
        printPlacement: "full_front",
        intendedPrintWidthIn: 10.5,
      });
      const computation = computeRegionMap(
        decoded.image,
        "bowling-sha",
        analysis.estimatedBackgroundColor,
        analysis.backgroundTolerance,
      );

      const INK_INTENT_IDS = new Set([57, 58, 67, 73, 82, 106, 115, 127, 141]);
      let bannerKept = 0;
      let bannerTotal = 0;
      let rgbMismatches = 0;
      for (let i = 0; i < computation.label.length; i += 1) {
        const label = computation.label[i]!;
        if (!INK_INTENT_IDS.has(label)) continue;
        if (label === 73) {
          bannerTotal += 1;
          if (approvedImage.data[i * 4 + 3]! >= VISIBLE_ALPHA_THRESHOLD) bannerKept += 1;
        }
        const o = i * 4;
        if (
          approvedImage.data[o] !== originalImage.data[o] ||
          approvedImage.data[o + 1] !== originalImage.data[o + 1] ||
          approvedImage.data[o + 2] !== originalImage.data[o + 2]
        ) {
          rgbMismatches += 1;
        }
      }
      assert.equal(bannerKept, bannerTotal, "the banner (region 73) must be fully retained");
      assert.equal(rgbMismatches, 0, "every ink-intent region must keep the customer's exact original RGB — never re-coloured");
    });

    it("finger holes and every non-consequential ink pixel (the tagline) survive — global RGB-preservation guarantee", async () => {
      const { approved } = await approvedBowling("Black");
      // `postCheck.rgbPreserved` is a WHOLE-IMAGE guarantee, not scoped to
      // the 11 regions an operator was asked about — it is exactly what
      // makes "the tagline is untouched" true without needing its own
      // region id (the tagline was never consequential; the automatic pass
      // already resolved it before separation review ever ran).
      assert.equal(approved.postCheck?.rgbPreserved, true);
      assert.equal(approved.postCheck?.noAlphaRaised, true);
      assert.equal(approved.postCheck?.passed, true);
    });

    it("Goal 15: the orphan warning is surfaced, honest, and never a hard block", async () => {
      const { approved } = await approvedBowling("Black");
      // The badge disc sitting behind light ink is exactly the geometry that
      // produces this warning — it must be reported, not hidden, and it must
      // never gate approval (which already succeeded above).
      assert.ok((approved.postCheck?.orphanedLightInkPixels ?? 0) > 0);
      assert.equal(approved.postCheck?.passed, true);
      assert.ok(
        approved.postCheck?.reasons.some((r) => /light garment/i.test(r)),
        "the reason must be stated in plain, honest language — never called safe",
      );
    });

    it("the SAME approved master renders correctly across 4 different garment colours — one asset, four previews", async () => {
      const { approvedImage } = await approvedBowling("Black");
      const garments = ["#000000", "#FFFFFF", "#B22234", "#C8C8C8"]
        .map((hex) => resolveGarmentColor(hex))
        .filter((g): g is NonNullable<typeof g> => g !== null);
      assert.equal(garments.length, 4);

      const composites = garments.map((g) => compositeOverGarment(approvedImage, g));

      // Wherever the SAME master is fully opaque (ink), every composite must
      // carry the IDENTICAL RGB regardless of which garment it was
      // composited over — proving one canonical master drives all four
      // previews rather than four independently regenerated images.
      let inkPixelsChecked = 0;
      for (let i = 0; i < approvedImage.data.length; i += 4) {
        if (approvedImage.data[i + 3] !== 255) continue;
        inkPixelsChecked += 1;
        const [r0, g0, b0] = [composites[0]!.data[i], composites[0]!.data[i + 1], composites[0]!.data[i + 2]];
        for (const composite of composites.slice(1)) {
          assert.equal(composite.data[i], r0, "ink RGB must be garment-invariant");
          assert.equal(composite.data[i + 1], g0);
          assert.equal(composite.data[i + 2], b0);
        }
      }
      assert.ok(inkPixelsChecked > 0, "the master must actually have opaque ink pixels to check");

      // Wherever the master is fully transparent (the badge disc, Show
      // Shirt), each composite must instead show that garment's own colour.
      const [black, white, red, gray] = composites;
      const substrateSampleIndex = (() => {
        for (let i = 0; i < approvedImage.data.length; i += 4) {
          if (approvedImage.data[i + 3] === 0) return i;
        }
        throw new Error("expected at least one fully transparent (Show Shirt) pixel");
      })();
      assert.deepEqual(
        [black!.data[substrateSampleIndex], black!.data[substrateSampleIndex + 1], black!.data[substrateSampleIndex + 2]],
        [0, 0, 0],
      );
      assert.deepEqual(
        [white!.data[substrateSampleIndex], white!.data[substrateSampleIndex + 1], white!.data[substrateSampleIndex + 2]],
        [255, 255, 255],
      );
      assert.notDeepEqual(
        [red!.data[substrateSampleIndex], red!.data[substrateSampleIndex + 1], red!.data[substrateSampleIndex + 2]],
        [black!.data[substrateSampleIndex], black!.data[substrateSampleIndex + 1], black!.data[substrateSampleIndex + 2]],
      );
      assert.notDeepEqual(
        [gray!.data[substrateSampleIndex], gray!.data[substrateSampleIndex + 1], gray!.data[substrateSampleIndex + 2]],
        [white!.data[substrateSampleIndex], white!.data[substrateSampleIndex + 1], white!.data[substrateSampleIndex + 2]],
      );
    });
  },
);
