import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import {
  FinalArtworkDeliveryCard,
  loadProductionArtworkState,
  type ProductionArtworkClientView,
} from "./FinalArtworkDeliveryCard";
import { formatProductionArtworkMetadataLine } from "./final-artwork-delivery-metadata";

const PRODUCTION: ProductionArtworkClientView = {
  url: "https://signed.example/production?token=abc",
  filename: "1988-toyota-mr2-print-ready.png",
  mimeType: "image/png",
  widthPx: 3600,
  heightPx: 4200,
  transparent: true,
  placementLabel: "Full Front",
  designLabel: "1988 Toyota MR2",
  widthIn: 12,
  heightIn: 14,
  dpi: 300,
};

const CONCEPT_URL = "https://signed.example/concept-selected.png";

describe("FinalArtworkDeliveryCard", () => {
  it("A: print_ready delivery card renders the customer heading", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "project-1",
        onMakeAnotherChange: () => {},
        forcedLoadState: { status: "ready", artwork: PRODUCTION },
      }),
    );
    assert.match(html, /Your print-ready artwork is ready/);
  });

  it("B: production preview uses the production asset URL, not the selected concept URL", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "project-1",
        onMakeAnotherChange: () => {},
        forcedLoadState: { status: "ready", artwork: PRODUCTION },
      }),
    );
    assert.match(html, /https:\/\/signed\.example\/production\?token=abc/);
    assert.doesNotMatch(html, new RegExp(CONCEPT_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("C: delivery card shows correct safe metadata", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "project-1",
        onMakeAnotherChange: () => {},
        forcedLoadState: { status: "ready", artwork: PRODUCTION },
      }),
    );
    assert.match(html, /1988 Toyota MR2/);
    assert.match(html, /Full Front/);
    assert.match(html, /PNG/);
    assert.match(html, /3,600/);
    assert.match(html, /4,200/);
    assert.match(html, /Transparent background/);
    // Live Acceptance Cleanup (Issue 5): the ACTUAL chosen production size
    // leads the line — this fixture chose 12", so a stale 10.5" default
    // must never appear.
    assert.match(html, /12&quot; × 14&quot;/);
    assert.match(html, /300 DPI/);
    assert.doesNotMatch(html, /10\.5/);
    assert.equal(
      formatProductionArtworkMetadataLine(PRODUCTION),
      'PNG · 12" × 14" · 300 DPI · 3,600 × 4,200 · Transparent background',
    );
  });

  it("D/J: Download Print-Ready Artwork and Make Another Change are available", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "project-1",
        onMakeAnotherChange: () => {},
        forcedLoadState: { status: "ready", artwork: PRODUCTION },
      }),
    );
    assert.match(html, /Download Print-Ready Artwork/);
    assert.match(html, /production-artwork\/download/);
    assert.match(html, /Make Another Change/);
  });

  it("F: no UUID/storage/provider internals appear in customer UI", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "5ca1f62d-9768-42dc-9bec-450f3ad56872",
        onMakeAnotherChange: () => {},
        forcedLoadState: {
          status: "ready",
          artwork: {
            ...PRODUCTION,
            // Even if a bad caller stuffed internals into labels, the card
            // must not invent Topaz/job/asset copy of its own.
          },
        },
      }),
    );
    assert.doesNotMatch(html, /27050f17|28d99b53|topaz|design-assets|storageKey|FinalArtworkJob/i);
  });

  it("G: signed URL fetch failure shows Retry", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "project-1",
        onMakeAnotherChange: () => {},
        forcedLoadState: { status: "error" },
      }),
    );
    assert.match(html, /We couldn(?:&#x27;|&apos;|')t load your print-ready artwork/);
    assert.match(html, /Retry/);
    assert.doesNotMatch(html, /regenerat/i);
  });

  it("H: retry reacquires a URL through the load helper", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error("expired");
      return PRODUCTION;
    };

    const first = await loadProductionArtworkState("project-1", fetchFn);
    assert.equal(first.status, "error");

    const second = await loadProductionArtworkState("project-1", fetchFn);
    assert.equal(second.status, "ready");
    if (second.status === "ready") {
      assert.equal(second.artwork.url, PRODUCTION.url);
    }
    assert.equal(calls, 2);
  });

  it("loading shell does not imply generation is still running", () => {
    const html = renderToString(
      createElement(FinalArtworkDeliveryCard, {
        projectId: "project-1",
        onMakeAnotherChange: () => {},
        forcedLoadState: { status: "loading" },
      }),
    );
    assert.match(html, /Loading your print-ready artwork/);
    assert.doesNotMatch(html, /Preparing|Generating|Topaz/i);
  });
});
