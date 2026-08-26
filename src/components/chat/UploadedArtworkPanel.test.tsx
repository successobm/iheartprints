import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";

import { ArtworkComparison } from "./ArtworkComparison";
import {
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_BACKGROUND_COLORS,
} from "./preview-background";
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
    // The neutral variant. Suites that exercise the review advisory override
    // it; nothing else should depend on its wording.
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

/**
 * Existing Artwork → Print Ready Phase 2: the size view the server computes
 * for an approved upload. Every figure here arrives pre-computed — the panel
 * never derives inches of its own.
 */
function printReadySize(
  overrides: Partial<PrintReadySizeView> = {},
): PrintReadySizeView {
  return {
    widthIn: 10.5,
    heightIn: 10.34,
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
    // Print'em All Phase 1: this fixture describes a CONFIRMED project,
    // because that is the state every pre-existing assertion in this file was
    // written against — an approved upload whose Prepare action is offered.
    // The unconfirmed case is a new, explicit test rather than a silent
    // change of meaning for the existing ones.
    confirmed: true,
    confirmedAt: "2026-08-21T00:00:00.000Z",
    blockingMessage: null,
    garmentSizeOptions: [
      { value: "youth", label: "Youth", isSelected: false },
      { value: "womens_small", label: "Women's / Smaller Garment", isSelected: false },
      { value: "adult_standard", label: "Standard Adult", isSelected: true },
      { value: "adult_plus", label: "2XL–4XL / Larger Garment", isSelected: false },
      { value: "custom", label: "Custom Size", isSelected: false },
    ],
    requiresExplicitWidth: false,
    ...overrides,
  };
}

/**
 * What a customer would actually READ: markup stripped, SSR comment markers
 * removed, entities decoded, whitespace collapsed. Assertions about customer
 * copy belong against this rather than against raw HTML, where Tailwind class
 * names and React's `<!-- -->` text separators both produce false results.
 */
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

