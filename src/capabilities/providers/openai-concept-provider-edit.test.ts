import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import { ProviderError } from "./provider-error";
import { resolveConceptGenerationProvider } from "./resolve-concept-provider";
import type { ConceptGenerationRequest } from "@/capabilities/shared/contracts";
import type {
  GenerationPromptRequest,
  RevisionDirective,
} from "@/lib/domain/types";

/**
 * True Source-Image Targeted Revision — provider boundary.
 *
 * Every call here goes through an INJECTED `fetchImpl`. No real OpenAI
 * request, no network, no paid call, ever (Section 10).
 */

const SMALL_B64 = Buffer.from("fake-png-bytes").toString("base64");
const SOURCE_BYTES = Buffer.from("original-concept-png-bytes");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function revision(overrides: Partial<RevisionDirective> = {}): RevisionDirective {
  return {
    requestedChanges: [
      "replace the oval badge border with a shield border",
      "make the shield border red",
    ],
    preserve: [],
    avoid: [],
    lockedWording: "1988 TOYOTA MR2",
    wordingChangeRequested: false,
    preserveEverythingElse: false,
    ...overrides,
  };
}

function prompt(overrides: Partial<GenerationPromptRequest> = {}): GenerationPromptRequest {
  return {
    product: "a crewneck t-shirt",
    subject: "a vintage sports car badge",
    style: "retro badge",
    colors: ["red"],
    productColor: "Black",
    requiredWording: "1988 TOYOTA MR2",
    printLocation: "full_front",
    audience: "car enthusiasts",
    purpose: "club merch",
    exclusions: null,
    notes: null,
    inspirationReferences: [],
    allowAdditionalText: false,
    targetConceptDirectionKey: "minimal_badge",
    revision: revision(),
    ...overrides,
  };
}

function request(
  overrides: Partial<ConceptGenerationRequest> = {},
): ConceptGenerationRequest {
  return {
    designId: "design-1",
    designBriefId: "version-2",
    conceptCount: 1,
    prompt: prompt(),
    idempotencyKey: "concept-generation:design-1:version-2",
    sourceArtwork: {
      sourceArtworkVersionId: "artwork-7",
      imageBytes: SOURCE_BYTES,
      contentType: "image/png",
    },
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function capturingFetch(calls: CapturedCall[], response = () =>
  jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] })): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return response();
  }) as unknown as typeof fetch;
}

function formOf(call: CapturedCall): FormData {
  assert.ok(call.init.body instanceof FormData, "edit request must be multipart");
  return call.init.body as FormData;
}

function editPromptOf(call: CapturedCall): string {
  return String(formOf(call).get("prompt"));
}

function newProvider(fetchImpl: typeof fetch, model = "gpt-image-1") {
  return new OpenAIConceptGenerationProvider({
    apiKey: "sk-test",
    model,
    fetchImpl,
    sleepImpl: async () => {},
  });
}

