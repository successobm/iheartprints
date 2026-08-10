import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";

import { ArtworkComparison } from "./ArtworkComparison";
import { UploadedArtworkPanel } from "./UploadedArtworkPanel";
import { WorkflowChoiceCard } from "./WorkflowChoiceCard";
import {
  deriveUploadedArtworkStep,
  type UploadedArtworkStep,
} from "./uploaded-artwork-flow";

function preparation(
  overrides: Partial<ArtworkPreparationView> = {},
): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "prepared",
    originalFilename: "bowling-logo.png",
    classification: "REQUIRES_ENHANCEMENT",
    customer: {
      backgroundMessage:
        "Your artwork has a solid background that can be removed automatically.",
      resolutionMessage:
        'Your artwork is smaller than the recommended print resolution for a 10.5"-wide print on the full front. We\'ll need to enhance it before creating the final print-ready file.',
      canPrepare: true,
      prepareActionLabel: "Remove the Background",
      enhancementNeeded: true,
    },
    hasPreparedArtwork: true,
    approved: false,
    widthPx: 979,
    heightPx: 1024,
    productSummary: "T-shirts for our bowling team",
    productColor: "Black",
    printPlacement: "full_front",
    ...overrides,
  };
}

function render(
  step: UploadedArtworkStep,
  overrides: Partial<ArtworkPreparationView> = {},
  images: { original?: string | null; prepared?: string | null } = {},
) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      step,
      preparation: preparation(overrides),
      busy: false,
      // `in`, not `??` — an explicit `null` means "still loading" and must
      // not fall back to the default URL.
      originalImageUrl:
        "original" in images ? images.original! : "https://signed.example/original.png",
      preparedImageUrl:
        "prepared" in images ? images.prepared! : "https://signed.example/prepared.png",
      onUpload: () => {
        throw new Error("onUpload must never fire from rendering");
      },
      onSaveDetails: () => {
        throw new Error("onSaveDetails must never fire from rendering");
      },
      onPrepare: () => {
        throw new Error("onPrepare must never fire from rendering");
      },
      onApprove: () => {
        throw new Error("onApprove must never fire from rendering");
      },
      onReconsider: () => {
        throw new Error("onReconsider must never fire from rendering");
      },
    }),
  );
}

describe("WorkflowChoiceCard", () => {
  it("offers both workflows in the customer's own terms", () => {
    const html = renderToString(
      createElement(WorkflowChoiceCard, {
        busy: false,
        onCreateNew: () => {
          throw new Error("must never fire from rendering");
        },
        onUploadExisting: () => {
          throw new Error("must never fire from rendering");
        },
      }),
    );

    assert.match(html, /Create New Artwork/);
    assert.match(html, /Upload Existing Artwork/);
    // No technical vocabulary in the choice itself.
    assert.doesNotMatch(html, /workflow|mode|pipeline|PNG|resolution/i);
  });
});

