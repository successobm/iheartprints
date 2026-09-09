/**
 * Banner Production Profile (Constitution amendment 3.3, §16A-bis):
 * end-to-end capability-level coverage for the `rigid_sign_raster` /
 * `banner_raster` production-type model — real local repository, real
 * asset storage, no mocks (mirrors `sign-preparation-capability-background
 * -treatment.test.ts`'s own harness exactly).
 *
 * The real motivating customer case: an 84x24in (7ft x 2ft) banner order.
 * "That sign size isn't covered by a supported rigid-sign policy yet" is
 * correct and MUST remain correct under `rigid_sign_raster` — Banner is a
 * genuine sibling profile, never a raised rigid-sign ceiling.
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
import {
  DEFAULT_SIGN_PRODUCTION_TYPE,
  resolveSignProductionType,
  SIGN_PRODUCTION_TYPES,
} from "@/lib/domain/types";

import { createSignPreparationCapability, SignPreparationStateError } from "./sign-preparation-capability";
import { ruthLikeSignArtwork, toPngBytes } from "./sign-fixtures";

describe("SignProductionType (domain resolver): fails closed on anything unrecognized", () => {
  it("recognizes exactly the two admitted values", () => {
    assert.deepEqual(SIGN_PRODUCTION_TYPES, ["rigid_sign_raster", "banner_raster"]);
    assert.equal(DEFAULT_SIGN_PRODUCTION_TYPE, "rigid_sign_raster");
  });

  it("null/undefined/garbage/empty all resolve to the SAFE default — never banner_raster by accident", () => {
    for (const value of [null, undefined, "", "signage", "vinyl_banner", "RIGID_SIGN_RASTER", " banner_raster"]) {
      assert.equal(resolveSignProductionType(value as string | null | undefined), "rigid_sign_raster", `value=${JSON.stringify(value)}`);
    }
  });

  it("the exact two admitted strings round-trip", () => {
    assert.equal(resolveSignProductionType("rigid_sign_raster"), "rigid_sign_raster");
    assert.equal(resolveSignProductionType("banner_raster"), "banner_raster");
  });
});

describe("SignPreparationCapability: Banner Production Profile", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-production-type-"));
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

  const ruthBytes = () => toPngBytes(ruthLikeSignArtwork());

  it("1: an existing/new preparation defaults to rigid_sign_raster, unconfirmed — never silently Banner", async () => {
    const { capability, projectId } = await build();
    const preparation = await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    assert.equal(preparation.productionType, "rigid_sign_raster");
    assert.equal(preparation.productionTypeConfirmedAt, null);
  });

  it("2: 84x24in remains rejected under rigid_sign_raster — the pre-existing, correct rejection is unchanged", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    await assert.rejects(
      capability.confirmSignProductionSpec(projectId, 84, 24),
      (error: unknown) => error instanceof SignPreparationStateError &&
        /rigid-sign policy/.test((error as Error).message),
    );
  });

  it("3: 84x24in is accepted once the production type is explicitly set to banner_raster", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    const withType = await capability.setSignProductionType(projectId, "banner_raster");
    assert.equal(withType.productionType, "banner_raster");
    assert.ok(withType.productionTypeConfirmedAt);

    const confirmed = await capability.confirmSignProductionSpec(projectId, 84, 24);
    assert.equal(confirmed.orderedWidthIn, 84);
    assert.equal(confirmed.orderedHeightIn, 24);
    assert.equal(confirmed.resolutionPolicyId, "banner_rect_up_to_36x96:v1");
    assert.ok(confirmed.specConfirmedAt);
  });

  it("REAL CUSTOMER CASE: 84x24in is rejected under rigid_sign_raster AND accepted under banner_raster, for the SAME project/upload", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });

    // Default rigid_sign_raster: correctly still refused.
    await assert.rejects(capability.confirmSignProductionSpec(projectId, 84, 24), SignPreparationStateError);

    // Explicit "what are we making?" -> Banner: now supported.
    await capability.setSignProductionType(projectId, "banner_raster");
    const confirmed = await capability.confirmSignProductionSpec(projectId, 84, 24);
    assert.equal(confirmed.resolutionPolicyId, "banner_rect_up_to_36x96:v1");
  });

  it("4: unsupported Banner dimensions still fail closed — Banner has real limits too, not an unbounded escape hatch", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    await capability.setSignProductionType(projectId, "banner_raster");
    // 37x100 exceeds both banner axes (36x96 max).
    await assert.rejects(
      capability.confirmSignProductionSpec(projectId, 37, 100),
      (error: unknown) => error instanceof SignPreparationStateError &&
        /banner policy/.test((error as Error).message),
    );
  });

  it("5: changing production type invalidates a stale confirmed spec/plan/authorization — nothing survives under the new category", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });

    // Confirm + plan + authorize under the DEFAULT rigid_sign_raster type.
    await capability.confirmSignProductionSpec(projectId, 18, 24);
    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    // The Ruth fixture's plan at 18x24in is review_required — an operator
    // actor (sufficient for every risk class) authorizes it.
    const authorized = await capability.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    assert.ok(authorized.authorizedPlanKey);
    assert.equal(authorized.status, "planned");

    // Change the production type: everything downstream must be cleared.
    const changed = await capability.setSignProductionType(projectId, "banner_raster");
    assert.equal(changed.productionType, "banner_raster");
    assert.equal(changed.specConfirmedAt, null);
    assert.equal(changed.resolutionPolicyId, null);
    assert.equal(changed.plan, null);
    assert.equal(changed.planKey, null);
    assert.equal(changed.authorizedPlanKey, null);
    assert.equal(changed.authorizedAt, null);
    assert.equal(changed.authorizedBy, null);
    assert.equal(changed.status, "inspected");
    // The customer's own stated size survives — SignSizeStep just re-confirms it.
    assert.equal(changed.orderedWidthIn, 18);
    assert.equal(changed.orderedHeightIn, 24);

    // Persisted, not just returned.
    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.plan, null);
    assert.equal(persisted!.planKey, null);
    assert.equal(persisted!.authorizedPlanKey, null);

    // The now-stale rigid plan can never be authorized again: no plan exists to authorize.
    await assert.rejects(
      capability.authorizeSignRepairPlan(projectId, { authorizedBy: "customer" }),
      SignPreparationStateError,
    );

    // Planning under the NEW category naturally produces a policy/plan bound to banner_raster.
    const rebuilt = await capability.confirmSignProductionSpec(projectId, 18, 24);
    assert.equal(rebuilt.resolutionPolicyId, "banner_rect_up_to_36x96:v1");
  });

  it("6: re-confirming the SAME production type is a pure no-op — nothing already-confirmed is disturbed", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    await capability.confirmSignProductionSpec(projectId, 18, 24);
    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const before_ = await capability.getSignPreparation(projectId);

    const same = await capability.setSignProductionType(projectId, "rigid_sign_raster");
    assert.deepEqual(same.plan, before_!.plan);
    assert.equal(same.planKey, before_!.planKey);
    assert.equal(same.specConfirmedAt, before_!.specConfirmedAt);
    assert.equal(same.status, "planned");
  });

  it("7: choosing rigid_sign_raster explicitly for the very first time behaves identically to the implicit default — idempotent, non-destructive", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    const withType = await capability.setSignProductionType(projectId, "rigid_sign_raster");
    assert.equal(withType.productionType, "rigid_sign_raster");
    assert.ok(withType.productionTypeConfirmedAt);
    // Still able to confirm a rigid-sign size normally afterward.
    const confirmed = await capability.confirmSignProductionSpec(projectId, 18, 24);
    assert.equal(confirmed.resolutionPolicyId, "rigid_rect_up_to_24x36:v1");
  });

  it("no regression: the existing 18x24in rigid-sign plan/composition path is completely unaffected by Banner's existence", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "kids-fun-extras.png",
    });
    const confirmed = await capability.confirmSignProductionSpec(projectId, 18, 24);
    assert.equal(confirmed.resolutionPolicyId, "rigid_rect_up_to_24x36:v1");
    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    assert.equal(outcome.result.plan!.expectedOutputWidthPx, 2754);
    assert.equal(outcome.result.plan!.expectedOutputHeightPx, 3672);
  });
});
