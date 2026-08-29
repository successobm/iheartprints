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

function fillCircle(image: RgbaImage, centerX: number, centerY: number, radius: number): void {
  const r2 = radius * radius;
  for (let y = Math.max(0, centerY - radius); y <= Math.min(image.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(image.width - 1, centerX + radius); x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= r2) setPixel(image, x, y);
    }
  }
}

/**
 * A horizontal capsule/stadium (a rectangle with semicircular end caps) —
 * used as the "robust anchor" shape in Phase 2A's structural-vs-incidental
 * fixtures, deliberately instead of either a plain filled rectangle or a
 * disk:
 *
 *   - A filled RECTANGLE's true medial axis is an "X" reaching each of its
 *     four corners, where the inscribed-circle radius (and so the ridge's
 *     own distance-transform value) shrinks toward zero AT the vertex — a
 *     well-known artifact of any polygon's medial axis, not genuine stroke
 *     fragility, and one that measurably inflates "fraction below floor"
 *     for a plain rectangle by an amount that depends on its aspect ratio.
 *   - A filled DISK's true medial axis is a SINGLE POINT at its center,
 *     regardless of how large its area is — ridge sample COUNT (which
 *     approximates arc length, per this module's own doc comment) is
 *     therefore trivially small for a disk no matter how "robust" it looks,
 *     which is the opposite failure: it made an appendage look artificially
 *     STRUCTURAL rather than incidental in an early version of this test.
 *   - A CAPSULE's medial axis is a straight segment of CONSTANT width
 *     (equal to `radius`) running its entire straight length, with no
 *     tapering at all (the rounded caps maintain exactly `radius` distance
 *     to the boundary all the way to the cap's own center point) — the
 *     closest simple synthetic shape to a real bold letter stroke's own
 *     geometry, which is exactly what these tests need to isolate the
 *     property under test (an attached thin appendage's fraction of the
 *     whole structure) from either confound above.
 */
