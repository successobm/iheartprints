import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  createCanvas,
  darkOutlinedDisplayArtwork,
  darkOutlinedTaglineArtwork,
  enclosedBlackRegionArtwork,
  fillEllipse,
  fillRect,
  fingerHoleArtwork,
  foregroundRingArtwork,
  getPixel,
  GOLD,
  hairlineCounterArtwork,
  haloArtwork,
  internalBlackOutlineArtwork,
  intentionalShadowArtwork,
  letterCounterArtwork,
  lightBackgroundCounterArtwork,
  lowContrastLightWallArtwork,
  multipleCountersArtwork,
  nearBlackForegroundArtwork,
  NEAR_BLACK,
  solidBlackExteriorArtwork,
  WHITE,
} from "./artwork-fixtures";
import {
  CAVITY_WALL_BASE_PX,
  CAVITY_WALL_INRADIUS_RATIO,
  expandMaskWithBackgroundCavities,
} from "./background-cavities";
import { computeExteriorMask, isolateBackground } from "./background-isolation";
import { analyzeArtwork } from "./image-analysis";

/**
 * ENCLOSED BACKGROUND CAVITIES.
 *
 * The exterior fill removes background reachable from the border. This suite
 * is about the background it cannot reach — the counter inside a letterform,
 * the open middle of a ring — and, far more importantly, about the artwork
 * that looks exactly like it and must survive.
 *
 * Every case here is a statement about the safety invariant:
 *
 *   Background removal may remove pixels only when the system has affirmative
 *   evidence that they belong to the detected background. Colour similarity
 *   alone is insufficient. Enclosure alone is insufficient.
 *
 * The negative controls are load-bearing. A suite that only proved counters
 * disappear would pass just as happily for "remove every black pixel", which
 * would destroy the customer's line work.
 */

function analyzeFor(image: RgbaImage) {
  return analyzeArtwork({
    image,
    format: "image/png",
    byteSize: 1234,
    declaresAlphaChannel: false,
    printPlacement: null,
    intendedPrintWidthIn: null,
  });
}

function isolateFor(image: RgbaImage) {
  const analysis = analyzeFor(image);
  return {
    analysis,
    ...isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    }),
  };
}

describe("A: solid dark exterior around foreground artwork", () => {
  it("still removes the exterior, and finds no cavity to argue about", () => {
    const image = solidBlackExteriorArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.equal(getPixel(prepared, 60, 60).a, 255);
    assert.ok(record.exteriorPixelsRemoved > 0);
    assert.equal(record.enclosedCavityRegionsRemoved, 0);
    assert.equal(record.enclosedCavityPixelsRemoved, 0);
  });
});

describe("B: foreground ring enclosing true background", () => {
  it("makes the enclosed background transparent and leaves the ring intact", () => {
    const image = foregroundRingArtwork();
    const { image: prepared, record, cavities } = isolateFor(image);

    // The middle of the ring: background, sealed off from the border.
    assert.equal(getPixel(prepared, 60, 60).a, 0);
    // The ring itself.
    assert.equal(getPixel(prepared, 60, 27).a, 255);
    // And the exterior, as before.
    assert.equal(getPixel(prepared, 0, 0).a, 0);

    assert.equal(record.enclosedCavityRegionsRemoved, 1);
    assert.equal(cavities.regions[0]!.decision, "removed_enclosed_background");
  });
});

describe("C: typography-like shape with an enclosed counter", () => {
  it("removes the counter without touching the stroke around it", () => {
    const image = letterCounterArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(getPixel(prepared, 60, 60).a, 0, "counter should be transparent");
    assert.equal(getPixel(prepared, 35, 60).a, 255, "left stroke must survive");
    assert.equal(getPixel(prepared, 85, 60).a, 255, "right stroke must survive");
    assert.equal(getPixel(prepared, 60, 25).a, 255, "top stroke must survive");

    // 24 x 56 counter, removed whole.
    assert.equal(record.enclosedCavityPixelsRemoved, 1344);
  });
});

