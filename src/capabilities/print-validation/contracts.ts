/**
 * Sprint 2M Phase 1: provider-neutral Print Validation contracts.
 *
 * Print Validation answers a different question than Concept Evaluation:
 *
 *   Concept Evaluation — "Did we generate the design the customer requested?"
 *   Print Validation   — "Can this artwork be produced correctly for the
 *                          intended print application?"
 *
 * A concept can pass Concept Evaluation and fail Print Validation — that is
 * expected, not a bug (a generated concept is ~1024x1024px; a full-back
 * print commonly needs 3600x4200px at production resolution). These
 * contracts are pure data. `PrintValidationCapability` never mutates a
 * Design Brief, never calls a generation/vision provider, and never
 * transforms artwork — it only determines what is currently known and
 * whether it is enough.
 */

import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  PrintPlacement,
} from "@/lib/domain/types";
import type { ProductionMethod } from "@/capabilities/shared/contracts";

// ---------------------------------------------------------------------------
// Production Requirements (Goal 2 / Goal 3 / Goal 8)
// ---------------------------------------------------------------------------

/** Internal print-production category. Never customer-facing terminology. */
export type ProductionCategory =
  | "apparel_raster" // DTF / DTG / sublimation-style: transparent raster PNG
  | "apparel_vector" // Screen print / embroidery on apparel: vector/digitized source required
  | "signage" // Banners/signs: vector at final size, fonts outlined
  | "logo_vector" // Generic vector/logo output: physical raster size is not the primary requirement
  | "unknown";

/**
 * How confidently `printMethod` / `category` were determined. The Design
 * Brief does not currently collect an explicit production method (Constitution
 * §6.6 — that is an internal decision, never asked of ordinary customers), so
 * this is deterministic keyword inference over already-collected brief text,
 * never a fabricated certainty.
 */
export type ProductionMethodConfidence = "confirmed" | "inferred" | "unknown";

/** Target physical print dimensions, always normalized to inches internally. */
export interface PhysicalDimensions {
  widthIn: number;
  /** `null` when only a width constraint is meaningful (rare in Phase 1). */
  heightIn: number | null;
}

export interface PixelDimensions {
  widthPx: number;
  heightPx: number;
}

export type RequiredOutputType = "raster" | "vector" | "raster_and_vector";

export type ColorModeExpectation =
  | "not_applicable"
  | "rgb"
  | "limited_spot_colors";

/**
 * Provider-neutral, internal production-readiness requirements for one
 * concept/placement combination. Never exposed as-is to a customer — see
 * ARCHITECTURE.md / Constitution §6.6 (Hide Technical Complexity).
 */
export interface ProductionRequirements {
  category: ProductionCategory;
  printMethod: ProductionMethod;
  printMethodConfidence: ProductionMethodConfidence;
  printLocation: PrintPlacement | null;
  /** `null` when physical size is not the primary requirement (e.g. `logo_vector`). */
  targetDimensions: PhysicalDimensions | null;
  requiredOutputType: RequiredOutputType;
  /**
   * Minimum acceptable production resolution for this method, in pixels per
   * inch. Only meaningful when `targetDimensions` is set and raster output
   * applies. Never treated as PNG DPI metadata — see `effective-resolution.ts`.
   */
  targetPpi: number | null;
  /** Derived minimum raster pixel dimensions (`targetDimensions` × `targetPpi`), when computable. */
  minRasterDimensionsPx: PixelDimensions | null;
  transparencyRequired: boolean;
  colorMode: ColorModeExpectation;
  /** Internal file kinds acceptable for final production — never a customer-facing format picker. */
  allowedFileFormats: string[];
  /** Simple safe-margin-from-edge guidance, expressed as a percent of the print area. */
  artworkBoundaryMarginPercent: number;
  requiredWordingVerificationRequired: boolean;
  /** Internal rationale trail — never customer-facing copy. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Print Validation Report (Goal 5)
// ---------------------------------------------------------------------------

export type PrintValidationStatus =
  | "ready"
  | "finalization_required"
  | "blocked";

export type PrintValidationCheckStatus =
  | "pass"
  | "warning"
  | "fail"
  | "unknown";

export type PrintValidationCheckSeverity = "info" | "warning" | "blocking";

export const PRINT_VALIDATION_CHECK_CODES = [
  "asset_exists",
  "content_type",
  "raster_dimensions_known",
  "transparency",
  "effective_resolution",
  "minimum_raster_dimensions",
  "vector_source",
  "brief_provenance",
  "concept_evaluation_alignment",
  "required_wording_verification",
  "print_location_known",
  "production_method_known",
  /**
   * Sprint 2M Phase 2C: info-only diagnostic recording whether
   * `effective_resolution`/`minimum_raster_dimensions` were judged against
   * the asset's literal pixel dimensions ("native") or its true pre-upscale
   * source dimensions ("interpolated_upscale"/"unknown") — never itself
   * blocking, since its effect already flows through those two checks.
   */
  "resolution_provenance",
] as const;

export type PrintValidationCheckCode =
  (typeof PRINT_VALIDATION_CHECK_CODES)[number];

export interface PrintValidationCheck {
  check: PrintValidationCheckCode;
  status: PrintValidationCheckStatus;
  severity: PrintValidationCheckSeverity;
  /** Internal rationale — never customer-facing copy (Goal 5, Goal 12). */
  reason: string;
}

