import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import type {
  CustomerFinalizationStatus,
  ProductionTreatmentView,
} from "@/lib/services/conversation-service";

import { UploadedArtworkPanel } from "./UploadedArtworkPanel";
import { PrepareForPrintAction } from "./PrepareForPrintAction";
import { ProductionTreatmentPanel } from "./ProductionTreatmentPanel";

/**
 * Phase 27M §8/§9/§12 — THE WAITING-STATE UX REGRESSION.
 *
 * Human acceptance of Phase 27L reported three silent pauses with no visible
 * indication of processing: selecting Standard Raster, selecting DTF
 * Halftone, and switching DTF Halftone back to Standard Raster — plus a
 * similar silent gap right after clicking the final "Prepare Print-Ready
 * Artwork" action, before the UI reported that processing had begun.
 *
 * TRACED: every one of these is a single request/response round trip (one
 * `fetch`, gated by the shared `sending` flag) with no separate
 * preview-generation call and no server-side staged progress to report — so
 * the fix is exactly what Section 8/9 describe: immediate, request-scoped
 * feedback attached to the real async boundary, never a fabricated stage.
 *
 * These tests are pure render-level proof (`renderToString`, matching this
 * directory's existing house style — see `production-treatment-dead-end.test.ts`)
 * that the NEW pending-state props actually change what a customer/operator
 * sees. `ChatApp.tsx`'s wiring of those props to real fetch calls is
 * unit-untestable without a browser and is instead covered by the Phase 27M
 * real-browser acceptance pass.
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
      enhancementNeeded: false,
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

function confirmedSize(
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
      { widthIn: 10.5, label: '10.5" Standard', isStandard: true, isSelected: true },
    ],
    note: null,
    recommendation: {
      recommendedFor: "Adult standard · Full Back",
      boxWidthIn: 10.5,
      boxHeightIn: 10.5,
      artworkWidthIn: 10.5,
      artworkHeightIn: 9.08,
      assumedGarmentSizeClass: false,
      isConfirmed: true,
    },
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
  } as PrintReadySizeView;
}

function treatmentView(
  overrides: Partial<ProductionTreatmentView> = {},
): ProductionTreatmentView {
  const garment = { label: "Black", hex: "#000000", rgb: { r: 0, g: 0, b: 0 } };
  return {
    treatment: "standard_raster",
    halftone: null,
    recommended: {
      lpi: 35,
      angleDeg: 45,
      dotShape: "round",
      midtone: 1,
      chokePx: 0,
      garment,
      algorithmVersion: "iheartprints_halftone_am_v1",
    },
    selectedAt: null,
    garment,
    offerable: true,
    offerBlockedReason: null,
    controls: {
      lpi: { min: 25, max: 55, recommended: 35 },
      angles: [22.5, 45],
      dotShapes: ["round", "ellipse"],
      midtone: { min: 0.5, max: 2, recommended: 1 },
      chokePx: { min: 0, max: 2, recommended: 0 },
    },
    ...overrides,
  } as ProductionTreatmentView;
}

function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPanel(options: {
  finalizationStatus?: CustomerFinalizationStatus;
  preparingForPrint?: boolean;
  busy?: boolean;
}) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step: "approved" as const,
      preparation: preparation(),
      busy: options.busy ?? false,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: "https://signed.example/prepared.png",
      printReadySize: confirmedSize(),
      finalizationStatus: options.finalizationStatus ?? "not_requested",
      preparingForPrint: options.preparingForPrint ?? false,
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

// Phase 28H removed the entire "Phase 27M — treatment selection shows
// immediate, request-specific waiting feedback (UploadedArtworkPanel path)"
// describe block that used to live here: `ProductionTreatmentPanel` is no
// longer mounted inside `UploadedArtworkPanel` at all (Standard Raster is
// now attempted automatically, with no customer treatment choice
// beforehand), so `pendingTreatment`/`onSelectStandardRaster`/
// `onSelectHalftoneTreatment` no longer exist on `UploadedArtworkPanelProps`.
// `ProductionTreatmentPanel`'s OWN pending-copy behavior is still proven
// directly below ("ProductionTreatmentPanel unit-level pending copy") since
// the component itself is untouched — only its customer-facing mount point
// was removed. See `uploaded-artwork-print-ready-flow.test.tsx` for the
// Phase 28H replacement coverage (Standard-Raster-only initial creation,
// the optional Halftone offer, and its own "Creating…" feedback).

describe("Phase 27M — Create Print-Ready Artwork shows immediate feedback on click (both surfaces)", () => {
  it("J: UploadedArtworkPanel path — preparingForPrint immediately swaps the label to 'Creating Print-Ready Artwork…'", () => {
    const before = visibleText(renderPanel({ preparingForPrint: false }));
    assert.match(before, /Create Print-Ready Artwork/);
    assert.doesNotMatch(before, /Creating Print-Ready Artwork…/);

    const during = visibleText(renderPanel({ preparingForPrint: true, busy: true }));
    assert.match(during, /Creating Print-Ready Artwork…/);
  });

  it("K: the button is genuinely disabled while preparingForPrint is true", () => {
    const html = renderPanel({ preparingForPrint: true, busy: true });
    const compact = html.replace(/\s+/g, " ");
    const match = /<button([^>]*)>\s*(?:<span[^>]*>[\s\S]*?<\/span>\s*)*Creating Print-Ready Artwork…\s*<\/button>/.exec(
      compact,
    );
    assert.ok(match, "no in-flight Create Print-Ready Artwork button rendered");
    assert.match(match![1], / disabled=""/);
  });

  it("J: create_new path (PrepareForPrintAction) — same immediate feedback", () => {
    const renderAction = (preparing: boolean, busy: boolean) =>
      renderToString(
        createElement(PrepareForPrintAction, {
          finalizationStatus: "not_requested" as const,
          canRequest: true,
          busy,
          preparing,
          onPrepare: () => {},
          printReadySize: confirmedSize(),
          onChoosePrintWidth: () => {},
          onUseRecommendedSize: () => {},
          onChooseGarmentSize: () => {},
        }),
      );

    const before = visibleText(renderAction(false, false));
    assert.match(before, /Create Print-Ready Artwork/);
    assert.doesNotMatch(before, /Creating Print-Ready Artwork…/);

    const during = visibleText(renderAction(true, true));
    assert.match(during, /Creating Print-Ready Artwork…/);
  });
});

describe("Phase 27M — ProductionTreatmentPanel unit-level pending copy", () => {
  function renderTreatmentPanel(pending: "standard_raster" | "halftone_dtf" | null) {
    return renderToString(
      createElement(ProductionTreatmentPanel, {
        view: treatmentView(),
        busy: pending !== null,
        pendingTreatment: pending,
        previewUrls: {},
        onSelectStandardRaster: () => {},
        onSelectHalftone: () => {},
      }),
    );
  }

  it("null -> static copy; standard_raster -> 'Switching treatment…'; halftone_dtf -> 'Loading halftone options…'", () => {
    assert.match(
      visibleText(renderTreatmentPanel(null)),
      /Standard Raster — normal full-color print preparation\./,
    );
    assert.match(visibleText(renderTreatmentPanel("standard_raster")), /Switching treatment…/);
    assert.match(visibleText(renderTreatmentPanel("halftone_dtf")), /Loading halftone options…/);
  });
});
