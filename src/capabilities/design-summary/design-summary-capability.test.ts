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
    // Sprint 2K Phase 3 (Goal 3): product/color/print location collapse
    // into one compact header line instead of a "Label: value" row.
    assert.match(formatted, /Camp shirts/);
    assert.match(formatted, /Required wording:\nNone/);
    assert.doesNotMatch(formatted, /Style:/);
    assert.doesNotMatch(formatted, /Audience:/);
  });

  it("quotes required wording so it reads unmistakably as literal print text (Goal 3)", () => {
    const summary = summaryFor(
      brief({
        productSummary: "T-shirt",
        exactText: "My 3 Sons",
      }),
    );
    const formatted = capability.formatForCustomer(summary);
    assert.match(formatted, /Required wording:\n"My 3 Sons"/);
  });

  it("groups product, product color, and print location into one header line (Goal 3)", () => {
    const summary = summaryFor(
      brief({
        productSummary: "T-shirt",
        shirtColor: "Black",
        printPlacement: "full_back",
      }),
    );
    const formatted = capability.formatForCustomer(summary);
    assert.match(formatted, /T-shirt · Black · Full back/);
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
    // Sprint 2K Phase 3 (Goal 2): capitalized for customer-facing display.
    assert.equal(summary.printLocation, "Left chest");
  });

  it("Sprint 2G Part 3: deferred sections are excluded from the regular field list entirely", () => {
    const theBrief = brief({ deferredSections: ["style", "colors", "printLocation"] });
    const summary = summaryFor(theBrief);

    assert.equal(summary.style, undefined);
    assert.equal(summary.colors, undefined);
    assert.equal(summary.printLocation, undefined);
  });

  it("lists deferred sections as completed designer decisions, not missing information", () => {
    const theBrief = brief({ deferredSections: ["style", "colors", "printLocation"] });
    const evaluation = briefEvaluation.evaluate(theBrief);
    const deferred = capability.listDeferredDecisions(evaluation);

    assert.equal(deferred.length, 3);
    const labels = deferred.map((d) => d.label);
    assert.ok(labels.some((l) => /style/i.test(l)));
    assert.ok(labels.some((l) => /colors/i.test(l)));
    assert.ok(labels.some((l) => /placement/i.test(l)));
    for (const label of labels) {
      assert.doesNotMatch(label, /missing|unknown|n\/a/i);
    }
  });

  it("does not list a section that was never deferred nor provided", () => {
    const theBrief = brief(); // nothing set, nothing deferred
    const evaluation = briefEvaluation.evaluate(theBrief);
    assert.deepEqual(capability.listDeferredDecisions(evaluation), []);
  });

  it("formatForCustomer renders a 'Designer will determine' section from deferred decisions", () => {
    const theBrief = brief({
      productSummary: "Camp shirts",
      deferredSections: ["colors", "printLocation"],
    });
    const summary = summaryFor(theBrief);
    const evaluation = briefEvaluation.evaluate(theBrief);
    const deferred = capability.listDeferredDecisions(evaluation);

    const formatted = capability.formatForCustomer(summary, deferred);
    assert.match(formatted, /Designer will determine/i);
    assert.match(formatted, /Best artwork colors/i);
    assert.match(formatted, /Final print placement/i);
    assert.doesNotMatch(formatted, /\bdeferred_to_designer\b/);
  });

  it("formatForCustomer omits the deferred section entirely when nothing was deferred", () => {
    const summary = summaryFor(brief({ productSummary: "Camp shirts" }));
    const formatted = capability.formatForCustomer(summary, []);
    assert.doesNotMatch(formatted, /designer will determine/i);
  });

  it("never displays raw internal resolution codes or confidence numbers", () => {
    const theBrief = brief({
      productSummary: "Camp shirts",
      designStyle: "make it cool",
      deferredSections: ["printLocation"],
    });
    const summary = summaryFor(theBrief);
    const evaluation = briefEvaluation.evaluate(theBrief);
    const deferred = capability.listDeferredDecisions(evaluation);
    const formatted = capability.formatForCustomer(summary, deferred);
    assert.doesNotMatch(formatted, /\d+%/);
    assert.doesNotMatch(formatted, /unknown|ambiguous|confidence|deferred_to_designer/i);
  });
});
