import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  alreadyTransparentArtwork,
  complexPhotographicBackgroundArtwork,
  edgeTouchingSubjectArtwork,
  enclosedBlackRegionArtwork,
  getPixel,
  haloArtwork,
  internalBlackOutlineArtwork,
  nearBlackBackgroundArtwork,
  solidBlackExteriorArtwork,
  whiteBackgroundArtwork,
} from "./artwork-fixtures";
import {
  BASE_BACKGROUND_TOLERANCE,
  MAX_BACKGROUND_TOLERANCE,
  computeExteriorMask,
  isolateBackground,
  passThroughTransparentArtwork,
  resolveBackgroundTolerance,
} from "./background-isolation";
import { analyzeArtwork } from "./image-analysis";
import { classifyRepairability } from "./repairability";

/**
 * The Phase 1 fixture suite (cases A–I of the acceptance plan). Every case is
 * a statement about the ONE property that makes edge-connected isolation
 * different from a colour threshold: reachability, not similarity, decides
 * what gets removed.
 */

function analyzeFor(image: ReturnType<typeof solidBlackExteriorArtwork>) {
  return analyzeArtwork({
    image,
    format: "image/png",
    byteSize: 1234,
    declaresAlphaChannel: true,
    printPlacement: null,
    intendedPrintWidthIn: null,
  });
}

function isolateFor(image: ReturnType<typeof solidBlackExteriorArtwork>) {
  const analysis = analyzeFor(image);
  return {
    analysis,
    ...isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    }),
  };
}

describe("resolveBackgroundTolerance", () => {
  it("stays at the audited baseline for a genuinely uniform export", () => {
    // The reference artwork measures an edge sigma of ≈0.53.
    assert.equal(resolveBackgroundTolerance(0.53), BASE_BACKGROUND_TOLERANCE);
    assert.equal(resolveBackgroundTolerance(0), BASE_BACKGROUND_TOLERANCE);
  });

  it("widens with measured edge noise but never past the ceiling", () => {
    assert.ok(resolveBackgroundTolerance(6) > BASE_BACKGROUND_TOLERANCE);
    assert.equal(resolveBackgroundTolerance(500), MAX_BACKGROUND_TOLERANCE);
  });
});

describe("A: solid black exterior", () => {
  it("makes the exterior transparent and leaves the subject fully opaque", () => {
    const image = solidBlackExteriorArtwork();
    const { image: prepared } = isolateFor(image);

    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.equal(getPixel(prepared, 119, 119).a, 0);
    assert.equal(getPixel(prepared, 60, 60).a, 255);
  });
});

describe("B: internal black outline", () => {
  it("keeps a black stroke that is enclosed by the subject", () => {
    const image = internalBlackOutlineArtwork();
    const { image: prepared, record } = isolateFor(image);

    // A pixel on the enclosed black stroke.
    const stroke = getPixel(prepared, 60, 41);
    assert.equal(stroke.a, 255);
    assert.ok(stroke.r < 40, `stroke should stay dark, got ${stroke.r}`);

    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.ok(
      record.interiorBackgroundColoredPixelsPreserved > 0,
      "the enclosed stroke must be counted as preserved, not removed",
    );
  });
});

describe("C: enclosed black region", () => {
  it("preserves a background-coloured region that nothing outside reaches", () => {
    const image = enclosedBlackRegionArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(getPixel(prepared, 60, 60).a, 255);
    // 20x20 region, minus whatever the fringe pass legitimately softens at
    // its own boundary — the interior is what matters.
    assert.ok(
      record.interiorBackgroundColoredPixelsPreserved >= 400,
      `expected the enclosed 20x20 region preserved, got ${record.interiorBackgroundColoredPixelsPreserved}`,
    );
    assert.equal(getPixel(prepared, 0, 0).a, 0);
  });
});

describe("D: near-black background", () => {
  it("removes an exterior whose values wander between 0 and 8", () => {
    const image = nearBlackBackgroundArtwork();
    const analysis = analyzeFor(image);
    // A 0–8 exterior is noisier than a truly flat export, so the adaptive
    // tolerance widens — but only slightly, and nowhere near the ceiling
    // where "background" would stop being a colour.
    assert.ok(analysis.backgroundTolerance >= BASE_BACKGROUND_TOLERANCE);
    assert.ok(analysis.backgroundTolerance <= 20);

    const { image: prepared } = isolateFor(image);
    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.equal(getPixel(prepared, 5, 90).a, 0);
    assert.equal(getPixel(prepared, 60, 60).a, 255);
  });
});

describe("E: white background", () => {
  it("runs the identical algorithm against a uniform white exterior", () => {
    const image = whiteBackgroundArtwork();
    const analysis = analyzeFor(image);
    assert.ok(analysis.estimatedBackgroundColor.r > 240);

    const { image: prepared } = isolateFor(image);
    assert.equal(getPixel(prepared, 0, 0).a, 0);
    assert.equal(getPixel(prepared, 60, 60).a, 255);
  });
});

