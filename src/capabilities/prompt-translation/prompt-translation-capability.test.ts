import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";

import {
  createInitialGenerationIntent,
  createPromptTranslationCapability,
  createRegenerationGenerationIntent,
  translateApprovedBrief,
} from "./index";

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

describe("PromptTranslationCapability — GenerationIntent", () => {
  const translation = createPromptTranslationCapability();

  it("initial intent is byte-for-byte equivalent to the historical brief-only mapping", () => {
    const brief = content();
    const viaIntent = translation.translate(createInitialGenerationIntent(brief));
    const historical = translateApprovedBrief(brief);
    assert.deepEqual(viaIntent, historical);
    assert.equal(JSON.stringify(viaIntent), JSON.stringify(historical));
  });

  it("carries plain Design Brief fields into the neutral request unembellished", () => {
    const result = translation.translate(createInitialGenerationIntent(content()));
    assert.equal(result.product, "Camp t-shirts");
    assert.equal(result.subject, "A friendly bear logo");
    assert.equal(result.requiredWording, "Camp Wildwood 2026");
    assert.equal(result.productColor, "Navy");
    assert.equal(result.printLocation, "full_front");
    assert.deepEqual(result.colors, ["Gold", "Cream"]);
    assert.equal(result.printPaletteEnforcement, "soft");
    assert.deepEqual(result.subjectOnlyColors, []);
    assert.equal(result.style, "Rustic hand-drawn");
    assert.equal(result.audience, "Camp families");
    assert.equal(result.purpose, "Fundraiser");
    assert.equal(result.exclusions, "No cartoon animals");
    assert.equal(result.notes, "Keep it simple");
  });

  it("never introduces provider quality-boosting keywords", () => {
    const result = translation.translate(createInitialGenerationIntent(content()));
    assert.doesNotMatch(
      JSON.stringify(result),
      /highly detailed|8k|masterpiece|photorealistic|trending on/i,
    );
  });

  it("leaves a deferred section out of the prompt request instead of guessing a value", () => {
    const result = translation.translate(
      createInitialGenerationIntent(
        content({
          deferredSections: ["style", "colors"],
          designStyle: "Rustic",
          preferredColors: ["Gold"],
        }),
      ),
    );
    assert.equal(result.style, null);
    assert.deepEqual(result.colors, []);
    assert.equal(result.printPaletteEnforcement, "none");
    assert.equal(result.productColor, "Navy");
  });

  it("falls back to safe, generic language when the brief itself is sparse", () => {
    const result = translation.translate(
      createInitialGenerationIntent(
        content({ productSummary: null, designDescription: null, shirtColor: null }),
      ),
    );
    assert.equal(result.product, "a custom t-shirt");
    assert.match(result.subject, /customer's intent/);
    assert.equal(result.productColor, null);
  });

  it("preserves required wording exactly, including punctuation and case", () => {
    const result = translation.translate(
      createInitialGenerationIntent(
        content({ exactText: 'Camp "Wildwood" — Est. 1987' }),
      ),
    );
    assert.equal(result.requiredWording, 'Camp "Wildwood" — Est. 1987');
  });

  it("never allows additional text beyond the required wording (Goal 7)", () => {
    const result = translation.translate(createInitialGenerationIntent(content()));
    assert.equal(result.allowAdditionalText, false);
  });

  it("no inspiration references when the description carries no reference cue", () => {
    const result = translation.translate(createInitialGenerationIntent(content()));
    assert.deepEqual(result.inspirationReferences, []);
  });

  it("splits a pop-culture reference out of the description into inspirationReferences, never into subject (Goal 4)", () => {
    const result = translation.translate(
      createInitialGenerationIntent(
        content({
          designDescription:
            "its a retro design spin off from the old tv show my 3 sons, but i want it bowling themed",
        }),
      ),
    );
    assert.match(result.subject, /retro design/i);
    assert.match(result.subject, /bowling themed/i);
    assert.doesNotMatch(result.subject, /tv show/i);
    assert.equal(result.inspirationReferences.length, 1);
    assert.match(result.inspirationReferences[0]!, /tv show my 3 sons/i);
  });

  it("splits a style reference into inspirationReferences too", () => {
    const result = translation.translate(
      createInitialGenerationIntent(
        content({ designStyle: "inspired by mid-century travel posters" }),
      ),
    );
    assert.doesNotMatch(result.style ?? "", /travel posters/i);
    assert.equal(result.inspirationReferences.length, 1);
  });
});

describe("PromptTranslationCapability — RegenerationPlan via GenerationIntent", () => {
  const translation = createPromptTranslationCapability();

  it("merges plan priorityChanges into notes in priority order without provider dialect", () => {
    const result = translation.translate(
      createRegenerationGenerationIntent(
        content(),
        plan({
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
      ),
    );

    assert.equal(result.exclusions, "No cartoon animals");
    assert.equal(result.requiredWording, "Camp Wildwood 2026");
    assert.match(result.notes ?? "", /Keep it simple/);
    assert.match(result.notes ?? "", /required wording/);
    assert.match(result.notes ?? "", /design style/);
    assert.match(result.notes ?? "", /graphics/);
    assert.equal((result.notes ?? "").includes("No cartoon animals"), false);
    assert.doesNotMatch(
      JSON.stringify(result),
      /masterpiece|8k|openai|photorealistic/i,
    );
  });

  it("applies remove actions by clearing the corresponding request fields", () => {
    const result = translation.translate(
      createRegenerationGenerationIntent(
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
        }),
      ),
    );
    assert.equal(result.requiredWording, null);
    assert.equal(result.style, null);
  });

  it("is deterministic and idempotent for the same intent", () => {
    const intent = createRegenerationGenerationIntent(
      content(),
      plan({
        priorityChanges: [
          {
            section: "style",
            description: "Strengthen the design style so it clearly matches the brief.",
            source: "evaluation",
            reason: "failed",
          },
        ],
      }),
    );
    assert.deepEqual(
      translation.translate(intent),
      translation.translate(intent),
    );
  });

  it("does not mutate the approved brief on the intent", () => {
    const brief = content({ exclusions: "No skulls" });
    const before = JSON.stringify(brief);
    translation.translate(
      createRegenerationGenerationIntent(
        brief,
        plan({
          remove: [
            {
              section: "style",
              description: "removed",
              source: "customer_revision",
              reason: "x",
            },
          ],
        }),
      ),
    );
    assert.equal(JSON.stringify(brief), before);
  });
});

describe("GenerationIntent construction", () => {
  it("createInitialGenerationIntent is immutable with a null regenerationPlan", () => {
    const intent = createInitialGenerationIntent(content());
    assert.equal(intent.regenerationPlan, null);
    assert.equal(Object.isFrozen(intent), true);
  });

  it("createRegenerationGenerationIntent is immutable with the supplied plan", () => {
    const regenerationPlan = plan({ generationAttempt: 3 });
    const intent = createRegenerationGenerationIntent(content(), regenerationPlan);
    assert.equal(intent.regenerationPlan?.generationAttempt, 3);
    assert.equal(Object.isFrozen(intent), true);
  });
});
