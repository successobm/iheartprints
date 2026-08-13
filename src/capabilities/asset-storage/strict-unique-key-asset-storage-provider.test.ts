import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildObjectKey } from "./asset-storage-provider";
import { StrictUniqueKeyAssetStorageProvider } from "./strict-unique-key-asset-storage-provider";

describe("StrictUniqueKeyAssetStorageProvider", () => {
  it("F: rejects a duplicate object key like Supabase upsert:false", async () => {
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const input = {
      projectId: "p1",
      conceptId: "prepared-prep-1",
      fileName: "prepared.png",
      bytes: Buffer.from("first"),
      contentType: "image/png",
    };

    const first = await storage.upload(input);
    assert.equal(
      first.objectKey,
      buildObjectKey({
        projectId: "p1",
        conceptId: "prepared-prep-1",
        fileName: "prepared.png",
      }),
    );
    assert.equal(storage.uploadCount, 1);

    await assert.rejects(
      () =>
        storage.upload({
          ...input,
          bytes: Buffer.from("second"),
        }),
      /The resource already exists/,
    );
    assert.equal(storage.uploadCount, 1);
    assert.equal(
      (await storage.download(first.objectKey)).toString(),
      "first",
      "rejected upload must not overwrite historical bytes",
    );
  });

  it("allows distinct conceptIds under the same project", async () => {
    const storage = new StrictUniqueKeyAssetStorageProvider();
    await storage.upload({
      projectId: "p1",
      conceptId: "prepared-a",
      fileName: "prepared.png",
      bytes: Buffer.from("a"),
      contentType: "image/png",
    });
    await storage.upload({
      projectId: "p1",
      conceptId: "prepared-b",
      fileName: "prepared.png",
      bytes: Buffer.from("b"),
      contentType: "image/png",
    });
    assert.equal(storage.uploadCount, 2);
  });
});
