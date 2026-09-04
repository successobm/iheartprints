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
  DtfFeatureIntegritySummary,
  FinalizationTransformation,
  PrintValidationCheck,
  PrintValidationCheckStatus,
  PrintValidationInput,
  PrintValidationProfile,
  PrintValidationReport,
  PrintValidationStatus,
  ProductionNormalizationSummary,
  ProductionRequirements,
  RigidSignFitToProductionEdgeEvidence,
  RigidSignFitToProductionEvidence,
  RigidSignGeometryStepEvidence,
  RigidSignMachineReadableContentEvidence,
  RigidSignPlanEvidence,
  UploadedPreserveEvidence,
} from "./contracts";
import type { HalftoneProductionEvidence } from "./contracts";
import {
  DEFAULT_PRODUCTION_TREATMENT,
  MAX_HALFTONE_LPI,
  MIN_HALFTONE_LPI,
  MIN_PRINTABLE_DOT_RADIUS_PX,
  type ProductionTreatment,
} from "@/capabilities/shared/production-treatment";
import {
  classifyDtfFeatureWidth,
  classifyDtfPartialAlphaFeature,
  classifyStructuralFragility,
  DTF_FEATURE_INTEGRITY_PROFILE_VERSION,
  DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM,
  DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM,
  DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
  DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
  effectiveDtfFeatureIntegrityTier,
  type DtfFeatureIntegrityTier,
  type StructuralFragilityResult,
} from "@/capabilities/shared/dtf-feature-integrity-profile";

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
/**
 * Print'em All Phase 2. Allowed relative deviation between a halftone
 * screen's REQUESTED line frequency and the frequency its recorded cell pitch
 * actually produces.
 *
 * Tight, because there is nothing here for a tolerance to absorb: cell pitch
 * is `targetPpi / lpi` in continuous coordinates and is deliberately never
 * rounded to whole pixels, so the only deviation possible is float
 * representation. A wider band would let a genuine LPI error — the classic
 * one being an engine that rounds 8.571px to 9px and silently prints 33.3 LPI
 * while the file says 35 — pass as rounding.
 */
const HALFTONE_LPI_TOLERANCE = 0.001;
/**
 * Print'em All Phase 2. The minimum ratio of source TONAL resolution to
 * screen frequency below which a halftone is not backed by real tone.
 *
 * 1.0 is the information floor, not a style preference: at exactly 1.0 each
 * halftone cell is backed by one source sample, and below it cells start
 * sharing samples, so the screen is inventing tonal structure the file does
 * not contain. That is the same lie `reconstruction_sufficiency` refuses on
 * the continuous-tone path, measured in the unit this representation actually
 * consumes.
 */
const MIN_HALFTONE_TONAL_RATIO = 1;
/**
 * Below this ratio the screen is backed by real tone but has little margin —
 * fine detail lands within a cell or two of the sampling limit and will soften
 * visibly. A warning, never a block: it is a quality observation for the
 * operator looking at the proof, not a claim that the plate is wrong.
 */
const COMFORTABLE_HALFTONE_TONAL_RATIO = 1.5;

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
  // Signs Phase S2: the rigid_sign_raster profile is entirely self-contained
  // — its requirements are never brief-derived (Sprint A2's lesson: a
  // structured, human-confirmed authority in, never prose classification),
  // so it branches before `deriveProductionRequirements` is ever called.
  // Every apparel line below this branch is unreached and unchanged for a
  // sign validation run.
  if ((input.validationProfile ?? "generated_concept") === "rigid_sign_raster") {
    return validateRigidSign(input);
  }

  const requirements = deriveProductionRequirements({
    printPlacement: input.printPlacement,
    productSummary: input.productSummary,
    designDescription: input.designDescription,
    intendedPrintWidthIn: input.intendedPrintWidthIn ?? null,
    // Sprint A2 (corrected): structured authority in, never re-derived here.
    requestedProductionOutput: input.requestedProductionOutput ?? null,
  });

  const profile: PrintValidationProfile =
    input.validationProfile ?? "generated_concept";
  const uploadedPreserve = profile === "uploaded_preserve";

  // Print'em All Phase 2. A SECOND, INDEPENDENT AXIS from the profile above:
  // the profile says whose specification the artwork answers to, the
  // treatment says which physical representation was made. Absent means
  // standard raster, so every plate produced before treatments existed is
  // judged by exactly the rules it was produced under.
  const productionTreatment: ProductionTreatment =
    input.productionTreatment ?? DEFAULT_PRODUCTION_TREATMENT;
  const halftoneTreatment = productionTreatment === "halftone_dtf";

  const checks: PrintValidationCheck[] = [];
  const requiredTransformations = new Set<FinalizationTransformation>();

  // Emitted first, and on every run, so a report always states which checks
  // it was even asking — never leaving "not applicable" and "passed"
  // indistinguishable to whoever reads it later.
  checks.push(describeValidationProfile(profile));

  // --- Hard-block checks -------------------------------------------------
  // These represent "there is nothing here to finalize", not "this needs
  // more work" — Goal 5's `"blocked"` status.

  // Sprint A2: asked before anything else, because for an out-of-scope
  // product every downstream measurement is beside the point. A yard sign
  // whose artwork happens to satisfy the raster checks is still not a thing
  // iHeartPrints makes, and a report saying `"ready"` would be a lie of
  // arithmetic. This is a product-scope decision (Constitution §7.13), not a
  // production profile awaiting implementation.
  if (requirements.category === "out_of_scope_product") {
    checks.push({
      check: "product_scope",
      status: "fail",
      severity: "blocking",
      reason:
        "Product is outside the iHeartPrints product scope (apparel artwork); no production artifact is produced for it.",
    });
    requiredTransformations.add("require_human_review");
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
  }
  checks.push({
    check: "product_scope",
    status: "pass",
    severity: "blocking",
    reason: "Product is within the iHeartPrints apparel product scope.",
  });

  // Sprint A2: the customer explicitly asked for a production artifact this
  // product does not make. Blocking on its own terms — not because the raster
  // artwork is deficient, but because handing them a Production PNG would be
  // answering a question they did not ask. Emitted as a pass on every other
  // run so "no unsupported artifact was requested" is stated, never inferred
  // from the check's absence.
  if (requirements.requestedUnsupportedOutput) {
    checks.push({
      check: "production_output_supported",
      status: "fail",
      severity: "blocking",
      reason: `Customer explicitly requested ${requirements.requestedUnsupportedOutput}; iHeartPrints currently produces the raster Production PNG only, which must not be presented as satisfying that request.`,
    });
    requiredTransformations.add("require_human_review");
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
  }
  checks.push({
    check: "production_output_supported",
    status: "pass",
    severity: "blocking",
    reason:
      "No unsupported production artifact was requested; the deliverable is the raster Production PNG.",
  });

  if (!input.primaryAsset) {
    checks.push({
      check: "asset_exists",
      status: "fail",
      severity: "blocking",
      reason: uploadedPreserve
        ? "No production asset exists for this uploaded artwork."
        : "No generated asset exists for this concept.",
    });
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
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
      return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
    }
  } else {
    const lineage = checkSourceLineage(input);
    checks.push(lineage);
    if (lineage.status !== "pass") {
      // A plate whose lineage cannot be established is not a plate to spend
      // any further arithmetic certifying — the same "there is nothing here
      // to finalize" class as a missing asset.
      requiredTransformations.add("require_human_review");
      return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
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

    // --- DTF Feature Integrity Phase 1 --------------------------------------
    // Standard-raster continuous-tone plates only (Section 14 of this
    // phase's plan): a halftone plate's dot lattice is not stroke/gap
    // geometry, and applying a continuous-tone rule to it would misclassify
    // every legitimate halftone dot as a "tiny isolated component." Applies
    // to BOTH validation profiles — a Create New Artwork production PNG and
    // an uploaded/prepared production PNG are equally subject to physical
    // feature fragility, and neither the brief nor the customer's own pixels
    // change what DTF production physically requires.
    //
    // Emitted only when the measurement is actually present (a standard-
    // raster asset whose final production raster was decoded and measured);
    // never emitted as a false pass, mirroring how halftone/reconstruction
    // checks are absent rather than defaulted outside their own applicable
    // case.
    if (!halftoneTreatment && input.dtfFeatureIntegrity) {
      const dtf = input.dtfFeatureIntegrity;

      const positiveCheck = checkDtfPositiveFeatureIntegrity(dtf);
      checks.push(positiveCheck);
      if (positiveCheck.status === "fail") requiredTransformations.add("require_human_review");

      const negativeCheck = checkDtfNegativeSpaceIntegrity(dtf);
      checks.push(negativeCheck);
      if (negativeCheck.status === "fail") requiredTransformations.add("require_human_review");

      const isolatedCheck = checkDtfIsolatedFeatureIntegrity(dtf);
      checks.push(isolatedCheck);
      if (isolatedCheck.status === "fail") requiredTransformations.add("require_human_review");

      // Diagnostic-only — see the profile module. Never contributes to
      // `requiredTransformations` and never carries `severity: "blocking"`.
      checks.push(checkDtfPartialAlphaFeatureIntegrity(dtf));
    }

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

      // Print'em All Phase 2 — THE SWAP, and the one place the two
      // production representations genuinely diverge in what they must prove.
      //
      // `reconstruction_sufficiency` asks a CONTINUOUS-TONE question: were
      // these pixels stretched past the detail of the raster they were built
      // from? For a halftone plate that question is not lenient or strict, it
      // is malformed — the plate's pixels are a dot lattice drawn at final
      // size, not a resample of source detail, so the check would fail every
      // correct halftone ever produced. Relaxing it to let them through would
      // be far worse: it would quietly weaken what that check means for every
      // continuous-tone plate as well.
      //
      // So a halftone plate answers a DIFFERENT set of questions instead, and
      // it is not a smaller one. It must prove its screen was recorded, was
      // generated across the delivered plate's own dimensions, carries the
      // physical cell geometry its stated LPI requires, and was backed by
      // enough source TONE to be worth screening at that frequency.
      if (halftoneTreatment) {
        const treatmentCheck = checkHalftoneTreatment(input.halftone ?? null);
        checks.push(treatmentCheck);
        if (treatmentCheck.status !== "pass") {
          requiredTransformations.add("require_human_review");
        }

        if (input.halftone) {
          const finalSizeCheck = checkHalftoneFinalSizeGeneration(
            input.halftone,
            normalization,
            asset,
          );
          checks.push(finalSizeCheck);
          if (finalSizeCheck.status !== "pass") {
            requiredTransformations.add("require_human_review");
          }

          const screenGeometryCheck = checkHalftoneScreenGeometry(input.halftone);
          checks.push(screenGeometryCheck);
          if (screenGeometryCheck.status !== "pass") {
            requiredTransformations.add("require_human_review");
          }

          const toneCheck = checkHalftoneTonalSufficiency(
            input.halftone,
            normalization,
          );
          checks.push(toneCheck);
          if (toneCheck.status === "fail") {
            requiredTransformations.add("require_human_review");
          }
        }
      } else {
        const sufficiencyCheck = checkReconstructionSufficiency(normalization);
        checks.push(sufficiencyCheck);
        if (sufficiencyCheck.status !== "pass") {
          requiredTransformations.add("upscale_raster_artwork");
        }
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
  return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, status);
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
        : profile === "rigid_sign_raster"
          ? "Applied the rigid_sign_raster profile: the customer's supplied artwork, deterministically repaired to the exact ordered substrate size, is the specification. No Design Brief, Concept Evaluation, apparel transparency requirement, or apparel placement sizing applies; plan lineage, executed-plan integrity, exact physical dimensions, opacity, and content-bounds checks apply in their place."
          : "Applied the generated-concept profile: this artwork was produced from an approved Design Brief, so brief provenance, Concept Evaluation alignment, and required-wording verification all apply.",
  };
}

