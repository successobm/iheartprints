import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";

import { UploadedArtworkPanel } from "./UploadedArtworkPanel";

/**
 * Print'em All Phase 2 — THE LIVE DEAD-END REGRESSION.
 *
 * A real internal Print'em All project reached a state with no way forward:
 *
 *   prepared artwork approved       yes
 *   garment_size_class              null
 *   production_size_confirmed_at    null
 *   finalization.status             retryable_failure  (Standard Raster)
 *
 * The Production Treatment card correctly refused DTF Halftone — "no size has
 * been confirmed for this project" — and the ONLY other control on screen was
 * "Retry Preparation", which would have failed exactly as before. The garment
 * picker, the recommendation, the contained dimensions, and the confirmation
 * control were all absent.
 *
 * The cause was a single early `return` in `PrintReadyStep` for
 * `retryable_failure`, which rendered a retry notice INSTEAD OF the production
 * authorities rather than alongside them. Server state was complete the whole
 * time — `resolvePrintReadySize` returns a full view for any approved
 * preparation, regardless of finalization status.
 *
 * The rule this file exists to hold: **a previous failed production attempt
 * must never remove the controls needed to choose a different valid
 * production treatment.**
 */

function preparation(
  overrides: Partial<ArtworkPreparationView> = {},
): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "approved",
    originalFilename: "team artwork.png",
    classification: "usable",
    customer: {
      headline: "Your artwork is ready to review",
      summary: "We removed the background.",
      enhancementNeeded: true,
      guidance: [],
    },
    hasPreparedArtwork: true,
    approved: true,
    widthPx: 584,
    heightPx: 640,
    visibleArtworkWidthPx: 562,
    visibleArtworkHeightPx: 486,
    productSummary: "T-shirts for our bowling team",
    productColor: "Black",
    printPlacement: "full_back",
    preparedRevision: "rev-1",
    ...overrides,
  } as ArtworkPreparationView;
}

/** The LIVE state: nothing confirmed, no garment class chosen. */
function unconfirmedSize(
  overrides: Partial<PrintReadySizeView> = {},
): PrintReadySizeView {
  return {
    widthIn: 10.5,
    heightIn: 9.08,
    dpi: 300,
    placementLabel: "Full Back",
    isDefaultWidth: true,
    minWidthIn: 4,
    maxWidthIn: 14,
    widthOptions: [
      { widthIn: 9, label: '9"', isStandard: false, isSelected: false },
      { widthIn: 10.5, label: '10.5" Standard', isStandard: true, isSelected: true },
      { widthIn: 12, label: '12"', isStandard: false, isSelected: false },
    ],
    note: null,
    recommendation: {
      recommendedFor: "Adult standard · Full Back",
      boxWidthIn: 10.5,
      boxHeightIn: 10.5,
      artworkWidthIn: 10.5,
      artworkHeightIn: 9.08,
      // Nobody has stated a garment class — the recommendation is an
      // ASSUMPTION, and it is labelled as one.
      assumedGarmentSizeClass: true,
      isConfirmed: false,
    },
    confirmed: false,
    confirmedAt: null,
    blockingMessage: "Confirm the print size before preparation.",
    garmentSizeOptions: [
      { value: "youth", label: "Youth", isSelected: false },
      { value: "womens_small", label: "Women's / Smaller Garment", isSelected: false },
      { value: "adult_standard", label: "Standard Adult", isSelected: false },
      { value: "adult_plus", label: "2XL–4XL / Larger Garment", isSelected: false },
      { value: "custom", label: "Custom Size", isSelected: false },
    ],
    requiresExplicitWidth: false,
    ...overrides,
  } as PrintReadySizeView;
}

function render(options: {
  finalizationStatus?: CustomerFinalizationStatus;
  size?: PrintReadySizeView | null;
  busy?: boolean;
} = {}) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step: "approved" as const,
      preparation: preparation(),
      busy: options.busy ?? false,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: "https://signed.example/prepared.png",
      printReadySize: "size" in options ? options.size! : unconfirmedSize(),
      finalizationStatus: options.finalizationStatus ?? "not_requested",
      onUpload: () => {},
      onSaveDetails: () => {},
      onPrepare: () => {},
      onApprove: () => {},
      onReconsider: () => {},
      onChoosePrintWidth: () => {},
      onUseRecommendedSize: () => {},
      onChooseGarmentSize: () => {},
      onPrepareForPrint: () => {},
    }),
  );
}

