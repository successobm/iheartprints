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
  PrintValidationProfile,
  PrintValidationReport,
  PrintValidationStatus,
  ProductionNormalizationSummary,
  ProductionRequirements,
  UploadedPreserveEvidence,
} from "./contracts";

/**
 * Print-Ready Normalization Phase 1 tolerances. Explicit, named, and always
 * compared with an inequality — never floating-point equality.
 */
/**
 * Minimum share of the production plate that must be actual artwork (alpha
 * bounding box ÷ trimmed plate). A correctly normalized plate sits at ~0.97+
 * (the small artwork-edge safety margin is the only thing below 1); the live
 * audited plate that motivated this phase sat at ~0.50 (2662x2861 of artwork
 * inside a 3600x4200 canvas), so this threshold separates the two by a wide
 * margin rather than splitting hairs.
 */
const MIN_ARTWORK_OCCUPANCY = 0.8;
/** Allowed relative deviation between the trimmed artwork's aspect ratio and the produced plate's. One pixel of rounding is far inside this. */
const ASPECT_RATIO_TOLERANCE = 0.01;
/** Allowed shortfall, in PPI, when comparing achieved effective resolution against the target — absorbs rounding only. */
const EFFECTIVE_PPI_TOLERANCE = 0.5;
/** Allowed relative deviation between embedded pHYs density and the intended production PPI (pHYs is an integer pixels-per-metre field, so it can never be exact). */
const DENSITY_METADATA_TOLERANCE = 0.01;
/** An alpha bounding box smaller than this on either axis is not meaningful artwork — it is a stray pixel or an encoding artifact. */
const MIN_MEANINGFUL_ALPHA_BBOX_PX = 16;
/**
 * Existing Artwork → Print Ready Phase 2. Allowed relative deviation between
 * the approved prepared artwork's own aspect ratio and the produced plate's
 * visible artwork. Wider than `ASPECT_RATIO_TOLERANCE` on purpose: that one
 * compares two measurements of the SAME raster inside one transform, while
 * this one spans an enhancement step, where an alpha threshold applied to
 * reconstructed edge pixels can legitimately move a bounding box by a pixel
 * or two. Still far tighter than any real crop or letterbox, which is what
 * this check exists to catch.
 */
const SOURCE_GEOMETRY_TOLERANCE = 0.02;
/**
 * Existing Artwork → Print Ready Phase 2. How far past 1.0 the production
 * resample may scale the artwork it was built from before the plate is
 * reporting pixels it does not have detail for. Absorbs rounding only — the
 * failure this guards against (a reconstruction that lands short of the
 * production target) overshoots it by whole multiples, never by half a
 * percent.
 */
