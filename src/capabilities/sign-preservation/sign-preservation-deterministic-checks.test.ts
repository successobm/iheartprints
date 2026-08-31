import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { fillRect, makeImage } from "@/capabilities/sign-preparation/sign-fixtures";

import {
  aggregateDeterministicEvidence,
  checkExtensionRegions,
  checkLineage,
  checkReconstructionToFinalRgb,
  checkSourceSimilarity,
  deriveContentRegion,
  overallStatusFromDeterministicEvidence,
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

  it("not a reconstructed asset -> unknown", () => {
    const evidence = checkLineage({ ...GOOD, resolutionProvenance: "native" });
    assert.equal(evidence.result, "unknown");
    assert.equal(evidence.resolutionProvenanceIsReconstructed, false);
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

function image(width: number, height: number, r: number, g: number, b: number, a = 255): RgbaImage {
  return makeImage(width, height, { r, g, b, a });
}

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
