import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { ConceptCards } from "./ConceptCards";

/**
 * Live Acceptance UX Pass — the two preview bugs, both of which were
 * structural rather than behavioral:
 *
 *   1. Clicking the enlarge control also SELECTED the concept, because
 *      that control was a `<button>` nested inside the card's own
 *      `<button>`. Nested interactive content is invalid, and the card's
 *      click handler sat directly on the ancestor of the thing being
 *      clicked, so "preview is read-only" depended entirely on
 *      `stopPropagation` surviving hydration.
 *   2. Once ANY concept was selected the card was rendered `disabled`,
 *      and browsers do not dispatch clicks to descendants of a disabled
 *      control — so the enlarge control inside it went dead. That is why
 *      the revised concept, which is auto-selected the moment it exists,
 *      could never be opened full size.
 *
 * Both disappear if the enlarge control is simply never a descendant of
 * the card button, which is what these tests pin down. They assert
 * structure, not clicks (there is no DOM in this test runner) — but the
 * structure is the stronger guarantee: with no selecting ancestor and no
 * disabled ancestor, there is no path from enlarging to selecting at all.
 */

function concept(overrides: Partial<CustomerArtworkVersion> = {}): CustomerArtworkVersion {
  return {
    id: "artwork-1",
    versionNumber: 1,
    kind: "concept",
    title: "Minimal Badge",
    summary: "A tight badge lockup.",
    placeholderLabel: "Concept A",
    accentColor: "#173F35",
    isSelected: false,
    hasImage: true,
    ...overrides,
  } as CustomerArtworkVersion;
}

function render(props: {
  concepts: CustomerArtworkVersion[];
  selectedId?: string | null;
  selectable?: boolean;
  busy?: boolean;
}) {
  return renderToString(
    createElement(ConceptCards, {
      concepts: props.concepts,
      projectId: "project-1",
      selectedId: props.selectedId ?? null,
      selectable: props.selectable ?? true,
      busy: props.busy ?? false,
      onSelect: () => {
        throw new Error("onSelect must never fire from rendering");
      },
    }),
  );
}

/** Every `<button>` in the markup, paired with its own attributes. */
function buttons(html: string): { attrs: string; inner: string }[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (match) => ({ attrs: match[1]!, inner: match[2]! }),
  );
}

/** Deepest nesting of `<button>` elements — must never exceed 1. */
function maxButtonDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const token of html.matchAll(/<button\b|<\/button>/g)) {
    if (token[0] === "</button>") depth -= 1;
    else max = Math.max(max, (depth += 1));
  }
  return max;
}

const EXPAND = /aria-label="View [^"]*full size"/;

describe("ConceptCards — preview is never selection", () => {
  it("A: the enlarge control is not inside the card's selecting button", () => {
    const html = render({ concepts: [concept()] });

    assert.match(html, EXPAND, "the enlarge control renders");
    assert.equal(maxButtonDepth(html), 1, "no button is nested inside another");

    // Nothing that opens the preview may carry the card's select handler:
    // the enlarge control's own element has no onClick-bearing ancestor,
    // which is exactly what the depth assertion above guarantees.
    const expand = buttons(html).find((button) => EXPAND.test(button.attrs));
    assert.ok(expand, "the enlarge control is its own top-level button");
    assert.doesNotMatch(expand.inner, /<button/);
  });

  it("D/E/F: initial concepts, revisions, and historical versions all get the same control", () => {
    for (const kind of ["concept", "revision", "final"] as const) {
      const html = render({
        concepts: [concept({ kind, title: `${kind} artwork` })],
      });
      assert.match(html, EXPAND, `${kind} artwork must be viewable full size`);
      assert.equal(maxButtonDepth(html), 1);
    }
  });

  it("E: a selected concept — the state every revision lands in — can still be enlarged", () => {
    const html = render({
      concepts: [concept({ id: "artwork-revised", kind: "revision", isSelected: true })],
      selectedId: "artwork-revised",
    });

    const [card, expand] = buttons(html);
    assert.ok(card && expand);
    // The card itself is correctly non-selectable (it is already selected)...
    assert.match(card.attrs, /disabled/);
    // ...and the enlarge control is unaffected by that.
    assert.match(expand.attrs, EXPAND);
    assert.doesNotMatch(expand.attrs, /disabled/);
  });

  it("E: enlarging stays available even while a request is in flight", () => {
    const html = render({ concepts: [concept()], busy: true });
    const expand = buttons(html).find((button) => EXPAND.test(button.attrs));
    assert.ok(expand);
    assert.doesNotMatch(expand.attrs, /disabled/);
  });

  it("C/L: an unselected concept stays explicitly selectable, including after another was chosen", () => {
    const html = render({
      concepts: [concept({ id: "artwork-1" }), concept({ id: "artwork-2", title: "Bold" })],
      selectedId: "artwork-1",
    });

    const cards = buttons(html).filter((button) => !EXPAND.test(button.attrs));
    assert.equal(cards.length, 2);
    // The already-selected one is inert; the other remains a real choice —
    // re-selecting an earlier concept is a supported lifecycle action.
    assert.match(cards[0]!.attrs, /disabled/);
    assert.doesNotMatch(cards[1]!.attrs, /disabled/);
    assert.match(cards[0]!.inner, /Selected/);
  });

  it("B/M: rendering the grid mutates nothing and calls nothing", () => {
    // `onSelect` throws if invoked (see `render`), so reaching this line at
    // all proves no selection happened; there is no preview API to call.
    const html = render({ concepts: [concept()], selectable: false });
    assert.match(html, EXPAND, "viewing is available even when selecting is not");
  });
});
