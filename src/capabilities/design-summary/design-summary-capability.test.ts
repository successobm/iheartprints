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
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("DesignSummaryCapability", () => {
  const capability = createDesignSummaryCapability();
  const briefEvaluation = createBriefEvaluationCapability();

  it("includes only fields actually gathered on the working brief", () => {
    const theBrief = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood 2026",
    });
    const summary = capability.createSummary(
      theBrief,
      briefEvaluation.evaluate(theBrief),
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
    const theBrief = brief({
      productSummary: "Camp shirts",
      exactText: "",
      designStyle: "   ",
      preferredColors: [],
    });
    const summary = capability.createSummary(
      theBrief,
      briefEvaluation.evaluate(theBrief),
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
});
