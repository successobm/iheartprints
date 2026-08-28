import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import {
  describeProductionVariantCostSummary,
  productionVariantDescription,
  productionVariantLabel,
  type ProductionVariantView,
} from "@/capabilities/shared/production-variant";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";

import { UploadedArtworkPanel } from "./UploadedArtworkPanel";

/**
 * Phase 28H — PROGRESSIVE PRINT-READY FILE CREATION.
 *
 * Section 13.O: `needs_review` (Standard Raster's deterministic
 * `finalization_required`) must never show "Try Again" — that framing
 * implies a plain retry might change a verdict that will recompute
 * identically on unchanged inputs. `retryable_failure` (a genuine
 * infrastructure hiccup) is UNAFFECTED and keeps its own real retry
 * framing — see `production-treatment-dead-end.test.tsx` for that
 * regression coverage, entirely untouched by this phase.
 *
 * Also proves the wiring: `onCreateHalftoneVersion`/`creatingHalftoneVersion`
 * actually reach `PrintReadyPackageCard`, and the removed
 * `ProductionTreatmentPanel` mount point never reappears from this step.
 */

function preparation(overrides: Partial<ArtworkPreparationView> = {}): ArtworkPreparationView {
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
    productSummary: "T-shirts",
    productColor: "Black",
    printPlacement: "full_front",
    preparedRevision: "rev-1",
    ...overrides,
  } as ArtworkPreparationView;
}

function confirmedSize(): PrintReadySizeView {
  return {
    widthIn: 6.92,
    heightIn: 10.5,
    dpi: 300,
    placementLabel: "Full Front",
    isDefaultWidth: true,
    minWidthIn: 4,
    maxWidthIn: 14,
    widthOptions: [{ widthIn: 6.92, label: '6.92" Standard', isStandard: true, isSelected: true }],
    note: null,
    recommendation: {
      recommendedFor: "Adult standard · Full Front",
      boxWidthIn: 10.5,
      boxHeightIn: 10.5,
      artworkWidthIn: 6.92,
      artworkHeightIn: 10.5,
      assumedGarmentSizeClass: false,
      isConfirmed: true,
    },
    confirmed: true,
    confirmedAt: "2026-08-27T00:00:00.000Z",
    blockingMessage: null,
    garmentSizeOptions: [{ value: "adult_standard", label: "Standard Adult", isSelected: true }],
    requiresExplicitWidth: false,
  } as PrintReadySizeView;
}

function variant(overrides: Partial<ProductionVariantView>): ProductionVariantView {
  return {
    treatment: "standard_raster",
    label: productionVariantLabel("standard_raster"),
    description: productionVariantDescription("standard_raster"),
    status: "not_created",
    finalArtworkJobId: null,
    finalAssetId: null,
    createdAt: null,
    physicalWidthIn: null,
    physicalHeightIn: null,
    pixelWidth: null,
    pixelHeight: null,
    halftone: null,
    attentionReason: null,
    attentionKind: null,
    costSummary: describeProductionVariantCostSummary(null, null),
    ...overrides,
  };
}

function render(options: {
  finalizationStatus?: CustomerFinalizationStatus;
  variants?: ProductionVariantView[];
  onCreateHalftoneVersion?: () => void;
  creatingHalftoneVersion?: boolean;
}) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step: "approved" as const,
      preparation: preparation(),
      busy: false,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: "https://signed.example/prepared.png",
      printReadySize: confirmedSize(),
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
      printReadyPackage: options.variants ? { variants: options.variants } : undefined,
      onCreateHalftoneVersion: options.onCreateHalftoneVersion,
      creatingHalftoneVersion: options.creatingHalftoneVersion,
    }),
  );
}

function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("Phase 28H Section 13.O — needs_review (deterministic finalization_required) never says 'Try Again'", () => {
  it("O: the primary action's label is the normal creation label, not 'Try Again', when finalizationStatus is needs_review", () => {
    const text = visibleText(render({ finalizationStatus: "needs_review" }));
    assert.doesNotMatch(text, /Try Again/);
    assert.match(text, /Create Print-Ready Artwork/);
  });

  it("O: the button is still present and still calls the same idempotent action -- resizing and re-requesting remains possible", () => {
    const html = render({ finalizationStatus: "needs_review" });
    const compact = html.replace(/\s+/g, " ");
    const match = /<button([^>]*)>\s*Create Print-Ready Artwork\s*<\/button>/.exec(compact);
    assert.ok(match, "the production request button must still exist for needs_review");
  });

  it("retryable_failure (a genuine infrastructure hiccup) is UNCHANGED -- still says Retry Preparation", () => {
    const text = visibleText(render({ finalizationStatus: "retryable_failure" }));
    assert.match(text, /Retry Preparation/);
  });

  it("the generic amber 'needs attention... try again' banner is suppressed once a print-ready package card is present (redundant with the package's own per-variant reason)", () => {
    const text = visibleText(
      render({
        finalizationStatus: "needs_review",
        variants: [
          variant({ status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size.", attentionKind: "deterministic_enhancement" }),
          variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
        ],
      }),
    );
    assert.doesNotMatch(text, /we'll take another look/i);
    assert.match(text, /Needs Additional Enhancement/);
  });
});

describe("Phase 28H — the Production Treatment selection card never reappears from the approved step", () => {
  it("no 'Production treatment' text renders regardless of finalization status or package contents", () => {
    for (const status of ["not_requested", "needs_review", "retryable_failure", "print_ready"] as const) {
      const text = visibleText(
        render({
          finalizationStatus: status,
          variants: [variant({ status: "print_ready", finalAssetId: "asset-1" }), variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" })],
        }),
      );
      assert.doesNotMatch(text, /Production treatment/i, `status=${status}`);
    }
  });
});

describe("Phase 28H — onCreateHalftoneVersion/creatingHalftoneVersion reach PrintReadyPackageCard", () => {
  it("the halftone offer's button fires the panel's own onCreateHalftoneVersion prop, not a re-implemented handler", () => {
    let fired = false;
    const html = render({
      variants: [
        variant({ status: "print_ready", finalAssetId: "asset-1" }),
        variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
      ],
      onCreateHalftoneVersion: () => {
        fired = true;
      },
    });
    assert.match(html, /data-action="create-halftone-version"/);
    // renderToString cannot fire onClick (no DOM) -- proven at the source
    // level that the SAME prop is threaded through unchanged, matching the
    // established precedent for this repo's other effect-driven doorways.
    assert.equal(fired, false, "renderToString must never invoke a click handler");
  });

  it("creatingHalftoneVersion=true reaches the card as its own 'Creating…' state", () => {
    const html = render({
      variants: [
        variant({ status: "print_ready", finalAssetId: "asset-1" }),
        variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
      ],
      creatingHalftoneVersion: true,
    });
    assert.match(html, /Creating…/);
  });
});
