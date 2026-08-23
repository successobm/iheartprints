import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { analyzeArtwork } from "./image-analysis";
import { isolateBackground } from "./background-isolation";
import { decodePngUpload } from "./image-decode";
import { measureExteriorRemovalEnclosure } from "./enclosure-evidence";
import {
  bowlingStyleArtwork,
  foregroundRingArtwork,
  letterCounterArtwork,
  multipleCountersArtwork,
  solidBlackExteriorArtwork,
  whiteBackgroundArtwork,
} from "./artwork-fixtures";

/** Real bowling ORIGINAL — local-only, not committed. Skips cleanly in CI. */
const BOWLING_ORIGINAL = ".local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png";
const hasBowling = existsSync(BOWLING_ORIGINAL);

function prepare(image: RgbaImage): RgbaImage {
  const analysis = analyzeArtwork({
    image,
    format: "image/png",
    byteSize: image.data.length,
    declaresAlphaChannel: true,
    printPlacement: null,
    intendedPrintWidthIn: null,
  });
  return isolateBackground(image, {
    backgroundColor: analysis.estimatedBackgroundColor,
    tolerance: analysis.backgroundTolerance,
    guidedRemovalPoints: [],
  }).image;
}

describe("measureExteriorRemovalEnclosure — determinism", () => {
  it("A: the same pair of images always yields the same ratio", () => {
    const original = bowlingStyleArtwork();
    const prepared = prepare(original);
    const first = measureExteriorRemovalEnclosure(original, prepared);
    const second = measureExteriorRemovalEnclosure(original, prepared);
    assert.deepEqual(first, second);
  });

  it("rejects mismatched dimensions rather than reading out of bounds", () => {
    const a = solidBlackExteriorArtwork();
    const b = whiteBackgroundArtwork();
    assert.throws(() => measureExteriorRemovalEnclosure(a, { ...b, width: b.width + 1 }));
  });
});

describe("G: safe fixtures measure zero enclosure intrusion", () => {
  it("solidBlackExterior: ratio is exactly 0", () => {
    const original = solidBlackExteriorArtwork();
    const evidence = measureExteriorRemovalEnclosure(original, prepare(original));
    assert.equal(evidence.exteriorRemovalEnclosureRatio, 0);
    assert.ok(evidence.removedPixelCount > 0, "the background WAS removed");
  });

  it("whiteBackground: ratio is exactly 0", () => {
    const original = whiteBackgroundArtwork();
    const evidence = measureExteriorRemovalEnclosure(original, prepare(original));
    assert.equal(evidence.exteriorRemovalEnclosureRatio, 0);
  });
});

describe("H: non-zero intrusion is not converted into a damage claim", () => {
  // These are Phase 1's synthetic controls: legitimate closed shapes
  // (a ring's open middle, a letter's counter) whose removal correctly
  // enters a region the surviving design surrounds. The ratio is expected
  // to be POSITIVE here — that is the point of the fixture, not a failure.
  for (const [name, make] of [
    ["foregroundRing", foregroundRingArtwork],
    ["letterCounter", letterCounterArtwork],
    ["multipleCounters", multipleCountersArtwork],
  ] as const) {
    it(`${name}: measures positive enclosure intrusion (this is a CORRECT removal)`, () => {
      const original = make();
      const evidence = measureExteriorRemovalEnclosure(original, prepare(original));
      assert.ok(
        evidence.exteriorRemovalEnclosureRatio > 0,
        `${name} is expected to intrude into an enclosed region by design`,
      );
      // The function itself asserts nothing about correctness either way —
      // it has no concept of "damaged". This test exists to prove that the
      // NUMBER does not encode a verdict; the assessor (tested separately)
      // is what turns it into "review_required", never "unsafe".
    });
  }
});

describe("B: the tracked synthetic bowling-style fixture — signals genuinely differ", () => {
  it("the OLD signal fires, but the NEW signal correctly does not — this is the point", () => {
    // `bowlingStyleArtwork` gives its interior black line work real enclosed-
    // cavity evidence (see background-cavities.ts), so those pixels are
    // PRESERVED rather than removed. `interiorBackgroundColoredPixelsPreserved`
    // (the existing, weaker signal) fires — the design does contain
    // background-coloured pixels. But nothing removal actually TOOK sits
    // enclosed by surviving artwork, so `exteriorRemovalEnclosureRatio` is
    // correctly 0. The two signals answering different questions, and
    // disagreeing here, is exactly why Phase 2 promotes the stronger one
    // rather than reusing the existing field.
    const original = bowlingStyleArtwork();
    const analysis = analyzeArtwork({
      image: original,
      format: "image/png",
      byteSize: original.data.length,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    assert.ok(
      analysis.disconnectedBackgroundColoredPixels > 0,
      "the old signal (interiorBackgroundColoredPixelsPreserved) fires on this fixture",
    );
    const evidence = measureExteriorRemovalEnclosure(original, prepare(original));
    assert.equal(
      evidence.exteriorRemovalEnclosureRatio,
      0,
      "the new signal correctly finds no enclosed removal here — the lines were preserved, not removed",
    );
  });
});

describe(
  "B: the REAL live bowling asset — exact measured value",
  { skip: !hasBowling },
  () => {
    it("exteriorRemovalEnclosureRatio ≈ 0.4558 (Phase 1's measured value)", () => {
      const bytes = readFileSync(BOWLING_ORIGINAL);
      const original = decodePngUpload(bytes).image;
      const prepared = prepare(original);
      const evidence = measureExteriorRemovalEnclosure(original, prepared);
      assert.ok(
        Math.abs(evidence.exteriorRemovalEnclosureRatio - 0.4558) < 0.001,
        `expected ≈0.4558, got ${evidence.exteriorRemovalEnclosureRatio}`,
      );
    });
  },
);
