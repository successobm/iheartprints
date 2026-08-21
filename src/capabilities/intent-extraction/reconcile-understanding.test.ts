import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileUnderstanding } from "./reconcile-understanding";
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
    garmentSizeClass: null,
    productionSizeConfirmedAt: null,
    productionSizeConfirmedWidthIn: null,
    productionSizeConfirmedMaxHeightIn: null,
    requestedProductionOutput: null,
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

describe("reconcileUnderstanding — null/empty input", () => {
  it("returns no fields for a null understanding (provider skipped/unavailable)", () => {
    const result = reconcileUnderstanding(null, { brief: brief() });
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.deferredSections, []);
    assert.equal(result.hadExplicitCorrection, false);
  });
});

describe("reconcileUnderstanding — unsupported/malformed sections rejected (Goal 10)", () => {
  it("rejects a proposed update for a section with no backing brief field", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "references" as never,
            value: "some reference",
            confidence: "explicit",
            evidence: "some reference",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.deepEqual(result.fields, {});
  });
});

describe("reconcileUnderstanding — never applies an ambiguous proposal (Goal 6/7)", () => {
  it("does not set a field when confidence is 'ambiguous'", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "ambiguous",
            evidence: "Make something cool for My 3 Sons",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.exactText, undefined);
  });
});

describe("reconcileUnderstanding — required wording protection (Goal 8)", () => {
  it("accepts required wording that is grounded in its own evidence", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "explicit",
            evidence: "our team is called My 3 Sons",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.exactText, "My 3 Sons");
  });

  it("rejects required wording NOT actually present in its evidence (paraphrase/hallucination guard)", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My Three Sons Bowling Club",
            confidence: "explicit",
            evidence: "our team is called My 3 Sons",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.exactText, undefined);
  });

  it("preserves the value's exact casing/spelling verbatim, never normalized", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sonz",
            confidence: "explicit",
            evidence: "actually spell it My 3 Sonz",
            isCorrection: true,
          },
        ],
      }),
      { brief: brief({ exactText: "My 3 Sons" }) },
    );
    assert.equal(result.fields.exactText, "My 3 Sonz");
    assert.equal(result.hadExplicitCorrection, true);
  });

  it("honors an explicit empty value (no wording) only at 'explicit' confidence", () => {
    const explicit = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "",
            confidence: "explicit",
            evidence: "no text on this one",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(explicit.fields.exactText, "");

    const inferred = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "",
            confidence: "inferred",
            evidence: "no text on this one",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(inferred.fields.exactText, undefined);
  });
});

describe("reconcileUnderstanding — normalization reuse (never bypasses deterministic normalization)", () => {
  it("normalizes product the same way a direct customer answer would", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "product",
            value: "tshirts",
            confidence: "explicit",
            evidence: "team t-shirts",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.productSummary, "T-shirt");
  });

  it("normalizes product color the same way a direct customer answer would", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "productColor",
            value: "navy",
            confidence: "explicit",
            evidence: "navy shirts",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.shirtColor, "Navy");
  });

  it("splits and normalizes a multi-color artwork-colors value", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "colors",
            value: "cream and orange",
            confidence: "explicit",
            evidence: "cream and orange",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.deepEqual(
      (result.fields.preferredColors ?? []).map((c) => c.toLowerCase()),
      ["cream", "orange"],
    );
  });

  it("parses a plain-language print location into the PrintPlacement enum", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "printLocation",
            value: "full back",
            confidence: "explicit",
            evidence: "full back",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.printPlacement, "full_back");
  });

  it("appends an exclusion note the same way appendNote does for a direct answer", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "exclusions",
            value: "No cartoons",
            confidence: "explicit",
            evidence: "no cartoons please",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief({ exclusions: "No skulls" }) },
    );
    assert.match(result.fields.exclusions ?? "", /No skulls/);
    assert.match(result.fields.exclusions ?? "", /No cartoons/);
  });
});

describe("reconcileUnderstanding — field-specific product grounding (Sprint 2L Phase 1A)", () => {
  const cases: Array<[value: string, evidence: string]> = [
    ["Hoodie", "staff hoodies"],
    ["T-shirt", "school fun run tees"],
    ["T-shirt", "family reunion shirts"],
    ["Polo", "company polos"],
    ["Jersey", "team jerseys"],
  ];

  for (const [value, evidence] of cases) {
    it(`grounds canonical Product "${value}" via recognized synonym evidence "${evidence}" (no literal containment)`, () => {
      const result = reconcileUnderstanding(
        understanding({
          proposedUpdates: [
            { section: "product", value, confidence: "explicit", evidence, isCorrection: false },
          ],
        }),
        { brief: brief() },
      );
      assert.equal(result.fields.productSummary, value);
    });
  }

  it("still grounds a descriptive product phrase via literal containment when no recognized synonym applies", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "product",
            value: "Custom Tote Bags",
            confidence: "explicit",
            evidence: "custom tote bags",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.productSummary, "Custom Tote Bags");
  });

  it("rejects a proposed Product with no relationship to its own evidence (hallucination guard)", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "product",
            value: "Hoodie",
            confidence: "explicit",
            evidence: "team t-shirts",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.productSummary, undefined);
  });

  it("required wording keeps exact-containment grounding — a recognized synonym never substitutes for it (Goal 8 unchanged)", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My Three Sons",
            confidence: "explicit",
            // Evidence contains a *different* spelling ("My 3 Sons") — this
            // must still be rejected even though it's semantically close,
            // unlike the looser Product policy above.
            evidence: "our team is called My 3 Sons",
            isCorrection: false,
          },
        ],
      }),
      { brief: brief() },
    );
    assert.equal(result.fields.exactText, undefined);
  });
});

describe("reconcileUnderstanding — deferrals only ever apply to deferrable sections", () => {
  it("accepts a deferral for a high-value/deferrable section", () => {
    const result = reconcileUnderstanding(
      understanding({ deferrals: [{ section: "colors", evidence: "no preference" }] }),
      { brief: brief() },
    );
    assert.deepEqual(result.deferredSections, ["colors"]);
  });

  it("rejects a deferral for a required (non-deferrable) section", () => {
    const result = reconcileUnderstanding(
      understanding({ deferrals: [{ section: "product", evidence: "you choose" }] }),
      { brief: brief() },
    );
    assert.deepEqual(result.deferredSections, []);
  });
});

describe("reconcileUnderstanding — multi-field resolution from one message (Goal 3)", () => {
  it("resolves product, requiredWording, audience, and purpose from one understanding result", () => {
    const result = reconcileUnderstanding(
      understanding({
        proposedUpdates: [
          {
            section: "product",
            value: "team t-shirts",
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
      { brief: brief() },
    );
    assert.equal(result.fields.productSummary, "Team T-Shirts");
    assert.equal(result.fields.exactText, "My 3 Sons");
    assert.equal(result.fields.audience, "Bowling team");
    assert.equal(result.fields.purpose, "Bowling league team apparel");
  });
});
