import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  candidateHighlightFrameClassName,
  DEFAULT_PREVIEW_BACKGROUND,
  isPreviewBackground,
  PREVIEW_BACKGROUND_COLORS,
  PREVIEW_BACKGROUND_COPY,
  PREVIEW_BACKGROUNDS,
  previewBackgroundSurfaceStyle,
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
