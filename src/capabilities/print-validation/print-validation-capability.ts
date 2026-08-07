/**
 * Sprint 2M Phase 1: real, deterministic, provider-neutral Print Validation.
 *
 * Answers "can this artwork be produced correctly for the intended print
 * application?" — never "did we generate the design the customer
 * requested?" (that is Concept Evaluation). A concept can pass Concept
 * Evaluation and fail Print Validation; that is expected, documented
 * behavior (ARCHITECTURE.md, Constitution §15).
 *
 * Pure and synchronous, mirroring `BriefEvaluationCapability`: no
 * repository, no provider, no I/O. The caller (a future Final Artwork
 * orchestrator, a route, or a test) resolves an `ArtworkVersion`'s asset,
 * approved brief snapshot, and Concept Evaluation state into a
 * `PrintValidationInput`; this capability only decides. Never mutates a
 * Design Brief. Never transforms, upscales, vectorizes, or regenerates
 * artwork (Goal 15/17) — it only determines what is required and whether it
 * is already satisfied.
 */

import { deriveProductionRequirements } from "./production-requirements";
import { calculateEffectiveResolution } from "./effective-resolution";
import type {
  FinalizationTransformation,
  PrintValidationCheck,
  PrintValidationInput,
  PrintValidationReport,
  PrintValidationStatus,
  ProductionRequirements,
} from "./contracts";

export interface PrintValidationCapability {
  /** Deterministic — the same input always produces the same report. Never mutates `input`. */
  validateArtwork(input: PrintValidationInput): PrintValidationReport;
}

export function createPrintValidationCapability(): PrintValidationCapability {
  return {
    validateArtwork(input) {
      return validate(input);
    },
  };
}

function validate(input: PrintValidationInput): PrintValidationReport {
  const requirements = deriveProductionRequirements({
    printPlacement: input.printPlacement,
    productSummary: input.productSummary,
    designDescription: input.designDescription,
  });

  const checks: PrintValidationCheck[] = [];
  const requiredTransformations = new Set<FinalizationTransformation>();

  // --- Hard-block checks -------------------------------------------------
  // These represent "there is nothing here to finalize", not "this needs
  // more work" — Goal 5's `"blocked"` status.

  if (!input.primaryAsset) {
    checks.push({
      check: "asset_exists",
      status: "fail",
      severity: "blocking",
      reason: "No generated asset exists for this concept.",
    });
    return buildReport(input, requirements, checks, requiredTransformations, "blocked");
  }
  checks.push({
    check: "asset_exists",
    status: "pass",
    severity: "blocking",
    reason: "A generated asset exists for this concept.",
  });

  const provenance = checkBriefProvenance(input);
  checks.push(provenance);
  if (provenance.status === "fail") {
    return buildReport(input, requirements, checks, requiredTransformations, "blocked");
  }

  // --- Recoverable checks --------------------------------------------------
  // From here on the concept is a legitimate finalization candidate; every
  // remaining failure describes work the future Final Artwork capability
  // would need to do, not a reason to discard the concept.

  const asset = input.primaryAsset;

  checks.push(checkContentType(asset));
  if (asset.contentType === null) {
    requiredTransformations.add("create_production_png");
  }

  const dimensionsKnown = asset.widthPx !== null && asset.heightPx !== null;
  checks.push({
    check: "raster_dimensions_known",
    status: dimensionsKnown ? "pass" : "unknown",
    severity: "blocking",
    reason: dimensionsKnown
      ? `Asset is ${asset.widthPx}x${asset.heightPx}px.`
      : "Asset pixel dimensions are not recorded.",
  });

  checks.push(checkTransparency(requirements, asset));
  if (
    requirements.transparencyRequired &&
    asset.hasTransparency === false
  ) {
    requiredTransformations.add("remove_background");
  }

  checks.push(checkResolutionProvenance(asset));

  const resolutionCheck = checkEffectiveResolution(requirements, asset);
  checks.push(resolutionCheck.check);
  if (resolutionCheck.check.status === "fail") {
    requiredTransformations.add("regenerate_at_production_dimensions");
    requiredTransformations.add("upscale_raster_artwork");
  }

  const minDimensionsCheck = checkMinimumRasterDimensions(requirements, asset);
  checks.push(minDimensionsCheck);
  if (minDimensionsCheck.status === "fail") {
    requiredTransformations.add("regenerate_at_production_dimensions");
  }

  const vectorCheck = checkVectorSource(requirements, asset);
  checks.push(vectorCheck);
  if (vectorCheck.status === "fail") {
    requiredTransformations.add("create_vector_version");
    if (requirements.category === "signage") {
      requiredTransformations.add("convert_fonts_to_outlines");
      requiredTransformations.add("resize_to_final_dimensions");
    } else {
      requiredTransformations.add("create_vector_or_pdf_asset");
    }
  }

  const evaluationCheck = checkConceptEvaluationAlignment(input);
  checks.push(evaluationCheck);
  if (evaluationCheck.status === "fail") {
    requiredTransformations.add("require_human_review");
  }

  const wordingCheck = checkRequiredWordingVerification(input);
  checks.push(wordingCheck);
  if (wordingCheck.status === "fail") {
    requiredTransformations.add("verify_or_recreate_text");
  }

  // --- Informational checks (never change status) -------------------------

  checks.push({
    check: "print_location_known",
    status: requirements.printLocation ? "pass" : "unknown",
    severity: "info",
    reason: requirements.printLocation
      ? `Print location resolved to ${requirements.printLocation}.`
      : "Print location is not yet known.",
  });

  checks.push({
    check: "production_method_known",
    status:
      requirements.printMethodConfidence === "unknown" ? "unknown" : "pass",
    severity: "info",
    reason:
      requirements.printMethodConfidence === "unknown"
        ? "Production method could not be confirmed from brief text; a default profile was assumed."
        : `Production method inferred as ${requirements.printMethod}.`,
  });

  const status = aggregateStatus(checks);
  return buildReport(input, requirements, checks, requiredTransformations, status);
}

