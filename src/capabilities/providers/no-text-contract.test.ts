import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import { OpenAIConceptEvaluationProvider } from "@/capabilities/concept-evaluation/openai-concept-evaluation-provider";
import type { ConceptEvaluationRequest } from "@/capabilities/concept-evaluation";
import { createIntentExtractionCapability } from "@/capabilities/intent-extraction";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import { CONCEPT_DIRECTIONS, describeConceptDirection } from "@/lib/domain/concept-directions";
import { deriveRequiredWording } from "@/lib/domain/required-wording";
import type {
  DesignBriefSnapshotContent,
  TShirtDesignBrief,
} from "@/lib/domain/types";

/**
 * Phase 1.1, Part B regressions — explicit no-text semantics.
 *
 * The live failure: the customer answered "No wording" to "what exact text
 * should appear?". The brief correctly stored `exactText: ""` and derived
 * `mode: "none"` — and then `GenerationPromptRequest` flattened that to
 * `requiredWording: null`, indistinguishable from an unanswered question.
 * The provider prompt kept typography-forward direction language, told the
 * model not to add text "beyond the exact wording specified above" when no
 * wording was specified above, listed typography under creative freedom, and
 * the returned artwork carried visible lettering. Evaluation passed it,
 * because "no required wording" read as "nothing to check".
 *
 * NO NETWORK. Every provider call below uses an injected `fetchImpl`.
 */

const SMALL_B64 = Buffer.from("fake-png-bytes").toString("base64");

/** Phrases that would AUTHORIZE lettering. None may survive into a no-text prompt. */
const TEXT_AUTHORIZING_PHRASES = [
  "typography-forward",
  "hand-lettered",
  "headline",
  "arced or stacked typography",
  "Typography:",
  "REQUIRED WORDING",
  "beyond the exact wording specified above",
  "CREATIVE FREEDOM: typography treatment",
  "the required wording is the dominant visual element",
  "wording is integrated into the illustration",
  "banner, ribbon, or hand-lettered treatment",
];

