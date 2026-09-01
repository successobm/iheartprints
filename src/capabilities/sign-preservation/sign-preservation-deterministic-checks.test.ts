import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { fillRect, makeImage } from "@/capabilities/sign-preparation/sign-fixtures";

import {
  aggregateDeterministicEvidence,
  checkExtensionRegions,
  checkPerimeterTileExtensionRegions,
  checkParametricFrameRegions,
  checkLineage,
  checkReconstructionToFinalRgb,
  checkSourceSimilarity,
  deriveContentRegion,
  deriveParametricFrameContentRegion,
  overallStatusFromDeterministicEvidence,
  replayLocalGeometrySteps,
} from "./sign-preservation-deterministic-checks";

/**
 * Signs Phase S4.1: direct, isolated coverage of the pure deterministic
 * preservation checks — small, hand-crafted fixtures for exact-value
 * assertions, deliberately separate from the capability-level integration
 * suite (`sign-preservation-capability.test.ts`), which exercises the same
 * functions through the real production pipeline instead.
 */

describe("checkLineage (Signs Phase S4.1)", () => {
  const GOOD = {
    sourceAssetExists: true,
    rehashedSourceSha256: "a".repeat(64),
    planSourceSha256: "a".repeat(64),
    finalAssetClaimedSourceSha256: "a".repeat(64),
    finalAssetBelongsToSignPreparation: true,
    finalAssetPlanKey: "sign-repair-plan:v1:x",
    currentPlanKey: "sign-repair-plan:v1:x",
    resolutionProvenance: "reconstructed",
    expectedResolutionProvenance: "reconstructed" as const,
    geometryAdapted: true,
    executionEvidencePresent: true,
    intermediateAssetExists: true,
    intermediateAssetTiedToSameJob: true,
  };

  it("all evidence consistent -> pass", () => {
    const evidence = checkLineage(GOOD);
    assert.equal(evidence.result, "pass");
    assert.deepEqual(evidence.reasons, []);
  });

  it("source SHA does not match the approved plan's own recorded hash -> unknown", () => {
    const evidence = checkLineage({ ...GOOD, planSourceSha256: "b".repeat(64) });
    assert.equal(evidence.result, "unknown");
    assert.equal(evidence.sourceShaMatchesPlan, false);
  });

  it("planKey mismatch (stale re-plan) -> unknown", () => {
    const evidence = checkLineage({ ...GOOD, finalAssetPlanKey: "sign-repair-plan:v1:stale" });
    assert.equal(evidence.result, "unknown");
    assert.equal(evidence.finalAssetPlanKeyMatches, false);
  });

  it("provenance does not match what the plan required (claims reconstructed, plan expects native) -> unknown", () => {
    const evidence = checkLineage({ ...GOOD, resolutionProvenance: "reconstructed", expectedResolutionProvenance: "native" });
    assert.equal(evidence.result, "unknown");
    assert.equal(evidence.resolutionProvenanceConsistentWithPlan, false);
  });

  it("Semantic Worker Wiring Phase: a TRUTHFUL native asset whose plan never required reconstruction -> still passes (the exact gap this phase closes — native is not itself a lineage failure)", () => {
    const evidence = checkLineage({
      ...GOOD,
      resolutionProvenance: "native",
      expectedResolutionProvenance: "native",
      // A perimeter-only plan never dispatches a provider, so it has no
      // separate job-tied intermediate asset either — mirrors
      // `sign-preservation-capability.ts`'s own substitution.
      intermediateAssetTiedToSameJob: true,
    });
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.resolutionProvenanceConsistentWithPlan, true);
  });

  it("geometryAdapted true but no execution evidence present -> unknown", () => {
    const evidence = checkLineage({ ...GOOD, executionEvidencePresent: false });
    assert.equal(evidence.result, "unknown");
    assert.equal(evidence.executionEvidencePresentWhenAdapted, false);
  });

  it("geometryAdapted false, execution evidence absent -> still fine (never required)", () => {
    const evidence = checkLineage({
      ...GOOD,
      geometryAdapted: false,
      executionEvidencePresent: false,
    });
    assert.equal(evidence.result, "pass");
  });

  it("missing intermediate -> unknown", () => {
    const evidence = checkLineage({ ...GOOD, intermediateAssetExists: false });
    assert.equal(evidence.result, "unknown");
  });
});

