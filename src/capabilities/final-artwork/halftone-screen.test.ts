import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HALFTONE_LPI,
  MAX_HALFTONE_LPI,
  MIN_HALFTONE_LPI,
  MIN_PRINTABLE_DOT_RADIUS_PX,
  recommendedHalftoneSettings,
  resolveGarmentColor,
  type HalftoneSettings,
} from "@/capabilities/shared/production-treatment";

import {
  HALFTONE_MIN_COVERAGE,
  MIN_PRINTABLE_ALPHA,
  applyHalftoneScreen,
  chokeAlpha,
  compositeOverGarment,
  encodedLuma,
  garmentRelativeTone,
  halftoneCoverageForTone,
  measureHalftoneTonalContent,
  resolveHalftoneScreenGeometry,
} from "./halftone-screen";
import type { RgbaImage } from "./raster-transform";

const BLACK_GARMENT = resolveGarmentColor("Black")!;
const WHITE_GARMENT = resolveGarmentColor("White")!;
const TARGET_PPI = 300;

function settings(overrides: Partial<HalftoneSettings> = {}): HalftoneSettings {
  return { ...recommendedHalftoneSettings(BLACK_GARMENT), ...overrides };
}

/** A solid rectangle of one colour, fully opaque. */
function solid(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
  alpha = 255,
): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb.r;
    data[i + 1] = rgb.g;
    data[i + 2] = rgb.b;
    data[i + 3] = alpha;
  }
  return { width, height, data };
}

/** A left-to-right greyscale ramp — the thing a screen exists to represent. */
function ramp(width: number, height: number): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = Math.round((x / (width - 1)) * 255);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function meanAlpha(image: RgbaImage): number {
  let sum = 0;
  for (let i = 3; i < image.data.length; i += 4) sum += image.data[i];
  return sum / (image.data.length / 4);
}

function alphaAt(image: RgbaImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3];
}

describe("halftone screen geometry (Goal 7 — LPI is physical, not a slider)", () => {
  it("derives cell pitch from output density and line frequency, never from a hard-coded pixel size", () => {
    // The three worked examples from the Phase 2 brief, recomputed rather than
    // asserted from a table: this is the arithmetic the whole representation
    // rests on.
    assert.equal(resolveHalftoneScreenGeometry(40, 300).cellPx, 7.5);
    assert.equal(resolveHalftoneScreenGeometry(50, 300).cellPx, 6);
    assert.ok(
      Math.abs(resolveHalftoneScreenGeometry(35, 300).cellPx - 8.5714) < 0.0001,
    );
  });

  it("does not round cell pitch to whole pixels — the classic way an engine silently prints a different LPI", () => {
    const geometry = resolveHalftoneScreenGeometry(DEFAULT_HALFTONE_LPI, TARGET_PPI);
    assert.notEqual(geometry.cellPx, Math.round(geometry.cellPx));
    // Rounded to 9px the screen would print 33.3 LPI; to 8px, 37.5 LPI.
    assert.equal(geometry.achievedLpi, DEFAULT_HALFTONE_LPI);
  });

  it("scales cell pitch with output density, so the same LPI is the same PHYSICAL frequency at any size", () => {
    // A plate printed larger has more pixels, not bigger dots-per-inch. The
    // cell pitch in PIXELS depends only on the density, which is why a 10.5in
    // and a 12in plate at 35 LPI carry identical physical dot frequency.
    const at300 = resolveHalftoneScreenGeometry(35, 300);
    const at600 = resolveHalftoneScreenGeometry(35, 600);
    assert.equal(at300.achievedLpi, 35);
    assert.equal(at600.achievedLpi, 35);
    assert.equal(at600.cellPx, at300.cellPx * 2);
  });

  it("keeps the smallest emittable dot printable across the whole supported LPI band", () => {
    for (let lpi = MIN_HALFTONE_LPI; lpi <= MAX_HALFTONE_LPI; lpi += 1) {
      for (const shape of ["round", "ellipse"] as const) {
        const geometry = resolveHalftoneScreenGeometry(lpi, TARGET_PPI, shape);
        assert.ok(
          geometry.minDotRadiusPx >= MIN_PRINTABLE_DOT_RADIUS_PX,
          `${lpi} LPI ${shape} floor dot is ${geometry.minDotRadiusPx}px`,
        );
      }
    }
  });

  it("refuses nonsense inputs rather than producing a screen nobody asked for", () => {
    assert.throws(() => resolveHalftoneScreenGeometry(0, 300));
    assert.throws(() => resolveHalftoneScreenGeometry(35, 0));
  });
});