function render(
  step: UploadedArtworkStep,
  overrides: Partial<ArtworkPreparationView> = {},
  images: { original?: string | null; prepared?: string | null } = {},
  phase2: {
    printReadySize?: PrintReadySizeView | null;
    finalizationStatus?: CustomerFinalizationStatus;
    busy?: boolean;
  } = {},
) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step,
      preparation: preparation(overrides),
      busy: phase2.busy ?? false,
      printReadySize:
        "printReadySize" in phase2 ? phase2.printReadySize! : printReadySize(),
      finalizationStatus: phase2.finalizationStatus ?? "not_requested",
      onChoosePrintWidth: () => {
        throw new Error("onChoosePrintWidth must never fire from rendering");
      },
      onPrepareForPrint: () => {
        throw new Error("onPrepareForPrint must never fire from rendering");
      },
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

  it("shows pre-upload quality guidance without gating the upload", () => {
    const html = render("upload");
    const text = visibleText(html);

    assert.match(text, /For the best results/);
    assert.match(text, /Transparent PNG/);
    assert.match(text, /white background/i);
    assert.match(text, /whenever possible/i);
    assert.match(text, /colou?red/i);
    assert.match(text, /dark/);
    assert.match(text, /textured/);
    assert.match(text, /complex/);
    assert.match(text, /traces/);
    assert.match(text, /edges/);
    assert.match(text, /iHeartPrints will automatically clean and prepare/);
    assert.match(text, /review it before creating your print-ready file/);

    // Recommended, never required — and transparent is listed first in Best.
    assert.doesNotMatch(text, /\brequired\b/i);
    assert.doesNotMatch(text, /\bmust\b/i);
    assert.match(text, /transparent or solid white background whenever possible/i);
    assert.match(text, /Best: Transparent PNG or white background/);

    // Existing CTA and file acceptance stay the primary action.
    assert.match(html, /Choose a PNG file/);
    assert.match(html, /accept="image\/png"/);
    assert.match(text, /We can work with PNG images right now/);
    assert.doesNotMatch(html, /type="checkbox"/);
    assert.doesNotMatch(html, /role="alert"/);
    assert.doesNotMatch(
      text,
      /alpha|masks?|fringe|matte|tolerance|Phase 1|Magic Select/i,
    );
  });

  it("renders that guidance through the Existing Artwork upload step only", () => {
    const step = deriveUploadedArtworkStep({
      preparation: null,
      choice: "upload_existing",
      atProjectStart: true,
    });
    assert.equal(step, "upload");
    assert.match(visibleText(render("upload")), /For the best results/);

    assert.doesNotMatch(
      visibleText(render("confirm_details", { printPlacement: null })),
      /For the best results/,
    );
    assert.doesNotMatch(visibleText(render("review_analysis")), /For the best results/);
    assert.doesNotMatch(visibleText(render("compare")), /For the best results/);
    assert.doesNotMatch(
      visibleText(render("approved", { approved: true, status: "approved" })),
      /For the best results/,
    );
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
    // No categorical preservation promise for the PREPARED asset.
    assert.match(approved, /removed the background from the artwork you uploaded/);
    assert.doesNotMatch(approved, /preserved your artwork|design itself is unchanged/);
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

/**
 * Existing Artwork → Print Ready Phase 2 (Goals 11/12): the continuation
 * affordance on the approved step.
 */
describe("UploadedArtworkPanel — print-ready continuation", () => {
  const approvedState = {
    approved: true,
    status: "approved" as const,
    hasPreparedArtwork: true,
  };

  it("offers the print-ready action, the size, and an honest enhancement note", () => {
    const text = visibleText(render("approved", approvedState));

    assert.match(text, /Ready for print preparation/);
    assert.match(text, /Prepare Print-Ready Artwork/);
    // Size and resolution, stated in the customer's own units.
    assert.match(text, /10\.5" × 10\.34"/);
    assert.match(text, /300 DPI/);
    assert.match(text, /Full Back/);
    assert.match(text, /Adjust size/);
    const html = render("approved", approvedState);
    // Enhancement is stated as a fact about a later step, with the
    // preservation promise attached.
    assert.match(html, /needs to be enhanced for this print size/);
    assert.match(html, /wording, and colours stay exactly as they are/);
  });

  it("never shows concept-generation or revision affordances", () => {
    const html = render("approved", approvedState);

    assert.doesNotMatch(html, /Use This Design/);
    assert.doesNotMatch(html, /Show Me 3 New Concepts/);
    assert.doesNotMatch(html, /Change Selection/i);
    assert.doesNotMatch(html, /concept/i);
    assert.doesNotMatch(html, /revision/i);
  });

  it("never leaks production internals to the customer", () => {
    // Checked against VISIBLE TEXT, not markup: Tailwind class names are full
    // of things like `px-3.5`, and a check that trips on those would be
    // measuring the stylesheet rather than the copy.
    const text = visibleText(render("approved", approvedState));

    for (const forbidden of [
      /topaz/i,
      /upscal/i,
      /reconstruct/i,
      /provider/i,
      /pixel/i,
      /\bpx\b/i,
      /validat/i,
      /\bjob\b/i,
      /alpha/i,
      /storage/i,
      /finaliz/i,
      /\bDTF\b/,
    ]) {
      assert.doesNotMatch(text, forbidden, `leaked internal term: ${forbidden}`);
    }
  });

  it("omits the enhancement note when the artwork is already large enough", () => {
    const html = render("approved", {
      ...approvedState,
      customer: {
        backgroundMessage: "Your artwork already has a clear background.",
        resolutionMessage: null,
        canPrepare: false,
        prepareActionLabel: null,
        enhancementNeeded: false,
      },
    });

    assert.match(html, /Prepare Print-Ready Artwork/);
    assert.doesNotMatch(html, /needs to be enhanced for this print size/);
  });

  it("replaces the action with the shared waiting copy while production runs", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "preparing",
    });

    assert.match(html, /Preparing your print-ready artwork/);
    assert.match(html, /about 3–4 minutes/);
    assert.doesNotMatch(html, /Prepare Print-Ready Artwork/);
    // Size is not changeable once production has started.
    assert.doesNotMatch(html, /Adjust size/);
  });

  it("states an honest needs-attention message, and offers a retry, on failure", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "needs_review",
    });

    assert.match(html, /needs attention before we can finish/);
    assert.match(html, /uploaded artwork and the prepared version are both safe/);
    assert.match(html, /Try Again/);
    assert.doesNotMatch(html, /Retry Preparation/);
    assert.doesNotMatch(html, /is ready|print-ready file is ready/i);
  });

  it("retryable_failure shows Retry Preparation and not the preparing spinner", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "retryable_failure",
    });

    assert.match(html, /Print-ready preparation couldn/);
    assert.match(html, /Retry Preparation/);
    assert.match(html, /type="button"/);
    assert.doesNotMatch(html, /Preparing your print-ready artwork/);
    assert.doesNotMatch(html, /Try Again/);
    assert.doesNotMatch(
      html,
      /topaz|supabase|fetch failed|provider|job id|system error/i,
    );
  });

  it("retryable_failure pending request disables duplicate Retry clicks", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "retryable_failure",
      busy: true,
    });

    assert.match(html, /Retry Preparation/);
    assert.match(html, /disabled/);
    assert.match(html, /aria-busy="true"/);
  });

  it("keeps the size control but drops the primary action once artwork is print-ready", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "print_ready",
    });

    // The delivery card owns the "it's ready" message; this panel must not
    // compete with it.
    assert.doesNotMatch(html, /Prepare Print-Ready Artwork/);
    assert.doesNotMatch(html, /Ready for print preparation/);
    // But the only route an upload customer has to a different size stays.
    assert.match(html, /Adjust size/);
  });

  it("says nothing about size when there is nothing honest to say", () => {
    const html = render("approved", approvedState, {}, { printReadySize: null });

    assert.doesNotMatch(html, /Adjust size/);
    assert.doesNotMatch(html, /300 DPI/);
    assert.match(html, /Prepare Print-Ready Artwork/);
  });
});