describe("deriveContentRegion (Signs Phase S4.1)", () => {
  it("derives from execution_geometry, horizontal axis (the real Ruth shape)", () => {
    const region = deriveContentRegion({
      finalWidthPx: 4608,
      finalHeightPx: 6144,
      reconstructedWidthPx: 4096,
      reconstructedHeightPx: 6144,
      executedPadStep: {
        axis: "horizontal",
        leadingPx: 256,
        trailingPx: 256,
        colorR: 0,
        colorG: 0,
        colorB: 0,
      },
      plannedPadStep: null,
    });
    assert.equal(region.result, "pass");
    assert.equal(region.derivedFrom, "execution_geometry");
    assert.deepEqual(region.contentRegion, { x: 256, y: 0, width: 4096, height: 6144 });
  });

  it("derives from execution_geometry, vertical axis", () => {
    const region = deriveContentRegion({
      finalWidthPx: 1000,
      finalHeightPx: 1400,
      reconstructedWidthPx: 1000,
      reconstructedHeightPx: 1200,
      executedPadStep: {
        axis: "vertical",
        leadingPx: 100,
        trailingPx: 100,
        colorR: 10,
        colorG: 10,
        colorB: 10,
      },
      plannedPadStep: null,
    });
    assert.deepEqual(region.contentRegion, { x: 0, y: 100, width: 1000, height: 1200 });
  });

  it("falls back to the plan's own step when nothing was adapted", () => {
    const region = deriveContentRegion({
      finalWidthPx: 2754,
      finalHeightPx: 3672,
      reconstructedWidthPx: 2448,
      reconstructedHeightPx: 3672,
      executedPadStep: null,
      plannedPadStep: {
        axis: "horizontal",
        leadingPx: 153,
        trailingPx: 153,
        colorR: 0,
        colorG: 0,
        colorB: 0,
      },
    });
    assert.equal(region.derivedFrom, "plan_step");
    assert.deepEqual(region.contentRegion, { x: 153, y: 0, width: 2448, height: 3672 });
  });

  it("no extension step at all -> the whole final canvas is the content region", () => {
    const region = deriveContentRegion({
      finalWidthPx: 2000,
      finalHeightPx: 3000,
      reconstructedWidthPx: 2000,
      reconstructedHeightPx: 3000,
      executedPadStep: null,
      plannedPadStep: null,
    });
    assert.equal(region.derivedFrom, "no_extension_step");
    assert.deepEqual(region.contentRegion, { x: 0, y: 0, width: 2000, height: 3000 });
  });

  it("region that does not fit inside the final canvas -> unknown (possible unexplained shift)", () => {
    const region = deriveContentRegion({
      finalWidthPx: 500,
      finalHeightPx: 500,
      reconstructedWidthPx: 400,
      reconstructedHeightPx: 400,
      executedPadStep: { axis: "horizontal", leadingPx: 200, trailingPx: 0, colorR: 0, colorG: 0, colorB: 0 },
      plannedPadStep: null,
    });
    assert.equal(region.result, "unknown");
    assert.equal(region.regionFitsWithinFinalCanvas, false);
  });
});

