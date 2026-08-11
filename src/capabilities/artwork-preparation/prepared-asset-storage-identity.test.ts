import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  buildObjectKey,
  StrictUniqueKeyAssetStorageProvider,
} from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  BOWLING_FINGER_HOLES,
  bowlingLetterformArtwork,
  darkOutlinedDisplayArtwork,
  getPixel,
  toPngBytes,
} from "./artwork-fixtures";
import {
  createArtworkPreparationCapability,
  type ArtworkPreparationCapability,
} from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { isStalePreparedImageResponse } from "./prepared-revision";

/**
 * Phase 1.4 — prepared-asset storage identity under Supabase-like
 * `upsert: false` semantics.
 *
 * Live root cause: deterministic `prepared-${prepId}-${applied.length}`
 * collided with orphan `-1` objects and returned HTTP 500 ("The resource
 * already exists"), so preparedRevision never advanced. These tests use
 * StrictUniqueKeyAssetStorageProvider so overwrite-friendly backends cannot
 * hide the bug again.
 */
describe("Guided cleanup — unique prepared storage identity (strict upsert:false)", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.Socket.prototype.connect;
  let networkAttempts: string[] = [];

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-prep-storage-id-"));
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
    assert.equal(networkAttempts.length, 0, "suite must stay offline");
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const COUNTER = { x: 70, y: 80 };
  const D = BOWLING_FINGER_HOLES[0]!;
  const R = BOWLING_FINGER_HOLES[1]!;

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(
      repo,
      storage,
      new PngThumbnailGenerator(),
    );
    const capability = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );
    return { repo, assets, capability, storage };
  }

  async function prepareOutlined(
    capability: ArtworkPreparationCapability,
    repo: ProjectRepository,
  ) {
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(darkOutlinedDisplayArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    const view = await capability.prepareBackground(projectId);
    return { projectId, view };
  }

  async function prepareBowling(
    capability: ArtworkPreparationCapability,
    repo: ProjectRepository,
  ) {
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingLetterformArtwork()),
      declaredContentType: "image/png",
      filename: "bowling-synth.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    const view = await capability.prepareBackground(projectId);
    return { projectId, view };
  }

  function preparedStorageKeys(
    storage: StrictUniqueKeyAssetStorageProvider,
    projectId: string,
  ): string[] {
    return storage
      .objectKeys()
      .filter(
        (key) =>
          key.startsWith(`projects/${projectId}/concepts/prepared-`) &&
          key.endsWith("/prepared.png"),
      );
  }

  function conceptFolder(storageKey: string): string {
    const parts = storageKey.split("/");
    // projects/{id}/concepts/{conceptId}/prepared.png
    return parts[3] ?? storageKey;
  }

  async function pixelsFor(
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

  async function confirmAt(
    capability: ArtworkPreparationCapability,
    projectId: string,
    point: { x: number; y: number },
  ) {
    const preview = await capability.previewGuidedCleanup(projectId, point);
    assert.equal(preview.outcome, "preview");
    assert.ok(preview.candidateToken);
    return capability.confirmGuidedCleanup(projectId, preview.candidateToken);
  }

  it("A: first confirm creates a unique prepared storage identity", async () => {
    const { repo, capability, storage } = await build();
    const { projectId, view: automatic } = await prepareOutlined(capability, repo);
    const beforeKeys = preparedStorageKeys(storage, projectId);
    assert.equal(beforeKeys.length, 1);
    const automaticFolder = conceptFolder(beforeKeys[0]!);
    // prepared-{preparationUuid}-{derivationUuid} — never …-{removalCount}.
    assert.match(
      automaticFolder,
      /^prepared-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const confirmed = await confirmAt(capability, projectId, COUNTER);
    assert.equal(confirmed.outcome, "removed");
    const afterKeys = preparedStorageKeys(storage, projectId);
    assert.equal(afterKeys.length, 2);
    const newKey = afterKeys.find((k) => conceptFolder(k) !== automaticFolder);
    assert.ok(newKey);
    assert.notEqual(conceptFolder(newKey), automaticFolder);
    assert.notEqual(confirmed.view.preparedRevision, automatic.preparedRevision);
  });

  it("B: second guided removal creates another unique identity", async () => {
    const { repo, capability, storage } = await build();
    const { projectId } = await prepareBowling(capability, repo);

    await confirmAt(capability, projectId, D);
    const afterD = preparedStorageKeys(storage, projectId);
    assert.equal(afterD.length, 2);

    await confirmAt(capability, projectId, R);
    const afterR = preparedStorageKeys(storage, projectId);
    assert.equal(afterR.length, 3);
    const folders = new Set(afterR.map(conceptFolder));
    assert.equal(folders.size, 3, "every derivation must use a distinct conceptId");
  });

  it("C: undo creates another unique identity even if bytes match a prior derivation", async () => {
    const { repo, assets, capability, storage } = await build();
    const { projectId } = await prepareBowling(capability, repo);

    const dConfirm = await confirmAt(capability, projectId, D);
    const afterDBytes = await assets.downloadAssetBytes(
      (await capability.resolveImageAssetId(projectId, "prepared"))!,
    );
    assert.ok(afterDBytes);
    const dOnlyHash = createHash("sha256").update(afterDBytes.bytes).digest("hex");
    const dOnlyAssetId = await capability.resolveImageAssetId(projectId, "prepared");
    assert.ok(dOnlyAssetId);
    const dOnlyKey = (await assets.listAssets(projectId)).find(
      (a) => a.id === dOnlyAssetId,
    )?.storageKey;
    assert.ok(dOnlyKey);

    await confirmAt(capability, projectId, R);
    const undone = await capability.undoGuidedCleanup(projectId);
    assert.equal(undone.outcome, "undone");
    assert.equal(undone.view.guidedCleanup.removalCount, 1);
    assert.notEqual(undone.view.preparedRevision, dConfirm.view.preparedRevision);

    const afterUndoId = await capability.resolveImageAssetId(projectId, "prepared");
    assert.ok(afterUndoId);
    const afterUndoAsset = (await assets.listAssets(projectId)).find(
      (a) => a.id === afterUndoId,
    );
    assert.ok(afterUndoAsset?.storageKey);
    assert.notEqual(
      afterUndoAsset.storageKey,
      dOnlyKey,
      "undo must not overwrite or reuse the earlier D-only object",
    );

    const undoneBytes = await assets.downloadAssetBytes(afterUndoId);
    assert.ok(undoneBytes);
    assert.equal(
      createHash("sha256").update(undoneBytes.bytes).digest("hex"),
      dOnlyHash,
      "undo may reproduce earlier bytes but under a new identity",
    );
    assert.equal(preparedStorageKeys(storage, projectId).length, 4);
  });

  it("D: existing orphan at the old deterministic -1 key does not block confirmation", async () => {
    const { repo, capability, storage } = await build();
    const { projectId, view: automatic } = await prepareOutlined(capability, repo);
    const preparationId = automatic.preparationId;
    assert.ok(preparationId);

    const orphanKey = buildObjectKey({
      projectId,
      conceptId: `prepared-${preparationId}-1`,
      fileName: "prepared.png",
    });
    storage.seed(orphanKey, Buffer.from("orphan-historical-bytes"));
    assert.ok(storage.has(orphanKey));

    const confirmed = await confirmAt(capability, projectId, COUNTER);
    assert.equal(confirmed.outcome, "removed");
    assert.equal(confirmed.view.guidedCleanup.removalCount, 1);
    assert.notEqual(confirmed.view.preparedRevision, automatic.preparedRevision);
    assert.equal(
      (await storage.download(orphanKey)).toString(),
      "orphan-historical-bytes",
      "orphan must remain untouched",
    );
  });

  it("E: duplicate same confirm stays idempotent and does not create another asset", async () => {
    const { repo, assets, capability, storage } = await build();
    const { projectId } = await prepareOutlined(capability, repo);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.ok(preview.candidateToken);
    const first = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken,
    );
    assert.equal(first.outcome, "removed");
    const keysAfterFirst = preparedStorageKeys(storage, projectId).length;
    const assetCountAfterFirst = (await assets.listAssets(projectId)).length;
    const revisionAfterFirst = first.view.preparedRevision;

    const second = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken,
    );
    assert.equal(second.outcome, "already_removed");
    assert.equal(second.view.preparedRevision, revisionAfterFirst);
    assert.equal(preparedStorageKeys(storage, projectId).length, keysAfterFirst);
    assert.equal((await assets.listAssets(projectId)).length, assetCountAfterFirst);
  });

  it("G/H: D→R accumulates; preparedRevision advances only on persisted derivation", async () => {
    const { repo, assets, capability } = await build();
    const { projectId, view: automatic } = await prepareBowling(capability, repo);
    assert.ok(automatic.preparedRevision);

    const dPreview = await capability.previewGuidedCleanup(projectId, D);
    assert.equal(dPreview.view.preparedRevision, automatic.preparedRevision);

    const dConfirm = await capability.confirmGuidedCleanup(
      projectId,
      dPreview.candidateToken!,
    );
    assert.equal(dConfirm.outcome, "removed");
    assert.equal(dConfirm.view.guidedCleanup.removalCount, 1);
    assert.notEqual(dConfirm.view.preparedRevision, automatic.preparedRevision);
    assert.equal(getPixel(await pixelsFor(capability, assets, projectId), D.x, D.y).a, 0);

    const rPreview = await capability.previewGuidedCleanup(projectId, R);
    assert.equal(rPreview.view.preparedRevision, dConfirm.view.preparedRevision);
    assert.equal(
      getPixel(await pixelsFor(capability, assets, projectId), D.x, D.y).a,
      0,
      "D stays transparent during R preview",
    );

    const rConfirm = await capability.confirmGuidedCleanup(
      projectId,
      rPreview.candidateToken!,
    );
    assert.equal(rConfirm.outcome, "removed");
    assert.equal(rConfirm.view.guidedCleanup.removalCount, 2);
    assert.notEqual(rConfirm.view.preparedRevision, dConfirm.view.preparedRevision);
    const afterR = await pixelsFor(capability, assets, projectId);
    assert.equal(getPixel(afterR, D.x, D.y).a, 0);
    assert.equal(getPixel(afterR, R.x, R.y).a, 0);
  });

  it("I/J: failed storage upload does not advance preparedRevision or guided_cleanup", async () => {
    const { repo, capability, storage } = await build();
    const { projectId, view: automatic } = await prepareOutlined(capability, repo);
    assert.equal(automatic.guidedCleanup.removalCount, 0);

    const preview = await capability.previewGuidedCleanup(projectId, COUNTER);
    assert.ok(preview.candidateToken);
    storage.failNextUpload = true;

    await assert.rejects(
      () => capability.confirmGuidedCleanup(projectId, preview.candidateToken!),
      /Simulated storage upload failure/,
    );

    const after = await capability.getPreparation(projectId);
    assert.ok(after);
    assert.equal(after.preparedRevision, automatic.preparedRevision);
    assert.equal(after.guidedCleanup.removalCount, 0);
    assert.equal(preparedStorageKeys(storage, projectId).length, 1);
  });

  it("K: client refresh gate still follows preparedRevision identity", () => {
    // ChatApp keys image fetches on opaquePreparedRevision; this pins the
    // stale-response helper the effect uses when a newer revision wins a race.
    assert.equal(
      isStalePreparedImageResponse({
        requestRevision: "rev-a",
        authoritativeRevision: "rev-b",
      }),
      true,
    );
    assert.equal(
      isStalePreparedImageResponse({
        requestRevision: "rev-b",
        authoritativeRevision: "rev-b",
      }),
      false,
    );
  });
});
