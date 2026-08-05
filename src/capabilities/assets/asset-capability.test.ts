import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";
import { createAssetCapability } from "./asset-capability";

describe("AssetCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-assets-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(previousCwd);
    await removeTempDir(tempDir);
  });

  it("returns an empty list for a design with no assets", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const assets = createAssetCapability(new LocalProjectRepository());
    const list = await assets.listAssets("no-such-project");
    assert.deepEqual(list, []);
  });

  it("registers an asset and can list it back with all fields intact", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    const assets = createAssetCapability(repo);

    const registered = await assets.registerAsset(created.project.id, {
      kind: "generated_artwork",
      storageKey: "data:image/png;base64,AAAA",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "openai",
      generationJobId: null,
      metadata: { generatedAt: "2026-08-05T00:00:00.000Z" },
      vectorAssetId: null,
      printAssetId: null,
    });

    assert.ok(registered);
    assert.equal(registered?.projectId, created.project.id);
    assert.equal(registered?.kind, "generated_artwork");
    assert.equal(registered?.widthPx, 1024);
    assert.equal(registered?.hasTransparency, true);

    const list = await assets.listAssets(created.project.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, registered?.id);
  });

  it("scopes listing to the requested design only", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo);
    const first = await repo.createProject();
    const second = await repo.createProject();

    await assets.registerAsset(first.project.id, {
      kind: "generated_artwork",
      storageKey: "data:image/png;base64,AAAA",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: null,
      heightPx: null,
      hasTransparency: null,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
    });

    const listForSecond = await assets.listAssets(second.project.id);
    assert.deepEqual(listForSecond, []);
  });

  it("never persists prompt text or credentials in asset metadata by construction", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    const assets = createAssetCapability(repo);

    const registered = await assets.registerAsset(created.project.id, {
      kind: "generated_artwork",
      storageKey: "data:image/png;base64,AAAA",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "openai",
      generationJobId: null,
      metadata: { generatedAt: "2026-08-05T00:00:00.000Z", sizeRequested: "1024x1024" },
      vectorAssetId: null,
      printAssetId: null,
    });

    const serialized = JSON.stringify(registered?.metadata ?? {});
    assert.doesNotMatch(serialized, /sk-|api[_-]?key|revised_prompt/i);
  });
});
