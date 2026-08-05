import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseStorageAssetProvider } from "./supabase-storage-asset-provider";

interface FakeStorageCalls {
  uploads: Array<{ bucket: string; path: string; bytes: Buffer; options: unknown }>;
  signedUrls: Array<{ bucket: string; path: string; expiresIn: number }>;
  removes: Array<{ bucket: string; paths: string[] }>;
}

function fakeSupabaseClient(overrides: {
  uploadError?: unknown;
  signedUrlError?: unknown;
  signedUrl?: string | null;
  removeError?: unknown;
} = {}): { client: SupabaseClient; calls: FakeStorageCalls } {
  const calls: FakeStorageCalls = { uploads: [], signedUrls: [], removes: [] };

  const client = {
    storage: {
      from(bucket: string) {
        return {
          async upload(objectPath: string, bytes: Buffer, options: unknown) {
            calls.uploads.push({ bucket, path: objectPath, bytes, options });
            if (overrides.uploadError) return { data: null, error: overrides.uploadError };
            return { data: { path: objectPath }, error: null };
          },
          async createSignedUrl(objectPath: string, expiresIn: number) {
            calls.signedUrls.push({ bucket, path: objectPath, expiresIn });
            if (overrides.signedUrlError) {
              return { data: null, error: overrides.signedUrlError };
            }
            const signedUrl =
              "signedUrl" in overrides
                ? overrides.signedUrl
                : `https://signed.example/${objectPath}`;
            return { data: { signedUrl }, error: null };
          },
          async remove(paths: string[]) {
            calls.removes.push({ bucket, paths });
            if (overrides.removeError) return { data: null, error: overrides.removeError };
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

describe("SupabaseStorageAssetProvider", () => {
  it("uploads to the private design-assets bucket using the shared object-key convention", async () => {
    const { client, calls } = fakeSupabaseClient();
    const provider = new SupabaseStorageAssetProvider(client);

    const { objectKey } = await provider.upload({
      projectId: "project-1",
      conceptId: "concept-1",
      fileName: "original.png",
      bytes: Buffer.from("bytes"),
      contentType: "image/png",
    });

    assert.equal(objectKey, "projects/project-1/concepts/concept-1/original.png");
    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.uploads[0]?.bucket, "design-assets");
    assert.equal(calls.uploads[0]?.path, objectKey);
    assert.deepEqual(calls.uploads[0]?.options, {
      contentType: "image/png",
      upsert: false,
    });
  });

  it("propagates an upload error rather than silently succeeding", async () => {
    const { client } = fakeSupabaseClient({ uploadError: new Error("bucket unavailable") });
    const provider = new SupabaseStorageAssetProvider(client);

    await assert.rejects(
      provider.upload({
        projectId: "p",
        conceptId: "c",
        fileName: "original.png",
        bytes: Buffer.from(""),
        contentType: "image/png",
      }),
    );
  });

  it("returns a real signed URL from the storage client", async () => {
    const { client, calls } = fakeSupabaseClient({
      signedUrl: "https://signed.example/projects/p/concepts/c/original.png?token=abc",
    });
    const provider = new SupabaseStorageAssetProvider(client);

    const url = await provider.getSignedUrl("projects/p/concepts/c/original.png", 300);

    assert.equal(url, "https://signed.example/projects/p/concepts/c/original.png?token=abc");
    assert.equal(calls.signedUrls[0]?.expiresIn, 300);
  });

  it("throws if the storage client returns no signed URL", async () => {
    const { client } = fakeSupabaseClient({ signedUrl: null });
    const provider = new SupabaseStorageAssetProvider(client);

    await assert.rejects(provider.getSignedUrl("projects/p/concepts/c/original.png", 300));
  });

  it("removes an object by its object key", async () => {
    const { client, calls } = fakeSupabaseClient();
    const provider = new SupabaseStorageAssetProvider(client);

    await provider.delete("projects/p/concepts/c/original.png");

    assert.equal(calls.removes.length, 1);
    assert.deepEqual(calls.removes[0]?.paths, ["projects/p/concepts/c/original.png"]);
  });

  it("propagates a delete error rather than silently succeeding", async () => {
    const { client } = fakeSupabaseClient({ removeError: new Error("not found") });
    const provider = new SupabaseStorageAssetProvider(client);

    await assert.rejects(provider.delete("projects/p/concepts/c/original.png"));
  });
});
