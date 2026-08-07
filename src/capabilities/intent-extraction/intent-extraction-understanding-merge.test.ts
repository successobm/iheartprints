import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIntentExtractionCapability } from "./intent-extraction-capability";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import type { TShirtDesignBrief } from "@/lib/domain/types";

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

function understanding(
  overrides: Partial<ConversationUnderstandingResult> = {},
): ConversationUnderstandingResult {
  return {
    proposedUpdates: [],
    deferrals: [],
    ambiguities: [],
    customerIntent: "provide_info",
    answeredPendingSection: null,
    ...overrides,
  };
}

const capability = createIntentExtractionCapability();

describe("IntentExtractionCapability — precedence when `understanding` is absent (Sprint 2L regression safety)", () => {
  it("behaves byte-for-byte like deterministic-only extraction when `understanding` is omitted", () => {
    const withUnderstandingOmitted = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Navy hoodies with a red and gold logo.",
    });
    const withUnderstandingNull = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Navy hoodies with a red and gold logo.",
      understanding: null,
    });
    assert.deepEqual(withUnderstandingOmitted, withUnderstandingNull);
    assert.equal(withUnderstandingOmitted.proposals[0]?.fields.shirtColor, "Navy");
  });
});

describe("IntentExtractionCapability — a validated understanding update overrides a deterministic one for the same field", () => {
  it("prefers the semantic interpretation's product color over the deterministic one when both fire", () => {
    // Deterministic extraction alone would read "navy" here (see
    // extraction.test.ts parity case) — understanding proposes a
    // deliberately different, still-valid value to prove precedence.
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Actually make that navy.",
      pendingSection: "productColor",
      understanding: understanding({
        proposedUpdates: [
          {
            section: "productColor",
            value: "Heather Grey",
            confidence: "explicit",
            evidence: "make that navy",
            isCorrection: true,
          },
        ],
      }),
    });
    assert.equal(result.proposals[0]?.fields.shirtColor, "Heather Grey");
  });
});

describe("IntentExtractionCapability — understanding fills gaps deterministic extraction alone would miss (Goal 3)", () => {
  it("resolves audience/purpose from understanding while deterministic extraction alone resolves nothing structured", () => {
    const reply =
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";

    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply,
      understanding: understanding({
        proposedUpdates: [
          {
            section: "product",
            value: "T-shirt",
            confidence: "explicit",
            evidence: "team t-shirts",
            isCorrection: false,
          },
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "explicit",
            evidence: "our team is called My 3 Sons",
            isCorrection: false,
          },
          {
            section: "audience",
            value: "Bowling team",
            confidence: "inferred",
            evidence: "I'm in a bowling league",
            isCorrection: false,
          },
          {
            section: "purpose",
            value: "Bowling league team apparel",
            confidence: "inferred",
            evidence: "I'm in a bowling league",
            isCorrection: false,
          },
        ],
      }),
    });

    const fields = result.proposals[0]?.fields ?? {};
    assert.equal(fields.productSummary, "T-shirt");
    assert.equal(fields.exactText, "My 3 Sons");
    assert.equal(fields.audience, "Bowling team");
    assert.equal(fields.purpose, "Bowling league team apparel");
  });
});

describe("IntentExtractionCapability — deferral union across both sources", () => {
  it("keeps the brief's already-deferred sections when understanding proposes an additional, different one", () => {
    const result = capability.extract({
      brief: brief({ deferredSections: ["style"] }),
      phase: "interviewing",
      reply: "No preference, choose whatever colors work best.",
      pendingSection: "colors",
      understanding: understanding({
        deferrals: [{ section: "colors", evidence: "choose whatever colors work best" }],
      }),
    });
    const deferred = new Set(result.proposals[0]?.fields.deferredSections ?? []);
    assert.ok(deferred.has("style"));
    assert.ok(deferred.has("colors"));
  });
});

describe("IntentExtractionCapability — ambiguous understanding never applies (Goal 6)", () => {
  it("leaves requiredWording unresolved when understanding flags it as ambiguous, with no deterministic match either", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Make something cool for My 3 Sons.",
      understanding: understanding({
        ambiguities: [
          {
            section: "requiredWording",
            note: "Unclear whether 'My 3 Sons' must appear as printed text.",
          },
        ],
      }),
    });
    assert.equal(result.proposals[0]?.fields.exactText, undefined);
  });
});

describe("IntentExtractionCapability — correction intent tagging from understanding", () => {
  it("tags 'correct' when understanding flags isCorrection even without the deterministic correction cue", () => {
    const result = capability.extract({
      brief: brief({ exactText: "My 3 Sons" }),
      phase: "interviewing",
      reply: "with the number 3",
      pendingSection: "requiredWording",
      understanding: understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "explicit",
            evidence: "My 3 Sons — with the number 3",
            isCorrection: true,
          },
        ],
      }),
    });
    assert.ok(result.intents.includes("correct"));
  });
});
