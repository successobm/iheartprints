import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation/artwork-preparation-capability";
import {
  bowlingStyleArtwork,
  solidBlackExteriorArtwork,
  toPngBytes,
} from "@/capabilities/artwork-preparation/artwork-fixtures";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

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

describe("UploadedArtworkPanel — guided background cleanup", () => {
  function render(
    overrides: Partial<ArtworkPreparationView> = {},
    props: Record<string, unknown> = {},
  ) {
    return renderToString(
      createElement(UploadedArtworkPanel, {
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
        onCleanupPoint: () => {},
        onUndoCleanup: () => {},
        ...props,
      }),
    );
  }

  it("exposes an obvious Clean Up Background action", () => {
    const html = render();

    assert.match(html, /Still see some background/i);
    assert.match(html, /Clean Up Background to remove any areas we missed/i);
    assert.match(html, /Clean Up Background/);
    // Constitution §6.6: none of the machinery may surface.
    assert.doesNotMatch(
      html,
      /cavity|connected component|flood fill|tolerance|alpha|inradius|wall ratio|mask|candidate region/i,
    );
  });

  it("keeps Use Prepared Artwork as a separate approval action", () => {
    const html = render();

    assert.match(html, /Clean Up Background/);
    assert.match(html, /Use Prepared Artwork/);
    assert.match(html, /Keep my original for now/);
    assert.match(html, /Enlarge/);
  });

  it("Q/R/S: approval safety copy stays separate from Preview Background", () => {
    const html = render();

    assert.match(html, /Preview Background/);
    assert.match(
      html,
      /Make sure all parts of your design are still there and the background looks clean/,
    );
    assert.match(html, /Try White to spot dark background residue/);
    assert.match(html, /Use Prepared Artwork/);
    // Background control is not an approve action.
    assert.match(html, /data-approval-safety-copy/);
  });

  it("offers Undo on compare once something has been removed", () => {
    assert.doesNotMatch(render({ guidedCleanup: { available: true, removalCount: 0 } }), /Undo Last Removal/);
    assert.match(render({ guidedCleanup: { available: true, removalCount: 2 } }), /Undo Last Removal/);
  });

  it("says nothing about cleanup when the server has not offered it", () => {
    const html = render({ guidedCleanup: { available: false, removalCount: 0 } });

    assert.doesNotMatch(html, /Clean Up Background/);
    assert.doesNotMatch(html, /Still see some background/i);
    // The rest of the compare step is untouched.
    assert.match(html, /Use Prepared Artwork/);
  });

  it("renders the server's refusal verbatim on compare", () => {
    // The single most important sentence in the flow. It is authored on the
    // server and rendered as-is, so the panel can never soften or invent it.
    const html = render(
      {},
      {
        cleanupMessage:
          "That area looks like part of the artwork, so we left it unchanged.",
      },
    );

    assert.match(html, /That area looks like part of the artwork, so we left it unchanged\./);
  });

  it("does not put confirm controls on the compare strip before the workspace opens", () => {
    // Pending highlight + confirm live inside GuidedCleanupWorkspace. Compare
    // only advertises Clean Up Background so customers are not asked to
    // confirm on a tiny tile they never clicked.
    const html = render(
      {},
      {
        cleanupPreviewHighlight: {
          bounds: { left: 10, top: 10, right: 20, bottom: 20, width: 10, height: 10 },
          overlayDataUrl: "data:image/png;base64,abc",
        },
        onConfirmCleanup: () => {},
        onCancelCleanupPreview: () => {},
      },
    );

    assert.match(html, /Clean Up Background/);
    assert.doesNotMatch(html, />Remove This Area</);
    assert.match(html, /Use Prepared Artwork/);
  });

  it("carries an opaque preparedRevision on the compare preparation view", () => {
    const html = render({ preparedRevision: "rev-after-d" });
    // Compare itself does not print the revision; the workspace keys on it.
    // Opening the workspace requires client state — assert the prop path via
    // GuidedCleanupWorkspace coverage, and that compare still offers cleanup.
    assert.match(html, /Clean Up Background/);
    assert.equal(preparation({ preparedRevision: "rev-after-d" }).preparedRevision, "rev-after-d");
    assert.notEqual(
      preparation({ preparedRevision: "rev-after-d" }).preparedRevision,
      preparation({ preparedRevision: "rev-automatic" }).preparedRevision,
    );
  });

  it("is not an image editor", () => {
    const html = render();

    assert.doesNotMatch(html, /brush|lasso|eraser|freehand|layer|opacity slider/i);
  });
});

