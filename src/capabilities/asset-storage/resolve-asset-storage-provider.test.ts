import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resolveAssetStorageProvider } from "./resolve-asset-storage-provider";

describe("resolveAssetStorageProvider", () => {
  const originalEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };

  afterEach(() => {
    if (originalEnv.NEXT_PUBLIC_SUPABASE_URL === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv.NEXT_PUBLIC_SUPABASE_URL;
    }
    if (originalEnv.SUPABASE_SERVICE_ROLE_KEY === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv.SUPABASE_SERVICE_ROLE_KEY;
    }
    if (originalEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    }
  });

  it("resolves the data URI provider for mode 'data_uri'", () => {
    assert.equal(resolveAssetStorageProvider("data_uri").storageKey, "data_uri");
  });

  it("resolves the filesystem provider for mode 'filesystem'", () => {
    assert.equal(resolveAssetStorageProvider("filesystem").storageKey, "filesystem");
  });

  it("resolves a Supabase-backed provider for mode 'supabase_storage'", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    assert.equal(
      resolveAssetStorageProvider("supabase_storage").storageKey,
      "supabase_storage",
    );
  });

  it("refuses supabase_storage without a service-role key (RLS bypass boundary)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-must-not-suffice";
    assert.throws(
      () => resolveAssetStorageProvider("supabase_storage"),
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it("resolves an s3 stand-in that fails clearly at use, not at resolution (unimplemented)", async () => {
    const provider = resolveAssetStorageProvider("s3");
    assert.equal(provider.storageKey, "s3");
    await assert.rejects(
      provider.upload({
        projectId: "p",
        conceptId: "c",
        fileName: "original.png",
        bytes: Buffer.from(""),
        contentType: "image/png",
      }),
      /not implemented/i,
    );
  });
});
