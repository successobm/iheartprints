import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { SupabaseStorageAssetProvider } from "./supabase-storage-asset-provider";

/**
 * Static security assertions for the private `design-assets` bucket and
 * the signed-URL-only customer access path (Sprint 2H Part 2A Check 1).
 */

const MIGRATION_PATH = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260805140000_background_generation_jobs.sql",
);

const PROVIDER_SOURCE_PATH = path.join(
  process.cwd(),
  "src",
  "capabilities",
  "asset-storage",
  "supabase-storage-asset-provider.ts",
);

describe("design-assets bucket privacy (Sprint 2H Part 2A security)", () => {
  it("registers design-assets as a private bucket (public = false)", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");

    assert.match(
      sql,
      /insert\s+into\s+storage\.buckets\s*\(\s*id\s*,\s*name\s*,\s*public\s*\)/i,
    );
    assert.match(
      sql,
      /values\s*\(\s*'design-assets'\s*,\s*'design-assets'\s*,\s*false\s*\)/i,
    );
    // Re-assert privacy if the row already existed as public.
    assert.match(
      sql,
      /on\s+conflict\s*\(\s*id\s*\)\s+do\s+update\s+set\s+public\s*=\s*excluded\.public/i,
    );

    // No storage.objects policy DDL — deny-by-default RLS + service-role only.
    assert.doesNotMatch(sql, /create\s+policy/i);
    assert.doesNotMatch(sql, /grant\s+.+\s+on\s+storage\.objects/i);
    assert.doesNotMatch(sql, /public\s*=\s*true/i);
  });

  it("never calls getPublicUrl — createSignedUrl is the only customer-access path", () => {
    const source = readFileSync(PROVIDER_SOURCE_PATH, "utf8");
    // Strip block comments so the doc line "never `getPublicUrl`" does not
    // count as a call site.
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(withoutBlockComments, /\.getPublicUrl\b/);
    assert.match(withoutBlockComments, /\.createSignedUrl\b/);
  });

  it("fake storage client used by unit tests has no getPublicUrl surface", async () => {
    // Reconstruct the same shape SupabaseStorageAssetProvider.test uses and
    // prove the provider never attempts a public-URL method.
    const calls: string[] = [];
    const client = {
      storage: {
        from() {
          return new Proxy(
            {},
            {
              get(_target, prop) {
                calls.push(String(prop));
                if (prop === "createSignedUrl") {
                  return async () => ({
                    data: { signedUrl: "https://signed.example/x" },
                    error: null,
                  });
                }
                if (prop === "upload") {
                  return async () => ({ data: { path: "x" }, error: null });
                }
                if (prop === "remove") {
                  return async () => ({ data: [], error: null });
                }
                return async () => {
                  throw new Error(`unexpected storage method: ${String(prop)}`);
                };
              },
            },
          );
        },
      },
    };

    const provider = new SupabaseStorageAssetProvider(client as never);
    await provider.getSignedUrl("projects/p/concepts/c/original.png", 300);
    assert.deepEqual(calls, ["createSignedUrl"]);
    assert.ok(!calls.includes("getPublicUrl"));
  });
});
