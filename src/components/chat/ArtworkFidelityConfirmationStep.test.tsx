/**
 * Production Acceptance Defect fix: proves the fidelity confirmation step's
 * action controls and mark choices are REAL, correctly-classed elements —
 * not merely that the underlying completeness logic works (already covered
 * exhaustively server-side by `artwork-fidelity-confirmation.test.ts`).
 *
 * This repo's test tooling is `node:test` + `renderToString` (no DOM, no
 * effects, no simulated clicks — see `UploadedArtworkPanel.test.tsx`'s own
 * established precedent). `useEffect` never fires during a server render,
 * so `checking`/`view` reflect exactly the initial state the props produce
 * — no propose fetch is ever triggered by these tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkFidelityView } from "@/lib/services/conversation-service";

import { ArtworkFidelityConfirmationStep } from "./ArtworkFidelityConfirmationStep";

function view(overrides: Partial<ArtworkFidelityView> = {}): ArtworkFidelityView {
  return {
    contractId: "contract-1",
    status: "proposed",
    proposalStatus: "analyzed",
    wording: [],
    protectedMarks: [
      { id: "m0", visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" },
    ],
    confirmedWording: null,
    confirmedMarks: null,
    confirmedAt: null,
    ...overrides,
  };
}

function render(artworkFidelity: ArtworkFidelityView | null) {
  return renderToString(
    createElement(ArtworkFidelityConfirmationStep, {
      projectId: "project-1",
      artworkFidelity,
      onConfirmed: () => {},
      onSkip: () => {},
    }),
  );
}

/** Extracts one element's full opening tag by its data-testid, for attribute/class assertions. */
function findTag(html: string, testId: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  assert.ok(match, `expected an element with data-testid="${testId}" in:\n${html}`);
  return match![0];
}

describe("ArtworkFidelityConfirmationStep — action controls", () => {
  it("Confirm renders as a real <button>, styled as the app's primary action", () => {
    const html = render(view());
    const tag = findTag(html, "artwork-fidelity-confirm-button");
    assert.match(tag, /^<button\b/);
    // Same primary-button classes as SignContextSavedStep's "Check my
    // artwork" button in the same panel — not a bespoke design.
    assert.match(tag, /bg-ink/);
    assert.match(tag, /text-white/);
    assert.match(tag, /rounded-full/);
    assert.match(html, /Confirm Artwork Details/);
  });

  it("Skip for now renders as a real, actionable <button> (secondary/text style)", () => {
    const html = render(view());
    const tag = findTag(html, "artwork-fidelity-skip-button");
    assert.match(tag, /^<button\b/);
    // Same secondary/text-button classes as the QR step's "Print as
    // supplied" button in the same panel.
    assert.match(tag, /text-muted/);
    assert.match(tag, /hover:underline/);
    // The literal `disabled` HTML attribute must be absent -- the class
    // NAME legitimately contains the substring "disabled" (Tailwind's
    // `disabled:` pseudo-class variant syntax), so this checks the real
    // attribute specifically, not the className text.
    assert.doesNotMatch(tag, /\bdisabled(=|>|\s)/, "Skip must never be disabled while the customer is still reviewing");
    assert.match(html, /Skip for now/);
  });

  it("disabled Confirm state is represented on the real element (proposed marks left unresolved)", () => {
    // A non-null view always carries at least one mark region (the
    // server-guaranteed catch-all) whose selection starts null, so
    // canConfirm is false at initial render without any interaction.
    const html = render(view());
    const tag = findTag(html, "artwork-fidelity-confirm-button");
    assert.match(tag, /\bdisabled(=|>|\s)/);
    // The disabled-look utility classes must actually be present, not just
    // the attribute -- this is the exact gap the production defect report
    // found (a real <button> with no styling at all).
    assert.match(tag, /disabled:opacity-40/);
    assert.match(tag, /disabled:cursor-not-allowed/);
  });

  it("enabled Confirm state is represented on the real element (nothing yet to resolve)", () => {
    // Before any proposal exists (artworkFidelity: null), wording/mark
    // completeness are both vacuously satisfied (zero regions to resolve),
    // so canConfirm is true at initial render -- the one reachable
    // "enabled" case this harness's own no-click-simulation constraint
    // allows testing without a DOM.
    const html = render(null);
    const tag = findTag(html, "artwork-fidelity-confirm-button");
    assert.doesNotMatch(tag, /\bdisabled(=|>|\s)/);
  });
});

describe("ArtworkFidelityConfirmationStep — protected-mark choices", () => {
  it("renders all five mark choices as distinct, individually clickable buttons, none pre-selected", () => {
    const html = render(view());
    const ids = ["™", "®", "©", "NONE", "NOT_SURE"];
    for (const id of ids) {
      const tag = findTag(html, `artwork-fidelity-mark-option-m0-${id}`);
      assert.match(tag, /^<button\b/);
      // Never pre-selected -- aria-pressed must be false and the unselected
      // (outlined, not filled) style classes must be the ones applied.
      assert.match(tag, /aria-pressed="false"/);
      assert.match(tag, /border-black\/10/);
      assert.doesNotMatch(tag, /bg-ink text-white/);
    }
    // A real ARIA grouping, not five loose buttons.
    assert.match(html, /role="radiogroup"/);
  });

  it("renders multiple proposed mark regions as separately labeled question groups", () => {
    const html = render(
      view({
        protectedMarks: [
          { id: "m0", visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" },
          { id: "m1", visualDescription: "small letters T and M", classification: "TM", confidence: "high" },
        ],
      }),
    );
    assert.ok(findTag(html, "artwork-fidelity-mark-option-m0-™"));
    assert.ok(findTag(html, "artwork-fidelity-mark-option-m1-™"));
    assert.match(html, /letter R enclosed by a circle/);
    assert.match(html, /small letters T and M/);
  });
});
