import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

import { OpenAIConceptEvaluationProvider } from "./openai-concept-evaluation-provider";
import type {
  ConceptEvaluationAssetReference,
  ConceptEvaluationRequest,
} from "./contracts";

function brief(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "Camp t-shirts",
    designDescription: "A bowling ball smashing pins",
    exactText: "Camp Wildwood 2026",
    shirtColor: "Navy",
    printPlacement: "full_front",
    preferredColors: ["Gold", "Forest green"],
    designStyle: "Vintage",
    additionalInstructions: null,
    audience: "Camp families",
    purpose: "Fundraiser",
    exclusions: "No skulls",
    deferredSections: [],
    ...overrides,
  };
}

function assetRef(
  overrides: Partial<ConceptEvaluationAssetReference> = {},
): ConceptEvaluationAssetReference {
  return {
    assetId: "asset-1",
    contentType: "image/png",
    widthPx: 1024,
    heightPx: 1024,
    isThumbnail: false,
    sourceUrl: "https://assets.example.test/signed/asset-1",
    ...overrides,
  };
}

function request(
  overrides: Partial<{
    brief: DesignBriefSnapshotContent;
    assets: ConceptEvaluationAssetReference[];
  }> = {},
): ConceptEvaluationRequest {
  return {
    brief: overrides.brief ?? brief(),
    concept: { title: "Concept A", summary: "s", placeholderLabel: "Concept A" },
    assets: overrides.assets ?? [assetRef()],
    idempotencyKey: "eval-key-1",
  };
}

function chatResponse(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** A full, internally-consistent "everything matches" fixture. */
function fullMatchPayload(overrides: Record<string, unknown> = {}) {
  return {
    requiredWording: { found: true, detectedText: "Camp Wildwood 2026", confidence: 92, notes: "clear" },
    exclusions: { violated: false, details: "no skulls present", confidence: 90 },
    style: { matches: true, score: 85, confidence: 80, notes: "vintage badge look" },
    graphics: { matches: true, score: 88, confidence: 82, notes: "ball + pins present" },
    colorPalette: { matches: true, score: 80, confidence: 75, notes: "gold and green used" },
    productCompatibility: { matches: true, score: 90, confidence: 70, notes: "fits a t-shirt" },
    composition: { score: 82, confidence: 75, notes: "balanced" },
    readability: { score: 88, confidence: 80, notes: "legible" },
    overallAlignment: { score: 85, confidence: 80, notes: "strong alignment" },
    warnings: [],
    recommendations: [],
    ...overrides,
  };
}

describe("OpenAIConceptEvaluationProvider — construction", () => {
  it("throws immediately if constructed without an API key", () => {
    assert.throws(
      () => new OpenAIConceptEvaluationProvider({ apiKey: "", model: "gpt-4o-mini" }),
      /API key/,
    );
  });
});

describe("OpenAIConceptEvaluationProvider — request translation", () => {
  it("sends only applicable brief requirements and the asset's signed URL, never customer/job identifiers", async () => {
    const requests: { init: RequestInit; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push({ init: init!, body: JSON.parse(String(init!.body)) });
      return chatResponse(fullMatchPayload());
    }) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
    });

    await provider.evaluate(request());

    assert.equal(requests.length, 1);
    const headers = requests[0]!.init.headers as Record<string, string>;
    assert.match(headers.authorization, /Bearer sk-test/);

    const body = requests[0]!.body as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    assert.equal(body.model, "gpt-4o-mini");
    const userMessage = body.messages.find((m) => m.role === "user")!;
    const content = userMessage.content as Array<Record<string, unknown>>;
    const textPart = content.find((p) => p.type === "text")! as { text: string };
    assert.match(textPart.text, /Camp Wildwood 2026/);
    assert.match(textPart.text, /bowling ball smashing pins/);
    assert.match(textPart.text, /No skulls/);
    const imagePart = content.find((p) => p.type === "image_url")! as {
      image_url: { url: string };
    };
    assert.equal(imagePart.image_url.url, "https://assets.example.test/signed/asset-1");

    // Never leaks the API key or a raw request/response into what's returned.
    const result = await provider.evaluate(request());
    assert.doesNotMatch(JSON.stringify(result), /sk-test/);
  });

  it("omits unspecified brief fields from the requirement text instead of inventing them", async () => {
    let capturedText = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMessage = body.messages.find((m) => m.role === "user")!;
      const content = userMessage.content as Array<Record<string, unknown>>;
      capturedText = (content.find((p) => p.type === "text") as { text: string }).text;
      return chatResponse(fullMatchPayload());
    }) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
    });

    await provider.evaluate(
      request({
        brief: brief({
          exactText: null,
          exclusions: null,
          designStyle: null,
          preferredColors: [],
        }),
      }),
    );

    assert.doesNotMatch(capturedText, /Required wording/i);
    assert.doesNotMatch(capturedText, /Explicit exclusions/i);
    assert.doesNotMatch(capturedText, /Requested style/i);
    assert.doesNotMatch(capturedText, /Requested colors/i);
  });
});

