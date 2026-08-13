import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { ConceptCards } from "./ConceptCards";
import { resolveGarmentPreviewColor } from "./concept-preview-surface";

/**
 * Phase 2D — garment-color concept cards + honest short-set UX.
 * Render-only: no paid generation, no provider calls, no asset mutation.
 */

function concept(
  overrides: Partial<CustomerArtworkVersion> = {},
): CustomerArtworkVersion {
  return {
    id: "artwork-1",
    versionNumber: 1,
    kind: "concept",
    title: "Minimal Badge",
    summary: "A tight badge lockup.",
    placeholderLabel: "Concept A",
    accentColor: "#173F35",
    isSelected: false,
    hasImage: true,
    ...overrides,
  } as CustomerArtworkVersion;
}

function render(props: {
  concepts: CustomerArtworkVersion[];
  selectedId?: string | null;
  selectable?: boolean;
  busy?: boolean;
  shirtColor?: string | null;
  productSummary?: string | null;
  deferredSections?: string[];
  conceptsWithheld?: number | null;
  showShortSetNote?: boolean;
}) {
  return renderToString(
    createElement(ConceptCards, {
      concepts: props.concepts,
      projectId: "project-1",
      selectedId: props.selectedId ?? null,
      selectable: props.selectable ?? true,
      busy: props.busy ?? false,
      onSelect: () => {
        throw new Error("onSelect must never fire from rendering");
      },
      garmentPreviewInput: {
        shirtColor: props.shirtColor ?? "Black",
        productSummary: props.productSummary ?? "T-shirt",
        deferredSections: props.deferredSections ?? [],
        designDescription: null,
      },
      conceptsWithheld: props.conceptsWithheld ?? null,
      showShortSetNote: props.showShortSetNote,
    }),
  );
}

describe("ConceptCards — Phase 2D garment preview + short set", () => {
  it("Z: Harley black garment defaults cards to black garment surface", () => {
    const html = render({
      concepts: [
        concept({ id: "bold", title: "Bold" }),
        concept({ id: "soft", title: "Soft" }),
        concept({ id: "minimal", title: "Minimal" }),
      ],
      shirtColor: "Black",
      conceptsWithheld: null,
    });
    assert.match(html, /data-concept-card-count="3"/);
    assert.match(html, /data-concept-card-surface="garment"/);
    assert.match(html, /On Black/);
    assert.doesNotMatch(html, /data-concept-short-set-note/);
    assert.match(html, /Soft/);
    assert.match(html, /Bold/);
    assert.match(html, /Minimal/);
  });

  it("Q/R: advisory Soft remains visible and selectable (no withhold UI)", () => {
    const html = render({
      concepts: [
        concept({ id: "soft", title: "Soft Illustrated" }),
        concept({ id: "bold", title: "Bold Direct" }),
        concept({ id: "min", title: "Minimal Badge" }),
      ],
      shirtColor: "Black",
    });
    assert.match(html, /Soft Illustrated/);
    assert.doesNotMatch(html, /garmentMatchingFraction|paletteCoverage|hard_fail/i);
    assert.doesNotMatch(html, /cannot be printed/i);
  });

  it("N/S/T: two-card short set explains withheld concept safely", () => {
    const html = render({
      concepts: [
        concept({ id: "a", title: "Bold" }),
        concept({ id: "b", title: "Minimal" }),
      ],
      conceptsWithheld: 1,
    });
    assert.match(html, /data-concept-card-count="2"/);
    assert.match(html, /sm:grid-cols-2/);
    assert.doesNotMatch(html, /sm:grid-cols-3/);
    assert.match(html, /data-concept-short-set-note="true"/);
    assert.match(html, /required print instructions/i);
    assert.doesNotMatch(html, /Phase 2B|paletteCoverage|hard_palette/i);
  });

  it("O: one-card layout stays compact", () => {
    const html = render({
      concepts: [concept({ id: "only", title: "Bold" })],
      conceptsWithheld: 2,
    });
    assert.match(html, /data-concept-card-count="1"/);
    assert.match(html, /max-w-sm/);
    assert.match(html, /1 concept that matches/i);
  });

  it("P: zero concepts render nothing (failure path owns recovery)", () => {
    const html = render({ concepts: [] });
    assert.equal(html, "");
  });

  it("E: deferred garment uses transparency card surface", () => {
    const html = render({
      concepts: [concept()],
      shirtColor: null,
      deferredSections: ["productColor"],
    });
    assert.match(html, /data-concept-card-surface="transparency"/);
    assert.doesNotMatch(html, /On Black/);
  });

  it("non-apparel does not force garment semantics", () => {
    const html = render({
      concepts: [concept()],
      shirtColor: "Black",
      productSummary: "yard sign",
    });
    assert.match(html, /data-concept-card-surface="transparency"/);
  });

  it("white / navy garment labels stay honest", () => {
    assert.match(
      render({ concepts: [concept()], shirtColor: "White" }),
      /On White/,
    );
    assert.match(
      render({ concepts: [concept()], shirtColor: "Navy" }),
      /On Navy/,
    );
  });

  it("K/L/W: rendering never selects and never invents paid work", () => {
    // onSelect throws if invoked — reaching assertions proves no selection.
    const html = render({
      concepts: [concept({ id: "soft", title: "Soft" })],
      selectable: true,
    });
    assert.match(html, /View Soft full size/);
    // Resolver remains pure presentation.
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Black",
      productSummary: "T-shirt",
    });
    assert.equal(resolved.cssColor, "#000000");
  });
});