function snapshot(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirt",
    designDescription: "A red 1988 Toyota MR2",
    exactText: null,
    shirtColor: "White",
    printPlacement: "full_front",
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

function brief(overrides: Partial<TShirtDesignBrief> = {}): TShirtDesignBrief {
  return {
    id: "brief-1",
    projectId: "project-1",
    customerName: null,
    projectName: null,
    productSummary: null,
    designDescription: null,
    exactText: null,
    shirtColor: null,
    printPlacement: null,
    intendedPrintWidthIn: null,
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
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

  await new OpenAIConceptGenerationProvider({
    apiKey: "sk-test-offline",
    model: "gpt-image-1",
    fetchImpl,
  }).generate({
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

  return prompts;
}

/** Drives one customer answer through Intent Extraction, deterministically. */
function answerWording(reply: string): string | null | undefined {
  const result = createIntentExtractionCapability().extract({
    brief: brief(),
    phase: "interviewing",
    reply,
    pendingSection: "requiredWording",
    understanding: null,
  });
  return result.proposals[0]?.fields.exactText;
}

describe("G/H — an explicit 'none' answer records explicit no-text, in every phrasing", () => {
  for (const reply of ["none", "No wording", "no text", "nothing", "n/a"]) {
    it(`"${reply}" resolves to explicit no-text`, () => {
      const exactText = answerWording(reply);
      assert.equal(exactText, "");
      assert.equal(deriveRequiredWording({ exactText: exactText ?? null }).mode, "none");
    });
  }

  it("carries the explicit state all the way into the generation request", () => {
    const request = createPromptTranslationCapability().translate({
      approvedBrief: snapshot({ exactText: "" }),
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    });
    assert.equal(request.wordingMode, "none");
    assert.equal(request.requiredWording, null);
  });
});

describe("O — an unresolved wording question is NOT a no-text request", () => {
  it("translates to 'unknown', never 'none'", () => {
    const request = createPromptTranslationCapability().translate({
      approvedBrief: snapshot({ exactText: null }),
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    });
    assert.equal(request.wordingMode, "unknown");
    assert.equal(request.requiredWording, null);
  });

  it("produces no hard no-text constraint in the provider prompt", async () => {
    const prompts = await directionPrompts(snapshot({ exactText: null }));
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /^NO TEXT/m);
      // …but it still must not invent wording, and must not dangle a
      // reference to wording that was never specified.
      assert.match(prompt, /has not specified any wording/i);
      assert.doesNotMatch(prompt, /beyond the exact wording specified above/i);
    }
  });
});

describe("I — the no-text provider prompt carries a hard constraint and nothing that authorizes text", () => {
  it("states an unambiguous no-text rule", async () => {
    const prompts = await directionPrompts(snapshot({ exactText: "" }));
    for (const prompt of prompts) {
      assert.match(prompt, /^NO TEXT/m);
      assert.match(prompt, /must contain no text of any kind/i);
      assert.match(
        prompt,
        /Do not render any words, letters, numbers, typography, labels, captions, titles, signage, monograms, dates, slogans, decorative lettering, or invented brand text/i,
      );
      assert.match(prompt, /no text or lettering of any kind/i);
    }
  });

  it("contains no phrase that would authorize lettering", async () => {
    const prompts = await directionPrompts(snapshot({ exactText: "" }));
    for (const [index, prompt] of prompts.entries()) {
      const title = CONCEPT_DIRECTIONS[index]!.title;
      for (const phrase of TEXT_AUTHORIZING_PHRASES) {
        assert.ok(
          !prompt.includes(phrase),
          `"${title}" no-text prompt still contains text-authorizing "${phrase}"`,
        );
      }
    }
  });

  it("states that no creative direction justifies adding lettering", async () => {
    const prompts = await directionPrompts(snapshot({ exactText: "" }));
    for (const prompt of prompts) {
      assert.match(prompt, /No creative direction, badge convention, or stylistic habit justifies adding lettering/);
      assert.match(prompt, /Typography is not among them/);
    }
  });
});

describe("J — all three directions stay distinct with zero typography permission", () => {
  const scenic = snapshot({
    exactText: "",
    designDescription:
      "Discovery Bay California scene with the lighthouse in the waterways, the channel leading to the marina, homes along the shoreline, and boats passing through the channel.",
  });

  it("sends the identical required content to every direction", async () => {
    const prompts = await directionPrompts(scenic);
    const requiredContent = prompts.map(
      (prompt) => prompt.match(/REQUIRED DESIGN CONTENT[\s\S]*?(?=\n\n)/)?.[0] ?? "",
    );
    assert.equal(new Set(requiredContent).size, 1);
    for (const prompt of prompts) {
      for (const element of ["lighthouse", "marina", "homes", "boats", "channel"]) {
        assert.ok(prompt.toLowerCase().includes(element), `missing ${element}`);
      }
    }
  });

  it("keeps three genuinely different creative treatments", async () => {
    const prompts = await directionPrompts(scenic);
    const styleSections = prompts.map(
      (prompt) => prompt.match(/STYLE \/ CREATIVE TREATMENT[\s\S]*?(?=\n\n)/)?.[0] ?? "",
    );
    assert.equal(new Set(styleSections).size, 3);
    assert.match(prompts[0]!, /Bold & Direct/);
    assert.match(prompts[1]!, /Soft & Illustrated/);
    assert.match(prompts[2]!, /Minimal Badge/);
  });

  it("gives none of them typography guidance", async () => {
    const prompts = await directionPrompts(scenic);
    for (const [index, prompt] of prompts.entries()) {
      const title = CONCEPT_DIRECTIONS[index]!.title;
      assert.ok(
        !prompt.includes("Typography:"),
        `"${title}" still carries a typography line`,
      );
      for (const phrase of TEXT_AUTHORIZING_PHRASES) {
        assert.ok(!prompt.includes(phrase), `"${title}" contains "${phrase}"`);
      }
    }
  });
});

describe("K — the exact-wording path is unchanged", () => {
  const withWording = snapshot({
    exactText: "Discovery Bay California",
    designDescription:
      "Discovery Bay California scene with the lighthouse on the left and the marina on the right.",
  });

  it("still demands the exact wording in every direction", async () => {
    const prompts = await directionPrompts(withWording);
    for (const prompt of prompts) {
      assert.match(
        prompt,
        /REQUIRED WORDING — include this exact wording, spelled correctly, and no other wording: "Discovery Bay California"\./,
      );
      assert.match(prompt, /beyond the exact wording specified above/i);
      assert.doesNotMatch(prompt, /^NO TEXT/m);
    }
  });

  it("still gives every direction its typography treatment", async () => {
    const prompts = await directionPrompts(withWording);
    for (const prompt of prompts) {
      assert.match(prompt, /Typography: /);
    }
    assert.match(prompts[0]!, /typography-forward/);
  });
});

describe("L — an explicit no-text state can later be superseded by real wording", () => {
  it("a customer who first said 'none' can add wording afterwards", () => {
    // Start: explicit no-text.
    const started = createIntentExtractionCapability().extract({
      brief: brief(),
      phase: "interviewing",
      reply: "No wording",
      pendingSection: "requiredWording",
      understanding: null,
    });
    assert.equal(started.proposals[0]?.fields.exactText, "");

    // Later: the customer changes their mind.
    const changed = createIntentExtractionCapability().extract({
      brief: brief({ exactText: "" }),
      phase: "interviewing",
      reply: 'Actually add "Discovery Bay"',
      pendingSection: "requiredWording",
      understanding: null,
    });
    assert.equal(changed.proposals[0]?.fields.exactText, "Discovery Bay");
  });

  it("typography becomes available again once wording exists", async () => {
    const before = await directionPrompts(snapshot({ exactText: "" }));
    const after = await directionPrompts(snapshot({ exactText: "Discovery Bay" }));

    assert.match(before[0]!, /^NO TEXT/m);
    assert.doesNotMatch(after[0]!, /^NO TEXT/m);
    assert.match(after[0]!, /Typography: /);
    assert.match(after[0]!, /REQUIRED WORDING/);
  });

  it("the no-text state is not sticky in the generation request", () => {
    const translate = createPromptTranslationCapability();
    assert.equal(
      translate.translate({
        approvedBrief: snapshot({ exactText: "" }),
        regenerationPlan: null,
        targetConceptDirectionKey: null,
        revisionInstruction: null,
      }).wordingMode,
      "none",
    );
    assert.equal(
      translate.translate({
        approvedBrief: snapshot({ exactText: "Discovery Bay" }),
        regenerationPlan: null,
        targetConceptDirectionKey: null,
        revisionInstruction: null,
      }).wordingMode,
      "provided",
    );
  });
});

describe("concept card copy matches the contract the provider was given", () => {
  it("says graphic-only when the customer asked for no text", () => {
    const request = createPromptTranslationCapability().translate({
      approvedBrief: snapshot({ exactText: "" }),
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    });
    for (const direction of CONCEPT_DIRECTIONS) {
      const summary = describeConceptDirection(direction, request);
      assert.match(summary, /Graphic-only — no text\./);
      assert.doesNotMatch(summary, /Featuring "/);
    }
  });

  it("names the exact wording when there is some", () => {
    const request = createPromptTranslationCapability().translate({
      approvedBrief: snapshot({ exactText: "Discovery Bay" }),
      regenerationPlan: null,
      targetConceptDirectionKey: null,
      revisionInstruction: null,
    });
    assert.match(
      describeConceptDirection(CONCEPT_DIRECTIONS[0]!, request),
      /Featuring "Discovery Bay"\./,
    );
  });
});

/* ------------------------------------------------------------------ */
/* M / N — evaluation                                                  */
/* ------------------------------------------------------------------ */

function evaluationRequest(
  briefOverrides: Partial<DesignBriefSnapshotContent> = {},
): ConceptEvaluationRequest {
  return {
    brief: snapshot({
      designDescription: "A marina scene with boats",
      exactText: "",
      exclusions: null,
      designStyle: null,
      preferredColors: [],
      ...briefOverrides,
    }),
    concept: { title: "Concept A", summary: "s", placeholderLabel: "Concept A" },
    assets: [
      {
        assetId: "asset-1",
        contentType: "image/png",
        widthPx: 1024,
        heightPx: 1024,
        isThumbnail: false,
        sourceUrl: "https://assets.example.test/signed/asset-1",
      },
    ],
    idempotencyKey: "eval-key-1",
  };
}

function evaluateWith(payload: Record<string, unknown>) {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  return new OpenAIConceptEvaluationProvider({
    apiKey: "sk-test-offline",
    model: "gpt-4o-mini",
    fetchImpl,
  });
}

const NEUTRAL_SIGNALS = {
  exclusions: { violated: null, details: "", confidence: 0 },
  style: { matches: null, score: null, confidence: 0, notes: "" },
  graphics: { matches: true, score: 90, confidence: 85, notes: "marina and boats present" },
  colorPalette: { matches: null, score: null, confidence: 0, notes: "" },
  productCompatibility: { matches: true, score: 90, confidence: 80, notes: "fits" },
  composition: { score: 85, confidence: 80, notes: "balanced" },
  readability: { score: 85, confidence: 80, notes: "clear" },
  overallAlignment: { score: 90, confidence: 90, notes: "strong" },
  warnings: [],
  recommendations: [],
};

describe("M — evaluation fails a no-text concept that contains visible lettering", () => {
  it("fails when the model reads 'MARINA' off the artwork", async () => {
    const provider = evaluateWith({
      ...NEUTRAL_SIGNALS,
      noText: { violated: true, detectedText: "MARINA", confidence: 95, notes: "large word across the top" },
    });
    const result = await provider.evaluate(evaluationRequest());

    assert.equal(result.status, "failed");
    assert.equal(result.passed, false);
    assert.ok(result.missingRequirements.includes("no text"));
    const wording = result.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.passed, false);
    assert.equal(wording?.score, 0);
  });

  it("fails on readable text even when the model claims no violation", async () => {
    // The code cross-check, not the model's own boolean, is decisive — the
    // same protection the required-wording path already had.
    const provider = evaluateWith({
      ...NEUTRAL_SIGNALS,
      noText: { violated: false, detectedText: "DISCOVERY BAY", confidence: 40, notes: "small text on the hull" },
    });
    const result = await provider.evaluate(evaluationRequest());

    assert.equal(result.status, "failed");
    assert.ok(result.missingRequirements.includes("no text"));
  });
});

describe("N — evaluation passes a genuinely graphic-only no-text concept", () => {
  it("records the no-text requirement as met", async () => {
    const provider = evaluateWith({
      ...NEUTRAL_SIGNALS,
      noText: { violated: false, detectedText: "", confidence: 92, notes: "no lettering anywhere" },
    });
    const result = await provider.evaluate(evaluationRequest());

    assert.notEqual(result.status, "failed");
    assert.ok(result.matchedRequirements.includes("no text"));
    const wording = result.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.passed, true);
    assert.equal(wording?.score, 100);
  });

  it("does not apply the no-text check when wording was never answered", async () => {
    const provider = evaluateWith({
      ...NEUTRAL_SIGNALS,
      noText: { violated: true, detectedText: "SOMETHING", confidence: 99, notes: "text present" },
    });
    const result = await provider.evaluate(evaluationRequest({ exactText: null }));

    // Unresolved wording is not a no-text request — a concept must never be
    // failed for lettering the customer never prohibited.
    assert.notEqual(result.status, "failed");
    assert.ok(!result.missingRequirements.includes("no text"));
    const wording = result.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.notes, "not_specified_in_brief");
  });
});

