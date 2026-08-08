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

  it("B: print_ready updates the UI to the ready state", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "print_ready",
        canRequest: false,
        busy: false,
        onPrepare: () => {},
      }),
    );
    assert.match(html, /Your print-ready artwork is ready/);
    assert.doesNotMatch(html, /Preparing your print-ready artwork/);
    assert.doesNotMatch(html, /Prepare Print-Ready Artwork/);
  });

  it("C: needs_review updates the UI and does not claim print-ready", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "needs_review",
        canRequest: false,
        busy: false,
        onPrepare: () => {},
      }),
    );
    assert.match(html, /We need to review your artwork before it can be finalized/);
    assert.doesNotMatch(html, /is ready/i);
    assert.doesNotMatch(html, /Preparing your print-ready artwork/);
  });

  it("G: never uses internal/technical terminology", () => {
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
      /finalize raster|print validation|production asset|vectorize|upscale|300 ?dpi|final artwork job|topaz|storageKey|provider/i,
    );
  });
});
