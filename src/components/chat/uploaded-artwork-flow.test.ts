import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";

import {
  deriveUploadedArtworkStep,
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
