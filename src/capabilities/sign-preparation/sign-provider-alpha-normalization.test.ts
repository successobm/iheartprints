import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { normalizeProviderAlphaOnVerifiedOpaqueSource } from "./sign-provider-alpha-normalization";

/**
 * Signs Phase S3D: direct, isolated coverage of the pure alpha-only
 * canonicalization the real Ruth acceptance run's forensic audit motivated
 * — see the module's own doc comment for the exact pixel-level evidence
 * (83.9% of pixels at alpha=254 spread across the whole canvas; the
 * remaining defect entirely confined to the 1px border ring; RGB beneath
 * every audited low-alpha pixel matching the proportional source colour).
 */

function image(width: number, height: number, fill: [number, number, number, number]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { width, height, data };
}

function setAlpha(img: RgbaImage, x: number, y: number, alpha: number): void {
  img.data[(y * img.width + x) * 4 + 3] = alpha;
}

function setPixel(img: RgbaImage, x: number, y: number, rgba: [number, number, number, number]): void {
  const idx = (y * img.width + x) * 4;
  img.data[idx] = rgba[0];
  img.data[idx + 1] = rgba[1];
  img.data[idx + 2] = rgba[2];
  img.data[idx + 3] = rgba[3];
}

describe("normalizeProviderAlphaOnVerifiedOpaqueSource (Signs Phase S3D)", () => {
  it("1: fully opaque source + provider alpha=254 everywhere — restored to 255, RGB unchanged", () => {
    const source = image(4, 4, [0, 0, 0, 255]); // verified fully opaque
    const reconstructed = image(4, 4, [12, 34, 56, 254]);

    const { image: result, evidence } = normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.ok(evidence);
    assert.equal(evidence!.reason, "provider_introduced_alpha_on_verified_opaque_source");
    assert.equal(evidence!.strategy, "force_opaque_preserve_rgb");
    assert.equal(evidence!.affectedPixelCount, 16);
    assert.equal(evidence!.minAlphaBefore, 254);
    assert.equal(evidence!.maxAlphaBefore, 254);
    assert.equal(evidence!.minAlphaAfter, 255);
    assert.equal(evidence!.maxAlphaAfter, 255);
    assert.equal(evidence!.rgbModified, false);
    assert.equal(evidence!.widthPx, 4);
    assert.equal(evidence!.heightPx, 4);

    for (let i = 0; i < result.data.length; i += 4) {
      assert.equal(result.data[i], 12);
      assert.equal(result.data[i + 1], 34);
      assert.equal(result.data[i + 2], 56);
      assert.equal(result.data[i + 3], 255);
    }
  });

  it("2: fully opaque source + provider alpha=0 with meaningful RGB — alpha restored, RGB preserved exactly", () => {
    const source = image(3, 3, [0, 0, 0, 255]);
    const reconstructed = image(3, 3, [0, 0, 0, 255]);
    // A border pixel with alpha=0 but real, meaningful colour underneath —
    // exactly the real Ruth pattern (orange text edge at alpha=0).
    setPixel(reconstructed, 0, 0, [253, 121, 2, 0]);

    const { image: result, evidence } = normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.ok(evidence);
    assert.equal(evidence!.affectedPixelCount, 1);
    assert.equal(evidence!.minAlphaBefore, 0);
    assert.equal(evidence!.maxAlphaBefore, 255);

    const idx = 0;
    assert.equal(result.data[idx], 253);
    assert.equal(result.data[idx + 1], 121);
    assert.equal(result.data[idx + 2], 2);
    assert.equal(result.data[idx + 3], 255, "alpha forced to opaque, RGB byte-identical");
  });

  it("3: mixed provider alpha values (0, 1-253, 254, 255) — output is uniformly alpha=255, every RGB byte-identical to input", () => {
    const source = image(4, 1, [0, 0, 0, 255]);
    const reconstructed = image(4, 1, [0, 0, 0, 255]);
    setPixel(reconstructed, 0, 0, [10, 20, 30, 0]);
    setPixel(reconstructed, 1, 0, [40, 50, 60, 120]);
    setPixel(reconstructed, 2, 0, [70, 80, 90, 254]);
    setPixel(reconstructed, 3, 0, [100, 110, 120, 255]);

    const before = Buffer.from(reconstructed.data); // snapshot for RGB comparison
    const { image: result, evidence } = normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.ok(evidence);
    assert.equal(evidence!.affectedPixelCount, 3, "only the three non-255 pixels are counted, not the already-opaque one");
    for (let i = 0; i < result.data.length; i += 4) {
      assert.equal(result.data[i], before[i], "R unchanged");
      assert.equal(result.data[i + 1], before[i + 1], "G unchanged");
      assert.equal(result.data[i + 2], before[i + 2], "B unchanged");
      assert.equal(result.data[i + 3], 255, "every alpha byte is exactly 255, no partial correction");
    }
  });

  it("4: source itself carries transparency — automatic normalization is refused/not admitted, reconstructed image returned untouched", () => {
    const source = image(2, 2, [0, 0, 0, 255]);
    setAlpha(source, 0, 0, 200); // the source itself is NOT verified opaque
    const reconstructed = image(2, 2, [5, 5, 5, 254]);
    const before = Buffer.from(reconstructed.data);

    const { image: result, evidence } = normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.equal(evidence, null, "never auto-normalizes when the source itself has transparency");
    assert.deepEqual(result.data, before, "reconstructed bytes returned completely untouched");
  });

  it("5: already fully opaque reconstruction — no normalization claimed, image returned untouched (same reference)", () => {
    const source = image(2, 2, [0, 0, 0, 255]);
    const reconstructed = image(2, 2, [9, 9, 9, 255]);

    const { image: result, evidence } = normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.equal(evidence, null, "nothing to normalize — never fabricates an evidence record for a no-op");
    assert.equal(result, reconstructed, "no copy made when there is nothing to change");
  });

  it("6: dimensions are unchanged by normalization", () => {
    const source = image(5, 7, [0, 0, 0, 255]);
    const reconstructed = image(5, 7, [1, 2, 3, 254]);

    const { image: result } = normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.equal(result.width, 5);
    assert.equal(result.height, 7);
    assert.equal(result.data.length, 5 * 7 * 4);
  });

  it("7: never mutates the caller's input buffer", () => {
    const source = image(2, 2, [0, 0, 0, 255]);
    const reconstructed = image(2, 2, [1, 2, 3, 254]);
    const originalBytes = Buffer.from(reconstructed.data);

    normalizeProviderAlphaOnVerifiedOpaqueSource(source, reconstructed);

    assert.deepEqual(reconstructed.data, originalBytes, "the input RgbaImage's own buffer is never written to");
  });
});