/**
 * Provider-neutral description of a step the future Final Artwork /
 * Production Artwork capability would need to perform. Never executed here
 * — Print Validation determines the truth about what is required; it does
 * not transform, upscale, vectorize, or regenerate anything (Goal 9, Goal
 * 15, Goal 17).
 */
export const FINALIZATION_TRANSFORMATIONS = [
  "regenerate_at_production_dimensions",
  "upscale_raster_artwork",
  "remove_background",
  "create_vector_version",
  "verify_or_recreate_text",
  "convert_fonts_to_outlines",
  "resize_to_final_dimensions",
  "create_production_png",
  "create_vector_or_pdf_asset",
  "require_human_review",
] as const;

export type FinalizationTransformation =
  (typeof FINALIZATION_TRANSFORMATIONS)[number];

export interface PrintValidationReport {
  artworkVersionId: string;
  designBriefVersionId: string | null;
  status: PrintValidationStatus;
  requirements: ProductionRequirements;
  checks: PrintValidationCheck[];
  requiredTransformations: FinalizationTransformation[];
  /** Plain summaries of the checks that produced `status: "blocked"` or drove `finalization_required`. Internal only. */
  blockingIssues: string[];
  warnings: string[];
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Input (Goal 6 / Goal 11 / Goal 13)
// ---------------------------------------------------------------------------

/**
 * Sprint 2M Phase 2C — the "Upscaling Truthfulness" honesty mechanism.
 *
 * `widthPx`/`heightPx` describe the asset's actual, literal pixel
 * dimensions. Those are not, by themselves, trustworthy evidence of
 * production-quality detail: a 1024x1024 concept resized to 3600x3600 via
 * ordinary interpolation has 3600x3600 *pixels* without gaining any real
 * detail. `resolutionProvenance` records the difference so
 * `effective_resolution`/`minimum_raster_dimensions` checks can never be
 * fooled by pixel count alone (see `print-validation-capability.ts`'s use
 * of `nativeWidthPx`/`nativeHeightPx`):
 *
 *   - `"native"` — every pixel genuinely carries source detail (as-generated,
 *     or only ever downsized, never enlarged beyond native density). Checks
 *     may trust `widthPx`/`heightPx` directly.
 *   - `"interpolated_upscale"` — some or all of the asset's pixels were
 *     manufactured by resampling beyond the source's native density. Checks
 *     must evaluate sufficiency against `nativeWidthPx`/`nativeHeightPx`
 *     (the true pre-upscale source dimensions) instead, which — by
 *     definition of why an upscale was needed — will correctly fail to meet
 *     a target the native asset didn't already meet.
 *   - `"unknown"` — provenance was not determined. Treated exactly like
 *     `"interpolated_upscale"` for validation purposes (never assumed safe).
 */
export type ResolutionProvenance = "native" | "interpolated_upscale" | "unknown";

/**
 * Opaque, already-sanitized summary of the concept's primary generated
 * asset. Deliberately excludes `storageKey` and any other internal storage
 * detail — mirrors `ConceptEvaluationAssetReference` (Goal 13: no raw
 * storage keys, no provider metadata reaching this boundary).
 */
export interface PrintValidationAssetSummary {
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  /** Reserved: populated once a future Final Artwork capability produces a vector companion asset. Always `null` today. */
  vectorAssetId: string | null;
  /** See `ResolutionProvenance`'s doc. Provisional (concept-stage) validation always passes `"native"` — a generated concept is never itself a resize of anything. */
  resolutionProvenance: ResolutionProvenance;
  /**
   * The true, pre-transformation source pixel dimensions this asset's
   * detail is actually derived from. Only load-bearing when
   * `resolutionProvenance === "interpolated_upscale"` (or `"unknown"`);
   * ignored otherwise. `null` when not applicable/not known.
   */
  nativeWidthPx: number | null;
  nativeHeightPx: number | null;
}

/**
 * Everything `PrintValidationCapability.validateArtwork` needs, already
 * resolved by the caller. Print Validation itself never reads a repository
 * (Goal 16/17 — "PrintValidation should remain pure validation"), mirroring
 * `ConceptEvaluationCapability.evaluate`'s `ConceptEvaluationInput` pattern:
 * the caller (a future Final Artwork orchestrator, a route, or a test) does
 * the I/O; this capability only decides.
 */
export interface PrintValidationInput {
  artworkVersionId: string;
  /** The approved Design Brief version this concept claims to have been generated against. */
  designBriefVersionId: string | null;
  /** The design's current/latest approved Design Brief version id, for provenance comparison (Goal 6, Goal 14 Scenario H). */
  currentApprovedDesignBriefVersionId: string | null;
  /** Print placement from the approved brief snapshot that authorized this concept, when resolvable. */
  printPlacement: PrintPlacement | null;
  /** Free-text product description from the approved brief snapshot — used only for deterministic production-method inference (Goal 3). Never sent to a provider. */
  productSummary: string | null;
  designDescription: string | null;
  /** Concept Evaluation state already computed and persisted for this concept, if any (Goal 6, Goal 14 Scenario I). Read-only — never recomputed here. */
  conceptEvaluationStatus: ConceptEvaluationStatus | null;
  conceptEvaluation: ConceptEvaluation | null;
  /** `null` when no generated asset exists yet (Goal 14 Scenario G). */
  primaryAsset: PrintValidationAssetSummary | null;
}