/** Parametric Frame Reconstruction Phase: the reconstruct_parametric_frame sibling of deriveContentRegion — a cropped-interior content region, never the whole reconstruction. */
describe("deriveParametricFrameContentRegion (Parametric Frame Reconstruction Phase)", () => {
  it("horizontal axis: interior offset includes leadingPx on the extended axis, frame depth only on the other", () => {
    const region = deriveParametricFrameContentRegion({
      finalWidthPx: 15,
      finalHeightPx: 6,
      intermediateWidthPx: 10,
      intermediateHeightPx: 6,
      axis: "horizontal",
      leadingPx: 3,
      trailingPx: 2,
      frameDepthPxScaled: 1,
    });
    assert.equal(region.result, "pass");
    assert.equal(region.derivedFrom, "execution_geometry");
    assert.deepEqual(region.contentRegion, { x: 4, y: 1, width: 8, height: 4 });
  });

  it("vertical axis: interior offset includes leadingPx on the extended (Y) axis, frame depth only on X", () => {
    const region = deriveParametricFrameContentRegion({
      finalWidthPx: 6,
      finalHeightPx: 15,
      intermediateWidthPx: 6,
      intermediateHeightPx: 10,
      axis: "vertical",
      leadingPx: 3,
      trailingPx: 2,
      frameDepthPxScaled: 1,
    });
    assert.equal(region.result, "pass");
    assert.deepEqual(region.contentRegion, { x: 1, y: 4, width: 4, height: 8 });
  });

  it("scaled frame depth leaves no positive-area interior -> unknown, null content region", () => {
    const region = deriveParametricFrameContentRegion({
      finalWidthPx: 13,
      finalHeightPx: 6,
      intermediateWidthPx: 10,
      intermediateHeightPx: 6,
      axis: "horizontal",
      leadingPx: 3,
      trailingPx: 0,
      frameDepthPxScaled: 5,
    });
    assert.equal(region.result, "unknown");
    assert.equal(region.contentRegion, null);
  });

  it("region that does not fit inside the final canvas -> unknown", () => {
    const region = deriveParametricFrameContentRegion({
      finalWidthPx: 11, // too small — the real final canvas would be 15
      finalHeightPx: 6,
      intermediateWidthPx: 10,
      intermediateHeightPx: 6,
      axis: "horizontal",
      leadingPx: 3,
      trailingPx: 2,
      frameDepthPxScaled: 1,
    });
    assert.equal(region.result, "unknown");
    assert.equal(region.regionFitsWithinFinalCanvas, false);
  });

  it("zero frame depth (old frame apparently never discarded) -> unknown, never a false pass", () => {
    const region = deriveParametricFrameContentRegion({
      finalWidthPx: 15,
      finalHeightPx: 6,
      intermediateWidthPx: 10,
      intermediateHeightPx: 6,
      axis: "horizontal",
      leadingPx: 3,
      trailingPx: 2,
      frameDepthPxScaled: 0,
    });
    assert.equal(region.result, "unknown");
    assert.equal(region.regionDimensionsMatchReconstruction, false);
    assert.deepEqual(region.contentRegion, { x: 3, y: 0, width: 10, height: 6 });
  });
});

function image(width: number, height: number, r: number, g: number, b: number, a = 255): RgbaImage {
  return makeImage(width, height, { r, g, b, a });
}

/** Parametric Frame Reconstruction Phase: reproduces the LOCAL S2 geometry steps a plan can interpose before reconstruct_parametric_frame. */
describe("replayLocalGeometrySteps (Parametric Frame Reconstruction Phase)", () => {
  it("no steps -> the image is returned unchanged", () => {
    const img = image(4, 6, 1, 2, 3);
    const result = replayLocalGeometrySteps(img, []);
    assert.equal(result, img);
  });

  it("downsample step -> resamples to the step's own targetWidthPx/targetHeightPx", () => {
    const img = image(8, 8, 10, 20, 30);
    const result = replayLocalGeometrySteps(img, [{ kind: "downsample", params: { targetWidthPx: 4, targetHeightPx: 4 } }]);
    assert.equal(result.width, 4);
    assert.equal(result.height, 4);
  });

  it("proportional_resample step -> the SAME resample behaviour as downsample (both read targetWidthPx/targetHeightPx)", () => {
    const img = image(4, 4, 10, 20, 30);
    const result = replayLocalGeometrySteps(img, [
      { kind: "proportional_resample", params: { targetWidthPx: 8, targetHeightPx: 8 } },
    ]);
    assert.equal(result.width, 8);
    assert.equal(result.height, 8);
  });

  it("rotate_90 step -> swaps width/height (a fixed clockwise turn)", () => {
    const img = image(4, 6, 10, 20, 30);
    const result = replayLocalGeometrySteps(img, [{ kind: "rotate_90", params: undefined }]);
    assert.equal(result.width, 6);
    assert.equal(result.height, 4);
  });

  it("multiple steps apply in order — rotate then resample", () => {
    const img = image(4, 6, 10, 20, 30); // rotate_90 -> 6x4, then downsample -> 3x2
    const result = replayLocalGeometrySteps(img, [
      { kind: "rotate_90", params: undefined },
      { kind: "downsample", params: { targetWidthPx: 3, targetHeightPx: 2 } },
    ]);
    assert.equal(result.width, 3);
    assert.equal(result.height, 2);
  });

  it("a resample step with missing target dimensions is left un-applied — never guessed", () => {
    const img = image(4, 4, 10, 20, 30);
    const result = replayLocalGeometrySteps(img, [{ kind: "downsample", params: {} }]);
    assert.equal(result.width, 4);
    assert.equal(result.height, 4);
  });

  it("an unrecognized step kind is skipped (never a guess, never a crash)", () => {
    const img = image(4, 4, 10, 20, 30);
    const result = replayLocalGeometrySteps(img, [{ kind: "reconstruct_perimeter_structure", params: {} }]);
    assert.equal(result.width, 4);
    assert.equal(result.height, 4);
  });
});

