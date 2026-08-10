import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { bowlingStyleArtwork, toPngBytes } from "./artwork-fixtures";
import { createArtworkPreparationCapability } from "./artwork-preparation-capability";

/**
 * PAID PROVIDER SAFETY — the property Phase 1 must be able to PROVE, not
 * merely assert in prose.
 *
 * Artwork preparation is local and deterministic by construction: the
 * capability's constructor takes a repository, an asset capability, and the
 * brief boundary, and there is no provider port anywhere in the module. This
 * test closes the gap between "by construction" and "verified" by making the
 * process physically unable to reach the network for the duration of a full
 * upload → analyze → prepare → approve run.
 *
 * Any OpenAI call, Topaz call, or segmentation-service call would fail the
 * run loudly instead of quietly spending money.
 */
describe("Artwork preparation makes zero network calls", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;
  const originalNetConnect = net.Socket.prototype.connect;
  let networkAttempts: string[] = [];

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-no-network-"));
    process.chdir(tempDir);

    const trap = (label: string) =>
      ((...args: unknown[]) => {
        networkAttempts.push(`${label}:${String(args[0])}`);
        throw new Error(`Network access is forbidden here (${label})`);
      }) as never;

    globalThis.fetch = trap("fetch");
    http.request = trap("http.request");
    https.request = trap("https.request");
    http.get = trap("http.get");
    https.get = trap("https.get");
    net.Socket.prototype.connect = trap("net.connect");
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    http.get = originalHttpGet;
    https.get = originalHttpsGet;
    net.Socket.prototype.connect = originalNetConnect;
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("runs the whole upload → analyze → prepare → approve flow offline", async () => {
    networkAttempts = [];

    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      // A data-URI store: bytes never leave the process, so even asset
      // storage cannot be the thing that reaches out.
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );

    const projectId = (await repo.createProject()).project.id;

    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await capability.prepareBackground(projectId);
    const approved = await capability.approvePreparedArtwork(projectId);

    assert.equal(approved.approved, true);
    assert.deepEqual(networkAttempts, []);
  });

  it("creates no GenerationJob and no FinalArtworkJob", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
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

    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.prepareBackground(projectId);
    await capability.approvePreparedArtwork(projectId);

    // Uploaded artwork is never dressed up as concept generation, and Phase 1
    // never starts production finalization.
    assert.deepEqual(await repo.listGenerationJobs(projectId), []);
    assert.equal(await repo.getActiveFinalDirectionApproval(projectId), null);
    assert.equal(await repo.claimNextQueuedFinalArtworkJob(), null);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.project.status, "intake");
    assert.equal(snapshot!.designBriefVersions.length, 0);
  });
});