/**
 * Intelligent Separation Phase 3 — surfacing the server's already-computed
 * `preparedReview` state (readiness + garment-conditional copy) in the
 * Existing Artwork compare screen. Every assertion here is about VIEW state;
 * nothing here recomputes readiness or a garment relationship — the copy
 * strings are exactly what `describePreparedArtworkReview` would produce,
 * asserted the same way Phase 1/2's suites did.
 */
describe("Preparation review intelligence — copy states (Phase 3)", () => {
  const REVIEW_REQUIRED_MISMATCHED = {
    headline: "Background prepared — review recommended",
    guidance:
      "Some removed background-coloured areas also run through the design. On this garment, those areas may show up as missing fill or detail — check the prepared artwork on Gray, White, and Black before continuing.",
    sharesBackgroundColor: true,
    reviewRequired: true,
    garmentMayMatchBackground: false,
  } as const;

  const REVIEW_REQUIRED_MATCHED = {
    headline: "Background prepared — review recommended",
    guidance:
      "Some of your design uses the same colour as the background. On this garment colour, those areas may already be supplied by the shirt itself — check the prepared artwork on Gray, White, and Black before continuing.",
    sharesBackgroundColor: true,
    reviewRequired: true,
    garmentMayMatchBackground: true,
  } as const;

  const REVIEW_REQUIRED_UNKNOWN_GARMENT = {
    headline: "Background prepared — review recommended",
    guidance:
      "Some removed background-coloured areas also run through the design. Review the prepared artwork carefully on Gray, White, and Black before continuing.",
    sharesBackgroundColor: true,
    reviewRequired: true,
    garmentMayMatchBackground: null,
  } as const;

  it("A: a safe preparation renders with no review styling", () => {
    const html = render("compare", {
      preparedReview: {
        headline: "Background prepared",
        guidance: "Review the artwork below before continuing.",
        sharesBackgroundColor: false,
        reviewRequired: false,
        garmentMayMatchBackground: null,
      },
    });

    assert.match(html, /data-preparation-readiness="safe"/);
    assert.doesNotMatch(html, /data-preparation-readiness="review_required"/);
    assert.doesNotMatch(html, /review recommended/i);
    assert.doesNotMatch(html, /border-amber/);
    assert.doesNotMatch(html, /Check Gray, White, and Black if you(?:'|&#x27;)re unsure/);
  });

  it("B: review_required renders a visibly distinct, non-catastrophic banner", () => {
    const html = render("compare", { preparedReview: REVIEW_REQUIRED_MISMATCHED });

    assert.match(html, /data-preparation-readiness="review_required"/);
    assert.match(html, /review recommended/i);
    for (const forbidden of [/\bfailed\b/i, /\bunsafe\b/i, /\bdamaged\b/i, /\bbroken\b/i, /\bdestroyed\b/i]) {
      assert.doesNotMatch(html, forbidden);
    }
  });

  it("C: matched-garment copy explains substrate, never claims safety", () => {
    const html = render("compare", { preparedReview: REVIEW_REQUIRED_MATCHED });

    assert.match(html, /may already be supplied by the shirt itself/i);
    assert.doesNotMatch(html, /this is safe/i);
  });

  it("D: mismatched-garment copy warns of missing fill\\/detail, never names an object", () => {
    const html = render("compare", { preparedReview: REVIEW_REQUIRED_MISMATCHED });

    assert.match(html, /missing fill or detail/i);
    assert.doesNotMatch(html, /bowling ball|the logo was removed| was removed\b/i);
  });

  it("E: unknown-garment copy is generic and never infers a colour relationship", () => {
    const html = render("compare", { preparedReview: REVIEW_REQUIRED_UNKNOWN_GARMENT });

    assert.match(html, /Review the prepared artwork carefully/i);
    assert.doesNotMatch(html, /On this garment/i);
    assert.doesNotMatch(html, /supplied by the shirt/i);
  });

  it("K: original safety wording appears both on the tile and near approval", () => {
    const html = render("compare");

    assert.match(html, /The artwork you uploaded, untouched\./);
    assert.match(html, /Your original upload is saved and unchanged\./);
  });

  it("L: approval stays available and is not additionally gated by review_required", () => {
    const html = render("compare", { preparedReview: REVIEW_REQUIRED_MISMATCHED });

    const button = html.match(/<button[^>]*>Use Prepared Artwork<\/button>/);
    assert.ok(button, "the approval button must still render");
    // The actual `disabled` DOM attribute, not the Tailwind `disabled:*`
    // variant classes every button carries regardless of state.
    assert.doesNotMatch(button![0], /\sdisabled(=|>|\s)/);
  });

  it("I/J: preview state carries no garment identity and never touches the prepared asset URL", () => {
    const safeHtml = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
        reviewRequired: false,
      }),
    );
    const reviewHtml = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
        reviewRequired: true,
      }),
    );

    for (const html of [safeHtml, reviewHtml]) {
      assert.match(html, /src="https:\/\/signed\.example\/prepared\.png"/);
      // The preview-background surface never carries or renders garment data.
      assert.doesNotMatch(html, /garment|shirtColor|shirt color/i);
    }
  });

  it("F/G/H: Gray stays default and White\\/Black stay selectable when review is recommended", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
        reviewRequired: true,
      }),
    );

    assert.match(html, new RegExp(`data-preview-background="${DEFAULT_PREVIEW_BACKGROUND}"`));
    assert.match(html, /data-preview-background-option="white"/);
    assert.match(html, /data-preview-background-option="gray"/);
    assert.match(html, /data-preview-background-option="black"/);
    assert.match(html, /Check Gray, White, and Black if you(?:'|&#x27;)re unsure\./);
  });

  it("the review-emphasis line is absent when review is not recommended", () => {
    const html = renderToString(
      createElement(ArtworkComparison, {
        original: { url: "https://signed.example/original.png", loading: false },
        prepared: { url: "https://signed.example/prepared.png", loading: false },
        reviewRequired: false,
      }),
    );

    assert.doesNotMatch(html, /Check Gray, White, and Black if you(?:'|&#x27;)re unsure/);
  });
});