describe("tonal transfer (Goal 10 — explicit and testable, never emergent)", () => {
  it("measures tone AGAINST THE GARMENT, so one rule serves black, white, and mid-grey", () => {
    // On black, separation reduces exactly to luma.
    assert.equal(garmentRelativeTone(0, 0), 0);
    assert.equal(garmentRelativeTone(1, 0), 1);
    // On white it inverts — shadows print, highlights open to fabric.
    assert.equal(garmentRelativeTone(1, 1), 0);
    assert.equal(garmentRelativeTone(0, 1), 1);
    // On mid grey BOTH ends reach full coverage.
    assert.equal(garmentRelativeTone(0, 0.5), 1);
    assert.equal(garmentRelativeTone(1, 0.5), 1);
    assert.equal(garmentRelativeTone(0.5, 0.5), 0);
  });

  it("NEVER drops garment-matched artwork to zero coverage (Goal 4 — the black-on-black rule)", () => {
    // The single most important property in this engine. Artwork whose tone
    // matches the garment exactly still prints a real, printable dot.
    assert.equal(halftoneCoverageForTone(0, 1), HALFTONE_MIN_COVERAGE);
    assert.ok(HALFTONE_MIN_COVERAGE > 0);
  });

  it("puts more ink in the midtones as `midtone` rises, and moves neither endpoint", () => {
    for (const tone of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const lean = halftoneCoverageForTone(tone, 0.7);
      const linear = halftoneCoverageForTone(tone, 1);
      const rich = halftoneCoverageForTone(tone, 1.4);
      assert.ok(lean < linear, `midtone 0.7 should remove ink at tone ${tone}`);
      assert.ok(rich > linear, `midtone 1.4 should add ink at tone ${tone}`);
    }
    // Fixed points: "bare garment" and "solid" mean the same thing at every
    // setting, so the control cannot redefine the ends of the range.
    for (const midtone of [0.5, 1, 2]) {
      assert.equal(halftoneCoverageForTone(0, midtone), HALFTONE_MIN_COVERAGE);
      assert.equal(halftoneCoverageForTone(1, midtone), 1);
    }
  });

  it("is monotonic in tone — a lighter region on a dark garment never prints LESS ink", () => {
    let previous = -1;
    for (let tone = 0; tone <= 1.0001; tone += 0.01) {
      const coverage = halftoneCoverageForTone(Math.min(tone, 1), 1);
      assert.ok(coverage >= previous);
      previous = coverage;
    }
  });
});