describe("UploadedArtworkPanel", () => {
  it("upload step accepts only what the pipeline can actually decode", () => {
    const html = render("upload");
    assert.match(html, /accept="image\/png"/);
    assert.match(html, /Choose a PNG file/);
    // Never advertises support that does not exist.
    assert.doesNotMatch(html, /jpe?g|webp|svg/i);
  });

  it("details step asks only production questions, never creative ones", () => {
    const html = render("confirm_details", { printPlacement: null });

    assert.match(html, /What are we printing this on/i);
    assert.match(html, /Garment colour/);
    assert.match(html, /Where should this print/);
    assert.match(html, /Full Front/);
    // An uploaded-artwork customer already HAS their design.
    assert.doesNotMatch(html, /describe (the|your) (design|artwork)/i);
    assert.doesNotMatch(html, /exact text|wording|slogan|concept/i);
  });

  it("analysis step renders only server-authored copy", () => {
    const html = render("review_analysis");

    assert.match(
      html,
      /Your artwork has a solid background that can be removed automatically/,
    );
    assert.match(html, /We&#x27;ll need to enhance it before creating the final print-ready file/);
    assert.match(html, /Remove the Background/);
  });

  it("analysis step offers no destructive action when review is needed", () => {
    const html = render("review_analysis", {
      classification: "NEEDS_REVIEW",
      customer: {
        backgroundMessage:
          "Your background is complex, so we need a different removal method. A designer will take a look before we go any further.",
        resolutionMessage: null,
        canPrepare: false,
        prepareActionLabel: null,
        enhancementNeeded: false,
      },
    });

    assert.match(html, /Your background is complex/);
    assert.doesNotMatch(html, /Remove the Background/);
  });

  it("comparison step labels both images and offers exactly one approval", () => {
    const html = render("compare");

    assert.match(html, /Original/);
    assert.match(html, /Prepared/);
    assert.match(html, /Use Prepared Artwork/);
    assert.match(html, /Keep my original for now/);
    // "Enlarge" is a separate control from approval — viewing never approves.
    assert.match(html, /Enlarge original artwork/);
    assert.match(html, /Enlarge prepared artwork/);
  });

  it("approved + enhancement required is a truthful Phase 1 terminal — not print-ready", () => {
    const approved = render("approved", { approved: true, status: "approved" });

    assert.doesNotMatch(approved, /Your artwork is ready to go/);
    assert.doesNotMatch(approved, /print-ready file is ready|print ready now/i);
    assert.doesNotMatch(approved, /Use Prepared Artwork/);
    assert.doesNotMatch(approved, /Approve|Finalize|Download|Enhance now/i);

    assert.match(approved, /Background preparation complete/);
    assert.match(approved, /removed the background and preserved your artwork/);
    assert.match(
      approved,
      /still needs to be enhanced before we can create the final print-ready file/,
    );
  });

  it("approved without enhancement still claims only final-prep readiness", () => {
    const approved = render("approved", {
      approved: true,
      status: "approved",
      classification: "PRINT_READY_ALREADY",
      customer: {
        backgroundMessage: "Your artwork already has a clear background, so there's nothing to remove.",
        resolutionMessage:
          'Your artwork has enough detail to print 10.5" wide on the full front.',
        canPrepare: false,
        prepareActionLabel: null,
        enhancementNeeded: false,
      },
    });

    assert.doesNotMatch(approved, /Your artwork is ready to go/);
    assert.doesNotMatch(approved, /Use Prepared Artwork/);
    assert.match(approved, /Background preparation complete/);
    assert.match(approved, /ready for final print preparation/);
    assert.doesNotMatch(approved, /still needs to be enhanced/);
  });

  it("persisted approved state reloads into the same truthful terminal copy", () => {
    // Reload identity is the preparation record alone — same inputs the
    // server would re-hydrate after a hard refresh.
    const step = deriveUploadedArtworkStep({
      preparation: preparation({
        approved: true,
        status: "approved",
        hasPreparedArtwork: true,
      }),
      choice: "undecided",
      atProjectStart: false,
    });
    assert.equal(step, "approved");

    const html = render("approved", {
      approved: true,
      status: "approved",
      hasPreparedArtwork: true,
    });
    assert.match(html, /Background preparation complete/);
    assert.match(html, /still needs to be enhanced/);
    assert.doesNotMatch(html, /Use Prepared Artwork/);
  });

  it("shows a loading state rather than a broken image while URLs resolve", () => {
    const html = render("compare", {}, { original: null, prepared: null });
    assert.match(html, /Loading…/);
  });
});

describe("ArtworkComparison", () => {
  it("renders the prepared tile on a transparency checkerboard", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    // The checkerboard proves removed background is genuinely transparent
    // rather than repainted white.
    assert.match(html, /linear-gradient\(45deg/);
    // Whole artwork, never a crop — the customer is checking fidelity.
    assert.match(html, /object-contain/);
    assert.doesNotMatch(html, /object-cover/);
  });

  it("has no approval affordance of its own", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    assert.doesNotMatch(html, /Use Prepared Artwork|Approve|Select/i);
  });
});
