import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { ConceptStatusBanner } from "./ConceptStatusBanner";
import type { ConceptStatusView } from "@/capabilities/shared/contracts";

function status(overrides: Partial<ConceptStatusView> = {}): ConceptStatusView {
  return {
    status: "needs_update",
    message: "Your recent changes affect these concepts.",
    currentConcepts: [],
    previousBatches: [],
    ...overrides,
  };
}

describe("ConceptStatusBanner", () => {
  it("renders the persistent regeneration action when status is needs_update", () => {
    const html = renderToString(
      createElement(ConceptStatusBanner, {
        status: status(),
        busy: false,
        onRegenerate: () => {},
        onKeepCurrent: () => {},
      }),
    );
    assert.match(html, /Your recent changes affect these concepts/);
    assert.match(html, /Generate Updated Concepts/);
    assert.match(html, /Keep Current Concepts/);
  });

  it("renders nothing when concepts are current", () => {
    const html = renderToString(
      createElement(ConceptStatusBanner, {
        status: status({ status: "current", message: "These concepts reflect your latest approved design." }),
        busy: false,
        onRegenerate: () => {},
        onKeepCurrent: () => {},
      }),
    );
    assert.equal(html, "");
  });

  it("renders nothing when there are no concepts yet", () => {
    const html = renderToString(
      createElement(ConceptStatusBanner, {
        status: status({ status: "none", message: "No concepts have been generated yet." }),
        busy: false,
        onRegenerate: () => {},
        onKeepCurrent: () => {},
      }),
    );
    assert.equal(html, "");
  });

  it("never uses internal terminology like 'stale' or 'version mismatch'", () => {
    const html = renderToString(
      createElement(ConceptStatusBanner, {
        status: status(),
        busy: false,
        onRegenerate: () => {},
        onKeepCurrent: () => {},
      }),
    );
    assert.doesNotMatch(html, /stale|invalidated|version mismatch/i);
  });

  it("disables both actions while busy but keeps them visible and labeled", () => {
    const html = renderToString(
      createElement(ConceptStatusBanner, {
        status: status(),
        busy: true,
        onRegenerate: () => {},
        onKeepCurrent: () => {},
      }),
    );
    const disabledCount = html.split('disabled=""').length - 1;
    assert.equal(disabledCount, 2);
    assert.match(html, /Generate Updated Concepts/);
  });
});