describe("OpenAIConceptEvaluationProvider — response normalization", () => {
  it("normalizes a fully matching response to passed with matched requirements", async () => {
    const fetchImpl = (async () => chatResponse(fullMatchPayload())) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      fetchImpl,
    });

    const result = await provider.evaluate(request());

    assert.equal(result.status, "passed");
    assert.equal(result.passed, true);
    assert.equal(result.overallScore, 85);
    assert.ok(result.matchedRequirements.includes("required wording"));
    assert.ok(result.matchedRequirements.includes("requested style"));
    assert.ok(result.matchedRequirements.includes("requested graphics"));
    assert.ok(result.matchedRequirements.includes("requested colors"));
    assert.ok(result.matchedRequirements.includes("exclusions respected"));
    assert.equal(result.missingRequirements.length, 0);
    // Never a raw provider dialect or prompt in what's returned.
    assert.deepEqual(Object.keys(result.providerMetadata).sort(), ["mode", "model"].sort());
  });

  it("detects required wording via OCR when present", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          requiredWording: { found: true, detectedText: "Camp Wildwood 2026", confidence: 95, notes: "clear text" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    const wording = result.criteria.find((c) => c.key === "required_wording")!;
    assert.equal(wording.passed, true);
    assert.equal(wording.score, 100);
    assert.ok(result.matchedRequirements.includes("required wording"));
  });

  it("does not fail the concept on low-confidence OCR uncertainty", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          requiredWording: { found: false, detectedText: "", confidence: 20, notes: "stylized, hard to read" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    // A low-confidence negative signal must not, by itself, fail the concept.
    assert.notEqual(result.status, "failed");
    assert.equal(result.missingRequirements.includes("required wording"), false);
  });

  it("marks the concept failed when required wording is confidently missing", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          requiredWording: { found: false, detectedText: "Camp Wildwood", confidence: 85, notes: "text present but wrong" },
          overallAlignment: { score: 40, confidence: 80, notes: "wording missing" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    assert.equal(result.status, "failed");
    assert.equal(result.passed, false);
    assert.ok(result.missingRequirements.includes("required wording"));
  });

  it("Sprint 2K Phase 2: does not blindly trust found:true when detectedText doesn't actually match the required wording (typo/incorrect)", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          // Model says "found" but the text it actually read is wrong
          // (missing the final "s") — a real customer-visible defect.
          requiredWording: { found: true, detectedText: "Camp Wildwood 202", confidence: 92, notes: "close enough?" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    const wording = result.criteria.find((c) => c.key === "required_wording")!;
    assert.equal(wording.passed, false);
    assert.equal(result.status, "failed");
    assert.ok(result.missingRequirements.includes("required wording"));
  });

  it("Sprint 2K Phase 2: catches invented extra wording even when the model reports found:true", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          requiredWording: {
            found: true,
            detectedText: "Camp Wildwood 2026 Est. 1985",
            confidence: 90,
            notes: "text present, plus a founding year",
          },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    assert.equal(result.status, "failed");
    assert.ok(result.missingRequirements.includes("required wording"));
  });

  it("Sprint 2K Phase 2: a case/punctuation-only difference in detectedText is still treated as a match", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          requiredWording: { found: true, detectedText: "CAMP WILDWOOD, 2026!", confidence: 90, notes: "clear" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    const wording = result.criteria.find((c) => c.key === "required_wording")!;
    assert.equal(wording.passed, true);
    assert.notEqual(result.status, "failed");
  });

  it("detects requested graphics being reasonably represented", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          graphics: { matches: true, score: 90, confidence: 88, notes: "bowling ball and pins clearly present" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    const graphics = result.criteria.find((c) => c.key === "graphics")!;
    assert.equal(graphics.passed, true);
    assert.ok(result.matchedRequirements.includes("requested graphics"));
  });

  it("detects requested style at a broad, high level", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({ style: { matches: true, score: 80, confidence: 75, notes: "reads as vintage" } }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    const style = result.criteria.find((c) => c.key === "style")!;
    assert.equal(style.passed, true);
  });

  it("evaluates requested colors with broad semantic matching passed through from the provider", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          colorPalette: { matches: true, score: 78, confidence: 70, notes: "olive reasonably satisfies forest green" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    const colors = result.criteria.find((c) => c.key === "color_palette")!;
    assert.equal(colors.passed, true);
    assert.ok(result.matchedRequirements.includes("requested colors"));
  });

  it("detects an obvious exclusion violation with confidence", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          exclusions: { violated: true, details: "a skull is visible in the design", confidence: 90 },
          overallAlignment: { score: 30, confidence: 80, notes: "violates exclusion" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(request());
    assert.equal(result.status, "failed");
    assert.ok(result.missingRequirements.includes("exclusions respected"));
  });

  it("never invents a requirement the brief did not state, even if the model tries to", async () => {
    const fetchImpl = (async () =>
      chatResponse(
        fullMatchPayload({
          // Model hallucinating a style opinion despite none being requested.
          style: { matches: false, score: 20, confidence: 95, notes: "not vintage enough" },
        }),
      )) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(
      request({ brief: brief({ designStyle: null }) }),
    );
    const style = result.criteria.find((c) => c.key === "style")!;
    assert.equal(style.score, null);
    assert.equal(style.passed, null);
    assert.equal(style.notes, "not_specified_in_brief");
    assert.equal(result.missingRequirements.includes("requested style"), false);
  });

  it("always assesses composition, readability, and overall alignment when an image exists", async () => {
    const fetchImpl = (async () => chatResponse(fullMatchPayload())) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(
      request({
        brief: brief({
          exactText: null,
          exclusions: null,
          designStyle: null,
          designDescription: null,
          preferredColors: [],
          productSummary: null,
        }),
      }),
    );

    assert.notEqual(result.criteria.find((c) => c.key === "composition")!.score, null);
    assert.notEqual(result.criteria.find((c) => c.key === "readability")!.score, null);
    assert.notEqual(result.criteria.find((c) => c.key === "overall_alignment")!.score, null);
  });
});