describe("the screen (Goals 6, 11, 12)", () => {
  it("preserves every source RGB byte and writes ALPHA only (Goal 11 — full colour, not monochrome dots)", () => {
    const source = ramp(200, 200);
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);

    let compared = 0;
    for (let i = 0; i < source.data.length; i += 4) {
      assert.equal(screened.image.data[i], source.data[i]);
      assert.equal(screened.image.data[i + 1], source.data[i + 1]);
      assert.equal(screened.image.data[i + 2], source.data[i + 2]);
      compared += 1;
    }
    assert.equal(compared, 200 * 200);
  });

  it("reproduces colour through COVERAGE: a saturated red keeps its exact RGB where it prints", () => {
    const red = { r: 214, g: 32, b: 48 };
    const source = solid(120, 120, red);
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);

    let inked = 0;
    for (let i = 0; i < screened.image.data.length; i += 4) {
      if (screened.image.data[i + 3] === 0) continue;
      inked += 1;
      assert.equal(screened.image.data[i], red.r);
      assert.equal(screened.image.data[i + 1], red.g);
      assert.equal(screened.image.data[i + 2], red.b);
    }
    assert.ok(inked > 0, "a mid-tone colour must print somewhere");
  });

  it("generates the lattice at the dimensions it was handed, and records them (the final-size proof)", () => {
    const source = ramp(3150, 40);
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);
    assert.equal(screened.metadata.screenWidthPx, 3150);
    assert.equal(screened.metadata.screenHeightPx, 40);
    assert.equal(screened.image.width, 3150);
    assert.equal(screened.image.height, 40);
  });

  it("leaves real transparency — a screened plate is dots, not a solid rectangle (Goal 12)", () => {
    // Mid-grey on black: genuinely partial coverage, so both ink and fabric
    // must be present.
    const source = solid(200, 200, { r: 128, g: 128, b: 128 });
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);

    let transparent = 0;
    let opaque = 0;
    for (let i = 3; i < screened.image.data.length; i += 4) {
      if (screened.image.data[i] === 0) transparent += 1;
      if (screened.image.data[i] === 255) opaque += 1;
    }
    assert.ok(transparent > 0, "the garment must show through a mid-tone");
    assert.ok(opaque > 0, "ink must actually land");
  });

  it("keeps solid artwork solid — full coverage is exact, never a lattice with holes", () => {
    // White on black is maximum separation. A screen that speckled it would be
    // removing ink from artwork that asked for all of it.
    const source = solid(150, 150, { r: 255, g: 255, b: 255 });
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);
    assert.equal(meanAlpha(screened.image), 255);
  });

  it("holds garment-matched artwork at the coverage floor instead of deleting it (Goal 4)", () => {
    // Pure black on a black garment: the case that motivated the floor.
    const source = solid(300, 300, { r: 0, g: 0, b: 0 });
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);

    assert.ok(
      screened.metadata.inkedPixelFraction > 0.05,
      `black-on-black must survive as a visible screen, got ${screened.metadata.inkedPixelFraction}`,
    );
    assert.ok(
      screened.metadata.inkedPixelFraction < 0.4,
      "…but must genuinely open up, not print as a solid black box",
    );
    assert.ok(
      Math.abs(screened.metadata.meanRequestedCoverage - HALFTONE_MIN_COVERAGE) < 1e-9,
    );
  });

  it("renders the requested coverage to within a few percent across the tonal range", () => {
    // The area-measured coverage table's whole reason for existing: what the
    // transfer function asks for is what the raster actually delivers.
    for (const level of [64, 128, 192]) {
      const source = solid(400, 400, { r: level, g: level, b: level });
      const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);
      const delivered = meanAlpha(screened.image) / 255;
      assert.ok(
        Math.abs(delivered - screened.metadata.meanRequestedCoverage) < 0.06,
        `level ${level}: asked ${screened.metadata.meanRequestedCoverage}, delivered ${delivered}`,
      );
    }
  });

  it("carries transparent source pixels straight through as transparent", () => {
    const source = solid(80, 80, { r: 200, g: 200, b: 200 }, 0);
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);
    assert.equal(meanAlpha(screened.image), 0);
    assert.equal(screened.metadata.visiblePixelCount, 0);
  });

  it("discards sub-printable alpha rather than delivering it as haze (Goal 12)", () => {
    const source = solid(80, 80, { r: 255, g: 255, b: 255 }, MIN_PRINTABLE_ALPHA - 1);
    const screened = applyHalftoneScreen(source, settings(), TARGET_PPI);
    assert.equal(meanAlpha(screened.image), 0);
  });

  it("is deterministic — the same settings on the same pixels produce the same bytes", () => {
    const source = ramp(240, 160);
    const a = applyHalftoneScreen(source, settings(), TARGET_PPI);
    const b = applyHalftoneScreen(source, settings(), TARGET_PPI);
    assert.ok(a.image.data.equals(b.image.data));
  });

  it("never mutates the source raster", () => {
    const source = ramp(120, 120);
    const before = Buffer.from(source.data);
    applyHalftoneScreen(source, settings(), TARGET_PPI);
    assert.ok(source.data.equals(before));
  });
});

