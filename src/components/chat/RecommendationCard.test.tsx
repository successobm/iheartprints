import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import { RecommendationCard } from "./RecommendationCard";
import type { RecommendationAction } from "@/capabilities/shared/contracts";

const actions: RecommendationAction[] = [
  { label: "Use White", kind: "apply", replyText: "Use white instead of gold." },
  { label: "Keep Gold", kind: "keep", replyText: "Keep it as gold." },
  { label: "Dismiss", kind: "dismiss", replyText: "No changes for now, keep going." },
];

describe("RecommendationCard", () => {
  it("renders the recommendation message and every action's label", () => {
    const html = renderToString(
      createElement(RecommendationCard, {
        message: "White lettering will stand out better than gold on a navy shirt.",
        actions,
        busy: false,
        onAction: () => {},
      }),
    );
    assert.match(html, /White lettering will stand out better/);
    assert.match(html, /Use White/);
    assert.match(html, /Keep Gold/);
    assert.match(html, /Dismiss/);
  });

  it("never exposes internal severity or numeric confidence", () => {
    const html = renderToString(
      createElement(RecommendationCard, {
        message: "White lettering will stand out better than gold on a navy shirt.",
        actions,
        busy: false,
        onAction: () => {},
      }),
    );
    assert.doesNotMatch(html, /\d+%/);
    assert.doesNotMatch(html, /warning|blocking|severity/i);
  });

  it("renders no action buttons when there are none", () => {
    const html = renderToString(
      createElement(RecommendationCard, {
        message: "Just letting you know.",
        actions: [],
        busy: false,
        onAction: () => {},
      }),
    );
    assert.doesNotMatch(html, /<button/);
  });

  it("disables every action while busy", () => {
    const html = renderToString(
      createElement(RecommendationCard, {
        message: "White lettering will stand out better than gold on a navy shirt.",
        actions,
        busy: true,
        onAction: () => {},
      }),
    );
    const disabledCount = html.split('disabled=""').length - 1;
    assert.equal(disabledCount, actions.length);
  });
});
