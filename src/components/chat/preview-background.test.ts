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
  it("defaults to White for QA inspection", () => {
    assert.equal(DEFAULT_PREVIEW_BACKGROUND, "white");
    assert.equal(PREVIEW_BACKGROUND_COLORS.white, "#FFFFFF");
    assert.equal(PREVIEW_BACKGROUND_COLORS.black, "#000000");
    assert.match(PREVIEW_BACKGROUND_COLORS.gray, /^#[0-9A-Fa-f]{6}$/);
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
