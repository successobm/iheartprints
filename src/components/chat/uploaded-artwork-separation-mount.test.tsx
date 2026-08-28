import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";

import { UploadedArtworkPanel } from "./UploadedArtworkPanel";
import type { UploadedArtworkStep } from "./uploaded-artwork-flow";

/**
 * Intelligent Separation Phase 10, Goal 2/3/4/16: proves `SeparationReviewPanel`
 * is actually mounted at the intended point in the real `UploadedArtworkPanel`
 * — not merely built and tested in isolation, the gap Phase 9's own report
 * flagged.
 *
 * HONEST BOUNDARY (Goal 17): this repo's only React test tool is
 * `react-dom/server`'s `renderToString` — a single, effect-free render pass.
 * `SeparationReviewPanel` fetches its own state in a `useEffect`, which
 * `renderToString` never runs, so every render captured here is the panel's
 * INITIAL, pre-fetch render. That is sufficient to prove placement (is it in
 * the tree, in the right order, only on the right step) and the optimistic
 * default (does easy artwork's approval button render before any separation
 * check completes) — it is NOT an end-to-end proof of the fetch/decide/
 * approve round trip. That round trip is proven at the HTTP layer instead:
 * `separation-routes-authorization.test.ts` (Goal 12) calls the real route
 * handlers, and `separation-decision-workflow.test.ts` (Phase 9) proves the
 * capability underneath them. This file is deliberately not called
 * "end-to-end" anywhere, per Goal 17's instruction to state the boundary
 * honestly rather than overclaim it.
 */

function preparation(overrides: Partial<ArtworkPreparationView> = {}): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "prepared",
    originalFilename: "bowling-logo.png",
    classification: "REQUIRES_ENHANCEMENT",
    customer: {
      backgroundMessage: "Your artwork has a solid background that can be removed automatically.",
      resolutionMessage: null,
      canPrepare: true,
      prepareActionLabel: "Remove the Background",
      enhancementNeeded: false,
    },
    hasPreparedArtwork: true,
    preparedReview: {
      headline: "Background prepared",
      guidance: "Review the artwork below before continuing.",
      sharesBackgroundColor: false,
      reviewRequired: false,
      garmentMayMatchBackground: null,
    },
    preparedRevision: "rev-fixture-prepared",
    approved: false,
    widthPx: 979,
    heightPx: 1024,
    visibleArtworkWidthPx: 923,
    visibleArtworkHeightPx: 909,
    productSummary: "T-shirts for our bowling team",
    productColor: "Black",
    printPlacement: "full_front",
    guidedCleanup: { available: true, removalCount: 0 },
    ...overrides,
  };
}

function printReadySize(): PrintReadySizeView {
  return {
    widthIn: 10.5,
    heightIn: 10.34,
    dpi: 300,
    placementLabel: "Full Back",
    isDefaultWidth: true,
    minWidthIn: 4,
    maxWidthIn: 14,
    widthOptions: [
      { widthIn: 10.5, label: '10.5" Standard', isStandard: true, isSelected: true },
    ],
    note: "This is a standard adult full back print size.",
    recommendation: {
      recommendedFor: "Adult standard · Full Back",
      boxWidthIn: 10.5,
      boxHeightIn: 10.5,
      artworkWidthIn: 10.5,
      artworkHeightIn: 10.34,
      assumedGarmentSizeClass: true,
      isConfirmed: true,
    },
    confirmed: true,
    confirmedAt: "2026-08-21T00:00:00.000Z",
    blockingMessage: null,
    garmentSizeOptions: [
      { value: "adult_standard", label: "Standard Adult", isSelected: true },
    ],
    requiresExplicitWidth: false,
  };
}

