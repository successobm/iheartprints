import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PNG } from "pngjs";

import {
  createPromptTranslationCapability,
  createInitialGenerationIntent,
  withPrintPaletteCorrection,
} from "@/capabilities/prompt-translation";
import type { ConceptGenerationRequest } from "@/capabilities/shared/contracts";
import type {
  DesignBriefSnapshotContent,
  GenerationPromptRequest,
} from "@/lib/domain/types";

import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";

/**
 * PHASE 2C — the REPLACEMENT PROMPT contract.
 *
 * A replacement is the same concept corrected, not a different design. These
 * tests pin that down at the two places it can break: the provider-neutral
 * DTO Prompt Translation produces, and the OpenAI dialect the adapter builds
 * from it.
 *
 * NO NETWORK. Every provider call here goes through an injected `fetchImpl`
 * that returns a synthetic 1x1 PNG and records the request body. Nothing can
 * reach OpenAI, and no paid call is possible.
 */

function tinyPngBase64(): string {
  const png = new PNG({ width: 1, height: 1 });
  png.data.fill(255);
  return PNG.sync.write(png).toString("base64");
}

function hardPaletteBrief(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirts",
    designDescription:
      "A black 2005 Harley Road Glide with black leather and a black helmet",
    exactText: "IRON HORSE",
    shirtColor: "Black",
    printPlacement: "full_back",
    preferredColors: ["White"],
    designStyle: "vintage garage poster",
    exclusions: "no skulls",
    deferredSections: [],
    additionalInstructions: "keep it simple",
    audience: "riders",
    purpose: "club shirt",
    ...overrides,
  };
}

