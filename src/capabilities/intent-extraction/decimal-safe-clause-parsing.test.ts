import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  clauseBodySource,
  clauseBoundarySource,
  splitOnClauseBoundaries,
} from "@/lib/domain/clause-boundaries";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import { createInitialGenerationIntent } from "@/capabilities/prompt-translation";
import { checkProductQuality } from "@/capabilities/shared/brief-field-quality";
import { isExplicitRevisionIntent } from "@/capabilities/shared/revision-intent";
import { CREATE_NEW_WORKFLOW } from "@/lib/domain/conversation";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type {
  DesignBriefSnapshotContent,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createIntentExtractionCapability } from "./intent-extraction-capability";
import { preserveDesignDetail } from "./preserve-design-detail";
import { mergeDesignDescription } from "./design-description-merge";

/**
 * Post-A4 correction — a decimal point is not a sentence boundary.
 *
 * THE LIVE DEFECT
 *
 * The customer wrote:
 *
 *   black 2010 jeep wrangler unlimited with full racks and an inspired
 *   overland roof top tent, large wheels with a 2.5" lift at the beach with
 *   the sun setting
 *
 * and the Design Brief recorded:
 *
 *   black 2010 jeep wrangler unlimited with full racks and an inspired
 *   overland roof top tent, large wheels with a 2
 *
 * `extractGraphics` bounds its capture at a sentence boundary — the right
 * rule, protecting the design description from an unrelated leading clause —
 * but its boundary set was the raw character class `[.!?]`, so the period
 * inside `2.5` counted as punctuation. The lift, the beach and the sunset
 * were silently gone before any concept was generated.
 *
 * The fix is `lib/domain/clause-boundaries.ts` and is deliberately LEXICAL:
 * a period is content when, and only when, it sits between two digits. No
 * measurement noun, unit, or product name participates, so `2.5" lift`,
 * `Version 2.5` and `a 1.25 ratio` are all preserved by the same rule that
 * still splits `Model 3.5. No text.` into two sentences.
 */