function render(step: UploadedArtworkStep, overrides: Partial<ArtworkPreparationView> = {}) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step,
      preparation: preparation(overrides),
      busy: false,
      printReadySize: printReadySize(),
      finalizationStatus: "not_requested",
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: "https://signed.example/prepared.png",
      onUpload: () => {
        throw new Error("must never fire from rendering");
      },
      onSaveDetails: () => {
        throw new Error("must never fire from rendering");
      },
      onPrepare: () => {
        throw new Error("must never fire from rendering");
      },
      onApprove: () => {
        throw new Error("must never fire from rendering");
      },
      onReconsider: () => {
        throw new Error("must never fire from rendering");
      },
      onChoosePrintWidth: () => {
        throw new Error("must never fire from rendering");
      },
      onPrepareForPrint: () => {
        throw new Error("must never fire from rendering");
      },
    }),
  );
}

const SEPARATION_LOADING_TEXT = "Checking whether this artwork needs a separation review";

describe("UploadedArtworkPanel — SeparationReviewPanel mount (Intelligent Separation Phase 10)", () => {
  it("W: the compare step actually mounts SeparationReviewPanel — not merely built in isolation", () => {
    const html = render("compare");
    assert.match(html, new RegExp(SEPARATION_LOADING_TEXT));
  });

  it("X: separation review is positioned after the review area (loading state, on first render), before the approval controls", () => {
    // Phase 28G Defect A: "Review your artwork" (the ordinary comparison's
    // own heading) no longer renders on the FIRST render at all -- the
    // very first render is now the review-loading state
    // (`data-review-loading-state`), which occupies the same structural
    // position the comparison used to. The ordering guarantee this test
    // protects is unchanged: the review area comes first, then
    // `SeparationReviewPanel`'s own mount point, then the approval
    // controls area.
    const html = render("compare");
    const reviewAreaAt = html.indexOf("data-review-loading-state");
    const separationAt = html.indexOf(SEPARATION_LOADING_TEXT);
    const approvalAt = html.indexOf("Your original upload is saved and unchanged.");
    assert.ok(reviewAreaAt !== -1 && separationAt !== -1 && approvalAt !== -1);
    assert.ok(
      reviewAreaAt < separationAt && separationAt < approvalAt,
      "expected order: review area -> separation review -> approval controls",
    );
  });

  it("Phase 28G Defect A CORRECTION of 'Goal 16': easy artwork's approval button does NOT render on the FIRST render -- it fails closed until separation status resolves", () => {
    // BEFORE Phase 28G, this test asserted the opposite: `CompareStep`
    // started `separationState` at `null` ("assume not required")
    // specifically so this button never waited on `SeparationReviewPanel`'s
    // fetch. Human acceptance on the real Chili & Salsa order proved that
    // optimism unsafe -- for the ~10 seconds the fetch took, the customer
    // saw and could click an approval button before the system had
    // actually established whether approving it that way was safe. This is
    // the CENTRAL behavior Phase 28G Defect A fixes: `separationState` now
    // starts at `"checking"`, and this button is withheld until it
    // resolves. See `uploaded-artwork-single-review.test.tsx` for the full
    // suite proving this, and for the source-level proof that the button
    // DOES render once resolved to "no gate required".
    const html = render("compare");
    assert.doesNotMatch(html, /Use This Artwork/);
    assert.match(html, /data-review-loading-state/);
  });

  it("Goal 16: no amber warning appears solely because the separation feature exists", () => {
    const html = render("compare", {
      preparedReview: {
        headline: "Background prepared",
        guidance: "Review the artwork below before continuing.",
        sharesBackgroundColor: false,
        reviewRequired: false,
        garmentMayMatchBackground: null,
      },
    });
    assert.doesNotMatch(html, /data-preparation-readiness="review_required"/);
  });

  it("SeparationReviewPanel is scoped to the compare step only — absent from approved", () => {
    const html = render("approved", { approved: true, hasPreparedArtwork: true });
    assert.doesNotMatch(html, new RegExp(SEPARATION_LOADING_TEXT));
  });

  it("SeparationReviewPanel is absent before any artwork is prepared", () => {
    const html = render("review_analysis", { hasPreparedArtwork: false });
    assert.doesNotMatch(html, new RegExp(SEPARATION_LOADING_TEXT));
  });
});
