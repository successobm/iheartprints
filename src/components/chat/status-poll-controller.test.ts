import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStatusPollController } from "./status-poll-controller";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createStatusPollController (finalization / generation polling)", () => {
  it("A: preparing starts polling", async () => {
    let polls = 0;
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 20,
      pollStatus: async () => {
        polls += 1;
        return "preparing";
      },
      refreshSnapshot: async () => {
        throw new Error("snapshot must not refresh while still preparing");
      },
    });

    const stop = controller.start();
    await sleep(70);
    stop();

    assert.ok(polls >= 2, `expected at least 2 polls, got ${polls}`);
  });

  it("B: print_ready refreshes the snapshot and stops polling", async () => {
    let polls = 0;
    let refreshes = 0;
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 20,
      pollStatus: async () => {
        polls += 1;
        return polls === 1 ? "preparing" : "print_ready";
      },
      refreshSnapshot: async () => {
        refreshes += 1;
      },
    });

    const stop = controller.start();
    await sleep(80);
    const pollsAfterReady = polls;
    await sleep(50);
    stop();

    assert.equal(refreshes, 1);
    assert.equal(polls, pollsAfterReady, "polling must stop after print_ready");
  });

  it("C: needs_review refreshes the snapshot and stops polling", async () => {
    let polls = 0;
    let refreshes = 0;
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 20,
      pollStatus: async () => {
        polls += 1;
        return polls === 1 ? "preparing" : "needs_review";
      },
      refreshSnapshot: async () => {
        refreshes += 1;
      },
    });

    const stop = controller.start();
    await sleep(80);
    const pollsAfterReview = polls;
    await sleep(50);
    stop();

    assert.equal(refreshes, 1);
    assert.equal(polls, pollsAfterReview, "polling must stop after needs_review");
  });

  it("D: unmount / project change stops polling", async () => {
    let polls = 0;
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 20,
      pollStatus: async () => {
        polls += 1;
        return "preparing";
      },
      refreshSnapshot: async () => {},
    });

    const stop = controller.start();
    await sleep(50);
    assert.ok(polls >= 1);
    stop();

    const pollsAtStop = polls;
    await sleep(60);
    assert.equal(polls, pollsAtStop);
  });

  it("survives a React Strict Mode mount -> cleanup -> mount double-invoke", async () => {
    let polls = 0;
    let refreshes = 0;
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 20,
      pollStatus: async () => {
        polls += 1;
        return polls >= 3 ? "print_ready" : "preparing";
      },
      refreshSnapshot: async () => {
        refreshes += 1;
      },
    });

    const stop1 = controller.start();
    stop1();

    const stop2 = controller.start();
    await sleep(100);
    stop2();

    assert.ok(polls >= 1, "the kept mount must poll");
    assert.equal(refreshes, 1);
  });

  it("stops polling after too many consecutive errors rather than looping forever", async () => {
    let polls = 0;
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 15,
      maxConsecutiveErrors: 3,
      pollStatus: async () => {
        polls += 1;
        throw new Error("transient");
      },
      refreshSnapshot: async () => {},
    });

    const stop = controller.start();
    await sleep(100);
    const pollsAfterBudget = polls;
    await sleep(50);
    stop();

    assert.equal(pollsAfterBudget, 3);
    assert.equal(polls, pollsAfterBudget);
  });

  it("a late in-flight tick after cleanup must not refresh the snapshot", async () => {
    let refreshes = 0;
    const pending = deferred<"print_ready">();
    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 20,
      pollStatus: () => pending.promise,
      refreshSnapshot: async () => {
        refreshes += 1;
      },
    });

    const stop = controller.start();
    await sleep(30);
    stop();
    pending.resolve("print_ready");
    await sleep(20);

    assert.equal(refreshes, 0);
  });

  it("does not start a second tick while one poll is still in flight", async () => {
    let polls = 0;
    let overlapping = 0;
    let inFlight = 0;
    const pending = deferred<"preparing">();

    const controller = createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: 15,
      pollStatus: async () => {
        polls += 1;
        inFlight += 1;
        if (inFlight > 1) overlapping += 1;
        try {
          if (polls === 1) return await pending.promise;
          return "preparing";
        } finally {
          inFlight -= 1;
        }
      },
      refreshSnapshot: async () => {},
    });

    const stop = controller.start();
    await sleep(50);
    pending.resolve("preparing");
    await sleep(20);
    stop();

    assert.equal(overlapping, 0);
  });
});
