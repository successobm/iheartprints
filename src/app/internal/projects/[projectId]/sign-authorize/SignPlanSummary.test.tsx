/**
 * Simplify Signs Production Review Phase: proves the normal review screen
 * is genuinely human-language — the SAME findings/proposedAction sentences
 * the customer-facing chat surface already renders, never a bare defect
 * code, step kind, pixel count, or RGB value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { SignPlanSummary } from "./SignPlanSummary";

/** Mirrors `UploadedArtworkPanel.test.tsx`'s own helper — strips tags, HTML comments (React's SSR hydration-boundary markers between adjacent expressions), and entities down to plain readable text. */
function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function render(props: Partial<Parameters<typeof SignPlanSummary>[0]> = {}) {
  return renderToString(
    createElement(SignPlanSummary, {
      orderedWidthIn: 18,
      orderedHeightIn: 6,
      findings: [],
      proposedAction: null,
      reviewRequired: false,
      ...props,
    }),
  );
}

describe("SignPlanSummary: the normal, human-language review screen", () => {
  it("review-required: headline says 'Artwork needs review'", () => {
    const html = render({ reviewRequired: true, proposedAction: "We can adjust the artwork." });
    assert.match(html, />Artwork needs review</);
  });

  it("nothing to fix: headline says 'Ready to prepare', never 'needs review'", () => {
    const html = render({ reviewRequired: false, proposedAction: null });
    assert.match(html, />Ready to prepare</);
    assert.doesNotMatch(html, /needs review/i);
  });

  it("shows the ordered size in plain inches notation", () => {
    const text = visibleText(render({ orderedWidthIn: 18, orderedHeightIn: 6 }));
    assert.match(text, /18" × 6"/);
  });

  it("renders the real proposed-action sentence verbatim — the SAME plain language a customer would see", () => {
    const text = visibleText(
      render({
        reviewRequired: true,
        proposedAction:
          "We can add space around the design so it fits your sign without stretching or trimming your artwork.",
      }),
    );
    assert.match(text, /add space around the design/);
    assert.match(text, /without stretching or trimming/);
  });

  it("renders each finding as its own plain sentence", () => {
    const text = visibleText(
      render({
        reviewRequired: true,
        findings: [
          "The proportions of your artwork don't exactly match the sign size.",
          "Part of your design reaches the very edge of the artwork, so filling it in needs a closer look.",
        ],
        proposedAction: "We can add space around the design.",
      }),
    );
    assert.match(text, /don't exactly match the sign size/);
    assert.match(text, /reaches the very edge of the artwork/);
  });

  it("nothing needs to change: says so plainly rather than fabricating a proposed action", () => {
    const text = visibleText(render({ proposedAction: null, reviewRequired: false }));
    assert.match(text, /already fits the ordered size well/);
  });

  it("NEVER leaks technical implementation vocabulary — no pixel counts, RGB values, plan risk labels, or step/repair identifiers", () => {
    const text = visibleText(
      render({
        reviewRequired: true,
        findings: ["The proportions of your artwork don't exactly match the sign size."],
        proposedAction:
          "We can add space around the design so it fits your sign without stretching or trimming your artwork.",
      }),
    );
    for (const term of [
      "RGB",
      "px",
      "planKey",
      "riskLabel",
      "pad_uniform_background",
      "downsample",
      "reconstruct_perimeter_structure",
      "Phase 3B",
      "authorize",
      "Authorize",
    ]) {
      assert.doesNotMatch(text, new RegExp(term), `leaked: ${term}`);
    }
  });
});
