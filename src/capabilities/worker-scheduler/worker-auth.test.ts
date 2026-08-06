import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const ENV_KEYS = ["WORKER_SECRET", "NODE_ENV"] as const;

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

describe("verifyWorkerSecret (Sprint 2H Part 2B)", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  describe("outside production", () => {
    it("rejects a request with no secret provided, even though nothing is configured", async () => {
      restoreEnv({});
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret(null), {
        authorized: false,
        reason: "missing_secret",
      });
    });

    it("accepts the well-known dev fallback secret when WORKER_SECRET is unset", async () => {
      restoreEnv({});
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(
        verifyWorkerSecret(
          "iheartprints-local-dev-worker-secret-do-not-use-in-production",
        ),
        { authorized: true },
      );
    });

    it("rejects an arbitrary guess when WORKER_SECRET is unset — dev fallback is not 'anything goes'", async () => {
      restoreEnv({});
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret("guessed-value"), {
        authorized: false,
        reason: "invalid_secret",
      });
    });

    it("honors an explicitly configured secret instead of the dev fallback", async () => {
      process.env.WORKER_SECRET = "dev-team-secret";
      process.env.NODE_ENV = "development";
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret("dev-team-secret"), { authorized: true });
      assert.deepEqual(
        verifyWorkerSecret(
          "iheartprints-local-dev-worker-secret-do-not-use-in-production",
        ),
        { authorized: false, reason: "invalid_secret" },
      );
    });
  });

  describe("production", () => {
    it("fails closed when WORKER_SECRET is unset, even with the dev fallback secret", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.WORKER_SECRET;
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(
        verifyWorkerSecret(
          "iheartprints-local-dev-worker-secret-do-not-use-in-production",
        ),
        { authorized: false, reason: "not_configured" },
      );
    });

    it("accepts the exact configured secret", async () => {
      process.env.NODE_ENV = "production";
      process.env.WORKER_SECRET = "a-real-production-secret";
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret("a-real-production-secret"), {
        authorized: true,
      });
    });

    it("rejects a wrong secret", async () => {
      process.env.NODE_ENV = "production";
      process.env.WORKER_SECRET = "a-real-production-secret";
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret("wrong-secret"), {
        authorized: false,
        reason: "invalid_secret",
      });
    });

    it("rejects a secret of a completely different length without throwing", async () => {
      process.env.NODE_ENV = "production";
      process.env.WORKER_SECRET = "a-real-production-secret";
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.doesNotThrow(() => verifyWorkerSecret("x"));
      assert.equal(verifyWorkerSecret("x").authorized, false);
      assert.doesNotThrow(() => verifyWorkerSecret("y".repeat(500)));
      assert.equal(verifyWorkerSecret("y".repeat(500)).authorized, false);
    });

    it("rejects a missing secret", async () => {
      process.env.NODE_ENV = "production";
      process.env.WORKER_SECRET = "a-real-production-secret";
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret(null), {
        authorized: false,
        reason: "missing_secret",
      });
    });

    it("treats a blank configured secret as unconfigured (fails closed)", async () => {
      process.env.NODE_ENV = "production";
      process.env.WORKER_SECRET = "   ";
      const { verifyWorkerSecret } = await import("./worker-auth");
      assert.deepEqual(verifyWorkerSecret("anything"), {
        authorized: false,
        reason: "not_configured",
      });
    });
  });
});