describe("checkReconstructionToFinalRgb (Signs Phase S4.1)", () => {
  it("exact RGB match -> pass, zero mismatches", () => {
    const recon = image(4, 4, 10, 20, 30);
    const final = makeImage(8, 4, { r: 0, g: 0, b: 0 });
    fillRect(final, 2, 0, 6, 4, { r: 10, g: 20, b: 30 });
    const region = { x: 2, y: 0, width: 4, height: 4 };
    const evidence = checkReconstructionToFinalRgb(recon, final, region);
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.mismatchedPixelCount, 0);
  });

  it("alpha differs but RGB identical -> still pass — alpha-only S3D normalization never counts as an RGB content change", () => {
    const recon = image(2, 2, 5, 5, 5, 254); // pre-normalization alpha
    const final = makeImage(2, 2, { r: 5, g: 5, b: 5, a: 255 }); // post-normalization
    const region = { x: 0, y: 0, width: 2, height: 2 };
    const evidence = checkReconstructionToFinalRgb(recon, final, region);
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.mismatchedPixelCount, 0);
  });

  it("one content pixel's RGB differs -> catastrophic, exactly one mismatch counted", () => {
    const recon = image(3, 1, 100, 100, 100);
    const final = image(3, 1, 100, 100, 100);
    final.data[0 * 4] = 101; // corrupt one R byte
    const region = { x: 0, y: 0, width: 3, height: 1 };
    const evidence = checkReconstructionToFinalRgb(recon, final, region);
    assert.equal(evidence.result, "catastrophic");
    assert.equal(evidence.mismatchedPixelCount, 1);
    assert.equal(evidence.maxChannelDelta, 1);
  });

  it("reconstruction dimensions do not match the content region -> unknown, not compared", () => {
    const recon = image(5, 5, 1, 1, 1);
    const final = image(10, 10, 1, 1, 1);
    const region = { x: 0, y: 0, width: 4, height: 4 };
    const evidence = checkReconstructionToFinalRgb(recon, final, region);
    assert.equal(evidence.result, "unknown");
    assert.equal(evidence.compared, false);
  });

  it("null content region -> unknown", () => {
    const recon = image(2, 2, 1, 1, 1);
    const final = image(2, 2, 1, 1, 1);
    const evidence = checkReconstructionToFinalRgb(recon, final, null);
    assert.equal(evidence.result, "unknown");
  });
});

