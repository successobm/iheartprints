import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RgbaImage } from "../raster-transform";
import { measureDtfCoverage } from "./measure-dtf-coverage";

/** Synthetic fixtures only — no customer artwork (AGENTS.md / Constitution §16-17). */

function canvas(width: number, height: number): RgbaImage {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function setPixel(image: RgbaImage, x: number, y: number, alpha = 255): void {
  const i = (y * image.width + x) * 4;
  image.data[i] = 0;
  image.data[i + 1] = 0;
  image.data[i + 2] = 0;
  image.data[i + 3] = alpha;
}

function fillRect(
  image: RgbaImage,
  left: number,
  top: number,
  width: number,
  height: number,
  alpha = 255,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      setPixel(image, x, y, alpha);
    }
  }
}

describe("measureDtfCoverage — synthetic fixtures (Section 22)", () => {
  it("A. an empty transparent plate measures zero coverage", () => {
    const image = canvas(100, 100);
    const m = measureDtfCoverage({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.visibleCoverageFraction, 0);
    assert.equal(m.strongInkCoverageFraction, 0);
    assert.equal(m.alphaWeightedCoverageFraction, 0);
    assert.equal(m.alphaBands.find((b) => b.band === "transparent")!.fractionOfPlate, 1);
  });

  it("B. a fully opaque plate measures 100% coverage across every coverage metric", () => {
    const image = canvas(100, 100);
    fillRect(image, 0, 0, 100, 100);
    const m = measureDtfCoverage({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.visibleCoverageFraction, 1);
    assert.equal(m.strongInkCoverageFraction, 1);
    assert.equal(m.alphaWeightedCoverageFraction, 1);
    assert.equal(m.alphaBands.find((b) => b.band === "opaque")!.fractionOfPlate, 1);
  });

  it("C. exactly half the plate opaque measures ~50% coverage", () => {
    const image = canvas(100, 100);
    fillRect(image, 0, 0, 50, 100);
    const m = measureDtfCoverage({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.visibleCoverageFraction, 0.5);
    assert.equal(m.strongInkCoverageFraction, 0.5);
    assert.equal(m.alphaWeightedCoverageFraction, 0.5);
  });

  it("D. a partial-alpha plate: binary coverage and alpha-weighted coverage differ correctly", () => {
    const image = canvas(100, 100);
    fillRect(image, 0, 0, 100, 100, 100); // partial alpha everywhere (100/255)
    const m = measureDtfCoverage({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    // Binary "visible" coverage is 100% (100 >= DEFAULT_ALPHA_THRESHOLD)...
    assert.equal(m.visibleCoverageFraction, 1);
    // ...but it is NOT strong ink (100 < STRONG_INK_ALPHA_THRESHOLD)...
    assert.equal(m.strongInkCoverageFraction, 0);
    assert.equal(m.partialAlphaCoverageFraction, 1);
    // ...and alpha-weighted coverage reflects the actual partial value, not a binary 0/1.
    assert.ok(Math.abs(m.alphaWeightedCoverageFraction - 100 / 255) < 1e-9);
    assert.ok(m.alphaWeightedCoverageFraction < m.visibleCoverageFraction);
  });

  it("E. one large continuous region measures differently from many small separated regions of similar total area", () => {
    const oneRegion = canvas(200, 200);
    fillRect(oneRegion, 50, 50, 100, 40); // 4000px, one block
    const oneRegionMeasurement = measureDtfCoverage({ image: oneRegion, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(oneRegionMeasurement.continuousRegions.totalComponentCount, 1);
    assert.ok(oneRegionMeasurement.continuousRegions.largestFractionOfPrintedArea! > 0.99);

    const manyRegions = canvas(200, 200);
    // 40 small 10x10 (100px) blocks, non-touching -> same total area (4000px), many separate regions.
    let placed = 0;
    for (let row = 0; row < 5 && placed < 40; row += 1) {
      for (let col = 0; col < 8 && placed < 40; col += 1) {
        fillRect(manyRegions, 10 + col * 20, 10 + row * 20, 10, 10);
        placed += 1;
      }
    }
    const manyRegionsMeasurement = measureDtfCoverage({ image: manyRegions, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(manyRegionsMeasurement.continuousRegions.totalComponentCount, 40);
    // Same total strong-ink coverage fraction as the one-region case...
    assert.ok(Math.abs(manyRegionsMeasurement.strongInkCoverageFraction - oneRegionMeasurement.strongInkCoverageFraction) < 1e-9);
    // ...but NO single region dominates the printed area the way the one big block did.
    assert.ok(manyRegionsMeasurement.continuousRegions.largestFractionOfPrintedArea! < 0.1);
    assert.ok(manyRegionsMeasurement.continuousRegions.largeRegionCount < oneRegionMeasurement.continuousRegions.largeRegionCount);
  });

  it("F. the SAME raster's coverage fraction is invariant to physical size, but physical covered area scales with it", () => {
    const image = canvas(100, 100);
    fillRect(image, 0, 0, 50, 50); // 25% strong-ink coverage
    const small = measureDtfCoverage({ image, confirmedWidthIn: 2, confirmedHeightIn: 2 });
    const large = measureDtfCoverage({ image, confirmedWidthIn: 8, confirmedHeightIn: 8 });

    assert.equal(small.strongInkCoverageFraction, large.strongInkCoverageFraction);
    assert.equal(small.visibleCoverageFraction, large.visibleCoverageFraction);
    // Physical size is 4x larger on each axis -> 16x the physical area.
    const ratio = large.physicalStrongInkAreaMm2 / small.physicalStrongInkAreaMm2;
    assert.ok(Math.abs(ratio - 16) < 0.01, `expected ~16x physical area, got ${ratio}x`);
    assert.ok(large.plateAreaMm2 > small.plateAreaMm2);
  });

  it("G. a halftone-like dot lattice measures its actual occupied plate area, not a naive average", () => {
    const image = canvas(100, 100);
    // A regular dot lattice: a 4x4px opaque dot every 10px — exercises the
    // engine on genuinely halftone-shaped input (Section 18: coverage may
    // measure a halftone plate; it draws no Feature Integrity conclusions
    // about it).
    for (let y = 0; y < 100; y += 10) {
      for (let x = 0; x < 100; x += 10) {
        fillRect(image, x, y, 4, 4);
      }
    }
    const m = measureDtfCoverage({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    // 10x10 dots, 16px each, on a 100x100 canvas = 100 dots * 16px = 1600px of 10000 = 16%.
    assert.ok(Math.abs(m.strongInkCoverageFraction - 0.16) < 0.001);
    assert.equal(m.continuousRegions.totalComponentCount, 100);
  });

  it("H. alpha-band accounting always totals to exactly 1", () => {
    const image = canvas(50, 50);
    fillRect(image, 0, 0, 10, 50, 0); // transparent
    fillRect(image, 10, 0, 10, 50, 30); // low
    fillRect(image, 20, 0, 10, 50, 100); // medium
    fillRect(image, 30, 0, 10, 50, 170); // high
    fillRect(image, 40, 0, 10, 50, 255); // opaque
    const m = measureDtfCoverage({ image, confirmedWidthIn: 2, confirmedHeightIn: 2 });
    const total = m.alphaBands.reduce((sum, b) => sum + b.fractionOfPlate, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    // Each of the five bands actually received its own stripe.
    for (const band of m.alphaBands) {
      assert.ok(band.fractionOfPlate > 0, `expected ${band.band} to have nonzero coverage`);
    }
  });

  it("never throws on a zero-area image", () => {
    const image = canvas(0, 0);
    const m = measureDtfCoverage({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.visibleCoverageFraction, 0);
  });
});
