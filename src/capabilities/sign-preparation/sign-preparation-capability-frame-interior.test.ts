/**
 * Structural Layout Reflow Phase 2C (Frame-Interior-Aware Segmentation).
 * Proves the FULL real-orchestration chain through
 * `SignPreparationCapability.planSignRepair` — source -> frame measurement
 * -> frame-interior analysis window -> structural segmentation -> planner
 * -> `reflow_structural_layout` — for a sign whose continuous decorative
 * frame would otherwise defeat full-width row uniformity everywhere (the
 * real cc6cfc4b-... acceptance sign's own defining property), never a
 * direct planner-level injection.
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

describe("SignPreparationCapability — frame-interior-aware structural reflow (real orchestration path)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-prep-frame-interior-"));
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

  it("a continuously-framed, multi-region banner sign reaches reflow_structural_layout through the real path, deterministically, with a straight-rectangle template and the 0.125in safe inset", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(framedBannerSignArtwork({ rounded: true, withHoles: true })),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 24, 36);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;

    const step = plan.steps.find((s) => s.kind === "reflow_structural_layout");
    assert.ok(step, "expected reflow_structural_layout to reach the real plan for a continuously-framed banner sign");
    assert.doesNotMatch(JSON.stringify(plan.steps), /"kind":"reconstruct_parametric_frame"/);

    assert.equal(plan.overallRisk, "review_required");
    assert.equal(step!.risk, "review_required");
    assert.equal(step!.params.templateShape, "straight_rectangle");
    assert.equal(step!.params.templateWidthIn, 24);
    assert.equal(step!.params.templateHeightIn, 36);
    assert.equal(step!.params.templateMinimumSafeInsetIn, 0.125);
    assert.equal(step!.params.scalingMode, "none");

    // The analysis window used was persisted explicitly (Phase 2C's own
    // architectural requirement — never left for a future executor to
    // infer), and matches the frame's own measured interior origin: NOT
    // (0,0) — proof the frame-interior window was genuinely used, not the
    // full image.
    assert.equal(typeof step!.params.analysisWindowXPx, "number");
    assert.ok((step!.params.analysisWindowXPx as number) > 0);
    assert.ok((step!.params.analysisWindowYPx as number) > 0);

    const regionCount = step!.params.regionCount as number;
    assert.equal(regionCount, 4);
    assert.equal(step!.params.region0Role, "top_anchor");
    assert.equal(step!.params.region1Role, "middle");
    assert.equal(step!.params.region2Role, "middle");
    assert.equal(step!.params.region3Role, "bottom_anchor");
    assert.equal(step!.params.gapCount, 3);

    // Region source bounds are SOURCE-image-absolute — the top anchor's
    // own sourceBounds must start well past y=0 (inside the frame's own
    // measured band depth), never at the true canvas edge.
    assert.ok((step!.params.region0SourceStartYPx as number) > 0);

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
