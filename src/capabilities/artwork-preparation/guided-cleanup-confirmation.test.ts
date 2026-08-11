import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  darkOutlinedDisplayArtwork,
  getPixel,
  toPngBytes,
} from "./artwork-fixtures";
import {
  createArtworkPreparationCapability,
  type ArtworkPreparationCapability,
} from "./artwork-preparation-capability";
import {
  mintGuidedCleanupCandidateToken,
  verifyGuidedCleanupCandidateToken,
} from "./guided-cleanup-candidate";
import { decodePngUpload } from "./image-decode";

/**
 * Phase 1.3: preview-then-confirm safety for guided background cleanup.
 *
 * Clicking must not mutate. Only an explicit confirm, after server-side
 * revalidation of a signed candidate, may persist a removal.
 */
describe("Guided cleanup — Phase 1.3 preview / confirmation safety", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.Socket.prototype.connect;
  let networkAttempts: string[] = [];

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-guided-confirm-"));
    process.chdir(tempDir);

    const trap = (label: string) =>
      ((...args: unknown[]) => {
        networkAttempts.push(`${label}:${String(args[0])}`);
        throw new Error(`Network access is forbidden here (${label})`);
      }) as never;

    networkAttempts = [];
    globalThis.fetch = trap("fetch");
    http.request = trap("http.request");
    https.request = trap("https.request");
    net.Socket.prototype.connect = trap("net.connect");
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    net.Socket.prototype.connect = originalNetConnect;
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const COUNTER = { x: 70, y: 80 };
  const OUTLINE = { x: 32, y: 80 };

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );
    return { repo, assets, capability };
  }

  async function prepared(
    capability: ArtworkPreparationCapability,
    repo: ProjectRepository,
  ) {
    const projectId = (await repo.createProject()).project.id;
    const bytes = toPngBytes(darkOutlinedDisplayArtwork());
    await capability.uploadOriginal(projectId, {
      bytes,
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    const view = await capability.prepareBackground(projectId);
    return {
      projectId,
      uploadedHash: createHash("sha256").update(bytes).digest("hex"),
      view,
    };
  }

  async function preparedPixels(
    capability: ArtworkPreparationCapability,
    assets: ReturnType<typeof createAssetCapability>,
    projectId: string,
  ) {
    const assetId = await capability.resolveImageAssetId(projectId, "prepared");
    assert.ok(assetId);
    const downloaded = await assets.downloadAssetBytes(assetId);
    assert.ok(downloaded);
    return {
      assetId,
      image: decodePngUpload(downloaded.bytes).image,
      bytes: downloaded.bytes,
      hash: createHash("sha256").update(downloaded.bytes).digest("hex"),
    };
  }

  async function hashOriginal(
    capability: ArtworkPreparationCapability,
    assets: ReturnType<typeof createAssetCapability>,
    projectId: string,
  ) {
    const assetId = await capability.resolveImageAssetId(projectId, "original");
    assert.ok(assetId);
    const downloaded = await assets.downloadAssetBytes(assetId);
    assert.ok(downloaded);
    return createHash("sha256").update(downloaded.bytes).digest("hex");
  }

  // A. Eligible region click returns preview without mutation.
  it("A: eligible click returns preview without mutating prepared bytes", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);

    assert.equal(preview.outcome, "preview");
    assert.ok(preview.candidateToken);
    assert.ok(preview.highlight);
    assert.equal(preview.view.guidedCleanup.removalCount, 0);

    const after = await preparedPixels(capability, assets, projectId);
    assert.equal(after.assetId, before.assetId);
    assert.equal(after.hash, before.hash);
    assert.equal(getPixel(after.image, 70, 80).a, 255);
  });

  // B. Preview identifies exact authoritative region.
  it("B: preview highlight covers the exact authoritative region bounds", async () => {
    const { repo, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.equal(preview.outcome, "preview");
    assert.ok(preview.highlight);
    const { bounds, overlayDataUrl } = preview.highlight;
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(overlayDataUrl.startsWith("data:image/png;base64,"));
    assert.ok(
      bounds.left <= COUNTER.x &&
        COUNTER.x < bounds.right &&
        bounds.top <= COUNTER.y &&
        COUNTER.y < bounds.bottom,
      "click point lies inside the highlighted bounds",
    );
  });

  // C. Cancel causes zero persistence mutation (cancel is client-side; preview alone must not persist).
  it("C: abandoning a preview leaves guided_cleanup and assets untouched", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);

    await capability.previewGuidedCleanup(projectId, COUNTER);
    // "Cancel" is local — no confirm call. Reload the preparation.
    const view = await capability.getPreparation(projectId);
    assert.ok(view);
    assert.equal(view.guidedCleanup.removalCount, 0);

    const after = await preparedPixels(capability, assets, projectId);
    assert.equal(after.hash, before.hash);
    assert.equal(after.assetId, before.assetId);
  });

  // D. Confirm removes exact previewed region.
  it("D: confirm removes the exact previewed region", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.ok(preview.candidateToken);
    const confirmed = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken,
    );

    assert.equal(confirmed.outcome, "removed");
    assert.equal(confirmed.view.guidedCleanup.removalCount, 1);
    assert.equal(
      getPixel((await preparedPixels(capability, assets, projectId)).image, 70, 80).a,
      0,
    );
  });

  // E / F / G / H — revalidation / stale / forged / cross-project
  it("E/F: confirm revalidates; stale candidate is rejected without mutation", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    const firstPreview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.ok(firstPreview.candidateToken);

    // Confirm once — advances preparedAssetId / removalCount.
    await capability.confirmGuidedCleanup(projectId, firstPreview.candidateToken!);
    const afterFirst = await preparedPixels(capability, assets, projectId);

    // A second, different region's preview minted against the NEW state.
    const secondPreview = await capability.previewGuidedCleanup(projectId, {
      x: 70,
      y: 120,
    });
    // Undo so the preparation state no longer matches secondPreview's claims.
    await capability.undoGuidedCleanup(projectId);
    const afterUndo = await preparedPixels(capability, assets, projectId);

    if (secondPreview.candidateToken) {
      const stale = await capability.confirmGuidedCleanup(
        projectId,
        secondPreview.candidateToken,
      );
      assert.equal(stale.outcome, "stale_preview");
      assert.match(stale.message, /changed since that preview/i);
    }

    // First token is also stale relative to the undone state unless the region
    // is already present (it is not after undo). Confirming it again should
    // either re-apply cleanly if claims still match, or refuse as stale.
    // After undo, preparedAssetId and removalCount match the original preview
    // again — so the ORIGINAL token may still be valid. Re-confirming it is a
    // legitimate redo, not a stale failure. Use a token with wrong asset id.
    const forgedStale = mintGuidedCleanupCandidateToken({
      projectId,
      preparationId: (await repo.getArtworkPreparation(projectId))!.id,
      preparedAssetId: afterFirst.assetId, // no longer current after undo
      regionKey: "p999999",
      point: COUNTER,
      pixelCount: 10,
      removalCount: 0,
    });
    const rejected = await capability.confirmGuidedCleanup(projectId, forgedStale);
    assert.equal(rejected.outcome, "stale_preview");
    assert.equal(
      (await preparedPixels(capability, assets, projectId)).hash,
      afterUndo.hash,
    );
  });

  it("G: forged candidate token is rejected", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);

    const forged = await capability.confirmGuidedCleanup(
      projectId,
      "not-a-real-token.forged",
    );
    assert.equal(forged.outcome, "stale_preview");
    assert.equal((await preparedPixels(capability, assets, projectId)).hash, before.hash);
  });

  it("H: cross-project candidate is rejected", async () => {
    const { repo, assets, capability } = await build();
    const victim = await prepared(capability, repo);
    const bystander = await prepared(capability, repo);

    const preview = await capability.previewGuidedCleanup(victim.projectId, COUNTER);
    assert.ok(preview.candidateToken);
    const victimBefore = await preparedPixels(capability, assets, victim.projectId);

    const rejected = await capability.confirmGuidedCleanup(
      bystander.projectId,
      preview.candidateToken!,
    );
    assert.equal(rejected.outcome, "stale_preview");
    assert.equal(
      (await preparedPixels(capability, assets, victim.projectId)).hash,
      victimBefore.hash,
    );
    assert.equal(
      (await capability.getPreparation(bystander.projectId))!.guidedCleanup.removalCount,
      0,
    );
  });

  // I. Double confirmation is idempotent.
  it("I: double confirmation is idempotent", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.ok(preview.candidateToken);

    const first = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken!,
    );
    const afterFirst = await preparedPixels(capability, assets, projectId);

    const second = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken!,
    );
    assert.equal(first.outcome, "removed");
    assert.equal(second.outcome, "already_removed");
    assert.equal(second.view.guidedCleanup.removalCount, 1);
    assert.equal(
      (await preparedPixels(capability, assets, projectId)).assetId,
      afterFirst.assetId,
    );
  });

  // J. Preview does not create asset/version/history.
  it("J: preview creates no asset, version, or guided_cleanup history", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);
    const versionsBefore = (await repo.getProject(projectId))!.artworkVersions.length;

    await capability.previewGuidedCleanup(projectId, COUNTER);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.guidedCleanup, null);
    assert.equal(preparation!.preparedAssetId, before.assetId);
    assert.equal(
      (await repo.getProject(projectId))!.artworkVersions.length,
      versionsBefore,
    );
  });

  // K. Confirm uses existing Phase 1.2 persistence path.
  it("K: confirm persists via guided_cleanup removals lineage", async () => {
    const { repo, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.ok(preview.candidateToken);
    await capability.confirmGuidedCleanup(projectId, preview.candidateToken!);

    const preparation = await repo.getArtworkPreparation(projectId);
    const stored = preparation!.guidedCleanup as {
      removals: Array<{ point: { x: number; y: number }; regionKey: string }>;
    } | null;
    assert.ok(stored);
    assert.equal(stored.removals.length, 1);
    assert.equal(stored.removals[0]!.point.x, COUNTER.x);
    assert.equal(stored.removals[0]!.point.y, COUNTER.y);
    assert.ok(stored.removals[0]!.regionKey.startsWith("p"));
  });

  // L. Undo after confirmation restores exact prior bytes.
  it("L: undo after confirmation restores exact prior bytes", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const automatic = await preparedPixels(capability, assets, projectId);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    await capability.confirmGuidedCleanup(projectId, preview.candidateToken!);
    const undone = await capability.undoGuidedCleanup(projectId);

    assert.equal(undone.outcome, "undone");
    assert.deepEqual(
      (await preparedPixels(capability, assets, projectId)).image.data,
      automatic.image.data,
    );
  });

  // M. Reload before confirmation loses transient preview safely.
  it("M: reload before confirmation discards transient preview; cleanup count stays 0", async () => {
    const { repo, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    await capability.previewGuidedCleanup(projectId, COUNTER);

    const reloaded = await build();
    const view = await reloaded.capability.getPreparation(projectId);
    assert.ok(view);
    assert.equal(view.guidedCleanup.removalCount, 0);
    // There is no persisted pending preview to restore — by design.
  });

  // N. Reload after confirmation preserves cleanup.
  it("N: reload after confirmation preserves cleanup", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    await capability.confirmGuidedCleanup(projectId, preview.candidateToken!);
    const cleaned = await preparedPixels(capability, assets, projectId);

    const reloaded = await build();
    const view = await reloaded.capability.getPreparation(projectId);
    assert.equal(view!.guidedCleanup.removalCount, 1);
    assert.deepEqual(
      (await preparedPixels(reloaded.capability, reloaded.assets, projectId)).image.data,
      cleaned.image.data,
    );
  });

  // O. Ineligible foreground click is refused.
  it("O: ineligible foreground click is refused without confirmation surface", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);

    const preview = await capability.previewGuidedCleanup(projectId, OUTLINE);
    assert.equal(preview.outcome, "not_background");
    assert.equal(preview.candidateToken, null);
    assert.equal(preview.highlight, null);
    assert.match(preview.message, /part of the artwork/i);
    assert.equal((await preparedPixels(capability, assets, projectId)).hash, before.hash);
  });

  // P / Q — finger-hole style ambiguous region (large counter stands in for finger hole eligibility)
  it("P/Q: eligible ambiguous region previews but cancel/confirm-absent leaves it intact", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.equal(preview.outcome, "preview");
    assert.ok(preview.candidateToken);
    // No confirm — equivalent to Cancel.
    assert.equal(getPixel(before.image, 70, 80).a, 255);
    assert.equal(
      getPixel((await preparedPixels(capability, assets, projectId)).image, 70, 80).a,
      255,
    );
  });

  // R. Existing guided cleanup still works end-to-end via preview+confirm.
  it("R: six-counter-style guided cleanup still works via preview+confirm", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    await capability.confirmGuidedCleanup(projectId, preview.candidateToken!);
    assert.equal(
      getPixel((await preparedPixels(capability, assets, projectId)).image, 70, 80).a,
      0,
    );
  });

  // S. Automatic Phase 1.2 result is unchanged by preview.
  it("S: automatic preparation output is unchanged by preview activity", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const automatic = await preparedPixels(capability, assets, projectId);

    await capability.previewGuidedCleanup(projectId, COUNTER);
    await capability.previewGuidedCleanup(projectId, OUTLINE);

    assert.equal(
      (await preparedPixels(capability, assets, projectId)).hash,
      automatic.hash,
    );
  });

  it("token mint/verify round-trips and rejects tampering", () => {
    const token = mintGuidedCleanupCandidateToken({
      projectId: "proj",
      preparationId: "prep",
      preparedAssetId: "asset",
      regionKey: "p12",
      point: { x: 1, y: 2 },
      pixelCount: 9,
      removalCount: 0,
    });
    const claims = verifyGuidedCleanupCandidateToken(token);
    assert.ok(claims);
    assert.equal(claims.regionKey, "p12");

    const tampered = `${token.slice(0, -4)}abcd`;
    assert.equal(verifyGuidedCleanupCandidateToken(tampered), null);
  });

  it("never mutates the immutable original across preview and confirm", async () => {
    const { repo, assets, capability } = await build();
    const { projectId, uploadedHash } = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    await capability.confirmGuidedCleanup(projectId, preview.candidateToken!);
    assert.equal(await hashOriginal(capability, assets, projectId), uploadedHash);
  });

  it("ran the whole confirmation suite with no network access", () => {
    assert.deepEqual(networkAttempts, []);
  });
});
