import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  PrintValidationCheckCode,
  PrintValidationInput,
  PrintValidationReport,
  ProductionNormalizationSummary,
  UploadedPreserveEvidence,
} from "./contracts";
import { createPrintValidationCapability } from "./print-validation-capability";

/**
 * False Print-Ready Guard — Cochrane-class authority regression.
 *
 * Central acceptance: a severely undersized Existing Artwork upload can
 * reach correct plate geometry + 300 PPI metadata + resolutionProvenance
 * `"reconstructed"` and still MUST NOT become automatically Print Ready
 * without reconstruction-quality/fidelity evidence.
 */

const SHA = "b".repeat(64);

function evidence(
  overrides: Partial<UploadedPreserveEvidence> = {},
): UploadedPreserveEvidence {
  return {
    preparedArtworkVersionId: "artwork-cochrane",
    preparedAssetId: "prepared-cochrane",
    originalAssetId: "original-cochrane",
    sourceBytesSha256: SHA,
    // ~1050px visible / 4200 required ≈ 0.25 — near Topaz's 4× ceiling.
    sourceAlphaBBoxWidthPx: 1050,
    sourceAlphaBBoxHeightPx: 354,
    enhancement: "reconstructed",
    ...overrides,
  };
}

/** Exact 14" × ~4.72" @ 300 PPI plate (4200 × 1415), sized down from a reconstructed raster. */
function cochraneNormalization(
  overrides: Partial<ProductionNormalizationSummary> = {},
): ProductionNormalizationSummary {
  return {
    strategy: "width_constrained_preserve_aspect",
    alphaBBoxWidthPx: 4200,
    alphaBBoxHeightPx: 1415,
    trimmedWidthPx: 4242,
    trimmedHeightPx: 1429,
    artworkOccupancy: (4200 * 1415) / (4242 * 1429),
    targetWidthIn: 14,
    widthToleranceIn: 0.05,
    targetPpi: 300,
    intendedWidthIn: 14,
    intendedHeightIn: 1415 / 300,
    constrainedBy: "width",
    densityPixelsPerMetre: 11811,
    ...overrides,
  };
}

function cochraneInput(
  overrides: Partial<PrintValidationInput> = {},
): PrintValidationInput {
  return {
    artworkVersionId: "artwork-cochrane",
    validationProfile: "uploaded_preserve",
    uploadedPreserve: evidence(),
    designBriefVersionId: null,
    currentApprovedDesignBriefVersionId: null,
    printPlacement: "full_front",
    productSummary: "Cochrane & Company apparel",
    designDescription: null,
    conceptEvaluationStatus: null,
    conceptEvaluation: null,
    intendedPrintWidthIn: 14,
    primaryAsset: {
      contentType: "image/png",
      widthPx: 4200,
      heightPx: 1415,
      hasTransparency: true,
      vectorAssetId: null,
      resolutionProvenance: "reconstructed",
      nativeWidthPx: 1100,
      nativeHeightPx: 380,
    },
    productionNormalization: cochraneNormalization(),
    ...overrides,
  };
}

function statusOf(
  report: PrintValidationReport,
  code: PrintValidationCheckCode,
): string | undefined {
  return report.checks.find((check) => check.check === code)?.status;
}

