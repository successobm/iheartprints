import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PNG } from "pngjs";

import type { GenerationPromptRequest } from "@/lib/domain/types";

import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import {
  classifyFetchRejectionDispatch,
  isPossiblyBilledProviderError,
  isRetryableProviderError,
  ProviderError,
} from "./provider-error";

/**
 * Phase 2C0.5 (§6) — TRANSPORT RETRY HARDENING.
 *
 * The defect: every `network`/`rate_limited`/`unavailable` failure was
 * retried up to three times regardless of whether the request had already
 * reached the provider. A 5xx returned AFTER a billable image generation
 * therefore paid for the same image three times, and nothing anywhere
 * recorded that it had.
 *
 * The fix is not "retry less". It is to stop pretending the transport layer
 * knows things it cannot know: retry only what provably never dispatched,
 * and hand everything ambiguous to the durable paid-intent layer, which has
 * a cross-worker budget the transport loop does not.
 *
 * Nothing here contacts OpenAI. `fetchImpl` is injected in every test.
 */

function b64Png(): string {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(200);
  return PNG.sync.write(png).toString("base64");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function prompt(): GenerationPromptRequest {
  return {
    product: "t-shirt",
    subject: "a lighthouse",
    style: "clean",
    colors: [],
    subjectOnlyColors: [],
    productColor: null,
    requiredWording: null,
    wordingMode: "unspecified",
    allowAdditionalText: false,
    inspirationReferences: [],
    exclusions: null,
    notes: null,
    printPaletteEnforcement: "soft",
    explicitInkRestriction: null,
  } as unknown as GenerationPromptRequest;
}

function newProvider(fetchImpl: typeof fetch) {
  return new OpenAIConceptGenerationProvider({
    apiKey: "sk-test",
    model: "gpt-image-1",
    fetchImpl,
    sleepImpl: async () => {},
  });
}

function request() {
  return {
    designId: "design-1",
    designBriefId: "version-1",
    conceptCount: 1,
    prompt: prompt(),
    idempotencyKey: "concept-generation:design-1:version-1",
  };
}

describe("provider dispatch classification", () => {
  it("treats a DNS/connect failure as provably never dispatched, so it is safe to retry", () => {
    const dnsFailure = new TypeError("fetch failed", {
      cause: { code: "ENOTFOUND" },
    });
    assert.equal(classifyFetchRejectionDispatch(dnsFailure), "not_dispatched");
    assert.equal(
      classifyFetchRejectionDispatch(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
      ),
      "not_dispatched",
    );
  });

  it("Signs Phase S4.2C.8: treats a TCP connect-timeout (Undici's ConnectTimeoutError) as provably never dispatched — the real S4.2C.7 failure mode", () => {
    const connectTimeout = new TypeError("fetch failed", {
      cause: { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    assert.equal(classifyFetchRejectionDispatch(connectTimeout), "not_dispatched");
  });

  it("treats a reset, a timeout, and anything unrecognized as ambiguous, never as safe", () => {
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "WAT"]) {
      assert.equal(
        classifyFetchRejectionDispatch(
          new TypeError("fetch failed", { cause: { code } }),
        ),
        "dispatched_ambiguous",
        `${code} can occur after the request was fully sent`,
      );
    }
    assert.equal(
      classifyFetchRejectionDispatch(new Error("no code at all")),
      "dispatched_ambiguous",
      "an unclassifiable failure is never assumed to be free",
    );
  });

  it("defaults each classification to its conservative dispatch state", () => {
    assert.equal(new ProviderError("rate_limited", "x").dispatch, "not_dispatched");
    assert.equal(new ProviderError("invalid_request", "x").dispatch, "not_dispatched");
    assert.equal(new ProviderError("auth", "x").dispatch, "not_dispatched");
    assert.equal(
      new ProviderError("malformed_response", "x").dispatch,
      "dispatched_billed",
    );
    assert.equal(new ProviderError("unavailable", "x").dispatch, "dispatched_ambiguous");
    assert.equal(new ProviderError("unknown", "x").dispatch, "dispatched_ambiguous");
  });

  it("retries only what provably never dispatched", () => {
    assert.equal(
      isRetryableProviderError(
        new ProviderError("network", "x", "not_dispatched"),
      ),
      true,
    );
    assert.equal(
      isRetryableProviderError(new ProviderError("rate_limited", "x")),
      true,
      "a 429 was refused before any work was done",
    );
    assert.equal(
      isRetryableProviderError(
        new ProviderError("unavailable", "x", "dispatched_ambiguous"),
      ),
      false,
      "an ambiguous 5xx is never blind-retried at the transport layer",
    );
    assert.equal(
      isRetryableProviderError(new ProviderError("malformed_response", "x")),
      false,
      "an unusable 200 is never retried — that is the most expensive loop available",
    );
  });

  it("reports which failures may already have been billed", () => {
    assert.equal(
      isPossiblyBilledProviderError(new ProviderError("rate_limited", "x")),
      false,
    );
    assert.equal(
      isPossiblyBilledProviderError(
        new ProviderError("unavailable", "x", "dispatched_ambiguous"),
      ),
      true,
    );
    assert.equal(
      isPossiblyBilledProviderError(new ProviderError("malformed_response", "x")),
      true,
    );
    assert.equal(isPossiblyBilledProviderError(new Error("not a provider error")), false);
  });
});

describe("OpenAI adapter transport policy", () => {
  it("still retries a 429 up to the per-image ceiling, because nothing was billed", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(429, { error: "rate limited" });
      return jsonResponse(200, { data: [{ b64_json: b64Png() }] });
    }) as typeof fetch;

    const result = await newProvider(fetchImpl).generate(request());
    assert.equal(result.concepts.length, 1);
    assert.equal(calls, 3);
  });

  it("no longer blind-retries a 5xx — one dispatch, then it is the paid-intent layer's decision", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(503, { error: "down" });
    }) as typeof fetch;

    await assert.rejects(
      () => newProvider(fetchImpl).generate(request()),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.classification === "unavailable" &&
        error.dispatch === "dispatched_ambiguous",
    );
    assert.equal(calls, 1, "previously this was 3 potentially-billed dispatches");
  });

  it("treats HTTP 200 with an empty data array as billed and never loops on it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(200, { data: [] });
    }) as typeof fetch;

    await assert.rejects(
      () => newProvider(fetchImpl).generate(request()),
      (error: unknown) =>
        error instanceof ProviderError && error.dispatch === "dispatched_billed",
    );
    assert.equal(calls, 1);
  });

  it("treats HTTP 200 with an unreadable body as billed", async () => {
    const fetchImpl = (async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      () => newProvider(fetchImpl).generate(request()),
      (error: unknown) =>
        error instanceof ProviderError && error.dispatch === "dispatched_billed",
    );
  });

  it("treats a 4xx rejection as not dispatched — the provider did no billable work", async () => {
    const fetchImpl = (async () =>
      jsonResponse(400, { error: "bad size" })) as typeof fetch;

    await assert.rejects(
      () => newProvider(fetchImpl).generate(request()),
      (error: unknown) =>
        error instanceof ProviderError && error.dispatch === "not_dispatched",
    );
  });

  it("retries a provably pre-dispatch connect failure, and gives up on an ambiguous one", async () => {
    let connectCalls = 0;
    const connectFailure = (async () => {
      connectCalls += 1;
      if (connectCalls < 3) {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }
      return jsonResponse(200, { data: [{ b64_json: b64Png() }] });
    }) as typeof fetch;
    const recovered = await newProvider(connectFailure).generate(request());
    assert.equal(recovered.concepts.length, 1);
    assert.equal(connectCalls, 3);

    let ambiguousCalls = 0;
    const midStreamFailure = (async () => {
      ambiguousCalls += 1;
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    await assert.rejects(() => newProvider(midStreamFailure).generate(request()));
    assert.equal(
      ambiguousCalls,
      1,
      "a reset may have arrived after the model already ran — it is not retried here",
    );
  });

  it("generateDirection makes exactly one paid dispatch for exactly one direction", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return jsonResponse(200, { data: [{ b64_json: b64Png() }] });
    }) as unknown as typeof fetch;

    const result = await newProvider(fetchImpl).generateDirection(
      request(),
      "minimal_badge",
    );

    assert.equal(bodies.length, 1, "one direction, one paid call");
    assert.equal(result.concepts.length, 1);
    assert.equal(result.concepts[0]?.directionKey, "minimal_badge");
    assert.doesNotMatch(
      JSON.stringify(result),
      /sk-test/,
      "and it still never leaks the API key",
    );
  });
});
