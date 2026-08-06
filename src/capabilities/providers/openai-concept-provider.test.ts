import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import type { GenerationPromptRequest } from "@/lib/domain/types";

function prompt(overrides: Partial<GenerationPromptRequest> = {}): GenerationPromptRequest {
  return {
    product: "a crewneck t-shirt",
    subject: "a friendly bear mascot",
    style: "hand-drawn",
    colors: ["gold", "forest green"],
    productColor: "Navy",
    requiredWording: "Camp Wildwood 2026",
    printLocation: "full_front",
    audience: "camp families",
    purpose: "fundraiser",
    exclusions: "no cartoon weapons",
    notes: null,
    inspirationReferences: [],
    allowAdditionalText: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SMALL_B64 = Buffer.from("fake-png-bytes").toString("base64");

describe("OpenAIConceptGenerationProvider", () => {
  it("throws immediately if constructed without an API key", () => {
    assert.throws(
      () => new OpenAIConceptGenerationProvider({ apiKey: "", model: "gpt-image-1" }),
      /API key/,
    );
  });

  it("requests one image per concept and returns real asset payloads, never exposing the provider dialect", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(init!);
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
    });

    const result = await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 2,
      prompt: prompt(),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    assert.equal(result.providerKey, "openai");
    assert.equal(result.concepts.length, 2);
    for (const concept of result.concepts) {
      assert.ok(concept.asset);
      assert.ok(Buffer.isBuffer(concept.asset!.imageBytes));
      assert.ok(concept.asset!.imageBytes.length > 0);
      assert.equal(concept.asset!.hasTransparency, true);
      // Never leaks the prompt text into what gets persisted downstream.
      assert.equal("prompt" in (concept.asset!.providerMetadata ?? {}), false);
    }

    // The API key must never appear in a customer-facing field.
    const serializedResult = JSON.stringify(result);
    assert.doesNotMatch(serializedResult, /sk-test/);

    // The request itself carries the key as a header, not the response shape.
    assert.equal(requests.length, 2);
    const headers = requests[0]!.headers as Record<string, string>;
    assert.match(headers.authorization, /Bearer sk-test/);
  });

  it("retries a rate-limited response and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(429, { error: "rate limited" });
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
      sleepImpl: async () => {},
    });

    const result = await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 1,
      prompt: prompt(),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    assert.equal(result.concepts.length, 1);
    assert.equal(calls, 3);
  });

  it("gives up after exhausting retries on a persistently unavailable provider", async () => {
    const fetchImpl = (async () => jsonResponse(503, { error: "down" })) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await assert.rejects(
      provider.generate({
        designId: "design-1",
        designBriefId: "version-1",
        conceptCount: 1,
        prompt: prompt(),
        idempotencyKey: "concept-generation:design-1:version-1",
      }),
      /temporarily unavailable/,
    );
  });

  it("does not retry a malformed response — fails fast instead of wasting attempts", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(200, { data: [] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await assert.rejects(
      provider.generate({
        designId: "design-1",
        designBriefId: "version-1",
        conceptCount: 1,
        prompt: prompt(),
        idempotencyKey: "concept-generation:design-1:version-1",
      }),
      /did not include image data/,
    );
    assert.equal(calls, 1);
  });

  it("classifies a network failure distinctly from a provider-side error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await assert.rejects(
      provider.generate({
        designId: "design-1",
        designBriefId: "version-1",
        conceptCount: 1,
        prompt: prompt(),
        idempotencyKey: "concept-generation:design-1:version-1",
      }),
      /could not be reached/,
    );
  });

  it("never embeds raw customer-provided fields verbatim as unsanitized JSON in the request body beyond the prompt text itself", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
    });

    await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 1,
      prompt: prompt({ requiredWording: "Camp Wildwood 2026" }),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    const body = JSON.parse(capturedBody) as { prompt: string; background: string };
    assert.match(body.prompt, /Camp Wildwood 2026/);
    assert.equal(body.background, "transparent");
  });

  it("Sprint 2K Phase 3 (Goal 5): sends a meaningfully different prompt per concept direction", async () => {
    const prompts: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt: string };
      prompts.push(body.prompt);
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
    });

    await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 3,
      prompt: prompt(),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    assert.equal(prompts.length, 3);
    const [a, b, c] = prompts;
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
    assert.match(a!, /Bold & Direct/);
    assert.match(b!, /Soft & Illustrated/);
    assert.match(c!, /Minimal Badge/);
  });

  it("Sprint 2K Phase 3 (Goal 7): instructs against inventing text beyond the required wording", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
    });

    await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 1,
      prompt: prompt({ requiredWording: "My 3 Sons" }),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    const body = JSON.parse(capturedBody) as { prompt: string };
    assert.match(body.prompt, /do not add any other text/i);
  });

  it("Sprint 2K Phase 3 (Goal 4): treats inspiration references as style-only, never literal content", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
    });

    await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 1,
      prompt: prompt({ inspirationReferences: ["the old tv show My 3 Sons"] }),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    const body = JSON.parse(capturedBody) as { prompt: string };
    assert.match(body.prompt, /style inspiration only/i);
    assert.match(body.prompt, /do not depict recognizable real people/i);
  });

  it("Sprint 2K Phase 3 (Goal 9): concept-direction distinctness is unaffected by regeneration-shaped prompt content", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] })) as typeof fetch;
    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test",
      model: "gpt-image-1",
      fetchImpl,
    });

    // A "regeneration-shaped" prompt — extra guidance folded into notes,
    // same as PromptTranslationCapability.mergeRegenerationPlan produces —
    // must still yield three distinctly-titled concepts, same as initial
    // generation.
    const regenerationShapedPrompt = prompt({
      notes: "Strengthen the graphics so it clearly matches the brief. Make sure the required wording reflects the customer's requested change.",
    });

    const result = await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 3,
      prompt: regenerationShapedPrompt,
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    const titles = result.concepts.map((c) => c.title);
    assert.deepEqual(titles, ["Bold & Direct", "Soft & Illustrated", "Minimal Badge"]);
    assert.equal(new Set(titles).size, 3);
  });
});
