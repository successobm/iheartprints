import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPrintReadyFilename } from "./print-ready-filename";

describe("buildPrintReadyFilename", () => {
  it("E: builds a sanitized customer-safe name from exact wording", () => {
    assert.equal(
      buildPrintReadyFilename({
        exactText: "1988 Toyota MR2",
        mimeType: "image/png",
      }),
      "1988-toyota-mr2-print-ready.png",
    );
  });

  it("E: strips unsafe filesystem characters and never embeds UUIDs", () => {
    const name = buildPrintReadyFilename({
      exactText: 'Camp "Wildwood"/2026?',
      mimeType: "image/png",
    });
    assert.equal(name, "camp-wildwood-2026-print-ready.png");
    assert.doesNotMatch(name, /[\\/:*?"<>|]/);
    assert.doesNotMatch(
      name,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("falls back when wording is missing", () => {
    assert.equal(
      buildPrintReadyFilename({
        productSummary: "T-shirt",
        mimeType: "image/png",
      }),
      "t-shirt-print-ready.png",
    );
    assert.equal(
      buildPrintReadyFilename({ mimeType: "image/png" }),
      "print-ready-artwork.png",
    );
  });
});
