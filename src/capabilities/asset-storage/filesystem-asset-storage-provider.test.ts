import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { FilesystemAssetStorageProvider } from "./filesystem-asset-storage-provider";
import { buildObjectKey } from "./asset-storage-provider";

describe("FilesystemAssetStorageProvider", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-fs-storage-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("uploads bytes to the same bucket/object-key convention Supabase Storage uses", async () => {
    const provider = new FilesystemAssetStorageProvider();
    const { objectKey } = await provider.upload({
      projectId: "project-1",
      conceptId: "concept-1",
      fileName: "original.png",
      bytes: Buffer.from("hello world"),
      contentType: "image/png",
    });

    assert.equal(
      objectKey,
      buildObjectKey({ projectId: "project-1", conceptId: "concept-1", fileName: "original.png" }),
    );
    assert.equal(objectKey, "projects/project-1/concepts/concept-1/original.png");

    const onDisk = await fs.readFile(path.join(tempDir, ".data", "assets", objectKey));
    assert.equal(onDisk.toString("utf8"), "hello world");
  });

  it("issues a signed URL that expires and rejects a tampered one", async () => {
    const provider = new FilesystemAssetStorageProvider();
    const { objectKey } = await provider.upload({
      projectId: "project-1",
      conceptId: "concept-1",
      fileName: "original.png",
      bytes: Buffer.from("bytes"),
      contentType: "image/png",
    });

    const url = await provider.getSignedUrl(objectKey, 60);
    assert.match(url, /^\/api\/assets\//);
    assert.match(url, /expires=\d+/);
    assert.match(url, /token=[0-9a-f]+/);

    const { verifyAssetToken } = await import("./signed-url-token");
    const parsed = new URL(url, "http://localhost");
    const expires = Number(parsed.searchParams.get("expires"));
    const token = parsed.searchParams.get("token") ?? "";
    assert.equal(verifyAssetToken(objectKey, expires, token), true);

    // A URL issued with an already-past expiry is rejected.
    assert.equal(verifyAssetToken(objectKey, Date.now() - 1, token), false);
  });

  it("deletes stored bytes, and tolerates deleting something already gone", async () => {
    const provider = new FilesystemAssetStorageProvider();
    const { objectKey } = await provider.upload({
      projectId: "project-1",
      conceptId: "concept-1",
      fileName: "original.png",
      bytes: Buffer.from("bytes"),
      contentType: "image/png",
    });

    await provider.delete(objectKey);
    await assert.rejects(() =>
      fs.readFile(path.join(tempDir, ".data", "assets", objectKey)),
    );

    // Deleting again must not throw (ENOENT is swallowed).
    await provider.delete(objectKey);
  });

  it("rejects an object key that attempts to escape the assets directory", async () => {
    const { resolveAssetPath } = await import("./filesystem-paths");
    assert.throws(() => resolveAssetPath("../../../etc/passwd"));
    assert.throws(() => resolveAssetPath("projects/abc/../../secret"));
  });
});