// ---------------------------------------------------------------------------
// Signs Phase S2: rigid_sign_raster profile
// ---------------------------------------------------------------------------

/** Relative aspect tolerance for "do both ordered axes independently reconcile" — the same figure `sign-preparation`'s own inspection uses. */
const RIGID_SIGN_ASPECT_TOLERANCE = 0.01;
/** PPI comparison tolerance, mirroring `EFFECTIVE_PPI_TOLERANCE`. */
const RIGID_SIGN_PPI_TOLERANCE = 0.5;

/**
 * LIVE PRODUCT BLOCKER #4D: independently re-derives whether a
 * reconstruction-provider result is PROPORTIONAL to what the approved plan
 * requested — never trusting the worker's own claim that it was. Reuses
 * `RIGID_SIGN_ASPECT_TOLERANCE`, the SAME tolerance this profile already
 * applies to "do both ordered axes independently reconcile" — one
 * tolerance value for one meaning ("proportional, modulo ordinary raster
 * rounding") throughout this profile, not a second, possibly-disagreeing
 * one for this specific check.
 */
function reconstructionIsProportional(
  requestedWidthPx: number,
  requestedHeightPx: number,
  actualWidthPx: number,
  actualHeightPx: number,
): boolean {
  if (!(requestedWidthPx > 0) || !(requestedHeightPx > 0) || !(actualWidthPx > 0) || !(actualHeightPx > 0)) {
    return false;
  }
  const scaleX = actualWidthPx / requestedWidthPx;
  const scaleY = actualHeightPx / requestedHeightPx;
  const larger = Math.max(scaleX, scaleY);
  return Math.abs(scaleX - scaleY) / larger <= RIGID_SIGN_ASPECT_TOLERANCE;
}

/**
 * LIVE PRODUCT BLOCKER #4D: true only when BOTH sides are `null` (no
 * geometry step on either the approved plan or the executed steps — a
 * bare reconstruction that reached the ordered aspect on its own) or BOTH
 * are present AND identical in `kind`/`axis`/fill. Pixel amounts
 * (`leadingPx`/`trailingPx`) are deliberately not part of this evidence —
 * re-deriving them is the ONE thing a legitimate S3C adaptation is
 * permitted to do; anything else diverging (a different step kind, a
 * different axis, a different fill, or one side present without the
 * other) means the executed geometry did not implement the approved plan.
 */
function geometryStepIdentityMatches(
  planned: RigidSignGeometryStepEvidence | null,
  executed: RigidSignGeometryStepEvidence | null,
): boolean {
  if (planned === null && executed === null) return true;
  if (planned === null || executed === null) return false;
  return (
    planned.kind === executed.kind &&
    planned.axis === executed.axis &&
    planned.colorR === executed.colorR &&
    planned.colorG === executed.colorG &&
    planned.colorB === executed.colorB &&
    planned.color === executed.color
  );
}

