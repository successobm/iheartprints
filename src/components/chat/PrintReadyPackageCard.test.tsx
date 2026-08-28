import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, it } from "node:test";

import { PrintReadyPackageCard } from "./PrintReadyPackageCard";
import {
  describeProductionVariantCostSummary,
  productionVariantDescription,
  productionVariantLabel,
  type ProductionVariantView,
} from "@/capabilities/shared/production-variant";

/**
 * Phase 27P — render-level proof for the Print-Ready Files surface:
 * per-variant identity/settings display (Goal I) and a responsive structure
 * with no fixed-width overflow hazard (Goal T, static half; live browser
 * acceptance covers the rest).
 */

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

function render(variants: ProductionVariantView[], guidance: string | null = null) {
  return renderToString(
    createElement(PrintReadyPackageCard, {
      projectId: "test-project-id",
      variants,
      guidance,
    }),
  );
}

function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/&deg;/g, "°")
    .replace(/\s+/g, " ")
    .trim();
}

describe("PrintReadyPackageCard", () => {
  it("renders nothing for an empty variant list", () => {
    assert.equal(render([]), "");
  });

  it("shows both variant labels, descriptions, and statuses", () => {
    const html = render([
      variant({ treatment: "standard_raster", status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size.", attentionKind: "deterministic_enhancement" }),
      variant({
        treatment: "halftone_dtf",
        label: "DTF Halftone",
        description: productionVariantDescription("halftone_dtf"),
        status: "print_ready",
        finalAssetId: "asset-1",
        halftone: { lpi: 35, angleDeg: 45, dotShape: "round" },
      }),
    ]);
    const text = visibleText(html);
    assert.match(text, /Standard Raster/);
    // Phase 28H Section 7: Standard Raster's own deterministic
    // "needs_attention" gets the more specific "Needs Additional
    // Enhancement" label -- never the generic "Needs Attention" a retryable
    // infrastructure hiccup or a halftone tonal-insufficiency verdict also
    // uses (see `PrintReadyPackageCard.tsx`'s `statusPresentation`).
    assert.match(text, /Needs Additional Enhancement/);
    assert.match(text, /needs additional image enhancement/);
    assert.match(text, /DTF Halftone/);
    assert.match(text, /Print Ready/);
  });

  it("I: halftone metadata displays the correct settings (LPI, angle, dot shape)", () => {
    const html = render([
      variant({
        treatment: "halftone_dtf",
        label: "DTF Halftone",
        status: "print_ready",
        finalAssetId: "asset-1",
        halftone: { lpi: 35, angleDeg: 45, dotShape: "round" },
      }),
    ]);
    assert.match(visibleText(html), /35 LPI · 45° · Round/);
  });

  it("download link is present ONLY for print_ready, and points at the variant's OWN treatment-scoped route", () => {
    const html = render([
      variant({ treatment: "standard_raster", status: "needs_attention" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "print_ready", finalAssetId: "asset-1" }),
    ]);
    const compact = html.replace(/\s+/g, " ");
    assert.doesNotMatch(compact, /production-artwork\/standard_raster\/download/);
    assert.match(compact, /href="\/api\/projects\/test-project-id\/production-artwork\/halftone_dtf\/download"/);
  });

  it("not_created and processing never render a download link", () => {
    const html = render([
      variant({ treatment: "standard_raster", status: "not_created" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "processing" }),
    ]);
    assert.doesNotMatch(html, /Download PNG/);
  });

  it("guidance sentence renders when provided, absent when null", () => {
    const withGuidance = visibleText(
      render(
        [variant({ status: "print_ready" }), variant({ treatment: "halftone_dtf", status: "print_ready" })],
        "Both files are print ready. Your printer can choose the version that works best for their equipment and production process.",
      ),
    );
    assert.match(withGuidance, /Both files are print ready/);

    const withoutGuidance = visibleText(render([variant({ status: "not_created" })], null));
    assert.doesNotMatch(withoutGuidance, /print ready\./i);
  });

  it("T: never claims one variant is universally better in rendered copy", () => {
    const html = visibleText(
      render([
        variant({ status: "print_ready" }),
        variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "print_ready" }),
      ]),
    );
    assert.doesNotMatch(html, /\bbetter\b/i);
  });

  it("T: responsive structure -- a single-column-by-default grid that only widens at a breakpoint, never a fixed pixel width", () => {
    // Structural regression: the variant grid must use relative/breakpoint
    // classes (grid-cols-1 by default, sm:grid-cols-2), never a fixed `w-*`
    // pixel width that would overflow a 320px viewport.
    const html = render([variant({ status: "not_created" }), variant({ treatment: "halftone_dtf", status: "not_created" })]);
    assert.match(html, /grid-cols-1/);
    assert.match(html, /sm:grid-cols-2/);
    assert.doesNotMatch(html, /\bw-\[\d/, "no fixed pixel width on the package or its variant cards");
  });
});

/**
 * Phase 28H — Section 13.D/E/F/H/I/N: the OPTIONAL "Create DTF Halftone
 * Version" offer that replaces the plain "Not Created" halftone tile once
 * Standard Raster has concluded (any of `print_ready` / `needs_attention` /
 * `retryable_failure`).
 */
function renderWithHalftoneOffer(
  variants: ProductionVariantView[],
  options: { onCreateHalftoneVersion?: () => void; creatingHalftoneVersion?: boolean } = {},
) {
  return renderToString(
    createElement(PrintReadyPackageCard, {
      projectId: "test-project-id",
      variants,
      guidance: null,
      onCreateHalftoneVersion: options.onCreateHalftoneVersion,
      creatingHalftoneVersion: options.creatingHalftoneVersion,
    }),
  );
}

describe("PrintReadyPackageCard — Phase 28H optional DTF Halftone offer", () => {
  it("D: the offer appears once Standard Raster is print_ready and Halftone has never been attempted", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "print_ready", finalAssetId: "asset-1" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
    ]);
    assert.match(html, /data-halftone-offer/);
    assert.match(html, /data-action="create-halftone-version"/);
    assert.match(visibleText(html), /DTF Halftone[\s\S]*Optional/);
  });

  it("Phase 28I HARD CORRECTION: the offer does NOT appear while Standard Raster is needs_attention -- Phase 28H's opposite rule is explicitly overruled", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size." }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
    ]);
    assert.doesNotMatch(html, /data-halftone-offer/);
    assert.doesNotMatch(html, /data-action="create-halftone-version"/);
    assert.match(html, /Not Created/);
  });

  it("Phase 28I HARD CORRECTION: the offer does NOT appear while Standard Raster is retryable_failure", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "retryable_failure" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
    ]);
    assert.doesNotMatch(html, /data-halftone-offer/);
  });

  it("the offer does NOT appear while Standard Raster has not been attempted yet (not_created) -- Raster must be tried first", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "not_created" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
    ]);
    assert.doesNotMatch(html, /data-halftone-offer/);
    assert.match(html, /Not Created/);
  });

  it("the offer does NOT appear while Standard Raster is still processing", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "processing" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
    ]);
    assert.doesNotMatch(html, /data-halftone-offer/);
  });

  it("the offer disappears once Halftone has actually been created -- never shown alongside its own real status", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "print_ready", finalAssetId: "asset-1" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "processing" }),
    ]);
    assert.doesNotMatch(html, /data-halftone-offer/);
    assert.match(html, /Processing/);
  });

  it("Creating…: clicking shows immediate, request-specific feedback and disables the button", () => {
    const html = renderWithHalftoneOffer(
      [
        variant({ status: "print_ready", finalAssetId: "asset-1" }),
        variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
      ],
      { creatingHalftoneVersion: true },
    );
    assert.match(html, /Creating…/);
    assert.doesNotMatch(html, /Not Created/);
    const compact = html.replace(/\s+/g, " ");
    const match = /<button([^>]*)>\s*Create DTF Halftone Version\s*<\/button>/.exec(compact);
    assert.ok(match);
    assert.match(match![1], / disabled=""/);
  });

  it("G: the offer's button never appears anywhere near, or references, Standard Raster's own job/asset -- no recreate/overwrite affordance", () => {
    const html = renderWithHalftoneOffer([
      variant({ status: "print_ready", finalAssetId: "asset-1", finalArtworkJobId: "raster-job-1" }),
      variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "not_created" }),
    ]);
    // Standard Raster's own tile is untouched -- still its own VariantCard,
    // still downloadable, with no create/recreate action of its own.
    assert.match(html, /Download PNG/);
    const rasterTileMatch = html.match(/Standard Raster[\s\S]*?(?=<div class="min-w-0)/);
    assert.ok(rasterTileMatch);
    assert.doesNotMatch(rasterTileMatch![0], /data-action="create-halftone-version"/);
  });

  it("Section 11/19: a legacy Halftone completed BEFORE Phase 28I's gate existed (Raster needs_attention, Halftone already print_ready) remains a normal, downloadable tile -- never hidden, mutated, or re-offered", () => {
    const html = renderWithHalftoneOffer(
      [
        variant({ status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size." }),
        variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "print_ready", finalAssetId: "legacy-asset-1" }),
      ],
      { onCreateHalftoneVersion: () => {} },
    );
    // No download link for Raster specifically (correctly not print_ready) --
    // isolate its own tile before checking.
    const rasterTile = html.match(/Standard Raster[\s\S]*?(?=<div class="min-w-0)/);
    assert.ok(rasterTile);
    assert.doesNotMatch(rasterTile![0], /Download PNG/);
    // ...but the legacy Halftone's OWN tile is untouched: still Print Ready,
    // still downloadable, never replaced by the offer card (the offer only
    // ever applies to a Halftone that is still `not_created`).
    assert.doesNotMatch(html, /data-halftone-offer/);
    assert.match(html, /DTF Halftone/);
    assert.match(html, /Download PNG/);
  });

  it("N: no package-level failure indicator exists merely because Standard Raster needs enhancement while Halftone is print_ready", () => {
    const html = visibleText(
      renderWithHalftoneOffer([
        variant({ status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size.", attentionKind: "deterministic_enhancement" }),
        variant({ treatment: "halftone_dtf", label: "DTF Halftone", status: "print_ready", finalAssetId: "asset-2" }),
      ]),
    );
    assert.doesNotMatch(html, /package failed|overall failed|both failed|production failed/i);
    assert.match(html, /Print Ready/);
    assert.match(html, /Needs Additional Enhancement/);
  });
});
