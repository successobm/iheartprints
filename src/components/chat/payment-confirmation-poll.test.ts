import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPaymentConfirmationPoll,
  DEFAULT_PAYMENT_POLL_MAX_ATTEMPTS,
} from "./payment-confirmation-poll";

/**
 * Sprint A5.5 — bounded confirmation polling.
 *
 * The scheduler is injected, so every claim here is asserted deterministically
 * rather than by waiting. The property that matters most is `C`: polling
 * STOPS. An unbounded confirmation loop against an abandoned checkout would
 * run for as long as the tab is open, and the copy it drives would keep
 * telling somebody their payment was being confirmed when nobody had paid.
 */

/** Runs queued timers immediately, in order, so a poll sequence is synchronous. */
function immediateScheduler() {
  const queue: Array<() => void> = [];
  let cancelled = new Set<number>();
  let nextHandle = 0;

  return {
    scheduler: {
      setTimeout(fn: () => void) {
        const handle = nextHandle++;
        queue.push(() => {
          if (!cancelled.has(handle)) fn();
        });
        return handle;
      },
      clearTimeout(handle: unknown) {
        cancelled.add(handle as number);
      },
    },
    /**
     * Drains everything the poll queues, including work queued while draining.
     *
     * Flushes microtasks BEFORE each queue check, which is load-bearing: the
     * poll's first tick runs via `void tick()` rather than through the
     * scheduler, so at the instant `drain` is first called the queue is still
     * empty and the follow-up timer has not been scheduled yet. An earlier
     * version checked the queue first and therefore drained nothing, making
     * every multi-attempt assertion silently pass on a single check.
     */
    async drain() {
      for (let guard = 0; guard < 1000; guard += 1) {
        // Let any in-flight async tick settle and schedule its successor.
        for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
        if (queue.length === 0) return;
        queue.shift()!();
      }
    },
    reset() {
      cancelled = new Set<number>();
    },
  };
}

describe("Sprint A5.5 — payment confirmation polling", () => {
  it("A: checks immediately, so a webhook that already landed is not made to wait", async () => {
    const harness = immediateScheduler();
    let checks = 0;

    const stop = createPaymentConfirmationPoll({
      refreshAndCheckUnlocked: async () => {
        checks += 1;
        return true;
      },
      onTimeout: () => assert.fail("must not time out on an immediate success"),
      scheduler: harness.scheduler,
    }).start();

    await harness.drain();
    stop();

    assert.equal(checks, 1, "the first check fires without waiting an interval");
  });

  it("B: stops as soon as the server reports the project unlocked", async () => {
    const harness = immediateScheduler();
    let checks = 0;

    const stop = createPaymentConfirmationPoll({
      refreshAndCheckUnlocked: async () => {
        checks += 1;
        return checks >= 3;
      },
      onTimeout: () => assert.fail("must not time out before the ceiling"),
      scheduler: harness.scheduler,
      maxAttempts: 10,
    }).start();

    await harness.drain();
    stop();

    assert.equal(checks, 3, "polling stops on the answer, not on the ceiling");
  });

  it("C: STOPS at the attempt ceiling and reports the timeout exactly once", async () => {
    const harness = immediateScheduler();
    let checks = 0;
    let timeouts = 0;

    const stop = createPaymentConfirmationPoll({
      // An abandoned checkout: the answer never changes.
      refreshAndCheckUnlocked: async () => {
        checks += 1;
        return false;
      },
      onTimeout: () => {
        timeouts += 1;
      },
      scheduler: harness.scheduler,
      maxAttempts: 5,
    }).start();

    await harness.drain();
    stop();

    assert.equal(checks, 5, "polling must not exceed its ceiling");
    assert.equal(timeouts, 1, "the timeout is announced once, not per attempt");
  });

  it("D: a failing refresh still consumes an attempt", async () => {
    // Otherwise a persistently failing endpoint polls forever — the exact
    // unbounded loop this controller exists to prevent.
    const harness = immediateScheduler();
    let checks = 0;
    let timeouts = 0;

    const stop = createPaymentConfirmationPoll({
      refreshAndCheckUnlocked: async () => {
        checks += 1;
        throw new Error("network");
      },
      onTimeout: () => {
        timeouts += 1;
      },
      scheduler: harness.scheduler,
      maxAttempts: 4,
    }).start();

    await harness.drain();
    stop();

    assert.equal(checks, 4);
    assert.equal(timeouts, 1);
  });

  it("E: cancelling stops the loop and suppresses a pending timeout", async () => {
    const harness = immediateScheduler();
    let checks = 0;
    let timeouts = 0;

    const stop = createPaymentConfirmationPoll({
      refreshAndCheckUnlocked: async () => {
        checks += 1;
        return false;
      },
      onTimeout: () => {
        timeouts += 1;
      },
      scheduler: harness.scheduler,
      maxAttempts: 10,
    }).start();

    // The immediate first check has already run; cancel before any scheduled
    // follow-up executes — an unmounting component must not keep polling.
    stop();
    await harness.drain();

    assert.equal(checks, 1);
    assert.equal(timeouts, 0, "a cancelled poll must not announce a timeout");
  });

  it("F: the default ceiling is bounded and modest", () => {
    assert.ok(DEFAULT_PAYMENT_POLL_MAX_ATTEMPTS > 0);
    assert.ok(
      DEFAULT_PAYMENT_POLL_MAX_ATTEMPTS <= 60,
      "a confirmation window measured in minutes, not hours",
    );
  });
});