describe("False Print-Ready Guard — Cochrane-class reconstructed upload", () => {
  const capability = createPrintValidationCapability();

  it("1/H: severely undersized reconstructed upload cannot automatically become print ready", () => {
    const report = capability.validateArtwork(cochraneInput());

    assert.equal(report.profile, "uploaded_preserve");
    assert.equal(report.status, "finalization_required");
    assert.equal(statusOf(report, "reconstruction_certification_evidence"), "fail");
    assert.ok(report.requiredTransformations.includes("require_human_review"));
  });

  it("2: exact production dimensions do not override the guard", () => {
    const report = capability.validateArtwork(cochraneInput());

    assert.equal(statusOf(report, "physical_width_policy"), "pass");
    assert.equal(statusOf(report, "minimum_raster_dimensions"), "pass");
    assert.equal(report.status, "finalization_required");
  });

  it("3: 300 PPI metadata / effective resolution do not override the guard", () => {
    const report = capability.validateArtwork(cochraneInput());

    assert.equal(statusOf(report, "effective_resolution"), "pass");
    assert.equal(statusOf(report, "density_metadata"), "pass");
    assert.equal(report.status, "finalization_required");
  });

  it("4: resolutionProvenance=reconstructed alone is not sufficient proof of recovered detail", () => {
    const report = capability.validateArtwork(cochraneInput());

    assert.equal(statusOf(report, "resolution_provenance"), "pass");
    assert.equal(statusOf(report, "reconstruction_sufficiency"), "pass");
    assert.equal(statusOf(report, "reconstruction_certification_evidence"), "fail");
    assert.notEqual(report.status, "ready");
  });

  it("5: native sufficient uploaded artwork retains Print Ready when geometry passes", () => {
    const report = capability.validateArtwork(
      cochraneInput({
        uploadedPreserve: evidence({
          sourceAlphaBBoxWidthPx: 4200,
          sourceAlphaBBoxHeightPx: 1415,
          enhancement: "skipped",
        }),
        primaryAsset: {
          contentType: "image/png",
          widthPx: 4200,
          heightPx: 1415,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: 4200,
          nativeHeightPx: 1415,
        },
        productionNormalization: cochraneNormalization({
          alphaBBoxWidthPx: 4200,
          alphaBBoxHeightPx: 1415,
          trimmedWidthPx: 4200,
          trimmedHeightPx: 1415,
          artworkOccupancy: 1,
        }),
      }),
    );

    assert.equal(statusOf(report, "reconstruction_certification_evidence"), "pass");
    assert.equal(report.status, "ready");
  });

  it("6: interpolated upscale remains blocked exactly as today", () => {
    const report = capability.validateArtwork(
      cochraneInput({
        uploadedPreserve: evidence({
          sourceAlphaBBoxWidthPx: 1050,
          sourceAlphaBBoxHeightPx: 354,
          enhancement: "skipped",
        }),
        primaryAsset: {
          contentType: "image/png",
          widthPx: 4200,
          heightPx: 1415,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "interpolated_upscale",
          nativeWidthPx: 1050,
          nativeHeightPx: 354,
        },
        // Interpolated path: plate stretched from the small source itself.
        productionNormalization: cochraneNormalization({
          trimmedWidthPx: 1050,
          trimmedHeightPx: 354,
          alphaBBoxWidthPx: 1050,
          alphaBBoxHeightPx: 354,
          artworkOccupancy: 1,
        }),
      }),
    );

    assert.notEqual(report.status, "ready");
    assert.equal(statusOf(report, "reconstruction_sufficiency"), "fail");
  });

  it("7: mild reconstructed case follows temporary policy (also withheld — no safe mild/severe cutoff)", () => {
    // Coverage ≈ 0.95 — near target, still used provider super-resolution.
    // Temporary policy: no fidelity evidence ⇒ no automatic Print Ready.
    const report = capability.validateArtwork(
      cochraneInput({
        uploadedPreserve: evidence({
          sourceAlphaBBoxWidthPx: 3990,
          sourceAlphaBBoxHeightPx: 1344,
          enhancement: "reconstructed",
        }),
        primaryAsset: {
          contentType: "image/png",
          widthPx: 4200,
          heightPx: 1415,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "reconstructed",
          nativeWidthPx: 4000,
          nativeHeightPx: 1350,
        },
        productionNormalization: cochraneNormalization({
          trimmedWidthPx: 4242,
          trimmedHeightPx: 1429,
        }),
      }),
    );

    assert.equal(statusOf(report, "reconstruction_certification_evidence"), "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("8: production asset geometry may fully pass while authoritative Print Ready is withheld", () => {
    const report = capability.validateArtwork(cochraneInput());

    for (const code of [
      "transparency",
      "effective_resolution",
      "minimum_raster_dimensions",
      "production_normalization",
      "alpha_bound_artwork",
      "transparent_dead_canvas",
      "physical_width_policy",
      "aspect_ratio_preserved",
      "source_lineage",
      "preserved_source_geometry",
      "reconstruction_sufficiency",
    ] as const) {
      assert.equal(statusOf(report, code), "pass", `${code} should pass`);
    }
    assert.equal(report.status, "finalization_required");
  });

  it("12: Create New (generated_concept) reconstructed plates are unchanged by this guard", () => {
    const report = capability.validateArtwork({
      artworkVersionId: "concept-1",
      validationProfile: "generated_concept",
      designBriefVersionId: "brief-v1",
      currentApprovedDesignBriefVersionId: "brief-v1",
      printPlacement: "full_front",
      productSummary: "shirts",
      designDescription: "a logo",
      conceptEvaluationStatus: "passed",
      conceptEvaluation: {
        overallScore: 90,
        passed: true,
        confidence: 90,
        criteria: [
          { key: "required_wording", score: 100, passed: true, confidence: 90, notes: null },
        ],
        warnings: [],
        recommendations: [],
        missingRequirements: [],
        matchedRequirements: [],
        providerMetadata: {},
      },
      intendedPrintWidthIn: 14,
      primaryAsset: {
        contentType: "image/png",
        widthPx: 4200,
        heightPx: 1415,
        hasTransparency: true,
        vectorAssetId: null,
        resolutionProvenance: "reconstructed",
        nativeWidthPx: 1050,
        nativeHeightPx: 354,
      },
      productionNormalization: cochraneNormalization(),
    });

    assert.ok(
      !report.checks.some((c) => c.check === "reconstruction_certification_evidence"),
      "guard must not emit under generated_concept",
    );
    // Geometry + concept eval still decide readiness; this guard must not be why it fails.
    assert.equal(report.status, "ready");
  });
});
