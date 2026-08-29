import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RgbaImage } from "../raster-transform";
import { measureFeatureIntegrity } from "./measure-feature-integrity";
import { STRONG_INK_ALPHA_THRESHOLD } from "./alpha-masks";

/**
 * Synthetic fixtures only — no customer artwork (AGENTS.md / Constitution
 * §16-17). Each builder reproduces one specific geometric pattern this
 * phase's plan (Section 18) asks the measurement engine to distinguish, not
 * a real design.
 */

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

describe("measureFeatureIntegrity — synthetic fixtures (Section 18)", () => {
  it("A. thick robust geometry measures a wide, unambiguous stroke", () => {
    const image = canvas(200, 200);
    fillRect(image, 20, 20, 160, 160);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.ok(m.positive.globalMinStrokeWidthMm !== null);
    // A 160px-square block on a 200px/4in raster: pixel pitch = 4*25.4/200 = 0.508mm/px.
    // Its ridge sits near the block's center, so half-width approaches ~80px * 0.508mm ≈ 40mm.
    assert.ok(m.positive.globalMinStrokeWidthMm! > 10, `expected a robust stroke, got ${m.positive.globalMinStrokeWidthMm}mm`);
  });

  it("B. a very thin positive line measures near one pixel of physical width", () => {
    const image = canvas(100, 100);
    fillRect(image, 50, 10, 1, 80); // 1px-wide vertical line
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    const pitchMm = (4 * 25.4) / 100;
    assert.ok(m.positive.globalMinStrokeWidthMm !== null);
    // A 1px line's DT-to-background is ~0.5-1px depending on the chamfer
    // approximation; width should be on the order of one pixel, not tens.
    assert.ok(
      m.positive.globalMinStrokeWidthMm! < pitchMm * 3,
      `expected a near-single-pixel width, got ${m.positive.globalMinStrokeWidthMm}mm (pitch ${pitchMm}mm)`,
    );
  });

  it("C. a narrow stroke attached to large artwork is still detected as its own minimum", () => {
    const image = canvas(200, 200);
    fillRect(image, 20, 20, 100, 100); // large block
    fillRect(image, 120, 60, 40, 1); // thin 1px-tall tail protruding from it
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    const pitchMm = (4 * 25.4) / 200;
    // The component's minimum must reflect the thin tail, not the bulk of the block.
    assert.ok(m.positive.globalMinStrokeWidthMm! < pitchMm * 4);
  });

  it("D. a wide negative opening measures a large gap", () => {
    const image = canvas(200, 200);
    fillRect(image, 10, 10, 180, 180);
    fillRect(image, 60, 60, 80, 80, 0); // cut a large transparent hole
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.ok(m.negative.globalMinGapWidthMm !== null);
    assert.ok(m.negative.globalMinGapWidthMm! > 10, `expected a wide opening, got ${m.negative.globalMinGapWidthMm}mm`);
  });

  it("E. a narrow negative channel between two shapes measures a small gap", () => {
    const image = canvas(200, 100);
    fillRect(image, 10, 10, 80, 80);
    fillRect(image, 92, 10, 80, 80); // 2px channel between the two blocks
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 2 });
    const pitchMm = (4 * 25.4) / 200;
    assert.ok(m.negative.globalMinGapWidthMm !== null);
    assert.ok(
      m.negative.globalMinGapWidthMm! < pitchMm * 4,
      `expected a narrow channel, got ${m.negative.globalMinGapWidthMm}mm (pitch ${pitchMm}mm)`,
    );
  });

  it("distinguishes positive-feature-too-thin from negative-space-too-narrow (Section 4)", () => {
    const image = canvas(200, 100);
    fillRect(image, 10, 10, 80, 80);
    fillRect(image, 92, 10, 80, 80); // narrow gap, both blocks robustly thick
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 2 });
    assert.ok(m.negative.globalMinGapWidthMm! < m.positive.globalMinStrokeWidthMm!);
  });

  it("F. a small isolated dot is measured with a small equivalent diameter", () => {
    const image = canvas(200, 200);
    fillRect(image, 20, 20, 100, 100); // large anchor shape
    fillRect(image, 180, 180, 3, 3); // tiny isolated dot, far away
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.isolated.totalComponentCount, 2);
    assert.ok(m.isolated.smallestEquivalentDiameterMm !== null);
    const pitchMm = (4 * 25.4) / 200;
    assert.ok(m.isolated.smallestEquivalentDiameterMm! < pitchMm * 6);
    // The dot has a real neighbor far across the canvas.
    const dot = m.isolated.components.find((c) => c.pixelArea === 9);
    assert.ok(dot);
    assert.ok(dot!.distanceToNearestNeighborMm !== null && dot!.distanceToNearestNeighborMm! > 20);
  });

  it("G. a distressed collection of tiny fragments is measured, not blindly discarded", () => {
    const image = canvas(200, 200);
    fillRect(image, 20, 20, 100, 100);
    // Scatter a handful of small non-touching fragments.
    const fragments = [
      [10, 10], [30, 190], [150, 150], [170, 20], [190, 190],
    ];
    for (const [x, y] of fragments) fillRect(image, x!, y!, 2, 2);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.isolated.totalComponentCount, 1 + fragments.length);
    // Every fragment is measured (present in the capped worst-first list —
    // capped well above 5 records, so nothing here is dropped).
    assert.ok(m.isolated.components.length >= fragments.length);
  });

  it("H. a partial-alpha thin feature is characterized separately from strong ink", () => {
    const image = canvas(100, 100);
    fillRect(image, 50, 10, 1, 80, 100); // alpha below STRONG_INK_ALPHA_THRESHOLD
    assert.ok(100 < STRONG_INK_ALPHA_THRESHOLD);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.positive.totalComponentCount, 0, "a partial-alpha line is not strong ink");
    assert.ok(m.partialAlpha.totalComponentCount >= 1);
    assert.ok(m.partialAlpha.partialAlphaFractionOfVisible > 0);
  });

  it("I. the SAME pixel feature classifies differently at two different physical sizes", () => {
    const image = canvas(100, 100);
    fillRect(image, 50, 10, 2, 80); // fixed 2px-wide stroke, never regenerated

    const printedSmall = measureFeatureIntegrity({ image, confirmedWidthIn: 2, confirmedHeightIn: 2 });
    const printedLarge = measureFeatureIntegrity({ image, confirmedWidthIn: 12, confirmedHeightIn: 12 });

    assert.ok(printedSmall.positive.globalMinStrokeWidthMm !== null);
    assert.ok(printedLarge.positive.globalMinStrokeWidthMm !== null);

    // Same raster pixels, six times the physical size => six times the
    // physical stroke width. This is the whole point of Section 7/18-I:
    // risk is a function of PHYSICAL size, never of source pixels alone.
    const ratio = printedLarge.positive.globalMinStrokeWidthMm! / printedSmall.positive.globalMinStrokeWidthMm!;
    assert.ok(Math.abs(ratio - 6) < 0.05, `expected ~6x scaling, got ${ratio}x`);
    assert.ok(printedLarge.positive.globalMinStrokeWidthMm! > printedSmall.positive.globalMinStrokeWidthMm!);
  });

  it("reports non-square pixel pitch as an honest limitation rather than silently averaging it away", () => {
    const image = canvas(100, 50);
    fillRect(image, 40, 10, 20, 20);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 10, confirmedHeightIn: 2 });
    assert.ok(m.limitations.some((l) => l.includes("pixel pitch")));
  });

  it("an empty (fully transparent) raster measures nothing and never throws", () => {
    const image = canvas(50, 50);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 2, confirmedHeightIn: 2 });
    assert.equal(m.positive.totalComponentCount, 0);
    assert.equal(m.isolated.totalComponentCount, 0);
    assert.equal(m.positive.globalMinStrokeWidthMm, null);
  });

  it("a fully opaque raster (no transparency anywhere) reports an honest limitation rather than a fabricated width", () => {
    // A raw, un-prepared upload has no alpha-based ink/background
    // separation at all — this must never be silently measured as "one
    // giant component" with a nonsense stroke width computed from an
    // unseeded distance transform.
    const image = canvas(50, 50);
    fillRect(image, 0, 0, 50, 50);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 2, confirmedHeightIn: 2 });
    assert.equal(m.positive.totalComponentCount, 0);
    assert.equal(m.positive.globalMinStrokeWidthMm, null);
    assert.equal(m.isolated.totalComponentCount, 0);
    assert.ok(m.limitations.some((l) => l.includes("no transparent margin")));
  });
});