function fillCapsule(image: RgbaImage, left: number, right: number, centerY: number, radius: number): void {
  fillRect(image, left + radius, centerY - radius, right - left - 2 * radius, 2 * radius);
  fillCircle(image, left + radius, centerY, radius);
  fillCircle(image, right - radius, centerY, radius);
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

  // --- Phase 2A: structural vs. incidental fragility (Sections 3-5, 21) ---

  const STRUCTURAL_THRESHOLDS = { blockingFloorMm: 1, warningFloorMm: 2 };

  it("A/C: a robust capsule anchor with one tiny thin appendage has a LOW fraction below the floor", () => {
    const image = canvas(400, 200);
    fillCapsule(image, 20, 300, 100, 40); // a long, uniformly thick (80px) capsule — see fillCapsule's doc comment for why not a rectangle or a disk
    fillRect(image, 270, 100, 60, 1); // short 1px-wide appendage/bridge protruding from it, well inside the capsule to guarantee connectivity
    const m = measureFeatureIntegrity({
      image,
      confirmedWidthIn: 4,
      confirmedHeightIn: 4,
      positiveFeatureThresholds: STRUCTURAL_THRESHOLDS,
    });
    const worst = m.positive.worstStructuralComponent;
    assert.ok(worst);
    // The appendage IS thin enough to fail the floor...
    assert.ok(worst!.minStrokeWidthMm! < STRUCTURAL_THRESHOLDS.blockingFloorMm);
    // ...but it is a tiny fraction of the component's overall ridge length.
    assert.ok(
      worst!.fractionBelowBlockingFloor < 0.5,
      `expected a low fraction (incidental), got ${worst!.fractionBelowBlockingFloor}`,
    );
  });

  it("B/D: a component that is predominantly (or entirely) thin geometry has a HIGH fraction below the floor", () => {
    const image = canvas(300, 300);
    fillRect(image, 20, 20, 260, 1); // one long, uniformly thin line — nothing robust anywhere
    const m = measureFeatureIntegrity({
      image,
      confirmedWidthIn: 4,
      confirmedHeightIn: 4,
      positiveFeatureThresholds: STRUCTURAL_THRESHOLDS,
    });
    const worst = m.positive.worstStructuralComponent;
    assert.ok(worst);
    assert.ok(
      worst!.fractionBelowBlockingFloor > 0.9,
      `expected a high fraction (structural), got ${worst!.fractionBelowBlockingFloor}`,
    );
  });

  it("per-component distribution: median/p25 stay robust for an incidental appendage but collapse for a predominantly-thin shape", () => {
    const robust = canvas(400, 200);
    fillCapsule(robust, 20, 300, 100, 40);
    fillRect(robust, 270, 100, 60, 1);
    const robustMeasurement = measureFeatureIntegrity({ image: robust, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    const robustComponent = robustMeasurement.positive.components.find((c) => c.pixelArea > 1000)!;
    assert.ok(robustComponent.medianStrokeWidthMm! > robustComponent.minStrokeWidthMm!);

    const thin = canvas(300, 300);
    fillRect(thin, 20, 20, 260, 1);
    const thinMeasurement = measureFeatureIntegrity({ image: thin, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    const thinComponent = thinMeasurement.positive.components[0]!;
    // Median and minimum are close together for a uniformly thin line.
    assert.ok(
      Math.abs(thinComponent.medianStrokeWidthMm! - thinComponent.minStrokeWidthMm!) <
        Math.abs(robustComponent.medianStrokeWidthMm! - robustComponent.minStrokeWidthMm!),
    );
  });

  it("G/H: negative-space structural fractions distinguish an isolated pinch from a predominantly narrow channel", () => {
    const NEGATIVE_THRESHOLDS = { blockingFloorMm: 2, warningFloorMm: 3 };
    // Bars span the FULL canvas width (no left/right margin) so the
    // negative space is a clean, self-contained corridor between them —
    // never wrapping around the sides through the open outer margin, which
    // would contaminate the fraction with unrelated open background.

    // G: a wide (20px) corridor with one isolated narrow (1px) pinch column.
    const pinch = canvas(200, 200);
    fillRect(pinch, 0, 0, 200, 90); // top bar, rows 0-89
    fillRect(pinch, 0, 110, 200, 90); // bottom bar, rows 110-199 — default corridor is rows 90-109 (20px)
    fillRect(pinch, 95, 90, 10, 19); // narrow the corridor to 1px (row 109 only) across a 10px-wide column
    const pinchMeasurement = measureFeatureIntegrity({
      image: pinch,
      confirmedWidthIn: 4,
      confirmedHeightIn: 4,
      negativeSpaceThresholds: NEGATIVE_THRESHOLDS,
    });
    const pinchWorst = pinchMeasurement.negative.worstStructuralComponent;
    assert.ok(pinchWorst);
    assert.ok(
      pinchWorst!.minGapWidthMm! < NEGATIVE_THRESHOLDS.blockingFloorMm,
      "the pinch itself must actually be measured as thin",
    );
    assert.ok(
      pinchWorst!.fractionBelowBlockingFloor < 0.5,
      `expected a low fraction for an isolated pinch, got ${pinchWorst!.fractionBelowBlockingFloor}`,
    );

    // H: the SAME two bars, but the ENTIRE corridor is narrowed to 1px.
    const uniform = canvas(200, 200);
    fillRect(uniform, 0, 0, 200, 99);
    fillRect(uniform, 0, 100, 200, 100); // corridor is exactly row 99 only, everywhere
    const uniformMeasurement = measureFeatureIntegrity({
      image: uniform,
      confirmedWidthIn: 4,
      confirmedHeightIn: 4,
      negativeSpaceThresholds: NEGATIVE_THRESHOLDS,
    });
    const uniformWorst = uniformMeasurement.negative.worstStructuralComponent;
    assert.ok(uniformWorst);
    assert.ok(
      uniformWorst!.fractionBelowBlockingFloor > pinchWorst!.fractionBelowBlockingFloor,
      "a uniformly narrow channel must have a higher structural fraction than one with a single isolated pinch",
    );
  });

  it("F: many tiny isolated components are reported as a micro-component population, not folded into structural fractions", () => {
    const image = canvas(300, 300);
    fillRect(image, 20, 20, 200, 200); // large anchor
    const positions: Array<[number, number]> = [];
    for (let i = 0; i < 20; i += 1) positions.push([230 + (i % 5) * 10, 20 + Math.floor(i / 5) * 10]);
    for (const [x, y] of positions) fillRect(image, x, y, 2, 2);
    const m = measureFeatureIntegrity({ image, confirmedWidthIn: 4, confirmedHeightIn: 4 });
    assert.equal(m.isolated.microComponents.microComponentCount, positions.length);
    assert.ok(m.isolated.microComponents.totalMicroComponentPhysicalAreaMm2 > 0);
    assert.ok(m.isolated.microComponents.fractionOfPrintedArea > 0);
    assert.ok(m.isolated.microComponents.fractionOfPrintedArea < 0.5, "20 tiny dots must be a small fraction of a 200x200 anchor's printed area");
  });

  it("I: the SAME physical geometry at a different raster resolution remains approximately physically consistent", () => {
    // Deliberately thicker than a 1-2px hairline: at such tiny absolute
    // pixel counts, chamfer-distance-transform discretization error is a
    // large FRACTION of the measurement itself (an honest limitation of
    // this approach at the extreme low end, not a resolution-consistency
    // bug) — a 8px/16px stroke keeps that discretization noise a small
    // fraction of the signal, which is what this test actually checks.
    const lowRes = canvas(100, 100);
    fillRect(lowRes, 10, 10, 80, 80);
    fillRect(lowRes, 89, 42, 10, 8);
    const lowResMeasurement = measureFeatureIntegrity({ image: lowRes, confirmedWidthIn: 4, confirmedHeightIn: 4 });

    // The same design at 2x raster resolution — every feature doubles in
    // pixels, but the physical size stays 4in, so physical widths should
    // land close to the low-res measurement.
    const highRes = canvas(200, 200);
    fillRect(highRes, 20, 20, 160, 160);
    fillRect(highRes, 178, 84, 20, 16);
    const highResMeasurement = measureFeatureIntegrity({ image: highRes, confirmedWidthIn: 4, confirmedHeightIn: 4 });

    // Both fixtures draw exactly one connected ink component (the block plus
    // its attached appendage); its own minimum reflects the appendage.
    assert.equal(lowResMeasurement.positive.totalComponentCount, 1);
    assert.equal(highResMeasurement.positive.totalComponentCount, 1);
    const lowResAppendage = lowResMeasurement.positive.components[0]!;
    const highResAppendage = highResMeasurement.positive.components[0]!;
    const ratio = highResAppendage.minStrokeWidthMm! / lowResAppendage.minStrokeWidthMm!;
    assert.ok(ratio > 0.7 && ratio < 1.4, `expected roughly consistent physical width across resolutions, got ratio ${ratio}`);
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
