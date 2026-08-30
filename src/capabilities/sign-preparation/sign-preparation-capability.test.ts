import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import {
  createAssetCapability,
  PngThumbnailGenerator,
} from "@/capabilities/assets";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  createSignPreparationCapability,
  SignPreparationStateError,
} from "./sign-preparation-capability";
import { ruthLikeSignArtwork, toPngBytes } from "./sign-fixtures";

/**
 * End-to-end S1 flow against the real local repository and a real asset
 * storage provider — no persistence mocks, and (by construction) no
 * provider of any kind exists to mock: sign inspection and planning are
 * local, deterministic, and change no pixels.
 */
describe("SignPreparationCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-prep-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createSignPreparationCapability(repo, assets);
    const project = await repo.createProject();
    return { repo, assets, capability, projectId: project.project.id };
  }

  const ruthBytes = () => toPngBytes(ruthLikeSignArtwork());

  it("A: upload persists an immutable customer_upload original and a spec-independent inspection", async () => {
    const { repo, capability, projectId } = await build();

    const preparation = await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "kids-fun-extras.png",
    });

    assert.equal(preparation.status, "inspected");
    assert.equal(preparation.originalFilename, "kids-fun-extras.png");
    assert.equal(preparation.orderedWidthIn, null);
    assert.equal(preparation.orderedHeightIn, null);
    assert.equal(preparation.plan, null);

    const stored = await repo.getAssetById(preparation.originalAssetId);
    assert.ok(stored);
    assert.equal(stored!.kind, "customer_upload");
    assert.equal(stored!.projectId, projectId);
    // Nothing generated these pixels, and nothing produced them either.
    assert.equal(stored!.providerKey, null);
    assert.equal(stored!.generationJobId, null);
    assert.equal(stored!.finalArtworkJobId, null);
    assert.equal(stored!.productionRole, null);
  });

  it("B: a second upload for the same project is refused — the original is never swapped", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "a.png",
    });
    await assert.rejects(
      capability.uploadSignArtwork(projectId, {
        bytes: ruthBytes(),
        declaredContentType: "image/png",
        filename: "b.png",
      }),
      SignPreparationStateError,
    );
  });

  it("6/7: planning without a confirmed width AND height fails closed — no plan persisted, explicit defects", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "blocked");
    assert.equal(outcome.result.plan, null);
    const codes = outcome.result.defects.map((defect) => defect.code);
    assert.ok(codes.includes("missing_confirmed_width"));
    assert.ok(codes.includes("missing_confirmed_height"));
    assert.ok(codes.includes("missing_spec_confirmation"));

    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.status, "inspected");
    assert.equal(persisted!.plan, null);
    assert.equal(persisted!.planKey, null);
  });

  it("C: confirmation validates dimensions and policy coverage, and never defaults", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });

    await assert.rejects(
      capability.confirmSignProductionSpec(projectId, 0, 24),
      SignPreparationStateError,
    );
    await assert.rejects(
      capability.confirmSignProductionSpec(projectId, Number.NaN, 24),
      SignPreparationStateError,
    );
    // Outside every V1 policy envelope: refused, never borrowed policy.
    await assert.rejects(
      capability.confirmSignProductionSpec(projectId, 40, 60),
      SignPreparationStateError,
    );
  });

  it("4/M: the Ruth acceptance flow — confirm 18×24, plan reconstruct→pad at exact audit math, REVIEW_REQUIRED", async () => {
    const { repo, assets, capability, projectId } = await build();
    const bytes = ruthBytes();
    const originalSha = createHash("sha256").update(bytes).digest("hex");

    await capability.uploadSignArtwork(projectId, {
      bytes,
      declaredContentType: "image/png",
      filename: "kids-fun-extras.png",
    });

    const confirmed = await capability.confirmSignProductionSpec(projectId, 18, 24);
    assert.equal(confirmed.orderedWidthIn, 18);
    assert.equal(confirmed.orderedHeightIn, 24);
    assert.ok(confirmed.specConfirmedAt);
    assert.equal(confirmed.resolutionPolicyId, "rigid_rect_up_to_24x36:v1");

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;

    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ["reconstruct_resolution", "pad_uniform_background"],
    );
    assert.equal(plan.steps[0]!.params.requestedWidthPx, 2448);
    assert.equal(plan.steps[0]!.params.requestedHeightPx, 3672);
    assert.equal(plan.steps[1]!.params.leadingPx, 153);
    assert.equal(plan.steps[1]!.params.trailingPx, 153);
    assert.equal(plan.expectedOutputWidthPx, 2754);
    assert.equal(plan.expectedOutputHeightPx, 3672);
    assert.ok(Math.abs(plan.expectedEffectivePpi - 153) < 0.01);
    assert.equal(plan.overallRisk, "review_required");
    assert.equal(plan.sourceSha256, originalSha);
    assert.ok(plan.defects.includes("foreground_reaches_extension_edge"));

    // Persisted, with the canonical key, and the lifecycle moved to planned.
    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.status, "planned");
    assert.equal(persisted!.planKey, plan.planKey);
    assert.ok(persisted!.plan);

    // S1 changed no pixels: the immutable original is byte-identical.
    const downloaded = await assets.downloadAssetBytes(persisted!.originalAssetId);
    const afterSha = createHash("sha256").update(downloaded!.bytes).digest("hex");
    assert.equal(afterSha, originalSha);
  });

  it("D: sign preparations are project-scoped — another project resolves to nothing", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: ruthBytes(),
      declaredContentType: "image/png",
      filename: "ruth.png",
    });
    const other = await repo.createProject();
    assert.equal(await capability.getSignPreparation(other.project.id), null);
    await assert.rejects(
      capability.planSignRepair(other.project.id),
      SignPreparationStateError,
    );
  });
});