function validateRigidSign(input: PrintValidationInput): PrintValidationReport {
  const profile: PrintValidationProfile = "rigid_sign_raster";
  const productionTreatment: ProductionTreatment = DEFAULT_PRODUCTION_TREATMENT;
  const checks: PrintValidationCheck[] = [];
  const requiredTransformations = new Set<FinalizationTransformation>();

  checks.push(describeValidationProfile(profile));

  if (!input.rigidSignRequirements) {
    checks.push({
      check: "exact_physical_dimensions",
      status: "unknown",
      severity: "blocking",
      reason: "No rigid-sign production requirements were provided for this run.",
    });
    requiredTransformations.add("require_human_review");
    return buildReport(
      input,
      EMPTY_RIGID_SIGN_REQUIREMENTS,
      checks,
      requiredTransformations,
      profile,
      productionTreatment,
      "blocked",
    );
  }
  const requirements = input.rigidSignRequirements;

  if (!input.primaryAsset) {
    checks.push({
      check: "asset_exists",
      status: "fail",
      severity: "blocking",
      reason: "No production asset exists for this rigid-sign preparation.",
    });
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
  }
  const asset = input.primaryAsset;
  checks.push({
    check: "asset_exists",
    status: "pass",
    severity: "blocking",
    reason: "A production asset exists for this rigid-sign preparation.",
  });

  checks.push(checkContentType(asset));

  const dimensionsKnown = asset.widthPx !== null && asset.heightPx !== null;
  checks.push({
    check: "raster_dimensions_known",
    status: dimensionsKnown ? "pass" : "unknown",
    severity: "blocking",
    reason: dimensionsKnown
      ? `Asset is ${asset.widthPx}x${asset.heightPx}px.`
      : "Asset pixel dimensions are not recorded.",
  });

  if (!input.rigidSign) {
    checks.push({
      check: "repair_plan_recorded",
      status: "fail",
      severity: "blocking",
      reason: "No repair plan evidence was recorded for this production asset.",
    });
    requiredTransformations.add("require_human_review");
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
  }
  const sign: RigidSignPlanEvidence = input.rigidSign;

  const planRecorded =
    sign.planKey.length > 0 && sign.policyId.length > 0 && sign.planSchemaVersion.length > 0;
  checks.push({
    check: "repair_plan_recorded",
    status: planRecorded ? "pass" : "fail",
    severity: "blocking",
    reason: planRecorded
      ? `A repair plan (${sign.planSchemaVersion}, policy ${sign.policyId}) was recorded for this production asset.`
      : "The recorded repair plan is missing its schema version, policy id, or plan key.",
  });
  if (!planRecorded) {
    requiredTransformations.add("require_human_review");
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
  }

  const lineageValid =
    sign.sourceAssetId.length > 0 && /^[0-9a-f]{64}$/.test(sign.sourceSha256);
  checks.push({
    check: "source_lineage",
    status: lineageValid ? "pass" : "fail",
    severity: "blocking",
    reason: lineageValid
      ? `Production artwork derives from immutable source asset ${sign.sourceAssetId} (content hash ${sign.sourceSha256.slice(0, 12)}…).`
      : "This production artwork carries no usable source asset id or content hash.",
  });
  if (!lineageValid) {
    requiredTransformations.add("require_human_review");
    return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, "blocked");
  }

  // The plan-integrity / print-ready risk boundary — the single most
  // important check in this profile. Constitution §16A.3 / S0.5 Rule 1: a
  // plan whose executed steps do not provably match what was recorded, that
  // reached here via anything but S2's admitted deterministic steps, or
  // that lacks a sufficient production-risk authorization, must never
  // certify as `"ready"`.
  //
  // Signs Phase S4→PrintValidation integration: reconstruction itself is no
  // longer an automatic block. A plan whose steps require semantic
  // preservation verification may still certify ready, but ONLY when an
  // authoritative `SignPreservationVerification` proves the executed steps
  // preserved the customer's artwork AND that verification is bound to
  // THIS exact asset/source/plan/algorithm identity — never a bare
  // boolean, never inferred from the record merely existing. Missing,
  // unknown, changed, or mismatched-identity evidence all fail exactly
  // like no evidence at all (fail closed).
  //
  // Semantic Worker Wiring Phase: gated on `sign.planRequiresSemantic
  // PreservationVerification` (the caller's own re-derivation of
  // `sign-preparation`'s `planRequiresSemanticPreservationVerification`),
  // NEVER on `asset.resolutionProvenance === "reconstructed"` — that used
  // to be the same condition by coincidence (the only plan shape ever
  // needing verification was also the only one a provider ever touched).
  // `reconstruct_perimeter_structure` breaks that coincidence: its pixels
  // stay `resolutionProvenance: "native"` (no provider is ever involved)
  // but still need the identical preservation question asked and answered
  // before this profile may certify ready. Gating on provenance alone
  // silently skipped this entire check for such a plan — whatever its
  // semantic verification actually concluded (`changed`, `unknown`, or
  // simply missing) had no bearing on readiness at all.
  const needsPreservationAuthorization = sign.planRequiresSemanticPreservationVerification;
  const pv = sign.preservationVerification;
  const preservationAuthorized =
    !needsPreservationAuthorization ||
    (pv !== null &&
      pv.status === "preserved" &&
      pv.finalAssetId === sign.finalAssetId &&
      pv.sourceAssetId === sign.sourceAssetId &&
      pv.sourceSha256 === sign.sourceSha256 &&
      pv.planKey === sign.planKey &&
      pv.verificationAlgorithmVersion === sign.expectedPreservationAlgorithmVersion);
  // LIVE PRODUCT BLOCKER #4B: `containsOnlyAdmittedSteps` alone is `false`
  // for ANY plan needing bounded provider reconstruction, by construction
  // (`reconstruct_resolution` is never S2-admitted) — that made plan
  // integrity unconditionally fail for every such plan, regardless of how
  // well reconstruction or preservation went, a gap between Signs Phase
  // S3A/S4 (which built the full reconstruct→verify pipeline) and this
  // still-S2-era rule. `planRequiresBoundedReconstruction` admits EXACTLY
  // that one S3A-recognized shape (a plan whose only non-admitted content
  // is a single `reconstruct_resolution` step) — never `approved_crop`,
  // never any other unrecognized step kind, and never anything the worker
  // itself refused to execute in the first place. This does not weaken
  // readiness on its own: `preservationAuthorized` (below) independently
  // still requires an authoritative `"preserved"` verification, bound to
  // this exact asset/source/plan/algorithm identity, before a reconstructed
  // plate's `executedPlanOk` can ever be true.
  //
  // LIVE PRODUCT BLOCKER #4D: `executedStepsMatchPlan` alone made an
  // "exact, unmodified replay" the ONLY admissible execution — but a real
  // reconstruction provider can honestly return more than requested
  // (proportionally), and the Signs Phase S3C adaptive-geometry path
  // exists PRECISELY to deterministically re-derive a geometry step's
  // pixel amounts from that actual result while still reaching the
  // ordered aspect. `executedStepsMatchPlan` is `false` in exactly that
  // case (a genuine, honest divergence from the plan's own predicted
  // numbers) — this never changes that flag's own meaning. Instead, a
  // SEPARATE, independently-verified path admits it: `geometryAdaptationOk`
  // re-derives, from raw facts alone (never a trusted "adaptation was
  // valid" claim), that (a) the actual reconstruction was genuinely
  // proportional to what was requested, and (b) the executed geometry
  // step's kind/axis/fill are IDENTICAL to the approved plan's own
  // recorded step — only pixel amounts differ. Anything else (a crop, a
  // distortion, a different step kind or axis, or missing/malformed
  // adaptation evidence) fails this independently of `executedStepsMatchPlan`.
  const adaptation = sign.executedGeometryAdaptation;
  const geometryAdaptationOk =
    adaptation !== null &&
    reconstructionIsProportional(
      adaptation.reconstructionRequestedWidthPx,
      adaptation.reconstructionRequestedHeightPx,
      adaptation.reconstructionActualWidthPx,
      adaptation.reconstructionActualHeightPx,
    ) &&
    geometryStepIdentityMatches(adaptation.plannedStep, adaptation.executedStep);
  const planIntegrityOk =
    sign.planKeyVerified &&
    (sign.executedStepsMatchPlan || geometryAdaptationOk) &&
    (sign.containsOnlyAdmittedSteps || sign.planRequiresBoundedReconstruction);
  // LIVE PRODUCT BLOCKER #4: production-risk authorization, identity-bound
  // to THIS plan — never `planOverallRisk === "auto_safe"` alone anymore.
  // The one rule this profile enforces ("who may authorize which risk
  // class") is deliberately re-stated here rather than imported from
  // `sign-preparation/sign-plan-authorization.ts` — this module must never
  // depend on that capability (the same rule that keeps `planOverallRisk`
  // itself a plain string here). Both copies encode the identical rule;
  // any future change to one must be mirrored in the other by inspection.
  const auth = sign.authorization;
  const authorizationBindsToCurrentPlan = auth !== null && auth.planKey === sign.planKey;
  const riskAuthorized =
    authorizationBindsToCurrentPlan &&
    (sign.planOverallRisk === "auto_safe"
      ? auth!.authorizedBy === "customer" || auth!.authorizedBy === "operator"
      : sign.planOverallRisk === "review_required"
        ? auth!.authorizedBy === "operator"
        : false);
  const executedPlanOk = planIntegrityOk && riskAuthorized && preservationAuthorized;
  checks.push({
    check: "executed_plan_matches_recorded_plan",
    status: executedPlanOk ? "pass" : "fail",
    severity: "blocking",
    reason: !planIntegrityOk
      ? "The executed steps could not be verified as an exact, unmodified replay of the recorded plan."
      : !riskAuthorized
        ? auth === null
          ? "No production-risk authorization was found for this plan — it cannot certify as ready until it is explicitly authorized."
          : !authorizationBindsToCurrentPlan
            ? "The recorded authorization does not match this exact plan — a stale or superseded authorization can never authorize a different plan."
            : `This plan's overall risk classification is "${sign.planOverallRisk}", which requires operator authorization; the recorded authorization is not sufficient.`
        : !preservationAuthorized
          ? pv === null
            ? "This plan requires semantic preservation verification, and no authoritative record could be resolved for it — it cannot certify as ready until verification proves the executed steps preserved the artwork."
            : pv.status !== "preserved"
              ? `This plan requires semantic preservation verification, and it concluded "${pv.status}" rather than "preserved" — it cannot certify as ready.`
              : "This plan requires semantic preservation verification, but the resolved record does not match this exact asset, source, plan, or verification-algorithm identity — a stale or mismatched verification can never authorize a different output."
          : `The executed plan is a verified, unmodified replay of the recorded plan, contains only S2-admitted deterministic steps, and carries a sufficient production-risk authorization for its "${sign.planOverallRisk}" classification${needsPreservationAuthorization ? " and a matching, authoritative preservation verification proving the executed steps preserved the artwork" : ""}.`,
  });
  if (!executedPlanOk) {
    requiredTransformations.add("require_human_review");
  }

  const widthPpi =
    dimensionsKnown && asset.widthPx ? asset.widthPx / sign.orderedWidthIn : null;
  const heightPpi =
    dimensionsKnown && asset.heightPx ? asset.heightPx / sign.orderedHeightIn : null;
  const dimensionsExact =
    widthPpi !== null &&
    heightPpi !== null &&
    Math.abs(widthPpi - heightPpi) / Math.max(widthPpi, heightPpi) <=
      RIGID_SIGN_ASPECT_TOLERANCE;
  checks.push({
    check: "exact_physical_dimensions",
    status: !dimensionsKnown ? "unknown" : dimensionsExact ? "pass" : "fail",
    severity: "blocking",
    reason: !dimensionsKnown
      ? "Cannot verify exact physical dimensions without known production pixel dimensions."
      : dimensionsExact
        ? `Production plate is ${asset.widthPx}x${asset.heightPx}px, matching the ordered ${formatIn(sign.orderedWidthIn)}x${formatIn(sign.orderedHeightIn)}in size on both axes.`
        : `Production plate's pixel geometry (${asset.widthPx}x${asset.heightPx}px) does not independently reconcile with the ordered ${formatIn(sign.orderedWidthIn)}x${formatIn(sign.orderedHeightIn)}in size on both axes.`,
  });

  const effectivePpi =
    widthPpi !== null && heightPpi !== null ? Math.min(widthPpi, heightPpi) : null;
  let resolutionStatus: PrintValidationCheck["status"] = "unknown";
  let resolutionSeverity: PrintValidationCheck["severity"] = "blocking";
  let resolutionReason = "Cannot compute effective resolution without known production pixel dimensions.";
  if (effectivePpi !== null) {
    if (effectivePpi + RIGID_SIGN_PPI_TOLERANCE >= sign.targetPpi) {
      resolutionStatus = "pass";
      resolutionSeverity = "blocking";
      resolutionReason = `Production plate prints at ~${Math.round(effectivePpi)} PPI, meeting the ${sign.targetPpi} PPI target.`;
    } else if (effectivePpi + RIGID_SIGN_PPI_TOLERANCE >= sign.minPpi) {
      resolutionStatus = "warning";
      resolutionSeverity = "warning";
      resolutionReason = `Production plate prints at ~${Math.round(effectivePpi)} PPI — below the ${sign.targetPpi} PPI target, but at or above the ${sign.minPpi} PPI minimum.`;
    } else {
      resolutionStatus = "fail";
      resolutionSeverity = "blocking";
      resolutionReason = `Production plate prints at only ~${Math.round(effectivePpi)} PPI, below the ${sign.minPpi} PPI blocking minimum.`;
      requiredTransformations.add("upscale_raster_artwork");
    }
  }
  checks.push({
    check: "effective_resolution",
    status: resolutionStatus,
    severity: resolutionSeverity,
    reason: resolutionReason,
  });

  checks.push(checkResolutionProvenance(asset));

  const opaque = asset.hasTransparency === false;
  checks.push({
    check: "no_unintended_transparency",
    status: asset.hasTransparency === null ? "unknown" : opaque ? "pass" : "fail",
    severity: "blocking",
    reason:
      asset.hasTransparency === null
        ? "Transparency metadata is not recorded for this asset."
        : opaque
          ? "Production plate is fully opaque, as rigid-sign production requires."
          : "Production plate carries transparency; rigid-sign production intent is opaque and no flattening colour was ever invented for it.",
  });

  checks.push({
    check: "content_within_bounds",
    status: sign.contentBoundsWithinOutput ? "pass" : "fail",
    severity: "blocking",
    reason: sign.contentBoundsReason,
  });

  // Signs Perimeter Safety Phase: defense in depth (real incident
  // cc6cfc4b-...) — every check above can pass (pixels preserved, correct
  // dimensions/PPI, opaque, nothing cropped) while a geometry-extension
  // repair has still moved edge-relative artwork away from the finished
  // substrate edge it depends on. This never trusts `sign-repair-planner
  // .ts` to have already refused such a plan — a future planner regression
  // must still be caught here, independently, from the plate's own
  // evidence. `edgeDependentStructureOnAffectedEdge=false` (nothing
  // edge-dependent was extended) passes trivially — this check adds no
  // risk to the ordinary case.
  const substrateBoundaryOk =
    !sign.substrateBoundary.edgeDependentStructureOnAffectedEdge ||
    sign.substrateBoundary.perimeterAlignmentAnswer === "same" ||
    sign.substrateBoundary.perimeterAlignmentAnswer === "not_applicable";
  checks.push({
    check: "substrate_boundary_semantics",
    status: substrateBoundaryOk ? "pass" : "fail",
    severity: "blocking",
    reason: !sign.substrateBoundary.edgeDependentStructureOnAffectedEdge
      ? "No edge-dependent artwork structure was detected on any edge this repair extended."
      : substrateBoundaryOk
        ? `Edge-dependent artwork structure was detected on an extended edge, and semantic verification confirmed its relationship to the finished edge (${sign.substrateBoundary.perimeterAlignmentAnswer}).`
        : sign.substrateBoundary.perimeterAlignmentAnswer === null
          ? "Edge-dependent artwork structure was detected on an extended edge, and no semantic verification of its finished-edge relationship exists — it cannot certify as ready until that relationship is affirmatively verified."
          : `Edge-dependent artwork structure was detected on an extended edge, and semantic verification concluded "${sign.substrateBoundary.perimeterAlignmentAnswer}" rather than confirming its relationship to the finished edge survived — it cannot certify as ready.`,
  });
  if (!substrateBoundaryOk) {
    requiredTransformations.add("require_human_review");
  }

  // Signs Phase 3B (Fit to Production, Section J — "the most important
  // requirement") / Edge-Intent Correction Phase: PROTECTED_CONTENT must
  // never be permitted within the physical SAFE inset from any CUT edge.
  // `null` (never analysed) and `"unknown"` (an edge with no provable
  // bleed baseline) both fail closed — this check is the one place
  // "ambiguous content must not silently receive bleed permission" becomes
  // an actual blocking gate, not merely a UI label. A BLEED_BACKGROUND
  // field genuinely reaching the cut edge is never itself a failure;
  // neither is a governed EDGE_INTENT_ARTWORK region — only PROTECTED/
  // AMBIGUOUS content found too close to an edge, AFTER excluding those
  // two, is.
  const fitToProduction = sign.fitToProduction;
  const safeInsetOk = fitToProduction !== null && fitToProduction.overallResult === "pass";
  const failingEdges = fitToProduction?.edges.filter((e) => e.protectedResult !== "pass") ?? [];
  const protectedContentSafeInsetReason = describeFitToProductionResult(fitToProduction, safeInsetOk, failingEdges);
  checks.push({
    check: "protected_content_safe_inset",
    status: safeInsetOk ? "pass" : "fail",
    severity: "blocking",
    reason: protectedContentSafeInsetReason,
  });
  if (!safeInsetOk) {
    requiredTransformations.add("require_human_review");
  }

  // Edge-Intent Correction Phase (Section I): a non-blocking production
  // ADVISORY, entirely separate from the blocking check above — present
  // whenever any edge carries governed edge-intent artwork, regardless of
  // whether the plate is otherwise READY. Never itself contributes to
  // `status` or `requiredTransformations`; never confused with a failure.
  const edgeIntentEdges = fitToProduction?.edges.filter((e) => e.edgeIntentPresent) ?? [];
  checks.push({
    check: "edge_intent_advisory",
    status: "pass",
    severity: "info",
    reason:
      edgeIntentEdges.length > 0
        ? `Intentional edge artwork is within the cutting tolerance area on ${edgeIntentEdges.map((e) => e.edge).join(", ")} and may vary slightly after trimming.`
        : "No governed edge-intent artwork was found on this plate.",
  });

  // SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION: see
  // `RigidSignPlanEvidence.machineReadableContent`'s own doc for why
  // `null` here pushes NOTHING (never a manufactured failure) — this
  // evidence is opt-in (computed only when an operator explicitly runs
  // the check/restoration), unlike `fitToProduction` above.
  const machineReadableContent = sign.machineReadableContent;
  if (machineReadableContent !== null) {
    const result = machineReadableContent.overallResult;
    const blocking = result === "fail" || result === "hard_fail";
    const status: PrintValidationCheckStatus =
      result === "review_required" ? "warning" : blocking ? "fail" : "pass";
    checks.push({
      check: "machine_readable_content_preserved",
      status,
      // `severity` marks whether this check's outcome is PROVEN (pass,
      // not_applicable, fail, hard_fail — blocking-class, exactly like
      // `protected_content_safe_inset`'s own fixed severity) versus
      // genuinely UNPROVEN (review_required: the source itself was never
      // verified, so neither a pass nor a fail can be claimed — Section
      // R's own exact scoping keeps this out of the blocking aggregation
      // entirely, never silently upgraded to a failure).
      severity: result === "review_required" ? "warning" : "blocking",
      reason: describeMachineReadableContentResult(machineReadableContent),
    });
    if (blocking) requiredTransformations.add("require_human_review");
  }

  const status = aggregateStatus(checks);
  return buildReport(input, requirements, checks, requiredTransformations, profile, productionTreatment, status);
}

