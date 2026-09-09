/**
 * Signs Dimension-Driven Artwork Preparation: capability-level regression
 * coverage proving the product-type gate is genuinely gone (never just the
 * pure policy function) and that the REAL customer case — 2172x724 source
 * artwork, requested 84x24in — reaches the SAME existing intelligent
 * repair/canvas-extension decision tree every other Signs order does,
 * with no substrate/product-category question anywhere in the sequence.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createSignPreparationCapability, SignPreparationStateError } from "./sign-preparation-capability";
import { fillRect, makeImage, ruthLikeSignArtwork, toPngBytes } from "./sign-fixtures";
import { RIGID_RECT_UP_TO_24X36_V1, BANNER_RECT_UP_TO_36X96_V1 } from "./resolution-policy";

/**
 * Reproduces the REAL customer case's geometric/repairability CLASS —
 * 2172x724px (3:1), busy/complex content reaching fully to the left AND
 * right edges (foreground bleed on both), a comparatively clean top and
 * bottom — WITHOUT using the customer's own pixels (the bowling/Ruth
 * fixture precedent: a real order's own file is never committed).
 * Requesting 84x24in (3.5:1) against this source requires horizontal
 * extension exactly like the real case.
 */
function customerShapedWideBannerArtwork(width = 2172, height = 724) {
  const image = makeImage(width, height, { r: 245, g: 245, b: 247 });
  // Busy content spanning the full width, touching x=0 and x=width-1 on
  // both edges — genuine foreground bleed, not a safely-paddable margin.
  const bandTop = Math.round(height * 0.2);
  const bandBottom = Math.round(height * 0.8);
  for (let y = bandTop; y < bandBottom; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      image.data[i] = (x * 41 + y * 89) % 256;
      image.data[i + 1] = (x * 67 + y * 23) % 256;
      image.data[i + 2] = (x * 11 + y * 173) % 256;
      image.data[i + 3] = 255;
    }
  }
  // A clean, uniform footer band — plausible real-world composition,
  // deliberately left safely paddable so the fixture isn't ambiguous on
  // every axis at once.
  fillRect(image, 0, height - 24, width, height, { r: 245, g: 245, b: 247 });
  return image;
}