describe("F: already transparent", () => {
  it("classifies as already transparent and performs no destructive pass", () => {
    const image = alreadyTransparentArtwork();
    const analysis = analyzeFor(image);
    const assessment = classifyRepairability(analysis);

    assert.equal(assessment.backgroundTreatment, "already_transparent");

    const { image: prepared, record } = passThroughTransparentArtwork(
      image,
      analysis.estimatedBackgroundColor,
      analysis.backgroundTolerance,
    );
    assert.equal(record.backgroundRemoved, false);
    assert.equal(record.exteriorPixelsRemoved, 0);
    assert.ok(prepared.data.equals(image.data), "not a single pixel may change");
  });
});

describe("G: edge-touching subject", () => {
  it("does not clip a subject merely because it reaches the border", () => {
    const image = edgeTouchingSubjectArtwork();
    const { image: prepared } = isolateFor(image);

    // The subject runs to x = 0 across rows 40..79.
    assert.equal(getPixel(prepared, 0, 60).a, 255);
    assert.equal(getPixel(prepared, 40, 60).a, 255);
    // The exterior above and below it is still removed.
    assert.equal(getPixel(prepared, 0, 5).a, 0);
    assert.equal(getPixel(prepared, 0, 115).a, 0);
  });
});

describe("H: halo / matte contamination", () => {
  it("lightens the dark fringe without touching interior line work", () => {
    const image = haloArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.ok(
      record.decontaminatedPixels > 0,
      "an anti-aliased edge over dark background must produce fringe corrections",
    );

    // Walk inward along the horizontal centre line to the first partially
    // transparent pixel: that is the anti-aliased rim.
    let fringeX = -1;
    for (let x = 0; x < prepared.width; x += 1) {
      const alpha = getPixel(prepared, x, 70).a;
      if (alpha > 0 && alpha < 255) {
        fringeX = x;
        break;
      }
    }
    assert.ok(fringeX >= 0, "expected a partially transparent rim pixel");

    const originalFringe = getPixel(image, fringeX, 70);
    const preparedFringe = getPixel(prepared, fringeX, 70);
    assert.ok(
      preparedFringe.r > originalFringe.r,
      `fringe should be decontaminated toward the subject colour (${originalFringe.r} → ${preparedFringe.r})`,
    );

    // The interior dark stroke is nowhere near the removed exterior and must
    // be byte-identical.
    const strokeBefore = getPixel(image, 70, 47);
    const strokeAfter = getPixel(prepared, 70, 47);
    assert.deepEqual(strokeAfter, strokeBefore);
  });
});

describe("I: complex photographic background", () => {
  it("refuses to mask and asks for review instead", () => {
    const image = complexPhotographicBackgroundArtwork();
    const analysis = analyzeFor(image);
    const assessment = classifyRepairability(analysis);

    assert.equal(assessment.classification, "NEEDS_REVIEW");
    assert.equal(assessment.backgroundTreatment, "manual_review");
    assert.equal(assessment.canPrepareAutomatically, false);
  });
});

describe("computeExteriorMask", () => {
  it("never spreads diagonally through a one-pixel gap in an outline", () => {
    // A closed white ring around a black core, with a diagonal-only pinch:
    // 8-connectivity would leak into the core and delete it.
    const image = solidBlackExteriorArtwork();
    const analysis = analyzeFor(image);
    const mask = computeExteriorMask(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.ok(mask.bounds);
    assert.equal(mask.bounds!.width, 60);
    assert.equal(mask.bounds!.height, 60);
  });

  it("counts colour matches that no border-connected path reaches", () => {
    const image = enclosedBlackRegionArtwork();
    const analysis = analyzeFor(image);
    const mask = computeExteriorMask(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.equal(mask.disconnectedMatchCount, 400);
  });
});

describe("isolateBackground", () => {
  it("never mutates the source image", () => {
    const image = solidBlackExteriorArtwork();
    const before = Buffer.from(image.data);
    isolateFor(image);
    assert.ok(image.data.equals(before));
  });

  it("preserves geometry exactly", () => {
    const image = haloArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.equal(prepared.width, image.width);
    assert.equal(prepared.height, image.height);
    assert.equal(record.aspectRatioPreserved, true);
  });

  it("bleeds artwork colour into the transparent guard band", () => {
    // Transparent pixels still carry RGB, and every resample in this codebase
    // interpolates RGB independently of alpha — an un-bled near-black would
    // reappear as a halo during Phase 2 upscaling.
    const image = solidBlackExteriorArtwork();
    const { image: prepared, record } = isolateFor(image);

    assert.ok(record.haloGuardPixels > 0);
    const justOutside = getPixel(prepared, 29, 60);
    assert.equal(justOutside.a, 0);
    assert.ok(
      justOutside.r > 100,
      `guard-band colour should come from the artwork, got ${justOutside.r}`,
    );
  });
});
