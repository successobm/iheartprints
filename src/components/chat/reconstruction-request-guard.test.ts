import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSingleFlightGuard } from "./reconstruction-request-guard";

describe("G. reconstruction request single-flight guard", () => {
  it("drops a repeat submission while one is in flight, even one made synchronously before the first awaits", async () => {
    const guard = createSingleFlightGuard();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = guard.run(async () => {
      started += 1;
      await gate;
      return "first";
    });
    // Two more clicks in the same tick as the first, and one after a turn.
    const second = guard.run(async () => {
      started += 1;
      return "second";
    });
    const third = guard.run(async () => {
      started += 1;
      return "third";
    });
    await Promise.resolve();
    const fourth = guard.run(async () => {
      started += 1;
      return "fourth";
    });

    assert.equal(guard.inFlight, true);
    assert.equal(await second, null);
    assert.equal(await third, null);
    assert.equal(await fourth, null);
    release();
    assert.equal(await first, "first");
    assert.equal(started, 1, "exactly one request may ever start");
    assert.equal(guard.inFlight, false);
  });

  it("allows a fresh request once the previous one finished, including after a failure", async () => {
    const guard = createSingleFlightGuard();
    await assert.rejects(
      guard.run(async () => {
        throw new Error("network");
      }),
      /network/,
    );
    assert.equal(guard.inFlight, false, "a failed request must release the guard");
    assert.equal(await guard.run(async () => "retry"), "retry");
    assert.equal(await guard.run(async () => "again"), "again");
  });
});