/** Internal rationale text for the `machine_readable_content_preserved` check — never customer-facing (mirrors every other check's own `reason` discipline in this file). Never includes the decoded payload itself (Section T). */
function describeMachineReadableContentResult(evidence: RigidSignMachineReadableContentEvidence): string {
  const { regions, overallResult } = evidence;
  if (overallResult === "not_applicable") {
    return "No machine-readable (QR) region was detected in the source artwork.";
  }
  const counts = {
    pass: regions.filter((r) => r.result === "pass").length,
    fail: regions.filter((r) => r.result === "fail").length,
    hard_fail: regions.filter((r) => r.result === "hard_fail").length,
    review_required: regions.filter((r) => r.result === "review_required").length,
  };
  const parts: string[] = [];
  if (counts.pass > 0) parts.push(`${counts.pass} verified preserved`);
  if (counts.fail > 0) parts.push(`${counts.fail} lost decodability during preparation`);
  if (counts.hard_fail > 0) parts.push(`${counts.hard_fail} now decode a DIFFERENT payload than the source`);
  if (counts.review_required > 0) {
    parts.push(`${counts.review_required} could not be verified from the original source artwork`);
  }
  return `${regions.length} machine-readable region(s) found in the source: ${parts.join("; ")}.`;
}

/** One edge's own clearance, formatted as "top 94px/0.607in" or "top no content found within scan depth". */
function formatFitToProductionEdgeClearance(edge: RigidSignFitToProductionEdgeEvidence): string {
  if (edge.nearestProtectedContentPx === null || edge.nearestProtectedContentIn === null) {
    return `${edge.edge} no content found within scan depth`;
  }
  return `${edge.edge} ${edge.nearestProtectedContentPx}px/${edge.nearestProtectedContentIn.toFixed(3)}in`;
}

