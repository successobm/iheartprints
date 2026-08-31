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

/**
 * LIVE PRODUCT BLOCKER #1: the routing question and the Sign path's own
 * two steps. A dedicated helper rather than reusing `render()` above — the
 * two new callbacks (`onChooseArtworkType`, `onConfirmSignSize`) and
 * `signArtwork` are specific to these three steps and every existing
 * `render()` call site would otherwise need to pass throw-on-call stubs
 * for callbacks that step never uses.
 */
function renderSignStep(
  step: Extract<
    UploadedArtworkStep,
    "choose_artwork_type" | "confirm_sign_size" | "sign_context_saved"
  >,
  signArtwork: { orderedWidthIn: number | null; orderedHeightIn: number | null; specConfirmed: boolean } | null = null,
) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step,
      preparation: preparation({ printPlacement: null }),
      busy: false,
      originalImageUrl: null,
      preparedImageUrl: null,
      signArtwork,
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
      onChooseArtworkType: () => {
        throw new Error("onChooseArtworkType must never fire from rendering");
      },
      onConfirmSignSize: () => {
        throw new Error("onConfirmSignSize must never fire from rendering");
      },
    }),
  );
}

describe("Sign artwork type routing (LIVE PRODUCT BLOCKER #1)", () => {
  it("the routing question stands alone — no apparel field anywhere near it", () => {
    const html = renderSignStep("choose_artwork_type");
    const text = visibleText(html);

    assert.match(text, /What are we printing today\?/);
    assert.match(html, /DTF \/ Apparel/);
    assert.match(html, /Sign/);
    assert.doesNotMatch(html, /Garment colour/i);
    assert.doesNotMatch(html, /Full Front|Full Back|Left Chest|Sleeve/);
    // No internal engine vocabulary, and no substrate question — that
    // belongs to physical ordering, not artwork preparation.
    assert.doesNotMatch(
      text,
      /rigid_sign_raster|banner|coroplast|aluminum|PVC|substrate/i,
    );
  });

  it("the sign-size step asks only width and height — never garment colour or placement", () => {
    const html = renderSignStep("confirm_sign_size");

    assert.match(html, /Width/i);
    assert.match(html, /Height/i);
    assert.match(html, /inches/i);
    assert.doesNotMatch(html, /Garment colour/i);
    assert.doesNotMatch(html, /Where should this print/i);
    assert.doesNotMatch(html, /Full Front|Full Back|Left Chest|Sleeve/);
    assert.doesNotMatch(html, /rigid_sign_raster|banner|coroplast|aluminum|PVC/i);
  });

  it("the sign-size step re-populates a previously entered size on reload", () => {
    const html = renderSignStep("confirm_sign_size", {
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      specConfirmed: false,
    });
    assert.match(html, /value="24"/);
    assert.match(html, /value="36"/);
  });

  it("the saved step echoes the confirmed size and claims nothing about print readiness", () => {
    const html = renderSignStep("sign_context_saved", {
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      specConfirmed: true,
    });
    const text = visibleText(html);

    assert.match(text, /24" × 36"/);
    assert.doesNotMatch(text, /print[- ]ready/i);
    assert.doesNotMatch(text, /approve|finalize|download/i);
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
      signArtwork: null,
      choice: "upload_existing",
      artworkTypeChoice: "undecided",
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

  it("Phase 28G Defect A: the FIRST comparison-step render fails closed — no images, no approval yet, only the review-loading state and the always-available exit/edit doorways", () => {
    // `separationState` now starts at `"checking"` specifically so this
    // render can never show an approval-capable review before the system
    // has established which one is authoritative -- see
    // `uploaded-artwork-single-review.test.tsx` for the full Phase 28G
    // Defect A suite this mirrors, and for the source-level proof that
    // Original/Prepared/"Use This Artwork" DO render once separation
    // status resolves to "no gate required".
    const html = render("compare");

    assert.match(html, /data-review-loading-state/);
    assert.doesNotMatch(html, /Use This Artwork/);
    assert.doesNotMatch(html, /Enlarge original artwork/);
    assert.doesNotMatch(html, /Enlarge prepared artwork/);
    assert.match(html, /Keep my original for now/);
    assert.match(html, /Edit Artwork/);
  });

  it("approved + enhancement required is a truthful Phase 1 terminal — not print-ready", () => {
    const approved = render("approved", { approved: true, status: "approved" });

    assert.doesNotMatch(approved, /Your artwork is ready to go/);
    assert.doesNotMatch(approved, /print-ready file is ready|print ready now/i);
    assert.doesNotMatch(approved, /Use This Artwork/);
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
    assert.doesNotMatch(approved, /Use This Artwork/);
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
      signArtwork: null,
      choice: "undecided",
      artworkTypeChoice: "undecided",
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
    assert.doesNotMatch(html, /Use This Artwork/);
  });

  it("shows a loading state rather than a broken image while URLs resolve", () => {
    // `ArtworkComparison` itself owns this behavior, and is only ever
    // mounted by `CompareStep` once separation status resolves to "no gate
    // required" (Phase 28G Defect A) -- exercised directly here, exactly
    // as the dedicated "ArtworkComparison" describe block below already
    // does for its other behaviors.
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: null, loading: true },
        prepared: { url: null, loading: true },
      }),
    );
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
    assert.match(text, /Create Print-Ready Artwork/);
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

    assert.match(html, /Create Print-Ready Artwork/);
    assert.doesNotMatch(html, /needs to be enhanced for this print size/);
  });

  it("replaces the action with the shared waiting copy while production runs", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "preparing",
    });

    assert.match(html, /Creating your print-ready artwork/);
    assert.match(html, /about 3–4 minutes/);
    assert.doesNotMatch(html, /Create Print-Ready Artwork/);
    // Size is not changeable once production has started.
    assert.doesNotMatch(html, /Adjust size/);
  });

  it("states an honest needs-attention message, without a misleading 'Try Again', on failure", () => {
    // Phase 28H Section 7/O: `needs_review` is Standard Raster's
    // deterministic `finalization_required` -- a plain retry recomputes the
    // identical verdict, so this button no longer calls itself "Try Again"
    // (that framing is now reserved for `retryable_failure`, a genuine
    // infrastructure hiccup where retrying might actually help). The
    // fallback banner itself (shown here because no `printReadyPackage` is
    // passed -- see the Phase 28H suite in
    // `uploaded-artwork-print-ready-flow.test.tsx` for the package-present
    // case) is unchanged.
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "needs_review",
    });

    assert.match(html, /needs attention before we can finish/);
    assert.match(html, /uploaded artwork and the prepared version are both safe/);
    assert.doesNotMatch(html, /Try Again/);
    assert.match(html, /Create Print-Ready Artwork/);
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
    assert.doesNotMatch(html, /Creating your print-ready artwork/);
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
    assert.doesNotMatch(html, /Create Print-Ready Artwork/);
    assert.doesNotMatch(html, /Ready for print preparation/);
    // But the only route an upload customer has to a different size stays.
    assert.match(html, /Adjust size/);
  });

  it("says nothing about size when there is nothing honest to say", () => {
    const html = render("approved", approvedState, {}, { printReadySize: null });

    assert.doesNotMatch(html, /Adjust size/);
    assert.doesNotMatch(html, /300 DPI/);
    assert.match(html, /Create Print-Ready Artwork/);
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

    assert.doesNotMatch(html, /Use This Artwork/);
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
 * longer reachable from this screen; the manual fallback doorway opens the
 * frozen Phase 27E Magic Wand correction workspace instead, which handles
 * BOTH missing artwork and leftover background. See the Phase 27E-UX-correction
 * report for why the entry point moved out of `SeparationReviewPanel` and
 * into `CompareStep` itself (reachability, not cosmetics).
 *
 * Phase 27G renamed the doorway from "Fix My Artwork" to "Remove Background
 * Manually" — the old label wrongly implied automatic preparation hadn't
 * already been an attempt at "fixing." The doorway now also makes explicit
 * that the manual tool starts over from the original upload, not from
 * repairing whatever automatic preparation produced.
 */
describe("UploadedArtworkPanel — the artwork-repair doorway (Phase 27E UX correction, Phase 27G renamed)", () => {
  // Phase 28G Defect A: several assertions below describe content that
  // only renders once separation status resolves to "no gate required" —
  // unreachable from a single `renderToString` call now that the very
  // first render is the review-loading state (see that section's own
  // dedicated suite). Those are proven at the source level instead, the
  // same pattern the "Edit Artwork routing" describe block below already
  // uses for its own effect-driven assertions.
  const PANEL_SOURCE = readFileSync(path.join(__dirname, "UploadedArtworkPanel.tsx"), "utf8");

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
    // Phase 28G Defect A: this heading only renders once separation status
    // resolves to "no gate required" -- the very first render is the
    // review-loading state instead (its own, differently-worded heading;
    // see the Phase 28G Defect A suite in
    // `uploaded-artwork-single-review.test.tsx`). Proven at the source
    // level here, exactly the same way this file already proves other
    // resolved-only content (e.g. "Edit Artwork routing" below).
    assert.match(PANEL_SOURCE, /Review your artwork</);
  });

  it("2: supporting copy accounts for BOTH missing artwork and leftover background, in one neutral sentence", () => {
    // Not "brittle to every word" -- but it must mention comparing against
    // the original, and it must not commit to only one failure direction.
    // Source-level for the same reason as "1/10" above.
    assert.match(PANEL_SOURCE, /compare the prepared version with your original/i);
    assert.match(PANEL_SOURCE, /still there/i); // covers "artwork went missing"
    assert.match(PANEL_SOURCE, /background remains/i); // covers "background left behind"
  });

  it("3/4/12/A/B: 'Edit Artwork' is present (Phase 28F; was 'Remove Background Manually'); every stale doorway label is gone", () => {
    const html = render();

    assert.match(html, /Edit Artwork/);
    // The internal data-action hook is a stable test/analytics id, kept
    // unchanged across the Phase 28F customer-facing rename — see
    // Phase 28E's identical precedent for `data-proposal-action`.
    assert.match(html, /data-action="remove-background-manually"/);
    assert.doesNotMatch(html, /Fix My Artwork/);
    assert.doesNotMatch(html, /data-action="fix-my-artwork"/);
    assert.doesNotMatch(html, /Clean Up Background/);
    assert.doesNotMatch(html, /Still see some background/i);
    assert.doesNotMatch(html, /remove any areas we missed/i);
    assert.doesNotMatch(html, /This Isn.t Right/i);
    assert.doesNotMatch(html, /Background Repair/i);
    assert.doesNotMatch(html, />Remove Background Manually</);
    // Constitution §6.6: none of the machinery may surface.
    assert.doesNotMatch(
      html,
      /cavity|connected component|flood fill|tolerance|alpha|inradius|wall ratio|mask|candidate region/i,
    );
  });

  it("13: helper copy under the Edit Artwork doorway explains the toolbox in plain language", () => {
    const html = render();
    assert.match(html, /Want to make changes\?/);
    assert.match(html, /select what to keep, clean up what shouldn&#x27;t be there/i);
  });

  it("8/14: 'Use This Artwork' (Phase 28F; was 'Use Prepared Artwork') remains available under its own 'Looks good?' heading", () => {
    const html = render();
    // Both are gated behind the same "resolved, no gate" condition (Phase
    // 28G Defect A) -- not renderable from one `renderToString` call, so
    // proven at the source level; "Keep my original for now" has no such
    // gate and is proven directly against the live render.
    assert.match(PANEL_SOURCE, /Looks good\?/);
    assert.match(PANEL_SOURCE, /Use This Artwork/);
    assert.match(PANEL_SOURCE, /<ArtworkComparison\b/); // renders "Enlarge" once mounted -- see the ArtworkComparison describe block for direct proof
    assert.match(html, /Keep my original for now/);
  });

  it("Q/R/S: approval safety copy stays separate from Preview Background", () => {
    // Both only render once resolved to "no gate required" (Preview
    // Background lives inside `ArtworkComparison`, only mounted then) --
    // proven at the source level that both exist and are distinct blocks.
    assert.match(PANEL_SOURCE, /<ArtworkComparison/); // renders "Preview Background" once mounted -- see the ArtworkComparison describe block for direct proof
    assert.match(PANEL_SOURCE, /Use This Artwork/);
    assert.match(PANEL_SOURCE, /data-approval-safety-copy/);
  });

  it("K: original safety wording appears both on the tile and near the doorway", () => {
    const html = render();
    // The tile's own "untouched" caption lives inside `ArtworkComparison`,
    // only mounted once resolved to "no gate required" -- proven directly
    // against that component (see the ArtworkComparison describe block),
    // referenced here at the source level.
    assert.match(PANEL_SOURCE, /<ArtworkComparison/);
    const artworkComparisonSource = readFileSync(path.join(__dirname, "ArtworkComparison.tsx"), "utf8");
    assert.match(artworkComparisonSource, /The artwork you uploaded, untouched\./);
    // The doorway-adjacent copy has no such gate and IS present on the
    // very first render.
    assert.match(html, /Your original upload is saved and unchanged\./);
  });

  it("6/17/18: Original/Prepared stays prominent with White/Gray/Black inspection, not buried under copy", () => {
    // `ArtworkComparison` (mounted only once resolved to "no gate
    // required" -- Phase 28G Defect A) owns Original/Prepared and the
    // White/Gray/Black inspection controls; proven directly against that
    // component in the "ArtworkComparison" describe block below. Here we
    // only need to confirm `CompareStep` actually mounts it in the
    // resolved, no-gate case.
    assert.match(PANEL_SOURCE, /<ArtworkComparison\b/);
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
    // decision area (Section 9) — not nested inside the Edit Artwork card,
    // and not phrased as another repair failure.
    const fixCardMatch = html.match(/data-action="remove-background-manually"[^]*?<\/div>/);
    assert.ok(fixCardMatch, "Edit Artwork card must exist");
    assert.doesNotMatch(
      fixCardMatch![0],
      /Resolution enhancement needed/,
      "resolution notice must not be nested inside the Edit Artwork card",
    );
    const fixIndex = html.indexOf('data-action="remove-background-manually"');
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
    // The workspace's own canvas must not be present before Remove Background
    // Manually is clicked.
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
 * Phase 27E UX correction, item 5 (renamed by Phase 27G, then Phase 28F to
 * "Edit Artwork"): the doorway must open the EXACT correction workspace already built in Phase
 * 27E — same component, same frozen controls (Restore Missing Artwork /
 * Remove Background / zoom / pan / Undo / Start Over / Done Editing),
 * reached with no algorithm change and no new route. `renderToString`
 * cannot execute the `onClick` that flips local state (no browser event
 * loop), so this is proven at the SOURCE level: the button's handler and
 * the workspace's own contract are both asserted directly, which is
 * exactly how this repo's other client-state doorways are proven (see
 * `separation-review-workspace-shape.test.ts`).
 */
describe("Edit Artwork routing (Phase 27E UX correction, Phase 27G/28F renamed)", () => {
  const PANEL_SOURCE = readFileSync(path.join(__dirname, "UploadedArtworkPanel.tsx"), "utf8");
  const WORKSPACE_SOURCE = readFileSync(path.join(__dirname, "CorrectionWorkspace.tsx"), "utf8");

  it("19: CompareStep's Edit Artwork button sets correctionMode to 'editing', which renders CorrectionWorkspace", () => {
    // The button and its onClick are adjacent JSX attributes on the same
    // element -- match them as one block rather than assuming an exact
    // attribute order.
    const buttonBlock =
      PANEL_SOURCE.match(/<button[^>]*data-action="remove-background-manually"[^>]*>/) ??
      PANEL_SOURCE.match(/<button[\s\S]*?data-action="remove-background-manually"/);
    assert.ok(buttonBlock, "Edit Artwork button must exist");
    assert.match(PANEL_SOURCE, /onClick=\{\(\)\s*=>\s*setCorrectionMode\("editing"\)\}/);
    assert.match(PANEL_SOURCE, /correctionMode === "editing"/);
    assert.match(PANEL_SOURCE, /<CorrectionWorkspace/);
    assert.match(PANEL_SOURCE, /<CorrectionFinalReview/);
  });

  it("L: Use This Artwork calls onApprove directly and is not gated behind correctionMode/editing (automatic-success path never requires opening the manual workspace)", () => {
    // "Use This Artwork" must be wired to onApprove as a plain,
    // top-level button -- not conditioned on correctionMode === "editing"
    // or on CorrectionWorkspace/CorrectionFinalReview having rendered.
    // This is what proves Phase 27G's automatic-success regression
    // requirement: the short path (upload -> automatic prep -> review ->
    // Use This Artwork) never forces a detour through Magic Wand.
    const useButtonBlock = PANEL_SOURCE.match(/onClick=\{onApprove\}[\s\S]{0,400}Use This Artwork/);
    assert.ok(useButtonBlock, "Use This Artwork must call onApprove directly");
  });

  it("no new correction route or algorithm import was introduced by this UX pass", () => {
    assert.doesNotMatch(PANEL_SOURCE, /magic-wand-algorithm/);
    assert.doesNotMatch(PANEL_SOURCE, /floodFillSelect|unionMasks|filterClicksContaining/);
    // The panel only imports the already-built, frozen components.
    assert.match(PANEL_SOURCE, /from "\.\/CorrectionWorkspace"/);
    assert.match(PANEL_SOURCE, /from "\.\/CorrectionFinalReview"/);
  });

  it("20/21: the workspace CorrectionWorkspace opens still exposes Restore Missing Artwork and Remove Background as Wand's own sub-mode (Phase 27I toolbar)", () => {
    assert.match(WORKSPACE_SOURCE, /data-mode="restore"/);
    assert.match(WORKSPACE_SOURCE, /data-mode="remove"/);
    assert.match(WORKSPACE_SOURCE, />Restore Missing Artwork</);
    assert.match(WORKSPACE_SOURCE, />Remove Background</);
  });

  it("E: CorrectionWorkspace's default mode is 'remove', not 'restore' (Phase 27G), and its default TOOL is the Wand (Phase 27I)", () => {
    assert.match(WORKSPACE_SOURCE, /useState<WandMode>\("remove"\)/);
    assert.match(WORKSPACE_SOURCE, /useState<Tool>\("magic_wand"\)/);
  });

  it("5: Remove Background is the primary/first Wand-mode button, Restore Missing Artwork is secondary (Phase 27G)", () => {
    const removeIndex = WORKSPACE_SOURCE.indexOf('data-mode="remove"');
    const restoreIndex = WORKSPACE_SOURCE.indexOf('data-mode="restore"');
    assert.ok(removeIndex >= 0 && restoreIndex >= 0, "both mode buttons must exist");
    assert.ok(removeIndex < restoreIndex, "Remove Background must render before Restore Missing Artwork");
  });

  it("Phase 27I: the toolbar exposes Wand/Fill/Brush/Eraser, with Wand first/default", () => {
    assert.match(WORKSPACE_SOURCE, /data-tool=\{t\.tool\}/, "the toolbar must render one button per TOOLS entry with a data-tool attribute");
    assert.match(WORKSPACE_SOURCE, /tool:\s*"magic_wand"/);
    assert.match(WORKSPACE_SOURCE, /tool:\s*"restore_fill"/);
    assert.match(WORKSPACE_SOURCE, /tool:\s*"restore_brush"/);
    assert.match(WORKSPACE_SOURCE, /tool:\s*"erase_brush"/);
    const wandIndex = WORKSPACE_SOURCE.indexOf('tool: "magic_wand"');
    const fillIndex = WORKSPACE_SOURCE.indexOf('tool: "restore_fill"');
    assert.ok(wandIndex >= 0 && fillIndex >= 0 && wandIndex < fillIndex, "Wand must be listed first in the toolbar");
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
