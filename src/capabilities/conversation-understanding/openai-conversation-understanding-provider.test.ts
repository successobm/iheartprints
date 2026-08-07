import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConversationUnderstandingProvider } from "./openai-conversation-understanding-provider";
import type { ConversationUnderstandingRequest } from "./contracts";

function chatResponse(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function request(
  overrides: Partial<ConversationUnderstandingRequest> = {},
): ConversationUnderstandingRequest {
  return {
    message: "I'm in a bowling league and our team is called My 3 Sons",
    knownBrief: {},
    unresolvedSections: ["product", "requiredWording", "audience"],
    pendingSection: null,
    recentTurns: [],
    ...overrides,
  };
}

const noopSleep = async () => {};

describe("OpenAIConversationUnderstandingProvider — construction", () => {
  it("throws immediately if constructed without an API key", () => {
    assert.throws(
      () => new OpenAIConversationUnderstandingProvider({ apiKey: "", model: "gpt-4o-mini" }),
      /API key/,
    );
  });
});

describe("OpenAIConversationUnderstandingProvider — happy path", () => {
  it("parses a well-formed JSON response into the provider-neutral result shape", async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return chatResponse({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "explicit",
            evidence: "our team is called My 3 Sons",
            isCorrection: false,
          },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIConversationUnderstandingProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noopSleep,
    });

    const result = await provider.interpret(request());
    assert.equal(result.proposedUpdates[0]?.section, "requiredWording");
    assert.equal(result.proposedUpdates[0]?.value, "My 3 Sons");

    // Never sends an image model, never sends anything but the bounded
    // request content (Goal 12 / security boundary).
    assert.equal((capturedBody as { model: string }).model, "gpt-4o-mini");
    const messages = (capturedBody as { messages: Array<{ content: string }> }).messages;
    assert.ok(messages.every((m) => !/data:image|image_url/i.test(m.content)));
  });
});

describe("OpenAIConversationUnderstandingProvider — provider-contract fixture (Sprint 2L Phase 1C, Goal: real-provider parsing fidelity)", () => {
  /**
   * This test exercises the REAL `OpenAIConversationUnderstandingProvider`
   * class end to end — its actual prompt-building, its actual HTTP call
   * shape, its actual response parsing — against a `Response` shaped
   * exactly like the real OpenAI chat-completions API returns (the
   * `chatResponse` envelope above). It is still a *fixture*: the JSON
   * `content` string is what we expect a well-prompted model to return,
   * not a live model's actual output.
   *
   * What this test DOES prove: the provider's parsing/normalization code
   * correctly turns a well-formed structured response into the
   * provider-neutral contract, for the exact opener that previously
   * corrupted a customer-facing question.
   *
   * What this test does NOT prove: that a real `gpt-4o-mini` call
   * actually produces this response for this message. Only a live,
   * explicitly-authorized acceptance test (see the Sprint 2L Phase 1C
   * report) proves that. Conflating the two was the root cause this
   * phase investigated — a passing fixture test here, or in
   * `goal-directed-orchestration-regression.test.ts`, means "the pipeline
   * is correct given this input," never "the real provider produces this
   * input."
   */
  it("parses the full 'My 3 Sons' opener into product/requiredWording/audience/purpose, exactly bounded, never the greedy run-on clause", async () => {
    const fetchImpl = (async () =>
      chatResponse({
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "team t-shirts", isCorrection: false },
          { section: "requiredWording", value: "My 3 Sons", confidence: "explicit", evidence: "our team is called My 3 Sons", isCorrection: false },
          { section: "audience", value: "Bowling team", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
          { section: "purpose", value: "Bowling league team apparel", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      })) as unknown as typeof fetch;

    const provider = new OpenAIConversationUnderstandingProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noopSleep,
    });

    const result = await provider.interpret(
      request({
        message:
          "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts",
      }),
    );

    const bySection = (s: string) => result.proposedUpdates.find((u) => u.section === s);
    assert.equal(bySection("product")?.value, "T-shirt");
    assert.equal(bySection("requiredWording")?.value, "My 3 Sons");
    assert.equal(bySection("audience")?.value, "Bowling team");
    assert.equal(bySection("purpose")?.value, "Bowling league team apparel");

    // The specific corruption this phase traced: requiredWording must
    // never be the greedy run-on capture.
    assert.notEqual(
      bySection("requiredWording")?.value,
      "My 3 Sons help me create a design for team t-shirts",
    );
  });
});

describe("OpenAIConversationUnderstandingProvider — failure classification (Goal 10)", () => {
  it("throws on a non-JSON response body", async () => {
    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAIConversationUnderstandingProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noopSleep,
      maxAttempts: 1,
    });
    await assert.rejects(provider.interpret(request()));
  });

  it("throws on a malformed JSON message content", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "{not valid json" } }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const provider = new OpenAIConversationUnderstandingProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noopSleep,
      maxAttempts: 1,
    });
    await assert.rejects(provider.interpret(request()));
  });

  it("retries a 429 then succeeds", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) return new Response("rate limited", { status: 429 });
      return chatResponse({
        proposedUpdates: [],
        deferrals: [],
        ambiguities: [],
        customerIntent: "unclear",
        answeredPendingSection: null,
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIConversationUnderstandingProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noopSleep,
      maxAttempts: 2,
    });
    const result = await provider.interpret(request());
    assert.equal(attempt, 2);
    assert.equal(result.customerIntent, "unclear");
  });

  it("does not retry a 400 (non-retryable) response", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;
    const provider = new OpenAIConversationUnderstandingProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noopSleep,
      maxAttempts: 3,
    });
    await assert.rejects(provider.interpret(request()));
    assert.equal(attempt, 1);
  });
});
