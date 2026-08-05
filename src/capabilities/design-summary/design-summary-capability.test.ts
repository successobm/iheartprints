import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDesignSummaryCapability } from "./design-summary-capability";
import { createBriefEvaluationCapability } from "@/capabilities/brief-evaluation";
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

describe("DesignSummaryCapability", () => {
  const capability = createDesignSummaryCapability();
  const briefEvaluation = createBriefEvaluationCapability();

  function summaryFor(theBrief: TShirtDesignBrief) {
    return capability.createSummary(theBrief, briefEvaluation.evaluate(theBrief));
  }

  it("includes only fields actually resolved on the working brief", () => {
    const summary = summaryFor(
      brief({
        productSummary: "Camp shirts",
        designDescription: "A friendly bear logo",
        shirtColor: "Navy",
        exactText: "Camp Wildwood 2026",
      }),
    );

    assert.equal(summary.product, "Camp shirts");
    assert.equal(summary.graphics, "A friendly bear logo");
    assert.equal(summary.productColor, "Navy");
    assert.equal(summary.requiredWording, "Camp Wildwood 2026");
    assert.equal(summary.audience, undefined);
    assert.equal(summary.purpose, undefined);
    assert.equal(summary.printLocation, undefined);
    assert.equal(summary.references, undefined);
    assert.equal(summary.productionConsiderations, undefined);
  });

  it("renders 'None' for explicit empty wording and omits blank optional fields", () => {
    const summary = summaryFor(
      brief({
        productSummary: "Camp shirts",
        exactText: "",
        designStyle: "   ",
        preferredColors: [],
      }),
    );

    assert.equal(summary.requiredWording, "None");
    assert.equal(summary.style, undefined);
    assert.equal(summary.colors, undefined);

    const formatted = capability.formatForCustomer(summary);
    assert.match(formatted, /Product: Camp shirts/);
    assert.match(formatted, /Required Wording: None/);
    assert.doesNotMatch(formatted, /Style:/);
    assert.doesNotMatch(formatted, /Audience:/);
  });

  it("renders audience, purpose, and print location once actually resolved", () => {
    const summary = summaryFor(
      brief({
        audience: "Camp families",
        purpose: "Summer fundraiser",
        printPlacement: "left_chest",
      }),
    );

    assert.equal(summary.audience, "Camp families");
    assert.equal(summary.purpose, "Summer fundraiser");
    assert.equal(summary.printLocation, "left chest");
  });

  it("renders friendly copy for deferred sections instead of blank/raw content", () => {
    const summary = summaryFor(
      brief({ deferredSections: ["style", "colors", "printLocation"] }),
    );

    assert.match(String(summary.style), /designer|choose/i);
    assert.match(String(summary.colors), /choose/i);
    assert.match(String(summary.printLocation), /choose|placement/i);

    const formatted = capability.formatForCustomer(summary);
    assert.doesNotMatch(formatted, /\bdeferred_to_designer\b/);
  });

  it("does not render a deferred section as blank — content or friendly copy, never neither", () => {
    const summary = summaryFor(brief({ deferredSections: ["colors"] }));
    assert.ok(summary.colors && summary.colors.trim().length > 0);
  });

  it("never displays raw internal resolution codes or confidence numbers", () => {
    const summary = summaryFor(
      brief({
        productSummary: "Camp shirts",
        designStyle: "make it cool",
        deferredSections: ["printLocation"],
      }),
    );
    const formatted = capability.formatForCustomer(summary);
    assert.doesNotMatch(formatted, /\d+%/);
    assert.doesNotMatch(formatted, /unknown|ambiguous|confidence/i);
  });
});