describe("checkExtensionRegions (Signs Phase S4.1)", () => {
  it("both extension bars exactly match approved fill -> pass", () => {
    const final = makeImage(10, 4, { r: 0, g: 0, b: 0 });
    fillRect(final, 3, 0, 7, 4, { r: 9, g: 9, b: 9 }); // content
    const region = { x: 3, y: 0, width: 4, height: 4 };
    const evidence = checkExtensionRegions(final, region, { r: 0, g: 0, b: 0 });
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.mismatchedPixelCount, 0);
    assert.equal(evidence.regionsChecked, 2);
    assert.equal(evidence.totalExtensionPixels, (3 + 3) * 4);
  });

  it("one extension pixel has the wrong colour -> catastrophic", () => {
    const final = makeImage(10, 4, { r: 0, g: 0, b: 0 });
    fillRect(final, 3, 0, 7, 4, { r: 9, g: 9, b: 9 });
    final.data[0] = 5; // one leading pixel is not exactly (0,0,0)
    const region = { x: 3, y: 0, width: 4, height: 4 };
    const evidence = checkExtensionRegions(final, region, { r: 0, g: 0, b: 0 });
    assert.equal(evidence.result, "catastrophic");
    assert.equal(evidence.mismatchedPixelCount, 1);
  });

  it("one extension pixel is not fully opaque -> catastrophic (alpha counted too)", () => {
    const final = makeImage(10, 4, { r: 0, g: 0, b: 0 });
    fillRect(final, 3, 0, 7, 4, { r: 9, g: 9, b: 9 });
    final.data[3] = 254; // alpha of pixel (0,0)
    const region = { x: 3, y: 0, width: 4, height: 4 };
    const evidence = checkExtensionRegions(final, region, { r: 0, g: 0, b: 0 });
    assert.equal(evidence.result, "catastrophic");
    assert.equal(evidence.mismatchedPixelCount, 1);
  });

  it("asymmetric extension — only a trailing bar, no leading bar", () => {
    const final = makeImage(8, 2, { r: 0, g: 0, b: 0 });
    fillRect(final, 0, 0, 6, 2, { r: 7, g: 7, b: 7 });
    const region = { x: 0, y: 0, width: 6, height: 2 };
    const evidence = checkExtensionRegions(final, region, { r: 0, g: 0, b: 0 });
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.regionsChecked, 1);
    assert.equal(evidence.totalExtensionPixels, 2 * 2);
  });

  it("no extension exists and no fill colour available -> pass, nothing to check", () => {
    const final = makeImage(4, 4, { r: 1, g: 2, b: 3 });
    const region = { x: 0, y: 0, width: 4, height: 4 };
    const evidence = checkExtensionRegions(final, region, null);
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.regionsChecked, 0);
  });

  it("extension exists but no approved fill colour could be determined -> unknown, never invents a colour", () => {
    const final = makeImage(8, 4, { r: 0, g: 0, b: 0 });
    const region = { x: 2, y: 0, width: 4, height: 4 };
    const evidence = checkExtensionRegions(final, region, null);
    assert.equal(evidence.result, "unknown");
  });

  it("null content region -> unknown", () => {
    const final = makeImage(4, 4, { r: 0, g: 0, b: 0 });
    const evidence = checkExtensionRegions(final, null, { r: 0, g: 0, b: 0 });
    assert.equal(evidence.result, "unknown");
  });
});

/** Semantic Worker Wiring Phase: the reconstruct_perimeter_structure sibling of checkExtensionRegions. */
describe("checkPerimeterTileExtensionRegions (Semantic Worker Wiring Phase)", () => {
  it("every tiled pixel exactly matches the expected periodic colour -> pass", () => {
    const width = 6;
    const height = 8;
    const final = makeImage(width, height, { r: 1, g: 1, b: 1 }); // content placeholder
    const leadingRows = [{ r: 200, g: 20, b: 20 }, { r: 20, g: 20, b: 20 }]; // period 2
    const trailingRows = [{ r: 10, g: 200, b: 10 }];
    const leadingPx = 3;
    const trailingPx = 1;
    // Paint the leading region per the SAME formula the executor uses:
    // distance d = leadingPx - 1 - y.
    for (let y = 0; y < leadingPx; y++) {
      const d = leadingPx - 1 - y;
      const color = leadingRows[(leadingRows.length - 1 - (d % leadingRows.length) + leadingRows.length) % leadingRows.length]!;
      fillRect(final, 0, y, width, y + 1, color);
    }
    // Trailing region, single row -> always rows[0].
    fillRect(final, 0, leadingPx + height - leadingPx - trailingPx, width, height, trailingRows[0]!);
    // Content region sits between.
    const contentRegion = { x: 0, y: leadingPx, width, height: height - leadingPx - trailingPx };

    const evidence = checkPerimeterTileExtensionRegions(
      final,
      contentRegion,
      "vertical",
      leadingPx,
      trailingPx,
      leadingRows,
      trailingRows,
    );
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.mismatchedPixelCount, 0);
    assert.equal(evidence.approvedFillRgb, null, "no single flat colour exists for a tiled reconstruction");
    assert.equal(evidence.totalExtensionPixels, (leadingPx + trailingPx) * width);
  });

  it("one tiled pixel has the wrong colour -> catastrophic", () => {
    const final = makeImage(4, 6, { r: 1, g: 1, b: 1 });
    const leadingRows = [{ r: 200, g: 20, b: 20 }];
    const trailingRows = [{ r: 10, g: 200, b: 10 }];
    fillRect(final, 0, 0, 4, 2, leadingRows[0]!);
    fillRect(final, 0, 4, 4, 6, trailingRows[0]!);
    final.data[0] = 5; // corrupt one leading pixel
    const contentRegion = { x: 0, y: 2, width: 4, height: 2 };
    const evidence = checkPerimeterTileExtensionRegions(final, contentRegion, "vertical", 2, 2, leadingRows, trailingRows);
    assert.equal(evidence.result, "catastrophic");
    assert.equal(evidence.mismatchedPixelCount, 1);
  });

  it("missing band rows -> unknown, never guesses a colour", () => {
    const final = makeImage(4, 6, { r: 1, g: 1, b: 1 });
    const contentRegion = { x: 0, y: 2, width: 4, height: 2 };
    const evidence = checkPerimeterTileExtensionRegions(final, contentRegion, "vertical", 2, 2, null, null);
    assert.equal(evidence.result, "unknown");
  });

  it("null content region -> unknown", () => {
    const final = makeImage(4, 4, { r: 0, g: 0, b: 0 });
    const evidence = checkPerimeterTileExtensionRegions(final, null, "vertical", 1, 1, [{ r: 1, g: 1, b: 1 }], [{ r: 1, g: 1, b: 1 }]);
    assert.equal(evidence.result, "unknown");
  });

  it("horizontal axis: tiles by column", () => {
    const final = makeImage(6, 4, { r: 1, g: 1, b: 1 });
    const leadingRows = [{ r: 5, g: 5, b: 200 }];
    const trailingRows = [{ r: 200, g: 5, b: 5 }];
    fillRect(final, 0, 0, 2, 4, leadingRows[0]!);
    fillRect(final, 4, 0, 6, 4, trailingRows[0]!);
    const contentRegion = { x: 2, y: 0, width: 2, height: 4 };
    const evidence = checkPerimeterTileExtensionRegions(final, contentRegion, "horizontal", 2, 2, leadingRows, trailingRows);
    assert.equal(evidence.result, "pass");
  });
});