describe("OpenAIConceptEvaluationProvider — no image available", () => {
  it("returns a needs_review result without calling the provider when no asset has a source URL", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return chatResponse(fullMatchPayload());
    }) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const result = await provider.evaluate(
      request({ assets: [assetRef({ sourceUrl: null })] }),
    );

    assert.equal(calls, 0);
    assert.equal(result.status, "needs_review");
    assert.ok(result.criteria.every((c) => c.notes === "no_image_available"));
    assert.equal(result.providerMetadata.mode, "no_image_available");
  });

  it("falls back to a thumbnail URL when no primary asset URL exists", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMessage = body.messages.find((m) => m.role === "user")!;
      const content = userMessage.content as Array<Record<string, unknown>>;
      const image = content.find((p) => p.type === "image_url") as { image_url: { url: string } };
      requests.push(image.image_url.url);
      return chatResponse(fullMatchPayload());
    }) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    await provider.evaluate(
      request({
        assets: [
          assetRef({ assetId: "primary", sourceUrl: null, isThumbnail: false }),
          assetRef({ assetId: "thumb", sourceUrl: "https://assets.example.test/signed/thumb", isThumbnail: true }),
        ],
      }),
    );

    assert.deepEqual(requests, ["https://assets.example.test/signed/thumb"]);
  });
});

describe("OpenAIConceptEvaluationProvider — failure, retry, and timeout behavior", () => {
  it("retries a rate-limited response and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      return chatResponse(fullMatchPayload());
    }) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "m",
      fetchImpl,
      sleepImpl: async () => {},
    });

    const result = await provider.evaluate(request());
    assert.equal(calls, 3);
    assert.equal(result.status, "passed");
  });

  it("gives up after exhausting retries on a persistently unavailable provider", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "down" }), { status: 503 })) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "m",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await assert.rejects(provider.evaluate(request()), /temporarily unavailable/);
  });

  it("does not retry a malformed response — fails fast instead of wasting attempts", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "m",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await assert.rejects(provider.evaluate(request()), /did not include a message/);
    assert.equal(calls, 1);
  });

  it("classifies a network failure distinctly and reports it without a stack trace leaking through", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "m",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await assert.rejects(provider.evaluate(request()), /could not be reached/);
  });

  it("times out a hung request instead of waiting forever", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;

    const provider = new OpenAIConceptEvaluationProvider({
      apiKey: "sk-test",
      model: "m",
      fetchImpl,
      sleepImpl: async () => {},
      timeoutMs: 5,
      maxAttempts: 1,
    });

    await assert.rejects(provider.evaluate(request()), /timed out/);
  });
});

describe("OpenAIConceptEvaluationProvider — determinism", () => {
  it("produces an identical normalized result for identical provider responses", async () => {
    const fetchImpl = (async () => chatResponse(fullMatchPayload())) as typeof fetch;
    const provider = new OpenAIConceptEvaluationProvider({ apiKey: "sk-test", model: "m", fetchImpl });

    const first = await provider.evaluate(request());
    const second = await provider.evaluate(request());
    assert.deepEqual(first, second);
  });
});