/** Markup stripped — assertions about what an operator READS. */
function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the button whose label is `label` is actually disabled.
 *
 * Deliberately NOT a `/disabled/` search over the markup. Tailwind's
 * `disabled:cursor-not-allowed` and `disabled:opacity-40` put the literal
 * string "disabled" into the CLASS attribute of every one of these buttons, so
 * the naive test passes whatever the truth is. React SSR renders the real
 * boolean attribute as `disabled=""`; that is what this looks for, scoped to
 * one button.
 */
function buttonIsDisabled(html: string, label: string): boolean {
  const compact = html.replace(/\s+/g, " ");
  const pattern = new RegExp(`<button([^>]*)>\\s*${label}\\s*</button>`);
  const match = pattern.exec(compact);
  assert.ok(match, `no <button> labelled "${label}" was rendered`);
  return / disabled=""/.test(match![1]);
}

/** Every control the size authority is made of, as an operator sees them. */
function assertSizeAuthorityVisible(html: string, context: string) {
  const text = visibleText(html);
  for (const label of [
    "Youth",
    "Women's / Smaller Garment",
    "Standard Adult",
    "2XL–4XL / Larger Garment",
    "Custom Size",
  ]) {
    assert.ok(
      text.includes(label),
      `${context}: garment class "${label}" must be selectable`,
    );
  }
  assert.match(text, /10\.5/, `${context}: the recommendation must be stated`);
  assert.match(
    text,
    /confirm/i,
    `${context}: an explicit confirmation control must exist`,
  );
}

