import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConceptGenerationProvider } from "@/capabilities/providers/openai-concept-provider";
import {
  createPromptTranslationCapability,
  derivePrintPalette,
} from "@/capabilities/prompt-translation";
import { CONCEPT_DIRECTIONS } from "@/lib/domain/concept-directions";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

/**
 * Phase 2A — Print palette vs subject-color separation.
 *
 * Proves the generation-facing contract: garment, subject-object colors, and
 * rendered print palette stay distinct; explicit contrast resolutions become
 * HARD required print palette instructions; creative directions cannot dilute
 * that hard constraint.
 *
 * NO NETWORK. Injected fetchImpl only — never contacts OpenAI/Topaz/etc.
 */

const SMALL_B64 = Buffer.from("fake-png-bytes").toString("base64");

const LIVE_HARLEY_DESCRIPTION =
  "A 2005 Harley Road Glide in black with silver trim and black tailpipes, featuring slight rise straight pull back bars, with a rider wearing a skull mask and helmet in black leather, and the Oakland Coliseum in the background, reflecting an Oakland Raiders theme. The rider is wearing a skull bask and helmet in black leather, with the oakland coliseum in the background Oakland Raiders theme.";

function snapshot(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirt",
    designDescription: null,
    exactText: null,
    shirtColor: null,
    printPlacement: "full_back",
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    ...overrides,
  };
}

async function directionPrompts(
  content: DesignBriefSnapshotContent,
): Promise<string[]> {
  const prompts: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt: string };
    prompts.push(body.prompt);
    return new Response(JSON.stringify({ data: [{ b64_json: SMALL_B64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const provider = new OpenAIConceptGenerationProvider({
    apiKey: "sk-test-offline",
    model: "gpt-image-1",
    fetchImpl,
  });

  await provider.generate({
    designId: "design-1",
    designBriefId: "version-1",
    conceptCount: 3,
    prompt: createPromptTranslationCapability().translate({
      approvedBrief: content,
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    }),
    idempotencyKey: "concept-generation:design-1:version-1",
  });

  assert.equal(prompts.length, 3);
  return prompts;
}

function assertAllContain(prompts: string[], fragments: string[]): void {
  for (const [index, prompt] of prompts.entries()) {
    const title = CONCEPT_DIRECTIONS[index]?.title ?? `#${index}`;
    for (const fragment of fragments) {
      assert.ok(
        prompt.toLowerCase().includes(fragment.toLowerCase()),
        `"${title}" missing "${fragment}"`,
      );
    }
  }
}

function assertNoneContain(prompts: string[], fragments: string[]): void {
  for (const [index, prompt] of prompts.entries()) {
    const title = CONCEPT_DIRECTIONS[index]?.title ?? `#${index}`;
    for (const fragment of fragments) {
      assert.ok(
        !prompt.toLowerCase().includes(fragment.toLowerCase()),
        `"${title}" must not contain "${fragment}"`,
      );
    }
  }
}

describe("derivePrintPalette — Phase 2A", () => {
  it("A: explicit conflict correction (black subject + white palette on black garment) is HARD", () => {
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: LIVE_HARLEY_DESCRIPTION,
        exactText: "",
      }),
    );
    assert.equal(derived.enforcement, "hard");
    assert.deepEqual(derived.colors, ["White"]);
    assert.equal(derived.garmentColor, "Black");
    assert.ok(derived.subjectOnlyColors.includes("black"));
  });

  it("I: casual preferredColors with no subject color conflict stay SOFT", () => {
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "Navy",
        preferredColors: ["Gold", "Cream"],
        designDescription: "A friendly bowling team mascot",
      }),
    );
    assert.equal(derived.enforcement, "soft");
    assert.deepEqual(derived.subjectOnlyColors, []);
  });

  it("K: keep-black-anyway (palette still matches garment) stays SOFT, never hard white", () => {
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["Black"],
        designDescription: "A black motorcycle on a black shirt",
      }),
    );
    assert.equal(derived.enforcement, "soft");
    assert.deepEqual(derived.colors, ["Black"]);
  });

  it("none when preferredColors empty or deferred", () => {
    assert.equal(
      derivePrintPalette(snapshot({ shirtColor: "Black" })).enforcement,
      "none",
    );
    assert.equal(
      derivePrintPalette(
        snapshot({
          shirtColor: "Black",
          preferredColors: ["White"],
          deferredSections: ["colors"],
        }),
      ).enforcement,
      "none",
    );
  });
});