describe("operator controls actually change the output (Goal 9, Goal 14)", () => {
  const source = ramp(400, 400);

  it("22.5 degrees and 45 degrees produce genuinely different rasters", () => {
    // An angle control with no measurable effect would be worse than no angle
    // control at all.
    const at45 = applyHalftoneScreen(source, settings({ angleDeg: 45 }), TARGET_PPI);
    const at225 = applyHalftoneScreen(source, settings({ angleDeg: 22.5 }), TARGET_PPI);
    assert.ok(!at45.image.data.equals(at225.image.data));

    // …while carrying the same amount of ink, because the ANGLE moved, not the
    // tone. Rotating a screen must not change how dark the artwork prints.
    assert.ok(
      Math.abs(meanAlpha(at45.image) - meanAlpha(at225.image)) < 4,
      "rotation must not change tonal weight",
    );
  });

  it("round and ellipse dots produce different rasters at the same tone", () => {
    const round = applyHalftoneScreen(source, settings({ dotShape: "round" }), TARGET_PPI);
    const ellipse = applyHalftoneScreen(
      source,
      settings({ dotShape: "ellipse" }),
      TARGET_PPI,
    );
    assert.ok(!round.image.data.equals(ellipse.image.data));
    assert.ok(
      Math.abs(meanAlpha(round.image) - meanAlpha(ellipse.image)) < 6,
      "dot SHAPE must not change tonal weight — both are area-normalized",
    );
  });

  it("LPI changes dot density deterministically without changing tonal weight", () => {
    const coarse = applyHalftoneScreen(source, settings({ lpi: 25 }), TARGET_PPI);
    const fine = applyHalftoneScreen(source, settings({ lpi: 55 }), TARGET_PPI);
    assert.ok(!coarse.image.data.equals(fine.image.data));
    // Compared with a tolerance, not for equality: `targetPpi / (targetPpi /
    // lpi)` is float division twice, so 55 round-trips as 55.00000000000001.
    // That is exactly the residue the validator's own tolerance absorbs, and
    // it is ~13 orders of magnitude below any real LPI error.
    assert.ok(Math.abs(coarse.metadata.achievedLpi - 25) < 1e-9);
    assert.ok(Math.abs(fine.metadata.achievedLpi - 55) < 1e-9);
    assert.ok(coarse.metadata.cellPx > fine.metadata.cellPx);
    assert.ok(Math.abs(meanAlpha(coarse.image) - meanAlpha(fine.image)) < 8);
  });

  it("the midtone control changes delivered coverage in the direction it claims", () => {
    const lean = applyHalftoneScreen(source, settings({ midtone: 0.7 }), TARGET_PPI);
    const linear = applyHalftoneScreen(source, settings({ midtone: 1 }), TARGET_PPI);
    const rich = applyHalftoneScreen(source, settings({ midtone: 1.4 }), TARGET_PPI);

    assert.ok(meanAlpha(lean.image) < meanAlpha(linear.image));
    assert.ok(meanAlpha(rich.image) > meanAlpha(linear.image));
    assert.ok(lean.metadata.meanRequestedCoverage < linear.metadata.meanRequestedCoverage);
    assert.ok(rich.metadata.meanRequestedCoverage > linear.metadata.meanRequestedCoverage);
  });

  it("the garment colour changes which tones open up — and it is a TONAL reference, never a composite", () => {
    const onBlack = applyHalftoneScreen(
      source,
      settings({ garment: BLACK_GARMENT }),
      TARGET_PPI,
    );
    const onWhite = applyHalftoneScreen(
      source,
      settings({ garment: WHITE_GARMENT }),
      TARGET_PPI,
    );
    assert.ok(!onBlack.image.data.equals(onWhite.image.data));

    // On a black garment the artwork's dark end opens up; on white, its light
    // end does. Same file, mirrored behaviour, one rule.
    const leftColumnBlack = alphaAt(onBlack.image, 2, 200);
    const rightColumnBlack = alphaAt(onBlack.image, 397, 200);
    const leftColumnWhite = alphaAt(onWhite.image, 2, 200);
    const rightColumnWhite = alphaAt(onWhite.image, 397, 200);
    assert.equal(rightColumnBlack, 255, "white artwork prints solid on black");
    assert.equal(leftColumnWhite, 255, "black artwork prints solid on white");
    assert.ok(leftColumnBlack < 255);
    assert.ok(rightColumnWhite < 255);
  });
});

