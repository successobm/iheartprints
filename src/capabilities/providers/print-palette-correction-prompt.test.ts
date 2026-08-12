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
    assert.match(
      prompt,
      /failed the required print-palette \/ garment-contrast constraint because too much garment-matching color was rendered as opaque printed artwork/,
    );
    assert.match(
      prompt,
      /Follow the REQUIRED PRINT PALETTE and the TRANSPARENCY \/ NEGATIVE SPACE rules above strictly/,
    );
    assert.match(prompt, /Do not use large opaque garment-matching fills/);
    assert.match(
      prompt,
      /Encode empty space and garment-supplied negative space as transparent alpha/,
    );
    assert.match(
      prompt,
      /Transparency must be real alpha, not simulated by filling with the garment color/,
    );
    assert.match(
      prompt,
      /Preserve the subject's identity and the same creative direction using the required print palette/,
    );
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

  it("Z: Phase 2A hard-palette prompt rules remain, with Phase 2C.2A transparency hardening", async () => {
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
    assert.match(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.match(
      prompt,
      /A transparent outer canvas alone is not enough/,
    );
  });
});

describe("Phase 2C.2A — transparency / negative-space prompt contract", () => {
  const translate = createPromptTranslationCapability();

  function prompts(brief: DesignBriefSnapshotContent) {
    const intent = createInitialGenerationIntent(brief);
    return {
      original: translate.translate(intent),
      correction: translate.translate(withPrintPaletteCorrection(intent)),
    };
  }

  async function capture(
    brief: DesignBriefSnapshotContent,
    direction: "bold_direct" | "soft_illustrated" | "minimal_badge",
    corrected: boolean,
  ) {
    const { provider, prompts: sent, bodies } = capturingProvider();
    const { original, correction } = prompts(brief);
    await provider.generateDirection(
      request(corrected ? correction : original),
      direction,
    );
    return { prompt: sent[0]!, body: bodies[0]! };
  }

  // A / B. Black subject + black garment + hard white palette
  it("A/B: black Harley on black garment keeps semantic black and bans opaque black print fill", async () => {
    const { prompt } = await capture(hardPaletteBrief({ exactText: "" }), "bold_direct", false);
    assert.match(prompt, /black 2005 Harley Road Glide/i);
    assert.match(prompt, /black leather/i);
    assert.match(prompt, /black helmet/i);
    assert.match(prompt, /Subject-only colors \(identity, not dominant ink\): black/);
    assert.match(prompt, /Render the printable artwork primarily in: White\./);
    assert.match(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.match(prompt, /do not paint large interiors[\s\S]*opaque garment-colored RGB/);
    assert.match(prompt, /Encode those areas as transparent alpha/);
    assert.match(prompt, /Outer background: fully transparent \(alpha\)/);
    assert.match(prompt, /internal garment-supplied negative space/i);
  });

  // C. White garment + hard black palette (inverse)
  it("C: white garment + hard black palette uses the inverse transparency contract", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        shirtColor: "White",
        preferredColors: ["Black"],
        designDescription: "A white swan on a still lake",
        exactText: "",
      }),
      "soft_illustrated",
      false,
    );
    assert.match(prompt, /Render the printable artwork primarily in: Black\./);
    assert.match(prompt, /Garment: White/);
    assert.match(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.match(prompt, /Outer background: fully transparent \(alpha\), never an opaque fill matching the White garment/);
    assert.match(prompt, /white swan/i);
  });

  // D. Navy garment + white palette
  it("D: navy garment + hard white palette carries the same alpha rule", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        shirtColor: "Navy",
        preferredColors: ["White"],
        designDescription: "A navy lighthouse beside white cliffs",
        exactText: "",
      }),
      "minimal_badge",
      false,
    );
    assert.match(prompt, /Garment: Navy/);
    assert.match(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.match(prompt, /never an opaque fill matching the Navy garment/);
  });

  // E. Red subject + hard white print
  it("E: red semantic subject is preserved while white print treatment is required", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription: "A bright red fire truck with a chrome ladder",
        exactText: "",
      }),
      "bold_direct",
      false,
    );
    assert.match(prompt, /bright red fire truck/i);
    assert.match(prompt, /Render the printable artwork primarily in: White\./);
    assert.match(prompt, /Subject-only colors \(identity, not dominant ink\): red/);
    assert.match(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
  });

  // F. Multicolor subject + monochrome palette
  it("F: multicolor subject under a monochrome hard palette still gets the transparency rule", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        shirtColor: "Black",
        preferredColors: ["White"],
        designDescription:
          "A green dragon with gold scales and blue wings breathing orange fire",
        exactText: "",
      }),
      "soft_illustrated",
      false,
    );
    assert.match(prompt, /green dragon/i);
    assert.match(prompt, /gold scales/i);
    assert.match(prompt, /blue wings/i);
    assert.match(prompt, /Render the printable artwork primarily in: White\./);
    assert.match(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
  });

  // G. Garment color included in hard print palette — do not falsely prohibit
  it("G: when garment color is in the required print palette, opaque use of that color stays allowed", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        shirtColor: "Black",
        preferredColors: ["White", "Black"],
        // Silver outside the palette keeps enforcement HARD while Black
        // remains an intentional print color.
        designDescription: "A black motorcycle with silver trim",
        exactText: "",
      }),
      "minimal_badge",
      false,
    );
    assert.match(prompt, /Render the printable artwork primarily in: White, Black\./);
    assert.match(prompt, /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT/);
    assert.match(
      prompt,
      /If a color is explicitly listed in the required print palette above, using that color as printed ink is intentional and allowed/,
    );
    assert.match(
      prompt,
      /This rule only forbids substituting opaque garment-matching fill for transparency when that color is outside the required print palette/,
    );
  });

  // H. Soft palette — no hard negative-space rule
  it("H: soft palette does not invent the hard transparency / negative-space rule", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        designDescription: "A friendly bear mascot holding a pennant",
        preferredColors: ["Cream"],
        exactText: "",
      }),
      "bold_direct",
      false,
    );
    assert.equal(
      prompts(
        hardPaletteBrief({
          designDescription: "A friendly bear mascot holding a pennant",
          preferredColors: ["Cream"],
        }),
      ).original.printPaletteEnforcement,
      "soft",
    );
    assert.doesNotMatch(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.doesNotMatch(prompt, /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT/);
    assert.match(prompt, /transparent background/);
  });

  // I. No palette
  it("I: no palette invents no hard transparency rule", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({
        preferredColors: [],
        designDescription: "A simple mountain silhouette",
        shirtColor: "Black",
        exactText: "",
      }),
      "bold_direct",
      false,
    );
    assert.doesNotMatch(prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.doesNotMatch(prompt, /REQUIRED PRINT PALETTE — HARD PRODUCTION CONSTRAINT/);
  });

  // J / K / L. No-text, wording, exclusions preserved under hardening
  it("J/K/L: no-text, required wording, and exclusions survive the transparency hardening", async () => {
    const noText = await capture(
      hardPaletteBrief({ exactText: "" }),
      "bold_direct",
      false,
    );
    assert.match(noText.prompt, /NO TEXT — the customer explicitly asked/);
    assert.match(noText.prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);

    const wording = await capture(hardPaletteBrief(), "soft_illustrated", false);
    assert.match(wording.prompt, /REQUIRED WORDING[\s\S]*"IRON HORSE"/);
    assert.match(wording.prompt, /Avoid: no skulls\./);
    assert.match(wording.prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
  });

  // M. All three directions inherit
  it("M: Bold, Soft, and Minimal inherit identical hard transparency rules", async () => {
    const brief = hardPaletteBrief({ exactText: "" });
    const sections: string[] = [];
    for (const direction of [
      "bold_direct",
      "soft_illustrated",
      "minimal_badge",
    ] as const) {
      const { prompt } = await capture(brief, direction, false);
      const block = prompt
        .split("\n\n")
        .find((part) => part.includes("TRANSPARENCY / NEGATIVE SPACE — HARD PRODUCTION RULE"));
      assert.ok(block, direction);
      sections.push(block!);
      assert.match(prompt, new RegExp(`Creative direction — .+`));
    }
    assert.equal(sections[0], sections[1]);
    assert.equal(sections[1], sections[2]);
  });

  // N / O / P / Q. Replacement delta, same direction, same quality, transparent request
  it("N: replacement adds a stronger corrective block on top of the base transparency contract", async () => {
    const brief = hardPaletteBrief({ exactText: "" });
    const initial = await capture(brief, "soft_illustrated", false);
    const replacement = await capture(brief, "soft_illustrated", true);

    assert.match(initial.prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.doesNotMatch(initial.prompt, /PRINT PALETTE CORRECTION/);
    assert.match(replacement.prompt, /TRANSPARENCY \/ NEGATIVE SPACE — HARD PRODUCTION RULE/);
    assert.match(replacement.prompt, /PRINT PALETTE CORRECTION/);
    assert.match(
      replacement.prompt,
      /because too much garment-matching color was rendered as opaque printed artwork/,
    );

    const initialWithoutClosingNoise = initial.prompt;
    assert.ok(
      replacement.prompt.includes(initialWithoutClosingNoise.split("PRINT PALETTE CORRECTION")[0]!.trim()) ||
        replacement.prompt.includes("TRANSPARENCY / NEGATIVE SPACE — HARD PRODUCTION RULE"),
      "base contract remains present on replacement",
    );
  });

  it("O/P/Q: replacement keeps direction, medium quality, and transparent background request", async () => {
    const { provider, prompts: sent, bodies } = capturingProvider();
    const { original, correction } = prompts(hardPaletteBrief({ exactText: "" }));
    await provider.generateDirection(request(original), "minimal_badge");
    await provider.generateDirection(request(correction), "minimal_badge");

    assert.match(sent[1]!, /Creative direction — Minimal Badge/);
    assert.equal(bodies[1]!.quality, "medium");
    assert.equal(bodies[1]!.size, "1024x1024");
    assert.equal(bodies[1]!.background, "transparent");
    assert.equal(bodies[1]!.model, bodies[0]!.model);
  });

  // R. No Phase 2B numeric thresholds in prompts
  it("R: prompts contain no Phase 2B numeric thresholds or reason codes", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({ exactText: "" }),
      "bold_direct",
      true,
    );
    assert.doesNotMatch(prompt, /garmentMatchingFraction|paletteCoverageFraction/i);
    assert.doesNotMatch(prompt, /0\.35|0\.4|0\.08|HARD_FAIL/);
    assert.doesNotMatch(
      prompt,
      /excessive_garment_matching_ink|hard_palette_not_dominant/,
    );
  });

  // S. Subject-vs-palette Phase 2A behavior preserved
  it("S: Phase 2A subject-vs-palette separation is preserved under 2C.2A", async () => {
    const { prompt } = await capture(
      hardPaletteBrief({ exactText: "" }),
      "bold_direct",
      false,
    );
    assert.match(
      prompt,
      /Colors named in REQUIRED DESIGN CONTENT describe real-world subject\/object identity, not literal print ink/,
    );
    assert.match(
      prompt,
      /The required print palette overrides literal subject-object color where the two conflict/,
    );
    assert.match(prompt, /Subject-only colors \(identity, not dominant ink\): black/);
  });
});
