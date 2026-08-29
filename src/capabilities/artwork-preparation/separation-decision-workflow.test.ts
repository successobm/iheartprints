import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { normalizeProductionRaster } from "@/capabilities/final-artwork/production-normalization";
import { applyHalftoneScreen } from "@/capabilities/final-artwork/halftone-screen";
import { sizingPolicyForProductionBox } from "@/capabilities/shared/garment-production-sizing";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import { recommendedHalftoneSettings } from "@/capabilities/shared/production-treatment";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createArtworkPreparationCapability } from "./artwork-preparation-capability";
import { bowlingStyleArtwork, solidBlackExteriorArtwork, toPngBytes } from "./artwork-fixtures";

// Resolved BEFORE any test in this file chdir's into a temp workspace.
const ROOT = process.cwd();
const BOWLING_ORIGINAL = path.resolve(
  process.cwd(),
  ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png",
);
const hasBowling = existsSync(BOWLING_ORIGINAL);

describe("Intelligent Separation Phase 9 — operator decision workflow", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-separation-workflow-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function harness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    return { repo, assets, capability };
  }

  async function seeded(bytes: Buffer, productColor = "Black") {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, { bytes, declaredContentType: "image/png", filename: "artwork.png" });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor,
      printPlacement: "full_front",
    });
    return { repo, assets, capability, projectId };
  }

  // -------------------------------------------------------------------
  // A/B: consequential-region detection
  // -------------------------------------------------------------------

  it("A: easy artwork requires no region review", async () => {
    const { capability, projectId } = await seeded(toPngBytes(solidBlackExteriorArtwork()));
    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.state, "review_not_required");
    assert.equal(review.regionMap.consequentialRegions.length, 0);
  });

  it("B: bowling-style artwork surfaces consequential regions", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    assert.notEqual(review.state, "review_not_required");
    assert.ok(review.regionMap.consequentialRegions.length > 0);
  });

  // -------------------------------------------------------------------
  // C/D: persistence + reload
  // -------------------------------------------------------------------

  it("C/D: decisions persist and reload identically from a fresh capability instance", async () => {
    const { repo, assets, projectId, capability } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    const regionId = review.regionMap.consequentialRegions[0]!.regionId;

    await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions: [{ regionId, intent: "substrate" }],
    });

    // Fresh capability instance, same repo — simulates a dev restart / reload.
    const reloadedCapability = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    const reloaded = await reloadedCapability.getSeparationReview(projectId);
    const decided = reloaded.decisions.find((d) => d.regionId === regionId);
    assert.ok(decided, "the decision must survive reload");
    assert.equal(decided!.intent, "substrate");
    assert.equal(decided!.source, "operator");
  });

  // -------------------------------------------------------------------
  // E/F/G: stale + invalid writes
  // -------------------------------------------------------------------

  it("E: a stale sourceAssetSha256 is rejected", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    await assert.rejects(() =>
      capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: "not-the-real-sha",
        regionMapHash: review.regionMap.regionMapHash,
        decisions: [{ regionId: review.regionMap.consequentialRegions[0]!.regionId, intent: "ink" }],
      }),
    );
  });

  it("F: a stale regionMapHash is rejected", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    await assert.rejects(() =>
      capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: "not-the-real-hash",
        decisions: [{ regionId: review.regionMap.consequentialRegions[0]!.regionId, intent: "ink" }],
      }),
    );
  });

  it("G: an unknown region id is rejected", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    await assert.rejects(() =>
      capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: review.regionMap.regionMapHash,
        decisions: [{ regionId: 999999999, intent: "ink" }],
      }),
    );
  });

  it("a rejected write applies NOTHING — not even the valid entries in the same batch", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    const validId = review.regionMap.consequentialRegions[0]!.regionId;
    await assert.rejects(() =>
      capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: review.regionMap.regionMapHash,
        decisions: [
          { regionId: validId, intent: "ink" },
          { regionId: 999999999, intent: "ink" },
        ],
      }),
    );
    const after = await capability.getSeparationReview(projectId);
    assert.equal(after.decisions.length, 0, "no partial write must have landed");
  });

  // -------------------------------------------------------------------
  // K/L/M: completeness gates approval
  // -------------------------------------------------------------------

  it("K/L: an unresolved (uncertain) consequential region blocks approval", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    const decisions = review.regionMap.consequentialRegions.map((r, i) => ({
      regionId: r.regionId,
      intent: i === 0 ? ("uncertain" as const) : ("ink" as const),
    }));
    await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions,
    });
    await assert.rejects(() => capability.approveSeparationMaster(projectId));
  });

  it("L: a completely undecided consequential region blocks approval", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    await assert.rejects(() => capability.approveSeparationMaster(projectId));
  });

  it("M: final approval is a separate, explicit action — deciding everything does not auto-approve", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    const decisions = review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" as const }));
    let afterDecisions = await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions,
    });
    // Phase 23: this fixture also carries a unified in-bounds proposal —
    // resolving it explicitly is a second, separate axis from region
    // decisions (Phase 22B Issue 2), so `review_complete` needs both here.
    if (review.regionMap.inBoundsProposal) {
      afterDecisions = await capability.submitProposalDecision(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        proposalHash: review.regionMap.inBoundsProposal.proposalHash,
        decision: "preserve_all",
      });
    }
    assert.equal(afterDecisions.state, "review_complete");
    assert.equal(afterDecisions.isProductionAuthoritative, false);
    assert.equal(afterDecisions.approvedAt, null);
  });

  // -------------------------------------------------------------------
  // N: changing a decision invalidates prior approval
  // -------------------------------------------------------------------

  it("N: changing a decision after approval clears production authority", async () => {
    const { capability, projectId } = await seeded(toPngBytes(bowlingStyleArtwork()));
    const review = await capability.getSeparationReview(projectId);
    const decisions = review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" as const }));
    await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions,
    });
    if (review.regionMap.inBoundsProposal) {
      await capability.submitProposalDecision(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        proposalHash: review.regionMap.inBoundsProposal.proposalHash,
        decision: "preserve_all",
      });
    }
    const approved = await capability.approveSeparationMaster(projectId);
    assert.equal(approved.isProductionAuthoritative, true);

    const flip = review.regionMap.consequentialRegions[0]!.regionId;
    const afterChange = await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions: [{ regionId: flip, intent: "substrate" }],
    });
    assert.equal(afterChange.approvedAt, null);
    assert.equal(afterChange.isProductionAuthoritative, false);
  });

  // -------------------------------------------------------------------
  // U: internal-only — the underlying gate a public caller would hit
  // -------------------------------------------------------------------

  it("U: isInternalProject is false for an ordinary project with no internal grant — the exact gate every separation route checks first", async () => {
    const { repo, projectId } = await seeded(toPngBytes(solidBlackExteriorArtwork()));
    const acquisition = createAcquisitionCapability(repo);
    assert.equal(await acquisition.isInternalProject(projectId), false);
  });

  it("U (Phase 28K CORRECTION): every separation route source calls isAuthorizedForArtworkCorrection before any capability read/write", () => {
    // Phase 28K widened the gate from staff-only (`isInternalProject` alone)
    // to "internal staff OR this project's own owner" -- see
    // `isAuthorizedForArtworkCorrection`'s doc comment for the full audit.
    // The routes no longer reference `isInternalProject` directly; that
    // check now lives inside the shared predicate they all call first.
    const root = path.join(ROOT, "src", "app", "api", "projects", "[projectId]", "artwork-preparation", "separation");
    for (const file of [
      "route.ts",
      path.join("decisions", "route.ts"),
      path.join("approve", "route.ts"),
      path.join("image", "route.ts"),
    ]) {
      const source = readFileSync(path.join(root, file), "utf8");
      assert.match(source, /isAuthorizedForArtworkCorrection/, `${file} must gate via isAuthorizedForArtworkCorrection`);
      const gateIndex = source.indexOf("isAuthorizedForArtworkCorrection(graph");
      const firstCapabilityCall = source.indexOf("artworkPreparation.");
      if (firstCapabilityCall >= 0) {
        assert.ok(gateIndex < firstCapabilityCall, `${file} must check the gate before calling into the capability`);
      }
    }
  });

  it("U (Phase 28K): the shared predicate itself still checks isInternalProject as one of its two authorized paths", () => {
    const source = readFileSync(
      path.join(ROOT, "src", "capabilities", "artwork-preparation", "artwork-correction-authorization.ts"),
      "utf8",
    );
    assert.match(source, /isInternalProject/, "internal staff access must remain one of the two authorized paths");
  });

  // -------------------------------------------------------------------
  // W/X: no provider calls anywhere on this path
  // -------------------------------------------------------------------

  it("W/X: no OpenAI/Topaz reference anywhere in the separation capability or routes", () => {
    const files = [
      path.join(ROOT, "src/capabilities/artwork-preparation/region-separation.ts"),
      path.join(ROOT, "src/capabilities/artwork-preparation/separation-review.ts"),
      path.join(ROOT, "src/app/api/projects/[projectId]/artwork-preparation/separation/route.ts"),
      path.join(ROOT, "src/app/api/projects/[projectId]/artwork-preparation/separation/decisions/route.ts"),
      path.join(ROOT, "src/app/api/projects/[projectId]/artwork-preparation/separation/approve/route.ts"),
      path.join(ROOT, "src/app/api/projects/[projectId]/artwork-preparation/separation/image/route.ts"),
    ];
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      for (const forbidden of [/openai/i, /topaz/i, /stripe/i]) {
        assert.doesNotMatch(source, forbidden, `${f} must not reference ${forbidden}`);
      }
    }
  });

  // -------------------------------------------------------------------
  // P/Q/R/S: production compatibility, real bowling asset
  // -------------------------------------------------------------------

  describe("Production compatibility (real bowling asset)", { skip: !hasBowling }, () => {
    it("P/Q/R/S: sizes correctly at 10.5in and 12in, and screens through the unmodified halftone engine", async () => {
      const bytes = readFileSync(BOWLING_ORIGINAL);
      const { capability, projectId, repo, assets } = await seeded(bytes, "Black");

      const review = await capability.getSeparationReview(projectId);
      const decisions: Array<{ regionId: number; intent: "substrate" | "ink" }> = review.regionMap.consequentialRegions.map(
        (r) => ({
          regionId: r.regionId,
          intent: r.regionId === 1 || r.regionId === 140 ? "substrate" : "ink",
        }),
      );
      await capability.submitRegionDecisions(projectId, {
        sourceAssetSha256: review.regionMap.sourceAssetSha256,
        regionMapHash: review.regionMap.regionMapHash,
        decisions,
      });
      if (review.regionMap.inBoundsProposal) {
        // `remove_with_exceptions` with no taps — matching the pre-Phase-23
        // unconditional exterior-removal default exactly — since this
        // test's own pixel assumption ("the exterior corner of the trimmed,
        // screened output carries zero ink") was written against that
        // removal behavior. `preserve_all` would retain this real asset's
        // own in-bounds proposal area (a Phase-17-style near-corner defect
        // this specific bowling logo also has), which is correct new
        // behavior but not what this sizing/halftone test measures.
        await capability.submitProposalDecision(projectId, {
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          proposalHash: review.regionMap.inBoundsProposal.proposalHash,
          decision: "remove_with_exceptions",
        });
      }
      const approved = await capability.approveSeparationMaster(projectId);
      assert.equal(approved.state, "review_complete");
      assert.equal(approved.isProductionAuthoritative, true);

      const prep = await repo.getArtworkPreparation(projectId);
      assert.equal(prep!.status, "approved");
      const masterBytes = (await assets.downloadAssetBytes(prep!.preparedAssetId!))!.bytes;
      const { PNG } = await import("pngjs");
      const master = PNG.sync.read(masterBytes);
      const image = { width: master.width, height: master.height, data: Buffer.from(master.data) };

      const settings = recommendedHalftoneSettings({ label: "Black", hex: "#000000", rgb: { r: 0, g: 0, b: 0 } });
      for (const widthIn of [10.5, 12]) {
        const policy = sizingPolicyForProductionBox(
          PRINT_PLACEMENT_SIZING_POLICY.full_front,
          widthIn,
          null,
        );
        const norm = normalizeProductionRaster(image, policy);
        assert.equal(norm.status, "normalized");
        if (norm.status !== "normalized") continue;
        // Sizing uses the SEPARATED artwork's own visible bounds, never the
        // full 979x1024 canvas.
        assert.notEqual(norm.result.metadata.alphaBBoxWidthPx, 979);
        assert.ok(
          Math.abs(norm.result.metadata.outputAspectRatio - norm.result.metadata.trimmedAspectRatio) < 0.001,
        );

        const screened = applyHalftoneScreen(norm.result.image, settings, norm.result.metadata.targetPpi);
        assert.equal(Math.round(screened.metadata.achievedLpi), 35);
        assert.equal(screened.metadata.screenWidthPx, norm.result.metadata.outputWidthPx);
        assert.equal(screened.metadata.screenHeightPx, norm.result.metadata.outputHeightPx);

        // Exterior corner: no ink.
        let cornerInk = 0;
        for (let y = 0; y < 200; y += 1) {
          for (let x = 0; x < 200; x += 1) {
            if (screened.image.data[(y * screened.image.width + x) * 4 + 3]! > 0) cornerInk += 1;
          }
        }
        assert.equal(cornerInk, 0, `exterior corner must carry zero ink at ${widthIn}in`);
      }
    });

    it("T (regression, diff-based): the Topaz provider and reconstruction ceiling are untouched by this feature", () => {
      // Structural: this feature never imports the Topaz provider at all.
      const source = readFileSync(
        path.join(ROOT, "src/capabilities/artwork-preparation/artwork-preparation-capability.ts"),
        "utf8",
      );
      assert.doesNotMatch(source, /topaz/i);
    });
  });

  // -------------------------------------------------------------------
  // Goal 20: easy artwork is unaffected
  // -------------------------------------------------------------------

  it("easy artwork: prepareBackground + approvePreparedArtwork behave exactly as before, untouched by this feature", async () => {
    const { capability, projectId } = await seeded(toPngBytes(solidBlackExteriorArtwork()));
    const prepared = await capability.prepareBackground(projectId);
    assert.equal(prepared.hasPreparedArtwork, true);
    const approved = await capability.approvePreparedArtwork(projectId);
    assert.equal(approved.approved, true);
    // No separation review was ever needed for this artwork.
    const review = await capability.getSeparationReview(projectId);
    assert.equal(review.state, "review_not_required");
  });
});