function checkBriefProvenance(input: PrintValidationInput): PrintValidationCheck {
  if (!input.designBriefVersionId) {
    return {
      check: "brief_provenance",
      status: "fail",
      severity: "blocking",
      reason:
        "This concept has no recorded Design Brief version — it cannot be validated against an approved brief.",
    };
  }
  if (!input.currentApprovedDesignBriefVersionId) {
    return {
      check: "brief_provenance",
      status: "unknown",
      severity: "blocking",
      reason: "No currently approved Design Brief version is available to compare against.",
    };
  }
  if (input.designBriefVersionId !== input.currentApprovedDesignBriefVersionId) {
    return {
      check: "brief_provenance",
      status: "fail",
      severity: "blocking",
      reason:
        "This concept was generated from a Design Brief version that is no longer the approved version.",
    };
  }
  return {
    check: "brief_provenance",
    status: "pass",
    severity: "blocking",
    reason: "Concept was generated from the currently approved Design Brief version.",
  };
}

function checkContentType(
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (!asset.contentType) {
    return {
      check: "content_type",
      status: "unknown",
      severity: "blocking",
      reason: "Asset content type is not recorded.",
    };
  }
  const recognized = ["image/png", "image/webp", "image/jpeg"].includes(
    asset.contentType,
  );
  return {
    check: "content_type",
    status: recognized ? "pass" : "warning",
    severity: recognized ? "blocking" : "warning",
    reason: recognized
      ? `Recognized raster content type (${asset.contentType}).`
      : `Unrecognized content type (${asset.contentType}).`,
  };
}

function checkTransparency(
  requirements: ProductionRequirements,
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (!requirements.transparencyRequired) {
    return {
      check: "transparency",
      status: "pass",
      severity: "blocking",
      reason: "Transparency is not required for this production method.",
    };
  }
  if (asset.hasTransparency === null) {
    return {
      check: "transparency",
      status: "unknown",
      severity: "blocking",
      reason: "Transparency metadata is not recorded for this asset.",
    };
  }
  return {
    check: "transparency",
    status: asset.hasTransparency ? "pass" : "fail",
    severity: "blocking",
    reason: asset.hasTransparency
      ? "Asset has a transparent background."
      : "A transparent background is required but this asset is opaque.",
  };
}

/**
 * Sprint 2M Phase 2C ("Upscaling Truthfulness"): the dimensions checks must
 * judge sufficiency against. When the asset's pixels are genuinely native
 * (as-generated, or only ever downsized), the asset's own literal
 * dimensions are trustworthy. When some/all of those pixels were
 * manufactured by interpolation beyond the source's native density (or
 * provenance is simply unknown), only the true pre-upscale source
 * dimensions may be trusted — using the inflated post-upscale dimensions
 * here is exactly the self-deception this sprint exists to prevent ("resize
 * a 1024px image to 3600px" must never read as "production-quality
 * artwork").
 */