describe("ArtworkComparison", () => {
  it("O/P: exposes prepared Preview Background inspection control", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    assert.match(html, /Preview Background/);
    assert.match(html, /data-preview-background-option="white"/);
    assert.match(html, /data-preview-background-option="gray"/);
    assert.match(html, /data-preview-background-option="black"/);
    assert.match(html, new RegExp(
      `data-comparison-surface="prepared"[^>]*data-preview-background="${DEFAULT_PREVIEW_BACKGROUND}"` +
        `|data-preview-background="${DEFAULT_PREVIEW_BACKGROUND}"[^>]*data-comparison-surface="prepared"`,
    ));
    assert.match(html, new RegExp(PREVIEW_BACKGROUND_COLORS[DEFAULT_PREVIEW_BACKGROUND]));
    assert.match(html, /object-contain/);
    assert.doesNotMatch(html, /object-cover/);
  });

  it("S: helper copy exists for background inspection", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    assert.match(
      html,
      /Check your artwork on different backgrounds before approving it/,
    );
  });

  it("T: original and prepared asset identities remain distinct URLs", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    assert.match(html, /src="https:\/\/signed\.example\/original\.png"/);
    assert.match(html, /src="https:\/\/signed\.example\/prepared\.png"/);
    assert.match(html, /Shown as uploaded/);
    assert.match(html, /Inspection background:/);
  });

  it("Q: has no approval affordance of its own", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    assert.doesNotMatch(html, /Use Prepared Artwork/);
    assert.doesNotMatch(html, />Approve</i);
    assert.doesNotMatch(html, />Select</i);
  });

  it("keeps compare tiles read-only — cleanup is not on the small preview", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
      }),
    );

    // Phase 1.4: the canonical cleanup path is the large workspace, not an
    // inline clickable tile. Enlarge remains available for view-only inspect.
    assert.doesNotMatch(html, /Click background to preview removing it/);
    assert.doesNotMatch(html, /cursor-crosshair/);
    assert.match(html, /Enlarge original artwork/);
    assert.match(html, /Enlarge prepared artwork/);
  });
});

/**
 * Phase 27E UX correction: the doorway into artwork repair. Replaces the
 * old "guided background cleanup" describe block — that mechanism
 * (`GuidedCleanupWorkspace`, single-click background-only removal) is no
 * longer reachable from this screen; "Fix My Artwork" opens the frozen
 * Phase 27E Magic Wand correction workspace instead, which handles BOTH
 * missing artwork and leftover background. See the Phase 27E-UX-correction
 * report for why the entry point moved out of `SeparationReviewPanel` and
 * into `CompareStep` itself (reachability, not cosmetics).
 */
