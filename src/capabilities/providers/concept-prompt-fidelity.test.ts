import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import { CONCEPT_DIRECTIONS } from "@/lib/domain/concept-directions";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

/**
 * Detailed-Description Fidelity (Phase 1), parts B and C.
 *
 * WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT. They prove what iHeartPrints
 * SENDS: that the customer's complete content contract survives Prompt
 * Translation and reaches all three concept-direction prompts intact, and
 * that no direction's styling contradicts it. They prove nothing about
 * whether an image model obeys — that is what live acceptance is for, and no
 * offline test may claim otherwise.
 *
 * NO NETWORK. Every call below goes through an injected `fetchImpl` that
 * returns a canned response. Nothing here contacts OpenAI, gpt-image, Topaz,
 * Supabase, or any other service.
 */

const SMALL_B64 = Buffer.from("fake-png-bytes").toString("base64");

function snapshot(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirt",
    designDescription: null,
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

/**
 * Builds the three real provider prompts for an approved brief, offline —
 * approved brief → PromptTranslationCapability → OpenAI adapter dialect.
 * The whole deterministic path the audit found the fidelity loss in.
 */
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

  return prompts;
}

function assertAllContain(prompts: string[], fragments: string[]): void {
  prompts.forEach((prompt, index) => {
    const title = CONCEPT_DIRECTIONS[index]?.title ?? `#${index}`;
    for (const fragment of fragments) {
      assert.ok(
        prompt.toLowerCase().includes(fragment.toLowerCase()),
        `"${title}" prompt is missing required content "${fragment}"`,
      );
    }
  });
}

/**
 * The exact faithfully-preserved description the Conversation Understanding
 * regressions produce for the live Discovery Bay request (see
 * `intent-extraction/detailed-description-fidelity.test.ts`).
 */
const DISCOVERY_BAY_DESCRIPTION =
  "A design featuring the Discovery Bay California lighthouse, water shaped like a T, ski boats, cruiser boats, and jet skis. The Discovery Bay California lighthouse on the left with the water in a T shape. If you turn toward the marina, show the marina there. Going straight, homes are on the left side.";

describe("D — full Discovery-Bay-style regression (provider half)", () => {
  it("every required subject, position and the exact wording reach the provider", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: DISCOVERY_BAY_DESCRIPTION,
        exactText: "Discovery Bay California",
      }),
    );

    assert.equal(prompts.length, 3);
    assertAllContain(prompts, [
      "lighthouse",
      "on the left",
      "T shape",
      "marina",
      "homes",
      "ski boats",
      "cruiser boats",
      "jet skis",
      "Discovery Bay California",
    ]);
  });
});

describe("E — all three directions carry the identical customer content contract", () => {
  it("sends the same required-content and composition sections to every direction", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: DISCOVERY_BAY_DESCRIPTION,
        exactText: "Discovery Bay California",
      }),
    );

    const requiredContentSections = prompts.map(
      (prompt) => prompt.match(/REQUIRED DESIGN CONTENT[\s\S]*?(?=\n\n)/)?.[0] ?? "",
    );
    const compositionSections = prompts.map(
      (prompt) => prompt.match(/COMPOSITION[\s\S]*?(?=\n\n)/)?.[0] ?? "",
    );

    assert.ok(requiredContentSections[0]!.includes("lighthouse"));
    assert.ok(compositionSections[0]!.includes("on the left"));
    assert.equal(new Set(requiredContentSections).size, 1);
    assert.equal(new Set(compositionSections).size, 1);
  });

  it("still differs meaningfully in creative treatment — fidelity is not achieved by convergence", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: DISCOVERY_BAY_DESCRIPTION,
        exactText: "Discovery Bay California",
      }),
    );

    const styleSections = prompts.map(
      (prompt) => prompt.match(/STYLE \/ CREATIVE TREATMENT[\s\S]*?(?=\n\n)/)?.[0] ?? "",
    );
    assert.equal(new Set(styleSections).size, 3);
    assert.equal(new Set(prompts).size, 3);
    assert.match(prompts[0]!, /Bold & Direct/);
    assert.match(prompts[1]!, /Soft & Illustrated/);
    assert.match(prompts[2]!, /Minimal Badge/);
  });
});

