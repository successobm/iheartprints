import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { ConceptPreviewModal } from "./ConceptPreviewModal";
import {
  CONCEPT_INSPECTION_COLORS,
  resolveGarmentPreviewColor,
} from "./concept-preview-surface";

const CONCEPT = {
  id: "artwork-revised",
  versionNumber: 4,
  kind: "revision",
  title: "Soft Illustrated",
  summary: "Quiet tonal treatment.",
  placeholderLabel: "Concept B",
  accentColor: "#173F35",
  isSelected: false,
  hasImage: true,
} as CustomerArtworkVersion;

const IMAGE_URL = "https://signed.example/artwork.png";

function render(overrides: {
  isSelected?: boolean;
  canSelect?: boolean;
  busy?: boolean;
  ready?: boolean;
  shirtColor?: string | null;
  productSummary?: string | null;
  deferredSections?: string[];
} = {}) {
  const garmentPreview = resolveGarmentPreviewColor({
    shirtColor: overrides.shirtColor ?? "Black",
    productSummary: overrides.productSummary ?? "T-shirt",
    deferredSections: overrides.deferredSections ?? [],
  });

  return renderToString(
    createElement(ConceptPreviewModal, {
      concept: CONCEPT,
      image:
        overrides.ready === false
          ? undefined
          : { status: "ready", url: IMAGE_URL },
      isSelected: overrides.isSelected ?? false,
      canSelect: overrides.canSelect ?? true,
      busy: overrides.busy ?? false,
      garmentPreview,
      onSelect: () => {
        throw new Error("onSelect must never fire from rendering");
      },
      onClose: () => {
        throw new Error("onClose must never fire from rendering");
      },
    }),
  );
}

describe("ConceptPreviewModal — Phase 2D", () => {
  it("defaults apparel to garment surface, not checkerboard", () => {
    const html = render({ shirtColor: "Black" });
    assert.match(html, /data-concept-preview-surface="garment"/);
    assert.match(html, /background-color:#000000/i);
    assert.match(html, /Design preview on Black/);
    assert.match(html, /data-concept-preview-src="https:\/\/signed\.example\/artwork\.png"/);
  });

  it("G/H/I/J: exposes Garment / White / Gray / Black / Transparency controls", () => {
    const html = render({ shirtColor: "Navy" });
    assert.match(html, /role="radiogroup"/);
    assert.match(html, /data-concept-preview-option="garment"/);
    assert.match(html, /data-concept-preview-option="white"/);
    assert.match(html, /data-concept-preview-option="gray"/);
    assert.match(html, /data-concept-preview-option="black"/);
    assert.match(html, /data-concept-preview-option="transparency"/);
    assert.match(html, /aria-checked="true"/);
  });

  it("K: switching controls do not rewrite the image src", () => {
    const html = render({ shirtColor: "Black" });
    assert.match(html, new RegExp(IMAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /object-contain/);
  });

  it("non-apparel defaults to transparency and omits Garment option", () => {
    const html = render({
      shirtColor: "Black",
      productSummary: "banner",
    });
    assert.match(html, /data-concept-preview-surface="transparency"/);
    assert.match(html, /linear-gradient\(45deg/);
    assert.doesNotMatch(html, /data-concept-preview-option="garment"/);
  });

  it("Y: controls are labeled radios with touch-friendly sizing", () => {
    const html = render();
    assert.match(html, /aria-label="Preview background"/);
    assert.match(html, /min-h-8/);
    assert.match(html, /aria-label="Design preview on Black"/);
  });

  it("selection action remains explicit and independent of background", () => {
    assert.match(render({ canSelect: true }), /Select this concept/);
    assert.doesNotMatch(render({ canSelect: false }), /Select this concept/);
    const selected = render({ isSelected: true, canSelect: true });
    assert.doesNotMatch(selected, /Select this concept/);
    assert.match(selected, /Selected/);
  });

  it("inspection color constants stay presentation-only solids", () => {
    assert.equal(CONCEPT_INSPECTION_COLORS.white, "#FFFFFF");
    assert.equal(CONCEPT_INSPECTION_COLORS.black, "#000000");
  });
});
