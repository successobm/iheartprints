/**
 * Signs Phase 3A: operator-confirmed structural evidence — synthetic,
 * end-to-end proof through the REAL `SignPreparationCapability` (never a
 * direct unit call on `synthesizeSegmentationFromOperatorOverride` alone
 * for the orchestration-precedence assertions) that:
 *
 *   - deterministic segmentation, when it fails (ambiguous), leaves
 *     planning correctly reflecting that until an operator override exists;
 *   - a valid, source-bound operator override lets planning reach
 *     `reflow_structural_layout` where deterministic evidence alone could
 *     not;
 *   - the override is rejected when bound to a stale/different source;
 *   - changing the confirmed boundaries changes the resulting `planKey`;
 *   - an authorization granted for one plan is never silently valid for a
 *     different one after the override changes.
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
import { verticalRunsArtwork, toPngBytes } from "./sign-fixtures";
import type { SignOperatorRegionBoundary } from "./sign-operator-structural-override";

/**
 * A fixture whose DETERMINISTIC scan is genuinely `"ambiguous"` (two large,
 * directly-adjacent, differently-coloured fill runs at rows 100-150/
 * 150-250 — well above the Phase 2D transition-run bound, so this is a
 * real, unresolvable disagreement, never a spurious one) — but whose
 * CORRECT structural interpretation (a top banner whose own fill extends
 * through row 150, then a background gap, then a bottom banner) an
 * operator can confirm directly: `region0`'s own declared span extends
 * THROUGH the disputed boundary (rows 0-150), so the ambiguous run at
 * 100-150 is absorbed into region0's own translated span rather than
 * independently re-validated — only the GAP (rows 150-250, genuinely
 * uniform on its own) and each anchor's own leading/trailing fill span are
 * independently measured.
 */
function ambiguousBannerArtwork() {
  return verticalRunsArtwork(300, [
    { heightPx: 40, color: { r: 200, g: 30, b: 30 } }, // region0's own leading fill.
    { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true }, // region0's own content.
    { heightPx: 50, color: { r: 90, g: 90, b: 200 } }, // the disputed run (ambiguous against the gap below).
    { heightPx: 100, color: { r: 20, g: 20, b: 20 } }, // the gap.
    { heightPx: 60, color: { r: 100, g: 250, b: 250 }, content: true }, // region1's own content.
    { heightPx: 40, color: { r: 30, g: 150, b: 30 } }, // region1's own trailing fill.
  ]);
}

const VALID_REGIONS: SignOperatorRegionBoundary[] = [
  { startYPx: 0, endYPx: 150, contentStartYPx: 40, contentEndYPx: 100 },
  { startYPx: 250, endYPx: 350, contentStartYPx: 250, contentEndYPx: 310 },
];

describe("Signs Phase 3A: operator-confirmed structural evidence (real orchestration path)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-operator-override-"));
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

  it("A: deterministic segmentation alone leaves the plan blocked/without reflow for this genuinely ambiguous fixture", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ambiguousBannerArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 2, 4);

    const outcome = await capability.planSignRepair(projectId);
    if (outcome.result.status === "planned") {
      assert.doesNotMatch(JSON.stringify(outcome.result.plan!.steps), /"kind":"reflow_structural_layout"/);
    }
    // Either genuinely blocked, or planned without reflow — either way,
    // NOT reflow, proving operator evidence was never silently assumed.
  });

  it("B: a valid operator override lets planning reach reflow_structural_layout where deterministic evidence alone could not", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ambiguousBannerArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 2, 4);

    await capability.confirmOperatorStructuralLayout(projectId, VALID_REGIONS);
    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const step = outcome.result.plan!.steps.find((s) => s.kind === "reflow_structural_layout");
    assert.ok(step, "expected operator evidence to unlock reflow_structural_layout");
    assert.equal(step!.params.regionCount, 2);
    assert.equal(step!.params.gapCount, 1);
  });

  it("C: an override bound to a stale/different source is rejected — never reused against a different source", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ambiguousBannerArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 2, 4);
    await capability.confirmOperatorStructuralLayout(projectId, VALID_REGIONS);

    // Directly corrupt the persisted override's own source binding — the
    // shape a stale override left over from a hypothetical re-upload would
    // take (this profile actually refuses a second upload per project, so
    // this simulates that class of staleness deterministically).
    const preparation = await repo.getSignPreparation(projectId);
    const corrupted = { ...(preparation!.operatorStructuralOverride as Record<string, unknown>), sourceSha256: "stale-hash" };
    await repo.updateSignPreparation(preparation!.id, { operatorStructuralOverride: corrupted });

    const outcome = await capability.planSignRepair(projectId);
    if (outcome.result.status === "planned") {
      assert.doesNotMatch(JSON.stringify(outcome.result.plan!.steps), /"kind":"reflow_structural_layout"/);
    }
  });

  it("D: changing the confirmed boundaries changes the resulting planKey, and a prior authorization does not silently cover the new plan", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ambiguousBannerArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 2, 4);
    await capability.confirmOperatorStructuralLayout(projectId, VALID_REGIONS);
    const outcome1 = await capability.planSignRepair(projectId);
    assert.equal(outcome1.result.status, "planned");
    const planKey1 = outcome1.result.plan!.planKey;
    await capability.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    // Confirm DIFFERENT boundaries — a genuinely different gap ratio.
    const changedRegions: SignOperatorRegionBoundary[] = [
      { startYPx: 0, endYPx: 150, contentStartYPx: 40, contentEndYPx: 100 },
      // A genuinely different confirmed content span (region1's own
      // meaningful content now starts 10px later) — still valid (still
      // within [250,310), and the fill measurement below it is unaffected
      // since it only ever reads `contentEndYPx`) but changes the encoded
      // step params, and therefore the resulting planKey.
      { startYPx: 250, endYPx: 350, contentStartYPx: 260, contentEndYPx: 310 },
    ];
    await capability.confirmOperatorStructuralLayout(projectId, changedRegions);
    const outcome2 = await capability.planSignRepair(projectId);
    assert.equal(outcome2.result.status, "planned");
    const planKey2 = outcome2.result.plan!.planKey;

    assert.notEqual(planKey1, planKey2);

    const preparation = await capability.getSignPreparation(projectId);
    // The OLD authorization no longer matches the CURRENT (re-planned) key
    // — `authorizeSignRepairPlan`'s own idempotent-reuse check would only
    // ever fire for the identical key.
    assert.notEqual(preparation!.authorizedPlanKey, planKey2);
  });

  it("E: an override with a genuinely unprovable boundary (colour does not hold up) is refused before anything is persisted", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ambiguousBannerArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 2, 4);

    const badRegions: SignOperatorRegionBoundary[] = [
      // region0's own fill/content span (rows 0-100) is fine on its own —
      // the defect is ending region0 at row 120, INSIDE the disputed run
      // (rows 100-150), so the declared gap (120-250) straddles a genuine
      // colour change (part of the disputed run's own colour, part of the
      // real gap's) and is NOT uniform.
      { startYPx: 0, endYPx: 120, contentStartYPx: 40, contentEndYPx: 100 },
      { startYPx: 250, endYPx: 350, contentStartYPx: 250, contentEndYPx: 310 },
    ];
    await assert.rejects(
      () => capability.confirmOperatorStructuralLayout(projectId, badRegions),
      SignPreparationStateError,
    );

    const preparation = await capability.getSignPreparation(projectId);
    assert.equal(preparation!.operatorStructuralOverride, null);
  });
});
