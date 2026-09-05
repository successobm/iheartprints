/**
 * Signs Normal Workstation Simplification Phase: SSR snapshot checks
 * proving the normal Signs workstation no longer renders Wand/tolerance/
 * Advanced-pixel-correction/Move/Remove/Destination-X/Y markup at all —
 * not merely hidden behind a link (Section C) — while retaining zoom
 * controls and the SAFE guide legend. Same pattern
 * `GuidedCleanupWorkspace.test.tsx` already uses (`renderToString`, no
 * click harness needed for a static/initial-state assertion) — this
 * component's own state starts with no queue/selection/preview concept
 * left to click through, so a single initial render already proves the
 * whole normal surface.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { SignFitToProductionSummary } from "@/capabilities/sign-preparation";

import { SignFitToProductionCorrectionTool } from "./SignFitToProductionCorrectionTool";

/** Minimal fake `AppRouterInstance` — this component only ever calls `refresh()`, and only from a click handler that never fires during a static SSR snapshot. */
const fakeRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => Promise.resolve(),
};

function edge(
  edgeName: "top" | "right" | "bottom" | "left",
  protectedResult: "pass" | "fail" | "unknown",
  overrides: Partial<SignFitToProductionSummary["edges"][number]> = {},
): SignFitToProductionSummary["edges"][number] {
  return {
    edge: edgeName,
    requiredProtectedInsetIn: 0.125,
    requiredProtectedInsetPx: 22,
    nearestProtectedContentPx: protectedResult === "pass" ? 50 : 0,
    nearestProtectedContentIn: protectedResult === "pass" ? 0.29 : 0,
    violatingPositionPx: protectedResult === "pass" ? null : 100,
    protectedResult,
    reason: "test fixture",
    edgeIntentPresent: false,
    edgeIntentNearestCutPx: null,
    edgeIntentAdvisory: false,
    unresolvedAmbiguousPresent: protectedResult === "fail",
    ...overrides,
  };
}

function passingFitToProduction(): SignFitToProductionSummary {
  return {
    status: "pass",
    reason: "all edges clear",
    safeInsetIn: 0.125,
    achievedPpiX: 170.6,
    achievedPpiY: 170.6,
    edges: [edge("top", "pass"), edge("right", "pass"), edge("bottom", "pass"), edge("left", "pass")],
  };
}

function blockedFitToProduction(): SignFitToProductionSummary {
  return {
    status: "fail",
    reason: "right edge fails",
    safeInsetIn: 0.125,
    achievedPpiX: 170.6,
    achievedPpiY: 170.6,
    edges: [edge("top", "pass"), edge("right", "fail"), edge("bottom", "pass"), edge("left", "pass")],
  };
}

function ambiguousFitToProduction(): SignFitToProductionSummary {
  return {
    status: "unknown",
    reason: "top edge bleed baseline unprovable",
    safeInsetIn: 0.125,
    achievedPpiX: 170.6,
    achievedPpiY: 170.6,
    edges: [edge("top", "unknown"), edge("right", "pass"), edge("bottom", "pass"), edge("left", "pass")],
  };
}

function render(fitToProduction: SignFitToProductionSummary) {
  return renderToString(
    createElement(
      AppRouterContext.Provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake, real type is Next-internal
      { value: fakeRouter as any },
      createElement(SignFitToProductionCorrectionTool, {
        projectId: "test-project",
        fitToProduction,
        orderedWidthIn: 36,
        orderedHeightIn: 24,
        artworkWidthPx: 6144,
        artworkHeightPx: 4096,
      }),
    ),
  );
}

describe("SignFitToProductionCorrectionTool: normal workstation surface (Section C)", () => {
  it("1. does not render Wand", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, /\bWand\b/);
    assert.doesNotMatch(html, /data-testid="sign-tool-wand"/);
  });

  it("2. does not render Wand tolerance controls", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, /Tolerance/i);
    assert.doesNotMatch(html, /data-testid="sign-wand-tolerance-/);
  });

  it("3. does not render Less / Normal / More tolerance buttons, or an Advanced pixel correction link", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, /data-testid="sign-wand-tolerance-less"/);
    assert.doesNotMatch(html, /data-testid="sign-wand-tolerance-more"/);
    assert.doesNotMatch(html, /Advanced pixel correction/);
    assert.doesNotMatch(html, /data-testid="sign-switch-to-advanced"/);
    assert.doesNotMatch(html, /data-sign-advanced-warning/);
  });

  it("4. does not render Move", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, />Move</);
    assert.doesNotMatch(html, /data-testid="sign-tool-move"/);
    assert.doesNotMatch(html, /data-testid="sign-correction-move"/);
    assert.doesNotMatch(html, /data-testid="sign-wand-move"/);
  });

  it("5. does not render Remove", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, />Remove</);
    assert.doesNotMatch(html, /data-testid="sign-tool-remove"/);
    assert.doesNotMatch(html, /data-testid="sign-correction-remove"/);
    assert.doesNotMatch(html, /data-testid="sign-wand-delete"/);
  });

  it("6. does not render Destination X/Y or rectangle-selection editing controls", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, /Destination y/i);
    assert.doesNotMatch(html, /data-testid="sign-correction-move-dest-y"/);
    assert.doesNotMatch(html, /data-testid="sign-correction-selection-x"/);
    assert.doesNotMatch(html, /data-testid="sign-action-panel"/);
    assert.doesNotMatch(html, /Precise coordinates/);
  });

  it("does not render any tool rail at all", () => {
    const html = render(blockedFitToProduction());
    assert.doesNotMatch(html, /data-sign-tool-rail/);
    assert.doesNotMatch(html, /data-sign-interaction-mode/);
  });

  it("7. retains zoom controls", () => {
    const html = render(blockedFitToProduction());
    assert.match(html, /data-sign-zoom-controls/);
    assert.match(html, /data-testid="sign-correction-zoom-out"/);
    assert.match(html, /data-testid="sign-correction-zoom-in"/);
    assert.match(html, /data-testid="sign-correction-zoom-fit"/);
    assert.match(html, /data-testid="sign-correction-zoom-100"/);
  });

  it("8. retains the SAFE guide legend, with copy that never mentions selecting/connected shapes", () => {
    const html = render(blockedFitToProduction());
    assert.match(html, /Dashed guide/);
    assert.match(html, /0\.125/);
    assert.doesNotMatch(html, /connected shape/i);
    assert.doesNotMatch(html, /Click directly on the artwork/i);
  });

  it("9. a blocked (fit_adjustment_required) state offers Fit to Safe Area as the primary action", () => {
    const html = render(blockedFitToProduction());
    assert.match(html, /Protected content needs more clearance/);
    assert.match(html, /data-testid="sign-fit-safe-area-preview"/);
    assert.match(html, />Fit artwork to safe area</);
  });

  it("a passing (ready_as_supplied) state shows 'Ready as supplied' and does NOT offer Fit", () => {
    const html = render(passingFitToProduction());
    assert.match(html, /Ready as supplied/);
    assert.match(html, /No artwork changes required/);
    assert.doesNotMatch(html, /data-testid="sign-fit-safe-area-preview"/);
  });

  it("an ambiguous (edge_classification_needed) state asks for production review, never offers Wand", () => {
    const html = render(ambiguousFitToProduction());
    assert.match(html, /Edge content needs production review/);
    assert.doesNotMatch(html, /\bWand\b/);
    assert.doesNotMatch(html, /data-testid="sign-fit-safe-area-preview"/);
  });
});
