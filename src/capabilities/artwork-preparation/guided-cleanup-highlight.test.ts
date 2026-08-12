import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { buildSelectionHighlight } from "./guided-cleanup-candidate";

describe("Magic Select selection highlight", () => {
  it("solid fill paints every selected pixel amber (visible on Black QA)", () => {
    const mask = new Uint8Array(8);
    mask[0] = 1;
    mask[3] = 1;
    const highlight = buildSelectionHighlight(
      mask,
      4,
      2,
      { left: 0, top: 0, right: 4, bottom: 2, width: 4, height: 2 },
      "solid",
    );
    const png = Buffer.from(highlight.overlayDataUrl.split(",")[1]!, "base64");
    const overlay = PNG.sync.read(png);
    const a = overlay.data;
    assert.equal(a[0], 245);
    assert.equal(a[1], 158);
    assert.equal(a[2], 11);
    assert.equal(a[3], 210);
    assert.equal(a[3 * 4], 245);
    assert.equal(a[3 * 4 + 3], 210);
    assert.equal(a[1 * 4 + 3], 0);
  });

  it("hatch fill remains the region-select treatment", () => {
    const mask = new Uint8Array(4);
    mask[0] = 1;
    mask[3] = 1;
    const highlight = buildSelectionHighlight(
      mask,
      2,
      2,
      { left: 0, top: 0, right: 2, bottom: 2, width: 2, height: 2 },
      "hatch",
    );
    const png = Buffer.from(highlight.overlayDataUrl.split(",")[1]!, "base64");
    const overlay = PNG.sync.read(png);
    assert.equal(overlay.data[0], 245);
    assert.equal(overlay.data[3 * 4], 28);
  });
});