/* ------------------------------------------------------------------ */
/* Full live-style regression: multi-turn design intent + no text       */
/* ------------------------------------------------------------------ */

describe("FULL — Discovery Bay multi-turn conversation ending in 'No wording'", () => {
  /**
   * Replays the live conversation shape offline. Turn 1 establishes the
   * location, lighthouse, waterways and the real-area/aerial request; turn 2
   * adds the channel, marina, homes and boats; turn 3 answers the wording
   * question with "No wording".
   */
  function runConversation(): TShirtDesignBrief {
    const capability = createIntentExtractionCapability();
    let current = brief();

    const understanding = (value: string) => ({
      proposedUpdates: [
        {
          section: "graphics" as const,
          value,
          confidence: "explicit" as const,
          evidence: value,
          isCorrection: false,
        },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info" as const,
      answeredPendingSection: null,
    });

    const turnOne = capability.extract({
      brief: current,
      phase: "interviewing",
      reply:
        "Are you familiar with Discovery Bay California? I want the design based on the lighthouse and waterways and an aerial idea of the real area.",
      pendingSection: "graphics",
      understanding: understanding(
        "Discovery Bay California design based on the lighthouse and the waterways, using an aerial idea of the real area",
      ),
    });
    current = { ...current, ...turnOne.proposals[0]!.fields };

    const turnTwo = capability.extract({
      brief: current,
      phase: "interviewing",
      reply:
        "I want to show the waterway that leads to the marina, with the lighthouse, nearby homes, and boats passing through the channel.",
      pendingSection: "graphics",
      understanding: understanding(
        "The waterway leading to the marina, with the lighthouse, nearby homes, and boats passing through the channel",
      ),
    });
    current = { ...current, ...turnTwo.proposals[0]!.fields };

    const turnThree = capability.extract({
      brief: current,
      phase: "interviewing",
      reply: "No wording",
      pendingSection: "requiredWording",
      understanding: null,
    });
    current = { ...current, ...turnThree.proposals[0]!.fields };

    return current;
  }

  it("the final brief carries every turn's design intent plus explicit no-text", () => {
    const final = runConversation();
    const description = final.designDescription ?? "";

    for (const fragment of [
      "Discovery Bay",
      "lighthouse",
      "waterway",
      "aerial",
      "real area",
      "marina",
      "homes",
      "boats",
      "channel",
    ]) {
      assert.match(
        description,
        new RegExp(fragment, "i"),
        `final brief lost "${fragment}": ${description}`,
      );
    }

    assert.equal(final.exactText, "");
    assert.equal(deriveRequiredWording(final).mode, "none");
  });

  it("all three provider prompts carry the full content and a hard no-text rule", async () => {
    const final = runConversation();
    const prompts = await directionPrompts(
      snapshot({
        designDescription: final.designDescription,
        exactText: final.exactText,
      }),
    );

    assert.equal(prompts.length, 3);
    for (const [index, prompt] of prompts.entries()) {
      const title = CONCEPT_DIRECTIONS[index]!.title;
      for (const element of [
        "Discovery Bay",
        "lighthouse",
        "waterway",
        "marina",
        "homes",
        "boats",
        "channel",
      ]) {
        assert.ok(
          prompt.toLowerCase().includes(element.toLowerCase()),
          `"${title}" prompt is missing "${element}"`,
        );
      }
      assert.match(prompt, /^NO TEXT/m);
      for (const phrase of TEXT_AUTHORIZING_PHRASES) {
        assert.ok(!prompt.includes(phrase), `"${title}" contains "${phrase}"`);
      }
      // Real-world intent survives, answered honestly.
      assert.match(prompt, /no map, aerial photograph, or other external geographic reference is available/);
    }

    // Still three genuinely different creative treatments.
    const styleSections = prompts.map(
      (prompt) => prompt.match(/STYLE \/ CREATIVE TREATMENT[\s\S]*?(?=\n\n)/)?.[0] ?? "",
    );
    assert.equal(new Set(styleSections).size, 3);
  });
});