describe("Post-A4 correction — decimal-safe clause parsing", () => {
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
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      ...overrides,
    };
  }

  const capability = createIntentExtractionCapability();

  function fieldsFrom(
    reply: string,
    pendingSection: BriefSectionKey | null = null,
    existing: Partial<TShirtDesignBrief> = {},
  ) {
    const result = capability.extract({
      brief: brief(existing),
      phase: "interviewing",
      reply,
      pendingSection,
    });
    return result.proposals[0]?.fields ?? {};
  }

  function describedBy(reply: string): string {
    return String(fieldsFrom(reply).designDescription ?? "");
  }

  /** The exact message from the live conversation. */
  const JEEP_MESSAGE =
    'black 2010 jeep wrangler unlimited with full racks and an inspired overland roof top tent, large wheels with a 2.5" lift at the beach with the sun setting';

  /* ================================================================== */
  /* A: the live input, end to end                                       */
  /* ================================================================== */

  it("A: the live Jeep message survives whole, through 'sun setting'", () => {
    const description = describedBy(JEEP_MESSAGE);

    // The exact old truncation point — this is the assertion that fails on
    // the pre-correction code.
    assert.doesNotMatch(description, /large wheels with a 2$/);
    assert.match(description, /2\.5" lift/);
    assert.match(description, /at the beach/);
    assert.match(description, /sun setting/);
    // Everything before the decimal is still there too — the fix restored
    // the tail without dropping the head.
    assert.match(description, /black 2010 jeep wrangler unlimited/i);
    assert.match(description, /full racks/i);
    assert.match(description, /roof top tent/i);
  });

  /* ================================================================== */
  /* B–E: measurements                                                   */
  /* ================================================================== */

  it('B: 2.5" lift', () => {
    assert.match(describedBy('a design with a 2.5" lift'), /2\.5" lift/);
  });

  it("C: 1.5 inch border", () => {
    assert.match(describedBy("a design with a 1.5 inch border"), /1\.5 inch border/);
  });

  it('D: 0.25" stroke', () => {
    assert.match(describedBy('a design with a 0.25" stroke'), /0\.25" stroke/);
  });

  it('E: 12.75" wide graphic', () => {
    assert.match(
      describedBy('a design with a 12.75" wide graphic'),
      /12\.75" wide graphic/,
    );
  });

  it("every common way of writing the same measurement survives", () => {
    // Goal 3 / Goal 12: the rule is about the DIGITS around the period, so it
    // can never depend on which unit spelling or which quote character
    // follows. The customer's numeric value is preserved verbatim — nothing
    // here normalizes 2.5 into anything else.
    for (const form of [
      '2.5" lift',
      "2.5-inch lift",
      "2.5 in lift",
      "2.5” lift", // right double quotation mark
      "2.5″ lift", // double prime
      "2.5 inch lift",
    ]) {
      const description = describedBy(`a jeep with a ${form}`);
      assert.match(description, /2\.5/, `lost the decimal in "${form}"`);
      assert.ok(description.includes(form), `lost the phrasing of "${form}"`);
    }
  });

  /* ================================================================== */
  /* F: several decimals in one message                                  */
  /* ================================================================== */

  it("F: every decimal in a multi-measurement message survives", () => {
    const description = describedBy(
      "a truck with a 2.5-inch lift, 17.5-inch wheels, and a 1.25-inch rack spacer",
    );
    assert.match(description, /2\.5-inch lift/);
    assert.match(description, /17\.5-inch wheels/);
    assert.match(description, /1\.25-inch rack spacer/);
  });

  /* ================================================================== */
  /* Goal 4: decimals that are not measurements at all                   */
  /* ================================================================== */

  it("a decimal outside any measurement context survives — the rule is lexical", () => {
    assert.match(describedBy("a design with Version 2.5 styling"), /Version 2\.5/);
    assert.match(describedBy("a design with Model 3.5"), /Model 3\.5/);
    assert.match(describedBy("a design with a 1.25 ratio"), /1\.25 ratio/);
    assert.match(describedBy("a design with a dial at 198.5 degrees"), /198\.5 degrees/);
  });

  /* ================================================================== */
  /* G–I: real periods must still split                                  */
  /* ================================================================== */

  it("G: a real period is still a sentence boundary", () => {
    // The cue-anchored capture stops at the first real sentence end, exactly
    // as it did before — the correction widened nothing.
    const description = describedBy("a design of a Jeep at the beach. Add a sunset.");
    assert.match(description, /Jeep at the beach/);
    assert.doesNotMatch(description, /Add a sunset/);

    assert.deepEqual(
      splitOnClauseBoundaries("Large wheels. Rooftop tent open.", ".!?")
        .map((part) => part.trim())
        .filter(Boolean),
      ["Large wheels", "Rooftop tent open"],
    );
  });

  it("H: 'Version 2.5. Make it black.' keeps the decimal AND the boundary", () => {
    const description = describedBy("a design with Version 2.5 styling. Make it black.");
    assert.match(description, /Version 2\.5/);
    assert.doesNotMatch(description, /Make it black/);

    assert.deepEqual(
      splitOnClauseBoundaries("Design version 2.5. Make it black.", ".!?")
        .map((part) => part.trim())
        .filter(Boolean),
      ["Design version 2.5", "Make it black"],
    );
  });

  it("I: 'Model 3.5. No text.' keeps the decimal AND reaches required-wording logic", () => {
    const fields = fieldsFrom("a design with Model 3.5. No text.");
    assert.match(String(fields.designDescription), /Model 3\.5/);
    // Explicit no-text is its own first-class value ("" — see
    // `lib/domain/required-wording.ts`), and the trailing sentence still
    // reaches it.
    assert.equal(fields.exactText, "");
  });

  it("a measurement sentence and a following instruction stay two sentences", () => {
    // Both survive here, and that is the correct outcome: the period after
    // "lift" is honored as a boundary (so "Sunset background" is a SECOND
    // sentence, restored by the design-detail backstop as its own clause),
    // while the decimal inside the first is not.
    const description = describedBy("a design with a 2.5-inch lift. Sunset background.");
    assert.match(description, /2\.5-inch lift\.\s+Sunset background/);
  });

  /* ================================================================== */
  /* Goal 7: years, model numbers, identifiers                           */
  /* ================================================================== */

  it("years, model numbers and identifiers are unaffected or improved", () => {
    // A year and a hyphenated model number never contained a period, so they
    // were never at risk — pinned so a future boundary change cannot quietly
    // start splitting them.
    assert.match(describedBy("a design of a 2010 Jeep Wrangler"), /2010 Jeep Wrangler/);
    assert.match(describedBy("a design of an F-150"), /F-150/);
    // These three did contain one, and were truncated by the same rule.
    assert.match(describedBy("a design of a 911.2 badge"), /911\.2/);
    assert.match(describedBy("a design of an MK2.5 emblem"), /MK2\.5/);
    assert.match(describedBy("a design with Version 2.0 lettering"), /Version 2\.0/);
  });

  /* ================================================================== */
  /* Goal 8: Correction B still holds                                    */
  /* ================================================================== */

  it("J: Correction B — the Jeep's black is still the subject's, not the palette", () => {
    const fields = fieldsFrom(JEEP_MESSAGE);
    assert.deepEqual(fields.preferredColors ?? [], []);
    assert.match(String(fields.designDescription), /black 2010 jeep wrangler/i);
    assert.equal(fields.shirtColor, undefined);
  });

  it("J: a later 'black shirt' resolves the garment with no palette to clash with", async () => {
    const first = fieldsFrom(JEEP_MESSAGE);
    const second = fieldsFrom(
      "black shirt",
      "productColor",
      { designDescription: String(first.designDescription) },
    );
    assert.equal(second.shirtColor, "Black");
    assert.deepEqual(second.preferredColors ?? [], []);

    const { createBriefEvaluationCapability } = await import(
      "@/capabilities/brief-evaluation"
    );
    const evaluation = createBriefEvaluationCapability().evaluate(
      brief({
        productSummary: "T-shirt",
        designDescription: String(first.designDescription),
        shirtColor: "Black",
        preferredColors: [],
        exactText: "",
        printPlacement: "full_front",
      }),
    );
    assert.equal(
      JSON.stringify(evaluation).includes("color_clash"),
      false,
      "a color clash was raised against a palette the customer never expressed",
    );
  });

  it("an explicit palette request is still recorded, decimals or not", () => {
    const palette = (reply: string) =>
      (fieldsFrom(reply).preferredColors ?? []).map((c) => c.toLowerCase());
    assert.deepEqual(palette("make the whole design black and gold").sort(), [
      "black",
      "gold",
    ]);
    assert.deepEqual(palette("make the design red, white, and blue"), [
      "red",
      "white",
      "blue",
    ]);
    // And a decimal in the same sentence no longer shears the color list into
    // fragments before the classifier ever sees it.
    assert.deepEqual(
      palette('make the whole design black and gold with a 2.5" border').sort(),
      ["black", "gold"],
    );
  });

  /* ================================================================== */
  /* Goal 14: the other consumers of the same rule                       */
  /* ================================================================== */

  it("required wording keeps a decimal instead of truncating at it", () => {
    assert.equal(fieldsFrom("our team is called Route 66.5 Crew").exactText, "Route 66.5 Crew");
    assert.equal(fieldsFrom('it should say "Pit Crew 2.5"').exactText, "Pit Crew 2.5");
    // A real sentence boundary still closes the capture.
    assert.equal(
      fieldsFrom("our team is called Route 66.5 Crew. Put it on the front.").exactText,
      "Route 66.5 Crew",
    );
  });

  it("product extraction reads the product clause past a decimal", () => {
    // This test asserts the DECIMAL invariant only. Which of the clause's
    // words end up in Product is `extractProduct`'s own long-standing
    // question, deliberately untouched by this correction — what matters
    // here is that a decimal no longer manufactures a clause boundary that
    // was never in the customer's sentence.

    // Multi-clause: the product clause is found on the correct side of the
    // one REAL comma, and the decimal does not invent a third clause.
    assert.match(
      String(fieldsFrom("black t-shirts, with a 2.5 inch logo").productSummary),
      /^black t-shirts?$/i,
    );

    // Single clause: whatever Product ends up holding, the decimal survives
    // in it and nothing is cut off at the "2".
    const single = String(fieldsFrom("a 2.5 inch logo on black t-shirts").productSummary);
    assert.match(single, /2\.5/);
    assert.doesNotMatch(single, /\ba 2$/);
    assert.match(single, /t-shirts?$/i);

    // A genuine short product name is still kept exactly as the customer
    // wrote it, qualifier and all.
    assert.equal(fieldsFrom("Camp shirts").productSummary, "Camp Shirts");
  });

  it("a real garment specification is never silently reduced to its bare noun", () => {
    // Guards the boundary this correction must NOT cross. A word-count gate
    // in `extractProduct` (briefly added while fixing the decimal defect)
    // shortened each of these to "Polo"/"T-shirt"/"Sweatshirt", discarding
    // customer content that `checkProductQuality` — the one authority on
    // whether a Product value is too long — accepts as a perfectly good
    // product name. `full zip hooded sweatshirt` reduced to `Sweatshirt` is
    // not a shorter name for the same garment; it is a different garment.
    for (const spec of [
      "youth small navy performance polo shirt",
      "premium ring spun combed cotton t-shirt",
      "authentic Nike Dri-FIT performance polo shirt",
      "unisex heavy blend full zip hooded sweatshirt",
    ]) {
      const stored = String(fieldsFrom(spec, "product").productSummary ?? "");
      assert.equal(stored.toLowerCase(), spec.toLowerCase(), `Product was reduced: "${spec}"`);
      assert.equal(
        checkProductQuality(stored),
        null,
        `the existing quality authority rejected a legitimate spec: "${spec}"`,
      );
    }
  });

  it("checkProductQuality remains the sole authority on an over-long Product", () => {
    // The punctuation-free run-on opener is still stored verbatim and still
    // caught by the quality gate — not by a second, duplicated length rule
    // inside `extractProduct`. Pinned so that boundary cannot drift back.
    const opener =
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";
    const stored = String(fieldsFrom(opener, "product").productSummary ?? "");
    assert.equal(checkProductQuality(stored)?.code, "product_too_long");
  });

  it("the design-detail backstop keeps a positioned measurement in one clause", () => {
    // `preserveDesignDetail` splits the customer message into clauses to find
    // what a lossy synthesis dropped; a decimal used to shred one clause into
    // two, and the fragment "5 inches from the left" restored on its own says
    // nothing.
    const restored = preserveDesignDetail(
      "A lighthouse.",
      "A lighthouse 2.5 inches from the left edge",
    );
    assert.match(restored, /2\.5 inches from the left/);
  });

  it("the multi-turn merge treats one measured statement as one statement", () => {
    const merged = mergeDesignDescription(
      "A jeep on the left.",
      'A jeep with a 2.5" lift on the left.',
      'make it a jeep with a 2.5" lift on the left',
    );
    assert.match(merged, /2\.5" lift/);
  });

  it("a question containing a measurement is still recognized as a question", () => {
    // Same rule, different consumer: an entirely-question message must not be
    // read as a standing instruction, which enqueues a paid regeneration.
    assert.equal(isExplicitRevisionIntent("Should the lift be 2.5 inches?"), false);
    assert.equal(isExplicitRevisionIntent("Make the lift 2.5 inches."), true);
  });

  /* ================================================================== */
  /* K: the whole detail reaches the generation prompt                   */
  /* ================================================================== */

  it("K: the generation request still carries every Jeep detail", () => {
    const description = describedBy(JEEP_MESSAGE);
    const content: DesignBriefSnapshotContent = {
      productSummary: "T-shirt",
      designDescription: description,
      exactText: "",
      shirtColor: "Black",
      printPlacement: "full_front",
      preferredColors: [],
      designStyle: null,
      additionalInstructions: null,
      audience: null,
      purpose: null,
      exclusions: null,
      deferredSections: [],
    };

    const request = createPromptTranslationCapability().translate(
      createInitialGenerationIntent(content),
    );
    const prompt = JSON.stringify(request);

    for (const detail of [
      /2010 jeep wrangler unlimited/i,
      /full racks/i,
      /roof top tent/i,
      /2\.5\\" lift/i,
      /beach/i,
      /sun setting/i,
    ]) {
      assert.match(prompt, detail, `the generation request lost ${detail}`);
    }
  });

  /* ================================================================== */
  /* The shared helper itself                                            */
  /* ================================================================== */

  describe("clause-boundaries", () => {
    it("a period is content only when it sits between two digits", () => {
      const boundary = new RegExp(clauseBoundarySource(".!?"), "g");
      assert.equal("2.5".match(boundary), null);
      assert.equal("v2.5.1".match(boundary), null);
      assert.deepEqual("3.5. No".match(boundary), ["."]);
      assert.deepEqual("beach. Add".match(boundary), ["."]);
      assert.deepEqual("Wait! Now? Yes.".match(boundary), ["!", "?", "."]);
    });

    it("a clause body runs through a decimal and stops at real punctuation", () => {
      const body = new RegExp(`${clauseBodySource(".!?")}+`);
      assert.equal('a 2.5" lift. Then'.match(body)?.[0], 'a 2.5" lift');
      assert.equal("plain text. Next".match(body)?.[0], "plain text");
    });

    it("splitting collapses runs and leaves decimals alone", () => {
      assert.deepEqual(
        splitOnClauseBoundaries("2.5in lift; 1.25in spacer. Done", ".;")
          .map((part) => part.trim())
          .filter(Boolean),
        ["2.5in lift", "1.25in spacer", "Done"],
      );
    });

    it("marks needing escapes inside a character class stay literal", () => {
      const boundary = new RegExp(clauseBoundarySource(".-]^"), "g");
      assert.deepEqual("a-b]c^d.e 1.5".match(boundary), ["-", "]", "^", "."]);
    });
  });
});

/* ==================================================================== */
/* Goal 9: the structured Create New path, end to end                    */
/* ==================================================================== */

describe("Post-A4 correction — Create New captures a decimal design description", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-decimal-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import("@/capabilities/composition");
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }
    const service = await import("@/lib/services/conversation-service");
    return { repo, service };
  }

  it("the workflow still opens with the product question and no customer turn", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const opened = await context.service.beginCreateNewWorkflow(started.project.id);

    assert.deepEqual(
      opened.messages.filter((message) => message.role === "user"),
      [],
    );
    const question = opened.messages.at(-1)!;
    assert.equal(question.role, "assistant");
    assert.equal(question.metadata.workflow, CREATE_NEW_WORKFLOW);
    assert.equal(question.metadata.section, "product");
  });

  it("a decimal-carrying design answer is stored whole, and notes stay empty", async () => {
    const context = await freshGraph();
    const started = await context.service.startConversation();
    const projectId = started.project.id;
    await context.service.beginCreateNewWorkflow(projectId);

    await context.service.handleUserMessage(projectId, "T-shirts");
    const after = await context.service.handleUserMessage(
      projectId,
      'a design of a black 2010 jeep wrangler unlimited with full racks and an inspired overland roof top tent, large wheels with a 2.5" lift at the beach with the sun setting',
    );

    const description = String(after.brief.designDescription ?? "");
    assert.match(description, /2\.5" lift/);
    assert.match(description, /sun setting/);
    assert.doesNotMatch(description, /large wheels with a 2$/);
    // The customer supplied no notes, so none were invented.
    assert.equal(after.brief.additionalInstructions, null);
  });
});