describe("OpenAIConceptGenerationProvider — targeted revision uses the image EDIT path", () => {
  it("sends the selected source artwork to the edit endpoint, not the generations endpoint", async () => {
    const calls: CapturedCall[] = [];
    const result = await newProvider(capturingFetch(calls)).generate(request());

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/images/edits");
    assert.notEqual(calls[0]!.url, "https://api.openai.com/v1/images/generations");

    // The customer's actual concept pixels crossed the boundary.
    const image = formOf(calls[0]!).get("image");
    assert.ok(image instanceof Blob);
    const uploaded = Buffer.from(await (image as Blob).arrayBuffer());
    assert.deepEqual(uploaded, SOURCE_BYTES);
    assert.equal((image as Blob).type, "image/png");

    assert.equal(result.concepts.length, 1);
    assert.equal(result.concepts[0]!.kind, "revision");
    assert.equal(result.concepts[0]!.directionKey, "minimal_badge");
  });

  it("configures the edit for maximum source preservation: n=1, high input fidelity, transparent PNG", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());

    const form = formOf(calls[0]!);
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("input_fidelity"), "high");
    assert.equal(form.get("background"), "transparent");
    assert.equal(form.get("output_format"), "png");
    assert.equal(form.get("model"), "gpt-image-1");

    // fetch must generate the multipart boundary itself.
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal("content-type" in headers, false);
    assert.match(headers.authorization!, /Bearer sk-test/);
  });

  it("produces exactly ONE revised concept, never three", async () => {
    const calls: CapturedCall[] = [];
    const result = await newProvider(capturingFetch(calls)).generate(
      // Even if a stale conceptCount of 3 were somehow passed through.
      request({ conceptCount: 3 }),
    );

    assert.equal(result.concepts.length, 1);
    assert.equal(calls.length, 1);
  });

  it("omits input_fidelity for a model that does not support it, but still edits the source image", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls), "gpt-image-1-mini").generate(request());

    const form = formOf(calls[0]!);
    assert.equal(form.get("input_fidelity"), null);
    assert.ok(form.get("image") instanceof Blob, "the source image is never conditional");
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/images/edits");
  });

  it("preserves retry behavior and error classification on the edit path", async () => {
    let attempts = 0;
    const retryingFetch = (async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse(429, { error: "rate limited" });
      return jsonResponse(200, { data: [{ b64_json: SMALL_B64 }] });
    }) as unknown as typeof fetch;

    const result = await newProvider(retryingFetch).generate(request());
    assert.equal(attempts, 3);
    assert.equal(result.concepts.length, 1);

    const failing = (async () => jsonResponse(500, { error: "boom" })) as unknown as typeof fetch;
    await assert.rejects(
      () => newProvider(failing).generate(request()),
      (error: unknown) =>
        error instanceof ProviderError && error.classification === "unavailable",
    );
  });

  it("never leaks the API key or the edit prompt into the persisted metadata", async () => {
    const calls: CapturedCall[] = [];
    const result = await newProvider(capturingFetch(calls)).generate(request());

    const metadata = result.concepts[0]!.asset!.providerMetadata;
    assert.equal("prompt" in metadata, false);
    assert.doesNotMatch(JSON.stringify(result), /sk-test/);
    assert.doesNotMatch(JSON.stringify(result), /shield/i);
  });
});

