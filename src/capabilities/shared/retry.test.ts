import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withRetry } from "./retry";

describe("withRetry", () => {
  it("returns the result on the first success without retrying", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      { attempts: 3, isRetryable: () => true },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries a retryable failure and succeeds within the attempt budget", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { attempts: 5, isRetryable: () => true, sleep: async () => {} },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("stops immediately on a non-retryable error", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("permanent");
        },
        { attempts: 5, isRetryable: () => false, sleep: async () => {} },
      ),
      /permanent/,
    );
    assert.equal(calls, 1);
  });

  it("gives up after exhausting the attempt budget and throws the last error", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls}`);
        },
        { attempts: 3, isRetryable: () => true, sleep: async () => {} },
      ),
      /attempt 3/,
    );
    assert.equal(calls, 3);
  });

  it("waits according to the caller's delay schedule between attempts", async () => {
    const delays: number[] = [];
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("fail");
        },
        {
          attempts: 3,
          isRetryable: () => true,
          delayMs: (attempt) => attempt * 100,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    );
    assert.deepEqual(delays, [100, 200]);
    assert.equal(calls, 3);
  });
});
