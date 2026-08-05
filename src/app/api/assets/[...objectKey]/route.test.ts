import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

describe("GET /api/assets/[...objectKey] (Sprint 2H Part 2A)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-asset-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function upload() {
    const { FilesystemAssetStorageProvider } = await import(
      "@/capabilities/asset-storage"
    );
    const provider = new FilesystemAssetStorageProvider();
    const { objectKey } = await provider.upload({
      projectId: "project-1",
      conceptId: "concept-1",
      fileName: "original.png",
      bytes: Buffer.from("fake-png-bytes"),
      contentType: "image/png",
    });
    return { provider, objectKey };
  }

  it("serves the file for a valid, unexpired signed URL", async () => {
    const { objectKey } = await upload();
    const { signAssetToken } = await import("@/capabilities/asset-storage");
    const expires = Date.now() + 60_000;
    const token = signAssetToken(objectKey, expires);

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/assets/${objectKey}?expires=${expires}&token=${token}`),
      { params: Promise.resolve({ objectKey: objectKey.split("/") }) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.toString("utf8"), "fake-png-bytes");
  });

  it("rejects a missing or invalid token with 403, never serving the file", async () => {
    const { objectKey } = await upload();

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/assets/${objectKey}?expires=${Date.now() + 60_000}&token=deadbeef`),
      { params: Promise.resolve({ objectKey: objectKey.split("/") }) },
    );

    assert.equal(response.status, 403);
  });

  it("rejects an expired signed URL with 403", async () => {
    const { objectKey } = await upload();
    const { signAssetToken } = await import("@/capabilities/asset-storage");
    const expires = Date.now() - 1000;
    const token = signAssetToken(objectKey, expires);

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/assets/${objectKey}?expires=${expires}&token=${token}`),
      { params: Promise.resolve({ objectKey: objectKey.split("/") }) },
    );

    assert.equal(response.status, 403);
  });

  it("returns 404 for an asset that was never uploaded, even with a validly signed token", async () => {
    const objectKey = "projects/ghost/concepts/ghost/original.png";
    const { signAssetToken } = await import("@/capabilities/asset-storage");
    const expires = Date.now() + 60_000;
    const token = signAssetToken(objectKey, expires);

    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/assets/${objectKey}?expires=${expires}&token=${token}`),
      { params: Promise.resolve({ objectKey: objectKey.split("/") }) },
    );

    assert.equal(response.status, 404);
  });

  it("rejects path-traversal object keys with 400 even when the token is valid", async () => {
    const traversalKeys = [
      ["..", "secret"],
      ["projects", "abc", "..", "..", "secret"],
    ];

    const { signAssetToken, GET } = await importRouteAndToken();

    for (const segments of traversalKeys) {
      const objectKey = segments.join("/");
      const expires = Date.now() + 60_000;
      const token = signAssetToken(objectKey, expires);
      const response = await GET(
        new Request(
          `http://localhost/api/assets/${segments.map(encodeURIComponent).join("/")}?expires=${expires}&token=${token}`,
        ),
        { params: Promise.resolve({ objectKey: segments }) },
      );
      assert.equal(
        response.status,
        400,
        `expected 400 for traversal key ${JSON.stringify(objectKey)}`,
      );
    }
  });
});

async function importRouteAndToken() {
  const { signAssetToken } = await import("@/capabilities/asset-storage");
  const { GET } = await import("./route");
  return { signAssetToken, GET };
}
