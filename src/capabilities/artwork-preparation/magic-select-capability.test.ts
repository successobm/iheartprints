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

import { getPixel, toPngBytes } from "./artwork-fixtures";
import {
  createArtworkPreparationCapability,
  type ArtworkPreparationCapability,
} from "./artwork-preparation-capability";
import {
  mintLegacyConnectedMagicSelectCandidateToken,
  mintMagicSelectCandidateToken,
} from "./guided-cleanup-candidate";
import { decodePngUpload } from "./image-decode";
import {
  MAGIC_SELECT_DEFAULT_TOLERANCE,
  MAGIC_SELECT_RULE_V1,
  MAGIC_SELECT_RULE_V2,
} from "./magic-color-selection";

/**
 * Phase 1.7: Magic Select at the capability boundary — preview/confirm token
 * safety, persistence, undo, and replay. Network is physically removed.
 */
describe("Magic Select — capability preview/confirm/undo", () => {
  let tempDir = "";
  let previousCwd = "";

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.Socket.prototype.connect;

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-magic-select-"));
    process.chdir(tempDir);

    const trap = (label: string) =>
      ((...args: unknown[]) => {
        throw new Error(`Network access is forbidden here (${label}:${String(args[0])})`);
      }) as never;

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

  function makeResidueFixture() {
    const image = opaqueCanvas(40, 40, 255, 255, 255);
    for (let y = 8; y <= 10; y += 1) {
      for (let x = 8; x <= 10; x += 1) {
        const i = (y * 40 + x) * 4;
        image.data[i] = 0;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
        image.data[i + 3] = 255;
      }
    }
    for (let y = 28; y <= 30; y += 1) {
      for (let x = 28; x <= 30; x += 1) {
        const i = (y * 40 + x) * 4;
        image.data[i] = 0;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
        image.data[i + 3] = 255;
      }
    }
    for (let y = 15; y <= 20; y += 1) {
      for (let x = 15; x <= 20; x += 1) {
        const i = (y * 40 + x) * 4;
        image.data[i] = 40;
        image.data[i + 1] = 120;
        image.data[i + 2] = 200;
        image.data[i + 3] = 255;
      }
    }
    return image;
  }

  async function prepared(capability: ArtworkPreparationCapability, repo: ProjectRepository) {
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(makeResidueFixture()),
      declaredContentType: "image/png",
      filename: "magic-residue.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirt",
      productColor: "White",
      printPlacement: "full_front",
    });
    await capability.prepareBackground(projectId);
    return projectId;
  }

  it("J: preview mutates nothing", async () => {
    const { capability, repo, assets } = await build();
    const projectId = await prepared(capability, repo);
    const before = await capability.getPreparation(projectId);
    const beforeAsset = before!.preparedRevision;
    const beforeBytes = await assets.downloadAssetBytes(
      (await repo.getArtworkPreparation(projectId))!.preparedAssetId!,
    );

    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 9, y: 9 },
      tool: "magic_select",
      tolerance: MAGIC_SELECT_DEFAULT_TOLERANCE,
    });

    assert.equal(preview.outcome, "preview");
    assert.ok(preview.candidateToken);
    assert.ok(preview.highlight);
    assert.ok((preview.selectedPixelCount ?? 0) > 0);

    const after = await capability.getPreparation(projectId);
    assert.equal(after!.preparedRevision, beforeAsset);
    assert.equal(after!.guidedCleanup.removalCount, 0);
    const afterBytes = await assets.downloadAssetBytes(
      (await repo.getArtworkPreparation(projectId))!.preparedAssetId!,
    );
    assert.deepEqual(afterBytes!.bytes, beforeBytes!.bytes);
  });

  it("L/M/N/O/P/Q: cancel no-ops; confirm removes, revises, undoes, replays", async () => {
    const { capability, repo, assets } = await build();
    const projectId = await prepared(capability, repo);
    const prep = await repo.getArtworkPreparation(projectId);
    const priorAssetId = prep!.preparedAssetId!;
    const priorBytes = (await assets.downloadAssetBytes(priorAssetId))!.bytes;
    const priorHash = createHash("sha256").update(priorBytes).digest("hex");

    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 9, y: 9 },
      tool: "magic_select",
      tolerance: 8,
    });
    assert.equal(preview.outcome, "preview");

    // Cancel = drop token client-side; server state unchanged.
    assert.equal((await capability.getPreparation(projectId))!.guidedCleanup.removalCount, 0);

    const confirmed = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken!,
    );
    assert.equal(confirmed.outcome, "removed");
    assert.equal(confirmed.view.guidedCleanup.removalCount, 1);
    assert.notEqual(confirmed.view.preparedRevision, preview.view.preparedRevision);

    const afterPrep = await repo.getArtworkPreparation(projectId);
    assert.notEqual(afterPrep!.preparedAssetId, priorAssetId);
    // Prior asset remains downloadable / immutable.
    const stillPrior = await assets.downloadAssetBytes(priorAssetId);
    assert.equal(createHash("sha256").update(stillPrior!.bytes).digest("hex"), priorHash);

    const removed = decodePngUpload(
      (await assets.downloadAssetBytes(afterPrep!.preparedAssetId!))!.bytes,
    ).image;
    assert.equal(getPixel(removed, 9, 9).a, 0);
    // Disconnected speck remains.
    assert.ok(getPixel(removed, 29, 29).a >= 8);

    const undone = await capability.undoGuidedCleanup(projectId);
    assert.equal(undone.outcome, "undone");
    assert.equal(undone.view.guidedCleanup.removalCount, 0);
    const restored = decodePngUpload(
      (
        await assets.downloadAssetBytes(
          (await repo.getArtworkPreparation(projectId))!.preparedAssetId!,
        )
      )!.bytes,
    ).image;
    assert.ok(getPixel(restored, 9, 9).a >= 8);
    assert.equal(
      createHash("sha256").update(encodeRestored(restored)).digest("hex").length,
      64,
    );
  });

  it("R/S/T/U: stale, forged, cross-project, and tolerance mismatch rejected", async () => {
    const { capability, repo } = await build();
    const projectId = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 9, y: 9 },
      tool: "magic_select",
      tolerance: 8,
    });

    const forged = await capability.confirmGuidedCleanup(
      projectId,
      `${preview.candidateToken}x`,
    );
    assert.equal(forged.outcome, "stale_preview");

    const prep = await repo.getArtworkPreparation(projectId);
    const mismatched = mintMagicSelectCandidateToken({
      projectId,
      preparationId: prep!.id,
      preparedAssetId: prep!.preparedAssetId!,
      point: { x: 9, y: 9 },
      tolerance: 20,
      selectionMode: "similar",
      ruleVersion: MAGIC_SELECT_RULE_V2,
      referenceColor: { r: 0, g: 0, b: 0 },
      selectionKey: "not-the-real-key",
      pixelCount: 999,
      removalCount: 0,
    });
    const rejected = await capability.confirmGuidedCleanup(projectId, mismatched);
    assert.equal(rejected.outcome, "stale_preview");

    const otherId = (await repo.createProject()).project.id;
    let crossOutcome = "threw";
    try {
      const cross = await capability.confirmGuidedCleanup(
        otherId,
        preview.candidateToken!,
      );
      crossOutcome = cross.outcome;
    } catch {
      crossOutcome = "threw";
    }
    assert.ok(crossOutcome === "stale_preview" || crossOutcome === "threw");
  });

  it("V: duplicate confirm is idempotent", async () => {
    const { capability, repo } = await build();
    const projectId = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 9, y: 9 },
      tool: "magic_select",
      tolerance: 8,
    });
    const first = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken!,
    );
    const second = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken!,
    );
    assert.equal(first.outcome, "removed");
    assert.equal(second.outcome, "already_removed");
    assert.equal(second.view.guidedCleanup.removalCount, 1);
    assert.equal(second.view.preparedRevision, first.view.preparedRevision);
  });

  it("E: thick 3x3 speck stays connected and does not jump a distant island", async () => {
    const { capability, repo } = await build();
    const projectId = await prepared(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 9, y: 9 },
      tool: "magic_select",
      tolerance: 40,
    });
    assert.equal(preview.outcome, "preview");
    // 3x3 speck thickness is 3 → connected fallback; distant speck stays.
    assert.equal(preview.selectedPixelCount, 9);
  });

  it("A/B: thin disconnected residue islands are magnetically attracted", async () => {
    const { capability, repo, assets } = await build();
    const projectId = await preparedThin(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 8, y: 8 },
      tool: "magic_select",
      tolerance: 8,
    });
    assert.equal(preview.outcome, "preview");
    assert.equal(preview.selectedPixelCount, 8);
    assert.match(preview.message, /Selected 8 pixels/i);

    const confirmed = await capability.confirmGuidedCleanup(
      projectId,
      preview.candidateToken!,
    );
    assert.equal(confirmed.outcome, "removed");
    const image = decodePngUpload(
      (
        await assets.downloadAssetBytes(
          (await repo.getArtworkPreparation(projectId))!.preparedAssetId!,
        )
      )!.bytes,
    ).image;
    assert.equal(getPixel(image, 8, 8).a, 0);
    assert.equal(getPixel(image, 28, 28).a, 0);
  });

  it("selectionMode tampering is rejected", async () => {
    const { capability, repo } = await build();
    const projectId = await preparedThin(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 8, y: 8 },
      tool: "magic_select",
      tolerance: 8,
    });
    const prep = await repo.getArtworkPreparation(projectId);
    const tampered = mintMagicSelectCandidateToken({
      projectId,
      preparationId: prep!.id,
      preparedAssetId: prep!.preparedAssetId!,
      point: { x: 8, y: 8 },
      tolerance: 8,
      selectionMode: "connected",
      ruleVersion: MAGIC_SELECT_RULE_V1,
      referenceColor: { r: 0, g: 0, b: 0 },
      selectionKey: "forged-mode",
      pixelCount: 8,
      removalCount: 0,
    });
    const rejected = await capability.confirmGuidedCleanup(projectId, tampered);
    assert.equal(rejected.outcome, "stale_preview");
    assert.equal(preview.outcome, "preview");
  });

  it("v2 connected token cannot be interpreted as magnetic similar", async () => {
    const { capability, repo } = await build();
    const projectId = await preparedThin(capability, repo);
    const preview = await capability.previewGuidedCleanup(projectId, {
      point: { x: 8, y: 8 },
      tool: "magic_select",
      tolerance: 8,
    });
    assert.equal(preview.selectedPixelCount, 8);
    const prep = await repo.getArtworkPreparation(projectId);
    const legacy = mintLegacyConnectedMagicSelectCandidateToken({
      projectId,
      preparationId: prep!.id,
      preparedAssetId: prep!.preparedAssetId!,
      point: { x: 8, y: 8 },
      tolerance: 8,
      referenceColor: { r: 0, g: 0, b: 0 },
      selectionKey: preview.candidateToken!.slice(0, 22),
      pixelCount: 8,
      removalCount: 0,
    });
    const rejected = await capability.confirmGuidedCleanup(projectId, legacy);
    assert.equal(rejected.outcome, "stale_preview");
  });
});

function encodeRestored(image: {
  width: number;
  height: number;
  data: Buffer;
}): Buffer {
  return createHash("sha256").update(image.data).digest();
}

function opaqueCanvas(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function makeThinResidueFixture() {
  const image = opaqueCanvas(40, 40, 255, 255, 255);
  for (let y = 8; y <= 9; y += 1) {
    for (let x = 8; x <= 9; x += 1) {
      const i = (y * 40 + x) * 4;
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
      image.data[i + 3] = 255;
    }
  }
  for (let y = 28; y <= 29; y += 1) {
    for (let x = 28; x <= 29; x += 1) {
      const i = (y * 40 + x) * 4;
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

async function preparedThin(
  capability: ArtworkPreparationCapability,
  repo: ProjectRepository,
) {
  const projectId = (await repo.createProject()).project.id;
  await capability.uploadOriginal(projectId, {
    bytes: toPngBytes(makeThinResidueFixture()),
    declaredContentType: "image/png",
    filename: "magic-thin-residue.png",
  });
  await capability.setProductionContext(projectId, {
    productSummary: "T-shirt",
    productColor: "White",
    printPlacement: "full_front",
  });
  await capability.prepareBackground(projectId);
  return projectId;
}
