import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError } from "@/capabilities/providers/provider-error";

import { OpenAIArtworkFidelityProposalProvider } from "./openai-artwork-fidelity-proposal-provider";

function responsesApiSuccess(structured: unknown, id = "resp_123"): Response {
  return new Response(
    JSON.stringify({
      id,
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(structured) }] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function noSleep() {
  return async () => {};
}

describe("OpenAIArtworkFidelityProposalProvider — construction", () => {
  it("throws immediately without an API key", () => {
    assert.throws(
      () => new OpenAIArtworkFidelityProposalProvider({ apiKey: "", model: "gpt-4o-mini" }),
      /API key/,
    );
  });
});

describe("OpenAIArtworkFidelityProposalProvider — request/response", () => {
  it("sends the image inline as a base64 data URI, using the Bearer credential", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init!.body));
      return responsesApiSuccess({ wording: [], protectedMarks: [] });
    }) as typeof fetch;

    const provider = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noSleep(),
    });
    await provider.propose({ bytes: Buffer.from("fake-png-bytes"), contentType: "image/png" });

    assert.ok(captured);
    const body = captured as { model: string; input: Array<{ role: string; content: unknown[] }>; text: unknown };
    assert.equal(body.model, "gpt-4o-mini");
    const userContent = body.input.find((m) => m.role === "user")!.content as Array<Record<string, unknown>>;
    const imagePart = userContent.find((p) => p.type === "input_image") as { image_url: string };
    assert.match(imagePart.image_url, /^data:image\/png;base64,/);
    const base64Payload = imagePart.image_url.slice("data:image/png;base64,".length);
    assert.equal(Buffer.from(base64Payload, "base64").toString("utf8"), "fake-png-bytes");
  });

  it("never exposes the raw API key in a thrown error or a returned result", async () => {
    const fetchImpl = (async () => responsesApiSuccess({ wording: [], protectedMarks: [] })) as typeof fetch;
    const provider = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-super-secret",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noSleep(),
    });
    const result = await provider.propose({ bytes: Buffer.from("x"), contentType: "image/png" });
    assert.doesNotMatch(JSON.stringify(result), /sk-super-secret/);
  });

  it("parses wording and protectedMarks from the structured output", async () => {
    const fetchImpl = (async () =>
      responsesApiSuccess({
        wording: [
          { readability: "readable", text: "BRIDGEWELL", visibleEvidence: "bold caps", confidence: "high" },
          { readability: "partially_readable", text: "_o__p__", visibleEvidence: "partial", confidence: "medium" },
        ],
        protectedMarks: [
          { visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" },
        ],
      })) as typeof fetch;
    const provider = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noSleep(),
    });

    const result = await provider.propose({ bytes: Buffer.from("x"), contentType: "image/png" });

    assert.equal(result.wording.length, 2);
    assert.equal(result.wording[0]!.text, "BRIDGEWELL");
    assert.equal(result.protectedMarks.length, 1);
    assert.equal(result.protectedMarks[0]!.classification, "R");
    assert.equal(result.providerRequestId, "resp_123");
  });

  it("defensively forces text=null when readability is cannot_read, even if the provider disobeys the schema", async () => {
    const fetchImpl = (async () =>
      responsesApiSuccess({
        wording: [{ readability: "cannot_read", text: "a sneaky guess", visibleEvidence: "", confidence: "low" }],
        protectedMarks: [],
      })) as typeof fetch;
    const provider = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noSleep(),
    });

    const result = await provider.propose({ bytes: Buffer.from("x"), contentType: "image/png" });

    assert.equal(result.wording[0]!.readability, "cannot_read");
    assert.equal(result.wording[0]!.text, null);
  });

  it("drops malformed wording/mark entries rather than guessing a shape for them", async () => {
    const fetchImpl = (async () =>
      responsesApiSuccess({
        wording: [{ readability: "not_a_real_value", text: "x", visibleEvidence: "", confidence: "high" }, null, "garbage"],
        protectedMarks: [{ classification: "not_a_real_value", confidence: "high" }],
      })) as typeof fetch;
    const provider = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noSleep(),
    });

    const result = await provider.propose({ bytes: Buffer.from("x"), contentType: "image/png" });

    assert.deepEqual(result.wording, []);
    assert.deepEqual(result.protectedMarks, []);
  });

  it("classifies a 429 as rate_limited and a 401 as auth, without retrying auth", async () => {
    let calls = 0;
    const fetchImpl429 = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
    }) as typeof fetch;
    const provider429 = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl: fetchImpl429,
      sleepImpl: noSleep(),
      maxAttempts: 2,
    });
    await assert.rejects(
      () => provider429.propose({ bytes: Buffer.from("x"), contentType: "image/png" }),
      (error: unknown) => error instanceof ProviderError && error.classification === "rate_limited",
    );
    assert.equal(calls, 2); // retried once, then gave up

    const fetchImpl401 = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as typeof fetch;
    const provider401 = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl: fetchImpl401,
      sleepImpl: noSleep(),
      maxAttempts: 3,
    });
    await assert.rejects(
      () => provider401.propose({ bytes: Buffer.from("x"), contentType: "image/png" }),
      (error: unknown) => error instanceof ProviderError && error.classification === "auth",
    );
  });

  it("throws malformed_response for an unparseable structured payload", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200 })) as typeof fetch;
    const provider = new OpenAIArtworkFidelityProposalProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
      sleepImpl: noSleep(),
    });
    await assert.rejects(
      () => provider.propose({ bytes: Buffer.from("x"), contentType: "image/png" }),
      (error: unknown) => error instanceof ProviderError && error.classification === "malformed_response",
    );
  });
});