describe("Signs Dimension-Driven Artwork Preparation: capability-level regression", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-signs-dimension-driven-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const capability = createSignPreparationCapability(repo, assets);
    const project = await repo.createProject();
    return { repo, assets, capability, projectId: project.project.id };
  }

  it("1/3: THE REAL CUSTOMER CASE — 2172x724 source, requested 84x24 — accepted as a valid Signs request, no product-type question, reaches the existing repair-planning decision tree", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(customerShapedWideBannerArtwork()),
      declaredContentType: "image/png",
      filename: "wide-banner-artwork.png",
    });

    // No production-type step exists any more — size confirmation is the
    // very next (and only) question, and it succeeds.
    const confirmed = await capability.confirmSignProductionSpec(projectId, 84, 24);
    assert.equal(confirmed.orderedWidthIn, 84);
    assert.equal(confirmed.orderedHeightIn, 24);
    assert.ok(confirmed.specConfirmedAt);
    assert.equal(confirmed.resolutionPolicyId, "signs_dimension_driven:v1");

    // The planner is reached — its own repairability decision tree (never
    // a product-type gate) decides what happens next. Whatever it decides,
    // it must be a REAL decision from REAL evidence, not a refusal for
    // being the "wrong" product type.
    const outcome = await capability.planSignRepair(projectId);
    assert.notEqual(outcome.result.status, undefined);
    if (outcome.result.status === "blocked") {
      // A genuine repairability escalation is an honest, legitimate
      // outcome (Constitution §16A.3: ambiguous/complex content routes to
      // review, never a destructive guess) — assert it is NOT a product-
      // type/size-envelope defect.
      assert.ok(!outcome.result.defects.includes("resolution_policy" as never));
    } else {
      // A formulated plan (auto_safe or review_required) — either is a
      // legitimate, real decision from the existing intelligent repair
      // engine, reached without ever asking "Rigid Sign or Banner?".
      assert.ok(outcome.result.plan);
      assert.equal(outcome.result.plan!.expectedOutputWidthPx / outcome.result.plan!.expectedOutputHeightPx > 3, true, "the plan's own canvas must be the ordered 3.5:1 shape, not the source's 3:1");
    }

    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.orderedWidthIn, 84);
    assert.equal(persisted!.orderedHeightIn, 24);
  });

  it("2: 84x24 Rigid-labelled and 84x24 Banner-labelled legacy production_type values behave IDENTICALLY now — the field has no decision authority left", async () => {
    const outcomes: string[] = [];
    for (const legacyProductionType of ["rigid_sign_raster", "banner_raster", null] as const) {
      const { repo, capability, projectId } = await build();
      await capability.uploadSignArtwork(projectId, {
        bytes: toPngBytes(customerShapedWideBannerArtwork()),
        declaredContentType: "image/png",
        filename: "wide-banner-artwork.png",
      });
      // Directly seed the legacy field, exactly as an old/current row
      // might carry it — confirmSignProductionSpec must never read it.
      const preparation = (await repo.getSignPreparation(projectId))!;
      await repo.updateSignPreparation(preparation.id, {
        productionType: legacyProductionType,
      });
      const confirmed = await capability.confirmSignProductionSpec(projectId, 84, 24);
      outcomes.push(`${confirmed.resolutionPolicyId}:${confirmed.orderedWidthIn}x${confirmed.orderedHeightIn}`);
    }
    assert.equal(outcomes[0], outcomes[1]);
    assert.equal(outcomes[1], outcomes[2]);
  });

  it("5: an EXISTING preparation with the legacy rigid_sign_raster resolutionPolicyId still loads and re-plans correctly (backward compatibility, no migration)", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });
    const preparation = (await repo.getSignPreparation(projectId))!;
    // Simulate an already-existing pre-refactor row, stamped under the
    // legacy rigid policy — never produced by new code, but must still load.
    await repo.updateSignPreparation(preparation.id, {
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      specConfirmedAt: new Date().toISOString(),
      resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
      productionType: "rigid_sign_raster",
      productionTypeConfirmedAt: new Date().toISOString(),
    });
    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    // The legacy row's own fixed 150 PPI target — unchanged, proving byte-
    // for-byte continuity for an already-existing rigid sign.
    assert.ok(Math.abs(outcome.result.plan!.expectedEffectivePpi - 153) < 0.01);
  });

  it("6: an EXISTING preparation with the legacy banner_raster resolutionPolicyId still loads and re-plans correctly (backward compatibility, no migration)", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(customerShapedWideBannerArtwork()),
      declaredContentType: "image/png",
      filename: "wide-banner-artwork.png",
    });
    const preparation = (await repo.getSignPreparation(projectId))!;
    await repo.updateSignPreparation(preparation.id, {
      orderedWidthIn: 84,
      orderedHeightIn: 24,
      specConfirmedAt: new Date().toISOString(),
      resolutionPolicyId: BANNER_RECT_UP_TO_36X96_V1.id,
      productionType: "banner_raster",
      productionTypeConfirmedAt: new Date().toISOString(),
    });
    const outcome = await capability.planSignRepair(projectId);
    // Whatever the real decision (planned or blocked), it must be reached
    // — never refused purely for the legacy banner policy id being
    // "unrecognized".
    assert.notEqual(
      outcome.result.status === "blocked" &&
        outcome.result.defects.includes("resolution_policy" as never),
      true,
    );
  });

  it("7: production_type_confirmed_at being null never blocks Signs preparation — it was never authority to begin with", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });
    const preparation = (await repo.getSignPreparation(projectId))!;
    assert.equal(preparation.productionTypeConfirmedAt, null);
    // Confirms immediately, with no prerequisite step in between.
    const confirmed = await capability.confirmSignProductionSpec(projectId, 18, 24);
    assert.ok(confirmed.specConfirmedAt);
  });

  it("10: dimension changes invalidate a stale plan/acceptance — unaffected by this refactor, still authoritative", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });
    await capability.confirmSignProductionSpec(projectId, 18, 24);
    const firstPlan = await capability.planSignRepair(projectId);
    assert.equal(firstPlan.result.status, "planned");
    const firstPlanKey = firstPlan.result.plan!.planKey;

    // A genuine dimension change re-confirms and must produce a DIFFERENT plan key.
    await capability.confirmSignProductionSpec(projectId, 20, 24);
    const secondPlan = await capability.planSignRepair(projectId);
    assert.equal(secondPlan.result.status, "planned");
    assert.notEqual(secondPlan.result.plan!.planKey, firstPlanKey);

    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.planKey, secondPlan.result.plan!.planKey);
  });

  it("no legacy production-type capability method exists any more — nothing in this codebase writes a new value to it", async () => {
    const { capability } = await build();
    assert.equal((capability as unknown as Record<string, unknown>).setSignProductionType, undefined);
  });

  it("an unsupported (too-large) requested size still fails closed under the new dimension-driven authority — for an honest technical reason, not a product label", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });
    await assert.rejects(
      capability.confirmSignProductionSpec(projectId, 200, 100),
      SignPreparationStateError,
    );
  });
});
