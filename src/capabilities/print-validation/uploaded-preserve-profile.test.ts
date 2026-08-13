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
 * Existing Artwork → Print Ready Phase 2, acceptance scenarios M/N/O (and the
 * AA regression that the generated-concept profile is unchanged).
 *
 * The `uploaded_preserve` profile is easy to get wrong in exactly one
 * direction: quietly becoming "validation, but lenient". These tests pin the
 * opposite claim — three checks that have no meaning for customer-supplied
 * artwork are not asked, three preservation checks that only apply to it ARE
 * asked, and everything a print shop would actually reject a file for still
 * blocks.
 */

const SHA = "a".repeat(64);

function evidence(
  overrides: Partial<UploadedPreserveEvidence> = {},
): UploadedPreserveEvidence {
  return {
    preparedArtworkVersionId: "artwork-1",
    preparedAssetId: "prepared-asset-1",
    originalAssetId: "original-asset-1",
    sourceBytesSha256: SHA,
    sourceAlphaBBoxWidthPx: 923,
    sourceAlphaBBoxHeightPx: 909,
    enhancement: "reconstructed",
    ...overrides,
  };
}

/**
 * A plate that is genuinely print-ready: 3150x3103px at 300 PPI over
 * 10.5x10.34in, trimmed tight to its own artwork, and sized DOWN from the
 * raster it was built from (3692x3636 of visible artwork reconstructed from
 * the 923x909 source).
 */
function normalization(
  overrides: Partial<ProductionNormalizationSummary> = {},
): ProductionNormalizationSummary {
  return {
    strategy: "width_constrained_preserve_aspect",
    alphaBBoxWidthPx: 3692,
    alphaBBoxHeightPx: 3636,
    trimmedWidthPx: 3730,
    trimmedHeightPx: 3674,
    artworkOccupancy: (3692 * 3636) / (3730 * 3674),
    targetWidthIn: 10.5,
    widthToleranceIn: 0.05,
    targetPpi: 300,
    intendedWidthIn: 10.5,
    intendedHeightIn: 3103 / 300,
    constrainedBy: "width",
    densityPixelsPerMetre: 11811,
    ...overrides,
  };
}

function uploadedPreserveInput(
  overrides: Partial<PrintValidationInput> = {},
): PrintValidationInput {
  return {
    artworkVersionId: "artwork-1",
    validationProfile: "uploaded_preserve",
    uploadedPreserve: evidence(),
    designBriefVersionId: null,
    currentApprovedDesignBriefVersionId: null,
    printPlacement: "full_back",
    productSummary: "T-shirts for our bowling team",
    designDescription: null,
    // The two fields the profile exists to make inapplicable. Deliberately
    // null in every scenario below — an uploaded-artwork plate never has them.
    conceptEvaluationStatus: null,
    conceptEvaluation: null,
    intendedPrintWidthIn: 10.5,
    primaryAsset: {
      contentType: "image/png",
      widthPx: 3150,
      heightPx: 3103,
      hasTransparency: true,
      vectorAssetId: null,
      resolutionProvenance: "reconstructed",
      nativeWidthPx: 979,
      nativeHeightPx: 1024,
    },
    productionNormalization: normalization(),
    ...overrides,
  };
}

function codes(report: PrintValidationReport): PrintValidationCheckCode[] {
  return report.checks.map((check) => check.check);
}

function statusOf(
  report: PrintValidationReport,
  code: PrintValidationCheckCode,
): string | undefined {
  return report.checks.find((check) => check.check === code)?.status;
}

