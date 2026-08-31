import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import type { AssetCapability } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker/final-artwork-worker-capability";
import { FakeSignReconstructionProvider } from "@/capabilities/final-artwork-worker/fake-sign-reconstruction-provider";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { SIGN_PRESERVATION_ALGORITHM_VERSION } from "./contracts";
import { createSignPreservationCapability, SignPreservationStateError } from "./sign-preservation-capability";

/**
 * Signs Phase S4.1: capability-level integration coverage — a REAL,
 * pipeline-produced final asset (via the same `FakeSignReconstructionProvider`
 * every S3A-S3D suite already uses; zero Topaz/network access, ever), then
 * `SignPreservationCapability` run against its real id. Deliberately
 * reproduces the real Ruth acceptance geometry synthetically
 * (`ruthLikeSignArtwork`, the established S1 fixture) — never the real
 * customer file, never the real persisted acceptance state.
 */
describe("Signs Phase S4.1: deterministic preservation verification", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-preservation-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(provider: FakeSignReconstructionProvider, assets?: AssetCapability) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets =
      assets ??
      createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, realAssets, provider);
    const preservation = createSignPreservationCapability(repo, realAssets);
    const project = await repo.createProject();
    return {
      repo,
      assets: realAssets,
      signPreparation,
      finalArtwork,
      worker,
      preservation,
      projectId: project.project.id,
    };
  }

  /** Reproduces the real Ruth acceptance geometry end to end: 1024x1536 source, 18x24in ordered, actual reconstruction 4096x6144 -> final 4608x6144, 256px/256px black extension. */
  async function ruthShapedFinalAsset(provider: FakeSignReconstructionProvider) {
    const built = await build(provider);
    await built.signPreparation.uploadSignArtwork(built.projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await built.signPreparation.confirmSignProductionSpec(built.projectId, 18, 24);
    await built.signPreparation.planSignRepair(built.projectId);
    const { job } = await built.finalArtwork.requestSignFinalArtwork(built.projectId);
    provider.behavior = { kind: "oversized_but_valid", widthPx: 4096, heightPx: 6144 };
    await built.worker.processNextJob();

    const finalAsset = (await built.repo.listAssets(built.projectId)).find(
      (a) =>
        a.finalArtworkJobId === job.id &&
        a.productionRole === "production_png" &&
        !isReconstructionIntermediateAsset(a),
    );
    assert.ok(finalAsset, "the Ruth-shaped final asset must exist before preservation verification runs");
    return { ...built, job, finalAsset: finalAsset! };
  }

  it("1: a real Ruth-shaped reconstruction produces deterministic evidence; overall status is 'unknown' — S4.1 can NEVER produce 'preserved'", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider);

    const result = await preservation.verifyDeterministicPreservation(finalAsset.id);

    assert.equal(result.status, "unknown");
    assert.notEqual(result.status, "preserved");
    assert.equal(result.finalAssetId, finalAsset.id);
    assert.equal(result.verificationAlgorithmVersion, SIGN_PRESERVATION_ALGORITHM_VERSION);
    assert.equal(result.semanticEvidence, null);

    const evidence = result.deterministicEvidence as Record<string, unknown>;
    assert.equal((evidence.lineage as Record<string, unknown>).result, "pass");
    assert.equal((evidence.regionMapping as Record<string, unknown>).result, "pass");
    assert.deepEqual((evidence.regionMapping as { contentRegion: unknown }).contentRegion, {
      x: 256,
      y: 0,
      width: 4096,
      height: 6144,
    });
    assert.equal((evidence.reconstructionToFinalRgb as Record<string, unknown>).result, "pass");
    assert.equal((evidence.extensionRegions as Record<string, unknown>).result, "pass");
    assert.equal(evidence.catastrophicAnomalyDetected, false);

    // Zero provider/network activity from preservation verification itself.
    assert.equal(provider.dispatchCount, 1, "exactly the one production dispatch — none from preservation");
  });

  it("2: final-asset identity binding — a verification for asset A is never returned for asset B", async () => {
    const providerA = new FakeSignReconstructionProvider();
    const a = await ruthShapedFinalAsset(providerA);
    const providerB = new FakeSignReconstructionProvider();
    const b = await ruthShapedFinalAsset(providerB);

    const resultA = await a.preservation.verifyDeterministicPreservation(a.finalAsset.id);
    const resultB = await b.preservation.verifyDeterministicPreservation(b.finalAsset.id);

    assert.notEqual(resultA.id, resultB.id);
    assert.equal(resultA.finalAssetId, a.finalAsset.id);
    assert.equal(resultB.finalAssetId, b.finalAsset.id);
    assert.notEqual(resultA.finalAssetId, resultB.finalAssetId);
  });

  it("3: planKey binding — the verification records the sign preparation's exact planKey", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, finalAsset, repo, projectId } = await ruthShapedFinalAsset(provider);
    const result = await preservation.verifyDeterministicPreservation(finalAsset.id);
    const preparation = await repo.getSignPreparation(projectId);
    assert.equal(result.planKey, preparation!.planKey);
  });

  it("4: duplicate verification identity reuses the existing record — never recomputed, never re-persisted", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, finalAsset, repo } = await ruthShapedFinalAsset(provider);

    const first = await preservation.verifyDeterministicPreservation(finalAsset.id);
    const second = await preservation.verifyDeterministicPreservation(finalAsset.id);

    assert.equal(first.id, second.id, "the same persisted row is returned, not a new one");

    const stored = await repo.getSignPreservationVerification(
      finalAsset.id,
      SIGN_PRESERVATION_ALGORITHM_VERSION,
    );
    assert.equal(stored!.id, first.id);
  });

  it("5: algorithm-version staleness — a different version never matches an existing record (structural proof, not behavior yet exercised by the capability)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, finalAsset, repo } = await ruthShapedFinalAsset(provider);
    await preservation.verifyDeterministicPreservation(finalAsset.id);

    const underOtherVersion = await repo.getSignPreservationVerification(
      finalAsset.id,
      "sign-preservation-deterministic:v2-does-not-exist",
    );
    assert.equal(underOtherVersion, null, "a bumped algorithm version never reuses a prior verification");
  });

  it("6: missing final asset -> throws SignPreservationStateError, nothing persisted", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, repo } = await build(provider);
    await assert.rejects(
      () => preservation.verifyDeterministicPreservation("00000000-0000-0000-0000-000000000000"),
      SignPreservationStateError,
    );
    const stored = await repo.getSignPreservationVerification(
      "00000000-0000-0000-0000-000000000000",
      SIGN_PRESERVATION_ALGORITHM_VERSION,
    );
    assert.equal(stored, null);
  });

  it("7: a non-reconstructed final asset refuses rather than fabricates evidence", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { repo, signPreparation, finalArtwork, worker, projectId, preservation } = await build(provider);
    // Exact-aspect, sufficiently-resolved source — no reconstruction needed.
    await signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(2700, 3600)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await signPreparation.planSignRepair(projectId);
    const { job } = await finalArtwork.requestSignFinalArtwork(projectId);
    await worker.processNextJob();
    const finalAsset = (await repo.listAssets(projectId)).find(
      (a) => a.finalArtworkJobId === job.id && a.productionRole === "production_png",
    );
    assert.ok(finalAsset);

    await assert.rejects(
      () => preservation.verifyDeterministicPreservation(finalAsset!.id),
      SignPreservationStateError,
    );
    assert.equal(provider.dispatchCount, 0, "no reconstruction, no provider dispatch — unaffected by S4.1");
  });

  it("8: recorded reasons are non-empty and traceable — an auditor can see why status is 'unknown' without reading runtime code", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider);
    const result = await preservation.verifyDeterministicPreservation(finalAsset.id);
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.reasons.length > 0, "S4.1 never claims silence — the similarity evidence reason is always present");
  });

  it("9: zero provider/network activity from preservation verification itself", async () => {
    const provider = new FakeSignReconstructionProvider();
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider);
    const dispatchBefore = provider.dispatchCount;
    const resumeBefore = provider.resumeCount;
    await preservation.verifyDeterministicPreservation(finalAsset.id);
    assert.equal(provider.dispatchCount, dispatchBefore);
    assert.equal(provider.resumeCount, resumeBefore);
  });
});