describe("D: multiple enclosed counters at different scales", () => {
  it("removes all of them, including the 4px-wall small-wording case", () => {
    const image = multipleCountersArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(record.enclosedCavityRegionsRemoved, 3);
    assert.equal(record.enclosedCavityRegionsPreserved, 0);

    assert.equal(getPixel(prepared, 35, 55).a, 0, "display-size counter");
    assert.equal(getPixel(prepared, 87, 45).a, 0, "body-size counter");
    assert.equal(getPixel(prepared, 124, 36).a, 0, "small-wording counter");

    // Every glyph body is still there.
    assert.equal(getPixel(prepared, 15, 55).a, 255);
    assert.equal(getPixel(prepared, 73, 45).a, 255);
    assert.equal(getPixel(prepared, 116, 36).a, 255);
  });
});

describe("E: intentional black holes inside coloured foreground — THE NEGATIVE CONTROL", () => {
  it("preserves a bowling ball's finger holes, which are enclosed and background-coloured", () => {
    const image = fingerHoleArtwork();
    const { image: prepared, record, cavities } = isolateFor(image);

    for (const hole of [
      { x: 130, y: 120 },
      { x: 190, y: 120 },
      { x: 160, y: 175 },
    ]) {
      const pixel = getPixel(prepared, hole.x, hole.y);
      assert.equal(pixel.a, 255, `finger hole at ${hole.x},${hole.y} must survive`);
      assert.ok(pixel.r < 40, `finger hole must stay dark, got ${pixel.r}`);
    }

    assert.equal(record.enclosedCavityRegionsRemoved, 0);
    assert.equal(record.enclosedCavityRegionsPreserved, 3);
    for (const region of cavities.regions) {
      assert.equal(region.decision, "preserved_wall_thicker_than_cavity");
      // The whole argument, in two numbers: the ball around each hole is far
      // thicker than the hole is wide.
      assert.ok(
        region.wallThicknessPx! >
          CAVITY_WALL_INRADIUS_RATIO * region.inradiusPx + CAVITY_WALL_BASE_PX,
      );
    }
  });

  it("leaves the ball's interior pixels byte-identical", () => {
    const image = fingerHoleArtwork();
    const { image: prepared } = isolateFor(image);

    // Deep interior, well away from any removed boundary.
    for (const point of [
      { x: 160, y: 145 },
      { x: 130, y: 145 },
      { x: 160, y: 200 },
    ]) {
      assert.deepEqual(
        getPixel(prepared, point.x, point.y),
        getPixel(image, point.x, point.y),
      );
    }
  });
});

describe("F: intentional black outline", () => {
  it("keeps an enclosed stroke — thin, but buried deep in the subject", () => {
    const image = internalBlackOutlineArtwork();
    const { image: prepared, record, cavities } = isolateFor(image);

    assert.equal(getPixel(prepared, 60, 41).a, 255);
    assert.equal(record.enclosedCavityRegionsRemoved, 0);
    assert.equal(
      cavities.regions[0]!.decision,
      "preserved_wall_thicker_than_cavity",
    );
    assert.ok(record.interiorBackgroundColoredPixelsPreserved > 0);
  });

  it("keeps an enclosed region that a previous phase already audited", () => {
    // Fixture C of the original Phase 1 suite: a 20x20 black square inside a
    // gold plate. Nothing about cavity detection may change this answer.
    const image = enclosedBlackRegionArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(getPixel(prepared, 60, 60).a, 255);
    assert.equal(record.enclosedCavityRegionsRemoved, 0);
    assert.ok(record.interiorBackgroundColoredPixelsPreserved >= 400);
  });
});

describe("G: intentional black shadow", () => {
  it("keeps a drop-shadow band under a shape", () => {
    const image = intentionalShadowArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(getPixel(prepared, 120, 160).a, 255);
    assert.equal(record.enclosedCavityRegionsRemoved, 0);
  });

  it("keeps an interior stroke sitting next to an anti-aliased rim", () => {
    // The halo fixture: an intentional dark bar inside a feathered subject.
    const image = haloArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.deepEqual(getPixel(prepared, 70, 47), getPixel(image, 70, 47));
    assert.equal(record.enclosedCavityRegionsRemoved, 0);
  });
});

