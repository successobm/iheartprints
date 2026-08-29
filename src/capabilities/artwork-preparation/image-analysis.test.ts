import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  alreadyTransparentArtwork,
  complexPhotographicBackgroundArtwork,
  createCanvas,
  enclosedBlackRegionArtwork,
  fillRect,
  NEAR_BLACK,
  solidBlackExteriorArtwork,
  TRANSPARENT,
  whiteBackgroundArtwork,
  WHITE,
} from "./artwork-fixtures";
import {
  analyzeArtwork,
  measureEdgeStatistics,
  measurePixelSufficiency,
} from "./image-analysis";
import { classifyRepairability } from "./repairability";
import { describeArtworkForCustomer, describeApprovedPreparation } from "./preparation-copy";

function analyze(
  image: RgbaImage,
  overrides: Partial<Parameters<typeof analyzeArtwork>[0]> = {},
) {
  return analyzeArtwork({
    image,
    format: "image/png",
    byteSize: 4096,
    declaresAlphaChannel: true,
    printPlacement: null,
    intendedPrintWidthIn: null,
    ...overrides,
  });
}

describe("measureEdgeStatistics", () => {
  it("finds a robust background colour that one odd pixel cannot move", () => {
    const image = createCanvas(60, 60, NEAR_BLACK);
    // A single blazing corner pixel — the classic way a naive mean or a
    // corner-sampled estimate picks the wrong background.
    fillRect(image, 0, 0, 1, 1, { r: 255, g: 0, b: 255, a: 255 });

    const edge = measureEdgeStatistics(image);
    assert.deepEqual(edge.dominantColor, { r: 0, g: 0, b: 0 });
    assert.ok(edge.dominantColorCoverage > 0.99);
  });

  it("measures the border ring, not the interior", () => {
    const image = createCanvas(60, 60, NEAR_BLACK);
    fillRect(image, 10, 10, 40, 40, WHITE);

    const edge = measureEdgeStatistics(image);
    assert.equal(edge.sampleCount, 60 * 4 - 4);
    assert.deepEqual(edge.dominantColor, { r: 0, g: 0, b: 0 });
    assert.equal(edge.maxChannelStandardDeviation, 0);
  });

  it("reports how much of the border is already transparent", () => {
    const edge = measureEdgeStatistics(alreadyTransparentArtwork());
    assert.equal(edge.transparentFraction, 1);
  });

  it("reports high deviation for a busy exterior", () => {
    const edge = measureEdgeStatistics(complexPhotographicBackgroundArtwork());
    assert.ok(edge.maxChannelStandardDeviation > 24);
    assert.ok(edge.dominantColorCoverage < 0.85);
  });
});

describe("analyzeArtwork", () => {
  it("measures transparency rather than trusting the declared colour type", () => {
    const opaque = analyze(solidBlackExteriorArtwork(), {
      declaresAlphaChannel: true,
    });
    assert.equal(opaque.declaresAlphaChannel, true);
    assert.equal(opaque.hasTransparency, false);
    assert.equal(opaque.fullyOpaque, true);
    assert.equal(opaque.fullyTransparent, false);
  });

  it("reports an empty canvas as fully transparent with no artwork bounds", () => {
    const analysis = analyze(createCanvas(40, 40, TRANSPARENT));
    assert.equal(analysis.fullyTransparent, true);
    assert.equal(analysis.artworkBounds, null);
  });

  it("bounds the visible artwork, not the canvas", () => {
    const analysis = analyze(solidBlackExteriorArtwork());
    assert.deepEqual(analysis.artworkBounds, {
      left: 30,
      top: 30,
      right: 90,
      bottom: 90,
      width: 60,
      height: 60,
    });
    assert.ok(analysis.deadCanvasFraction > 0.7);
  });

  it("counts background-coloured pixels the border cannot reach", () => {
    const analysis = analyze(enclosedBlackRegionArtwork());
    assert.equal(analysis.disconnectedBackgroundColoredPixels, 400);
  });

  it("is confident about a flat exterior and unconfident about a busy one", () => {
    assert.ok(analyze(whiteBackgroundArtwork()).backgroundConfidence > 0.9);
    assert.ok(
      analyze(complexPhotographicBackgroundArtwork()).backgroundConfidence < 0.5,
    );
  });

  it("is deterministic — the same bytes always produce the same analysis", () => {
    const first = analyze(solidBlackExteriorArtwork());
    const second = analyze(solidBlackExteriorArtwork());
    assert.deepEqual(first, second);
  });
});

