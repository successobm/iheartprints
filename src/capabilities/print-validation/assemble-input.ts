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

import type { PrintPlacement } from "@/lib/domain/types";

import type {
  PrintValidationAssetSummary,
  PrintValidationInput,
  ProductionNormalizationSummary,
  ResolutionProvenance,
  UploadedPreserveEvidence,
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
  /**
   * Live Acceptance Cleanup (Issue 5): the customer's chosen production
   * print width, in inches. `null`/omitted resolves to the placement
   * default. Passed through verbatim — this module never derives size.
   */
  intendedPrintWidthIn?: number | null;
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
    intendedPrintWidthIn: params.intendedPrintWidthIn ?? null,
    primaryAsset,
    // A generated concept has not been normalized for production at all —
    // never claim production geometry for it (Print-Ready Normalization
    // Phase 1).
    productionNormalization: null,
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
  /**
   * Live Acceptance Cleanup (Issue 5): the customer's chosen production
   * print width, in inches — the SAME value the production transform was
   * sized from. Authoritative validation must judge the plate against the
   * size actually intended, never the placement default.
   */
  intendedPrintWidthIn?: number | null;
  /**
   * Print-Ready Normalization Phase 1: what the production transform actually
   * did to produce this plate. REQUIRED for an authoritative production
   * validation — `print_ready` means "the normalized artwork itself is
   * production-ready", which cannot be decided without the plate's own
   * measured geometry.
   */
  normalization: ProductionNormalizationSummary;
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
    intendedPrintWidthIn: params.intendedPrintWidthIn ?? null,
    primaryAsset,
    productionNormalization: params.normalization,
  };
}

export interface AssembleUploadedPreserveProductionPrintValidationInputParams {
  /** The approved prepared `ArtworkVersion` (`kind: "prepared_upload"`) this plate was produced from. */
  artworkVersionId: string;
  /**
   * Production context the customer stated in the upload flow. Deliberately
   * NOT a `DesignBriefSnapshotContent`: no approved brief version authorizes
   * uploaded artwork, and passing a frozen snapshot here would imply one
   * exists. Only the fields production-method inference actually reads.
   */
  printPlacement: PrintPlacement | null;
  productSummary: string | null;
  /** The production width this plate was sized from, in inches — the job's own frozen intent, never the live working brief. */
  intendedPrintWidthIn: number | null;
  asset: ProductionAssetSummaryInput;
  normalization: ProductionNormalizationSummary;
  uploadedPreserve: UploadedPreserveEvidence;
}

/**
 * Existing Artwork → Print Ready Phase 2: builds an **authoritative**
 * `PrintValidationInput` for a production plate made from artwork the
 * CUSTOMER supplied and approved.
 *
 * Separate from `assembleAuthoritativeProductionPrintValidationInput` rather
 * than a flag on it, because the two genuinely differ in what they are given,
 * not merely in how it is judged: there is no `designBriefVersionId`, no
 * `currentApprovedDesignBriefVersionId`, no Concept Evaluation, and no
 * `designDescription` — because none of those exist for uploaded artwork. A
 * shared function with five nulls threaded through it would invite exactly
 * the mistake this split prevents (quietly passing a stale brief version, or
 * a Concept Evaluation belonging to some other artwork, and having the
 * checks silently believe it).
 */
export function assembleUploadedPreserveProductionPrintValidationInput(
  params: AssembleUploadedPreserveProductionPrintValidationInputParams,
): PrintValidationInput {
  return {
    artworkVersionId: params.artworkVersionId,
    validationProfile: "uploaded_preserve",
    uploadedPreserve: params.uploadedPreserve,
    // No Design Brief version authorizes uploaded artwork — see
    // `ArtworkPreparationCapability.approvePreparedArtwork`, which leaves
    // `ArtworkVersion.designBriefVersionId` null for the same reason.
    designBriefVersionId: null,
    currentApprovedDesignBriefVersionId: null,
    printPlacement: params.printPlacement,
    productSummary: params.productSummary,
    // The pixels ARE the design. A written description of uploaded artwork
    // would be a second, competing source of truth about it (see
    // `capability-boundaries.ts`), so nothing supplies one here.
    designDescription: null,
    conceptEvaluationStatus: null,
    conceptEvaluation: null,
    intendedPrintWidthIn: params.intendedPrintWidthIn,
    primaryAsset: {
      contentType: params.asset.contentType,
      widthPx: params.asset.widthPx,
      heightPx: params.asset.heightPx,
      hasTransparency: params.asset.hasTransparency,
      vectorAssetId: null,
      resolutionProvenance: params.asset.resolutionProvenance,
      nativeWidthPx: params.asset.nativeWidthPx,
      nativeHeightPx: params.asset.nativeHeightPx,
    },
    productionNormalization: params.normalization,
  };
}