describe("H: dark-inked outlines are foreground, however low-contrast", () => {
  /**
   * THE REAL-FILE REGRESSION.
   *
   * The customer's bowling artwork is outlined in dark ink — measured
   * (16,8,0) against a (1,1,1) background. That is unambiguously foreground
   * under the background model (Chebyshev 15 vs a tolerance of 12) but only
   * ~17 Euclidean away from the background. The classifier's boundary gate
   * demanded 48, so it refused 129 of the file's counters.
   *
   * `SOLID_REFERENCE_MIN_DISTANCE` answers "is there enough colour separation
   * to divide by?" for fringe decontamination. It is not an answer to "is
   * this foreground structure?", and borrowing it here silently required
   * customer artwork to be high-contrast.
   */
  it("removes a counter whose enclosing wall is dark ink, not bright fill", () => {
    const image = darkOutlinedTaglineArtwork();
    const { image: prepared, record, cavities } = isolateFor(image);

    const region = cavities.regions.find((candidate) => candidate.pixelCount > 100)!;
    assert.equal(region.boundaryForegroundFraction, 1, "the wall is outside the model");
    assert.equal(
      region.boundaryHighContrastFraction,
      0,
      "and would have scored zero under the old contrast rule",
    );
    assert.equal(region.decision, "removed_enclosed_background");

    assert.equal(getPixel(prepared, 45, 60).a, 0, "the counter goes transparent");
    assert.ok(record.enclosedCavityRegionsRemoved >= 1);

    // Both dark outlines are byte-identical: 3px of ink survives having the
    // background removed from BOTH of its sides. Before the composite check
    // in `cleanFringe`, the middle of each outline was punched to alpha 10 and
    // recoloured to a saturated (255,183,0).
    for (const x of [32, 33, 34, 39, 40, 51, 52]) {
      assert.deepEqual(
        getPixel(prepared, x, 60),
        getPixel(image, x, 60),
        `outline pixel x=${x} must be untouched`,
      );
    }
  });

  it("does the same on a light background with an equally low-contrast wall", () => {
    const image = lowContrastLightWallArtwork();
    const { image: prepared, cavities } = isolateFor(image);

    const region = cavities.regions[0]!;
    assert.equal(region.boundaryForegroundFraction, 1);
    assert.equal(region.boundaryHighContrastFraction, 0);
    assert.equal(getPixel(prepared, 60, 60).a, 0);
    assert.equal(getPixel(prepared, 35, 60).a, 255);
  });

  it("consequently no longer protects a dark fill behind a dark thin wall", () => {
    // This case used to be preserved, and its protection came ENTIRELY from
    // the 48-distance rule. That protection is not recoverable: the synthetic
    // charcoal wall here sits ~45 Euclidean from the background, FURTHER than
    // the customer's real (16,8,0) outline at ~17. Any contrast threshold
    // that preserves this fixture also refuses the real file's counters, so
    // the two requirements are mutually exclusive and the real file wins.
    //
    // Recorded as a test rather than deleted, because it is a real behaviour
    // change and the Original-vs-Prepared comparison is now the safeguard.
    const image = nearBlackForegroundArtwork();
    const { record, cavities } = isolateFor(image);

    const region = cavities.regions[0]!;
    assert.equal(region.boundaryForegroundFraction, 1);
    assert.ok(region.boundaryHighContrastFraction < 0.05);
    assert.equal(record.enclosedCavityRegionsRemoved, 1);
  });
});