/**
 * Phase 3, Goals M/N/O/P/Q/R — exercised against a harness with cleanup
 * wired (`onCleanupPoint` present), mirroring the existing "guided background
 * cleanup" describe block's local render helper.
 */
describe("Preparation review intelligence — no auto-routing, no leaked vocabulary (Phase 3)", () => {
  function renderCompareFull(overrides: Partial<ArtworkPreparationView> = {}) {
    return renderToString(
      createElement(UploadedArtworkPanel, {
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
        onCleanupPoint: () => {},
        onUndoCleanup: () => {},
      }),
    );
  }

  const REVIEW_REQUIRED = {
    headline: "Background prepared — review recommended",
    guidance:
      "Some removed background-coloured areas also run through the design. On this garment, those areas may show up as missing fill or detail — check the prepared artwork on Gray, White, and Black before continuing.",
    sharesBackgroundColor: true,
    reviewRequired: true,
    garmentMayMatchBackground: false,
  } as const;

  it("M: Clean Up Background remains available under review_required", () => {
    const html = renderCompareFull({
      preparedReview: REVIEW_REQUIRED,
      guidedCleanup: { available: true, removalCount: 0 },
    });

    assert.match(html, /Clean Up Background/);
  });

  it("N/O/P: review_required renders no production-routing, job, or treatment vocabulary", () => {
    const html = renderCompareFull({ preparedReview: REVIEW_REQUIRED });

    for (const forbidden of [
      /Prepare for Print/i,
      /Finalize/i,
      /halftone/i,
      /\btreatment\b/i,
      /\bLPI\b/,
      /FinalArtworkJob/i,
      /provider/i,
      /Topaz/i,
    ]) {
      assert.doesNotMatch(html, forbidden);
    }
  });

  it("Q/R: no internal experimental strategy vocabulary reaches rendered markup", () => {
    const html = renderCompareFull({ preparedReview: REVIEW_REQUIRED });

    for (const forbidden of [
      /original_preserving_separation/i,
      /manual_intervention/i,
      /prepared_background_removed/i,
      /ProductionSourceStrategy/i,
      /exteriorRemovalEnclosureRatio/i,
      /disconnectedBackgroundColoredPixels/i,
      /assessProductionSourceStrategy/i,
      /backgroundConfidence/i,
    ]) {
      assert.doesNotMatch(html, forbidden);
    }
  });
});