/** Captures the prompt a paid dispatch WOULD have sent. Never networks. */
function capturingProvider() {
  const prompts: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenAIConceptGenerationProvider({
    apiKey: "test-key-not-real",
    model: "gpt-image-1",
    quality: "medium",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      prompts.push(String(body.prompt));
      return new Response(
        JSON.stringify({ data: [{ b64_json: tinyPngBase64() }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
  return { provider, prompts, bodies };
}

function request(prompt: GenerationPromptRequest): ConceptGenerationRequest {
  return {
    designId: "design-1",
    designBriefId: "brief-1",
    conceptCount: 3,
    prompt,
    idempotencyKey: "idem-1",
  };
}

describe("Phase 2C — replacement prompt contract", () => {
  const translate = createPromptTranslationCapability();

  function prompts(brief: DesignBriefSnapshotContent) {
    const intent = createInitialGenerationIntent(brief);
    return {
      original: translate.translate(intent),
      correction: translate.translate(withPrintPaletteCorrection(intent)),
    };
  }

  // --- The provider-neutral DTO -------------------------------------------

  it("the correction changes exactly ONE field of the request — nothing else can drift", () => {
    const { original, correction } = prompts(hardPaletteBrief());

    assert.equal(original.printPaletteCorrection, undefined);
    assert.equal(correction.printPaletteCorrection, true);
    assert.deepEqual(
      { ...correction, printPaletteCorrection: undefined },
      { ...original, printPaletteCorrection: undefined },
      "subject, style, palette, wording, exclusions, notes, product and placement are all identical",
    );
  });

  it("an ordinary translation is byte-for-byte unchanged by Phase 2C", () => {
    const { original } = prompts(hardPaletteBrief());
    assert.ok(
      !("printPaletteCorrection" in original),
      "the field is absent, not `false` — no existing request shape changed",
    );
  });

  // --- L. The corrective instruction reaches the prompt --------------------

  it("L: a replacement prompt carries the deterministic print-palette correction", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { correction } = prompts(hardPaletteBrief());

    await provider.generateDirection(request(correction), "soft_illustrated");

    const prompt = sent[0]!;
    assert.match(prompt, /PRINT PALETTE CORRECTION/);
    assert.match(prompt, /failed the required print-palette \/ garment-contrast constraint/);
    assert.match(prompt, /Follow the REQUIRED PRINT PALETTE above strictly/);
    assert.match(prompt, /garment color dominate the artwork/);
    assert.match(prompt, /Preserve the subject's identity using the required printable palette/);
    assert.match(
      prompt,
      /Do not treat subject-object colors as literal print ink where they conflict/,
    );
    assert.match(
      prompt,
      /corrected version of the same concept, not a different design/,
    );
  });

  it("L: an ORDINARY prompt never mentions a correction", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { original } = prompts(hardPaletteBrief());

    await provider.generateDirection(request(original), "soft_illustrated");
    assert.doesNotMatch(sent[0]!, /PRINT PALETTE CORRECTION/);
  });

  it("L: the correction exposes no validator internals, thresholds, or numbers", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { correction } = prompts(hardPaletteBrief());
    await provider.generateDirection(request(correction), "soft_illustrated");

    const section = sent[0]!
      .split("\n\n")
      .find((part) => part.startsWith("PRINT PALETTE CORRECTION"));
    assert.ok(section);
    assert.doesNotMatch(section, /\d/, "no numbers of any kind");
    assert.doesNotMatch(section, /%|fraction|threshold|luminance|coverage/i);
    assert.doesNotMatch(
      section,
      /garment_matching|palette_not_dominant|insufficient_contrast|excessive_/i,
      "no validator reason codes",
    );
  });

  it("L: the correction only appears alongside a HARD print palette", async () => {
    const { provider, prompts: sent } = capturingProvider();
    // Soft enforcement: no subject-object colors outside the palette.
    const soft = hardPaletteBrief({
      designDescription: "A friendly bear mascot holding a pennant",
    });
    const { correction } = prompts(soft);
    assert.equal(correction.printPaletteEnforcement, "soft");

    await provider.generateDirection(request(correction), "soft_illustrated");
    assert.doesNotMatch(sent[0]!, /PRINT PALETTE CORRECTION/);
    assert.doesNotMatch(sent[0]!, /REQUIRED PRINT PALETTE/);
  });

  // --- M / N / O / P. What a replacement must NOT change -------------------

  it("N: a replacement preserves the required wording contract exactly", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { correction } = prompts(hardPaletteBrief());

    await provider.generateDirection(request(correction), "bold_direct");
    assert.equal(correction.requiredWording, "IRON HORSE");
    assert.match(sent[0]!, /REQUIRED WORDING — include this exact wording/);
    assert.match(sent[0]!, /"IRON HORSE"/);
    assert.match(
      sent[0]!,
      /Do not add any other text, letters, words, dates, or slogans/,
    );
  });

  it("M: a replacement preserves an explicit NO TEXT contract", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { correction } = prompts(hardPaletteBrief({ exactText: "" }));
    assert.equal(correction.wordingMode, "none");

    await provider.generateDirection(request(correction), "bold_direct");
    assert.match(sent[0]!, /NO TEXT — the customer explicitly asked/);
    assert.match(sent[0]!, /PRINT PALETTE CORRECTION/);
    assert.doesNotMatch(sent[0]!, /REQUIRED WORDING/);
  });

  it("M: a replacement preserves exclusions and the hard-palette priority rule", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { correction } = prompts(hardPaletteBrief());

    await provider.generateDirection(request(correction), "minimal_badge");
    assert.match(sent[0]!, /Avoid: no skulls\./);
    assert.match(sent[0]!, /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT/);
    assert.match(
      sent[0]!,
      /No creative direction may override the required print palette/,
    );
  });

  it("O: a replacement generates the SAME catalog direction, one image", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { correction } = prompts(hardPaletteBrief());

    const result = await provider.generateDirection(
      request(correction),
      "soft_illustrated",
    );
    assert.equal(result.concepts.length, 1);
    assert.equal(result.concepts[0]?.directionKey, "soft_illustrated");
    assert.equal(sent.length, 1, "exactly one paid dispatch per replacement");
    assert.match(sent[0]!, /Creative direction — Soft & Illustrated/);
  });

  it("P: a replacement uses the same model, quality, size and background as an initial image", async () => {
    const { provider, bodies } = capturingProvider();
    const { original, correction } = prompts(hardPaletteBrief());

    await provider.generateDirection(request(original), "soft_illustrated");
    await provider.generateDirection(request(correction), "soft_illustrated");

    assert.equal(bodies.length, 2);
    const [initial, replacement] = bodies as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    assert.equal(replacement.model, initial.model);
    assert.equal(replacement.quality, initial.quality);
    assert.equal(replacement.size, initial.size);
    assert.equal(replacement.background, initial.background);
    assert.equal(replacement.n, initial.n);
    assert.equal(
      replacement.quality,
      "medium",
      "Phase 2C never bumps a replacement to a more expensive quality",
    );
  });

  // --- Z / AA. Untouched earlier phases ------------------------------------

  it("Z: Phase 2A hard-palette prompt rules are unchanged by Phase 2C", async () => {
    const { provider, prompts: sent } = capturingProvider();
    const { original } = prompts(hardPaletteBrief());

    await provider.generateDirection(request(original), "bold_direct");
    const prompt = sent[0]!;
    assert.match(prompt, /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT:/);
    assert.match(prompt, /Render the printable artwork primarily in: White\./);
    assert.match(
      prompt,
      /Garment: Black — maintain strong visible contrast against this fabric\./,
    );
    assert.match(
      prompt,
      /The required print palette overrides literal subject-object color where the two conflict\./,
    );
    assert.match(prompt, /Subject-only colors \(identity, not dominant ink\)/);
  });
});