describe("Phase 1.2 Part A: the hairline counter allowance", () => {
  /**
   * The one automatic change the real-file audit justified.
   *
   * Two genuine tagline counters on the customer's artwork — the enclosed
   * slots in the `R` and the `B` of "DISTURBING FROM DAY ONE" — measured
   * inradius 1 and wall 7 and were refused, because at inradius 1 the ratio
   * term contributes under two pixels and the base allowance of 4 decided the
   * case alone.
   *
   * This is a statement about hairline strokes at raster scale, NOT a
   * relaxation of the mass-vs-hole rule: the base is a constant, so it is
   * swamped by the ratio term everywhere the cavity is not near-zero-sized.
   * The negative control below is what holds it honest.
   */
  it("removes a 1px-inradius counter behind a 7px wall", () => {
    const image = hairlineCounterArtwork();
    const { cavities } = isolateFor(image);

    const region = cavities.regions.find((candidate) => candidate.pixelCount > 20)!;
    assert.equal(region.inradiusPx, 1, "the real hairline geometry");
    assert.equal(region.wallThicknessPx, 7);
    assert.equal(
      CAVITY_WALL_INRADIUS_RATIO * region.inradiusPx + CAVITY_WALL_BASE_PX >= 7,
      true,
      "1.75 * 1 + 6 = 7.75 reaches it; the previous 5.75 did not",
    );
    assert.equal(region.decision, "removed_enclosed_background");
    assert.equal(getPixel(isolateFor(image).image, 26, 40).a, 0);
  });

  it("still refuses the finger-hole control by a wide margin", () => {
    // THE GOVERNING NEGATIVE CONTROL, at the real audited geometry: a finger
    // hole measuring inradius 9 / wall 26 against an allowance that the base
    // change moved only from 19.75 to 21.75. Still preserved, with 4px to
    // spare.
    assert.equal(CAVITY_WALL_INRADIUS_RATIO * 9 + CAVITY_WALL_BASE_PX, 21.75);
    assert.ok(21.75 < 26, "the real finger hole stays out of reach");

    const image = fingerHoleArtwork();
    const { cavities, image: prepared } = isolateFor(image);
    for (const region of cavities.regions) {
      assert.equal(region.removed, false);
    }
    for (const [x, y] of [
      [130, 120],
      [190, 120],
      [160, 175],
    ] as const) {
      assert.deepEqual(getPixel(prepared, x, y), getPixel(image, x, y));
    }
  });

  it("leaves the ambiguous large-counter class exactly where it was", () => {
    // The base change must not accidentally reach the display counters. It
    // does not, and it could not: their inradius is 11, so the ratio term
    // dominates and the two extra pixels of base are noise.
    const image = darkOutlinedDisplayArtwork();
    const { cavities } = isolateFor(image);
    const region = cavities.regions.find((candidate) => candidate.pixelCount > 500)!;
    assert.equal(region.decision, "preserved_wall_thicker_than_cavity");
  });
});

describe("the open case: display-scale counters inside a compound stroke", () => {
  /**
   * CHARACTERIZATION, not endorsement, and now RESOLVED — by asking the
   * customer rather than by moving a threshold.
   *
   * With the boundary evidence corrected, the real file's large counters are
   * refused purely on geometry: an outlined display face carries a compound
   * wall (outer outline + fill + inner outline) thicker than 1.75x the
   * counter's inradius. Audited real values: wall 61 against an allowance of
   * 26.75, and wall 26 against 19.75. This fixture reproduces that at 31
   * against 23.25.
   *
   * THE CONSTANT IS NOT SIMPLY TOO LOW, and the full real-file audit settled
   * why. Across the customer's artwork the wall/inradius statistic measures
   * 2.11–5.29 for genuine letter counters and 2.89–4.69 for the bowling ball's
   * finger holes: the finger holes sit INSIDE the counter range, so the
   * populations are nested and NO threshold separates them. Raising the ratio
   * far enough to reach the counters deletes the finger holes first.
   *
   * These regions are therefore permanently ambiguous to every measurement
   * available, and the system's answer is to preserve them and let the
   * customer point at the ones that are background
   * (`guided-removal.test.ts`). That is why this test pins PRESERVATION as
   * correct behaviour rather than as a known defect.
   */
  it("passes the boundary evidence and is refused only by the wall metric", () => {
    const image = darkOutlinedDisplayArtwork();
    const { cavities } = isolateFor(image);

    const region = cavities.regions.find((candidate) => candidate.pixelCount > 500)!;
    assert.equal(region.boundaryForegroundFraction, 1);
    assert.equal(region.decision, "preserved_wall_thicker_than_cavity");
    assert.equal(region.inradiusPx, 11);
    assert.equal(region.wallThicknessPx, 31);
  });
});

describe("I: light background equivalent", () => {
  it("runs the identical code path with a white background and a dark subject", () => {
    const image = lightBackgroundCounterArtwork();
    const analysis = analyzeFor(image);
    assert.ok(analysis.estimatedBackgroundColor.r > 240);

    const { image: prepared, record } = isolateFor(image);
    assert.equal(getPixel(prepared, 60, 60).a, 0, "the light counter is background too");
    assert.equal(getPixel(prepared, 35, 60).a, 255);
    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.equal(record.enclosedCavityRegionsRemoved, 1);
  });
});

