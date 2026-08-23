import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { bowlingStyleArtwork, toPngBytes } from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";

/**
 * Intelligent Separation Phase 10, Goal 13: RELOAD / RESTART BEHAVIOR, across
 * a "dev/service restart against a persistent test store" — i.e. a FRESH
 * capability instance built against the SAME `LocalProjectRepository`, which
 * is what actually persists to disk between instances.
 *
 * `separation-decision-workflow.test.ts` ("C/D") already proves this for a
 * PARTIAL decision set. This file proves the two states that leaves open:
 * a COMPLETE-but-not-yet-approved set, and an APPROVED master.
 */
describe("Separation reload/restart — complete and approved states survive a fresh instance", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-separation-reload-"));
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

  function restart(repo: Awaited<ReturnType<typeof harness>>["repo"], assets: Awaited<ReturnType<typeof harness>>["assets"]) {
    return createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
  }

  async function seeded() {
    const { repo, assets, capability } = await harness();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    return { repo, assets, capability, projectId };
  }

  it("a COMPLETE (all regions decided) but NOT YET APPROVED set survives a fresh instance", async () => {
    const { repo, assets, capability, projectId } = await seeded();
    const review = await capability.getSeparationReview(projectId);
    await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions: review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" as const })),
    });

    const reloaded = restart(repo, assets);
    const reread = await reloaded.getSeparationReview(projectId);
    assert.equal(reread.state, "review_complete");
    assert.equal(reread.pendingRegionIds.length, 0);
    assert.equal(reread.isProductionAuthoritative, false, "complete is not the same as approved");
  });

  it("an APPROVED master survives a fresh instance, still production-authoritative", async () => {
    const { repo, assets, capability, projectId } = await seeded();
    const review = await capability.getSeparationReview(projectId);
    await capability.submitRegionDecisions(projectId, {
      sourceAssetSha256: review.regionMap.sourceAssetSha256,
      regionMapHash: review.regionMap.regionMapHash,
      decisions: review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" as const })),
    });
    const approved = await capability.approveSeparationMaster(projectId);
    assert.equal(approved.isProductionAuthoritative, true);

    const reloaded = restart(repo, assets);
    const reread = await reloaded.getSeparationReview(projectId);
    assert.equal(reread.state, "review_complete");
    assert.equal(reread.isProductionAuthoritative, true, "approval must survive a restart, not just the live instance");
    assert.equal(reread.approvedAt, approved.approvedAt);

    // The approved asset itself is still readable, byte-for-byte, after "restart".
    const preparationRow = await repo.getArtworkPreparation(projectId);
    const downloaded = await assets.downloadAssetBytes(preparationRow!.preparedAssetId!);
    assert.ok(downloaded, "the approved master asset must still be readable after a restart");
  });
});
