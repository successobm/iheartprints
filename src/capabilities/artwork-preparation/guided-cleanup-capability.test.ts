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
  ArtworkPreparationStateError,
  createArtworkPreparationCapability,
  type ArtworkPreparationCapability,
} from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";

/**
 * Phase 1.2, Part C at the capability boundary: persistence, lineage, undo,
 * idempotency and ownership.
 *
 * The pure region logic is pinned in `guided-removal.test.ts`. What matters
 * here is everything AROUND it — that the customer's clicks survive a reload,
 * that the immutable original is never touched, that an approved preparation is
 * never rewritten, and that a click cannot cross a project boundary.
 *
 * The whole suite runs with the network physically removed.
 */
describe("Guided cleanup — capability, persistence and lineage", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.Socket.prototype.connect;
  let networkAttempts: string[] = [];

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-guided-cleanup-"));
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

  /** The ambiguous large counter: preserved automatically, removable by a click. */
  const COUNTER = { x: 70, y: 80 };
  /** The customer's dark outline. Never a candidate, at any tolerance. */
  const OUTLINE = { x: 32, y: 80 };

  /**
   * Phase 1.3: preview then confirm — the only mutating path. Keeps these
   * lineage tests focused on persistence while forcing the safety gate.
   */
  async function removeAt(
    capability: ArtworkPreparationCapability,
    projectId: string,
    point: { x: number; y: number },
  ) {
    const preview = await capability.previewGuidedCleanup(projectId, point);
    if (preview.outcome !== "preview" || !preview.candidateToken) {
      return {
        outcome: preview.outcome,
        message: preview.message,
        view: preview.view,
      };
    }
    return capability.confirmGuidedCleanup(projectId, preview.candidateToken);
  }

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

  /** Upload → context → prepare, leaving a project at the "compare" step. */
  async function prepared(capability: ArtworkPreparationCapability, repo: ProjectRepository) {
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
    return { projectId, uploadedHash: createHash("sha256").update(bytes).digest("hex"), view };
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
    return decodePngUpload(downloaded.bytes).image;
  }

  it("removes a preserved ambiguous region when the customer clicks it", async () => {
    const { repo, assets, capability } = await build();
    const { projectId, view } = await prepared(capability, repo);

    assert.equal(view.guidedCleanup.available, true);
    assert.equal(view.guidedCleanup.removalCount, 0);
    assert.equal(getPixel(await preparedPixels(capability, assets, projectId), 70, 80).a, 255);

    const result = await removeAt(capability, projectId, COUNTER);

    assert.equal(result.outcome, "removed");
    assert.equal(result.view.guidedCleanup.removalCount, 1);
    assert.equal(getPixel(await preparedPixels(capability, assets, projectId), 70, 80).a, 0);
  });

  it("is idempotent: clicking the same region twice changes nothing", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    await removeAt(capability, projectId, COUNTER);
    const firstAsset = await capability.resolveImageAssetId(projectId, "prepared");
    const firstBytes = await preparedPixels(capability, assets, projectId);

    // A second click a few pixels away — the same region, which is what a real
    // double click or an impatient customer actually produces.
    const second = await removeAt(capability, projectId, { x: 74, y: 86 });

    assert.equal(second.outcome, "already_removed");
    assert.equal(second.view.guidedCleanup.removalCount, 1, "no second removal recorded");
    assert.equal(
      await capability.resolveImageAssetId(projectId, "prepared"),
      firstAsset,
      "and no second asset was derived",
    );
    assert.deepEqual(
      (await preparedPixels(capability, assets, projectId)).data,
      firstBytes.data,
    );
  });

  it("refuses a click on the customer's dark outline and changes nothing", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const before = await preparedPixels(capability, assets, projectId);
    const beforeAsset = await capability.resolveImageAssetId(projectId, "prepared");

    const result = await removeAt(capability, projectId, OUTLINE);

    assert.equal(result.outcome, "not_background");
    assert.match(result.message, /part of the artwork/i);
    assert.equal(result.view.guidedCleanup.removalCount, 0);
    assert.equal(
      await capability.resolveImageAssetId(projectId, "prepared"),
      beforeAsset,
      "a refusal derives nothing",
    );
    assert.deepEqual(
      (await preparedPixels(capability, assets, projectId)).data,
      before.data,
    );
  });

  it("refuses a forged coordinate safely", async () => {
    const { repo, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    for (const point of [
      { x: 100_000, y: 100_000 },
      { x: -4, y: 12 },
    ]) {
      const result = await removeAt(capability, projectId, point);
      assert.equal(result.outcome, "outside_image");
      assert.equal(result.view.guidedCleanup.removalCount, 0);
    }
  });

  it("undo restores the prior prepared state exactly", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    const automatic = await preparedPixels(capability, assets, projectId);

    await removeAt(capability, projectId, COUNTER);
    assert.equal(getPixel(await preparedPixels(capability, assets, projectId), 70, 80).a, 0);

    const undone = await capability.undoGuidedCleanup(projectId);

    assert.equal(undone.outcome, "undone");
    assert.equal(undone.view.guidedCleanup.removalCount, 0);
    // Byte-identical to the automatic result, because both are the same pure
    // function of the same immutable original and the same (empty) click list.
    assert.deepEqual(
      (await preparedPixels(capability, assets, projectId)).data,
      automatic.data,
    );
  });

  it("undo with nothing to undo is harmless", async () => {
    const { repo, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    const result = await capability.undoGuidedCleanup(projectId);
    assert.equal(result.outcome, "nothing_to_undo");
    assert.equal(result.view.guidedCleanup.removalCount, 0);
  });

  it("survives a reload: a fresh capability reads the same prepared artwork", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);
    await removeAt(capability, projectId, COUNTER);
    const afterCleanup = await preparedPixels(capability, assets, projectId);

    // A completely new capability graph over the same persisted store — the
    // closest this suite gets to a page reload.
    const reloaded = await build();
    const view = await reloaded.capability.getPreparation(projectId);

    assert.ok(view);
    assert.equal(view.guidedCleanup.removalCount, 1, "the clicks survived");
    assert.deepEqual(
      (await preparedPixels(reloaded.capability, reloaded.assets, projectId)).data,
      afterCleanup.data,
      "and the prepared bytes are unchanged",
    );
  });

  it("never modifies the immutable original upload", async () => {
    const { repo, assets, capability } = await build();
    const { projectId, uploadedHash } = await prepared(capability, repo);

    await removeAt(capability, projectId, COUNTER);
    await capability.undoGuidedCleanup(projectId);
    await removeAt(capability, projectId, COUNTER);

    const preparation = await repo.getArtworkPreparation(projectId);
    const original = await assets.downloadAssetBytes(preparation!.originalAssetId);
    assert.equal(
      createHash("sha256").update(original!.bytes).digest("hex"),
      uploadedHash,
      "the customer's upload is byte-identical after three cleanup operations",
    );
  });

  it("derives a NEW asset per cleanup and never overwrites the superseded one", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    const automaticAssetId = (await capability.resolveImageAssetId(projectId, "prepared"))!;
    const automaticBytes = (await assets.downloadAssetBytes(automaticAssetId))!.bytes;

    await removeAt(capability, projectId, COUNTER);
    const cleanedAssetId = (await capability.resolveImageAssetId(projectId, "prepared"))!;

    assert.notEqual(cleanedAssetId, automaticAssetId, "a new asset");
    // The superseded asset still exists and still holds its original bytes:
    // lineage stays readable, and nothing was rewritten in place.
    const superseded = await assets.downloadAssetBytes(automaticAssetId);
    assert.ok(superseded);
    assert.deepEqual(superseded.bytes, automaticBytes);
  });

  it("refuses to touch an APPROVED preparation", async () => {
    const { repo, assets, capability } = await build();
    const { projectId } = await prepared(capability, repo);

    await removeAt(capability, projectId, COUNTER);
    const approved = await capability.approvePreparedArtwork(projectId);
    const approvedAssetId = (await capability.resolveImageAssetId(projectId, "prepared"))!;
    const approvedBytes = (await assets.downloadAssetBytes(approvedAssetId))!.bytes;

    assert.equal(approved.guidedCleanup.available, false, "cleanup is no longer offered");

    await assert.rejects(
      () => removeAt(capability, projectId, { x: 70, y: 120 }),
      ArtworkPreparationStateError,
    );
    await assert.rejects(
      () => capability.undoGuidedCleanup(projectId),
      ArtworkPreparationStateError,
    );

    // The approved artwork — the thing Phase 2 consumes — is untouched.
    assert.equal(
      await capability.resolveImageAssetId(projectId, "prepared"),
      approvedAssetId,
    );
    assert.deepEqual(
      (await assets.downloadAssetBytes(approvedAssetId))!.bytes,
      approvedBytes,
    );
  });

  it("refuses cleanup before anything has been prepared", async () => {
    const { repo, capability } = await build();
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(darkOutlinedDisplayArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });

    await assert.rejects(
      () => removeAt(capability, projectId, COUNTER),
      ArtworkPreparationStateError,
    );
  });

  it("rejects a cleanup aimed at another project", async () => {
    const { repo, assets, capability } = await build();
    const victim = await prepared(capability, repo);
    await removeAt(capability, victim.projectId, COUNTER);
    const victimBytes = await preparedPixels(capability, assets, victim.projectId);

    // A project with no preparation at all cannot borrow the victim's.
    const bystanderId = (await repo.createProject()).project.id;
    await assert.rejects(
      () => removeAt(capability, bystanderId, COUNTER),
      ArtworkPreparationStateError,
    );
    await assert.rejects(
      () => capability.undoGuidedCleanup(bystanderId),
      ArtworkPreparationStateError,
    );

    assert.equal(await capability.resolveImageAssetId(bystanderId, "prepared"), null);
    assert.deepEqual(
      (await preparedPixels(capability, assets, victim.projectId)).data,
      victimBytes.data,
      "the other project's artwork is untouched",
    );
  });

  it("multiple guided removals produce a deterministic final image", async () => {
    const { repo, assets, capability } = await build();
    const first = await prepared(capability, repo);
    await removeAt(capability, first.projectId, COUNTER);
    const firstResult = await preparedPixels(capability, assets, first.projectId);

    // The same clicks, on a different project, from a different capability
    // instance: same bytes out.
    const other = await build();
    const second = await prepared(other.capability, other.repo);
    await removeAt(other.capability, second.projectId, { x: 72, y: 84 });
    const secondResult = await preparedPixels(
      other.capability,
      other.assets,
      second.projectId,
    );

    assert.deepEqual(secondResult.data, firstResult.data);
  });

  it("ran the whole flow with no network access of any kind", () => {
    assert.deepEqual(networkAttempts, []);
  });
});
