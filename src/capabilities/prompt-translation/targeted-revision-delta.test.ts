import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

import {
  createInitialGenerationIntent,
  createRegenerationGenerationIntent,
} from "./generation-intent";
import { createPromptTranslationCapability } from "./prompt-translation-capability";

/**
 * True Source-Image Targeted Revision (Section 5 — delta plumbing).
 *
 * The bug being fixed: `RegenerationPlan` knew only which brief SECTIONS
 * changed, its canned descriptions were flattened into `notes`, and the
 * provider ignored `notes` entirely — so the revision delta died at the
 * provider boundary. These prove the delta now survives, as discrete
 * changes, all the way to `GenerationPromptRequest.revision`.
 */

function brief(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "a crewneck t-shirt",
    designDescription: "a vintage sports car badge",
    exactText: "1988 TOYOTA MR2",
    shirtColor: "Black",
    printPlacement: "full_front",
    preferredColors: ["Red"],
    designStyle: "retro badge",
    additionalInstructions: null,
    audience: "car enthusiasts",
    purpose: "club merch",
    exclusions: null,
    deferredSections: [],
    ...overrides,
  } as DesignBriefSnapshotContent;
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

const translate = createPromptTranslationCapability().translate;

function targetedRevision(
  instruction: string | null,
  planOverrides: Partial<RegenerationPlan> = {},
  briefOverrides: Partial<DesignBriefSnapshotContent> = {},
) {
  return translate(
    createRegenerationGenerationIntent(
      brief(briefOverrides),
      plan(planOverrides),
      "minimal_badge",
      instruction,
    ),
  );
}

describe("PromptTranslation — targeted revision delta", () => {
  it("carries two requested changes through as TWO changes", () => {
    const result = targetedRevision(
      "change the font to retro and remove the sunset",
    );

    assert.ok(result.revision);
    assert.deepEqual(result.revision!.requestedChanges, [
      "change the font to retro",
      "remove the sunset",
    ]);
  });

  it("carries a single targeted change as a targeted change, not a new design description", () => {
    const result = targetedRevision("make the car larger");

    assert.deepEqual(result.revision!.requestedChanges, ["make the car larger"]);
    // Crucially it is NOT a restatement of the whole design.
    assert.doesNotMatch(
      result.revision!.requestedChanges.join(" "),
      /vintage sports car badge/,
    );
  });

  it("carries the live-acceptance border/shield delta", () => {
    const result = targetedRevision(
      "make the border red and change it to a shield",
    );

    assert.deepEqual(result.revision!.requestedChanges, [
      "make the border red",
      "change it to a shield",
    ]);
  });

  it("falls back to the RegenerationPlan's section-level changes when there is no literal instruction", () => {
    const result = targetedRevision(null, {
      customerRequestedChanges: [
        {
          section: "colors",
          description: "Make sure the design colors reflect the customer's requested change.",
          source: "customer_revision",
          reason: "r",
        },
      ],
    });

    assert.deepEqual(result.revision!.requestedChanges, [
      "Make sure the design colors reflect the customer's requested change.",
    ]);
  });

  it("carries preservation and avoidance requirements from the plan", () => {
    const result = targetedRevision("make the border red", {
      preserve: [
        {
          section: "requiredWording",
          description: "the required wording already reflects the customer's request — keep as-is.",
          source: "evaluation",
          reason: "r",
        },
      ],
      avoid: [
        { section: "exclusions", description: "no flames", source: "brief", reason: "r" },
      ],
    });

    assert.deepEqual(result.revision!.preserve, [
      "the required wording already reflects the customer's request — keep as-is.",
    ]);
    assert.ok(result.revision!.avoid.includes("no flames"));
  });
});

describe("PromptTranslation — required wording protection", () => {
  it("locks the exact wording when the customer asked for something unrelated", () => {
    const result = targetedRevision("make the car larger");

    assert.equal(result.revision!.wordingChangeRequested, false);
    assert.equal(result.revision!.lockedWording, "1988 TOYOTA MR2");
  });

  it("a typography change is NOT a wording change — the wording stays locked", () => {
    const result = targetedRevision("change the font to something more retro");

    assert.equal(result.revision!.wordingChangeRequested, false);
    assert.equal(result.revision!.lockedWording, "1988 TOYOTA MR2");
  });

  it("lifts the lock when the customer explicitly asks to change the wording", () => {
    const result = targetedRevision(
      'change the text to "MR2 TURBO"',
      {},
      { exactText: "MR2 TURBO" },
    );

    assert.equal(result.revision!.wordingChangeRequested, true);
    assert.equal(result.revision!.lockedWording, null);
    assert.equal(result.requiredWording, "MR2 TURBO");
  });

  it("recognizes a wording change stated by quoting the current wording", () => {
    const result = targetedRevision(
      'change "1988 TOYOTA MR2" to "MR2 TURBO"',
      {},
      { exactText: "MR2 TURBO" },
    );

    assert.equal(result.revision!.wordingChangeRequested, true);
  });

  it("recognizes a wording change the RegenerationPlan structured for us", () => {
    const result = targetedRevision(null, {
      remove: [
        {
          section: "requiredWording",
          description: "Customer removed the required wording.",
          source: "customer_revision",
          reason: "r",
        },
      ],
    });

    assert.equal(result.revision!.wordingChangeRequested, true);
    assert.equal(result.revision!.lockedWording, null);
  });
});

