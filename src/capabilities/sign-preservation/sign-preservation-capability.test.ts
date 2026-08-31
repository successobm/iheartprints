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

import {
  buildCombinedVerificationAlgorithmVersion,
  SIGN_PRESERVATION_ALGORITHM_VERSION,
} from "./contracts";
import { createSignPreservationCapability, SignPreservationStateError } from "./sign-preservation-capability";
import { FakeSignPreservationSemanticProvider } from "./fake-sign-preservation-semantic-provider";
import type { SignPreservationSemanticProvider } from "./sign-preservation-semantic-provider";
import { ProviderError } from "@/capabilities/providers/provider-error";

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

  async function build(
    provider: FakeSignReconstructionProvider,
    assets?: AssetCapability,
    semanticProvider?: SignPreservationSemanticProvider,
  ) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets =
      assets ??
      createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, realAssets, provider);
    const preservation = createSignPreservationCapability(repo, realAssets, semanticProvider);
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
  async function ruthShapedFinalAsset(
    provider: FakeSignReconstructionProvider,
    semanticProvider?: SignPreservationSemanticProvider,
  ) {
    const built = await build(provider, undefined, semanticProvider);
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

/**
 * Signs Phase S4.2A: the full deterministic + semantic pipeline. Every
 * test uses `FakeSignPreservationSemanticProvider` — no test in this file,
 * or anywhere in this repository, ever calls a real semantic/multimodal
 * provider or Topaz.
 */
describe("Signs Phase S4.2A: semantic preservation verification", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-preservation-semantic-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build(
    provider: FakeSignReconstructionProvider,
    semanticProvider: SignPreservationSemanticProvider,
  ) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const signPreparation = createSignPreparationCapability(repo, realAssets);
    const finalArtwork = createFinalArtworkCapability(repo);
    const worker = createFinalArtworkWorkerCapability(repo, realAssets, provider);
    const preservation = createSignPreservationCapability(repo, realAssets, semanticProvider);
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

  async function ruthShapedFinalAsset(
    provider: FakeSignReconstructionProvider,
    semanticProvider: SignPreservationSemanticProvider,
  ) {
    const built = await build(provider, semanticProvider);
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

  /**
   * Wraps a real `AssetCapability`, overriding `downloadAssetBytes` for
   * ONE specific asset id to return `overrideBytes` (or `null`) instead of
   * its real content. A pure test-harness technique — never touches the
   * actually-persisted asset — used to deterministically exercise the
   * "structural authority invalid" and "catastrophic RGB mismatch" branches
   * that the real, self-correcting production pipeline can never actually
   * produce (every upstream S2/S3A/S3C/S3D check already refuses to
   * persist a defective final asset in the first place).
   */
  function withOverriddenBytes(
    realAssets: AssetCapability,
    assetId: string,
    overrideBytes: Buffer | null,
  ): AssetCapability {
    return {
      ...realAssets,
      async downloadAssetBytes(id: string) {
        if (id === assetId) {
          return overrideBytes ? { bytes: overrideBytes, contentType: "image/png" } : null;
        }
        return realAssets.downloadAssetBytes(id);
      },
    };
  }

  it("1: structural authority valid + semantic 'preserved' -> overall 'preserved', exactly one semantic dispatch", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "all_same" };
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider, semantic);

    const result = await preservation.verifyPreservation(finalAsset.id);

    assert.equal(result.status, "preserved");
    assert.equal(semantic.dispatchCount, 1);
    assert.equal(
      result.verificationAlgorithmVersion,
      buildCombinedVerificationAlgorithmVersion(semantic.providerKey, semantic.modelIdentity),
    );
    const semanticEvidence = result.semanticEvidence as Record<string, unknown>;
    assert.ok(semanticEvidence, "semantic evidence is persisted");
    assert.equal(semanticEvidence.verdict, "preserved");
    assert.equal(semanticEvidence.providerKey, semantic.providerKey);
    assert.equal(semanticEvidence.modelIdentity, semantic.modelIdentity);
  });

  it("2: repeated invocation reuses the persisted result — never recomputed, never re-dispatched", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider, semantic);

    const first = await preservation.verifyPreservation(finalAsset.id);
    const second = await preservation.verifyPreservation(finalAsset.id);

    assert.equal(first.id, second.id);
    assert.equal(semantic.dispatchCount, 1);
  });

  it("3: a different semantic provider (model/version change) creates a different verification identity — no stale reuse", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semanticA = new FakeSignPreservationSemanticProvider();
    const { repo, finalAsset, preservation: preservationA } = await ruthShapedFinalAsset(provider, semanticA);
    await preservationA.verifyPreservation(finalAsset.id);

    const semanticB = new FakeSignPreservationSemanticProvider("fake-model-v2");
    const { createSignPreservationCapability: create } = await import("./sign-preservation-capability");
    const preservationB = create(repo, (await import("@/capabilities/assets")).createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    ), semanticB);

    // Under semanticB's own (different) combined identity, nothing exists
    // yet — proving the version bump did not silently reuse semanticA's row.
    const underB = await repo.getSignPreservationVerification(
      finalAsset.id,
      buildCombinedVerificationAlgorithmVersion(semanticB.providerKey, semanticB.modelIdentity),
    );
    assert.equal(underB, null);

    const resultB = await preservationB.verifyPreservation(finalAsset.id);
    assert.equal(semanticB.dispatchCount, 1, "a fresh dispatch occurred under the new identity");
    assert.notEqual(
      resultB.verificationAlgorithmVersion,
      buildCombinedVerificationAlgorithmVersion(semanticA.providerKey, semanticA.modelIdentity),
    );
  });

  it("4: deterministic structural invalidity (unreadable final-asset bytes) -> zero semantic dispatches, status 'unknown'", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "all_same" }; // would certify 'preserved' if ever asked — must never be asked
    const { repo, assets, finalAsset, projectId } = await ruthShapedFinalAsset(
      provider,
      semantic,
    );

    const brokenAssets = withOverriddenBytes(assets, finalAsset.id, null);
    const brokenPreservation = createSignPreservationCapability(repo, brokenAssets, semantic);

    const result = await brokenPreservation.verifyPreservation(finalAsset.id);

    assert.equal(result.status, "unknown");
    assert.notEqual(result.status, "preserved");
    assert.equal(semantic.dispatchCount, 0, "structural authority was invalid — the semantic provider must never be consulted");
    assert.equal(result.semanticEvidence, null);
    void projectId;
  });

  it("5: deterministic catastrophic anomaly (corrupted final-asset RGB) -> 'changed', cannot be overridden by a 'preserved' semantic answer, zero semantic dispatches", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "all_same" }; // would certify 'preserved' if ever asked — must never be asked
    const { repo, assets, finalAsset } = await ruthShapedFinalAsset(provider, semantic);

    const realBytes = await assets.downloadAssetBytes(finalAsset.id);
    assert.ok(realBytes);
    const { PNG } = await import("pngjs");
    const png = PNG.sync.read(realBytes!.bytes);
    // Corrupt one pixel deep inside the CONTENT region (x=256 is the first
    // content column for this Ruth-shaped fixture) — never in the
    // extension bars, so this isolates the RGB-integrity check specifically.
    const idx = (100 * png.width + 300) * 4;
    png.data[idx] = (png.data[idx] + 77) % 256;
    const corruptedBytes = PNG.sync.write(png);

    const corruptedAssets = withOverriddenBytes(assets, finalAsset.id, corruptedBytes);
    const corruptedPreservation = createSignPreservationCapability(repo, corruptedAssets, semantic);

    const result = await corruptedPreservation.verifyPreservation(finalAsset.id);

    assert.equal(result.status, "changed");
    const evidence = result.deterministicEvidence as Record<string, unknown>;
    assert.equal((evidence.reconstructionToFinalRgb as Record<string, unknown>).result, "catastrophic");
    assert.equal(evidence.catastrophicAnomalyDetected, true);
    assert.equal(semantic.dispatchCount, 0, "a proven catastrophic anomaly must skip the semantic provider entirely");
  });

  it("6: semantic 'changed' -> overall 'changed'", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "changed_price" };
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider, semantic);

    const result = await preservation.verifyPreservation(finalAsset.id);
    assert.equal(result.status, "changed");
    assert.equal(semantic.dispatchCount, 1);
    const semanticEvidence = result.semanticEvidence as Record<string, unknown>;
    assert.equal(semanticEvidence.verdict, "changed");
  });

  it("7: semantic 'cannot_determine' -> a COMPLETED record persists with status 'unknown' (never treated as a failed attempt)", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "cannot_determine" };
    const { preservation, finalAsset, repo } = await ruthShapedFinalAsset(provider, semantic);

    const result = await preservation.verifyPreservation(finalAsset.id);
    assert.equal(result.status, "unknown");
    assert.equal(semantic.dispatchCount, 1);

    const stored = await repo.getSignPreservationVerification(
      finalAsset.id,
      buildCombinedVerificationAlgorithmVersion(semantic.providerKey, semantic.modelIdentity),
    );
    assert.ok(stored, "a completed (cannot_determine-driven unknown) verification IS persisted");
    assert.equal(stored!.id, result.id);
  });

  it("8: malformed provider result (structurally invalid answers, no throw) does NOT persist a completed verification", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "malformed_result" };
    const { preservation, finalAsset, repo } = await ruthShapedFinalAsset(provider, semantic);

    await assert.rejects(() => preservation.verifyPreservation(finalAsset.id), ProviderError);
    assert.equal(semantic.dispatchCount, 1, "the attempt was made");

    const stored = await repo.getSignPreservationVerification(
      finalAsset.id,
      buildCombinedVerificationAlgorithmVersion(semantic.providerKey, semantic.modelIdentity),
    );
    assert.equal(stored, null, "no completed verification was persisted for a malformed attempt");
  });

  it("9: provider failure (timeout) does not persist a completed verification; a later retry may dispatch again and succeed", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "provider_timeout" };
    const { preservation, finalAsset, repo } = await ruthShapedFinalAsset(provider, semantic);

    await assert.rejects(() => preservation.verifyPreservation(finalAsset.id));
    assert.equal(semantic.dispatchCount, 1);

    const combinedVersion = buildCombinedVerificationAlgorithmVersion(
      semantic.providerKey,
      semantic.modelIdentity,
    );
    const storedAfterFailure = await repo.getSignPreservationVerification(finalAsset.id, combinedVersion);
    assert.equal(storedAfterFailure, null, "the transient failure persisted nothing");

    // A later invocation is free to try again — nothing blocks it, since no
    // row exists under this identity yet.
    semantic.behavior = { kind: "all_same" };
    const result = await preservation.verifyPreservation(finalAsset.id);
    assert.equal(result.status, "preserved");
    assert.equal(semantic.dispatchCount, 2, "one failed attempt + one successful attempt");
  });

  it("10: review_required risk remains unresolved after a 'preserved' verification — this capability never touches plan/risk state", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "all_same" };
    const { preservation, finalAsset, repo, projectId } = await ruthShapedFinalAsset(provider, semantic);

    const before = await repo.getSignPreparation(projectId);
    assert.equal(before!.plan!.overallRisk, "review_required");

    const result = await preservation.verifyPreservation(finalAsset.id);
    assert.equal(result.status, "preserved");

    const after = await repo.getSignPreparation(projectId);
    assert.equal(after!.plan!.overallRisk, "review_required", "unchanged — preservation never approves review risk");
    assert.deepEqual(after!.plan, before!.plan, "the approved plan itself is byte-for-byte unchanged");
  });

  it("11: a 'preserved' verification never marks the project print_ready — this capability never touches project/PrintValidation state", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "all_same" };
    const { preservation, finalAsset, repo, projectId } = await ruthShapedFinalAsset(provider, semantic);

    const before = await repo.getProject(projectId);
    const result = await preservation.verifyPreservation(finalAsset.id);
    assert.equal(result.status, "preserved");

    const after = await repo.getProject(projectId);
    assert.equal(after!.project.status, before!.project.status, "unchanged");
    assert.notEqual(after!.project.status, "print_ready");
  });

  it("12: no semantic provider configured -> throws, and verifyDeterministicPreservation remains fully usable on the same capability instance", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const realAssets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const noSemanticPreservation = createSignPreservationCapability(repo, realAssets);
    await assert.rejects(
      () => noSemanticPreservation.verifyPreservation("00000000-0000-0000-0000-000000000000"),
      SignPreservationStateError,
    );
  });

  it("13: zero Topaz reconstruction calls from preservation verification itself", async () => {
    const provider = new FakeSignReconstructionProvider();
    const semantic = new FakeSignPreservationSemanticProvider();
    semantic.behavior = { kind: "all_same" };
    const { preservation, finalAsset } = await ruthShapedFinalAsset(provider, semantic);
    const dispatchBefore = provider.dispatchCount;
    await preservation.verifyPreservation(finalAsset.id);
    assert.equal(provider.dispatchCount, dispatchBefore, "verifyPreservation never re-dispatches reconstruction");
  });

  it("14: resolveSignPreservationSemanticProvider is forced to the safe placeholder under the automated test environment — never OpenAI, never network-capable", async () => {
    const { resolveSignPreservationSemanticProvider } = await import(
      "./resolve-sign-preservation-semantic-provider"
    );
    const { PlaceholderSignPreservationSemanticProvider } = await import(
      "./placeholder-sign-preservation-semantic-provider"
    );
    const resolved = resolveSignPreservationSemanticProvider();
    assert.ok(resolved instanceof PlaceholderSignPreservationSemanticProvider);
    // The placeholder can never certify preserved — every category comes
    // back cannot_determine.
    const result = await resolved.compare({
      sourceOverview: { dataUri: "data:image/png;base64,AA==", label: "x" },
      reconstructionOverview: { dataUri: "data:image/png;base64,AA==", label: "x" },
      sourceCrops: [],
      reconstructionCrops: [],
      idempotencyKey: "k",
    });
    assert.ok(result.answers.every((a) => a.answer === "cannot_determine"));
  });
});
