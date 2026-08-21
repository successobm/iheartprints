import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type { TShirtDesignBrief } from "@/lib/domain/types";

import { createIntentExtractionCapability } from "./intent-extraction-capability";
import { reconcileUnderstanding } from "./reconcile-understanding";

/**
 * A4 Funnel Correction B — an object's color is not the design's palette.
 *
 * THE LIVE DEFECT
 *
 * The customer opened with "black 2010 jeep wrangler unlimited with full
 * racks and a inspired overland roof top tent". The clause carries no
 * garment word and no design word, so it fell to `extractColors`'
 * "undecided" branch — which pushed every color straight into
 * `artworkColors`, bypassing `colorStatesAPalettePreference` entirely. The
 * brief recorded Preferred Colors = Black, the assistant replied "I have
 * Black in the artwork", and when the customer later said the SHIRT was
 * black, Brief Evaluation raised a blocking color clash and asked them to
 * change a design palette they had never asked for.
 *
 * The Jeep's color is an attribute of the SUBJECT. `extractGraphics`
 * already keeps it in the design description, which is where the
 * generation prompt reads it from — so declining to invent a palette loses
 * nothing.
 *
 * The end-to-end consequences (no clash question, no acknowledgment, the
 * prompt still drawing a black Jeep) are pinned in
 * `capabilities/conversation/subject-color-regression.test.ts`.
 */
