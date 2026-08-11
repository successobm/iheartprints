import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { PreviewBackgroundControl } from "./PreviewBackgroundControl";
import {
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
      }),
    );

    assert.match(html, /role="radiogroup"/);
    assert.match(html, new RegExp(PREVIEW_BACKGROUND_COPY.label));
    assert.match(html, /data-preview-background="white"/);
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
});