describe("Print Validation — uploaded_preserve applicability profile", () => {
  const capability = createPrintValidationCapability();

  it("M: a plate with no Concept Evaluation at all is still print-ready", () => {
    const report = capability.validateArtwork(uploadedPreserveInput());

    assert.equal(report.profile, "uploaded_preserve");
    assert.equal(report.status, "ready");
    assert.deepEqual(report.blockingIssues, []);
    assert.ok(
      !codes(report).includes("concept_evaluation_alignment"),
      "a concept evaluation that could not exist is not asked for",
    );
  });

  it("N: absent typed required wording never blocks — the wording is in the customer's pixels", () => {
    const report = capability.validateArtwork(uploadedPreserveInput());

    assert.ok(!codes(report).includes("required_wording_verification"));
    assert.equal(report.status, "ready");
  });

  it("does not ask for brief provenance, because no brief version authorizes uploaded artwork", () => {
    const report = capability.validateArtwork(uploadedPreserveInput());

    assert.ok(!codes(report).includes("brief_provenance"));
    assert.equal(report.designBriefVersionId, null);
    assert.equal(report.status, "ready");
  });

  it("records which profile it applied, so 'not asked' is never mistaken for 'passed'", () => {
    const report = capability.validateArtwork(uploadedPreserveInput());
    const profileCheck = report.checks.find(
      (check) => check.check === "validation_profile",
    );

    assert.ok(profileCheck);
    assert.equal(profileCheck.severity, "info");
    assert.match(profileCheck.reason, /uploaded-preserve/);
    assert.match(profileCheck.reason, /were not evaluated/);
  });

  // --- O: everything a print shop would actually reject still blocks --------

  it("O: an opaque plate is blocked — transparency is a production requirement, not a brief opinion", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        primaryAsset: {
          ...uploadedPreserveInput().primaryAsset!,
          hasTransparency: false,
        },
      }),
    );

    assert.equal(statusOf(report, "transparency"), "fail");
    assert.notEqual(report.status, "ready");
  });

  it("O: a plate that is mostly transparent dead canvas is blocked", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        productionNormalization: normalization({ artworkOccupancy: 0.5 }),
      }),
    );

    assert.equal(statusOf(report, "transparent_dead_canvas"), "fail");
    assert.notEqual(report.status, "ready");
  });

  it("O: a plate at the wrong physical width is blocked", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        productionNormalization: normalization({ intendedWidthIn: 9 }),
      }),
    );

    assert.equal(statusOf(report, "physical_width_policy"), "fail");
    assert.notEqual(report.status, "ready");
  });

  it("O: a stretched plate is blocked", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        productionNormalization: normalization({ trimmedHeightPx: 2000 }),
      }),
    );

    assert.equal(statusOf(report, "aspect_ratio_preserved"), "fail");
    assert.notEqual(report.status, "ready");
  });

  it("O: an unrecorded content type is blocked", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        primaryAsset: {
          ...uploadedPreserveInput().primaryAsset!,
          contentType: null,
        },
      }),
    );

    assert.equal(statusOf(report, "content_type"), "unknown");
    assert.notEqual(report.status, "ready");
  });

  it("O: a plate whose pixels disagree with its recorded physical size is blocked", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        primaryAsset: {
          ...uploadedPreserveInput().primaryAsset!,
          widthPx: 2000,
        },
      }),
    );

    assert.equal(statusOf(report, "production_normalization"), "fail");
    assert.notEqual(report.status, "ready");
  });

  it("O: artwork too small to be meaningful is blocked", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        productionNormalization: normalization({
          alphaBBoxWidthPx: 4,
          alphaBBoxHeightPx: 4,
        }),
      }),
    );

    assert.equal(statusOf(report, "alpha_bound_artwork"), "fail");
    assert.notEqual(report.status, "ready");
  });

  // --- Goal 8: the preservation checks this profile ADDS -------------------

  it("blocks a plate whose lineage was never recorded", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({ uploadedPreserve: null }),
    );

    assert.equal(report.status, "blocked");
    assert.equal(statusOf(report, "source_lineage"), "fail");
  });

  it("blocks a plate that names the immutable original as its source instead of the prepared artwork", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        uploadedPreserve: evidence({ preparedAssetId: "original-asset-1" }),
      }),
    );

    assert.equal(report.status, "blocked");
    assert.match(
      report.blockingIssues.join(" "),
      /original upload as its source/,
    );
  });

  it("blocks a plate whose recorded source is a different prepared artwork", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        uploadedPreserve: evidence({ preparedArtworkVersionId: "artwork-other" }),
      }),
    );

    assert.equal(report.status, "blocked");
    assert.match(report.blockingIssues.join(" "), /different prepared artwork/);
  });

  it("blocks a plate carrying no usable content hash for its source pixels", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        uploadedPreserve: evidence({ sourceBytesSha256: "not-a-hash" }),
      }),
    );

    assert.equal(report.status, "blocked");
    assert.match(report.blockingIssues.join(" "), /content hash/);
  });

  it("blocks a plate whose artwork was cropped or letterboxed during production", () => {
    // Source artwork is 923x909 (≈1.015). This plate's own artwork came out
    // markedly wider than tall, which no proportional transform of that source
    // can produce — the bottom of the design was cropped away.
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        uploadedPreserve: evidence({
          sourceAlphaBBoxWidthPx: 923,
          sourceAlphaBBoxHeightPx: 909,
        }),
        productionNormalization: normalization({
          alphaBBoxWidthPx: 3692,
          alphaBBoxHeightPx: 3200,
        }),
      }),
    );

    assert.equal(statusOf(report, "preserved_source_geometry"), "fail");
    assert.notEqual(report.status, "ready");
    assert.match(
      report.blockingIssues.join(" "),
      /cropped, padded, or distorted/,
    );
  });

  it("accepts the small bounding-box drift a real reconstruction produces", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        productionNormalization: normalization({
          // A couple of pixels of alpha-threshold movement on a ~3700px edge.
          alphaBBoxWidthPx: 3694,
          alphaBBoxHeightPx: 3635,
        }),
      }),
    );

    assert.equal(statusOf(report, "preserved_source_geometry"), "pass");
  });

  it("Goal 5: blocks a plate stretched past the detail it was built from", () => {
    // The honest failure mode of a reconstruction that lands short of target:
    // 3150px of plate resampled up from 1600px of real artwork.
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        productionNormalization: normalization({
          alphaBBoxWidthPx: 1580,
          alphaBBoxHeightPx: 1556,
          trimmedWidthPx: 1600,
          trimmedHeightPx: 1575,
          artworkOccupancy: (1580 * 1556) / (1600 * 1575),
        }),
      }),
    );

    assert.equal(statusOf(report, "reconstruction_sufficiency"), "fail");
    assert.notEqual(report.status, "ready");
    assert.match(report.blockingIssues.join(" "), /without the detail to match it/);
    assert.ok(report.requiredTransformations.includes("upscale_raster_artwork"));
  });

  it("Goal 5: a plate sized DOWN from its source passes — the skip-enhancement path", () => {
    const report = capability.validateArtwork(
      uploadedPreserveInput({
        uploadedPreserve: evidence({ enhancement: "skipped" }),
        primaryAsset: {
          ...uploadedPreserveInput().primaryAsset!,
          resolutionProvenance: "native",
          nativeWidthPx: 3150,
          nativeHeightPx: 3103,
        },
        productionNormalization: normalization({
          alphaBBoxWidthPx: 3980,
          alphaBBoxHeightPx: 3920,
          trimmedWidthPx: 4020,
          trimmedHeightPx: 3960,
          artworkOccupancy: (3980 * 3920) / (4020 * 3960),
        }),
      }),
    );

    assert.equal(statusOf(report, "reconstruction_sufficiency"), "pass");
    assert.equal(report.status, "ready");
  });
});