describe("measurePixelSufficiency", () => {
  it("says nothing at all when there is no print placement yet", () => {
    assert.equal(measurePixelSufficiency(1000, 1000, null, null), null);
  });

  it("reads the shared placement policy rather than restating a print size (square artwork -- the box never narrows a square)", () => {
    const sufficiency = measurePixelSufficiency(923, 923, "full_front", null);
    assert.ok(sufficiency);
    assert.equal(sufficiency!.targetWidthIn, 10.5);
    assert.equal(sufficiency!.targetPpi, 300);
    assert.equal(sufficiency!.requiredWidthPx, 3150);
    assert.equal(sufficiency!.sufficient, false);
  });

  it("honours a customer-chosen production width -- the assumed garment box never overrides an explicit width", () => {
    const sufficiency = measurePixelSufficiency(1200, 1200, "full_front", 4);
    assert.equal(sufficiency!.requiredWidthPx, 1200);
    assert.equal(sufficiency!.sufficient, true);
  });

  it("Phase 28C/28S: a tall/portrait artwork's required width is CONTAINED against the assumed Standard Adult box, not the placement's flat 10.5in default", () => {
    // A 2:3 portrait (height = 1.5x width) is classified portrait (Phase
    // 28S), so it is height-controlled against the PLACEMENT's own 14in
    // technical ceiling, not the flat 10.5x10.5 recommendation box a
    // square/landscape design would use: widthIn = 14/1.5 = 9.333...
    // (Phase 28C originally asserted 10.5/1.5 = 7.0 here -- the flat-box
    // number Phase 28S found was never meant to be a portrait ceiling; see
    // `orientedProductionBox`'s doc comment in garment-production-sizing.ts.)
    const sufficiency = measurePixelSufficiency(2000, 3000, "full_front", null);
    assert.ok(sufficiency);
    assert.equal(sufficiency!.targetWidthIn, 14 / 1.5);
    assert.equal(sufficiency!.requiredWidthPx, Math.round((14 / 1.5) * 300));
    // 2000px already exceeds the ~2800px this artwork actually needs at its
    // correctly-contained ~9.33in width -- nowhere near the old 3150px
    // (10.5in) requirement a flat width-only check would have wrongly
    // demanded.
    assert.equal(sufficiency!.sufficient, false);
    assert.ok(
      sufficiency!.requiredWidthPx < 3150,
      "the contained requirement must be strictly less than the old flat 10.5in requirement",
    );
  });

  it("measures the artwork's width, never the padded canvas", () => {
    // A 120px canvas whose visible artwork is only 60px wide.
    const analysis = analyze(solidBlackExteriorArtwork(), {
      printPlacement: "sleeve",
    });
    assert.equal(analysis.pixelSufficiency!.availableWidthPx, 60);
  });
});

describe("classifyRepairability", () => {
  it("PRINT_READY_ALREADY: transparent and big enough for the target", () => {
    const image = createCanvas(4000, 4000, TRANSPARENT);
    fillRect(image, 100, 100, 3800, 3800, WHITE);
    const assessment = classifyRepairability(
      analyze(image, { printPlacement: "full_front" }),
    );

    assert.equal(assessment.classification, "PRINT_READY_ALREADY");
    assert.equal(assessment.backgroundTreatment, "already_transparent");
    assert.equal(assessment.enhancementRequired, false);
  });

  it("REPAIRABLE_AUTOMATICALLY: uniform exterior, no placement to fall short of", () => {
    const assessment = classifyRepairability(analyze(solidBlackExteriorArtwork()));
    assert.equal(assessment.classification, "REPAIRABLE_AUTOMATICALLY");
    assert.equal(assessment.backgroundTreatment, "remove_exterior");
    assert.equal(assessment.canPrepareAutomatically, true);
  });

  it("REQUIRES_ENHANCEMENT: same artwork, but too few pixels for the target", () => {
    const assessment = classifyRepairability(
      analyze(solidBlackExteriorArtwork(), { printPlacement: "full_front" }),
    );

    assert.equal(assessment.classification, "REQUIRES_ENHANCEMENT");
    assert.equal(assessment.enhancementRequired, true);
    // The background is still safely removable — enhancement is a separate,
    // later problem and must not block preparation.
    assert.equal(assessment.backgroundTreatment, "remove_exterior");
    assert.equal(assessment.canPrepareAutomatically, true);
  });

  it("NEEDS_REVIEW: a photographic exterior is never aggressively masked", () => {
    const assessment = classifyRepairability(
      analyze(complexPhotographicBackgroundArtwork()),
    );
    assert.equal(assessment.classification, "NEEDS_REVIEW");
    assert.equal(assessment.canPrepareAutomatically, false);
  });

  it("NOT_REPAIRABLE: there is no visible artwork at all", () => {
    const assessment = classifyRepairability(analyze(createCanvas(40, 40, TRANSPARENT)));
    assert.equal(assessment.classification, "NOT_REPAIRABLE");
    assert.equal(assessment.backgroundTreatment, "none");
  });

  it("prefers review over damage when the fill would consume the whole canvas", () => {
    // A flat canvas with nothing on it but background.
    const assessment = classifyRepairability(analyze(createCanvas(80, 80, NEAR_BLACK)));
    assert.equal(assessment.canPrepareAutomatically, false);
  });
});

