import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPromptTranslationCapability } from "./prompt-translation-capability";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

function content(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "Camp t-shirts",
    designDescription: "A friendly bear logo",
    exactText: "Camp Wildwood 2026",
    shirtColor: "Navy",
    printPlacement: "full_front",
    preferredColors: ["Gold", "Cream"],
    designStyle: "Rustic hand-drawn",
    additionalInstructions: "Keep it simple",
    audience: "Camp families",
    purpose: "Fundraiser",
    exclusions: "No cartoon animals",
    deferredSections: [],
    ...overrides,
  };
}

describe("PromptTranslationCapability", () => {
  const translation = createPromptTranslationCapability();

  it("carries plain Design Brief fields into the neutral request unembellished", () => {
    const result = translation.translate(content());
    assert.equal(result.product, "Camp t-shirts");
    assert.equal(result.subject, "A friendly bear logo");
    assert.equal(result.requiredWording, "Camp Wildwood 2026");
    assert.equal(result.productColor, "Navy");
    assert.equal(result.printLocation, "full_front");
    assert.deepEqual(result.colors, ["Gold", "Cream"]);
    assert.equal(result.style, "Rustic hand-drawn");
    assert.equal(result.audience, "Camp families");
    assert.equal(result.purpose, "Fundraiser");
    assert.equal(result.exclusions, "No cartoon animals");
    assert.equal(result.notes, "Keep it simple");
  });

  it("never introduces provider quality-boosting keywords", () => {
    const result = translation.translate(content());
    const joined = JSON.stringify(result);
    assert.doesNotMatch(
      joined,
      /highly detailed|8k|masterpiece|photorealistic|trending on/i,
    );
  });

  it("leaves a deferred section out of the prompt request instead of guessing a value", () => {
    const result = translation.translate(
      content({ deferredSections: ["style", "colors"], designStyle: "Rustic", preferredColors: ["Gold"] }),
    );
    assert.equal(result.style, null);
    assert.deepEqual(result.colors, []);
    // Un-deferred fields are unaffected.
    assert.equal(result.productColor, "Navy");
  });

  it("falls back to safe, generic language when the brief itself is sparse", () => {
    const result = translation.translate(
      content({ productSummary: null, designDescription: null, shirtColor: null }),
    );
    assert.equal(result.product, "a custom t-shirt");
    assert.match(result.subject, /customer's intent/);
    assert.equal(result.productColor, null);
  });

  it("preserves required wording exactly, including punctuation and case", () => {
    const result = translation.translate(
      content({ exactText: 'Camp "Wildwood" — Est. 1987' }),
    );
    assert.equal(result.requiredWording, 'Camp "Wildwood" — Est. 1987');
  });
});