/** Parametric Frame Reconstruction Phase: the reconstruct_parametric_frame sibling of checkPerimeterTileExtensionRegions/checkExtensionRegions. */
describe("checkParametricFrameRegions (Parametric Frame Reconstruction Phase)", () => {
  const bands = [{ color: { r: 0, g: 0, b: 0 }, thicknessPx: 2 }];
  const fillColor = { r: 0, g: 0, b: 0 };

  function rectangularFramedImage(): RgbaImage {
    const final = makeImage(10, 10, { r: 0, g: 0, b: 0 });
    fillRect(final, 2, 2, 8, 8, { r: 1, g: 1, b: 1 }); // interior placeholder — never this check's territory
    return final;
  }

  it("every redrawn frame pixel exactly matches the plan's own measured band model -> pass", () => {
    const final = rectangularFramedImage();
    const contentRegion = { x: 2, y: 2, width: 6, height: 6 };
    const evidence = checkParametricFrameRegions(final, contentRegion, null, bands, fillColor, null, null);
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.mismatchedPixelCount, 0);
    assert.equal(evidence.totalExtensionPixels, 100 - 36);
  });

  it("one redrawn frame pixel has the wrong colour -> catastrophic", () => {
    const final = rectangularFramedImage();
    final.data[0] = 5; // corrupt the top-left corner pixel
    const contentRegion = { x: 2, y: 2, width: 6, height: 6 };
    const evidence = checkParametricFrameRegions(final, contentRegion, null, bands, fillColor, null, null);
    assert.equal(evidence.result, "catastrophic");
    assert.equal(evidence.mismatchedPixelCount, 1);
  });

  const testHole = {
    radiusPx: 1,
    offsetFromCornerXPx: 1,
    offsetFromCornerYPx: 1,
    ringColor: { r: 0, g: 0, b: 0 },
    interiorColor: { r: 9, g: 9, b: 9 },
  };

  /** Paints every pixel of one corner's hole (interior disk + ring) exactly per the check's own distance formula — never just the center pixel. */
  function paintHoleAtCorner(
    final: RgbaImage,
    w: number,
    h: number,
    corner: readonly [number, number, 1 | -1, 1 | -1],
    hole: typeof testHole,
  ): void {
    const [cx, cy, sx, sy] = corner;
    const centerX = cx + sx * hole.offsetFromCornerXPx;
    const centerY = cy + sy * hole.offsetFromCornerYPx;
    const margin = hole.radiusPx + 2;
    for (let y = Math.max(0, centerY - margin); y <= Math.min(h - 1, centerY + margin); y++) {
      for (let x = Math.max(0, centerX - margin); x <= Math.min(w - 1, centerX + margin); x++) {
        const d = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
        const color = d <= hole.radiusPx ? hole.interiorColor : d <= hole.radiusPx + 2 ? hole.ringColor : null;
        if (!color) continue;
        const i = (y * w + x) * 4;
        final.data[i] = color.r;
        final.data[i + 1] = color.g;
        final.data[i + 2] = color.b;
      }
    }
  }

  const ALL_FOUR_CORNERS = [
    [0, 0, 1, 1],
    [19, 0, -1, 1],
    [0, 19, 1, -1],
    [19, 19, -1, -1],
  ] as const;

  it("a flat frame + 4 symmetric holes reconstruction matches the model exactly -> pass", () => {
    // frame depth 2 (from `bands`), holes offset (1,1)/radius 1 from each
    // corner — well inside the extension band, never touching contentRegion.
    const final = makeImage(20, 20, { r: 0, g: 0, b: 0 });
    fillRect(final, 2, 2, 18, 18, { r: 1, g: 1, b: 1 });
    for (const corner of ALL_FOUR_CORNERS) paintHoleAtCorner(final, 20, 20, corner, testHole);
    const contentRegion = { x: 2, y: 2, width: 16, height: 16 };
    const evidence = checkParametricFrameRegions(final, contentRegion, null, bands, fillColor, null, testHole);
    assert.equal(evidence.result, "pass", evidence.reasons.join("; "));
  });

  it("one hole missing (never painted, still frame colour) -> catastrophic", () => {
    const final = makeImage(20, 20, { r: 0, g: 0, b: 0 });
    fillRect(final, 2, 2, 18, 18, { r: 1, g: 1, b: 1 });
    // Paint only 3 of the 4 corners' holes — the 4th is left as plain frame colour.
    for (const corner of ALL_FOUR_CORNERS.slice(0, 3)) paintHoleAtCorner(final, 20, 20, corner, testHole);
    const contentRegion = { x: 2, y: 2, width: 16, height: 16 };
    const evidence = checkParametricFrameRegions(final, contentRegion, null, bands, fillColor, null, testHole);
    assert.equal(evidence.result, "catastrophic");
    // Only the missing hole's own interior disk (radius 1 -> 5 pixels: centre + 4 cardinal neighbours) mismatches — its ring colour already matches the plain frame background.
    assert.equal(evidence.mismatchedPixelCount, 5);
  });

  it("null content region -> unknown", () => {
    const final = rectangularFramedImage();
    const evidence = checkParametricFrameRegions(final, null, null, bands, fillColor, null, null);
    assert.equal(evidence.result, "unknown");
  });

  it("missing band model -> unknown, never guesses a colour", () => {
    const final = rectangularFramedImage();
    const contentRegion = { x: 2, y: 2, width: 6, height: 6 };
    const evidence = checkParametricFrameRegions(final, contentRegion, null, null, null, null, null);
    assert.equal(evidence.result, "unknown");
  });
});