function honestDimensionsFor(
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): { widthPx: number | null; heightPx: number | null; interpolated: boolean } {
  // Sprint 2M Phase 2E: "reconstructed" pixels are genuine provider-produced
  // detail (e.g. Topaz Transparency Upscale), never fabricated local
  // interpolation — trusted exactly like "native", never penalized down to
  // the tiny pre-reconstruction source dimensions.
  if (asset.resolutionProvenance === "native" || asset.resolutionProvenance === "reconstructed") {
    return { widthPx: asset.widthPx, heightPx: asset.heightPx, interpolated: false };
  }
  return {
    widthPx: asset.nativeWidthPx,
    heightPx: asset.nativeHeightPx,
    interpolated: true,
  };
}

function checkResolutionProvenance(
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (asset.resolutionProvenance === "native") {
    return {
      check: "resolution_provenance",
      status: "pass",
      severity: "info",
      reason: "Asset pixel dimensions genuinely reflect source detail (no interpolated upscale).",
    };
  }
  if (asset.resolutionProvenance === "interpolated_upscale") {
    return {
      check: "resolution_provenance",
      status: "warning",
      severity: "info",
      reason:
        "Asset dimensions include an interpolated upscale — resolution sufficiency was judged against the true, smaller source dimensions, not the enlarged pixel count.",
    };
  }
  if (asset.resolutionProvenance === "reconstructed") {
    return {
      check: "resolution_provenance",
      status: "pass",
      severity: "info",
      reason:
        "Asset dimensions include genuine provider-side reconstruction (not fabricated local interpolation) — resolution sufficiency was judged against the reconstructed pixel dimensions directly.",
    };
  }
  return {
    check: "resolution_provenance",
    status: "unknown",
    severity: "info",
    reason: "Resolution provenance is not recorded for this asset; treated conservatively (never assumed native).",
  };
}

function checkEffectiveResolution(
  requirements: ProductionRequirements,
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): { check: PrintValidationCheck; effectivePpi: number | null } {
  if (requirements.targetPpi === null || !requirements.targetDimensions) {
    return {
      check: {
        check: "effective_resolution",
        status: "pass",
        severity: "blocking",
        reason: "Raster resolution is not the primary requirement for this production method.",
      },
      effectivePpi: null,
    };
  }
  const honest = honestDimensionsFor(asset);
  if (honest.widthPx === null || honest.heightPx === null) {
    return {
      check: {
        check: "effective_resolution",
        status: "unknown",
        severity: "blocking",
        reason: honest.interpolated
          ? "Cannot compute effective resolution — this asset is an interpolated upscale and its true source dimensions are not recorded."
          : "Cannot compute effective resolution without known pixel dimensions.",
      },
      effectivePpi: null,
    };
  }

  const { effectivePpi } = calculateEffectiveResolution(
    { widthPx: honest.widthPx, heightPx: honest.heightPx },
    requirements.targetDimensions,
  );
  const sufficient = effectivePpi >= requirements.targetPpi;
  const provenanceNote = honest.interpolated
    ? " (measured against true source detail, not the enlarged file dimensions)"
    : "";
  return {
    check: {
      check: "effective_resolution",
      status: sufficient ? "pass" : "fail",
      severity: "blocking",
      reason: sufficient
        ? `Effective resolution is ~${Math.round(effectivePpi)} PPI, meeting the ${requirements.targetPpi} PPI target${provenanceNote}.`
        : `Effective resolution is ~${Math.round(effectivePpi)} PPI, below the ${requirements.targetPpi} PPI target for the intended print size${provenanceNote}.`,
    },
    effectivePpi,
  };
}

function checkMinimumRasterDimensions(
  requirements: ProductionRequirements,
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (!requirements.minRasterDimensionsPx) {
    return {
      check: "minimum_raster_dimensions",
      status: "pass",
      severity: "blocking",
      reason: "No minimum raster size applies to this production method.",
    };
  }
  const honest = honestDimensionsFor(asset);
  if (honest.widthPx === null || honest.heightPx === null) {
    return {
      check: "minimum_raster_dimensions",
      status: "unknown",
      severity: "blocking",
      reason: honest.interpolated
        ? "Cannot compare against the minimum raster size — this asset is an interpolated upscale and its true source dimensions are not recorded."
        : "Cannot compare against the minimum raster size without known pixel dimensions.",
    };
  }
  const meets =
    honest.widthPx >= requirements.minRasterDimensionsPx.widthPx &&
    honest.heightPx >= requirements.minRasterDimensionsPx.heightPx;
  const provenanceNote = honest.interpolated
    ? " (measured against true source detail, not the enlarged file dimensions)"
    : "";
  return {
    check: "minimum_raster_dimensions",
    status: meets ? "pass" : "fail",
    severity: "blocking",
    reason: meets
      ? `Asset meets the minimum ${requirements.minRasterDimensionsPx.widthPx}x${requirements.minRasterDimensionsPx.heightPx}px requirement${provenanceNote}.`
      : `Asset is ${honest.widthPx}x${honest.heightPx}px${provenanceNote}, below the minimum ${requirements.minRasterDimensionsPx.widthPx}x${requirements.minRasterDimensionsPx.heightPx}px requirement.`,
  };
}