describe("customer-facing copy", () => {
  it("never mentions the mechanism", () => {
    const analysis = analyze(solidBlackExteriorArtwork(), {
      printPlacement: "full_front",
    });
    const view = describeArtworkForCustomer(analysis, classifyRepairability(analysis));
    const allCopy = [
      view.backgroundMessage,
      view.resolutionMessage ?? "",
      view.prepareActionLabel ?? "",
    ]
      .join(" ")
      .toLowerCase();

    for (const jargon of [
      "flood",
      "sigma",
      "tolerance",
      "mask",
      "alpha",
      "rgb",
      "pixel",
      "dpi",
      "ppi",
      "provider",
      "threshold",
    ]) {
      assert.ok(!allCopy.includes(jargon), `copy leaked "${jargon}": ${allCopy}`);
    }
  });

  it("says the background can be removed automatically", () => {
    const analysis = analyze(solidBlackExteriorArtwork());
    const view = describeArtworkForCustomer(analysis, classifyRepairability(analysis));
    assert.equal(
      view.backgroundMessage,
      "Your artwork has a solid background that can be removed automatically.",
    );
  });

  it("names enhancement as a later step, never as something that happened", () => {
    const analysis = analyze(solidBlackExteriorArtwork(), {
      printPlacement: "full_front",
    });
    const view = describeArtworkForCustomer(analysis, classifyRepairability(analysis));

    assert.equal(view.enhancementNeeded, true);
    assert.match(view.resolutionMessage!, /smaller than the recommended print resolution/);
    assert.match(view.resolutionMessage!, /We'll need to enhance it before/);
  });

  it("explains a complex background without offering a destructive action", () => {
    const analysis = analyze(complexPhotographicBackgroundArtwork());
    const view = describeArtworkForCustomer(analysis, classifyRepairability(analysis));

    assert.match(view.backgroundMessage, /complex/);
    assert.equal(view.canPrepare, false);
    assert.equal(view.prepareActionLabel, null);
  });

  it("stays silent about print size until a placement is known", () => {
    const analysis = analyze(solidBlackExteriorArtwork());
    const view = describeArtworkForCustomer(analysis, classifyRepairability(analysis));
    assert.equal(view.resolutionMessage, null);
  });

  it("approved terminal copy never overclaims print readiness", () => {
    const needsEnhancement = describeApprovedPreparation(true);
    assert.equal(needsEnhancement.headline, "Background preparation complete");
    assert.match(needsEnhancement.summary, /removed the background/);
    assert.match(needsEnhancement.nextStepMessage, /still needs to be enhanced/);
    assert.doesNotMatch(needsEnhancement.headline, /ready to go/i);
    assert.doesNotMatch(needsEnhancement.summary, /ready to go/i);

    const sufficient = describeApprovedPreparation(false);
    assert.equal(sufficient.headline, "Background preparation complete");
    assert.match(sufficient.nextStepMessage, /ready for final print preparation/);
    assert.doesNotMatch(sufficient.nextStepMessage, /still needs to be enhanced/);
  });
});