/** One failing edge, formatted as "bottom (fail, 15px/0.094in, unresolved ambiguous)" or "left (unknown)". */
function formatFitToProductionFailingEdge(edge: RigidSignFitToProductionEdgeEvidence): string {
  const clearance = edge.nearestProtectedContentPx === null ? "" : `, ${edge.nearestProtectedContentPx}px/${edge.nearestProtectedContentIn!.toFixed(3)}in`;
  const ambiguity = edge.protectedResult === "fail" ? (edge.unresolvedAmbiguousPresent ? ", unresolved ambiguous review" : ", acknowledged protected content") : "";
  return `${edge.edge} (${edge.protectedResult}${clearance}${ambiguity})`;
}

function describeFitToProductionResult(
  fitToProduction: RigidSignFitToProductionEvidence | null,
  safeInsetOk: boolean,
  failingEdges: RigidSignFitToProductionEdgeEvidence[],
): string {
  if (fitToProduction === null) {
    return "No Fit to Production safe-inset analysis was recorded for this plate — it cannot certify as ready until protected-content clearance from every cut edge is affirmatively measured.";
  }
  if (safeInsetOk) {
    const clearances = fitToProduction.edges.map(formatFitToProductionEdgeClearance).join(", ");
    return `Every edge affirmatively clears the ${fitToProduction.safeInsetIn}in required protected-content inset (BLEED_BACKGROUND and any governed EDGE_INTENT_ARTWORK excluded from measurement) — nearest protected/ambiguous content: ${clearances}.`;
  }
  const failures = failingEdges.map(formatFitToProductionFailingEdge).join(", ");
  return (
    `${failingEdges.length} edge(s) do not clear the ${fitToProduction.safeInsetIn}in required protected-content inset or could not be ` +
    `affirmatively measured: ${failures} — a BLEED_BACKGROUND field reaching the cut edge, or governed EDGE_INTENT_ARTWORK, is never itself a ` +
    "failure; this means PROTECTED_CONTENT or unresolved AMBIGUOUS_REVIEW content was found too close, or the edge could not be proven safe at all."
  );
}

