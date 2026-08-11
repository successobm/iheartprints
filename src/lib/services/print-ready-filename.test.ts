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

  // --- Existing Artwork → Print Ready Phase 2 (scenario Y) -----------------

  it("Y: names an uploaded artwork's deliverable after the customer's own file", () => {
    assert.equal(
      buildPrintReadyFilename({
        uploadedFilename: "Split Disturbers.png",
        // The only brief text an upload project ever has describes the
        // garment, not the design — the customer would not recognize it.
        productSummary: "T-shirts for our bowling team",
        mimeType: "image/png",
      }),
      "split-disturbers-print-ready.png",
    );
  });

  it("Y: drops the uploaded file's own extension rather than carrying it onto a PNG", () => {
    assert.equal(
      buildPrintReadyFilename({
        uploadedFilename: "team-logo.jpeg",
        mimeType: "image/png",
      }),
      "team-logo-print-ready.png",
    );
  });

  it("Y: an uploaded name still gets sanitized, and never embeds an id", () => {
    const name = buildPrintReadyFilename({
      uploadedFilename: '3 Sons "Bowling"/Logo v2.PNG',
      mimeType: "image/png",
    });
    assert.equal(name, "3-sons-bowling-logo-v2-print-ready.png");
    assert.doesNotMatch(name, /[\\/:*?"<>|]/);
  });

  it("Y: falls back to brief wording when there is no uploaded filename", () => {
    assert.equal(
      buildPrintReadyFilename({
        uploadedFilename: null,
        exactText: "Camp Wildwood 2026",
        mimeType: "image/png",
      }),
      "camp-wildwood-2026-print-ready.png",
    );
    assert.equal(
      buildPrintReadyFilename({
        uploadedFilename: "   ",
        productSummary: "T-shirt",
        mimeType: "image/png",
      }),
      "t-shirt-print-ready.png",
    );
  });
});
