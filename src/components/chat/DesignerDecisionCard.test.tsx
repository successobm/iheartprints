import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { DesignerDecisionCard } from "./DesignerDecisionCard";

describe("DesignerDecisionCard", () => {
  it("renders the designer decision message under a clear heading", () => {
    const html = renderToString(
      createElement(DesignerDecisionCard, {
        message: "We'll choose the placement that works best for this design.",
      }),
    );
    assert.match(html, /Designer Decision/);
    assert.match(html, /choose the placement that works best/);
  });

  it("never phrases the decision as missing or unresolved", () => {
    const html = renderToString(
      createElement(DesignerDecisionCard, {
        message: "We'll choose colors that work well with the shirt.",
      }),
    );
    assert.doesNotMatch(html, /missing|unknown|not provided|n\/a/i);
  });
});
