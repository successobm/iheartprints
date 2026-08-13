import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { ConceptPreviewModal } from "./ConceptPreviewModal";
import { resolveGarmentPreviewColor } from "./concept-preview-surface";

/**
 * Live Acceptance UX Pass: one viewer serves every artwork version —
 * original concept, revision, or historical version — and viewing is
 * always read-only. Selection exists here only as an explicit, separate
 * action, and only when the lifecycle already permits it.
 */

const CONCEPT = {
  id: "artwork-revised",
  versionNumber: 4,
  kind: "revision",
  title: "Minimal Badge",
  summary: "Shield border in red.",
  placeholderLabel: "Concept C",
  accentColor: "#173F35",
  isSelected: false,
  hasImage: true,
} as CustomerArtworkVersion;

function render(overrides: {
  isSelected?: boolean;
  canSelect?: boolean;
  busy?: boolean;
  ready?: boolean;
} = {}) {
  return renderToString(
    createElement(ConceptPreviewModal, {
      concept: CONCEPT,
      image:
        overrides.ready === false
          ? undefined
          : { status: "ready", url: "https://signed.example/artwork.png" },
      isSelected: overrides.isSelected ?? false,
      canSelect: overrides.canSelect ?? true,
      busy: overrides.busy ?? false,
      garmentPreview: resolveGarmentPreviewColor({
        shirtColor: null,
        productSummary: "yard sign",
      }),
      onSelect: () => {
        throw new Error("onSelect must never fire from rendering");
      },
      onClose: () => {
        throw new Error("onClose must never fire from rendering");
      },
    }),
  );
}

describe("ConceptPreviewModal", () => {
  it("G: shows the whole artwork, never a crop", () => {
    const html = render();
    assert.match(html, /object-contain/);
    assert.doesNotMatch(html, /object-cover/);
    assert.match(html, /https:\/\/signed\.example\/artwork\.png/);
  });

  it("G: keeps transparency visible behind the artwork when garment preview is off", () => {
    // Non-apparel / deferred defaults to checkerboard so transparency
    // inspection remains available.
    assert.match(render(), /linear-gradient\(45deg/);
    assert.match(render(), /data-concept-preview-surface="transparency"/);
  });

  it("identifies which version is being viewed, and offers a way out", () => {
    const html = render();
    assert.match(html, /Minimal Badge/);
    assert.match(html, /Shield border in red/);
    assert.match(html, /aria-label="Close preview"/);
    assert.match(html, /role="dialog"/);
  });

  it("A: offers selection only as an explicit action, never as a side effect of viewing", () => {
    assert.match(render({ canSelect: true }), /Select this concept/);
    // Not offered when the lifecycle does not permit it...
    assert.doesNotMatch(render({ canSelect: false }), /Select this concept/);
    // ...nor when this version is already the selected one.
    const selected = render({ isSelected: true, canSelect: true });
    assert.doesNotMatch(selected, /Select this concept/);
    assert.match(selected, /Selected/);
  });

  it("stays viewable while a request is in flight, with selection held back", () => {
    const html = render({ busy: true });
    assert.match(html, /object-contain/);
    assert.match(html, /Select this concept/);
    assert.match(html, /disabled/);
  });
});
