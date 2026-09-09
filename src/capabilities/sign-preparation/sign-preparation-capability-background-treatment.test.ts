/**
 * Constitution amendment 3.2 (§16A.2): end-to-end capability-level coverage
 * for the KEEP/REMOVE background treatment — real local repository, real
 * asset storage, no mocks (mirrors `sign-preparation-capability.test.ts`'s
 * own harness exactly; there is no provider of any kind to mock either
 * way).
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
import { computeSignPlanKey } from "./sign-plan-identity";
import type { SignRepairPlan } from "./contracts";
import { fillRect, makeImage, toPngBytes } from "./sign-fixtures";

describe("SignPreparationCapability: Constitution amendment 3.2 background treatment", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-bg-treatment-"));
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

  /** White exterior, distinct opaque subject — a safe, unambiguous REMOVE case. */
  function whiteExteriorSignArtwork(width = 1200, height = 800) {
    const image = makeImage(width, height, { r: 255, g: 255, b: 255 });
    fillRect(image, Math.round(width * 0.2), Math.round(height * 0.2), Math.round(width * 0.8), Math.round(height * 0.8), {
      r: 20,
      g: 40,
      b: 120,
    });
    return image;
  }

  async function uploadAndConfirm(capability: Awaited<ReturnType<typeof build>>["capability"], projectId: string, bytes: Buffer) {
    await capability.uploadSignArtwork(projectId, {
      bytes,
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    return capability.confirmSignProductionSpec(projectId, 24, 16);
  }

  it("H: KEEP remains the default for a preparation that has never selected a treatment", async () => {
    const { capability, projectId } = await build();
    const preparation = await uploadAndConfirm(capability, projectId, toPngBytes(whiteExteriorSignArtwork()));
    assert.equal(preparation.backgroundTreatment, "keep");
    assert.equal(preparation.backgroundTreatmentConfirmedAt, null);
    assert.equal(preparation.backgroundRemoval, null);
  });

  it("I: existing (KEEP) opaque Signs workflow is unaffected — a composition plan built without ever touching treatment is opaque and unchanged", async () => {
    const { capability, projectId } = await build();
    await uploadAndConfirm(capability, projectId, toPngBytes(whiteExteriorSignArtwork()));

    const updated = await capability.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 255, g: 255, b: 255 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });

    const plan = updated.plan as unknown as SignRepairPlan;
    assert.equal(plan.backgroundTreatment, "keep");
    assert.equal(plan.sourceAssetId, updated.originalAssetId);
  });

  it('REMOVE: a safe white-exterior artwork produces a governed "removed" outcome with a NEW derived transparent asset — the immutable original is untouched', async () => {
    const { repo, capability, projectId } = await build();
    const preparation = await uploadAndConfirm(capability, projectId, toPngBytes(whiteExteriorSignArtwork()));
    const originalAssetId = preparation.originalAssetId;

    const updated = await capability.setSignBackgroundTreatment(projectId, "remove");
    assert.equal(updated.backgroundTreatment, "remove");
    assert.ok(updated.backgroundTreatmentConfirmedAt);

    const removal = updated.backgroundRemoval as unknown as { status: string; preparedAssetId: string | null };
    assert.equal(removal.status, "removed");
    assert.ok(removal.preparedAssetId);
    assert.notEqual(removal.preparedAssetId, originalAssetId);

    // The immutable original's own bytes are untouched.
    assert.equal(updated.originalAssetId, originalAssetId);
    const originalStillThere = await repo.getAssetById(originalAssetId);
    assert.ok(originalStillThere);
  });

  it("REMOVE: the composition plan's own source becomes the derived transparent prepared asset — never a duplicated engine's output silently substituted for it", async () => {
    const { capability, projectId } = await build();
    const preparation = await uploadAndConfirm(capability, projectId, toPngBytes(whiteExteriorSignArtwork()));
    const updatedPrep = await capability.setSignBackgroundTreatment(projectId, "remove");
    const removal = updatedPrep.backgroundRemoval as unknown as { preparedAssetId: string };

    const planned = await capability.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 0, g: 0, b: 0 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });

    const plan = planned.plan as unknown as SignRepairPlan;
    assert.equal(plan.backgroundTreatment, "remove");
    assert.equal(plan.sourceAssetId, removal.preparedAssetId);
    assert.notEqual(plan.sourceAssetId, preparation.originalAssetId);
  });

  it("REMOVE + ambiguous artwork: does NOT claim success — planning/composition refuse fail-closed until resolved", async () => {
    const { capability, projectId } = await build();
    // No visible artwork at all (uniform white, nothing to isolate) —
    // classifyRepairability resolves this to NOT_REPAIRABLE ("none"),
    // never "remove_exterior".
    const blank = makeImage(600, 400, { r: 255, g: 255, b: 255 });
    await uploadAndConfirm(capability, projectId, toPngBytes(blank));
    const updated = await capability.setSignBackgroundTreatment(projectId, "remove");
    const removal = updated.backgroundRemoval as unknown as { status: string };
    assert.equal(removal.status, "no_visible_artwork");

    await assert.rejects(
      capability.confirmSignCompositionPlan(projectId, {
        reconstruction: null,
        crop: null,
        fitBackground: { r: 0, g: 0, b: 0 },
        fitPlacement: null,
        moves: [],
        fills: [],
        replacements: [],
      }),
      SignPreparationStateError,
    );
    await assert.rejects(capability.planSignRepair(projectId), SignPreparationStateError);
  });

  it("M: changing treatment changes planKey identity — a stale KEEP-plan authorization can never be reused for a REMOVE plan", async () => {
    const { capability, projectId } = await build();
    await uploadAndConfirm(capability, projectId, toPngBytes(whiteExteriorSignArtwork()));

    const keepPlanned = await capability.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 255, g: 255, b: 255 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    const keepPlan = keepPlanned.plan as unknown as SignRepairPlan;
    assert.equal(keepPlan.backgroundTreatment, "keep");
    const authorized = await capability.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    assert.equal(authorized.authorizedPlanKey, keepPlan.planKey);

    await capability.setSignBackgroundTreatment(projectId, "remove");
    const removePlanned = await capability.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 0, g: 0, b: 0 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    const removePlan = removePlanned.plan as unknown as SignRepairPlan;

    assert.notEqual(removePlan.planKey, keepPlan.planKey);
    // The OLD authorization no longer matches the CURRENT plan — a stale
    // candidate/acceptance bound to the old treatment can never be
    // silently approved under the new one.
    assert.notEqual(removePlanned.authorizedPlanKey, removePlan.planKey);
    assert.equal(removePlanned.authorizedPlanKey, keepPlan.planKey);

    // Sanity: planKey is genuinely derived FROM backgroundTreatment, not
    // merely different by coincidence of re-planning.
    const recomputedAsKeep = computeSignPlanKey({ ...removePlan, backgroundTreatment: "keep" });
    assert.notEqual(recomputedAsKeep, removePlan.planKey);
  });
});
