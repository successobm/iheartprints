import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { wakeFinalArtworkWorker } from "./final-artwork-http-wake";

/**
 * Bounded FinalArtwork Production-Execution Repair: unit coverage for the
 * production-only, best-effort, bounded wake trigger. Every scenario here
 * asserts the same invariant from the approved repair contract: "The
 * immediate wake is NOT authoritative. Failure of that wake must leave a
 * durable queued/recoverable job that the recovery scheduler can
 * subsequently advance" — so every failure mode below must resolve
 * (never reject) and must never throw.
 */

function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

/** Captures every `console.error` call made during `fn()`, then restores it — regardless of whether `fn()` throws. */
async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; errorCalls: unknown[][] }> {
  const original = console.error;
  const errorCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  try {
    const result = await fn();
    return { result, errorCalls };
  } finally {
    console.error = original;
  }
}

describe("wakeFinalArtworkWorker", () => {
  it("never calls fetch when the local in-process trigger is allowed (interactive dev)", async () => {
    let called = false;
    await wakeFinalArtworkWorker({
      reason: "test",
      policy: { allowed: true },
      fetchImpl: fakeFetch(() => {
        called = true;
        return new Response(null, { status: 200 });
      }),
    });
    assert.equal(called, false, "dev already gets a prompt worker wake via the in-process trigger");
  });

  it("never calls fetch during automated tests, even with a policy override omitted", async () => {
    // No `policy` override -- exercises the LIVE decision, which the test
    // harness's own IHEARTPRINTS_AUTOMATED_TEST=1 makes "automated_test".
    let called = false;
    await wakeFinalArtworkWorker({
      reason: "test",
      fetchImpl: fakeFetch(() => {
        called = true;
        return new Response(null, { status: 200 });
      }),
    });
    assert.equal(called, false, "automated tests must stay isolated from any network call");
  });

  it("skips the call and logs, without throwing, when WORKER_SECRET is not configured", async () => {
    const previous = process.env.WORKER_SECRET;
    delete process.env.WORKER_SECRET;
    try {
      let called = false;
      const { errorCalls } = await captureConsoleError(() =>
        wakeFinalArtworkWorker({
          reason: "test-no-secret",
          policy: { allowed: false, reason: "production" },
          fetchImpl: fakeFetch(() => {
            called = true;
            return new Response(null, { status: 200 });
          }),
        }),
      );
      assert.equal(called, false);
      assert.equal(errorCalls.length, 1);
      assert.match(String(errorCalls[0]?.[0]), /WORKER_SECRET is not configured/);
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });

  it("posts an authenticated request to the worker route when production + secret + fetch succeeds", async () => {
    const previous = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-secret-not-real";
    try {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      await wakeFinalArtworkWorker({
        reason: "prepare_uploaded_artwork",
        policy: { allowed: false, reason: "production" },
        fetchImpl: fakeFetch((url, init) => {
          calls.push({ url, init });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      });
      assert.equal(calls.length, 1, "exactly one wake call");
      assert.match(calls[0]!.url, /\/api\/worker\/final-artwork$/);
      assert.equal(calls[0]!.init?.method, "POST");
      const headers = calls[0]!.init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer test-secret-not-real");
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });

  it("swallows a fetch rejection (network failure) without throwing", async () => {
    const previous = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-secret-not-real";
    try {
      const { errorCalls } = await captureConsoleError(() =>
        wakeFinalArtworkWorker({
          reason: "network-fail",
          policy: { allowed: false, reason: "production" },
          fetchImpl: fakeFetch(() => {
            throw new TypeError("fetch failed");
          }),
        }),
      );
      assert.equal(errorCalls.length, 1);
      assert.match(String(errorCalls[0]?.[0]), /best-effort wake failed/);
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });

  it("swallows a non-2xx response without throwing", async () => {
    const previous = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-secret-not-real";
    try {
      const { errorCalls } = await captureConsoleError(() =>
        wakeFinalArtworkWorker({
          reason: "server-error",
          policy: { allowed: false, reason: "production" },
          fetchImpl: fakeFetch(() => new Response(null, { status: 500 })),
        }),
      );
      assert.equal(errorCalls.length, 1);
      assert.match(String(errorCalls[0]?.[0]), /HTTP 500/);
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });

  it("aborts and swallows a wake call that never resolves, bounded by its own short timeout", async () => {
    const previous = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-secret-not-real";
    try {
      const startedAt = Date.now();
      const { errorCalls } = await captureConsoleError(() =>
        wakeFinalArtworkWorker({
          reason: "hangs-forever",
          policy: { allowed: false, reason: "production" },
          timeoutMs: 50,
          fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
          }) as typeof fetch,
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 2000, `wake call must be bounded by its own timeout, took ${elapsedMs}ms`);
      assert.equal(errorCalls.length, 1);
      assert.match(String(errorCalls[0]?.[0]), /best-effort wake failed/);
    } finally {
      if (previous === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = previous;
    }
  });
});