describe("the safety invariant", () => {
  it("does nothing at all without a confirmed exterior background", () => {
    // No exterior mask means no background model. Colour similarity on its own
    // must never be enough to remove anything.
    const image = letterCounterArtwork();
    const analysis = analyzeFor(image);
    const emptyMask = new Uint8Array(image.width * image.height);

    const result = expandMaskWithBackgroundCavities(image, emptyMask, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.equal(result.removedRegionCount, 0);
    assert.deepEqual(result.regions, []);
    assert.ok(result.mask.every((value) => value === 0));
  });

  it("never mutates the exterior mask it was handed", () => {
    const image = foregroundRingArtwork();
    const analysis = analyzeFor(image);
    const exterior = computeExteriorMask(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });
    const before = Uint8Array.from(exterior.mask);

    const result = expandMaskWithBackgroundCavities(image, exterior.mask, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.deepEqual(exterior.mask, before);
    assert.ok(result.removedPixelCount > 0, "and the copy is what changed");
  });

  it("preserves a region no foreground path reaches, rather than guessing", () => {
    // A dark dot sealed inside a closed dark ring. The ring blocks every route
    // from the exterior, so there is no wall to measure and therefore no
    // evidence — which means preserve.
    const image = createCanvas(240, 240, NEAR_BLACK);
    fillEllipse(image, 120, 120, 80, 80, GOLD);
    fillEllipse(image, 120, 120, 48, 48, NEAR_BLACK);
    fillEllipse(image, 120, 120, 40, 40, GOLD);
    fillEllipse(image, 120, 120, 6, 6, NEAR_BLACK);

    const { image: prepared, cavities } = isolateFor(image);

    const sealed = cavities.regions.find(
      (region) => region.decision === "preserved_unreachable_from_exterior",
    );
    assert.ok(sealed, "the innermost dot should be unreachable, not removed");
    assert.equal(sealed!.wallThicknessPx, null);
    assert.equal(getPixel(prepared, 120, 120).a, 255);
  });

  it("removes nothing when cavity removal would consume the whole canvas", () => {
    // A hairline frame inset one pixel from the border. Its interior really is
    // enclosed background, but acting on it would leave a 0.4%-of-canvas
    // outline behind — which means the background model is wrong about
    // something, and the honest response is to touch none of it.
    const size = 900;
    const image = createCanvas(size, size, NEAR_BLACK);
    fillRect(image, 1, 1, size - 2, 1, WHITE);
    fillRect(image, 1, size - 2, size - 2, 1, WHITE);
    fillRect(image, 1, 1, 1, size - 2, WHITE);
    fillRect(image, size - 2, 1, 1, size - 2, WHITE);

    const analysis = analyzeFor(image);
    const exterior = computeExteriorMask(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });
    const result = expandMaskWithBackgroundCavities(image, exterior.mask, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.equal(result.combinedMaskGuardTripped, true);
    assert.equal(result.removedRegionCount, 0);
    assert.equal(result.regions[0]!.decision, "preserved_combined_mask_guard");
  });
});

describe("record accounting", () => {
  it("splits the disconnected background-coloured pool into removed and preserved", () => {
    const image = fingerHoleArtwork();
    const analysis = analyzeFor(image);
    const { record } = isolateFor(image);

    // Nothing was removed here, so every disconnected match is still reported
    // as preserved.
    assert.equal(
      record.interiorBackgroundColoredPixelsPreserved,
      analysis.disconnectedBackgroundColoredPixels,
    );

    // And where cavities ARE removed, the preserved count drops by exactly
    // what left.
    const counters = letterCounterArtwork();
    const counterAnalysis = analyzeFor(counters);
    const counterRecord = isolateFor(counters).record;
    assert.equal(
      counterRecord.interiorBackgroundColoredPixelsPreserved,
      counterAnalysis.disconnectedBackgroundColoredPixels -
        counterRecord.enclosedCavityPixelsRemoved,
    );
  });
});