describe("UploadedArtworkPanel — the artwork-repair doorway (Phase 27E UX correction)", () => {
  function render(overrides: Partial<ArtworkPreparationView> = {}) {
    return renderToString(
      createElement(UploadedArtworkPanel, {
        projectId: "test-project-id",
        step: "compare" as UploadedArtworkStep,
        preparation: preparation(overrides),
        busy: false,
        originalImageUrl: "https://signed.example/original.png",
        preparedImageUrl: "https://signed.example/prepared.png",
        onUpload: () => {},
        onSaveDetails: () => {},
        onPrepare: () => {},
        onApprove: () => {},
        onReconsider: () => {},
      }),
    );
  }

  it("1/10: states the primary heading, exactly", () => {
    const html = render();
    assert.match(html, /Review your artwork before continuing/);
  });

  it("2: supporting copy accounts for BOTH missing artwork and leftover background, in one neutral sentence", () => {
    const html = render();
    // Not "brittle to every word" -- but it must mention comparing against
    // the original, and it must not commit to only one failure direction.
    assert.match(html, /compare the prepared version with your original/i);
    assert.match(html, /still there/i); // covers "artwork went missing"
    assert.match(html, /background remains/i); // covers "background left behind"
  });

  it("3/4/12: 'Fix My Artwork' is present; the misleading 'Clean Up Background' doorway is gone", () => {
    const html = render();

    assert.match(html, /Fix My Artwork/);
    assert.match(html, /data-action="fix-my-artwork"/);
    assert.doesNotMatch(html, /Clean Up Background/);
    assert.doesNotMatch(html, /Still see some background/i);
    assert.doesNotMatch(html, /remove any areas we missed/i);
    assert.doesNotMatch(html, /This Isn.t Right/i);
    // Constitution §6.6: none of the machinery may surface.
    assert.doesNotMatch(
      html,
      /cavity|connected component|flood fill|tolerance|alpha|inradius|wall ratio|mask|candidate region/i,
    );
  });

  it("13: helper copy under Fix My Artwork names BOTH repair directions", () => {
    const html = render();
    assert.match(html, /Something doesn.t look right/);
    assert.match(html, /restore missing parts of your design/i);
    assert.match(html, /remove background that was left behind/i);
  });

  it("8/14: 'Use Prepared Artwork' remains available under its own 'Looks good?' heading", () => {
    const html = render();

    assert.match(html, /Looks good\?/);
    assert.match(html, /Use Prepared Artwork/);
    assert.match(html, /Keep my original for now/);
    assert.match(html, /Enlarge/);
  });

  it("Q/R/S: approval safety copy stays separate from Preview Background", () => {
    const html = render();

    assert.match(html, /Preview Background/);
    assert.match(html, /Use Prepared Artwork/);
    assert.match(html, /data-approval-safety-copy/);
  });

  it("K: original safety wording appears both on the tile and near the doorway", () => {
    const html = render();

    assert.match(html, /The artwork you uploaded, untouched\./);
    assert.match(html, /Your original upload is saved and unchanged\./);
  });

  it("6/17/18: Original/Prepared stays prominent with White/Gray/Black inspection, not buried under copy", () => {
    const html = render();

    assert.match(html, /Original/);
    assert.match(html, /Prepared/);
    assert.match(html, /data-preview-background-option="white"/);
    assert.match(html, /data-preview-background-option="gray"/);
    assert.match(html, /data-preview-background-option="black"/);
  });

  it("9/15: resolution enhancement is a separate, informational block, phrased distinctly from artwork repair", () => {
    const html = render({
      customer: {
        backgroundMessage: "Your artwork has a solid background that can be removed automatically.",
        resolutionMessage:
          'Your artwork is smaller than the recommended print resolution for a 10.5"-wide print on the full front. We\'ll need to enhance it before creating the final print-ready file.',
        canPrepare: true,
        prepareActionLabel: "Remove the Background",
        enhancementNeeded: true,
      },
    });

    assert.match(html, /data-resolution-notice/);
    assert.match(html, /Resolution enhancement needed/);
    assert.match(html, /We&#x27;ll need to enhance it/);
    // It must sit in its own block, AFTER the primary compare/repair
    // decision area (Section 9) — not nested inside the Fix My Artwork
    // card, and not phrased as another repair failure.
    const fixCardMatch = html.match(/data-action="fix-my-artwork"[^]*?<\/div>/);
    assert.ok(fixCardMatch, "Fix My Artwork card must exist");
    assert.doesNotMatch(fixCardMatch![0], /Resolution enhancement needed/, "resolution notice must not be nested inside the Fix My Artwork card");
    const fixIndex = html.indexOf('data-action="fix-my-artwork"');
    const resolutionIndex = html.indexOf("data-resolution-notice");
    assert.ok(resolutionIndex > fixIndex, "resolution notice must come after the primary repair decision area");
  });

  it("resolution notice is absent when enhancement is not needed", () => {
    const html = render({
      customer: {
        backgroundMessage: "Your artwork already has a clear background.",
        resolutionMessage: null,
        canPrepare: false,
        prepareActionLabel: null,
        enhancementNeeded: false,
      },
    });
    assert.doesNotMatch(html, /data-resolution-notice/);
    assert.doesNotMatch(html, /Resolution enhancement needed/);
  });

  it("11: no provider/algorithm vocabulary leaks into this screen", () => {
    const html = render();
    for (const forbidden of [
      /topaz/i,
      /openai/i,
      /stripe/i,
      /Prepare for Print/i,
      /Finalize/i,
      /\btreatment\b/i,
      /provider/i,
      /flood.?fill/i,
      /connectivity/i,
      /tolerance/i,
    ]) {
      assert.doesNotMatch(html, forbidden, `leaked term: ${forbidden}`);
    }
  });

  it("is not an image editor by itself — the workspace only opens on demand", () => {
    const html = render();
    assert.doesNotMatch(html, /brush|lasso|eraser|freehand|layer|opacity slider/i);
    // The workspace's own canvas must not be present before Fix My Artwork is clicked.
    assert.doesNotMatch(html, /data-correction-canvas/);
  });

  it("does not imply automatic preparation succeeded perfectly, nor that it definitely failed", () => {
    const html = render();
    for (const overclaim of [/perfect/i, /flawless/i, /failed/i, /broken/i, /damaged/i, /ruined/i]) {
      assert.doesNotMatch(html, overclaim);
    }
  });
});

/**
 * Phase 27E UX correction, item 5: "Fix My Artwork" must open the EXACT
 * correction workspace already built in Phase 27E — same component, same
 * frozen controls (Restore Missing Artwork / Remove Background / zoom /
 * pan / Undo / Start Over / Done Editing), reached with no algorithm
 * change and no new route. `renderToString` cannot execute the `onClick`
 * that flips local state (no browser event loop), so this is proven at
 * the SOURCE level: the button's handler and the workspace's own contract
 * are both asserted directly, which is exactly how this repo's other
 * client-state doorways are proven (see `separation-review-workspace-shape.test.ts`).
 */
describe("Fix My Artwork routing (Phase 27E UX correction)", () => {
  const PANEL_SOURCE = readFileSync(path.join(__dirname, "UploadedArtworkPanel.tsx"), "utf8");
  const WORKSPACE_SOURCE = readFileSync(path.join(__dirname, "CorrectionWorkspace.tsx"), "utf8");

  it("19: CompareStep's Fix My Artwork button sets correctionMode to 'editing', which renders CorrectionWorkspace", () => {
    // The button and its onClick are adjacent JSX attributes on the same
    // element -- match them as one block rather than assuming an exact
    // attribute order.
    const buttonBlock = PANEL_SOURCE.match(/<button[^>]*data-action="fix-my-artwork"[^>]*>/) ?? PANEL_SOURCE.match(/<button[\s\S]*?data-action="fix-my-artwork"/);
    assert.ok(buttonBlock, "Fix My Artwork button must exist");
    assert.match(PANEL_SOURCE, /onClick=\{\(\)\s*=>\s*setCorrectionMode\("editing"\)\}/);
    assert.match(PANEL_SOURCE, /correctionMode === "editing"/);
    assert.match(PANEL_SOURCE, /<CorrectionWorkspace/);
    assert.match(PANEL_SOURCE, /<CorrectionFinalReview/);
  });

  it("no new correction route or algorithm import was introduced by this UX pass", () => {
    assert.doesNotMatch(PANEL_SOURCE, /magic-wand-algorithm/);
    assert.doesNotMatch(PANEL_SOURCE, /floodFillSelect|unionMasks|filterClicksContaining/);
    // The panel only imports the already-built, frozen components.
    assert.match(PANEL_SOURCE, /from "\.\/CorrectionWorkspace"/);
    assert.match(PANEL_SOURCE, /from "\.\/CorrectionFinalReview"/);
  });

  it("20/21: the workspace CorrectionWorkspace opens still exposes Restore Missing Artwork and Remove Background", () => {
    assert.match(WORKSPACE_SOURCE, /data-mode="restore"/);
    assert.match(WORKSPACE_SOURCE, /data-mode="remove"/);
    assert.match(WORKSPACE_SOURCE, />Restore Missing Artwork</);
    assert.match(WORKSPACE_SOURCE, />Remove Background</);
  });

  it("all other Phase 27D/27E controls remain present in the frozen workspace", () => {
    for (const control of [
      /data-action="zoom-fit"/,
      /data-action="zoom-in"/,
      /data-action="zoom-out"/,
      /data-action="zoom-100"/,
      /data-pan-toggle/,
      /data-action="undo-correction"/,
      /data-action="start-over"/,
      /data-action="done-editing"/,
    ]) {
      assert.match(WORKSPACE_SOURCE, control);
    }
  });
});
