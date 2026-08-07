import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { PrepareForPrintAction } from "./PrepareForPrintAction";

describe("PrepareForPrintAction (Sprint 2M Phase 2B)", () => {
  it("renders nothing when there is nothing to prepare and no request has been made", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: false,
        busy: false,
        onPrepare: () => {},
      }),
    );
    assert.equal(html, "");
  });

  it("renders the explicit action when a current, selected concept can be approved", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: true,
        busy: false,
        onPrepare: () => {},
      }),
    );
    assert.match(html, /Prepare Print-Ready Artwork/);
  });

  it("renders a truthful 'preparing' state, never claiming print-ready", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "preparing",
        canRequest: false,
        busy: false,
        onPrepare: () => {},
      }),
    );
    assert.match(html, /Preparing your print-ready artwork/);
    assert.doesNotMatch(html, /is ready/i);
  });

  it("never uses internal/technical terminology", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: true,
        busy: false,
        onPrepare: () => {},
      }),
    );
    assert.doesNotMatch(
      html,
      /finalize raster|print validation|production asset|vectorize|upscale|300 ?dpi|final artwork job/i,
    );
  });
});