const CONTENT_SCALE_TOLERANCE = 0.005;

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
    intendedPrintWidthIn: input.intendedPrintWidthIn ?? null,
  });

  const profile: PrintValidationProfile =
    input.validationProfile ?? "generated_concept";
  const uploadedPreserve = profile === "uploaded_preserve";

  const checks: PrintValidationCheck[] = [];
  const requiredTransformations = new Set<FinalizationTransformation>();

  // Emitted first, and on every run, so a report always states which checks
  // it was even asking — never leaving "not applicable" and "passed"
  // indistinguishable to whoever reads it later.
  checks.push(describeValidationProfile(profile));

  // --- Hard-block checks -------------------------------------------------
  // These represent "there is nothing here to finalize", not "this needs
  // more work" — Goal 5's `"blocked"` status.

  if (!input.primaryAsset) {
    checks.push({
      check: "asset_exists",
      status: "fail",
      severity: "blocking",
      reason: uploadedPreserve
        ? "No production asset exists for this uploaded artwork."
        : "No generated asset exists for this concept.",
    });
    return buildReport(input, requirements, checks, requiredTransformations, profile, "blocked");
  }
  checks.push({
    check: "asset_exists",
    status: "pass",
    severity: "blocking",
    reason: uploadedPreserve
      ? "A production asset exists for this uploaded artwork."
      : "A generated asset exists for this concept.",
  });

  // Existing Artwork → Print Ready Phase 2: `brief_provenance` asks whether
  // this artwork was generated from the currently approved Design Brief
  // version. Uploaded artwork was not generated from anything — the
  // customer's own file, and their explicit approval of the prepared version
  // of it, are the authority (see `PrintValidationProfile`). The check is not
  // emitted rather than emitted as a pass, so nothing reads as verified that
  // was never asked; `source_lineage` below is the uploaded workflow's own,
  // genuinely applicable provenance check.
  if (!uploadedPreserve) {
    const provenance = checkBriefProvenance(input);
    checks.push(provenance);
    if (provenance.status === "fail") {
      return buildReport(input, requirements, checks, requiredTransformations, profile, "blocked");
    }
  } else {
    const lineage = checkSourceLineage(input);
    checks.push(lineage);
    if (lineage.status !== "pass") {
      // A plate whose lineage cannot be established is not a plate to spend
      // any further arithmetic certifying — the same "there is nothing here
      // to finalize" class as a missing asset.
      requiredTransformations.add("require_human_review");
      return buildReport(input, requirements, checks, requiredTransformations, profile, "blocked");
    }
  }

  // --- Recoverable checks --------------------------------------------------
  // From here on the concept is a legitimate finalization candidate; every
  // remaining failure describes work the future Final Artwork capability
  // would need to do, not a reason to discard the concept.

  const asset = input.primaryAsset;
  // Print-Ready Normalization Phase 1: present only for an authoritative
  // production-plate validation. When absent, every check below behaves
  // exactly as it did for provisional concept-stage validation.
  const normalization = input.productionNormalization ?? null;

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

  const resolutionCheck = checkEffectiveResolution(requirements, asset, normalization);
  checks.push(resolutionCheck.check);
  if (resolutionCheck.check.status === "fail") {
    requiredTransformations.add("regenerate_at_production_dimensions");
    requiredTransformations.add("upscale_raster_artwork");
  }

  const minDimensionsCheck = checkMinimumRasterDimensions(
    requirements,
    asset,
    normalization,
  );
  checks.push(minDimensionsCheck);
  if (minDimensionsCheck.status === "fail") {
    requiredTransformations.add("regenerate_at_production_dimensions");
  }

  // --- Print-Ready Normalization Phase 1: production-plate-only checks -----
  // `print_ready` must mean "the normalized artwork ITSELF is production
  // ready", so these run against the real plate's own measured geometry.
  if (normalization) {
    const normalizationCheck = checkProductionNormalization(normalization, asset);
    checks.push(normalizationCheck);
    if (normalizationCheck.status !== "pass") {
      requiredTransformations.add("require_human_review");
    }

    const alphaCheck = checkAlphaBoundArtwork(normalization);
    checks.push(alphaCheck);
    if (alphaCheck.status !== "pass") {
      requiredTransformations.add("require_human_review");
    }

    const deadCanvasCheck = checkTransparentDeadCanvas(normalization);
    checks.push(deadCanvasCheck);
    if (deadCanvasCheck.status !== "pass") {
      requiredTransformations.add("resize_to_final_dimensions");
    }

    const widthPolicyCheck = checkPhysicalWidthPolicy(normalization);
    checks.push(widthPolicyCheck);
    if (widthPolicyCheck.status !== "pass") {
      requiredTransformations.add("resize_to_final_dimensions");
    }

    const aspectCheck = checkAspectRatioPreserved(normalization);
    checks.push(aspectCheck);
    if (aspectCheck.status !== "pass") {
      requiredTransformations.add("require_human_review");
    }

    // Informational only — density metadata is never allowed to stand in for
    // real pixel geometry (see `effective-resolution.ts`).
    checks.push(checkDensityMetadata(normalization));

    // --- Existing Artwork → Print Ready Phase 2: preservation checks -------
    // Only meaningful against a real plate, and only for artwork whose source
    // pixels are themselves the specification.
    if (uploadedPreserve && input.uploadedPreserve) {
      const geometryCheck = checkPreservedSourceGeometry(
        normalization,
        input.uploadedPreserve,
      );
      checks.push(geometryCheck);
      if (geometryCheck.status !== "pass") {
        requiredTransformations.add("require_human_review");
      }

      const sufficiencyCheck = checkReconstructionSufficiency(normalization);
      checks.push(sufficiencyCheck);
      if (sufficiencyCheck.status !== "pass") {
        requiredTransformations.add("upscale_raster_artwork");
      }
    }
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

  // Existing Artwork → Print Ready Phase 2: both of these ask "does this
  // artwork match the brief we were given?" — a question with no answer, not
  // a lenient one, when the customer supplied the artwork and no brief
  // describes it. Not emitted under `uploaded_preserve`; see
  // `PrintValidationProfile` for the full rationale.
  if (!uploadedPreserve) {
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
  return buildReport(input, requirements, checks, requiredTransformations, profile, status);
}

function describeValidationProfile(
  profile: PrintValidationProfile,
): PrintValidationCheck {
  return {
    check: "validation_profile",
    status: "pass",
    severity: "info",
    reason:
      profile === "uploaded_preserve"
        ? "Applied the uploaded-preserve profile: the customer's own approved artwork is the specification, so brief provenance, Concept Evaluation alignment, and typed required-wording verification are inapplicable and were not evaluated; source-lineage and geometry-preservation checks were evaluated in their place."
        : "Applied the generated-concept profile: this artwork was produced from an approved Design Brief, so brief provenance, Concept Evaluation alignment, and required-wording verification all apply.",
  };
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
  normalization: ProductionNormalizationSummary | null,
): { check: PrintValidationCheck; effectivePpi: number | null } {
  // Print-Ready Normalization Phase 1: for a real production plate, effective
  // resolution is measured against the size the plate is actually INTENDED to
  // print at — never the placement envelope, and never a padded canvas.
  if (normalization) {
    const honest = honestDimensionsFor(asset);
    if (honest.widthPx === null || honest.heightPx === null) {
      return {
        check: {
          check: "effective_resolution",
          status: "unknown",
          severity: "blocking",
          reason: honest.interpolated
            ? "Cannot compute effective resolution — this production artwork is an interpolated upscale and its true source dimensions are not recorded."
            : "Cannot compute effective resolution without known production pixel dimensions.",
        },
        effectivePpi: null,
      };
    }
    const { effectivePpi } = calculateEffectiveResolution(
      { widthPx: honest.widthPx, heightPx: honest.heightPx },
      { widthIn: normalization.intendedWidthIn, heightIn: normalization.intendedHeightIn },
    );
    const sufficient =
      effectivePpi >= normalization.targetPpi - EFFECTIVE_PPI_TOLERANCE;
    const provenanceNote = honest.interpolated
      ? " (measured against true source detail, not the enlarged file dimensions)"
      : "";
    return {
      check: {
        check: "effective_resolution",
        status: sufficient ? "pass" : "fail",
        severity: "blocking",
        reason: sufficient
          ? `Production artwork prints at ~${Math.round(effectivePpi)} PPI over its intended ${formatIn(normalization.intendedWidthIn)}x${formatIn(normalization.intendedHeightIn)}in size, meeting the ${normalization.targetPpi} PPI target${provenanceNote}.`
          : `Production artwork prints at only ~${Math.round(effectivePpi)} PPI over its intended ${formatIn(normalization.intendedWidthIn)}x${formatIn(normalization.intendedHeightIn)}in size, below the ${normalization.targetPpi} PPI target${provenanceNote}.`,
      },
      effectivePpi,
    };
  }

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
  normalization: ProductionNormalizationSummary | null,
): PrintValidationCheck {
  // Print-Ready Normalization Phase 1: a legitimately wide (or tall) plate has
  // fewer pixels on its short axis than the placement ENVELOPE would demand —
  // comparing it against the envelope would fail correct artwork purely for
  // not being envelope-shaped. The real bar is the plate's own intended
  // physical size at the target PPI.
  if (normalization) {
    const required = {
      widthPx: Math.ceil(normalization.intendedWidthIn * normalization.targetPpi),
      heightPx: Math.ceil(normalization.intendedHeightIn * normalization.targetPpi),
    };
    const honest = honestDimensionsFor(asset);
    if (honest.widthPx === null || honest.heightPx === null) {
      return {
        check: "minimum_raster_dimensions",
        status: "unknown",
        severity: "blocking",
        reason: honest.interpolated
          ? "Cannot compare against the minimum production size — this production artwork is an interpolated upscale and its true source dimensions are not recorded."
          : "Cannot compare against the minimum production size without known production pixel dimensions.",
      };
    }
    const meets = honest.widthPx >= required.widthPx && honest.heightPx >= required.heightPx;
    const provenanceNote = honest.interpolated
      ? " (measured against true source detail, not the enlarged file dimensions)"
      : "";
    return {
      check: "minimum_raster_dimensions",
      status: meets ? "pass" : "fail",
      severity: "blocking",
      reason: meets
        ? `Production artwork carries at least the ${required.widthPx}x${required.heightPx}px its intended physical size requires at ${normalization.targetPpi} PPI${provenanceNote}.`
        : `Production artwork carries ${honest.widthPx}x${honest.heightPx}px${provenanceNote}, below the ${required.widthPx}x${required.heightPx}px its intended physical size requires at ${normalization.targetPpi} PPI.`,
    };
  }

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

// ---------------------------------------------------------------------------
// Existing Artwork → Print Ready Phase 2 — uploaded-preserve checks
// ---------------------------------------------------------------------------

/**
 * The uploaded workflow's own provenance check, and the structural guarantee
 * behind Goal 6: the plate was built from the PREPARED artwork the customer
 * approved, never from the immutable original upload and never from an asset
 * this report is not actually about.
 *
 * Missing evidence fails rather than passes. A plate whose lineage nobody
 * recorded is indistinguishable from one built from the wrong source, and
 * "we didn't write it down" is not a reason to certify it.
 */
function checkSourceLineage(input: PrintValidationInput): PrintValidationCheck {
  const evidence = input.uploadedPreserve;
  if (!evidence) {
    return {
      check: "source_lineage",
      status: "fail",
      severity: "blocking",
      reason:
        "No source lineage was recorded for this production artwork, so it cannot be shown to derive from the prepared artwork the customer approved.",
    };
  }
  if (evidence.preparedArtworkVersionId !== input.artworkVersionId) {
    return {
      check: "source_lineage",
      status: "fail",
      severity: "blocking",
      reason:
        "This production artwork's recorded source is a different prepared artwork than the one being validated.",
    };
  }
  if (!evidence.preparedAssetId || evidence.preparedAssetId === evidence.originalAssetId) {
    return {
      check: "source_lineage",
      status: "fail",
      severity: "blocking",
      reason:
        "This production artwork records the customer's original upload as its source rather than the approved, background-prepared version of it.",
    };
  }
  if (!/^[0-9a-f]{64}$/.test(evidence.sourceBytesSha256)) {
    return {
      check: "source_lineage",
      status: "fail",
      severity: "blocking",
      reason:
        "This production artwork carries no usable content hash for the exact source pixels it was built from.",
    };
  }
  return {
    check: "source_lineage",
    status: "pass",
    severity: "blocking",
    reason: `Production artwork derives from the customer-approved prepared artwork (content hash ${evidence.sourceBytesSha256.slice(0, 12)}…), not from the immutable original upload.`,
  };
}

/**
 * Compares the plate's own visible artwork against the approved prepared
 * artwork's visible artwork, by proportion. Both figures are alpha bounding
 * boxes measured at the same threshold, so this is one measurement against
 * another rather than two different ideas of "visible".
 *
 * DELIBERATELY NOT a fidelity claim. It cannot tell whether a reconstruction
 * changed a colour, softened a letterform, or altered a texture — no
 * arithmetic on bounding boxes can. What it does catch is the failure mode
 * that arithmetic CAN catch: artwork cropped away, padded out, or squashed on
 * its way through the production pipeline.
 */
function checkPreservedSourceGeometry(
  normalization: ProductionNormalizationSummary,
  evidence: UploadedPreserveEvidence,
): PrintValidationCheck {
  const sourceRatio =
    evidence.sourceAlphaBBoxWidthPx / evidence.sourceAlphaBBoxHeightPx;
  const plateRatio =
    normalization.alphaBBoxWidthPx / normalization.alphaBBoxHeightPx;

  if (
    !Number.isFinite(sourceRatio) ||
    !Number.isFinite(plateRatio) ||
    sourceRatio <= 0 ||
    plateRatio <= 0
  ) {
    return {
      check: "preserved_source_geometry",
      status: "unknown",
      severity: "blocking",
      reason:
        "Source and production artwork proportions could not be compared — one of the recorded artwork bounds is incomplete.",
    };
  }

  const relativeDeviation = Math.abs(plateRatio - sourceRatio) / sourceRatio;
  const preserved = relativeDeviation <= SOURCE_GEOMETRY_TOLERANCE;
  return {
    check: "preserved_source_geometry",
    status: preserved ? "pass" : "fail",
    severity: "blocking",
    reason: preserved
      ? `Production artwork keeps the approved artwork's proportions (${sourceRatio.toFixed(4)} → ${plateRatio.toFixed(4)}, within ${SOURCE_GEOMETRY_TOLERANCE * 100}%).`
      : `Production artwork's proportions differ from the approved artwork's (${sourceRatio.toFixed(4)} → ${plateRatio.toFixed(4)}) — the design appears to have been cropped, padded, or distorted during production.`,
  };
}

/**
 * The honest answer to "what if enhancement still isn't enough?".
 *
 * Production sizing always resamples the trimmed artwork to the target
 * dimensions, so a plate ALWAYS has the pixel count its physical size
 * demands — that number alone can never fail. What can fail is whether those
 * pixels carry detail: if the raster the plate was built from was narrower
 * than the plate itself, the difference was manufactured by interpolation.
 *
 * Derived from figures the summary already carries rather than a new field:
 * the produced width is `intendedWidthIn × targetPpi` by construction, and
 * `trimmedWidthPx` is the artwork it was resampled from, so their ratio is
 * exactly the production transform's own content scale.
 */
function checkReconstructionSufficiency(
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  const producedWidthPx = normalization.intendedWidthIn * normalization.targetPpi;
  if (
    !Number.isFinite(producedWidthPx) ||
    !Number.isFinite(normalization.trimmedWidthPx) ||
    normalization.trimmedWidthPx <= 0
  ) {
    return {
      check: "reconstruction_sufficiency",
      status: "unknown",
      severity: "blocking",
      reason:
        "Cannot determine whether this production artwork was enlarged beyond its source detail — its recorded production geometry is incomplete.",
    };
  }

  const contentScale = producedWidthPx / normalization.trimmedWidthPx;
  const sufficient = contentScale <= 1 + CONTENT_SCALE_TOLERANCE;
  return {
    check: "reconstruction_sufficiency",
    status: sufficient ? "pass" : "fail",
    severity: "blocking",
    reason: sufficient
      ? `Production artwork was sized down from (or held at) the detail it was built from (${Math.round(normalization.trimmedWidthPx)}px → ${Math.round(producedWidthPx)}px), so every printed pixel carries real detail.`
      : `Production artwork was enlarged ${contentScale.toFixed(2)}x beyond the artwork it was built from (${Math.round(normalization.trimmedWidthPx)}px → ${Math.round(producedWidthPx)}px) — it carries the required pixel count without the detail to match it.`,
  };
}

// ---------------------------------------------------------------------------
// Print-Ready Normalization Phase 1 — production-plate checks
// ---------------------------------------------------------------------------

/**
 * Cross-checks the plate's recorded pixel dimensions against the physical
 * specification the normalization claims for them. These are two independently
 * persisted facts (the `AssetRecord`'s own dimensions and the transform's
 * metadata); if they disagree, something resized or re-encoded the plate after
 * normalization and no other check's arithmetic can be trusted.
 */
function checkProductionNormalization(
  normalization: ProductionNormalizationSummary,
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (asset.widthPx === null || asset.heightPx === null) {
    return {
      check: "production_normalization",
      status: "unknown",
      severity: "blocking",
      reason: "Production artwork pixel dimensions are not recorded, so its physical print specification cannot be verified.",
    };
  }

  const expectedWidthPx = normalization.intendedWidthIn * normalization.targetPpi;
  const expectedHeightPx = normalization.intendedHeightIn * normalization.targetPpi;
  const agrees =
    Math.abs(asset.widthPx - expectedWidthPx) <= 1 &&
    Math.abs(asset.heightPx - expectedHeightPx) <= 1;

  return {
    check: "production_normalization",
    status: agrees ? "pass" : "fail",
    severity: "blocking",
    reason: agrees
      ? `Production artwork is ${asset.widthPx}x${asset.heightPx}px, intended to print at ${formatIn(normalization.intendedWidthIn)}x${formatIn(normalization.intendedHeightIn)}in (${normalization.strategy}, ${normalization.targetPpi} PPI).`
      : `Production artwork is ${asset.widthPx}x${asset.heightPx}px, which does not match its recorded intended print size of ${formatIn(normalization.intendedWidthIn)}x${formatIn(normalization.intendedHeightIn)}in at ${normalization.targetPpi} PPI — the file may have been resized after normalization.`,
  };
}

function checkAlphaBoundArtwork(
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  const meaningful =
    normalization.alphaBBoxWidthPx >= MIN_MEANINGFUL_ALPHA_BBOX_PX &&
    normalization.alphaBBoxHeightPx >= MIN_MEANINGFUL_ALPHA_BBOX_PX;
  return {
    check: "alpha_bound_artwork",
    status: meaningful ? "pass" : "fail",
    severity: "blocking",
    reason: meaningful
      ? `Visible artwork occupies a ${normalization.alphaBBoxWidthPx}x${normalization.alphaBBoxHeightPx}px alpha-bound region of the production artwork.`
      : `Visible artwork occupies only a ${normalization.alphaBBoxWidthPx}x${normalization.alphaBBoxHeightPx}px region — too small to be meaningful printable artwork.`,
  };
}

/**
 * The defect the Print-Ready Production Output Audit found: a plate whose
 * artwork covered roughly half its pixels, with the rest transparent padding —
 * which also inflated every resolution figure computed against the canvas.
 */
function checkTransparentDeadCanvas(
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  const occupancy = normalization.artworkOccupancy;
  const acceptable = occupancy >= MIN_ARTWORK_OCCUPANCY;
  return {
    check: "transparent_dead_canvas",
    status: acceptable ? "pass" : "fail",
    severity: "blocking",
    reason: acceptable
      ? `Artwork fills ${formatPercent(occupancy)} of the production artwork; transparent padding is limited to the intended artwork-edge safety margin.`
      : `Artwork fills only ${formatPercent(occupancy)} of the production artwork — the rest is transparent dead canvas, which is not a print-ready deliverable.`,
  };
}

function checkPhysicalWidthPolicy(
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  // A tall/narrow artwork proportionally reduced to fit the placement's
  // printable height is correct, intended behavior — its width is honestly
  // below target rather than stretched or cropped to reach it.
  if (normalization.constrainedBy === "max_height") {
    return {
      check: "physical_width_policy",
      status: "pass",
      severity: "blocking",
      reason: `Production artwork prints ${formatIn(normalization.intendedWidthIn)}in wide — narrower than the ${formatIn(normalization.targetWidthIn)}in target because the artwork's own proportions reached the placement's printable height first.`,
    };
  }

  const deviation = Math.abs(
    normalization.intendedWidthIn - normalization.targetWidthIn,
  );
  const withinPolicy = deviation <= normalization.widthToleranceIn;
  return {
    check: "physical_width_policy",
    status: withinPolicy ? "pass" : "fail",
    severity: "blocking",
    reason: withinPolicy
      ? `Production artwork prints ${formatIn(normalization.intendedWidthIn)}in wide, matching the ${formatIn(normalization.targetWidthIn)}in target for this placement.`
      : `Production artwork prints ${formatIn(normalization.intendedWidthIn)}in wide, outside the ${formatIn(normalization.targetWidthIn)}in ±${normalization.widthToleranceIn}in target for this placement.`,
  };
}

function checkAspectRatioPreserved(
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  const trimmedRatio = normalization.trimmedWidthPx / normalization.trimmedHeightPx;
  const producedRatio = normalization.intendedWidthIn / normalization.intendedHeightIn;
  if (!Number.isFinite(trimmedRatio) || !Number.isFinite(producedRatio) || producedRatio <= 0) {
    return {
      check: "aspect_ratio_preserved",
      status: "unknown",
      severity: "blocking",
      reason: "Aspect ratio could not be compared — production geometry is incomplete.",
    };
  }
  const relativeDeviation = Math.abs(producedRatio - trimmedRatio) / trimmedRatio;
  const preserved = relativeDeviation <= ASPECT_RATIO_TOLERANCE;
  return {
    check: "aspect_ratio_preserved",
    status: preserved ? "pass" : "fail",
    severity: "blocking",
    reason: preserved
      ? `Artwork proportions survived normalization (${trimmedRatio.toFixed(4)} → ${producedRatio.toFixed(4)}, within ${ASPECT_RATIO_TOLERANCE * 100}%).`
      : `Artwork proportions changed during normalization (${trimmedRatio.toFixed(4)} → ${producedRatio.toFixed(4)}) — the artwork has been distorted.`,
  };
}

/**
 * Records whether the file's own embedded density agrees with the intended
 * production resolution. Deliberately INFO severity: rewriting a density tag
 * adds no image information, so it can confirm — never establish —
 * print-readiness.
 */
function checkDensityMetadata(
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  if (normalization.densityPixelsPerMetre === null) {
    return {
      check: "density_metadata",
      status: "unknown",
      severity: "info",
      reason: "Production artwork carries no embedded physical-resolution metadata; effective resolution was calculated from pixel geometry, which is authoritative regardless.",
    };
  }
  const declaredPpi = normalization.densityPixelsPerMetre / 39.3700787402;
  const agrees =
    Math.abs(declaredPpi - normalization.targetPpi) / normalization.targetPpi <=
    DENSITY_METADATA_TOLERANCE;
  return {
    check: "density_metadata",
    status: agrees ? "pass" : "warning",
    severity: "info",
    reason: agrees
      ? `Embedded physical-resolution metadata declares ~${Math.round(declaredPpi)} PPI, agreeing with the intended ${normalization.targetPpi} PPI production specification.`
      : `Embedded physical-resolution metadata declares ~${Math.round(declaredPpi)} PPI, disagreeing with the intended ${normalization.targetPpi} PPI production specification (pixel geometry remains authoritative).`,
  };
}

/** Compact inch formatting for internal report reasons — never customer-facing copy. */
function formatIn(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
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
  profile: PrintValidationProfile,
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
    profile,
    status,
    requirements,
    checks,
    requiredTransformations: Array.from(requiredTransformations),
    blockingIssues,
    warnings,
    evaluatedAt: new Date().toISOString(),
  };
}
