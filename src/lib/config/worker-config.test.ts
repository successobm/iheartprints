import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const ENV_KEYS = [
  "WORKER_SECRET",
  "NODE_ENV",
  "MAX_GENERATION_JOBS_PER_RUN",
  "WORKER_HEARTBEAT_INTERVAL",
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

describe("worker-config (Sprint 2H Part 2B)", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  describe("getWorkerSecret", () => {
    it("returns null when unset", async () => {
      restoreEnv({});
      const { getWorkerSecret } = await import("./worker-config");
      assert.equal(getWorkerSecret(), null);
    });

    it("returns null for a blank/whitespace-only value", async () => {
      process.env.WORKER_SECRET = "   ";
      const { getWorkerSecret } = await import("./worker-config");
      assert.equal(getWorkerSecret(), null);
    });

    it("returns the trimmed configured secret", async () => {
      process.env.WORKER_SECRET = "  super-secret-value  ";
      const { getWorkerSecret } = await import("./worker-config");
      assert.equal(getWorkerSecret(), "super-secret-value");
    });
  });

  describe("isWorkerSecretRequired", () => {
    it("is false outside production", async () => {
      for (const env of ["development", "test", undefined]) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        const { isWorkerSecretRequired } = await import("./worker-config");
        assert.equal(isWorkerSecretRequired(), false);
      }
    });

    it("is true in production", async () => {
      process.env.NODE_ENV = "production";
      const { isWorkerSecretRequired } = await import("./worker-config");
      assert.equal(isWorkerSecretRequired(), true);
    });
  });

  describe("getMaxGenerationJobsPerRun", () => {
    it("defaults to a small positive number when unset", async () => {
      restoreEnv({});
      const { getMaxGenerationJobsPerRun } = await import("./worker-config");
      const value = getMaxGenerationJobsPerRun();
      assert.ok(Number.isInteger(value) && value > 0 && value <= 20);
    });

    it("honors a configured positive integer", async () => {
      process.env.MAX_GENERATION_JOBS_PER_RUN = "12";
      const { getMaxGenerationJobsPerRun } = await import("./worker-config");
      assert.equal(getMaxGenerationJobsPerRun(), 12);
    });

    for (const invalid of ["0", "-3", "not-a-number", "", "  "]) {
      it(`falls back to the default for an invalid value (${JSON.stringify(invalid)})`, async () => {
        process.env.MAX_GENERATION_JOBS_PER_RUN = invalid;
        const { getMaxGenerationJobsPerRun } = await import("./worker-config");
        assert.ok(Number.isInteger(getMaxGenerationJobsPerRun()) && getMaxGenerationJobsPerRun() > 0);
      });
    }
  });

  describe("getWorkerHeartbeatIntervalMs", () => {
    it("defaults to a positive number of milliseconds when unset", async () => {
      restoreEnv({});
      const { getWorkerHeartbeatIntervalMs } = await import("./worker-config");
      assert.ok(getWorkerHeartbeatIntervalMs() > 0);
    });

    it("honors a configured positive integer", async () => {
      process.env.WORKER_HEARTBEAT_INTERVAL = "5000";
      const { getWorkerHeartbeatIntervalMs } = await import("./worker-config");
      assert.equal(getWorkerHeartbeatIntervalMs(), 5000);
    });

    for (const invalid of ["0", "-1", "nonsense"]) {
      it(`falls back to the default for an invalid value (${JSON.stringify(invalid)})`, async () => {
        process.env.WORKER_HEARTBEAT_INTERVAL = invalid;
        const { getWorkerHeartbeatIntervalMs } = await import("./worker-config");
        assert.ok(getWorkerHeartbeatIntervalMs() > 0);
      });
    }
  });
});
