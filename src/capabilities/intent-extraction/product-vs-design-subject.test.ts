import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIntentExtractionCapability } from "./intent-extraction-capability";
import { reconcileUnderstanding } from "./reconcile-understanding";
import { productNameForQuestion } from "@/capabilities/shared/print-product-vocabulary";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import type { TShirtDesignBrief } from "@/lib/domain/types";

/**
 * Live acceptance: "create a design of a red 1988 toyota mr2" recorded
 * Product = "Design" and Preferred Colors = Red, then asked "What color
 * Designs will these print on?".
 *
 * Three concepts were collapsing into two fields. The print PRODUCT is the
 * physical item printed on; the DESIGN SUBJECT is what the artwork depicts;
 * a SUBJECT ATTRIBUTE (the car being red) is part of that subject, not a
 * palette preference and not the garment's color. This file pins all three
 * apart, on the deterministic layer plus the semantic layer's validation —
 * no provider call, no network, no cost.
 */
describe("Product vs design subject semantics", () => {
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
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      ...overrides,
    };
  }

  const capability = createIntentExtractionCapability();

  function fieldsFrom(reply: string) {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply,
      pendingSection: null,
    });
    return result.proposals[0]?.fields ?? {};
  }

  function noPalettePreference(fields: { preferredColors?: string[] }) {
    assert.deepEqual(
      fields.preferredColors ?? [],
      [],
      `a color describing the subject must never be recorded as a palette preference, got ${JSON.stringify(fields.preferredColors)}`,
    );
  }

  it("A. a design request that names no product leaves the product unresolved and keeps the subject's color on the subject", () => {
    const fields = fieldsFrom("create a design of a red 1988 toyota mr2");

    assert.equal(fields.productSummary, undefined);
    assert.match(String(fields.designDescription), /red 1988 toyota mr2/i);
    assert.equal(fields.shirtColor, undefined);
    noPalettePreference(fields);
  });

  it("B. naming the garment resolves the product without inventing a garment color or a palette", () => {
    const fields = fieldsFrom(
      "let's create a t-shirt design of a red 1988 Toyota MR2",
    );

    assert.equal(fields.productSummary, "T-shirt");
    assert.equal(fields.shirtColor, undefined);
    assert.match(String(fields.designDescription), /red 1988 Toyota MR2/i);
    noPalettePreference(fields);
  });

  it("C. a garment color and a subject color in one message keep their own roles", () => {
    const fields = fieldsFrom("black t-shirt with a red 1988 Toyota MR2");

    assert.match(String(fields.productSummary), /t-shirt/i);
    assert.equal(fields.shirtColor, "Black");
    assert.match(String(fields.designDescription), /red 1988 Toyota MR2/i);
    noPalettePreference(fields);
  });

  it("D. the same holds for any subject — a black Labrador is not a palette", () => {
    const fields = fieldsFrom("black Labrador on a gray hoodie");

    assert.match(String(fields.productSummary), /hoodie/i);
    assert.equal(fields.shirtColor, "Gray");
    assert.match(String(fields.designDescription), /black Labrador/i);
    noPalettePreference(fields);
  });

  it("E. three colors, three roles — subject, artwork palette, and garment", () => {
    const fields = fieldsFrom("red roses with gold lettering on a navy shirt");

    assert.equal(fields.shirtColor, "Navy");
    // "gold lettering" IS a statement about how the artwork is rendered.
    assert.deepEqual(fields.preferredColors, ["Gold"]);
    // ...while the roses' red stays with the roses.
    assert.match(String(fields.designDescription), /red roses/i);
    assert.doesNotMatch(String(fields.designDescription), /navy shirt/i);
  });

  it("F. design-artifact words never identify a product, whatever the subject", () => {
    for (const message of [
      "make a graphic of our building",
      "make a design of my dog",
      "create artwork of our building",
      "design something with our logo",
    ]) {
      assert.equal(
        fieldsFrom(message).productSummary,
        undefined,
        `"${message}" must leave the print product unresolved`,
      );
    }
  });

  it("G. a real product is still recognized when a design-artifact word sits next to it", () => {
    // The deterministic layer's product vocabulary is garment-only, so a
    // banner reaches the brief through the semantic layer — which must
    // strip "artwork" and keep "banner".
    const reconciled = reconcileUnderstanding(
      understanding({ section: "product", value: "Banner", evidence: "a banner" }),
      { brief: brief() },
    );
    assert.equal(reconciled.fields.productSummary, "Banner");

    const withArtifactWord = reconcileUnderstanding(
      understanding({
        section: "product",
        value: "T-shirt design",
        evidence: "a t-shirt design",
      }),
      { brief: brief() },
    );
    assert.equal(withArtifactWord.fields.productSummary, "T-shirt");
  });

  it("G2. the semantic layer can no longer ground a design-artifact word as the product", () => {
    // The exact live failure: "Design" is literally contained in its own
    // evidence, so the hallucination guard passed it through.
    for (const value of ["Design", "Artwork", "A graphic", "Logo concept", "Custom design"]) {
      const reconciled = reconcileUnderstanding(
        understanding({
          section: "product",
          value,
          evidence: `create a ${value.toLowerCase()}`,
        }),
        { brief: brief() },
      );
      assert.equal(
        reconciled.fields.productSummary,
        undefined,
        `"${value}" must never be stored as the print product`,
      );
    }
  });

  it("H. a customer-facing question never inflects a design-artifact word into a product", () => {
    assert.equal(productNameForQuestion("Design"), null);
    assert.equal(productNameForQuestion("Artwork"), null);
    assert.equal(productNameForQuestion(null), null);
    // A sentence-shaped value is refused too — questions are only ever
    // built from something short enough to read as a product name.
    assert.equal(
      productNameForQuestion("shirts for the whole bowling league this fall"),
      null,
    );

    assert.equal(productNameForQuestion("T-shirt"), "T-shirt");
    assert.equal(productNameForQuestion("tshirts"), "T-shirt");
    assert.equal(productNameForQuestion("hoodie"), "Hoodie");
    assert.equal(productNameForQuestion("banner"), "Banner");
  });

  it("I. an explicit palette preference is still recorded as one", () => {
    // The subject-attribute rule must not silence a customer who really is
    // talking about the artwork's colors.
    assert.deepEqual(fieldsFrom("use red and gold in the design").preferredColors, [
      "Red",
      "Gold",
    ]);
    assert.deepEqual(
      fieldsFrom("make the design mostly blue").preferredColors,
      ["Blue"],
    );
  });

  function understanding(update: {
    section: string;
    value: string;
    evidence: string;
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
      answeredPendingSection: null,
    };
  }
});
