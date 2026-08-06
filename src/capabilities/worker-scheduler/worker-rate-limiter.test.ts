import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

describe("worker rate limiter (Sprint 2H Part 2B)", () => {
  beforeEach(async () => {
    const { resetWorkerAuthRateLimiterForTests } = await import(
      "./worker-rate-limiter"
    );
    resetWorkerAuthRateLimiterForTests();
  });

  it("does not trip for a handful of failures", async () => {
    const { registerWorkerAuthFailure } = await import("./worker-rate-limiter");
    for (let i = 0; i < 5; i += 1) {
      assert.equal(registerWorkerAuthFailure(), false);
    }
  });

  it("trips once the per-window budget is exceeded", async () => {
    const { registerWorkerAuthFailure } = await import("./worker-rate-limiter");
    let limited = false;
    for (let i = 0; i < 25; i += 1) {
      limited = registerWorkerAuthFailure();
    }
    assert.equal(limited, true);
  });

  it("reset makes the limiter available again", async () => {
    const { registerWorkerAuthFailure, resetWorkerAuthRateLimiterForTests } =
      await import("./worker-rate-limiter");
    for (let i = 0; i < 25; i += 1) registerWorkerAuthFailure();
    resetWorkerAuthRateLimiterForTests();
    assert.equal(registerWorkerAuthFailure(), false);
  });
});