/**
 * Live Acceptance Cleanup — Issue 1, at the delta/prompt boundary.
 *
 * The live failure, exactly: "make the 3 SONS text the same color as the
 * ball, everything else stays the same" changed BOTH "3 SONS" and "MY".
 * Two defects fed it, and both are pinned here:
 *   1. the bare noun "text" was read as a request to change the WORDING, so
 *      the exact-wording lock was dropped and the provider was told it was
 *      changing what the design says — a licence to re-render every word;
 *   2. "everything else stays the same" was swallowed into the change
 *      description instead of strengthening the preservation contract.
 *
 * Generic by construction: the same shapes are asserted for unrelated
 * subjects, and nothing about bowling appears anywhere.
 */
describe("PromptTranslation — targeted styling of a text element", () => {
  const bowling = {
    exactText: "MY 3 SONS",
    designDescription: "bowling pins and a ball",
  };

  it("1: 'make the 3 SONS text the same color as the ball' is a STYLING change, not a wording change", () => {
    const result = targetedRevision(
      "make the 3 SONS text the same color as the ball, everything else stays the same",
      {},
      bowling,
    );

    // The heart of the live bug: naming a text element while asking for a
    // color must never lift the exact-wording lock.
    assert.equal(result.revision!.wordingChangeRequested, false);
    assert.equal(result.revision!.lockedWording, "MY 3 SONS");
  });

  it("1b: the delta targets only 3 SONS, and 'everything else' becomes a preservation constraint", () => {
    const result = targetedRevision(
      "make the 3 SONS text the same color as the ball, everything else stays the same",
      {},
      bowling,
    );

    assert.deepEqual(result.revision!.requestedChanges, [
      "make the 3 SONS text the same color as the ball",
    ]);
    assert.equal(result.revision!.preserveEverythingElse, true);
    // "MY" is never part of what was asked to change.
    assert.doesNotMatch(result.revision!.requestedChanges.join(" "), /\bMY\b/);
  });

  it("2: 'make the wheels chrome; leave everything else the same' is a targeted change only", () => {
    const result = targetedRevision(
      "make the wheels chrome; leave everything else the same",
    );

    assert.deepEqual(result.revision!.requestedChanges, [
      "make the wheels chrome",
    ]);
    assert.equal(result.revision!.preserveEverythingElse, true);
    assert.equal(result.revision!.wordingChangeRequested, false);
    assert.equal(result.revision!.lockedWording, "1988 TOYOTA MR2");
  });

  it("generalizes: naming words while asking for appearance never unlocks the wording", () => {
    for (const instruction of [
      "make only the word SALE red",
      "change the top line to blue",
      "make the number 25 gold",
      "make the title bigger",
      "make the lettering white like the pins",
    ]) {
      const result = targetedRevision(instruction);
      assert.equal(
        result.revision!.wordingChangeRequested,
        false,
        `"${instruction}" is styling, not re-wording`,
      );
      assert.equal(result.revision!.lockedWording, "1988 TOYOTA MR2", instruction);
    }
  });

  it("still lifts the lock when the customer genuinely wants different words", () => {
    for (const instruction of [
      'change the text to "MR2 TURBO"',
      "make it say MR2 TURBO",
      "fix the spelling of the text",
    ]) {
      const result = targetedRevision(instruction, {}, { exactText: "MR2 TURBO" });
      assert.equal(
        result.revision!.wordingChangeRequested,
        true,
        `"${instruction}" really is a wording change`,
      );
      assert.equal(result.revision!.lockedWording, null, instruction);
    }
  });

  it("a revision with no blanket clause still gets the default preservation contract", () => {
    const result = targetedRevision("make the border red");
    assert.equal(result.revision!.preserveEverythingElse, false);
    // The default ("preserve everything not requested") is unconditional and
    // lives in the adapter — see openai-concept-provider-edit.test.ts.
    assert.deepEqual(result.revision!.requestedChanges, ["make the border red"]);
  });
});

describe("PromptTranslation — only a targeted revision is an edit", () => {
  it("initial generation carries no revision directive", () => {
    const result = translate(createInitialGenerationIntent(brief()));

    assert.equal(result.revision, null);
    assert.equal(result.targetConceptDirectionKey, null);
  });

  it("a three-direction 'show me alternatives' regeneration carries no revision directive", () => {
    const result = translate(
      createRegenerationGenerationIntent(
        brief(),
        plan({
          customerRequestedChanges: [
            { section: "colors", description: "x", source: "customer_revision", reason: "r" },
          ],
        }),
        // No target direction — this is an exploration, not an edit.
        null,
        "make the border red",
      ),
    );

    assert.equal(result.revision, null);
  });
});