describe("F — no direction contradicts required scene content", () => {
  it("never tells the provider 'no scene', 'not a scene', or 'single icon' for a scenic subject", async () => {
    const prompts = await directionPrompts(
      snapshot({ designDescription: DISCOVERY_BAY_DESCRIPTION }),
    );

    for (const [index, prompt] of prompts.entries()) {
      const title = CONCEPT_DIRECTIONS[index]!.title;
      const lowered = prompt.toLowerCase();
      for (const contradiction of ["no scene", "not a scene", "single icon", "single small icon", "one restrained icon"]) {
        assert.ok(
          !lowered.includes(contradiction),
          `"${title}" prompt contradicts the required scene with "${contradiction}"`,
        );
      }
    }
  });

  it("states the precedence rule that keeps a direction subordinate to the content", async () => {
    const prompts = await directionPrompts(
      snapshot({ designDescription: DISCOVERY_BAY_DESCRIPTION }),
    );
    for (const prompt of prompts) {
      assert.match(prompt, /DO NOT OMIT/);
      assert.match(prompt, /PRIORITY when anything conflicts/);
      assert.match(prompt, /never what is included or left out/i);
    }
  });
});

describe("G — a simple subject still supports a genuinely minimal treatment", () => {
  it("Minimal Badge stays minimal for a single simple subject", async () => {
    const prompts = await directionPrompts(
      snapshot({ designDescription: "A red 1988 Toyota MR2" }),
    );

    const minimalBadge = prompts[2]!;
    assert.match(minimalBadge, /Minimal Badge/);
    assert.match(minimalBadge, /a single small icon or mark, no scene/);
    assert.match(minimalBadge, /one restrained icon representative of the subject/);
  });

  it("keeps the generic centered-composition default when the customer stated no positions", async () => {
    const prompts = await directionPrompts(
      snapshot({ designDescription: "A red 1988 Toyota MR2" }),
    );
    for (const prompt of prompts) {
      assert.match(prompt, /centered composition/);
    }
  });
});

describe("H — explicit customer composition overrides the centering default", () => {
  it("withdraws generic centering when the customer said where things go", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: "Lighthouse on the left with marina on the right.",
      }),
    );

    for (const [index, prompt] of prompts.entries()) {
      const title = CONCEPT_DIRECTIONS[index]!.title;
      assert.ok(
        !prompt.includes("centered composition"),
        `"${title}" prompt still imposes a centered composition`,
      );
      assert.ok(
        !prompt.includes("centered, symmetrical layout"),
        `"${title}" prompt still imposes a centered, symmetrical layout`,
      );
      assert.match(prompt, /arranged to match the customer's stated composition/);
    }
  });

  it("restates the customer's own placements as composition requirements", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: "Lighthouse on the left with marina on the right.",
      }),
    );
    for (const prompt of prompts) {
      assert.match(prompt, /- Lighthouse on the left/);
      assert.match(prompt, /- marina on the right/);
      assert.match(prompt, /they outrank any layout, framing, or centering guidance/);
    }
  });
});

describe("I — customer content outranks the direction", () => {
  it("preserves count, subjects and relationship in every direction, including the minimal one", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: "Three dogs sitting beside a cabin with mountains behind them.",
      }),
    );

    assertAllContain(prompts, ["three dogs", "cabin", "mountains", "behind"]);
    for (const prompt of prompts) {
      assert.ok(!prompt.toLowerCase().includes("no scene"));
      assert.ok(!prompt.toLowerCase().includes("single icon"));
    }
  });
});

describe("J — required wording semantics are unchanged", () => {
  it("still demands the exact wording and forbids inventing any other text", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: "A red 1988 Toyota MR2",
        exactText: "MR2 TURBO",
      }),
    );
    for (const prompt of prompts) {
      assert.match(
        prompt,
        /include this exact wording, spelled correctly, and no other wording: "MR2 TURBO"/i,
      );
      assert.match(prompt, /do not add any other text/i);
    }
  });
});

describe("real-world geography is preserved but answered honestly", () => {
  it("carries the request through and states plainly that no reference is available", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: DISCOVERY_BAY_DESCRIPTION,
        additionalInstructions: "Make it look like the actual area if you can.",
      }),
    );
    for (const prompt of prompts) {
      assert.match(prompt, /Make it look like the actual area/);
      assert.match(prompt, /no map, aerial photograph, or other external geographic reference is available/);
      assert.match(prompt, /Do not invent landmarks that were not described/);
    }
  });

  it("never claims map accuracy", async () => {
    const prompts = await directionPrompts(
      snapshot({
        designDescription: DISCOVERY_BAY_DESCRIPTION,
        additionalInstructions: "Make it look like the actual area if you can.",
      }),
    );
    for (const prompt of prompts) {
      assert.ok(!/geographically accurate|to scale|survey[- ]accurate/i.test(prompt));
    }
  });
});
