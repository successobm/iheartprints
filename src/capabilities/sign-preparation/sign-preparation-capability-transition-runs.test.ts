/**
 * Structural Layout Reflow Phase 2D (Bounded Transition-Run Segmentation).
 * Proves the FULL real-orchestration chain through
 * `SignPreparationCapability.planSignRepair` — source -> frame measurement
 * -> frame-interior analysis window -> structural segmentation (now with
 * bounded transition-run normalization) -> planner -> `reflow_structural_
 * layout` — for a continuously-framed banner sign whose interior contains a
 * bounded, plausibly-transitional 1px row that, before Phase 2D, would have
 * made segmentation report `"ambiguous"` and block the reflow step
 * entirely (the SAME structural shape as the real cc6cfc4b-... acceptance
 * sign's own defect). Never a direct planner-level injection.
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

import { createSignPreparationCapability } from "./sign-preparation-capability";
import { planContainsOnlyAdmittedSteps } from "./sign-transform-executor";
import { framedBannerSignArtwork, toPngBytes } from "./sign-fixtures";

describe("SignPreparationCapability — bounded transition-run segmentation (real orchestration path)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-prep-transition-runs-"));
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
    return { repo, capability, projectId: project.project.id };
  }

  it("a framed banner sign with a bounded interior transition row still reaches reflow_structural_layout, deterministically, with a straight-rectangle template and the 0.125in safe inset", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(framedBannerSignArtwork({ rounded: true, withHoles: true, transitionBeforeGap2: true })),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 24, 36);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;

    const step = plan.steps.find((s) => s.kind === "reflow_structural_layout");
    assert.ok(
      step,
      "expected reflow_structural_layout to reach the real plan — a bounded interior transition row must not " +
        "leave segmentation ambiguous",
    );
    assert.doesNotMatch(JSON.stringify(plan.steps), /"kind":"reconstruct_parametric_frame"/);

    assert.equal(plan.overallRisk, "review_required");
    assert.equal(step!.risk, "review_required");
    assert.equal(step!.params.templateShape, "straight_rectangle");
    assert.equal(step!.params.templateMinimumSafeInsetIn, 0.125);
    assert.equal(step!.params.scalingMode, "none");

    assert.equal(step!.params.regionCount, 4);
    assert.equal(step!.params.gapCount, 3);
    assert.equal(step!.params.region0Role, "top_anchor");
    assert.equal(step!.params.region3Role, "bottom_anchor");

    // 17: executor still refuses this plan entirely.
    assert.equal(planContainsOnlyAdmittedSteps(plan), false);

    // Determinism: a second, independent plan call against the SAME
    // immutable original produces an IDENTICAL step and an IDENTICAL
    // planKey.
    const again = await capability.planSignRepair(projectId);
    assert.equal(again.result.status, "planned");
    const stepAgain = again.result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.deepEqual(step!.params, stepAgain.params);
    assert.equal(again.result.plan!.planKey, plan.planKey);

    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.planKey, plan.planKey);
  });
});