describe("Internal Existing Artwork must never dead-end on production size", () => {
  it("A: prepared + approved + unconfirmed shows the full size authority", () => {
    assertSizeAuthorityVisible(
      render({ finalizationStatus: "not_requested" }),
      "not_requested",
    );
  });

  it("B: retryable_failure + unconfirmed STILL shows the full size authority", () => {
    // THE REGRESSION. Before the fix this rendered a retry notice and a button
    // and nothing else.
    const html = render({ finalizationStatus: "retryable_failure" });
    assertSizeAuthorityVisible(html, "retryable_failure");

    // The failure is still reported — as a banner, not as a replacement.
    assert.match(visibleText(html), /Print-ready preparation couldn/);
    assert.match(visibleText(html), /Retry Preparation/);
  });

  it("C: a reload of that same state renders identically — nothing lives in component state", () => {
    // A refresh re-renders from the server snapshot. Two independent renders
    // of the same props must therefore be byte-identical; if they were not,
    // some authority would be living in the client.
    const first = render({ finalizationStatus: "retryable_failure" });
    const second = render({ finalizationStatus: "retryable_failure" });
    assert.equal(first, second);
    assertSizeAuthorityVisible(second, "reload");
  });

  it("B: the retry action is the ONLY primary action — no duplicate prepare button", () => {
    const text = visibleText(render({ finalizationStatus: "retryable_failure" }));
    const retryCount = text.split("Retry Preparation").length - 1;
    assert.equal(retryCount, 1, "exactly one retry action");
    assert.doesNotMatch(
      text,
      /Create Print-Ready Artwork/,
      "the first-run action must not appear alongside a retry",
    );
  });

  it("B: exactly one garment picker is rendered — never a second size authority", () => {
    const text = visibleText(render({ finalizationStatus: "retryable_failure" }));
    assert.equal(
      text.split("2XL–4XL / Larger Garment").length - 1,
      1,
      "a duplicated picker would be a second, competing size authority",
    );
  });

  it("D: the standard-adult recommendation is stated as 10.5 x 10.5", () => {
    const text = visibleText(
      render({
        finalizationStatus: "retryable_failure",
        size: unconfirmedSize({
          garmentSizeOptions: [
            { value: "youth", label: "Youth", isSelected: false },
            {
              value: "womens_small",
              label: "Women's / Smaller Garment",
              isSelected: false,
            },
            { value: "adult_standard", label: "Standard Adult", isSelected: true },
            {
              value: "adult_plus",
              label: "2XL–4XL / Larger Garment",
              isSelected: false,
            },
            { value: "custom", label: "Custom Size", isSelected: false },
          ],
        }),
      }),
    );
    assert.match(text, /10\.5/);
    // And the artwork's own CONTAINED output dimensions, which are not the box.
    assert.match(text, /9\.08|9\.1/);
  });

  it("E: choosing a garment class does NOT confirm — the recommendation stays a recommendation", () => {
    const html = render({
      finalizationStatus: "retryable_failure",
      size: unconfirmedSize({
        garmentSizeOptions: [
          { value: "youth", label: "Youth", isSelected: false },
          {
            value: "womens_small",
            label: "Women's / Smaller Garment",
            isSelected: false,
          },
          { value: "adult_standard", label: "Standard Adult", isSelected: true },
          { value: "adult_plus", label: "2XL–4XL / Larger Garment", isSelected: false },
          { value: "custom", label: "Custom Size", isSelected: false },
        ],
      }),
    });
    // Still unconfirmed, so the primary action is still disabled. A class is
    // a context for a SUGGESTION; consent is a separate act.
    assert.match(visibleText(html), /confirm/i);
    assert.equal(buttonIsDisabled(html, "Retry Preparation"), true);
  });

  // Phase 28H removed the customer-facing Production Treatment selection
  // card entirely (`ProductionTreatmentPanel` is no longer mounted inside
  // `UploadedArtworkPanel`) — the two tests that used to live here ("G: DTF
  // Halftone is NOT selectable before confirmation" / "H: DTF Halftone
  // becomes selectable once the size is confirmed") proved a pre-creation
  // treatment CHOICE that no longer exists: Standard Raster is now always
  // attempted first, automatically, and DTF Halftone is offered only AFTER
  // it reaches a terminal state — see
  // `uploaded-artwork-print-ready-flow.test.tsx` for that replacement
  // coverage, including its own size-confirmation prerequisites.

  it("F: confirming also re-enables the production request itself", () => {
    const html = render({
      finalizationStatus: "retryable_failure",
      size: unconfirmedSize({
        confirmed: true,
        confirmedAt: "2026-08-21T00:00:00.000Z",
        blockingMessage: null,
      }),
    });
    // The retry button is present and NOT disabled — confirming the size
    // unblocks the production request itself.
    assert.equal(buttonIsDisabled(html, "Retry Preparation"), false);
  });

  it("I: a custom garment class asks for an explicit width instead of suggesting one", () => {
    const text = visibleText(
      render({
        finalizationStatus: "retryable_failure",
        size: unconfirmedSize({
          // No authoritative box exists for a custom garment — the honest
          // response is to ask, never to invent a recommendation.
          recommendation: null,
          requiresExplicitWidth: true,
          garmentSizeOptions: [
            { value: "youth", label: "Youth", isSelected: false },
            {
              value: "womens_small",
              label: "Women's / Smaller Garment",
              isSelected: false,
            },
            { value: "adult_standard", label: "Standard Adult", isSelected: false },
            {
              value: "adult_plus",
              label: "2XL–4XL / Larger Garment",
              isSelected: false,
            },
            { value: "custom", label: "Custom Size", isSelected: true },
          ],
        }),
      }),
    );
    assert.match(text, /Custom Size/);
    assert.doesNotMatch(
      text,
      /Recommended for/i,
      "a custom garment must not be shown a box this product does not have",
    );
  });

  it("the ordering reads: size authority → production request", () => {
    // The operator workflow should read in the order the work happens.
    const text = visibleText(render({ finalizationStatus: "not_requested" }));
    const sizeAt = text.indexOf("Standard Adult");
    const actionAt = text.indexOf("Create Print-Ready Artwork");

    assert.ok(sizeAt >= 0 && actionAt >= 0);
    assert.ok(sizeAt < actionAt, "size authority must come before the production request");
  });

  // Phase 28H removed "V: after switching to halftone, the action stops
  // calling itself a retry" and "L: choosing halftone reveals the screen
  // controls" -- both proved behavior of the removed pre-creation treatment
  // CHOICE (switching the primary action's own target treatment via
  // `ProductionTreatmentPanel`). DTF Halftone is now created through its own
  // dedicated "Create DTF Halftone Version" action (see
  // `PrintReadyPackageCard`/`uploaded-artwork-print-ready-flow.test.tsx`),
  // which never relabels or reconfigures Standard Raster's own retry button.

  it("M: no 'Production treatment' selection card renders at all, for any finalization status -- Phase 28H Section 13.A", () => {
    for (const status of ["not_requested", "retryable_failure", "needs_review", "print_ready"] as const) {
      const html = render({ finalizationStatus: status });
      const text = visibleText(html);
      assert.doesNotMatch(text, /Production treatment/i, `status=${status}`);
      assert.doesNotMatch(text, /\bINTERNAL\b/, `status=${status}`);
    }
    // The size authority is unaffected by any of this.
    assertSizeAuthorityVisible(render({ finalizationStatus: "retryable_failure" }), "no treatment card");
  });

  it("`preparing` is still the one state that replaces the controls", () => {
    // Not an oversight. The size confirmation is refused server-side while a
    // plate is being made, so offering it would put the page and the server
    // into open disagreement.
    const text = visibleText(render({ finalizationStatus: "preparing" }));
    assert.doesNotMatch(text, /Standard Adult/);
  });
});