/** Placeholder requirements object for the hard-block case where none were provided — never returned as `"ready"`. */
const EMPTY_RIGID_SIGN_REQUIREMENTS: ProductionRequirements = {
  category: "rigid_sign_raster",
  printMethod: "unknown",
  printMethodConfidence: "unknown",
  requestedUnsupportedOutput: null,
  printLocation: null,
  targetDimensions: null,
  sizing: null,
  requiredOutputType: "raster",
  targetPpi: null,
  minRasterDimensionsPx: null,
  transparencyRequired: false,
  colorMode: "rgb",
  allowedFileFormats: [],
  artworkBoundaryMarginPercent: 0,
  requiredWordingVerificationRequired: false,
  notes: ["No rigid-sign production requirements were provided for this run."],
};

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
  if (
    asset.resolutionProvenance === "native" ||
    asset.resolutionProvenance === "reconstructed" ||
    // Print'em All Phase 2: a halftone plate's pixels are trusted for the same
    // reason a native asset's are, arrived at differently. Nothing was
    // enlarged to reach this pixel count — the dot lattice was DRAWN at it, so
    // the geometry is exact at the target density by construction. Whether
    // that lattice was worth drawing at this frequency is a separate question
    // with its own check (`halftone_tonal_sufficiency`); pixel count is not
    // where it gets asked.
    asset.resolutionProvenance === "halftone_generated"
  ) {
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
  if (asset.resolutionProvenance === "halftone_generated") {
    return {
      check: "resolution_provenance",
      status: "pass",
      severity: "info",
      // Worded with deliberate care. This says the DOT GEOMETRY is correct at
      // the production density because it was generated there. It does not say
      // — and must never be paraphrased into saying — that the source detail
      // was reconstructed to 300 PPI. See `halftone_tonal_sufficiency` for
      // what the source was actually asked for.
      reason:
        "Asset dimensions are final-size halftone production geometry: the dot lattice was generated at the production density rather than resampled to it, so pixel dimensions were judged directly. This is not a claim of reconstructed source detail.",
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
  //
  // Phase 28V.1: MUST use the SAME rounding rule
  // `resolveWidthConstrainedSizing` used to derive the plate's own actual
  // pixel dimensions from that same physical size (Math.round throughout —
  // see `print-placement-dimensions.ts`), never `Math.ceil`. `intendedWidthIn`/
  // `intendedHeightIn` are themselves already a pixels-to-inches division
  // (`outputPx / targetPpi`), so multiplying back by `targetPpi` here is a
  // round trip through floating point — for an inches value with no exact
  // binary representation (10.46, matching a real production incident:
  // project 7bcc3e19-5617-4712-99ab-65f1667b5eda), `10.46 * 300` evaluates
  // to `3138.0000000000005`, a hair ABOVE the true integer. `Math.ceil`
  // has zero tolerance for that overshoot and rounds up to 3139 — one
  // phantom pixel more than the asset's own real, correct, intentionally-
  // produced height of 3138 — failing a plate that exactly matches its own
  // target. `Math.round` (like the production code it must mirror)
  // correctly absorbs that same float error back down to 3138.
  if (normalization) {
    const required = {
      widthPx: Math.round(normalization.intendedWidthIn * normalization.targetPpi),
      heightPx: Math.round(normalization.intendedHeightIn * normalization.targetPpi),
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
// Print'em All Phase 2 — DTF halftone treatment checks
// ---------------------------------------------------------------------------

/**
 * Was the screen recorded at all?
 *
 * Missing evidence FAILS rather than passes, exactly as `source_lineage`
 * does and for the same reason. A screened plate whose settings nobody wrote
 * down cannot be reproduced, cannot be explained to a printer, and cannot be
 * compared against the next one — "we did not record it" is not a reason to
 * certify a production file.
 */
function checkHalftoneTreatment(
  evidence: HalftoneProductionEvidence | null,
): PrintValidationCheck {
  if (!evidence) {
    return {
      check: "halftone_treatment",
      status: "fail",
      severity: "blocking",
      reason:
        "This plate is recorded as DTF halftone production but carries no halftone screen evidence, so the screen that produced it cannot be reproduced or verified.",
    };
  }
  if (!evidence.algorithmVersion) {
    return {
      check: "halftone_treatment",
      status: "fail",
      severity: "blocking",
      reason:
        "This halftone plate records no screen engine version, so there is no way to know which implementation produced it.",
    };
  }
  return {
    check: "halftone_treatment",
    status: "pass",
    severity: "blocking",
    reason:
      `Halftone treatment recorded and reproducible: ${evidence.lpi} LPI, ${evidence.angleDeg}deg, ${evidence.dotShape} dot, ` +
      `midtone ${evidence.midtone}, choke ${evidence.chokePx}px, garment ${evidence.garmentHex}, engine ${evidence.algorithmVersion}.`,
  };
}

/**
 * THE CHECK THE WHOLE REPRESENTATION RESTS ON (Goals 6, 17, 18).
 *
 * A halftone plate's honesty is entirely a claim about WHERE the lattice was
 * drawn. Generated across the final canvas, a 35 LPI screen prints at 35 LPI
 * and its pixels are genuinely correct at 300 PPI. Generated small and
 * enlarged afterwards, the identical file prints at 35 divided by the scale
 * factor while still stating 35 — the dots get bigger, the tonal sampling
 * does not improve, and the plate has become a resolution claim it cannot
 * support. That is the failure this treatment could most plausibly be misused
 * to hide, so it is checked against three independently recorded facts:
 *
 *   the screen's own recorded generation dimensions,
 *   the delivered asset's actual pixel dimensions,
 *   the physical specification the transform recorded for those pixels
 *     (`intendedWidthIn x targetPpi`).
 *
 * The first two must agree EXACTLY — they are integer pixel counts written by
 * two different stages, so any disagreement means something between them
 * resized the plate, and there is nothing there to round. The third is
 * compared within a pixel, because it is a physical measurement in inches
 * being turned back into pixels.
 */
function checkHalftoneFinalSizeGeneration(
  evidence: HalftoneProductionEvidence,
  normalization: ProductionNormalizationSummary,
  asset: NonNullable<PrintValidationInput["primaryAsset"]>,
): PrintValidationCheck {
  if (asset.widthPx === null || asset.heightPx === null) {
    return {
      check: "halftone_final_size_generation",
      status: "unknown",
      severity: "blocking",
      reason:
        "Cannot confirm the halftone screen was generated at final size — the delivered plate's own pixel dimensions are not recorded.",
    };
  }

  if (
    evidence.screenWidthPx !== asset.widthPx ||
    evidence.screenHeightPx !== asset.heightPx
  ) {
    return {
      check: "halftone_final_size_generation",
      status: "fail",
      severity: "blocking",
      reason:
        `Halftone screen was generated across ${evidence.screenWidthPx}x${evidence.screenHeightPx}px but the delivered plate is ` +
        `${asset.widthPx}x${asset.heightPx}px — the dot lattice was resized after generation, so the plate does not print at the line frequency it states.`,
    };
  }

  // The physical cross-check. The plate's own recorded print size, converted
  // back to pixels at the recorded density, has to land on the same canvas the
  // lattice was drawn across — otherwise the screen and the physical
  // specification are describing two different plates.
  const specWidthPx = normalization.intendedWidthIn * normalization.targetPpi;
  const specHeightPx = normalization.intendedHeightIn * normalization.targetPpi;
  if (
    Math.abs(specWidthPx - evidence.screenWidthPx) > 1 ||
    Math.abs(specHeightPx - evidence.screenHeightPx) > 1
  ) {
    return {
      check: "halftone_final_size_generation",
      status: "fail",
      severity: "blocking",
      reason:
        `Halftone screen was generated across ${evidence.screenWidthPx}x${evidence.screenHeightPx}px, but this plate's recorded physical specification ` +
        `(${normalization.intendedWidthIn.toFixed(3)}in x ${normalization.intendedHeightIn.toFixed(3)}in at ${normalization.targetPpi} PPI) calls for ` +
        `${Math.round(specWidthPx)}x${Math.round(specHeightPx)}px — the screen and the physical specification describe different plates.`,
    };
  }

  return {
    check: "halftone_final_size_generation",
    status: "pass",
    severity: "blocking",
    reason:
      `Halftone screen was generated directly at the final production size (${evidence.screenWidthPx}x${evidence.screenHeightPx}px), matching both the ` +
      `delivered plate and its ${normalization.intendedWidthIn.toFixed(2)}in x ${normalization.intendedHeightIn.toFixed(2)}in specification at ${normalization.targetPpi} PPI; ` +
      "nothing was enlarged after generation.",
  };
}

/**
 * Is the screen's PHYSICAL geometry what its stated line frequency requires
 * (Goals 7, 18)?
 *
 * LPI is a physical dot frequency, so it is verifiable arithmetic rather than
 * a label: at a given output density there is exactly one cell pitch that
 * produces it. Recomputing that pitch here — instead of trusting the
 * engine's own `achievedLpi` — is what catches the classic implementation
 * bug where a cell size gets rounded to whole pixels and the plate silently
 * prints a different frequency than the one on its record.
 */
function checkHalftoneScreenGeometry(
  evidence: HalftoneProductionEvidence,
): PrintValidationCheck {
  if (
    !Number.isFinite(evidence.cellPx) ||
    evidence.cellPx <= 0 ||
    !Number.isFinite(evidence.targetPpi) ||
    evidence.targetPpi <= 0 ||
    !Number.isFinite(evidence.lpi) ||
    evidence.lpi <= 0
  ) {
    return {
      check: "halftone_screen_geometry",
      status: "unknown",
      severity: "blocking",
      reason:
        "Cannot verify halftone screen geometry — the recorded cell pitch, output density, or line frequency is incomplete.",
    };
  }

  if (evidence.lpi < MIN_HALFTONE_LPI || evidence.lpi > MAX_HALFTONE_LPI) {
    return {
      check: "halftone_screen_geometry",
      status: "fail",
      severity: "blocking",
      reason:
        `Halftone screen was produced at ${evidence.lpi} LPI, outside the ${MIN_HALFTONE_LPI}-${MAX_HALFTONE_LPI} LPI band this build supports and has tested geometry for.`,
    };
  }

  const expectedCellPx = evidence.targetPpi / evidence.lpi;
  const recomputedLpi = evidence.targetPpi / evidence.cellPx;
  const cellDeviation = Math.abs(evidence.cellPx - expectedCellPx) / expectedCellPx;
  const lpiDeviation = Math.abs(recomputedLpi - evidence.lpi) / evidence.lpi;

  if (cellDeviation > HALFTONE_LPI_TOLERANCE || lpiDeviation > HALFTONE_LPI_TOLERANCE) {
    return {
      check: "halftone_screen_geometry",
      status: "fail",
      severity: "blocking",
      reason:
        `Halftone cell pitch is ${evidence.cellPx.toFixed(4)}px where ${evidence.lpi} LPI at ${evidence.targetPpi} PPI requires ${expectedCellPx.toFixed(4)}px ` +
        `(the recorded lattice actually prints ${recomputedLpi.toFixed(2)} LPI) — the plate does not carry the line frequency it states.`,
    };
  }

  if (evidence.minDotRadiusPx < MIN_PRINTABLE_DOT_RADIUS_PX) {
    return {
      check: "halftone_screen_geometry",
      status: "fail",
      severity: "blocking",
      reason:
        `This screen's smallest dot is ${evidence.minDotRadiusPx.toFixed(2)}px in radius, below the ${MIN_PRINTABLE_DOT_RADIUS_PX}px a DTF process reproduces reliably — ` +
        "its lightest tones would drop out or print as haze rather than as dots.",
    };
  }

  return {
    check: "halftone_screen_geometry",
    status: "pass",
    severity: "blocking",
    reason:
      `Halftone geometry is physically correct: ${evidence.cellPx.toFixed(3)}px cells at ${evidence.targetPpi} PPI produce ${recomputedLpi.toFixed(2)} LPI against ${evidence.lpi} requested, ` +
      `with a smallest dot radius of ${evidence.minDotRadiusPx.toFixed(2)}px.`,
  };
}

/**
 * THE HALFTONE'S OWN SUFFICIENCY QUESTION — the counterpart of
 * `reconstruction_sufficiency`, asked in the unit this representation
 * actually consumes (Goal 18).
 *
 * A screen at L lines per inch samples the artwork L times per inch and can
 * represent nothing finer. So the honest bar is not "does the source carry
 * 300 PPI of detail?" — no halftone needs that, which is the whole reason
 * this treatment exists — but "does the source carry at least L PPI of TONE?".
 *
 * The source's tonal density falls out of geometry the normalization summary
 * already records, so nothing new has to be measured or trusted:
 *
 *     source tonal PPI = trimmedWidthPx / intendedWidthIn
 *
 * i.e. the pixels the plate was actually built from, spread across the
 * physical inches it prints at. For the live Print'em All fixture that is
 * 578px across 10.5in = 55 PPI, against a 35 LPI screen — a ratio of 1.57,
 * genuinely backed. The SAME file measured against continuous tone's 300 PPI
 * bar is short by 5.6x, and both statements are true at once because they are
 * measuring different representations.
 *
 * Below 1.0 the screen would be inventing tonal structure the file does not
 * contain, which is the same dishonesty the continuous-tone path refuses.
 * Between 1.0 and 1.5 it is real but tight, and the operator is told so
 * rather than blocked — a proof they can look at beats a threshold nobody
 * chose from a press test.
 */
function checkHalftoneTonalSufficiency(
  evidence: HalftoneProductionEvidence,
  normalization: ProductionNormalizationSummary,
): PrintValidationCheck {
  if (
    !Number.isFinite(normalization.trimmedWidthPx) ||
    normalization.trimmedWidthPx <= 0 ||
    !Number.isFinite(normalization.intendedWidthIn) ||
    normalization.intendedWidthIn <= 0 ||
    !Number.isFinite(evidence.lpi) ||
    evidence.lpi <= 0
  ) {
    return {
      check: "halftone_tonal_sufficiency",
      status: "unknown",
      severity: "blocking",
      reason:
        "Cannot determine whether this screen is backed by real source tone — the plate's recorded production geometry is incomplete.",
    };
  }

  const sourceTonalPpi = normalization.trimmedWidthPx / normalization.intendedWidthIn;
  const ratio = sourceTonalPpi / evidence.lpi;

  if (ratio < MIN_HALFTONE_TONAL_RATIO) {
    return {
      check: "halftone_tonal_sufficiency",
      status: "fail",
      severity: "blocking",
      reason:
        `This artwork carries ${sourceTonalPpi.toFixed(1)} PPI of tonal information across its ${normalization.intendedWidthIn.toFixed(2)}in print width, ` +
        `below the ${evidence.lpi} PPI a ${evidence.lpi} LPI screen consumes — halftone cells would share source samples, so the screen would be ` +
        "inventing tonal structure the file does not contain. A lower line frequency or a smaller physical size would be honest; this is not.",
    };
  }

  if (ratio < COMFORTABLE_HALFTONE_TONAL_RATIO) {
    return {
      check: "halftone_tonal_sufficiency",
      status: "warning",
      severity: "warning",
      reason:
        `This artwork carries ${sourceTonalPpi.toFixed(1)} PPI of tonal information against a ${evidence.lpi} LPI screen (${ratio.toFixed(2)}x) — ` +
        "backed by real source tone, but with little margin, so fine detail will soften noticeably. Halftoning represents tone; it does not restore detail the source never had.",
    };
  }

  return {
    check: "halftone_tonal_sufficiency",
    status: "pass",
    severity: "warning",
    reason:
      `This artwork carries ${sourceTonalPpi.toFixed(1)} PPI of tonal information against a ${evidence.lpi} LPI screen (${ratio.toFixed(2)}x) — ` +
      "every halftone cell is backed by real source tone.",
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

// ---------------------------------------------------------------------------
// DTF Feature Integrity Phase 1
// ---------------------------------------------------------------------------
//
// All four checks below classify already-measured physical widths/diameters
// (`DtfFeatureIntegritySummary`, assembled by `FinalArtworkWorkerCapability`
// from a real `FeatureIntegrityMeasurement`) against the ONE centralized,
// explicitly provisional profile in `shared/dtf-feature-integrity-profile.ts`.
// No threshold is declared here — see that module for why, and for why every
// number in it requires physical DTF calibration before it means anything
// more than "a conservative engineering starting point."

function formatMm(value: number): string {
  return `${value.toFixed(2)}mm`;
}

/**
 * "Restore Completed Print-Ready Download Flow": the honest, explicit
 * disclosure a `reason` string carries whenever
 * `effectiveDtfFeatureIntegrityTier` actually downgraded a raw "blocking"
 * verdict to "warning" for calibration reasons — never a silent severity
 * change. Empty string when no downgrade occurred (raw and gated tiers
 * agree), so a genuinely calibrated-blocking future verdict's reason text
 * is unaffected.
 *
 * Deliberately makes no safety claim ("guaranteed printable", "confirmed
 * fine") — only states the POLICY fact: an uncalibrated floor was crossed,
 * and this profile's current calibration status does not yet treat that as
 * grounds to withhold the file.
 */
function describeCalibrationDowngrade(
  rawTier: DtfFeatureIntegrityTier,
  gatedTier: DtfFeatureIntegrityTier,
): string {
  if (rawTier !== "blocking" || gatedTier === "blocking") return "";
  return (
    ` This crosses the current provisional BLOCKING floor, but the DTF Feature Integrity profile ` +
    `(${DTF_FEATURE_INTEGRITY_PROFILE_VERSION}) is explicitly uncalibrated — physical DTF testing has not yet established an ` +
    `authoritative floor — so this is reported as a warning, not a print refusal, until calibration does.`
  );
}

/**
 * Phase 2A: renders one `classifyStructuralFragility` result into the
 * `kind`-appropriate clause of a check's `reason` string. Shared between the
 * positive-feature and negative-space checks, which differ only in
 * vocabulary ("stroke" vs "gap").
 */
function describeStructuralFragility(
  result: StructuralFragilityResult,
  nounPhrase: string,
): string {
  if (result.kind === "structural") {
    return (
      `a SUBSTANTIAL PORTION of this structure's own geometry — not merely one isolated point — is this ${nounPhrase}. ` +
      "The minimum is representative of the shape as a whole, not an outlier."
    );
  }
  return (
    `this is a small, isolated dip within an otherwise more robust structure (a terminal tip, thin crack, or attached ` +
    `decorative detail) — the overwhelming majority of the structure's own geometry is NOT this ${nounPhrase}. ` +
    "Per this phase's plan, one pathological point must not by itself block an otherwise-robust structure."
  );
}

function checkDtfPositiveFeatureIntegrity(
  dtf: DtfFeatureIntegritySummary,
): PrintValidationCheck {
  const worst = dtf.positive.worstStructuralComponent;
  if (!worst) {
    return {
      check: "dtf_positive_feature_integrity",
      status: "pass",
      severity: "warning",
      reason: "No positive ink feature was measured; there is nothing narrow to flag.",
    };
  }

  const result = classifyStructuralFragility(
    worst.minStrokeWidthMm,
    worst.fractionBelowBlockingFloor,
    worst.fractionBelowWarningFloor,
    DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
    DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
  );
  const widthMm = worst.minStrokeWidthMm;

  if (result.effectiveTier === "pass") {
    return {
      check: "dtf_positive_feature_integrity",
      status: "pass",
      severity: "warning",
      reason:
        widthMm === null
          ? "No positive ink feature was measured; there is nothing narrow to flag."
          : `The thinnest measured positive ink feature is ${formatMm(widthMm)} wide at this artwork's confirmed print size.`,
    };
  }

  const floorMm =
    result.minimumTier === "blocking"
      ? DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM
      : DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM;
  const gatedTier = effectiveDtfFeatureIntegrityTier(result.effectiveTier);
  const reason =
    `The thinnest measured positive ink feature is ${formatMm(widthMm!)} wide at this artwork's confirmed print size — below the provisional ` +
    `${formatMm(floorMm)} DTF floor (uncalibrated; see the DTF Feature Integrity profile) — and ${describeStructuralFragility(result, "thin")}` +
    describeCalibrationDowngrade(result.effectiveTier, gatedTier);

  return {
    check: "dtf_positive_feature_integrity",
    status: gatedTier === "blocking" ? "fail" : "warning",
    severity: gatedTier === "blocking" ? "blocking" : "warning",
    reason,
  };
}

function checkDtfNegativeSpaceIntegrity(
  dtf: DtfFeatureIntegritySummary,
): PrintValidationCheck {
  const worst = dtf.negative.worstStructuralComponent;
  if (!worst) {
    return {
      check: "dtf_negative_space_integrity",
      status: "pass",
      severity: "warning",
      reason: "No enclosed or between-artwork negative space was measured; there is nothing narrow to flag.",
    };
  }

  const result = classifyStructuralFragility(
    worst.minGapWidthMm,
    worst.fractionBelowBlockingFloor,
    worst.fractionBelowWarningFloor,
    DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
    DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  );
  const widthMm = worst.minGapWidthMm;

  if (result.effectiveTier === "pass") {
    return {
      check: "dtf_negative_space_integrity",
      status: "pass",
      severity: "warning",
      reason:
        widthMm === null
          ? "No enclosed or between-artwork negative space was measured; there is nothing narrow to flag."
          : `The narrowest measured negative space is ${formatMm(widthMm)} wide at this artwork's confirmed print size.`,
    };
  }

  const floorMm =
    result.minimumTier === "blocking"
      ? DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM
      : DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM;
  const gatedTier = effectiveDtfFeatureIntegrityTier(result.effectiveTier);
  const reason =
    `The narrowest measured negative space (a letter counter or gap between shapes) is ${formatMm(widthMm!)} wide at this artwork's confirmed print size — below the provisional ` +
    `${formatMm(floorMm)} DTF floor (uncalibrated) — and ${describeStructuralFragility(result, "narrow")}` +
    describeCalibrationDowngrade(result.effectiveTier, gatedTier);

  return {
    check: "dtf_negative_space_integrity",
    status: gatedTier === "blocking" ? "fail" : "warning",
    severity: gatedTier === "blocking" ? "blocking" : "warning",
    reason,
  };
}

function checkDtfIsolatedFeatureIntegrity(
  dtf: DtfFeatureIntegritySummary,
): PrintValidationCheck {
  const diameterMm = dtf.isolated.smallestEquivalentDiameterMm;
  const tier = classifyDtfFeatureWidth(
    diameterMm,
    DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM,
    DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM,
  );
  // Phase 2A (Section 7): population-level context — informational, and
  // included on every status so an operator can tell "one small component"
  // apart from "hundreds of them totaling a meaningful share of the plate,"
  // regardless of which single component happens to be smallest.
  const micro = dtf.isolated.microComponents;
  const microNote =
    micro.microComponentCount > 0
      ? ` Separately, ${micro.microComponentCount} isolated micro component(s) were measured, together covering ` +
        `${formatPercent(micro.fractionOfPrintedArea)} of all printed area` +
        (micro.meanPartialAlphaFraction > 0.5
          ? " (predominantly faint/partial-alpha — may be background-removal residue rather than intentional detail; this measurement cannot tell the difference)."
          : " (predominantly crisp/opaque marks).")
      : "";
  if (diameterMm === null) {
    return {
      check: "dtf_isolated_feature_integrity",
      status: "pass",
      severity: "warning",
      reason: `No isolated printable component was measured; there is nothing small to flag.${microNote}`,
    };
  }
  const gatedTier = effectiveDtfFeatureIntegrityTier(tier);
  if (tier === "blocking") {
    return {
      check: "dtf_isolated_feature_integrity",
      status: gatedTier === "blocking" ? "fail" : "warning",
      severity: gatedTier === "blocking" ? "blocking" : "warning",
      reason:
        `The smallest isolated printable component measures ${formatMm(diameterMm)} equivalent diameter at this artwork's confirmed print size — below the provisional ` +
        `${formatMm(DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM)} DTF floor (uncalibrated). This describes measured geometry, not creative intent — a genuinely intentional tiny distressed fragment ` +
        `can still measure this small; a human reviewer, not this check, is the one who knows which.${microNote}` +
        describeCalibrationDowngrade(tier, gatedTier),
    };
  }
  if (tier === "warning") {
    return {
      check: "dtf_isolated_feature_integrity",
      status: "warning",
      severity: "warning",
      reason: `The smallest isolated printable component measures ${formatMm(diameterMm)} equivalent diameter at this artwork's confirmed print size — worth an operator's attention, not yet refused.${microNote}`,
    };
  }
  return {
    check: "dtf_isolated_feature_integrity",
    status: "pass",
    severity: "warning",
    reason: `The smallest isolated printable component measures ${formatMm(diameterMm)} equivalent diameter at this artwork's confirmed print size.${microNote}`,
  };
}

/**
 * Diagnostic-only (Section 10/13 of this phase's plan) — partial-alpha
 * geometry is the least understood category this phase measures, so this
 * check never returns `severity: "blocking"` regardless of what it measures.
 * See `classifyDtfPartialAlphaFeature`.
 */
function checkDtfPartialAlphaFeatureIntegrity(
  dtf: DtfFeatureIntegritySummary,
): PrintValidationCheck {
  const diameterMm = dtf.partialAlpha.smallestEquivalentDiameterMm;
  const tier = classifyDtfPartialAlphaFeature(diameterMm);
  if (diameterMm === null) {
    return {
      check: "dtf_partial_alpha_feature_integrity",
      status: "pass",
      severity: "warning",
      reason: "No partial-alpha (soft/faint) fine feature was measured.",
    };
  }
  if (tier === "warning") {
    return {
      check: "dtf_partial_alpha_feature_integrity",
      status: "warning",
      severity: "warning",
      reason:
        `The smallest partial-alpha fine feature measures ${formatMm(diameterMm)} equivalent diameter, carrying ` +
        `${formatPercent(dtf.partialAlpha.partialAlphaFractionOfVisible)} of visible artwork at partial alpha overall — diagnostic only. ` +
        "How a soft/faint feature this small actually reproduces through DTF ink and adhesive powder is not something this measurement can observe.",
    };
  }
  return {
    check: "dtf_partial_alpha_feature_integrity",
    status: "pass",
    severity: "warning",
    reason: `The smallest partial-alpha fine feature measures ${formatMm(diameterMm)} equivalent diameter.`,
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
  productionTreatment: ProductionTreatment,
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
    productionTreatment,
    status,
    requirements,
    checks,
    requiredTransformations: Array.from(requiredTransformations),
    blockingIssues,
    warnings,
    evaluatedAt: new Date().toISOString(),
    // Operator Production Correction UX: carried straight through from the
    // caller's own `rigidSign` evidence (never re-measured here) — `null`
    // outside the rigid_sign_raster profile, or when no analysis was ever
    // recorded for this plate. See `PrintValidationReport.fitToProductionEvidence`'s own doc.
    fitToProductionEvidence: input.rigidSign?.fitToProduction ?? null,
  };
}
