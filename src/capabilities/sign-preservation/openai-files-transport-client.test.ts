import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError } from "@/capabilities/providers/provider-error";

import {
  deleteOpenAIFile,
  uploadOpenAIFile,
  OPENAI_FILES_EXPIRES_AFTER_SECONDS,
} from "./openai-files-transport-client";

/**
 * Signs Phase S4.2C.6 (amended S4.2C.6A): direct, isolated coverage of the
 * OpenAI Files transport client — previously only exercised indirectly
 * through `openai-sign-preservation-semantic-provider.test.ts`'s
 * `compare()` flow. Focuses on the network-cause diagnostic improvement
 * (bounded, STRUCTURED-SCALAR-ONLY cause description folded into
 * `ProviderError` — `name`/`code`/`errno`/`syscall` only, NEVER
 * `message`/`cause.message`/stack/the whole error object — dispatch state
 * classified via the existing `classifyFetchRejectionDispatch`) and
 * confirms no retry behavior changed. No real network access, ever.
 */

const FAKE_API_KEY = "sk-test-secret-value";
const SAMPLE_INPUT = {
  filename: "sign-preservation-test.png",
  bytes: Buffer.from([1, 2, 3, 4]),
  contentType: "image/png",
  expiresAfterSeconds: OPENAI_FILES_EXPIRES_AFTER_SECONDS,
};

/**
 * A deliberately HOSTILE `cause.message` — every forbidden string this
 * amendment must guarantee can never appear in a `ProviderError` message,
 * concatenated into one payload, alongside real structured scalar fields
 * that SHOULD be surfaced (`code`/`name`/`errno`/`syscall`).
 */
const HOSTILE_MESSAGE = [
  "sk-test-secret-value",
  "Bearer abc123",
  "Authorization",
  "customer artwork text",
  "purpose=user_data",
  "expires_after[seconds]=3600",
].join(" | ");

function connectionError(overrides: {
  name?: string;
  code?: string;
  errno?: string | number;
  syscall?: string;
  message?: string;
  cause?: Record<string, unknown>;
}) {
  const err = new Error(overrides.message ?? "fetch failed") as Error & {
    code?: string;
    errno?: string | number;
    syscall?: string;
    cause?: unknown;
  };
  if (overrides.name) err.name = overrides.name;
  if (overrides.code) err.code = overrides.code;
  if (overrides.errno !== undefined) err.errno = overrides.errno;
  if (overrides.syscall) err.syscall = overrides.syscall;
  if (overrides.cause) err.cause = overrides.cause;
  return err;
}

/** Asserts none of the hostile-message's component strings (or the fake API key/Authorization/Bearer) ever appear in a `ProviderError` message. */
function assertNeverLeaksHostileContent(message: string) {
  assert.doesNotMatch(message, /sk-test-secret-value/);
  assert.doesNotMatch(message, /Bearer/i);
  assert.doesNotMatch(message, /authorization/i);
  assert.doesNotMatch(message, /customer artwork text/);
  assert.doesNotMatch(message, /purpose=user_data/);
  assert.doesNotMatch(message, /expires_after\[seconds\]/);
}

