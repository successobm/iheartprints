import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const ENV_KEYS = ["ASSET_STORAGE_MODE"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

describe("getAssetStorageMode", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("defaults to data_uri when unset", async () => {
    restoreEnv({});
    const { getAssetStorageMode } = await import("./asset-storage-config");
    assert.equal(getAssetStorageMode(), "data_uri");
  });

  it("recognizes supabase_storage and s3", async () => {
    const { getAssetStorageMode } = await import("./asset-storage-config");

    process.env.ASSET_STORAGE_MODE = "supabase_storage";
    assert.equal(getAssetStorageMode(), "supabase_storage");

    process.env.ASSET_STORAGE_MODE = "s3";
    assert.equal(getAssetStorageMode(), "s3");
  });

  it("is case-insensitive and tolerant of surrounding whitespace", async () => {
    process.env.ASSET_STORAGE_MODE = "  S3  ";
    const { getAssetStorageMode } = await import("./asset-storage-config");
    assert.equal(getAssetStorageMode(), "s3");
  });

  it("falls back to data_uri for an unrecognized value", async () => {
    process.env.ASSET_STORAGE_MODE = "azure_blob";
    const { getAssetStorageMode } = await import("./asset-storage-config");
    assert.equal(getAssetStorageMode(), "data_uri");
  });
});

describe("isProductionSafeAssetStorageMode", () => {
  it("data_uri is not production-safe", async () => {
    const { isProductionSafeAssetStorageMode } = await import(
      "./asset-storage-config"
    );
    assert.equal(isProductionSafeAssetStorageMode("data_uri"), false);
  });

  it("supabase_storage and s3 are treated as production-safe by contract", async () => {
    const { isProductionSafeAssetStorageMode } = await import(
      "./asset-storage-config"
    );
    assert.equal(isProductionSafeAssetStorageMode("supabase_storage"), true);
    assert.equal(isProductionSafeAssetStorageMode("s3"), true);
  });
});
