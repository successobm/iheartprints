import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError } from "@/capabilities/providers/provider-error";

import { SIGN_PRESERVATION_SEMANTIC_CATEGORIES } from "./contracts";
import { OpenAISignPreservationSemanticProvider } from "./openai-sign-preservation-semantic-provider";
import type { SignPreservationSemanticRequest } from "./sign-preservation-semantic-provider";

/**
 * Signs Phase S4.2A: request-building / response-parsing / error-
 * classification coverage for the real OpenAI adapter — via an injected
 * fake `fetchImpl` ONLY. No test in this file, or anywhere in this
 * repository, ever constructs this class with a real API key or lets a
 * real network request leave the process.
 */

function image(label: string) {
  return { dataUri: `data:image/png;base64,${Buffer.from(label).toString("base64")}`, label };
}

function sampleRequest(): SignPreservationSemanticRequest {
  return {
    sourceOverview: image("source overview"),
    reconstructionOverview: image("reconstruction overview"),
    sourceCrops: Array.from({ length: 6 }, (_, i) => image(`source crop ${i}`)),
    reconstructionCrops: Array.from({ length: 6 }, (_, i) => image(`reconstruction crop ${i}`)),
    idempotencyKey: "test-identity-key",
  };
}

function allSameAnswers() {
  return SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
    category,
    answer: "same",
    reason: "unchanged",
    regionReference: null,
  }));
}

function responsesApiResponse(body: unknown, status = 200, id = "resp_test_1"): Response {
  return new Response(
    JSON.stringify({
      id,
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 1234, output_tokens: 56 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("OpenAISignPreservationSemanticProvider — construction", () => {
  it("throws immediately if constructed without an API key", () => {
    assert.throws(
      () => new OpenAISignPreservationSemanticProvider({ apiKey: "", model: "gpt-5.6-sol" }),
      /API key/,
    );
  });

  it("modelIdentity exposes the exact pinned model — part of the combined verification identity", () => {
    const provider = new OpenAISignPreservationSemanticProvider({ apiKey: "sk-test", model: "gpt-5.6-sol" });
    assert.equal(provider.modelIdentity, "gpt-5.6-sol");
    assert.equal(provider.providerKey, "openai_sign_preservation_semantic");
  });
});

describe("OpenAISignPreservationSemanticProvider — request translation", () => {
  it("sends exactly 14 image parts (2 overview + 6+6 crops), the strict json_schema contract, and the image-text-safety system instruction", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init!.body)));
      return responsesApiResponse({ answers: allSameAnswers() });
    }) as typeof fetch;

    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
    });
    await provider.compare(sampleRequest());

    assert.equal(requests.length, 1);
    const body = requests[0];
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.temperature, 0);

    const input = body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const system = input.find((m) => m.role === "system");
    assert.ok(system);
    const systemText = (system!.content[0] as { text: string }).text;
    assert.match(systemText, /DATA TO COMPARE ONLY/);
    assert.match(systemText, /never/i);
    assert.match(systemText, /follow|obey|act on/i);

    const user = input.find((m) => m.role === "user");
    assert.ok(user);
    const imageParts = user!.content.filter((part) => part.type === "input_image");
    assert.equal(imageParts.length, 14, "2 overview + 6 source crops + 6 reconstruction crops");

    const format = (body.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, "json_schema");
    assert.equal(format.strict, true);
    const schema = format.schema as Record<string, unknown>;
    const answersSchema = (schema.properties as Record<string, Record<string, unknown>>).answers;
    assert.equal(answersSchema.minItems, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length);
    assert.equal(answersSchema.maxItems, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length);
  });

  it("parses a well-formed Responses-API payload into answers + providerRequestId + tokenUsage", async () => {
    const fetchImpl = (async () =>
      responsesApiResponse({ answers: allSameAnswers() }, 200, "resp_abc123")) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
    });
    const result = await provider.compare(sampleRequest());
    assert.equal(result.answers.length, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length);
    assert.equal(result.providerRequestId, "resp_abc123");
    assert.deepEqual(result.tokenUsage, { inputTokens: 1234, outputTokens: 56 });
  });
});

describe("OpenAISignPreservationSemanticProvider — error classification", () => {
  it("429 -> rate_limited", async () => {
    const fetchImpl = (async () => new Response("", { status: 429 })) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
      maxAttempts: 1,
    });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "rate_limited");
      return true;
    });
  });

  it("401 -> auth", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
      maxAttempts: 1,
    });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "auth");
      return true;
    });
  });

  it("500 -> unavailable", async () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
      maxAttempts: 1,
    });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "unavailable");
      return true;
    });
  });

  it("unparsable JSON body -> malformed_response", async () => {
    const fetchImpl = (async () =>
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
      maxAttempts: 1,
    });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "malformed_response");
      return true;
    });
  });

  it("well-formed HTTP response but no structured output text -> malformed_response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "resp_1", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
      maxAttempts: 1,
    });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "malformed_response");
      return true;
    });
  });

  it("structured output text that is not valid JSON -> malformed_response", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const provider = new OpenAISignPreservationSemanticProvider({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      fetchImpl,
      maxAttempts: 1,
    });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "malformed_response");
      return true;
    });
  });
});