describe("OpenAIConceptGenerationProvider — no text-to-image fallback for a targeted revision", () => {
  it("fails rather than generating from text when the source artwork is missing", async () => {
    const calls: CapturedCall[] = [];
    await assert.rejects(
      () =>
        newProvider(capturingFetch(calls)).generate(
          request({ sourceArtwork: null }),
        ),
      (error: unknown) =>
        error instanceof ProviderError && error.classification === "invalid_request",
    );

    // The decisive assertion: nothing was requested at all — in particular
    // not a fresh text-to-image generation dressed up as a revision.
    assert.equal(calls.length, 0);
  });

  it("fails rather than generating from text when the source artwork is empty", async () => {
    const calls: CapturedCall[] = [];
    await assert.rejects(
      () =>
        newProvider(capturingFetch(calls)).generate(
          request({
            sourceArtwork: {
              sourceArtworkVersionId: "artwork-7",
              imageBytes: Buffer.alloc(0),
              contentType: "image/png",
            },
          }),
        ),
      (error: unknown) => error instanceof ProviderError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("OpenAIConceptGenerationProvider — the edit prompt is an edit, not a re-imagining", () => {
  it("establishes editing, apply-only-requested, and preserve-everything-else", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());
    const text = editPromptOf(calls[0]!);

    assert.match(text, /editing the artwork image supplied/i);
    assert.match(text, /not a new interpretation/i);
    assert.match(text, /Apply ONLY the changes listed under CHANGE/i);
    assert.match(text, /must survive the edit unchanged/i);
    assert.match(text, /PRESERVE EXACTLY/i);
  });

  it("carries EVERY requested change into the edit prompt", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(
      request({
        prompt: prompt({
          revision: revision({
            requestedChanges: [
              "change the font to something more retro",
              "remove the sunset",
            ],
          }),
        }),
      }),
    );
    const text = editPromptOf(calls[0]!);

    assert.match(text, /- change the font to something more retro/);
    assert.match(text, /- remove the sunset/);
  });

  it("enumerates the default preservation contract rather than a vague 'keep the rest'", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());
    const text = editPromptOf(calls[0]!);

    for (const expected of [
      /overall composition and layout/i,
      /typography style/i,
      /identity, placement, scale, and proportions/i,
      // Live Acceptance Cleanup (Issue 1): color preservation is now stated
      // PER ELEMENT rather than as a blanket "the existing artwork colors".
      // The live failure was one unrequested element changing alongside the
      // requested one, which a whole-image statement never addressed.
      /the exact current color of every element the CHANGE list does not name/i,
      /every graphical element the CHANGE list does not mention/i,
      /visual hierarchy/i,
      /transparent background/i,
    ]) {
      assert.match(text, expected);
    }
    assert.match(text, /Do not redraw, re-stylize, re-crop, re-center, or re-scale/i);
  });

  /**
   * Live Acceptance Cleanup — Issue 1, at the provider boundary.
   *
   * The live failure was never a whole-design redraw: ONE unrequested
   * element changed alongside the requested one ("make the 3 SONS text red"
   * also turned "MY" red). A whole-image "keep everything else the same"
   * does not address that, so scope is now stated per element.
   */
  it("1: scopes each change to the element it names, so an unrelated element can't ride along", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());
    const text = editPromptOf(calls[0]!);

    assert.match(text, /Each change applies ONLY to the specific element it names/i);
    assert.match(
      text,
      /only those exact words change — every other word keeps its current color/i,
    );
    assert.match(
      text,
      /never make an unrequested element match one you were asked to change/i,
    );
    // Text identity is preserved explicitly: a text element is not obviously
    // a "graphical element" to an image model.
    assert.match(
      text,
      /every other word, letter, and line of text in the artwork exactly as it appears now/i,
    );
  });

  it("1b: an explicit 'everything else stays the same' strengthens the contract further", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(
      request({
        prompt: prompt({
          revision: revision({
            requestedChanges: ["make the 3 SONS text the same color as the ball"],
            preserveEverythingElse: true,
          }),
        }),
      }),
    );
    const text = editPromptOf(calls[0]!);

    assert.match(text, /customer explicitly asked for everything else to stay exactly the same/i);
    assert.match(text, /Treat every element not named under CHANGE as locked/i);
    assert.match(text, /If you are unsure whether something was meant to change, leave it exactly as it is/i);
  });

  it("1c: without that phrase the extra statement is absent, but the default contract still is not", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());
    const text = editPromptOf(calls[0]!);

    assert.doesNotMatch(text, /customer explicitly asked for everything else/i);
    assert.match(text, /Apply ONLY the changes listed under CHANGE/i);
    assert.match(text, /Each change applies ONLY to the specific element it names/i);
  });

  it("1d: a styling change to a text element keeps the exact-wording lock stated", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(
      request({
        prompt: prompt({
          revision: revision({
            requestedChanges: ["make the 3 SONS text the same color as the ball"],
            wordingChangeRequested: false,
            lockedWording: "MY 3 SONS",
          }),
        }),
      }),
    );
    const text = editPromptOf(calls[0]!);

    assert.match(text, /the exact wording "MY 3 SONS" — same spelling, same capitalization/i);
    // The wording-CHANGE sentence would tell the model it is changing what
    // the design says, which is what licensed re-rendering every word.
    assert.doesNotMatch(text, /while changing what it says/i);
  });

  it("does not restate the catalog creative direction — the source image IS the direction", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());
    const text = editPromptOf(calls[0]!);

    assert.doesNotMatch(text, /Creative direction —/);
    assert.doesNotMatch(text, /Illustration density:/);
    assert.doesNotMatch(text, /Print-ready apparel graphic for/);
  });

  it("consumes prompt.notes instead of silently discarding them", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(
      request({ prompt: prompt({ notes: "Keep the club crest legible at small sizes." }) }),
    );

    assert.match(
      editPromptOf(calls[0]!),
      /Keep the club crest legible at small sizes\./,
    );
  });

  it("surfaces avoid entries when the plan has them", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(
      request({
        prompt: prompt({ revision: revision({ avoid: ["no flames", "no skulls"] }) }),
      }),
    );

    assert.match(editPromptOf(calls[0]!), /Must not appear: no flames; no skulls\./);
  });
});

