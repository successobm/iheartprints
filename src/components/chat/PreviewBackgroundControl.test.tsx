import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { PreviewBackgroundControl } from "./PreviewBackgroundControl";
import {
  DEFAULT_CUSTOM_PREVIEW_COLOR,
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_BACKGROUND_COLORS,
  PREVIEW_BACKGROUND_COPY,
} from "./preview-background";

describe("PreviewBackgroundControl", () => {
  it("renders White / Gray / Black with radiogroup semantics", () => {
    const html = renderToString(
      createElement(PreviewBackgroundControl, {
        value: DEFAULT_PREVIEW_BACKGROUND,
        onChange: () => {},
        customColor: DEFAULT_CUSTOM_PREVIEW_COLOR,
        onCustomColorChange: () => {},
      }),
    );

    assert.match(html, /role="radiogroup"/);
    assert.match(html, new RegExp(PREVIEW_BACKGROUND_COPY.label));
    // Tracks whatever the default is rather than pinning a colour here — the
    // default itself is asserted once, in `preview-background.test.ts`.
    assert.match(
      html,
      new RegExp(`data-preview-background="${DEFAULT_PREVIEW_BACKGROUND}"`),
    );
    assert.match(
      html,
      new RegExp(
        `data-preview-background-option="${DEFAULT_PREVIEW_BACKGROUND}"[^>]*aria-checked="true"` +
          `|aria-checked="true"[^>]*data-preview-background-option="${DEFAULT_PREVIEW_BACKGROUND}"`,
      ),
      "the default surface must be the selected one",
    );
    assert.match(html, /data-preview-background-option="white"/);
    assert.match(html, /data-preview-background-option="gray"/);
    assert.match(html, /data-preview-background-option="black"/);
    assert.match(html, /aria-checked="true"/);
    assert.match(html, />White</);
    assert.match(html, />Gray</);
    assert.match(html, />Black</);
    assert.doesNotMatch(html, /matte|alpha|composit/i);
  });

  it("marks the selected option for assistive technology", () => {
    const html = renderToString(
      createElement(PreviewBackgroundControl, {
        value: "black",
        onChange: () => {},
        customColor: DEFAULT_CUSTOM_PREVIEW_COLOR,
        onCustomColorChange: () => {},
      }),
    );

    assert.match(html, /data-preview-background="black"/);
    assert.match(
      html,
      /data-preview-background-option="black"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-preview-background-option="black"/,
    );
    assert.match(
      html,
      /data-preview-background-option="white"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-preview-background-option="white"/,
    );
    assert.equal(PREVIEW_BACKGROUND_COLORS.black, "#000000");
  });

  /**
   * DTF Custom Preview Background Phase.
   */
  describe("Custom Color", () => {
    it("CASE 9 — the custom color control has an accessible label/name, and preset controls keep their radio semantics", () => {
      const html = renderToString(
        createElement(PreviewBackgroundControl, {
          value: DEFAULT_PREVIEW_BACKGROUND,
          onChange: () => {},
          customColor: "#1F3FAF",
          onCustomColorChange: () => {},
        }),
      );

      assert.match(html, /type="color"/);
      assert.match(
        html,
        new RegExp(`aria-label="${PREVIEW_BACKGROUND_COPY.customColorInputLabel}"`),
      );
      // The native input is wrapped by a <label for=...> — the
      // accessible-name association a screen reader relies on.
      assert.match(html, /<label[^>]*for="[^"]*-custom-input"/);
      assert.match(html, /id="[^"]*-custom-input"/);
      // Presets are entirely unaffected: still real radios with real names.
      for (const option of ["white", "gray", "black"] as const) {
        assert.match(html, new RegExp(`role="radio"[^>]*data-preview-background-option="${option}"|data-preview-background-option="${option}"[^>]*role="radio"`));
        assert.match(html, new RegExp(`aria-label="${PREVIEW_BACKGROUND_COPY.options[option]}"`));
      }
    });

    it("renders a Custom Color option alongside White / Gray / Black, never replacing them", () => {
      const html = renderToString(
        createElement(PreviewBackgroundControl, {
          value: DEFAULT_PREVIEW_BACKGROUND,
          onChange: () => {},
          customColor: DEFAULT_CUSTOM_PREVIEW_COLOR,
          onCustomColorChange: () => {},
        }),
      );

      assert.match(html, /data-preview-background-option="custom"/);
      assert.match(html, new RegExp(PREVIEW_BACKGROUND_COPY.options.custom));
      assert.match(html, /data-preview-background-option="white"/);
      assert.match(html, /data-preview-background-option="gray"/);
      assert.match(html, /data-preview-background-option="black"/);
    });

    it("marks Custom Color as the active surface when selected, and shows its swatch/hex", () => {
      const html = renderToString(
        createElement(PreviewBackgroundControl, {
          value: "custom",
          onChange: () => {},
          customColor: "#ff0000",
          onCustomColorChange: () => {},
        }),
      );

      assert.match(
        html,
        /data-preview-background-option="custom"[^>]*data-selected="true"|data-selected="true"[^>]*data-preview-background-option="custom"/,
      );
      assert.match(html, /#FF0000/);
      assert.match(html, /data-custom-color-swatch/);
      // The presets are all correctly deselected while custom is active.
      for (const option of ["white", "gray", "black"] as const) {
        assert.match(
          html,
          new RegExp(`data-preview-background-option="${option}"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-preview-background-option="${option}"`),
        );
      }
    });

    it("an optional garment preset chip renders only when provided, and reuses the resolved label/hex", () => {
      const withGarment = renderToString(
        createElement(PreviewBackgroundControl, {
          value: DEFAULT_PREVIEW_BACKGROUND,
          onChange: () => {},
          customColor: DEFAULT_CUSTOM_PREVIEW_COLOR,
          onCustomColorChange: () => {},
          garmentPreset: { label: "Blue", hex: "#1F3FAF" },
        }),
      );
      assert.match(withGarment, /Garment: Blue/);
      assert.match(withGarment, /#1F3FAF/);

      const withoutGarment = renderToString(
        createElement(PreviewBackgroundControl, {
          value: DEFAULT_PREVIEW_BACKGROUND,
          onChange: () => {},
          customColor: DEFAULT_CUSTOM_PREVIEW_COLOR,
          onCustomColorChange: () => {},
          garmentPreset: null,
        }),
      );
      assert.doesNotMatch(withoutGarment, /Garment:/);
    });

    it("disabling the control disables the custom color input too", () => {
      const html = renderToString(
        createElement(PreviewBackgroundControl, {
          value: DEFAULT_PREVIEW_BACKGROUND,
          onChange: () => {},
          customColor: DEFAULT_CUSTOM_PREVIEW_COLOR,
          onCustomColorChange: () => {},
          disabled: true,
        }),
      );

      assert.match(html, /data-preview-custom-color-input[^>]*disabled|disabled[^>]*data-preview-custom-color-input/);
    });
  });
});
