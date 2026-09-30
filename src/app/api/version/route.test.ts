import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const ENV_KEYS = [
  "GIT_SHA",
  "NODE_ENV",
  "WORKER_SECRET",
  "TOPAZ_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

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

const routeSourcePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "route.ts",
);

describe("GET /api/version (production build version endpoint)", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("returns 200 with the exact SHA and environment when build metadata exists", async () => {
    process.env.GIT_SHA = "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8";
    process.env.NODE_ENV = "production";

    const { GET } = await import("./route");
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      gitSha: "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8",
      environment: "production",
    });
  });

  it("reflects the environment/build marker correctly", async () => {
    process.env.GIT_SHA = "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8";
    process.env.NODE_ENV = "development";

    const { GET } = await import("./route");
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.environment, "development");
  });

  it("does not leak secrets or extra environment values", async () => {
    process.env.GIT_SHA = "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8";
    process.env.NODE_ENV = "production";
    process.env.WORKER_SECRET = "sentinel-worker-secret";
    process.env.TOPAZ_API_KEY = "sentinel-topaz-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sentinel-service-role-key";

    const { GET } = await import("./route");
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), ["environment", "gitSha", "ok"]);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("sentinel-worker-secret"));
    assert.ok(!serialized.includes("sentinel-topaz-key"));
    assert.ok(!serialized.includes("sentinel-service-role-key"));
  });

  it("fails closed with a non-200 and no fabricated SHA when build metadata is missing", async () => {
    restoreEnv({});
    process.env.NODE_ENV = "production";

    const { GET } = await import("./route");
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.gitSha, null);
    for (const fabricated of ["unknown", "latest", "unknown-main", "production"]) {
      assert.notEqual(body.gitSha, fabricated);
    }
  });

  for (const malformed of [
    "not-a-sha",
    "7fbe2d2",
    "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e", // 39 chars
    "7FBE2D295A3DED1313E4E6711BB7E1F7F765A8E8", // uppercase
  ]) {
    it(`fails closed with 503 for a malformed GIT_SHA (${JSON.stringify(malformed)})`, async () => {
      process.env.GIT_SHA = malformed;
      process.env.NODE_ENV = "production";

      const { GET } = await import("./route");
      const response = await GET();
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.gitSha, null);
    });
  }

  it("sets cache-control: no-store so the answer is never served stale", async () => {
    process.env.GIT_SHA = "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8";

    const { GET } = await import("./route");
    const response = await GET();

    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("is read-only, with no capability/database/provider dependency", () => {
    const source = readFileSync(routeSourcePath, "utf8");
    assert.ok(!source.includes("@/capabilities"));
    assert.ok(!source.includes("@/lib/db"));
    assert.ok(!source.includes("@/lib/services"));
  });
});
