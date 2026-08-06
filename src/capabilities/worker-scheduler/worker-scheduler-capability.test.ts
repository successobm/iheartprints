import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createGenerationSchedulerCapability } from "./worker-scheduler-capability";

/**
 * Sprint 2H Part 2B: pure orchestration tests against a fake
 * `GenerationWorkerCapability` — no filesystem, no repo, no provider. The
 * scheduler's contract is entirely about *when* and *how many times* it
 * calls the worker, never about generation itself (that's covered by
 * `generation-worker-capability.test.ts` and
 * `generation-worker-concurrency.test.ts`).
 */
function fakeWorker(options: {
  queue?: string[];
  recoveredCount?: number;
} = {}): { worker: GenerationWorkerCapability; calls: { processNextJob: number; recoverAbandonedJobs: number } } {
  const queue = [...(options.queue ?? [])];
  const calls = { processNextJob: 0, recoverAbandonedJobs: 0 };

  const worker: GenerationWorkerCapability = {
    async processNextJob() {
      calls.processNextJob += 1;
      const processedJobId = queue.shift() ?? null;
      return { processedJobId };
    },
    async recoverAbandonedJobs() {
      calls.recoverAbandonedJobs += 1;
      return { recoveredCount: options.recoveredCount ?? 0 };
    },
  };

  return { worker, calls };
}

describe("GenerationSchedulerCapability (Sprint 2H Part 2B)", () => {
  it("runBatch recovers first, then drains the queue until empty", async () => {
    const { worker, calls } = fakeWorker({ queue: ["a", "b", "c"], recoveredCount: 2 });
    const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 10 });

    const result = await scheduler.runBatch();

    assert.deepEqual(result.processedJobIds, ["a", "b", "c"]);
    assert.equal(result.recoveredCount, 2);
    assert.equal(result.limitReached, false);
    assert.equal(calls.recoverAbandonedJobs, 1);
    // 3 successful claims + 1 final call that finds the queue empty.
    assert.equal(calls.processNextJob, 4);
  });

  it("stops at maxJobsPerRun even though more jobs remain queued", async () => {
    const { worker } = fakeWorker({ queue: ["a", "b", "c", "d", "e"] });
    const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 2 });

    const result = await scheduler.runBatch();

    assert.deepEqual(result.processedJobIds, ["a", "b"]);
    assert.equal(result.limitReached, true);
  });

  it("returns an empty batch cleanly when nothing is queued", async () => {
    const { worker } = fakeWorker({ queue: [] });
    const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 5 });

    const result = await scheduler.runBatch();

    assert.deepEqual(result.processedJobIds, []);
    assert.equal(result.limitReached, false);
  });

  it("concurrent runBatch calls within one process join the same in-flight batch instead of double-running", async () => {
    let resolveFirstClaim: (() => void) | null = null;
    const calls = { processNextJob: 0 };
    const worker: GenerationWorkerCapability = {
      async processNextJob() {
        calls.processNextJob += 1;
        if (calls.processNextJob === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstClaim = resolve;
          });
          return { processedJobId: "only-job" };
        }
        return { processedJobId: null };
      },
      async recoverAbandonedJobs() {
        return { recoveredCount: 0 };
      },
    };
    const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 5 });

    const first = scheduler.runBatch();
    const second = scheduler.runBatch();

    // Let the first claim resolve now that both calls have joined it.
    queueMicrotask(() => resolveFirstClaim?.());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(firstResult.processedJobIds, ["only-job"]);

    // A batch that starts *after* the first one settles is independent.
    const third = await scheduler.runBatch();
    assert.deepEqual(third.processedJobIds, []);
  });

  describe("start / stop lifecycle", () => {
    it("start() ticks runBatch repeatedly until stop()", async () => {
      let ticks = 0;
      const worker: GenerationWorkerCapability = {
        async processNextJob() {
          return { processedJobId: null };
        },
        async recoverAbandonedJobs() {
          ticks += 1;
          return { recoveredCount: 0 };
        },
      };
      const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 1 });

      try {
        assert.equal(scheduler.isRunning(), false);
        scheduler.start(10);
        assert.equal(scheduler.isRunning(), true);

        await new Promise((resolve) => setTimeout(resolve, 55));
        scheduler.stop();
        assert.equal(scheduler.isRunning(), false);

        const ticksAtStop = ticks;
        assert.ok(ticksAtStop >= 2, `expected multiple ticks, got ${ticksAtStop}`);

        // No further ticks after stop().
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(ticks, ticksAtStop);
      } finally {
        // Guarantees the timer never outlives this test, even if an
        // assertion above threw — an uncleared `setInterval` would
        // otherwise hang the whole `node --test` process.
        scheduler.stop();
      }
    });

    it("start() is idempotent — calling it twice does not create two timers", async () => {
      let ticks = 0;
      const worker: GenerationWorkerCapability = {
        async processNextJob() {
          return { processedJobId: null };
        },
        async recoverAbandonedJobs() {
          ticks += 1;
          return { recoveredCount: 0 };
        },
      };
      const scheduler = createGenerationSchedulerCapability(worker, { maxJobsPerRun: 1 });

      try {
        scheduler.start(10);
        scheduler.start(10);
        await new Promise((resolve) => setTimeout(resolve, 55));

        // With two independent timers this would be roughly double.
        assert.ok(ticks <= 8, `expected a single timer's worth of ticks, got ${ticks}`);
      } finally {
        scheduler.stop();
      }
    });

    it("stop() is safe to call when never started", () => {
      const { worker } = fakeWorker();
      const scheduler = createGenerationSchedulerCapability(worker);
      assert.doesNotThrow(() => scheduler.stop());
      assert.equal(scheduler.isRunning(), false);
    });
  });
});
