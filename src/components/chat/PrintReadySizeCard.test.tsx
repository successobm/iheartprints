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
 * and must not be matched against as if they were), then DECODES entities.
 *
 * Decoding matters as soon as copy contains an apostrophe: React escapes
 * "Women's" to "Women&#x27;s", and a test asserting against the escaped form
 * would be checking React's encoder rather than what the customer reads —
 * and would silently stop matching if the encoder ever changed.
 */
function textOf(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x27|#39|apos);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&(#x2F|#47);/g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

/**
 * Print'em All Phase 1: an UNCONFIRMED project — a resolvable width and
 * nobody who ever approved it. This is the state every historical project is
 * in, and the state a customer arrives at the size card in.
 */
function standardFullFront() {
  return describePrintReadySize({
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
    ...SQUARE_CONCEPT,
  })!;
}

/** The same project after a human has confirmed the recommended box. */
function confirmedFullFront() {
  return describePrintReadySize({
    printPlacement: "full_front",
    intendedPrintWidthIn: 10.5,
    productionSizeConfirmedAt: "2026-08-21T00:00:00.000Z",
    productionSizeConfirmedWidthIn: 10.5,
    productionSizeConfirmedMaxHeightIn: 10.5,
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

    assert.match(html, /Print size/);
    assert.match(html, /10\.5&quot; × 10\.5&quot;/);
    // React SSR interleaves comment markers between interpolated segments,
    // so the rendered text is asserted after stripping them.
    assert.match(textOf(html), /300 DPI/);
    assert.match(html, /Full Front/);
    assert.match(html, /standard adult full front print size/i);
    assert.match(html, /Adjust size/);
  });

  it("Goal 9: states the recommendation, what the artwork does inside it, and who it is for", () => {
    const html = renderToString(
      createElement(PrintReadySizeCard, {
        size: standardFullFront(),
        busy: false,
        onChooseWidth: () => {},
        onUseRecommendedSize: () => {},
      }),
    );
    const text = textOf(html);

    // Three separate facts, said separately. Collapsing them is what let a
    // paid job run at a size nobody picked.
    assert.match(text, /Recommended for: Standard Adult · Full Front/);
    assert.match(text, /Recommended area: 10\.5" × 10\.5"/);
    assert.match(text, /Your artwork will print at:/);
    assert.match(html, /Use recommended size/);
  });

  it("Goal 6: an unconfirmed size says so, and a confirmed one says so instead", () => {
    const pending = textOf(
      renderToString(
        createElement(PrintReadySizeCard, {
          size: standardFullFront(),
          busy: false,
          onChooseWidth: () => {},
          onUseRecommendedSize: () => {},
        }),
      ),
    );
    assert.match(pending, /Confirm the print size before preparation\./);
    assert.doesNotMatch(pending, /Print size confirmed/);

    const confirmed = textOf(
      renderToString(
        createElement(PrintReadySizeCard, {
          size: confirmedFullFront(),
          busy: false,
          onChooseWidth: () => {},
          onUseRecommendedSize: () => {},
        }),
      ),
    );
    assert.match(confirmed, /Print size confirmed/);
    assert.doesNotMatch(confirmed, /Confirm the print size before preparation/);
    // Already confirmed at the recommendation, so re-offering it would read
    // as an unfinished step.
    assert.doesNotMatch(confirmed, /Use recommended size/);
  });

  it("Goal 4/5/6: each garment class shows its own recommended area", () => {
    const expected = [
      { garmentSizeClass: "youth", label: "Youth", area: "8.5" },
      {
        garmentSizeClass: "womens_small",
        label: "Women's / Smaller Garment",
        area: "9",
      },
      { garmentSizeClass: "adult_standard", label: "Standard Adult", area: "10.5" },
      {
        garmentSizeClass: "adult_plus",
        label: "2XL–4XL / Larger Garment",
        area: "12",
      },
    ] as const;

    for (const row of expected) {
      const text = textOf(
        renderToString(
          createElement(PrintReadySizeCard, {
            size: describePrintReadySize({
              printPlacement: "full_front",
              intendedPrintWidthIn: null,
              garmentSizeClass: row.garmentSizeClass,
              ...SQUARE_CONCEPT,
            })!,
            busy: false,
            onChooseWidth: () => {},
            onUseRecommendedSize: () => {},
          }),
        ),
      );
      assert.match(
        text,
        new RegExp(`Recommended for: ${row.label.replace(/[/]/g, "[/]")} · Full Front`),
        row.garmentSizeClass,
      );
      assert.match(
        text,
        new RegExp(`Recommended area: ${row.area}" × ${row.area}"`),
        row.garmentSizeClass,
      );
    }
  });

  it("Goal 7: a custom-size garment asks for a width instead of inventing one", () => {
    const custom = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      garmentSizeClass: "custom",
      ...SQUARE_CONCEPT,
    })!;
    assert.equal(custom.recommendation, null);
    assert.equal(custom.requiresExplicitWidth, true);

    const text = textOf(
      renderToString(
        createElement(PrintReadySizeCard, {
          size: custom,
          busy: false,
          onChooseWidth: () => {},
          onUseRecommendedSize: () => {},
        }),
      ),
    );
    assert.match(text, /Enter the print width you want\./);
    assert.doesNotMatch(text, /Recommended area/);
    assert.doesNotMatch(text, /Use recommended size/);
    // The width entry is offered without waiting for "Adjust size" — it is
    // the only route forward for this garment.
    assert.match(text, /Use this width/);
  });

  it("Goal 2: the garment picker offers plain labels, never the enum, and selects nothing by default", () => {
    const unstated = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      garmentSizeClass: null,
      ...SQUARE_CONCEPT,
    })!;

    const html = renderToString(
      createElement(PrintReadySizeCard, {
        size: unstated,
        busy: false,
        onChooseWidth: () => {},
        onUseRecommendedSize: () => {},
        onChooseGarmentSize: () => {},
      }),
    );
    const text = textOf(html);

    for (const label of [
      "Youth",
      "Women's / Smaller Garment",
      "Standard Adult",
      "2XL–4XL / Larger Garment",
      "Custom Size",
    ]) {
      assert.match(text, new RegExp(label.replace(/[/]/g, "[/]")), label);
    }
    assert.doesNotMatch(text, /adult_standard|womens_small|adult_plus/);

    // K: an ASSUMED class is not a chosen one. The recommendation is computed
    // as standard adult, but no chip is pressed and nothing is confirmed —
    // highlighting one would turn an assumption into an apparent decision.
    assert.doesNotMatch(html, /aria-pressed="true"/);
    assert.equal(unstated.confirmed, false);

    const chosen = renderToString(
      createElement(PrintReadySizeCard, {
        size: describePrintReadySize({
          printPlacement: "full_front",
          intendedPrintWidthIn: null,
          garmentSizeClass: "adult_plus",
          ...SQUARE_CONCEPT,
        })!,
        busy: false,
        onChooseWidth: () => {},
        onUseRecommendedSize: () => {},
        onChooseGarmentSize: () => {},
      }),
    );
    assert.match(chosen, /aria-pressed="true"/);
  });

  it("the picker is absent entirely when no handler is wired, rather than inert", () => {
    const html = renderToString(
      createElement(PrintReadySizeCard, {
        size: standardFullFront(),
        busy: false,
        onChooseWidth: () => {},
      }),
    );
    assert.doesNotMatch(html, /Printing on/);
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
    // Print'em All Phase 1: 10.5 legitimately appears now — as the standard
    // adult RECOMMENDATION the customer chose away from, which is exactly
    // the distinction this pass exists to make visible. What must never
    // appear is 10.5 as the size their artwork will print at.
    assert.doesNotMatch(html, /print at: <!-- -->10\.5/);
    assert.match(textOf(html), /Recommended area: 10\.5/);
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
        printReadySize: confirmedFullFront(),
        onChoosePrintWidth: () => {},
      }),
    );

    assert.match(html, /Print size/);
    assert.match(html, /10\.5&quot;/);
    assert.match(html, /Prepare Print-Ready Artwork/);
    assert.match(html, /Adjust size/);
  });

  it("Goal 6: the prepare action is unavailable until the size is confirmed", () => {
    const unconfirmed = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: true,
        busy: false,
        onPrepare: () => {},
        printReadySize: standardFullFront(),
        onChoosePrintWidth: () => {},
        onUseRecommendedSize: () => {},
      }),
    );
    // The action is still SHOWN — hiding it would leave the customer without
    // any sense of what happens next — but it cannot be pressed, and the card
    // directly above says why.
    assert.match(unconfirmed, /Prepare Print-Ready Artwork/);
    assert.match(unconfirmed, /disabled=""/);
    assert.match(textOf(unconfirmed), /Confirm the print size before preparation/);

    const confirmed = renderToString(
      createElement(PrepareForPrintAction, {
        finalizationStatus: "not_requested",
        canRequest: true,
        busy: false,
        onPrepare: () => {},
        printReadySize: confirmedFullFront(),
        onChoosePrintWidth: () => {},
        onUseRecommendedSize: () => {},
      }),
    );
    assert.doesNotMatch(confirmed, /disabled=""/);
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