describe("checkSourceSimilarity (Signs Phase S4.1) — advisory only", () => {
  it("clean exact 4x downsample of the source -> concern (advisory), not catastrophic", () => {
    const source = makeImage(4, 4, { r: 100, g: 150, b: 200 });
    const reconstructionContent = makeImage(16, 16, { r: 100, g: 150, b: 200 });
    const evidence = checkSourceSimilarity(source, reconstructionContent);
    assert.equal(evidence.computed, true);
    assert.equal(evidence.scaleFactor, 4);
    assert.equal(evidence.result, "concern");
    assert.ok((evidence.globalMeanAbsoluteError as number) < 5);
  });

  it("non-integer scale relationship -> unavailable, never guessed", () => {
    const source = makeImage(5, 7, { r: 1, g: 1, b: 1 });
    const reconstructionContent = makeImage(16, 20, { r: 1, g: 1, b: 1 });
    const evidence = checkSourceSimilarity(source, reconstructionContent);
    assert.equal(evidence.computed, false);
    assert.equal(evidence.result, "unknown");
  });

  it("wildly different colours everywhere -> catastrophic", () => {
    const source = makeImage(4, 4, { r: 0, g: 0, b: 0 });
    const reconstructionContent = makeImage(8, 8, { r: 255, g: 255, b: 255 });
    const evidence = checkSourceSimilarity(source, reconstructionContent);
    assert.equal(evidence.result, "catastrophic");
  });

  it("a small localized difference (e.g. a changed price region) never independently reaches catastrophic", () => {
    const source = makeImage(8, 8, { r: 50, g: 50, b: 50 });
    const reconstructionContent = makeImage(16, 16, { r: 50, g: 50, b: 50 });
    // Corrupt a small localized block only — mirrors "one price changed",
    // never the whole canvas.
    fillRect(reconstructionContent, 0, 0, 4, 4, { r: 255, g: 0, b: 0 });
    const evidence = checkSourceSimilarity(source, reconstructionContent);
    assert.notEqual(evidence.result, "catastrophic");
  });
});

