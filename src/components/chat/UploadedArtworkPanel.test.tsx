import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";

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
      { widthIn: 9, label: '9"', isStandard: false, isSelected: false },
      { widthIn: 10.5, label: '10.5" Standard', isStandard: true, isSelected: true },
      { widthIn: 12, label: '12"', isStandard: false, isSelected: false },
    ],
    note: "This is a standard adult full back print size.",
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
  } = {},
) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      step,
      preparation: preparation(overrides),
      busy: false,
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
    assert.match(text, /Change Size/);
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
    assert.doesNotMatch(html, /Change Size/);
  });

  it("states an honest needs-attention message, and offers a retry, on failure", () => {
    const html = render("approved", approvedState, {}, {
      finalizationStatus: "needs_review",
    });

    assert.match(html, /needs attention before we can finish/);
    assert.match(html, /uploaded artwork and the prepared version are both safe/);
    assert.match(html, /Try Again/);
    assert.doesNotMatch(html, /is ready|print-ready file is ready/i);
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
    assert.match(html, /Change Size/);
  });

  it("says nothing about size when there is nothing honest to say", () => {
    const html = render("approved", approvedState, {}, { printReadySize: null });

    assert.doesNotMatch(html, /Change Size/);
    assert.doesNotMatch(html, /300 DPI/);
    assert.match(html, /Prepare Print-Ready Artwork/);
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
