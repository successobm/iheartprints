import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { DesignSummaryCard } from "./DesignSummaryCard";

describe("DesignSummaryCard", () => {
  it("renders only known fields and both decision actions", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: {
          product: "Camp t-shirts",
          requiredWording: "Camp Wildwood 2026",
        },
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );

    assert.match(html, /Product/);
    assert.match(html, /Camp t-shirts/);
    assert.match(html, /Required Wording/);
    assert.match(html, /Camp Wildwood 2026/);

    // Fields never collected by the current scripted interview must not appear.
    assert.doesNotMatch(html, /Audience/);
    assert.doesNotMatch(html, /Purpose/);
    assert.doesNotMatch(html, /Print Location/);
    assert.doesNotMatch(html, /References/);

    assert.match(html, /Approve and Create Concepts/);
    assert.match(html, /Edit/);
    // Sprint 2L Phase 1B (Goal 12): "Continue" removed as redundant with Edit.
    assert.doesNotMatch(html, /Continue/);
  });

  it("disables all actions while busy", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { product: "Camp t-shirts" },
        busy: true,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );

    const disabledCount = html.split("disabled=\"\"").length - 1;
    // Sprint 2L Phase 1B (Goal 12): two actions now — Approve, Edit.
    assert.equal(disabledCount, 2);
  });

  it("omits the summary detail list entirely when nothing is known yet", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: {},
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );

    assert.doesNotMatch(html, /<dl/);
  });

  it("Sprint 2G Part 3: marks an updated field with a visible, non-color-only badge", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { product: "Camp t-shirts", productColor: "Navy" },
        updatedSections: ["productColor"],
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );
    assert.match(html, /Updated/); // the badge itself has visible text, not just color
    assert.match(html, /aria-label="Product Color was just updated"/);
  });

  it("shows an old → new transition for an updated field with a prior value", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { productColor: "Navy" },
        updatedSections: ["productColor"],
        fieldTransitions: { productColor: { from: "Black", to: "Navy" } },
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );
    assert.match(html, /Black/);
    assert.match(html, /Navy/);
  });

  it("does not badge a field that wasn't updated", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { product: "Camp t-shirts", productColor: "Navy" },
        updatedSections: ["productColor"],
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );
    assert.doesNotMatch(html, /aria-label="Product was just updated"/);
  });

  it("renders deferred decisions as a distinct 'Designer will determine' list, not as blank/missing fields", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { product: "Camp t-shirts" },
        deferredDecisions: [
          { section: "colors", label: "Best artwork colors" },
          { section: "printLocation", label: "Final print placement" },
        ],
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );
    assert.match(html, /Designer will determine/);
    assert.match(html, /Best artwork colors/);
    assert.match(html, /Final print placement/);
    assert.doesNotMatch(html, /missing|unknown|n\/a/i);
  });

  it("omits the deferred decisions section entirely when nothing was deferred", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { product: "Camp t-shirts" },
        deferredDecisions: [],
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
      }),
    );
    assert.doesNotMatch(html, /Designer will determine/);
  });
});
