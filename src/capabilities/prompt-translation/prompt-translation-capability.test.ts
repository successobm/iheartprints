import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPromptTranslationCapability } from "./prompt-translation-capability";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";

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

function plan(overrides: Partial<RegenerationPlan> = {}): RegenerationPlan {
  return {
    preserve: [],
    strengthen: [],
    remove: [],
    replace: [],
    avoid: [],
    priorityChanges: [],
    unchangedSections: [],
    customerRequestedChanges: [],
    evaluationDrivenChanges: [],
    generationAttempt: 2,
    reason: "test plan",
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

describe("PromptTranslationCapability — optional RegenerationPlan", () => {
  const translation = createPromptTranslationCapability();

  it("without a plan, output matches the brief-only translation exactly", () => {
    const brief = content();
    assert.deepEqual(translation.translate(brief), translation.translate(brief, null));
    assert.deepEqual(translation.translate(brief), translation.translate(brief, undefined));
  });

  it("merges plan priorityChanges into notes in priority order without provider dialect", () => {
    const result = translation.translate(
      content(),
      plan({
        avoid: [
          {
            section: "exclusions",
            description: "No cartoon animals",
            source: "brief",
            reason: "exclusions",
          },
        ],
        strengthen: [
          {
            section: "style",
            description: "Make sure the design style reflects the customer's requested change.",
            source: "customer_revision",
            reason: "customer",
          },
        ],
        evaluationDrivenChanges: [
          {
            section: "graphics",
            description: "Strengthen the graphics so it clearly matches the brief.",
            source: "evaluation",
            reason: "evaluation",
          },
        ],
        priorityChanges: [
          {
            section: "exclusions",
            description: "No cartoon animals",
            source: "brief",
            reason: "exclusions",
          },
          {
            section: "requiredWording",
            description: "Make sure the required wording reflects the customer's requested change.",
            source: "customer_revision",
            reason: "customer",
          },
          {
            section: "style",
            description: "Make sure the design style reflects the customer's requested change.",
            source: "customer_revision",
            reason: "customer",
          },
          {
            section: "graphics",
            description: "Strengthen the graphics so it clearly matches the brief.",
            source: "evaluation",
            reason: "evaluation",
          },
        ],
      }),
    );

    assert.equal(result.exclusions, "No cartoon animals");
    assert.equal(result.requiredWording, "Camp Wildwood 2026");
    assert.match(result.notes ?? "", /Keep it simple/);
    assert.match(result.notes ?? "", /required wording/);
    assert.match(result.notes ?? "", /design style/);
    assert.match(result.notes ?? "", /graphics/);
    // Exclusions description is not duplicated into notes.
    assert.equal((result.notes ?? "").includes("No cartoon animals"), false);
    assert.doesNotMatch(
      JSON.stringify(result),
      /masterpiece|8k|openai|photorealistic/i,
    );
  });

  it("applies remove actions by clearing the corresponding request fields", () => {
    const result = translation.translate(
      content({ exactText: "" }),
      plan({
        remove: [
          {
            section: "requiredWording",
            description: "Customer removed the required wording",
            source: "customer_revision",
            reason: "removed",
          },
          {
            section: "style",
            description: "Customer removed the design style",
            source: "customer_revision",
            reason: "removed",
          },
        ],
        priorityChanges: [],
      }),
    );
    assert.equal(result.requiredWording, null);
    assert.equal(result.style, null);
  });

  it("is deterministic and idempotent for the same brief + plan", () => {
    const brief = content();
    const regenerationPlan = plan({
      priorityChanges: [
        {
          section: "style",
          description: "Strengthen the design style so it clearly matches the brief.",
          source: "evaluation",
          reason: "failed",
        },
      ],
    });
    const a = translation.translate(brief, regenerationPlan);
    const b = translation.translate(brief, regenerationPlan);
    assert.deepEqual(a, b);
  });
});
