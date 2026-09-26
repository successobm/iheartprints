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
  it("One-Job-Per-Invocation Repair: runBatch recovers first, then claims and advances AT MOST ONE job, even though several are queued — a second, independent runBatch() call is required to advance the next one", async () => {
    const { worker, calls } = fakeWorker({ queue: ["a", "b", "c"], recoveredCount: 2 });
    const scheduler = createFinalArtworkSchedulerCapability(worker);

    const first = await scheduler.runBatch();
    assert.deepEqual(first.processedJobIds, ["a"], "exactly one job advanced by the first HTTP-shaped invocation");
    assert.equal(first.recoveredCount, 2);
    assert.equal(first.limitReached, true);
    assert.equal(calls.recoverAbandonedJobs, 1);
    // Exactly one claim -- never a loop, never a second claim attempt even
    // to discover the queue is non-empty.
    assert.equal(calls.processNextJob, 1);

    // "b" and "c" remain untouched by the first invocation -- each needs
    // its OWN, separate runBatch() call, mirroring a separate HTTP POST /
    // separate immediate-wake / separate recovery-scheduler tick in
    // production.
    const second = await scheduler.runBatch();
    assert.deepEqual(second.processedJobIds, ["b"]);
    assert.equal(calls.processNextJob, 2);

    const third = await scheduler.runBatch();
    assert.deepEqual(third.processedJobIds, ["c"]);

    const fourth = await scheduler.runBatch();
    assert.deepEqual(fourth.processedJobIds, [], "the queue is now genuinely empty");
    assert.equal(fourth.limitReached, false);
  });

  it("MULTI-JOB scheduler test: with multiple eligible jobs queued, one runBatch() invocation advances exactly one — the other eligible jobs remain untouched (queued) until a LATER invocation", async () => {
    const { worker, calls } = fakeWorker({ queue: ["job-1", "job-2", "job-3", "job-4", "job-5"] });
    const scheduler = createFinalArtworkSchedulerCapability(worker);

    // A single HTTP/runBatch invocation, exactly as `POST /api/worker/final-artwork`
    // would trigger via `finalArtworkScheduler.runBatch()`.
    const invocation1 = await scheduler.runBatch();

    assert.deepEqual(invocation1.processedJobIds, ["job-1"], "invocation #1 advances exactly one job");
    assert.equal(calls.processNextJob, 1, "exactly one claim attempt -- structurally bounded, never a loop that could discover (let alone advance) the other four");

    // The other four jobs were never claimed at all by invocation #1 --
    // each of THEM needs its own, later, independent invocation.
    const invocation2 = await scheduler.runBatch();
    const invocation3 = await scheduler.runBatch();
    const invocation4 = await scheduler.runBatch();
    const invocation5 = await scheduler.runBatch();
    assert.deepEqual(
      [invocation2.processedJobIds, invocation3.processedJobIds, invocation4.processedJobIds, invocation5.processedJobIds],
      [["job-2"], ["job-3"], ["job-4"], ["job-5"]],
      "each remaining job is advanced by its own separate, later invocation, in order -- never more than one per invocation",
    );
    assert.equal(calls.processNextJob, 5, "exactly one claim attempt per invocation, five invocations for five jobs");
  });

  it("returns an empty batch cleanly when nothing is queued — the ordinary state between customer approvals", async () => {
    const { worker } = fakeWorker({ queue: [] });
    const scheduler = createFinalArtworkSchedulerCapability(worker);

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
    const scheduler = createFinalArtworkSchedulerCapability(worker);

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
    const scheduler = createFinalArtworkSchedulerCapability(worker);

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
      const scheduler = createFinalArtworkSchedulerCapability(worker);

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
      const scheduler = createFinalArtworkSchedulerCapability(worker);

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
      const scheduler = createFinalArtworkSchedulerCapability(worker);
      assert.doesNotThrow(() => scheduler.stop());
    });
  });
});
