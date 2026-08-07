/**
 * Sprint 2M Phase 2A: pure mapping from already-resolved domain data into
 * `PrintValidationInput`. Zero I/O — takes plain values the orchestration
 * layer (`GenerationWorkerCapability`) already has in scope, never a
 * repository, provider, or storage handle. This keeps the "which fields
 * matter" knowledge cohesive with `PrintValidationCapability`'s own
 * contract while the capability itself stays exactly as pure as Phase 1
 * left it (Goal 2 — "PrintValidationCapability only evaluates that input").
 */

import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";

import type {
  PrintValidationAssetSummary,
  PrintValidationInput,
  ResolutionProvenance,
} from "./contracts";

/** Only the fields `PrintValidationAssetSummary` actually needs — never a raw `AssetRecord`/`storageKey`. */
export interface ProvisionalAssetSummaryInput {
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
}

export interface AssembleProvisionalPrintValidationInputParams {
  artworkVersionId: string;
  /** The approved Design Brief version this concept was generated against. */
  designBriefVersionId: string;
  /** The design's current/latest approved Design Brief version id, resolved by the caller. */
  currentApprovedDesignBriefVersionId: string | null;
  /** Frozen brief snapshot content the concept was generated against. */
  brief: DesignBriefSnapshotContent;
  /** `null` when no real image bytes exist (e.g. the placeholder provider). */
  asset: ProvisionalAssetSummaryInput | null;
  conceptEvaluationStatus: ConceptEvaluationStatus | null;
  conceptEvaluation: ConceptEvaluation | null;
}

/**
 * Builds a `PrintValidationInput` for **provisional** print-readiness
 * intelligence on a just-generated (or just-evaluated) concept. Never
 * implies the concept is final production artwork — see
 * ARCHITECTURE.md's "Provisional Print Readiness" section.
 */
export function assembleProvisionalPrintValidationInput(
  params: AssembleProvisionalPrintValidationInputParams,
): PrintValidationInput {
  const primaryAsset: PrintValidationAssetSummary | null = params.asset
    ? {
        contentType: params.asset.contentType,
        widthPx: params.asset.widthPx,
        heightPx: params.asset.heightPx,
        hasTransparency: params.asset.hasTransparency,
        // Phase 2A never produces a vector companion asset.
        vectorAssetId: null,
        // Sprint 2M Phase 2C: a generated concept is never itself a resize
        // of anything — its pixels are always genuinely as-produced by the
        // provider. Provisional validation therefore always trusts the
        // literal dimensions directly; only a production-asset validation
        // (see `assembleAuthoritativeProductionPrintValidationInput`) can
        // ever carry `"interpolated_upscale"`.
        resolutionProvenance: "native",
        nativeWidthPx: params.asset.widthPx,
        nativeHeightPx: params.asset.heightPx,
      }
    : null;

  return {
    artworkVersionId: params.artworkVersionId,
    designBriefVersionId: params.designBriefVersionId,
    currentApprovedDesignBriefVersionId: params.currentApprovedDesignBriefVersionId,
    printPlacement: params.brief.printPlacement,
    productSummary: params.brief.productSummary,
    designDescription: params.brief.designDescription,
    conceptEvaluationStatus: params.conceptEvaluationStatus,
    conceptEvaluation: params.conceptEvaluation,
    primaryAsset,
  };
}

/** Only the fields a production-asset validation actually needs — never a raw `AssetRecord`/`storageKey`. */
export interface ProductionAssetSummaryInput {
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  resolutionProvenance: ResolutionProvenance;
  nativeWidthPx: number | null;
  nativeHeightPx: number | null;
}

export interface AssembleAuthoritativeProductionPrintValidationInputParams {
  artworkVersionId: string;
  /** The approved Design Brief version the source concept was generated against, and this production asset was built from. */
  designBriefVersionId: string;
  /** The design's current/latest approved Design Brief version id, resolved by the caller. */
  currentApprovedDesignBriefVersionId: string | null;
  /** Frozen brief snapshot content the source concept — and this production asset — was built against. */
  brief: DesignBriefSnapshotContent;
  /** The real production asset just created. Never `null` — a validation run with no asset has nothing to validate. */
  asset: ProductionAssetSummaryInput;
  /**
   * Sprint 2M Phase 2C (Goal 8): required-wording verification for the
   * *production* asset. Reuses Concept Evaluation's already-persisted
   * `required_wording` criterion only when the caller has confirmed the
   * production transformation was content-preserving (a pure geometric
   * resample of the exact same source pixels — never a provider
   * regeneration that could redraw text). `FinalArtworkWorkerCapability` is
   * responsible for that confirmation; this function only assembles what
   * it's given.
   */
  conceptEvaluationStatus: ConceptEvaluationStatus | null;
  conceptEvaluation: ConceptEvaluation | null;
}

/**
 * Builds a `PrintValidationInput` for **authoritative** Print Validation
 * against a real production asset (Sprint 2M Phase 2C, Goal 11). Distinct
 * from `assembleProvisionalPrintValidationInput` only in *what* it
 * validates (a would-be finished production asset vs. an as-generated
 * concept) — see ARCHITECTURE.md's "Provisional Print Readiness vs. Final
 * Print Validation" for why that is the only difference that matters.
 */
export function assembleAuthoritativeProductionPrintValidationInput(
  params: AssembleAuthoritativeProductionPrintValidationInputParams,
): PrintValidationInput {
  const primaryAsset: PrintValidationAssetSummary = {
    contentType: params.asset.contentType,
    widthPx: params.asset.widthPx,
    heightPx: params.asset.heightPx,
    hasTransparency: params.asset.hasTransparency,
    // Phase 2C never produces a vector companion asset (Goal 17 — raster
    // apparel PNG only).
    vectorAssetId: null,
    resolutionProvenance: params.asset.resolutionProvenance,
    nativeWidthPx: params.asset.nativeWidthPx,
    nativeHeightPx: params.asset.nativeHeightPx,
  };

  return {
    artworkVersionId: params.artworkVersionId,
    designBriefVersionId: params.designBriefVersionId,
    currentApprovedDesignBriefVersionId: params.currentApprovedDesignBriefVersionId,
    printPlacement: params.brief.printPlacement,
    productSummary: params.brief.productSummary,
    designDescription: params.brief.designDescription,
    conceptEvaluationStatus: params.conceptEvaluationStatus,
    conceptEvaluation: params.conceptEvaluation,
    primaryAsset,
  };
}
