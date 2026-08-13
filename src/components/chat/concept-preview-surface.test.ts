import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONCEPT_INSPECTION_COLORS,
  UNKNOWN_GARMENT_NEUTRAL_HEX,
  availableConceptPreviewModes,
  conceptCardGarmentHint,
  conceptCardsGridClassName,
  conceptPreviewSurfaceStyle,
  defaultConceptPreviewMode,
  resolveGarmentPreviewColor,
  shortConceptSetNote,
  transparencySurfaceStyle,
} from "./concept-preview-surface";

describe("concept-preview-surface (Phase 2D)", () => {
  it("A: black garment → black preview surface", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Black",
      productSummary: "T-shirt",
    });
    assert.equal(resolved.useGarmentPreview, true);
    assert.equal(resolved.cssColor, "#000000");
    assert.equal(resolved.label, "Black");
    assert.equal(defaultConceptPreviewMode(resolved), "garment");
    assert.deepEqual(conceptPreviewSurfaceStyle("garment", resolved), {
      backgroundColor: "#000000",
    });
  });

  it("B: white garment → white preview surface", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "White",
      productSummary: "hoodie",
    });
    assert.equal(resolved.cssColor, "#FFFFFF");
    assert.deepEqual(conceptPreviewSurfaceStyle("garment", resolved), {
      backgroundColor: "#FFFFFF",
    });
  });

  it("C: navy garment → navy preview surface", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Navy",
      productSummary: "crewneck",
    });
    assert.equal(resolved.cssColor, "#000080");
    assert.equal(resolved.resolvedFrom, "named");
  });

  it("D: unknown garment → neutral fallback, label retained", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Aurora Mist",
      productSummary: "T-shirt",
    });
    assert.equal(resolved.useGarmentPreview, true);
    assert.equal(resolved.cssColor, UNKNOWN_GARMENT_NEUTRAL_HEX);
    assert.equal(resolved.resolvedFrom, "neutral_fallback");
    assert.equal(resolved.label, "Aurora Mist");
    assert.notEqual(resolved.cssColor, "#000000");
  });

  it("E: deferred garment → no garment surface (transparency default)", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: null,
      deferredSections: ["productColor"],
      productSummary: "T-shirt",
    });
    assert.equal(resolved.useGarmentPreview, false);
    assert.equal(resolved.resolvedFrom, "deferred");
    assert.equal(defaultConceptPreviewMode(resolved), "transparency");
    assert.ok("backgroundImage" in conceptPreviewSurfaceStyle("garment", resolved));
  });

  it("F: garment preview is CSS / presentation only", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Red",
      productSummary: "shirt",
    });
    const style = conceptPreviewSurfaceStyle("garment", resolved);
    assert.deepEqual(Object.keys(style), ["backgroundColor"]);
    assert.equal(style.backgroundColor, "#C81010");
  });

  it("G/H/I/J: inspection modes White / Gray / Black / Transparency", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Black",
      productSummary: "T-shirt",
    });
    assert.equal(
      conceptPreviewSurfaceStyle("white", resolved).backgroundColor,
      CONCEPT_INSPECTION_COLORS.white,
    );
    assert.equal(
      conceptPreviewSurfaceStyle("gray", resolved).backgroundColor,
      CONCEPT_INSPECTION_COLORS.gray,
    );
    assert.equal(
      conceptPreviewSurfaceStyle("black", resolved).backgroundColor,
      CONCEPT_INSPECTION_COLORS.black,
    );
    assert.deepEqual(
      conceptPreviewSurfaceStyle("transparency", resolved),
      transparencySurfaceStyle(),
    );
  });

  it("prefers hex garment colors from the brief", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "#1a2b3c",
      productSummary: "tee",
    });
    assert.equal(resolved.resolvedFrom, "hex");
    assert.equal(resolved.cssColor, "#1A2B3C");
  });

  it("non-apparel keeps transparency default and no garment mode", () => {
    const resolved = resolveGarmentPreviewColor({
      shirtColor: "Black",
      productSummary: "yard sign",
    });
    assert.equal(resolved.isApparel, false);
    assert.equal(resolved.useGarmentPreview, false);
    assert.equal(defaultConceptPreviewMode(resolved), "transparency");
    assert.deepEqual(availableConceptPreviewModes(resolved), [
      "white",
      "gray",
      "black",
      "transparency",
    ]);
  });

  it("M/N/O: layout classes for 3 / 2 / 1 concepts", () => {
    assert.match(conceptCardsGridClassName(3), /sm:grid-cols-3/);
    assert.match(conceptCardsGridClassName(2), /sm:grid-cols-2/);
    assert.doesNotMatch(conceptCardsGridClassName(2), /sm:grid-cols-3/);
    assert.match(conceptCardsGridClassName(1), /max-w-sm/);
    assert.doesNotMatch(conceptCardsGridClassName(1), /sm:grid-cols-3/);
  });

  it("S/T/U: safe short-set copy hides internal reason codes", () => {
    const note = shortConceptSetNote({ visibleCount: 2, conceptsWithheld: 1 });
    assert.ok(note);
    assert.match(note!, /2 concepts that match your required print instructions/i);
    assert.match(note!, /One concept was not shown/i);
    assert.doesNotMatch(
      note!,
      /paletteCoverage|garmentMatching|hard_fail|Phase 2B|FAIL|WARN/i,
    );

    assert.equal(shortConceptSetNote({ visibleCount: 3, conceptsWithheld: 0 }), null);
    assert.equal(shortConceptSetNote({ visibleCount: 0, conceptsWithheld: 3 }), null);

    const one = shortConceptSetNote({ visibleCount: 1, conceptsWithheld: 2 });
    assert.ok(one);
    assert.match(one!, /1 concept that matches/i);
  });

  it("Z/Harley: advisory Soft remains a visible card concern — UI keeps all three equal", () => {
    // Presentation helpers never rank or withhold; cards receive whatever
    // the server delivered. Three visible concepts → no short-set note.
    assert.equal(
      shortConceptSetNote({ visibleCount: 3, conceptsWithheld: null }),
      null,
    );
    const black = resolveGarmentPreviewColor({
      shirtColor: "Black",
      productSummary: "Black T-shirt",
    });
    assert.equal(conceptCardGarmentHint(black), "On Black");
    assert.equal(black.cssColor, "#000000");
  });

  it("W: helpers never expose a paid-provider seam", () => {
    const moduleSource = [
      "resolveGarmentPreviewColor",
      "conceptPreviewSurfaceStyle",
      "shortConceptSetNote",
    ].join("|");
    assert.match(moduleSource, /resolveGarmentPreviewColor/);
    // Pure functions: calling them allocates no network / provider handles.
    resolveGarmentPreviewColor({ shirtColor: "Navy", productSummary: "shirt" });
    shortConceptSetNote({ visibleCount: 2, conceptsWithheld: 1 });
  });
});
