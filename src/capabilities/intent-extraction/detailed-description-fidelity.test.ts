import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIntentExtractionCapability } from "./intent-extraction-capability";
import { preserveDesignDetail } from "./preserve-design-detail";
import { reconcileUnderstanding } from "./reconcile-understanding";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import { analyzeDesignContent } from "@/lib/domain/design-content-contract";
import type { TShirtDesignBrief } from "@/lib/domain/types";

/**
 * Detailed-Description Fidelity (Phase 1), part A regressions.
 *
 * These prove what the DETERMINISTIC layers guarantee, which is the only
 * thing an automated test can honestly prove. They deliberately do NOT
 * assert that OpenAI's Conversation Understanding model will comply with its
 * strengthened instructions, and they make zero network calls: every
 * `ConversationUnderstandingResult` below is a hand-written fixture standing
 * in for a provider response, including the deliberately LOSSY responses the
 * Discovery Bay live acceptance audit actually observed.
 *
 * The contract under test: whatever the model returns, the design-critical
 * objects, counts, positions and relationships the customer stated survive
 * into `designDescription`.
 */

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

/** A provider response proposing exactly one `graphics` synthesis. */
function graphicsUnderstanding(value: string): ConversationUnderstandingResult {
  return {
    proposedUpdates: [
      {
        section: "graphics",
        value,
        confidence: "explicit",
        evidence: value,
        isCorrection: false,
      },
    ],
    deferrals: [],
    ambiguities: [],
    customerIntent: "provide_info",
    answeredPendingSection: null,
  };
}

/** The reconciled `designDescription` for one customer message + one synthesis. */
function reconciledDescription(synthesis: string, message: string): string {
  const result = reconcileUnderstanding(graphicsUnderstanding(synthesis), {
    brief: brief(),
    message,
  });
  return result.fields.designDescription ?? "";
}

function assertRetains(description: string, required: string[]): void {
  for (const fragment of required) {
    assert.match(
      description,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `design description lost "${fragment}": ${description}`,
    );
  }
}

describe("A — Conversation Understanding preserves stated spatial relationships", () => {
  const message =
    "Put the lighthouse on the left, marina on the right, and homes behind the lighthouse.";

  it("restores every position a lossy synthesis dropped", () => {
    // The exact failure shape the audit found: a short, tidy, designer-
    // sounding phrase with every position removed.
    const description = reconciledDescription("Lighthouse with boats", message);
    assertRetains(description, [
      "lighthouse",
      "left",
      "marina",
      "right",
      "homes",
      "behind",
    ]);
  });

  it("keeps each element bound to its OWN position, not just the words in a bag", () => {
    const description = reconciledDescription("Lighthouse with boats", message);
    const contract = analyzeDesignContent(description);
    assert.equal(contract.hasExplicitComposition, true);
    assert.equal(contract.requiresScene, true);
    // Structure, not keyword presence: each stated relationship survives as a
    // readable statement pairing its subject with its position.
    const statements = contract.compositionStatements.join(" | ").toLowerCase();
    assert.match(statements, /lighthouse[^|]*\bleft\b/);
    assert.match(statements, /marina[^|]*\bright\b/);
    assert.match(statements, /homes[^|]*\bbehind\b/);
  });

  it("leaves an already-faithful synthesis completely untouched", () => {
    const faithful =
      "Coastal scene with the lighthouse on the left, the marina on the right, and homes behind the lighthouse";
    assert.equal(reconciledDescription(faithful, message), faithful);
  });
});

describe("B — every distinct required object category survives", () => {
  it("keeps ski boats, cruiser boats and jet skis as three separate categories", () => {
    const description = reconciledDescription(
      "A lighthouse scene",
      "Include ski boats, cruiser boats, and jet skis.",
    );
    assertRetains(description, ["ski boats", "cruiser boats", "jet skis"]);
  });

  it("does not accept a collapsed 'boats' synthesis as covering all three", () => {
    const description = reconciledDescription(
      "A lighthouse scene with boats",
      "Include ski boats, cruiser boats, and jet skis.",
    );
    assertRetains(description, ["ski", "cruiser", "jet"]);
  });

  it("preserves a stated count", () => {
    const description = reconciledDescription(
      "Dogs beside a cabin",
      "Three dogs sitting beside a cabin with mountains behind them.",
    );
    assertRetains(description, ["three dogs", "cabin", "mountains", "behind"]);
  });
});

