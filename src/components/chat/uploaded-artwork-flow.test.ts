import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";

import {
  deriveUploadedArtworkStep,
  isRoutedToOperatorSeparationReview,
  needsAutomaticBackgroundReview,
  uploadedArtworkOwnsSurface,
} from "./uploaded-artwork-flow";

function preparation(
  overrides: Partial<ArtworkPreparationView> = {},
): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "analyzed",
    originalFilename: "logo.png",
    classification: "REPAIRABLE_AUTOMATICALLY",
    customer: {
      backgroundMessage: "Your artwork has a solid background that can be removed automatically.",
      resolutionMessage: null,
      canPrepare: true,
      prepareActionLabel: "Remove the Background",
      enhancementNeeded: false,
    },
    hasPreparedArtwork: false,
    preparedReview: null,
    preparedRevision: null,
    approved: false,
    widthPx: 979,
    heightPx: 1024,
    visibleArtworkWidthPx: 923,
    visibleArtworkHeightPx: 909,
    productSummary: null,
    productColor: null,
    printPlacement: null,
    guidedCleanup: { available: false, removalCount: 0 },
    ...overrides,
  };
}

describe("deriveUploadedArtworkStep", () => {
  it("offers the workflow choice only at the very start of a project", () => {
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "undecided",
        atProjectStart: true,
      }),
      "choose_workflow",
    );
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "undecided",
        atProjectStart: false,
      }),
      null,
    );
  });

  it("leaves the Create New Artwork flow completely untouched", () => {
    // The existing interview must render exactly as before: no uploaded-
    // artwork surface at all, at any point.
    //
    // Correction A: expressed as `atProjectStart: false` rather than a
    // `choice: "create_new"` enum value, which no longer exists. Choosing
    // Create New is durable SERVER state now (the `create_new` marker on
    // the assistant turn `beginCreateNewWorkflow` writes), and
    // `isAtProjectStart` reads it — so by the time this function is asked,
    // the choice has already closed the project-start window.
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "undecided",
        atProjectStart: false,
      }),
      null,
    );
  });

  it("walks upload → details → analysis → compare → approved", () => {
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "upload_existing",
        atProjectStart: true,
      }),
      "upload",
    );

    assert.equal(
      deriveUploadedArtworkStep({
        preparation: preparation(),
        choice: "undecided",
        atProjectStart: false,
      }),
      "confirm_details",
      "a placement is required before print size can be discussed honestly",
    );

    assert.equal(
      deriveUploadedArtworkStep({
        preparation: preparation({ printPlacement: "full_front" }),
        choice: "undecided",
        atProjectStart: false,
      }),
      "review_analysis",
    );

    assert.equal(
      deriveUploadedArtworkStep({
        preparation: preparation({
          printPlacement: "full_front",
          hasPreparedArtwork: true,
          status: "prepared",
        }),
        choice: "undecided",
        atProjectStart: false,
      }),
      "compare",
    );

    assert.equal(
      deriveUploadedArtworkStep({
        preparation: preparation({
          printPlacement: "full_front",
          hasPreparedArtwork: true,
          status: "approved",
          approved: true,
        }),
        choice: "undecided",
        atProjectStart: false,
      }),
      "approved",
    );
  });

  it("an existing preparation is the durable workflow identity", () => {
    // No client-side choice, mid-project, after a reload: the preparation
    // record alone is enough to keep the customer in their own workflow.
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: preparation({ printPlacement: "sleeve" }),
        choice: "undecided",
        atProjectStart: false,
      }),
      "review_analysis",
    );
  });
});

describe("uploadedArtworkOwnsSurface", () => {
  it("does not claim the surface merely by offering the choice", () => {
    assert.equal(uploadedArtworkOwnsSurface("choose_workflow"), false);
    assert.equal(uploadedArtworkOwnsSurface(null), false);
  });

  it("claims the surface for every real step of the upload workflow", () => {
    for (const step of [
      "upload",
      "confirm_details",
      "review_analysis",
      "compare",
      "approved",
    ] as const) {
      assert.equal(uploadedArtworkOwnsSurface(step), true);
    }
  });
});

/**
 * Phase 16: complex-background → operator separation routing.
 *
 * These are pure-function tests of the routing GATE itself — the actual
 * mount/reveal of `SeparationReviewPanel` inside `AnalysisStep` is
 * unreachable from this repo's `renderToString`-only test tooling for the
 * same reason `CompareStep`'s own separation wiring always has been (no DOM,
 * no effects). `complex-background-operator-routing.test.ts` proves the
 * capability layer genuinely supports this without a prepared asset; the
 * Phase 16 browser acceptance proves the two wired together end to end.
 */
describe("needsAutomaticBackgroundReview (Phase 16)", () => {
  it("A/C: only NEEDS_REVIEW opts an artwork into speculative separation routing", () => {
    assert.equal(needsAutomaticBackgroundReview("NEEDS_REVIEW"), true);
    for (const classification of [
      "REPAIRABLE_AUTOMATICALLY",
      "REQUIRES_ENHANCEMENT",
      "PRINT_READY_ALREADY",
      "NOT_REPAIRABLE",
    ] as const) {
      assert.equal(
        needsAutomaticBackgroundReview(classification),
        false,
        `${classification} must not speculatively mount the separation panel`,
      );
    }
  });
});

describe("isRoutedToOperatorSeparationReview (Phase 16)", () => {
  it("A: NEEDS_REVIEW + review_required routes into the operator workspace", () => {
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", "review_required"), true);
  });

  it("A: NEEDS_REVIEW + review_in_progress and review_complete also route in (mid-review reload, and full-review revisit)", () => {
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", "review_in_progress"), true);
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", "review_complete"), true);
  });

  it("B: still loading (null) never routes — the terminal message is the safe default until the server actually says otherwise", () => {
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", null), false);
  });

  it("B: a public/prospect project's 404 surfaces as this same null default — conservative behavior is unchanged", () => {
    // SeparationReviewPanel's GET fetch 404s for a non-internal project and
    // sets `view: null`, which never calls `onStateChange` with anything but
    // the initial `null` — there is no separate "public" signal to test
    // here by construction: it is indistinguishable from "still loading".
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", null), false);
  });

  it("D: review_not_required never forces the operator workspace", () => {
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", "review_not_required"), false);
  });

  it("E: cannot_safely_automate fails closed — no invented continuation", () => {
    assert.equal(isRoutedToOperatorSeparationReview("NEEDS_REVIEW", "cannot_safely_automate"), false);
  });

  it("C: easy artwork (any non-NEEDS_REVIEW classification) never routes, even if a stray state were somehow reported", () => {
    for (const classification of [
      "REPAIRABLE_AUTOMATICALLY",
      "REQUIRES_ENHANCEMENT",
      "PRINT_READY_ALREADY",
      "NOT_REPAIRABLE",
    ] as const) {
      for (const state of [
        "review_required",
        "review_in_progress",
        "review_complete",
        "review_not_required",
        "cannot_safely_automate",
        null,
      ] as const) {
        assert.equal(
          isRoutedToOperatorSeparationReview(classification, state),
          false,
          `${classification} + ${state} must never route into operator separation review`,
        );
      }
    }
  });
});
