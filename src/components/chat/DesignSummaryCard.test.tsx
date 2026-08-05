import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { DesignSummaryCard } from "./DesignSummaryCard";

describe("DesignSummaryCard", () => {
  it("renders only known fields and all three decision actions", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: {
          product: "Camp t-shirts",
          requiredWording: "Camp Wildwood 2026",
        },
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
        onContinue: () => {},
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
    assert.match(html, /Continue/);
  });

  it("disables all actions while busy", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: { product: "Camp t-shirts" },
        busy: true,
        onApprove: () => {},
        onEdit: () => {},
        onContinue: () => {},
      }),
    );

    const disabledCount = html.split("disabled=\"\"").length - 1;
    assert.equal(disabledCount, 3);
  });

  it("omits the summary detail list entirely when nothing is known yet", () => {
    const html = renderToString(
      createElement(DesignSummaryCard, {
        summary: {},
        busy: false,
        onApprove: () => {},
        onEdit: () => {},
        onContinue: () => {},
      }),
    );

    assert.doesNotMatch(html, /<dl/);
  });
});