describe("C — scene structure survives", () => {
  it("retains a T-shaped waterway and the lighthouse position", () => {
    const description = reconciledDescription(
      "A lighthouse",
      "Show a T-shaped waterway with the lighthouse on the left.",
    );
    assertRetains(description, ["T-shaped", "waterway", "lighthouse", "left"]);
    assert.equal(analyzeDesignContent(description).requiresScene, true);
  });
});

describe("D — full Discovery-Bay-style regression (Conversation Understanding half)", () => {
  const message =
    "Create a design of the Discovery Bay California lighthouse on the left with the water in a T shape. If you turn toward the marina, show the marina there. Going straight, homes are on the left side. Show ski boats, cruiser boats and jet skis. Wording is Discovery Bay California.";

  // Verbatim shape of the synthesis the live audit observed: polished,
  // plausible, and missing the lighthouse position, the marina, the homes,
  // and the entire compositional contract.
  const observedLossySynthesis =
    "A design featuring the Discovery Bay California lighthouse, water shaped like a T, ski boats, cruiser boats, and jet skis";

  it("recovers every design-critical detail the observed live synthesis dropped", () => {
    const description = reconciledDescription(observedLossySynthesis, message);
    assertRetains(description, [
      "lighthouse",
      "left",
      "T shape",
      "marina",
      "homes",
      "ski boats",
      "cruiser boats",
      "jet skis",
    ]);
  });

  it("does not contaminate the design description with the required wording clause", () => {
    const description = reconciledDescription(observedLossySynthesis, message);
    assert.doesNotMatch(description, /wording is/i);
  });

  it("produces a description that reads as an explicitly composed scene", () => {
    const contract = analyzeDesignContent(
      reconciledDescription(observedLossySynthesis, message),
    );
    assert.equal(contract.hasExplicitComposition, true);
    assert.equal(contract.requiresScene, true);
    assert.ok(contract.requiredElementCount >= 5);
  });
});

describe("no contamination from other Design Brief sections", () => {
  it("never folds a garment-color clause into the design description", () => {
    const description = reconciledDescription(
      "A red 1988 Toyota MR2",
      "no the color of the shirt is black the design is my 1988 Toyota MR2 which is Red",
    );
    assert.equal(description, "A red 1988 Toyota MR2");
  });

  it("never folds a print-placement answer into the design description", () => {
    const description = reconciledDescription(
      "A red 1988 Toyota MR2",
      "Print it on the left chest.",
    );
    assert.equal(description, "A red 1988 Toyota MR2");
  });

  it("never folds a bare placement answer into the design description", () => {
    assert.equal(preserveDesignDetail("A red 1988 Toyota MR2", "left chest"), "A red 1988 Toyota MR2");
  });

  it("never folds a palette preference into the design description", () => {
    const description = reconciledDescription(
      "A friendly bear mascot",
      "Use blue and gold colors in the design.",
    );
    assert.equal(description, "A friendly bear mascot");
  });
});

describe("a simple request is never padded", () => {
  it("leaves a short, complete synthesis exactly as the provider wrote it", () => {
    for (const [synthesis, message] of [
      ["A cool red race car", "I want a cool red race car"],
      ["A red 1988 Toyota MR2", "lets create a t-shirt design of my Red 1988 Toyota MR2"],
      [
        "Retro bowling team logo inspired by a classic sitcom-era aesthetic",
        "this is a take on the old sitcom my 3 sons, so i want to create a team logo but bowling themed, with that retro vibe",
      ],
    ] as const) {
      assert.equal(preserveDesignDetail(synthesis, message), synthesis);
    }
  });

  it("is a no-op when there is no customer message to compare against", () => {
    assert.equal(preserveDesignDetail("A red race car", null), "A red race car");
    assert.equal(preserveDesignDetail("A red race car", ""), "A red race car");
  });
});

describe("the deterministic fallback path is equally faithful (no provider configured)", () => {
  it("keeps the whole spatial description when Conversation Understanding is unavailable", () => {
    const capability = createIntentExtractionCapability();
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply:
        "Create a design of the lighthouse on the left with the water in a T shape. Homes are on the left side. Show ski boats, cruiser boats and jet skis.",
      pendingSection: "graphics",
      understanding: null,
    });

    const description = result.proposals[0]?.fields.designDescription ?? "";
    assertRetains(description, [
      "lighthouse",
      "left",
      "T shape",
      "homes",
      "ski boats",
      "cruiser boats",
      "jet skis",
    ]);
  });
});
