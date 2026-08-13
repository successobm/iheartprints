import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { describePrintReadySize } from "@/capabilities/shared/print-ready-size";

import { PrepareForPrintAction } from "./PrepareForPrintAction";
import { formatSizeLine, PrintReadySizeCard } from "./PrintReadySizeCard";

/**
 * Live Acceptance Cleanup — Issue 5, at the surface the customer actually
 * sees. Every figure is computed server-side from the placement policy and
 * handed in; this component owns none of them.
 */

const SQUARE_CONCEPT = { artworkWidthPx: 1024, artworkHeightPx: 1024 };

/**
 * Visible text only — strips React's SSR comment markers, tag names, and
 * attributes (Tailwind class names like `px-3` are not customer-facing copy
 * and must not be matched against as if they were).
 */
function textOf(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

function standardFullFront() {
  return describePrintReadySize({
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
    ...SQUARE_CONCEPT,
  })!;
}

describe("PrintReadySizeCard", () => {
  it("14: states the standard full-front size, resolution, and placement before finalizing", () => {
    const html = renderToString(
      createElement(PrintReadySizeCard, {
        size: standardFullFront(),
        busy: false,
        onChooseWidth: () => {},
      }),
    );

    assert.match(html, /Print-ready size/);
    assert.match(html, /10\.5&quot; × 10\.5&quot;/);
    // React SSR interleaves comment markers between interpolated segments,
    // so the rendered text is asserted after stripping them.
    assert.match(textOf(html), /300 DPI/);
    assert.match(html, /Full Front/);
    assert.match(html, /standard adult full front print size/i);
    assert.match(html, /Change Size/);
  });

  it("21: shows the customer's CHOSEN width, never a stale default", () => {
    const chosen = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: 12,
      ...SQUARE_CONCEPT,
    })!;

    const html = renderToString(
      createElement(PrintReadySizeCard, {
        size: chosen,
        busy: false,
        onChooseWidth: () => {},
      }),
    );

    assert.match(html, /12&quot; × 12&quot;/);
    assert.doesNotMatch(html, /10\.5/);
  });

  it("states width only when the artwork's proportions aren't known yet", () => {
    const unknownAspect = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      artworkWidthPx: null,
      artworkHeightPx: null,
    })!;

    assert.equal(formatSizeLine(unknownAspect), '10.5" wide');
    // Never a fabricated height — that would be a promise about the plate.
    assert.doesNotMatch(formatSizeLine(unknownAspect), /×/);
  });

  it("never exposes production internals as customer-facing settings", () => {
    const html = renderToString(
      createElement(PrintReadySizeCard, {
        size: standardFullFront(),
        busy: false,
        onChooseWidth: () => {},
      }),
    );

    // DPI is stated as a fact, never offered as a knob; everything else
    // about production stays hidden (Constitution §6.4 / AGENTS.md Goal 8).
    const text = textOf(html);
    assert.doesNotMatch(text, /upscal|raster|vector|pHYs|Topaz|provider|PPI/i);
    assert.doesNotMatch(text, /resolution|pixels|\bpx\b/i);
    assert.doesNotMatch(text, /alpha|normaliz|plate|trim/i);
  });
});

describe("PrepareForPrintAction — size is shown before the commitment", () => {
  it("renders the size alongside the prepare action", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: true,
        busy: false,
        onPrepare: () => {},
        printReadySize: standardFullFront(),
        onChoosePrintWidth: () => {},
      }),
    );

    assert.match(html, /Print-ready size/);
    assert.match(html, /10\.5&quot;/);
    assert.match(html, /Prepare Print-Ready Artwork/);
    assert.match(html, /Change Size/);
  });

  it("stays exactly as it was when no size can be stated honestly", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: true,
        busy: false,
        onPrepare: () => {},
        printReadySize: null,
        onChoosePrintWidth: () => {},
      }),
    );

    assert.match(html, /Prepare Print-Ready Artwork/);
    assert.doesNotMatch(html, /Print-ready size/);
  });

  it("12/13: the waiting state carries the approximate expectation", () => {
    const html = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "preparing",
        canRequest: false,
        busy: false,
        onPrepare: () => {},
      }),
    );

    assert.match(html, /Preparing your print-ready artwork/);
    assert.match(html, /3–4 minutes/);
    assert.doesNotMatch(html, /is ready/i);
  });
});
