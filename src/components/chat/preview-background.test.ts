import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  candidateHighlightFrameClassName,
  CUSTOM_PREVIEW_SURFACE,
  DEFAULT_CUSTOM_PREVIEW_COLOR,
  DEFAULT_PREVIEW_BACKGROUND,
  garmentPresetChipLabel,
  isPreviewBackground,
  isPreviewSurface,
  isValidHexColor,
  normalizeHexColor,
  PREVIEW_BACKGROUND_COLORS,
  PREVIEW_BACKGROUND_COPY,
  PREVIEW_BACKGROUNDS,
  previewBackgroundSurfaceStyle,
  previewSurfaceStyle,
  resolveGarmentPreviewColor,
  resolvePreviewSurfaceHex,
  sameHexColor,
} from "./preview-background";

describe("preview-background (Phase 1.5)", () => {
  /**
   * A: the default is GRAY, and this is the assertion that keeps it there.
   *
   * It used to be White, on the reasoning that white is the strongest surface
   * for spotting dark residue. It is — and it is simultaneously the surface on
   * which white artwork becomes invisible. The audited bowling logo is drawn
   * for a dark garment (white ring, white tagline, white pin bodies), so a
   * white default hid intact, fully-opaque artwork and made a correct
   * preparation look destructive right at the approval decision.
   *
   * Gray is the only default that is neutral to both halves of the artwork.
   */
  it("A: defaults to Gray so neither light nor dark artwork is hidden", () => {
    assert.equal(DEFAULT_PREVIEW_BACKGROUND, "gray");

    // Genuinely mid-tone: far enough from both extremes that white artwork and
    // black artwork each retain contrast against it.
    const gray = PREVIEW_BACKGROUND_COLORS.gray;
    assert.match(gray, /^#[0-9A-Fa-f]{6}$/);
    const level = parseInt(gray.slice(1, 3), 16);
    assert.ok(
      level > 0x40 && level < 0xe0,
      `gray must stay a mid-tone, got ${gray}`,
    );
  });

  it("B+C: White and Black both remain selectable inspection choices", () => {
    assert.ok(PREVIEW_BACKGROUNDS.includes("white"));
    assert.ok(PREVIEW_BACKGROUNDS.includes("black"));
    assert.equal(PREVIEW_BACKGROUND_COLORS.white, "#FFFFFF");
    assert.equal(PREVIEW_BACKGROUND_COLORS.black, "#000000");
    assert.equal(isPreviewBackground("white"), true);
    assert.equal(isPreviewBackground("black"), true);
  });

  it("tells the customer what each surface is actually good for", () => {
    const tip = PREVIEW_BACKGROUND_COPY.approvalTip;
    assert.match(tip, /Gray/);
    assert.match(tip, /White/);
    assert.match(tip, /Black/);
  });

  it("C: surface style is presentation-only solid colors", () => {
    for (const background of PREVIEW_BACKGROUNDS) {
      const style = previewBackgroundSurfaceStyle(background);
      assert.deepEqual(Object.keys(style), ["backgroundColor"]);
      assert.equal(style.backgroundColor, PREVIEW_BACKGROUND_COLORS[background]);
      assert.equal("backgroundImage" in style, false);
    }
  });

  it("exposes customer-friendly labels without technical jargon", () => {
    assert.equal(PREVIEW_BACKGROUND_COPY.label, "Preview Background");
    assert.equal(PREVIEW_BACKGROUND_COPY.options.white, "White");
    assert.equal(PREVIEW_BACKGROUND_COPY.options.gray, "Gray");
    assert.equal(PREVIEW_BACKGROUND_COPY.options.black, "Black");
    assert.doesNotMatch(
      JSON.stringify(PREVIEW_BACKGROUND_COPY),
      /matte|alpha|composit|transparenc/i,
    );
  });

  it("candidate highlight frame is not color-only", () => {
    const frame = candidateHighlightFrameClassName();
    assert.match(frame, /border-dashed/);
    assert.match(frame, /amber/);
    assert.match(frame, /repeating-linear-gradient|shadow/);
  });

  it("validates preview background tokens", () => {
    assert.equal(isPreviewBackground("white"), true);
    assert.equal(isPreviewBackground("gray"), true);
    assert.equal(isPreviewBackground("black"), true);
    assert.equal(isPreviewBackground("magenta"), false);
  });
});

/**
 * DTF Custom Preview Background Phase: a customer's own arbitrary colour
 * (any RGB/hex), previewed against the transparent PREPARED artwork only —
 * White / Gray / Black keep working exactly as before. This is a
 * presentation-only CSS layer: these tests hold the same invariant the
 * existing suite above already does (`backgroundColor` only, nothing that
 * could ever touch the artwork's own pixels), extended to the 4th option.
 */
describe("preview-background — Custom Color (DTF Custom Preview Background Phase)", () => {
  it("CASE 1 — White / Gray / Black are entirely unaffected by adding Custom Color", () => {
    assert.deepEqual([...PREVIEW_BACKGROUNDS], ["white", "gray", "black"]);
    for (const preset of PREVIEW_BACKGROUNDS) {
      assert.equal(resolvePreviewSurfaceHex(preset, "#123456"), PREVIEW_BACKGROUND_COLORS[preset]);
      assert.deepEqual(previewSurfaceStyle(preset, "#123456"), previewBackgroundSurfaceStyle(preset));
    }
  });

  it("CASE 2 — selecting a custom color changes the resolved Prepared preview surface", () => {
    const white = previewSurfaceStyle("white", "#1F3FAF");
    const custom = previewSurfaceStyle("custom", "#1F3FAF");
    assert.notDeepEqual(white, custom);
    assert.equal(custom.backgroundColor, "#1F3FAF");
  });

  it("CASE 3 — arbitrary Blue, Red, and Green values work with no special-case code, and every distinct hex resolves to itself", () => {
    const samples = ["#1F3FAF", "#FF0000", "#008000", "#FFA500", "#800080", "#F5F5DC"];
    for (const hex of samples) {
      assert.equal(resolvePreviewSurfaceHex(CUSTOM_PREVIEW_SURFACE, hex), hex.toUpperCase());
      assert.equal(previewSurfaceStyle(CUSTOM_PREVIEW_SURFACE, hex).backgroundColor, hex.toUpperCase());
    }
    // No two distinct inputs collapse to the same output — this is a
    // generic pass-through, never a lookup table with fixed entries.
    const resolved = samples.map((hex) => resolvePreviewSurfaceHex(CUSTOM_PREVIEW_SURFACE, hex));
    assert.equal(new Set(resolved).size, samples.length);
  });

  it("CASE 4 — the surface style is presentation-only for custom too: only `backgroundColor`, nothing that could touch artwork pixels", () => {
    for (const hex of ["#1F3FAF", "#FF0000", "#008000"]) {
      const style = previewSurfaceStyle("custom", hex);
      assert.deepEqual(Object.keys(style), ["backgroundColor"]);
      assert.equal("backgroundImage" in style, false);
      assert.equal("opacity" in style, false);
      assert.equal("mixBlendMode" in style, false);
      assert.equal("filter" in style, false);
    }
    // Structural guarantee, not just an empirical one: neither function
    // that resolves a preview surface takes an image/pixel argument at all
    // — there is nothing for a preview colour choice to alter.
    assert.equal(resolvePreviewSurfaceHex.length, 2);
    assert.equal(previewSurfaceStyle.length, 2);
  });

  it("CASE 5/6 — purity: the same (surface, color) input always resolves to the same output, independent of call order or prior calls — the one property that makes 'opaque art stays opaque, transparency reveals the background' true regardless of what artwork is actually being viewed", () => {
    const first = previewSurfaceStyle("black", "#1F3FAF");
    previewSurfaceStyle("custom", "#FF0000");
    previewSurfaceStyle("custom", "#008000");
    const second = previewSurfaceStyle("black", "#1F3FAF");
    assert.deepEqual(first, second);
  });

  it("CASE 8 — switching White → Custom → Black → Custom resolves deterministically at every step", () => {
    const sequence: Array<[import("./preview-background").PreviewSurface, string]> = [
      ["white", DEFAULT_CUSTOM_PREVIEW_COLOR],
      ["custom", "#1F3FAF"],
      ["black", "#1F3FAF"],
      ["custom", "#FF0000"],
    ];
    const results = sequence.map(([surface, hex]) => previewSurfaceStyle(surface, hex).backgroundColor);
    assert.deepEqual(results, ["#FFFFFF", "#1F3FAF", "#000000", "#FF0000"]);
  });

  it("an invalid or empty custom value never reaches CSS un-sanitized — falls back to the documented default", () => {
    assert.equal(resolvePreviewSurfaceHex("custom", ""), DEFAULT_CUSTOM_PREVIEW_COLOR);
    assert.equal(resolvePreviewSurfaceHex("custom", "not-a-color"), DEFAULT_CUSTOM_PREVIEW_COLOR);
    assert.equal(resolvePreviewSurfaceHex("custom", "#12"), DEFAULT_CUSTOM_PREVIEW_COLOR);
  });

  it("validates and normalizes hex colors", () => {
    assert.equal(isValidHexColor("#1F3FAF"), true);
    assert.equal(isValidHexColor("#1f3faf"), true);
    assert.equal(isValidHexColor("1F3FAF"), false);
    assert.equal(isValidHexColor("#1F3"), false);
    assert.equal(isValidHexColor(""), false);
    assert.equal(normalizeHexColor(" #1f3faf "), "#1F3FAF");
    assert.equal(normalizeHexColor("garbage"), null);
  });

  it("sameHexColor compares case-insensitively", () => {
    assert.equal(sameHexColor("#1f3faf", "#1F3FAF"), true);
    assert.equal(sameHexColor("#FF0000", "#00FF00"), false);
  });

  it("exposes an accessible label for the native color input and a Custom Color option label", () => {
    assert.equal(PREVIEW_BACKGROUND_COPY.options.custom, "Custom Color");
    assert.match(PREVIEW_BACKGROUND_COPY.customColorInputLabel, /color/i);
  });

  it("the preview-only clarification is present in the existing helper copy, without alarming/warning language", () => {
    assert.match(PREVIEW_BACKGROUND_COPY.helper, /never be added|never added/i);
    assert.doesNotMatch(PREVIEW_BACKGROUND_COPY.helper, /warning|error|danger/i);
    // The original phrase this copy is pinned by elsewhere must survive verbatim.
    assert.match(
      PREVIEW_BACKGROUND_COPY.helper,
      /Check your artwork on different backgrounds before approving it/,
    );
  });

  it("isPreviewSurface recognizes all four surfaces and rejects anything else", () => {
    assert.equal(isPreviewSurface("white"), true);
    assert.equal(isPreviewSurface("gray"), true);
    assert.equal(isPreviewSurface("black"), true);
    assert.equal(isPreviewSurface("custom"), true);
    assert.equal(isPreviewSurface("magenta"), false);
  });

  it("garmentPresetChipLabel formats the customer's own stated colour, unrelabeled", () => {
    assert.equal(garmentPresetChipLabel("Blue"), "Garment: Blue");
    assert.equal(garmentPresetChipLabel("Royal Blue"), "Garment: Royal Blue");
  });
});

/**
 * CASE 10 — the customer's already-entered garment colour can safely
 * initialize the custom preview, via the SAME resolver
 * (`resolveGarmentColor`) the sibling `garment-preview-surface.ts` already
 * trusts — never a second parsing implementation, and never affecting
 * artwork pixels either way.
 */
describe("preview-background — resolveGarmentPreviewColor (CASE 10)", () => {
  it("a resolvable garment colour like Blue resolves to a real hex and its own stated label", () => {
    const resolved = resolveGarmentPreviewColor("Blue");
    assert.ok(resolved);
    assert.equal(resolved!.label, "Blue");
    assert.equal(resolved!.hex, "#1F3FAF");
  });

  it("an unresolvable, empty, or missing garment colour returns null — never a guess, never a default colour", () => {
    for (const input of ["Heather Blue", "", "   ", "not-a-colour", null, undefined]) {
      assert.equal(resolveGarmentPreviewColor(input), null);
    }
  });

  it("distinct recognized garment colours resolve to distinct hexes", () => {
    const blue = resolveGarmentPreviewColor("Blue");
    const red = resolveGarmentPreviewColor("Red");
    const navy = resolveGarmentPreviewColor("Navy");
    assert.ok(blue && red && navy);
    assert.notEqual(blue!.hex, red!.hex);
    assert.notEqual(blue!.hex, navy!.hex);
  });

  it("never mutates or depends on any artwork/pixel data — a pure string-in, colour-out resolver", () => {
    assert.equal(resolveGarmentPreviewColor.length, 1);
  });
});

/**
 * CASE 4 — Production pixel isolation, at the architecture level: none of
 * the actual pixel-producing authorities (the deterministic classifier, the
 * removal-mask/master builder, or the capability that derives the prepared
 * PNG that gets approved/downloaded) import this presentation-only preview
 * module or its control at all. There is no code path for a preview colour
 * choice to reach production bytes through, structurally — not merely by
 * behavior observed in a specific test run.
 */
describe("preview-background — architectural isolation from production pixels (CASE 4)", () => {
  const PRODUCTION_AUTHORITY_FILES = [
    ["capabilities", "artwork-preparation", "artwork-preparation-capability.ts"],
    ["capabilities", "artwork-preparation", "region-separation.ts"],
    ["capabilities", "artwork-preparation", "image-analysis.ts"],
    ["capabilities", "artwork-preparation", "repairability.ts"],
  ];

  it("no production-pixel authority imports the preview-background module or its control", () => {
    for (const parts of PRODUCTION_AUTHORITY_FILES) {
      const source = readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");
      assert.doesNotMatch(
        source,
        /from ["'].*preview-background["']/,
        `${parts.join("/")} must never import the client-only preview module`,
      );
      assert.doesNotMatch(
        source,
        /PreviewBackgroundControl/,
        `${parts.join("/")} must never reference the preview control`,
      );
    }
  });
});
