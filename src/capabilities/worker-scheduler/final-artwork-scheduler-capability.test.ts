import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import { createFinalArtworkSchedulerCapability } from "./final-artwork-scheduler-capability";

/**
 * Make Final Artwork Worker Run Automatically In Production Phase: mirrors
 * `worker-scheduler-capability.test.ts`'s own established pattern for
 * `GenerationSchedulerCapability` exactly — pure orchestration tests
 * against a fake worker, no filesystem, no repo, no provider. The
 * scheduler's own contract (recover, then claim in a bounded loop, then
 * stop; concurrent `runBatch()` calls join the same in-flight batch) is
 * what a production trigger (`.github/workflows/final-artwork-worker.yml`)
 * actually depends on being correct — this file is what makes that
 * dependency more than an assumption. Real end-to-end job processing
 * (claim -> deterministic transform -> asset -> validation -> print-ready)
 * remains `sign-production-delivery.test.ts`'s own job, unduplicated here.
 *
 * `fakeWorker`'s return value only ever implements the two methods
 * `createFinalArtworkSchedulerCapability` actually calls
 * (`processNextJob`/`recoverAbandonedJobs`) — the real
 * `FinalArtworkWorkerCapability` interface carries many more
 * operator-only methods this scheduler never touches, so the fake is
 * deliberately cast rather than fully implemented.
 */
function fakeWorker(
  options: { queue?: string[]; recoveredCount?: number } = {},
): { worker: FinalArtworkWorkerCapability; calls: { processNextJob: number; recoverAbandonedJobs: number } } {
  const queue = [...(options.queue ?? [])];
  const calls = { processNextJob: 0, recoverAbandonedJobs: 0 };

  const worker = {
    async processNextJob() {
      calls.processNextJob += 1;
      const processedJobId = queue.shift() ?? null;
      return { processedJobId };
    },
    async recoverAbandonedJobs() {
      calls.recoverAbandonedJobs += 1;
      return { recoveredCount: options.recoveredCount ?? 0 };
    },
  } as unknown as FinalArtworkWorkerCapability;

  return { worker, calls };
}

describe("FinalArtworkSchedulerCapability", () => {
  it("runBatch recovers first, then drains the queue until empty", async () => {
    const { worker, calls } = fakeWorker({ queue: ["a", "b", "c"], recoveredCount: 2 });
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 10 });

    const result = await scheduler.runBatch();

    assert.deepEqual(result.processedJobIds, ["a", "b", "c"]);
    assert.equal(result.recoveredCount, 2);
    assert.equal(result.limitReached, false);
    assert.equal(calls.recoverAbandonedJobs, 1);
    // 3 successful claims + 1 final call that finds the queue empty.
    assert.equal(calls.processNextJob, 4);
  });

  it("stops at maxJobsPerRun even though more jobs remain queued — the shared MAX_GENERATION_JOBS_PER_RUN knob this scheduler reuses", async () => {
    const { worker } = fakeWorker({ queue: ["a", "b", "c", "d", "e"] });
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 2 });

    const result = await scheduler.runBatch();

    assert.deepEqual(result.processedJobIds, ["a", "b"]);
    assert.equal(result.limitReached, true);
  });

  it("returns an empty batch cleanly when nothing is queued — the ordinary state between customer approvals", async () => {
    const { worker } = fakeWorker({ queue: [] });
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 5 });

    const result = await scheduler.runBatch();

    assert.deepEqual(result.processedJobIds, []);
    assert.equal(result.limitReached, false);
  });

  it("concurrent runBatch calls within one process join the same in-flight batch instead of double-running — the property overlapping GitHub Actions runs of the same trigger rely on within one instance", async () => {
    let resolveFirstClaim: (() => void) | null = null;
    const calls = { processNextJob: 0 };
    const worker = {
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
    } as unknown as FinalArtworkWorkerCapability;
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 5 });

    assert.equal(scheduler.hasActiveBatch(), false);
    const first = scheduler.runBatch();
    const second = scheduler.runBatch();
    assert.equal(scheduler.hasActiveBatch(), true);

    queueMicrotask(() => resolveFirstClaim?.());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(firstResult.processedJobIds, ["only-job"]);
    assert.equal(scheduler.hasActiveBatch(), false);

    // A batch that starts *after* the first one settles is independent —
    // exactly the shape of two separate scheduled trigger invocations,
    // five minutes apart, each running its own fresh batch.
    const third = await scheduler.runBatch();
    assert.deepEqual(third.processedJobIds, []);
  });

  it("a slow provider-backed job (models real Topaz latency) does not block hasActiveBatch from correctly reporting in-flight, and settles cleanly once the provider call resolves", async () => {
    let releaseProvider: (() => void) | undefined;
    const worker = {
      async processNextJob() {
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        return { processedJobId: "slow-topaz-job" };
      },
      async recoverAbandonedJobs() {
        return { recoveredCount: 0 };
      },
    } as unknown as FinalArtworkWorkerCapability;
    const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 1 });

    const batch = scheduler.runBatch();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(scheduler.hasActiveBatch(), true);

    releaseProvider?.();
    const result = await batch;
    assert.deepEqual(result.processedJobIds, ["slow-topaz-job"]);
    assert.equal(scheduler.hasActiveBatch(), false);
  });

  describe("start / stop lifecycle", () => {
    it("start() ticks runBatch repeatedly until stop()", async () => {
      let ticks = 0;
      const worker = {
        async processNextJob() {
          return { processedJobId: null };
        },
        async recoverAbandonedJobs() {
          ticks += 1;
          return { recoveredCount: 0 };
        },
      } as unknown as FinalArtworkWorkerCapability;
      const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 1 });

      assert.equal(scheduler.isRunning(), false);
      scheduler.start(5);
      assert.equal(scheduler.isRunning(), true);

      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      scheduler.stop();
      assert.equal(scheduler.isRunning(), false);
      assert.ok(ticks >= 2, `expected multiple ticks, got ${ticks}`);

      const ticksAtStop = ticks;
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(ticks, ticksAtStop, "no further ticks after stop()");
    });

    it("start() is idempotent — a second call while already running does not create a second timer", () => {
      const worker = {
        async processNextJob() {
          return { processedJobId: null };
        },
        async recoverAbandonedJobs() {
          return { recoveredCount: 0 };
        },
      } as unknown as FinalArtworkWorkerCapability;
      const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 1 });

      scheduler.start(1000);
      scheduler.start(1000);
      assert.equal(scheduler.isRunning(), true);
      scheduler.stop();
      assert.equal(scheduler.isRunning(), false);
    });

    it("stop() is safe to call even when never started", () => {
      const worker = {
        async processNextJob() {
          return { processedJobId: null };
        },
        async recoverAbandonedJobs() {
          return { recoveredCount: 0 };
        },
      } as unknown as FinalArtworkWorkerCapability;
      const scheduler = createFinalArtworkSchedulerCapability(worker, { maxJobsPerRun: 1 });
      assert.doesNotThrow(() => scheduler.stop());
    });
  });
});