describe("edge choke (Goal 12 — narrow, explicit, off by default)", () => {
  it("does nothing at all at the default of 0", () => {
    const source = solid(60, 60, { r: 255, g: 255, b: 255 });
    assert.equal(chokeAlpha(source, 0), source);
  });

  it("pulls the artwork edge in by the requested number of output pixels", () => {
    const source = solid(40, 40, { r: 255, g: 255, b: 255 });
    // Surround the artwork with transparency so there is an edge to choke.
    const framed: RgbaImage = {
      width: 60,
      height: 60,
      data: Buffer.alloc(60 * 60 * 4),
    };
    for (let y = 10; y < 50; y += 1) {
      for (let x = 10; x < 50; x += 1) {
        const i = (y * 60 + x) * 4;
        framed.data[i] = 255;
        framed.data[i + 1] = 255;
        framed.data[i + 2] = 255;
        framed.data[i + 3] = 255;
      }
    }
    void source;

    const choked = chokeAlpha(framed, 2);
    assert.equal(alphaAt(framed, 10, 30), 255);
    assert.equal(alphaAt(choked, 10, 30), 0, "the outer two pixels are removed");
    assert.equal(alphaAt(choked, 11, 30), 0);
    assert.equal(alphaAt(choked, 12, 30), 255, "and nothing beyond them is");
  });

  it("never touches RGB — a choke moves an edge, it does not recolour anything", () => {
    const framed = solid(40, 40, { r: 12, g: 200, b: 90 });
    const choked = chokeAlpha(framed, 1);
    for (let i = 0; i < framed.data.length; i += 4) {
      assert.equal(choked.data[i], framed.data[i]);
      assert.equal(choked.data[i + 1], framed.data[i + 1]);
      assert.equal(choked.data[i + 2], framed.data[i + 2]);
    }
  });
});

describe("tonal content measurement (Goal 3 input)", () => {
  it("reports no midtone for a flat solid logo — screening it would only remove ink", () => {
    const flat = solid(100, 100, { r: 255, g: 255, b: 255 });
    const measured = measureHalftoneTonalContent(flat, BLACK_GARMENT);
    assert.equal(measured.visiblePixelCount, 10_000);
    assert.equal(measured.midtoneFraction, 0);
  });

  it("reports no visible pixels for empty artwork", () => {
    const empty = solid(50, 50, { r: 0, g: 0, b: 0 }, 0);
    const measured = measureHalftoneTonalContent(empty, BLACK_GARMENT);
    assert.equal(measured.visiblePixelCount, 0);
    assert.equal(measured.midtoneFraction, 0);
  });

  it("reports substantial midtone for a tonal ramp — the artwork a screen is for", () => {
    const measured = measureHalftoneTonalContent(ramp(200, 200), BLACK_GARMENT);
    assert.ok(measured.midtoneFraction > 0.8);
  });
});

describe("garment preview (Goal 13 — preview only, never the export)", () => {
  it("composites over the garment colour and returns a fully opaque image", () => {
    const screened = applyHalftoneScreen(
      solid(60, 60, { r: 128, g: 128, b: 128 }),
      settings(),
      TARGET_PPI,
    );
    const preview = compositeOverGarment(screened.image, BLACK_GARMENT);
    for (let i = 3; i < preview.data.length; i += 4) {
      assert.equal(preview.data[i], 255);
    }
  });

  it("does not alter the plate it previews (Goal 13 / test matrix M)", () => {
    const screened = applyHalftoneScreen(
      solid(60, 60, { r: 128, g: 128, b: 128 }),
      settings(),
      TARGET_PPI,
    );
    const before = Buffer.from(screened.image.data);
    compositeOverGarment(screened.image, BLACK_GARMENT);
    compositeOverGarment(screened.image, WHITE_GARMENT);
    assert.ok(screened.image.data.equals(before));
  });
});

describe("luma", () => {
  it("normalizes to 0..1 with the Rec.709 weights", () => {
    assert.equal(encodedLuma(0, 0, 0), 0);
    // The Rec.709 weights sum to 1 in exact arithmetic but not in binary float.
    assert.ok(Math.abs(encodedLuma(255, 255, 255) - 1) < 1e-12);
    assert.ok(encodedLuma(0, 255, 0) > encodedLuma(255, 0, 0));
  });
});