/**
 * Phase 3, Goals S/T/U — the actual bowling fixture and a genuinely safe
 * fixture, driven through the REAL preparation capability so the UI is
 * proven against server-computed evidence rather than hand-typed copy.
 * Runs entirely in a throwaway temp directory; never touches the real
 * `.data/sprint1-store.json` and never mutates the live bowling project.
 */
describe("Preparation review intelligence — real preparation evidence (Phase 3)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-panel-review-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function realPrepare(image: Parameters<typeof toPngBytes>[0], productColor: string) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createArtworkPreparationCapability(
      repo,
      assets,
      createDesignBriefCapability(repo),
    );
    const projectId = (await repo.createProject()).project.id;
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(image),
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await capability.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor,
      printPlacement: "full_front",
    });
    const view = await capability.prepareBackground(projectId);
    const record = await repo.getArtworkPreparation(projectId);
    const preparedBytes = (await assets.downloadAssetBytes(record!.preparedAssetId!))!.bytes;
    return { view, preparedBytes };
  }

  function renderWithView(view: ArtworkPreparationView) {
    return renderToString(
      createElement(UploadedArtworkPanel, {
        step: "compare" as UploadedArtworkStep,
        preparation: view,
        busy: false,
        originalImageUrl: "https://signed.example/original.png",
        preparedImageUrl: "https://signed.example/prepared.png",
        onUpload: () => {},
        onSaveDetails: () => {},
        onPrepare: () => {},
        onApprove: () => {},
        onReconsider: () => {},
        onCleanupPoint: () => {},
        onUndoCleanup: () => {},
      }),
    );
  }

  it("S: bowling on a white shirt shows review recommended + mismatched-garment copy", async () => {
    const { view } = await realPrepare(bowlingStyleArtwork(), "White");
    assert.equal(view.preparedReview?.reviewRequired, true);
    assert.equal(view.preparedReview?.garmentMayMatchBackground, false);

    const html = renderWithView(view);
    assert.match(html, /review recommended/i);
    assert.match(html, /missing fill or detail/i);
    assert.match(html, /data-preparation-readiness="review_required"/);
    assert.match(html, /data-preview-background="gray"/);
    assert.match(html, /data-preview-background-option="white"/);
    assert.match(html, /data-preview-background-option="black"/);
    assert.match(html, /The artwork you uploaded, untouched\./);
    assert.match(html, /Clean Up Background/);
    assert.match(html, /Use Prepared Artwork/);
  });

  it("T: bowling on a black shirt shows review recommended + matched-garment copy, and prepared bytes match the white-shirt run", async () => {
    const black = await realPrepare(bowlingStyleArtwork(), "Black");
    const white = await realPrepare(bowlingStyleArtwork(), "White");

    assert.equal(black.view.preparedReview?.reviewRequired, true);
    assert.equal(black.view.preparedReview?.garmentMayMatchBackground, true);
    assert.equal(
      createHash("sha256").update(black.preparedBytes).digest("hex"),
      createHash("sha256").update(white.preparedBytes).digest("hex"),
      "garment colour must never change the prepared PNG bytes",
    );

    const html = renderWithView(black.view);
    assert.match(html, /review recommended/i);
    assert.match(html, /supplied by the shirt itself/i);
  });

  it("U: a safe fixture stays low-friction — no banner, no garment-conditional copy", async () => {
    const { view } = await realPrepare(solidBlackExteriorArtwork(), "Navy");
    assert.equal(view.preparedReview?.reviewRequired, false);

    const html = renderWithView(view);
    assert.doesNotMatch(html, /review recommended/i);
    assert.match(html, /data-preparation-readiness="safe"/);
    assert.doesNotMatch(html, /border-amber/);
    assert.match(html, /Use Prepared Artwork/);
  });
});