describe("OpenAIConceptGenerationProvider — required wording protection", () => {
  it("locks the exact wording when the customer did not ask to change it", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());
    const text = editPromptOf(calls[0]!);

    assert.match(text, /the exact wording "1988 TOYOTA MR2"/);
    assert.match(text, /same spelling, same capitalization, same words/i);
  });

  it("allows an explicit wording change and states the new wording exactly", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(
      request({
        prompt: prompt({
          requiredWording: "MR2 TURBO",
          revision: revision({
            requestedChanges: ['change the text "1988 Toyota MR2" to "MR2 TURBO"'],
            lockedWording: null,
            wordingChangeRequested: true,
          }),
        }),
      }),
    );
    const text = editPromptOf(calls[0]!);

    assert.match(text, /must read exactly, and only: "MR2 TURBO"/);
    // The lock must not simultaneously forbid the change it was asked for.
    assert.doesNotMatch(text, /the exact wording "MR2 TURBO" — same spelling/);
    // Typography still survives a pure wording change.
    assert.match(text, /Keep the existing typography style/i);
  });

  it("still forbids inventing text the customer never asked for", async () => {
    const calls: CapturedCall[] = [];
    await newProvider(capturingFetch(calls)).generate(request());

    assert.match(
      editPromptOf(calls[0]!),
      /Do not add any text, letters, words, dates, or slogans/i,
    );
  });
});

describe("automated test safety — the edit path can never fire for real", () => {
  it("forces a non-editing placeholder provider regardless of ambient generation env vars", () => {
    const restore = {
      key: process.env.OPENAI_API_KEY,
      provider: process.env.CONCEPT_GENERATION_PROVIDER,
      enable: process.env.CONCEPT_GENERATION_ENABLE_REAL,
    };
    process.env.OPENAI_API_KEY = "sk-live-should-never-be-used";
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";

    try {
      const provider = resolveConceptGenerationProvider();
      assert.equal(provider.providerKey, "placeholder");
      // Nothing that could ever reach `/v1/images/edits`.
      assert.equal(provider.editsSourceArtwork, false);
      assert.equal(provider instanceof OpenAIConceptGenerationProvider, false);
    } finally {
      process.env.OPENAI_API_KEY = restore.key;
      process.env.CONCEPT_GENERATION_PROVIDER = restore.provider;
      process.env.CONCEPT_GENERATION_ENABLE_REAL = restore.enable;
    }
  });
});

describe("OpenAIConceptGenerationProvider — initial generation is untouched", () => {
  it("still uses the generations endpoint and still produces three concepts", async () => {
    const calls: CapturedCall[] = [];
    const result = await newProvider(capturingFetch(calls)).generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 3,
      prompt: prompt({ targetConceptDirectionKey: null, revision: null }),
      idempotencyKey: "concept-generation:design-1:version-1",
    });

    assert.equal(result.concepts.length, 3);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.url, "https://api.openai.com/v1/images/generations");
      assert.equal(typeof call.init.body, "string");
      assert.equal(JSON.parse(String(call.init.body)).n, 1);
    }
    for (const concept of result.concepts) {
      assert.equal(concept.kind, "concept");
    }
  });

  it("never requires a source image for initial generation", async () => {
    const calls: CapturedCall[] = [];
    const result = await newProvider(capturingFetch(calls)).generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 3,
      prompt: prompt({ targetConceptDirectionKey: null, revision: null }),
      idempotencyKey: "concept-generation:design-1:version-1",
      sourceArtwork: null,
    });

    assert.equal(result.concepts.length, 3);
  });
});