describe("uploadOpenAIFile — network-cause diagnostics (Signs Phase S4.2C.6, amended S4.2C.6A)", () => {
  it("surfaces nested cause.code from the underlying fetch rejection", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw connectionError({ name: "TypeError", cause: { code: "UND_ERR_SOCKET", name: "SocketError" } });
    }) as typeof fetch;

    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.match(err.message, /network_cause_underlying_code=UND_ERR_SOCKET/);
        return true;
      },
    );
    assert.equal(calls, 1, "no retry — the transport client never retries internally");
  });

  it("surfaces nested cause.name from the underlying fetch rejection", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ cause: { name: "SocketError", code: "UND_ERR_SOCKET" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.match(err.message, /network_cause_underlying_name=SocketError/);
        return true;
      },
    );
  });

  it("surfaces errno when present, top-level and nested", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ errno: "ECONNRESET", cause: { errno: "ECONNRESET" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.match(err.message, /network_cause_errno=ECONNRESET/);
        assert.match(err.message, /network_cause_underlying_errno=ECONNRESET/);
        return true;
      },
    );
  });

  it("surfaces syscall when present, top-level and nested", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ syscall: "read", cause: { syscall: "read" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.match(err.message, /network_cause_syscall=read/);
        assert.match(err.message, /network_cause_underlying_syscall=read/);
        return true;
      },
    );
  });

  it("Signs Phase S4.2C.6A: error.message is NEVER surfaced, even a hostile one containing secrets/customer data/multipart content", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ message: HOSTILE_MESSAGE, code: "UND_ERR_SOCKET" });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assertNeverLeaksHostileContent(err.message);
        // The structured field that WAS present must still be surfaced.
        assert.match(err.message, /network_cause_code=UND_ERR_SOCKET/);
        return true;
      },
    );
  });

  it("Signs Phase S4.2C.6A: error.cause.message is NEVER surfaced, even a hostile one containing secrets/customer data/multipart content", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ cause: { message: HOSTILE_MESSAGE, code: "UND_ERR_SOCKET", errno: "ECONNRESET", syscall: "read" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assertNeverLeaksHostileContent(err.message);
        // Every structured field that WAS present must still be surfaced.
        assert.match(err.message, /network_cause_underlying_code=UND_ERR_SOCKET/);
        assert.match(err.message, /network_cause_underlying_errno=ECONNRESET/);
        assert.match(err.message, /network_cause_underlying_syscall=read/);
        return true;
      },
    );
  });

  it("never leaks the API key, Authorization header, or multipart content into the error message (structured-fields-only case)", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ cause: { code: "ECONNRESET" } });
    }) as typeof fetch;

    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assertNeverLeaksHostileContent(err.message);
        return true;
      },
    );
  });

  it("classification remains 'network' for a connection-level failure", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.classification, "network");
        return true;
      },
    );
  });

  it("dispatch stays dispatched_ambiguous for an unrecognized/reset-style cause code", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.dispatch, "dispatched_ambiguous");
        return true;
      },
    );
  });

  it("dispatch is correctly not_dispatched for a provably pre-dispatch cause code (existing classifyFetchRejectionDispatch evidence, not a new rule)", async () => {
    const fetchImpl = (async () => {
      throw connectionError({ cause: { code: "ENOTFOUND" } });
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.dispatch, "not_dispatched");
        return true;
      },
    );
  });

  it("no retry behavior changes — a network failure results in exactly one fetch call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw connectionError({ cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    await assert.rejects(() => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT));
    assert.equal(calls, 1);
  });

  it("an abort/timeout still classifies as 'unavailable', unaffected by the diagnostic change", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    await assert.rejects(
      () => uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.classification, "unavailable");
        return true;
      },
    );
  });

  it("a successful upload still returns a valid file id, unaffected by the diagnostic change", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "file-abc123" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const result = await uploadOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, SAMPLE_INPUT);
    assert.equal(result.fileId, "file-abc123");
  });
});

describe("deleteOpenAIFile — network-cause diagnostics (Signs Phase S4.2C.6, amended S4.2C.6A)", () => {
  it("surfaces nested cause.code/errno/syscall and never leaks the API key or a hostile cause.message", async () => {
    const fetchImpl = (async () => {
      throw connectionError({
        cause: { code: "UND_ERR_SOCKET", errno: "ECONNRESET", syscall: "read", message: HOSTILE_MESSAGE },
      });
    }) as typeof fetch;
    await assert.rejects(
      () => deleteOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, "file-abc123"),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.classification, "network");
        assert.match(err.message, /network_cause_underlying_code=UND_ERR_SOCKET/);
        assert.match(err.message, /network_cause_underlying_errno=ECONNRESET/);
        assert.match(err.message, /network_cause_underlying_syscall=read/);
        assertNeverLeaksHostileContent(err.message);
        return true;
      },
    );
  });

  it("a 404 is still treated as already-deleted (idempotent), unaffected by the diagnostic change", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
    const result = await deleteOpenAIFile({ apiKey: FAKE_API_KEY, fetchImpl }, "file-abc123");
    assert.equal(result.deleted, true);
  });
});