describe("Print Validation — generated_concept profile is unchanged (AA)", () => {
  const capability = createPrintValidationCapability();

  function generatedConceptInput(
    overrides: Partial<PrintValidationInput> = {},
  ): PrintValidationInput {
    return {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "brief-v1",
      currentApprovedDesignBriefVersionId: "brief-v1",
      printPlacement: "full_back",
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
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
      intendedPrintWidthIn: 10.5,
      primaryAsset: {
        contentType: "image/png",
        widthPx: 3150,
        heightPx: 3103,
        hasTransparency: true,
        vectorAssetId: null,
        resolutionProvenance: "reconstructed",
        nativeWidthPx: 979,
        nativeHeightPx: 1024,
      },
      productionNormalization: normalization(),
      ...overrides,
    };
  }

  it("AA: still blocks a generated concept whose required wording was never verified", () => {
    const report = capability.validateArtwork(
      generatedConceptInput({ conceptEvaluation: null, conceptEvaluationStatus: null }),
    );

    assert.equal(report.profile, "generated_concept");
    assert.equal(statusOf(report, "required_wording_verification"), "unknown");
    assert.equal(statusOf(report, "concept_evaluation_alignment"), "unknown");
    assert.notEqual(report.status, "ready");
  });

  it("AA: still blocks a concept generated from a superseded brief version", () => {
    const report = capability.validateArtwork(
      generatedConceptInput({ currentApprovedDesignBriefVersionId: "brief-v2" }),
    );

    assert.equal(report.status, "blocked");
    assert.equal(statusOf(report, "brief_provenance"), "fail");
  });

  it("AA: a fully verified generated concept is still print-ready", () => {
    const report = capability.validateArtwork(generatedConceptInput());
    assert.equal(report.status, "ready");
  });

  it("does not apply the uploaded-preserve preservation checks to generated concepts", () => {
    const report = capability.validateArtwork(generatedConceptInput());
    const emitted = codes(report);

    assert.ok(!emitted.includes("source_lineage"));
    assert.ok(!emitted.includes("preserved_source_geometry"));
    assert.ok(!emitted.includes("reconstruction_sufficiency"));
  });
});