describe("A4 Correction B — subject color vs. design palette", () => {
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

  function fieldsFrom(reply: string, pendingSection: BriefSectionKey | null = null) {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply,
      pendingSection,
    });
    return result.proposals[0]?.fields ?? {};
  }

  function palette(reply: string, pendingSection: BriefSectionKey | null = null) {
    return (fieldsFrom(reply, pendingSection).preferredColors ?? []).map((c) =>
      c.toLowerCase(),
    );
  }

  /* ================================================================== */
  /* A–E: a color describing the subject is never a palette preference   */
  /* ================================================================== */

  it("A: the live message — 'black 2010 jeep wrangler…' records no palette preference", () => {
    const fields = fieldsFrom(
      "black 2010 jeep wrangler unlimited with full racks and a inspired overland roof top tent",
    );
    assert.deepEqual(fields.preferredColors ?? [], []);
    // J: and the Jeep's color is still captured, where it belongs.
    assert.match(String(fields.designDescription), /black 2010 jeep wrangler/i);
    assert.match(String(fields.designDescription), /roof top tent/i);
  });

  it("B: 'blue motorcycle with sunset behind it' records no palette preference", () => {
    const fields = fieldsFrom("blue motorcycle with sunset behind it");
    assert.deepEqual(fields.preferredColors ?? [], []);
    assert.match(String(fields.designDescription), /blue motorcycle/i);
  });

  it("C: two subject colors — 'black dog wearing a red bandana' — records neither", () => {
    assert.deepEqual(palette("black dog wearing a red bandana"), []);
  });

  it("D: 'red 1967 Mustang on a white shirt' — garment white, palette empty", () => {
    const fields = fieldsFrom("red 1967 Mustang on a white shirt");
    assert.equal(fields.shirtColor, "White");
    assert.deepEqual(fields.preferredColors ?? [], []);
    assert.match(String(fields.designDescription), /red 1967 Mustang/i);
  });

  it("E: 'white Jeep on a black T-shirt' — garment black, palette empty", () => {
    const fields = fieldsFrom("white Jeep on a black T-shirt");
    assert.equal(fields.shirtColor, "Black");
    assert.deepEqual(fields.preferredColors ?? [], []);
    assert.match(String(fields.designDescription), /white Jeep/i);
  });

  /* ================================================================== */
  /* F–G: an explicit palette request still works, and now completely    */
  /* ================================================================== */

  it("F: 'make the whole design black and gold' captures BOTH colors", () => {
    // The secondary defect: the one-word window in
    // `DESIGN_ELEMENT_BEFORE_COLOR` reached "black" and stopped, so the
    // same sentence's "gold" was silently dropped.
    assert.deepEqual(palette("make the whole design black and gold").sort(), [
      "black",
      "gold",
    ]);
    assert.deepEqual(palette("make the design black and gold").sort(), [
      "black",
      "gold",
    ]);
  });

  it("G: 'black and silver color scheme' captures both", () => {
    assert.deepEqual(palette("black and silver color scheme").sort(), [
      "black",
      "silver",
    ]);
  });

  it("a comma-separated palette list survives clause splitting", () => {
    assert.deepEqual(palette("make the design red, white, and blue"), [
      "red",
      "white",
      "blue",
    ]);
    // A bare color list set off by commas has no noun to modify, so it is
    // the customer naming colors rather than describing a subject.
    assert.deepEqual(
      palette(
        "Vintage bowling team called My 3 Sons, gold and white, bowling ball smashing pins",
      ).sort(),
      ["gold", "white"],
    );
  });

  it("every other explicit palette phrasing still works", () => {
    assert.deepEqual(palette("use red and white for the artwork").sort(), [
      "red",
      "white",
    ]);
    assert.deepEqual(palette("use red and gold in the design").sort(), ["gold", "red"]);
    assert.deepEqual(palette("make the design mostly blue"), ["blue"]);
    assert.deepEqual(palette("make the artwork solid black"), ["black"]);
    // A whole-design referent names the design as surely as "the design" does.
    assert.deepEqual(palette("make everything blue"), ["blue"]);
    assert.deepEqual(palette("red roses with gold lettering on a navy shirt"), ["gold"]);
  });

  it("the pending question is still an authority in its own right", () => {
    // "What colors?" answered with a bare list — no design word anywhere,
    // and it does not need one.
    assert.deepEqual(palette("forest green and cream", "colors"), [
      "forest green",
      "cream",
    ]);
    // "What color shirt?" answers the garment, not the palette.
    const fields = fieldsFrom("black", "productColor");
    assert.equal(fields.shirtColor, "Black");
    assert.deepEqual(fields.preferredColors ?? [], []);
  });

  it("H: an explicit all-black artwork request is still a palette preference", () => {
    // Goal 7: the bug is false palette INFERENCE, not the clash detector.
    // A customer who really does ask for black artwork must still be able
    // to, so Brief Evaluation still has something to raise against a black
    // shirt.
    assert.deepEqual(palette("make the artwork solid black"), ["black"]);
    assert.deepEqual(palette("make the whole design black"), ["black"]);
  });

  /* ================================================================== */
  /* Goal 8: the semantic layer is held to the same rule                 */
  /* ================================================================== */

  function understanding(update: {
    section: string;
    value: string;
    evidence: string;
    answeredPendingSection?: string | null;
  }): ConversationUnderstandingResult {
    return {
      proposedUpdates: [
        {
          section: update.section as never,
          value: update.value,
          confidence: "explicit",
          evidence: update.evidence,
          isCorrection: false,
        },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: (update.answeredPendingSection ?? null) as never,
    };
  }

  const JEEP = "black 2010 jeep wrangler unlimited with full racks";

  it("Goal 8: a semantic 'colors' proposal read off bare subject wording is rejected", () => {
    // Understanding's fields WIN the merge in `extract`, so without this
    // guard the deterministic fix could be undone one layer later.
    const reconciled = reconcileUnderstanding(
      understanding({ section: "colors", value: "Black", evidence: JEEP }),
      { brief: brief(), message: JEEP },
    );
    assert.equal(reconciled.fields.preferredColors, undefined);
  });

  it("Goal 8: the same message end to end — deterministic + semantic — still records no palette", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: JEEP,
      pendingSection: null,
      understanding: understanding({
        section: "colors",
        value: "Black",
        evidence: JEEP,
      }),
    });
    const fields = result.proposals[0]?.fields ?? {};
    assert.deepEqual(fields.preferredColors ?? [], []);
  });

  it("Goal 8: a semantic proposal WITH palette evidence is still accepted", () => {
    const message = "make the design black and gold";
    const reconciled = reconcileUnderstanding(
      understanding({
        section: "colors",
        value: "Black and Gold",
        evidence: "the design black and gold",
      }),
      { brief: brief(), message },
    );
    assert.deepEqual(reconciled.fields.preferredColors, ["Black", "Gold"]);
  });

  it("Goal 8: answering the colors question is accepted however terse the evidence", () => {
    const reconciled = reconcileUnderstanding(
      understanding({
        section: "colors",
        value: "Black",
        evidence: "black",
        answeredPendingSection: "colors",
      }),
      { brief: brief(), message: "black" },
    );
    assert.deepEqual(reconciled.fields.preferredColors, ["Black"]);
  });

  it("Goal 8: one palette-grounded color carries its own list", () => {
    // "gold lettering" is real palette intent; the guard refuses only the
    // case where NO proposed color reads as one anywhere.
    const message = "a black jeep with gold lettering above it";
    const reconciled = reconcileUnderstanding(
      understanding({
        section: "colors",
        value: "Gold",
        evidence: "gold lettering",
      }),
      { brief: brief(), message },
    );
    assert.deepEqual(reconciled.fields.preferredColors, ["Gold"]);
  });
});