describe("print-palette provider contract — Phase 2A", () => {
  it("A/B/C: live Harley regression — hard white print palette preserves black-Harley identity", async () => {
    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: LIVE_HARLEY_DESCRIPTION,
        exactText: "",
        printPlacement: "full_back",
        productSummary: "T-shirt",
      }),
    );

    assertAllContain(prompts, [
      "REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT",
      "Render the printable artwork primarily in: White",
      "Garment: Black",
      "Harley Road Glide",
      "in black",
      "black leather",
      "REQUIRED PRINT PALETTE hard constraint",
      "NO TEXT",
    ]);

    // Soft "Preferred colors" must not remain as the only/optional phrasing.
    assertNoneContain(prompts, ["Preferred colors: White"]);

    // Must not invent a semantic "white Harley" rewrite of the subject.
    for (const prompt of prompts) {
      assert.doesNotMatch(
        prompt,
        /\bwhite\s+harley\b/i,
        "prompt must not rewrite subject into a white Harley",
      );
      assert.match(prompt, /in black with silver trim/i);
    }

    // Subject-only colors called out; dominant black ink discouraged.
    assertAllContain(prompts, [
      "Subject-only colors",
      "not literal print ink",
      "overrides literal subject-object color",
    ]);
  });

  it("F: all three concept directions inherit the SAME hard print palette", async () => {
    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: LIVE_HARLEY_DESCRIPTION,
        exactText: "",
      }),
    );

    assert.equal(prompts.length, 3);
    for (const [index, prompt] of prompts.entries()) {
      assert.match(prompt, /Bold & Direct|Soft & Illustrated|Minimal Badge/);
      assert.match(
        prompt,
        /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT/,
        CONCEPT_DIRECTIONS[index]!.title,
      );
      assert.match(prompt, /Print palette \/ dominant ink color is not among them/);
    }

    // Creative density still differs — Soft is richest — without dropping palette.
    assert.match(prompts[1]!, /richest|full scenic|warm, illustrated/i);
    assert.match(prompts[1]!, /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT/);
  });

  it("D: white garment + black artwork hard contract", async () => {
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "White",
        preferredColors: ["Black"],
        designDescription: "A white swan with white feathers on calm water",
      }),
    );
    assert.equal(derived.enforcement, "hard");

    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "White",
        preferredColors: ["Black"],
        designDescription: "A white swan with white feathers on calm water",
        exactText: "",
      }),
    );
    assertAllContain(prompts, [
      "REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT",
      "primarily in: Black",
      "Garment: White",
      "white swan",
    ]);
    assertNoneContain(prompts, ["Preferred colors: Black"]);
  });

  it("E: navy subject + white artwork on navy garment is HARD", async () => {
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "Navy",
        preferredColors: ["White"],
        designDescription: "A navy blue lighthouse on a rocky coast",
      }),
    );
    assert.equal(derived.enforcement, "hard");
  });

  it("E (red subject + monochrome white palette): HARD and keeps red identity", async () => {
    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: "A red 1988 Toyota MR2 with chrome wheels",
        exactText: "",
      }),
    );
    assertAllContain(prompts, [
      "REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT",
      "primarily in: White",
      "red 1988 Toyota MR2",
      "Subject-only colors",
    ]);
    assert.doesNotMatch(prompts[0]!, /\bwhite\s+1988\s+toyota\b/i);
  });

  it("F matrix: multicolor subject + single-color print palette is HARD", async () => {
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription:
          "A red motorcycle with blue flames and gold accents",
      }),
    );
    assert.equal(derived.enforcement, "hard");
    assert.ok(derived.subjectOnlyColors.includes("red"));
    assert.ok(derived.subjectOnlyColors.includes("blue"));
    assert.ok(derived.subjectOnlyColors.includes("gold"));
  });

  it("G: no-text remains hard alongside hard print palette", async () => {
    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: LIVE_HARLEY_DESCRIPTION,
        exactText: "",
      }),
    );
    assertAllContain(prompts, ["NO TEXT"]);
    assertNoneContain(prompts, [
      "Typography:",
      "REQUIRED WORDING",
      "CREATIVE FREEDOM: typography treatment",
    ]);
  });

  it("H: required wording remains hard with soft palette", async () => {
    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "Navy",
        preferredColors: ["Gold", "Cream"],
        designDescription: "A friendly bowling team mascot",
        exactText: "My 3 Sons",
      }),
    );
    assertAllContain(prompts, [
      'REQUIRED WORDING — include this exact wording',
      "My 3 Sons",
      "Preferred colors: Gold, Cream",
    ]);
    assertNoneContain(prompts, [
      "REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT",
    ]);
  });

  it("J: garment-color change (not artwork palette) does not invent hard white", () => {
    // Customer fixed clash by changing the shirt; preferred colors stay gold.
    const derived = derivePrintPalette(
      snapshot({
        shirtColor: "White",
        preferredColors: ["Gold"],
        designDescription: "A bowling ball smashing pins",
      }),
    );
    assert.equal(derived.enforcement, "soft");
  });

  it("L: shirt color is never phrased as the artwork palette", async () => {
    const prompts = await directionPrompts(
      snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: LIVE_HARLEY_DESCRIPTION,
        exactText: "",
      }),
    );
    assertNoneContain(prompts, [
      "Preferred colors: Black",
      "primarily in: Black",
    ]);
    assertAllContain(prompts, ["primarily in: White", "Garment: Black"]);
  });

  it("N: offline only — fetchImpl never hits a real host", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: SMALL_B64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const provider = new OpenAIConceptGenerationProvider({
      apiKey: "sk-test-offline",
      model: "gpt-image-1",
      fetchImpl,
    });
    await provider.generate({
      designId: "design-1",
      designBriefId: "version-1",
      conceptCount: 1,
      prompt: createPromptTranslationCapability().translate({
        approvedBrief: snapshot({
          shirtColor: "Black",
          preferredColors: ["White"],
          designDescription: LIVE_HARLEY_DESCRIPTION,
          exactText: "",
        }),
        regenerationPlan: null,
        targetConceptDirectionKey: null,
        revisionInstruction: null,
      }),
      idempotencyKey: "concept-generation:design-1:version-1",
    });
    assert.equal(fetchCalls, 1);
  });
});

describe("PromptTranslationCapability — Phase 2A field mapping", () => {
  it("maps hard enforcement and subject-only colors onto GenerationPromptRequest", () => {
    const request = createPromptTranslationCapability().translate({
      approvedBrief: snapshot({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: LIVE_HARLEY_DESCRIPTION,
        exactText: "",
      }),
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    });
    assert.equal(request.printPaletteEnforcement, "hard");
    assert.deepEqual(request.colors, ["White"]);
    assert.equal(request.productColor, "Black");
    assert.ok(request.subjectOnlyColors.includes("black"));
    assert.ok(request.subjectOnlyColors.includes("silver"));
    assert.equal(request.wordingMode, "none");
    assert.match(request.subject, /Harley Road Glide in black/i);
  });

  it("maps soft enforcement for casual preferences", () => {
    const request = createPromptTranslationCapability().translate({
      approvedBrief: snapshot({
        shirtColor: "Navy",
        preferredColors: ["Gold", "Cream"],
        designDescription: "A friendly bowling team mascot",
      }),
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    });
    assert.equal(request.printPaletteEnforcement, "soft");
    assert.deepEqual(request.subjectOnlyColors, []);
  });
});