function checkVectorSource(
  requirements: ProductionRequirements,
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (requirements.requiredOutputType === "raster") {
    return {
      check: "vector_source",
      status: "pass",
      severity: "blocking",
      reason: "Vector source is not required for this production method.",
    };
  }
  if (asset.vectorAssetId) {
    return {
      check: "vector_source",
      status: "pass",
      severity: "blocking",
      reason: "A vector companion asset already exists.",
    };
  }
  return {
    check: "vector_source",
    status: "fail",
    severity: "blocking",
    reason: "This production method requires vector artwork, and none exists yet.",
  };
}

function checkConceptEvaluationAlignment(
  input: PrintValidationInput,
): PrintValidationCheck {
  if (!input.conceptEvaluationStatus || input.conceptEvaluationStatus === "pending") {
    return {
      check: "concept_evaluation_alignment",
      status: "unknown",
      severity: "blocking",
      reason: "Concept Evaluation has not completed for this concept.",
    };
  }
  if (input.conceptEvaluationStatus === "failed") {
    return {
      check: "concept_evaluation_alignment",
      status: "fail",
      severity: "blocking",
      reason: "Concept Evaluation determined this concept does not match the approved Design Brief.",
    };
  }
  if (input.conceptEvaluationStatus === "needs_review") {
    return {
      check: "concept_evaluation_alignment",
      status: "warning",
      severity: "warning",
      reason: "Concept Evaluation was inconclusive for this concept.",
    };
  }
  return {
    check: "concept_evaluation_alignment",
    status: "pass",
    severity: "blocking",
    reason: "Concept Evaluation determined this concept matches the approved Design Brief.",
  };
}

function checkRequiredWordingVerification(
  input: PrintValidationInput,
): PrintValidationCheck {
  const criterion = input.conceptEvaluation?.criteria.find(
    (c) => c.key === "required_wording",
  );
  if (!criterion || criterion.passed === null) {
    return {
      check: "required_wording_verification",
      status: "unknown",
      severity: "blocking",
      reason: "Required wording has not been verified for this concept yet.",
    };
  }
  return {
    check: "required_wording_verification",
    status: criterion.passed ? "pass" : "fail",
    severity: "blocking",
    reason: criterion.passed
      ? "Required wording was verified as present and correct."
      : "Required wording was not verified as present and correct on this concept.",
  };
}

function aggregateStatus(checks: PrintValidationCheck[]): PrintValidationStatus {
  const blocking = checks.filter((c) => c.severity === "blocking");
  const allSatisfied = blocking.every((c) => c.status === "pass");
  return allSatisfied ? "ready" : "finalization_required";
}

function buildReport(
  input: PrintValidationInput,
  requirements: ProductionRequirements,
  checks: PrintValidationCheck[],
  requiredTransformations: Set<FinalizationTransformation>,
  status: PrintValidationStatus,
): PrintValidationReport {
  // A "blocking"-severity check only ever carries status "pass" / "fail" /
  // "unknown" in this module — never "warning" (that status is reserved for
  // "warning"-severity checks) — so these two filters never overlap and
  // together account for every non-passing check (Goal 10: an "unknown"
  // check must never be silently treated as a pass).
  const blockingIssues = checks
    .filter((c) => c.severity === "blocking" && c.status !== "pass")
    .map((c) => c.reason);
  const warnings = checks
    .filter((c) => c.severity !== "blocking" && c.status !== "pass")
    .map((c) => c.reason);

  return {
    artworkVersionId: input.artworkVersionId,
    designBriefVersionId: input.designBriefVersionId,
    status,
    requirements,
    checks,
    requiredTransformations: Array.from(requiredTransformations),
    blockingIssues,
    warnings,
    evaluatedAt: new Date().toISOString(),
  };
}
