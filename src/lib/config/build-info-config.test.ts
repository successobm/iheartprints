import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const ENV_KEYS = ["GIT_SHA", "NODE_ENV"] as const;

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

describe("build-info-config (production build version endpoint)", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  describe("getBuildGitSha", () => {
    it("returns null when unset", async () => {
      restoreEnv({});
      const { getBuildGitSha } = await import("./build-info-config");
      assert.equal(getBuildGitSha(), null);
    });

    it("returns null for a blank/whitespace-only value", async () => {
      process.env.GIT_SHA = "   ";
      const { getBuildGitSha } = await import("./build-info-config");
      assert.equal(getBuildGitSha(), null);
    });

    it("returns the trimmed configured SHA", async () => {
      process.env.GIT_SHA = "  7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8  ";
      const { getBuildGitSha } = await import("./build-info-config");
      assert.equal(
        getBuildGitSha(),
        "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e8",
      );
    });

    it("never fabricates a placeholder for a missing value", async () => {
      restoreEnv({});
      const { getBuildGitSha } = await import("./build-info-config");
      const value = getBuildGitSha();
      assert.notEqual(value, "unknown");
      assert.notEqual(value, "latest");
      assert.notEqual(value, "unknown-main");
    });

    for (const invalid of [
      "not-a-sha",
      "7fbe2d2", // a valid short/abbreviated SHA is still rejected — only the full 40 chars count
      "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e", // 39 chars, one short
      "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8e80", // 41 chars, one long
      "7FBE2D295A3DED1313E4E6711BB7E1F7F765A8E8", // uppercase hex is rejected — must match exactly
      "7fbe2d295a3ded1313e4e6711bb7e1f7f765a8g8", // non-hex character
      "'; DROP TABLE users; --",
    ]) {
      it(`rejects a malformed GIT_SHA rather than trusting it (${JSON.stringify(invalid)})`, async () => {
        process.env.GIT_SHA = invalid;
        const { getBuildGitSha } = await import("./build-info-config");
        assert.equal(getBuildGitSha(), null);
      });
    }
  });

  describe("getRuntimeEnvironment", () => {
    it("defaults to development when unset", async () => {
      restoreEnv({});
      const { getRuntimeEnvironment } = await import("./build-info-config");
      assert.equal(getRuntimeEnvironment(), "development");
    });

    it("reflects NODE_ENV when set", async () => {
      process.env.NODE_ENV = "production";
      const { getRuntimeEnvironment } = await import("./build-info-config");
      assert.equal(getRuntimeEnvironment(), "production");
    });
  });
});
