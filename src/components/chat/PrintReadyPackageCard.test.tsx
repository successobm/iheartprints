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
      variant({ treatment: "standard_raster", status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size." }),
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
    assert.match(text, /Needs Attention/);
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