describe("aggregateDeterministicEvidence / overallStatusFromDeterministicEvidence (Signs Phase S4.1)", () => {
  const PASS_LINEAGE = checkLineage({
    sourceAssetExists: true,
    rehashedSourceSha256: "a".repeat(64),
    planSourceSha256: "a".repeat(64),
    finalAssetClaimedSourceSha256: "a".repeat(64),
    finalAssetBelongsToSignPreparation: true,
    finalAssetPlanKey: "k",
    currentPlanKey: "k",
    resolutionProvenance: "reconstructed",
    expectedResolutionProvenance: "reconstructed",
    geometryAdapted: false,
    executionEvidencePresent: false,
    intermediateAssetExists: true,
    intermediateAssetTiedToSameJob: true,
  });

  it("everything passes -> overall status is 'unknown', NEVER 'preserved' (S4.1's own hard invariant)", () => {
    const region = deriveContentRegion({
      finalWidthPx: 4,
      finalHeightPx: 4,
      reconstructedWidthPx: 4,
      reconstructedHeightPx: 4,
      executedPadStep: null,
      plannedPadStep: null,
    });
    const recon = image(4, 4, 1, 1, 1);
    const final = image(4, 4, 1, 1, 1);
    const rgb = checkReconstructionToFinalRgb(recon, final, region.contentRegion);
    const ext = checkExtensionRegions(final, region.contentRegion, null);
    const similarity = checkSourceSimilarity(makeImage(1, 1, { r: 1, g: 1, b: 1 }), recon);

    const evidence = aggregateDeterministicEvidence({
      lineage: PASS_LINEAGE,
      regionMapping: region,
      reconstructionToFinalRgb: rgb,
      extensionRegions: ext,
      sourceSimilarity: similarity,
    });
    assert.equal(evidence.catastrophicAnomalyDetected, false);
    const status = overallStatusFromDeterministicEvidence(evidence);
    assert.equal(status, "unknown");
    // @ts-expect-error — "preserved" must not even type-check as a possible return.
    const _neverPreserved: "changed" | "unknown" = "preserved";
    void _neverPreserved;
  });

  it("any catastrophic sub-result -> overall 'changed'", () => {
    const region = deriveContentRegion({
      finalWidthPx: 4,
      finalHeightPx: 4,
      reconstructedWidthPx: 4,
      reconstructedHeightPx: 4,
      executedPadStep: null,
      plannedPadStep: null,
    });
    const recon = image(4, 4, 1, 1, 1);
    const final = image(4, 4, 2, 2, 2); // whole content differs -> catastrophic
    const rgb = checkReconstructionToFinalRgb(recon, final, region.contentRegion);
    const ext = checkExtensionRegions(final, region.contentRegion, null);
    const similarity = checkSourceSimilarity(makeImage(1, 1, { r: 1, g: 1, b: 1 }), recon);

    const evidence = aggregateDeterministicEvidence({
      lineage: PASS_LINEAGE,
      regionMapping: region,
      reconstructionToFinalRgb: rgb,
      extensionRegions: ext,
      sourceSimilarity: similarity,
    });
    assert.equal(evidence.catastrophicAnomalyDetected, true);
    assert.equal(overallStatusFromDeterministicEvidence(evidence), "changed");
  });
});
