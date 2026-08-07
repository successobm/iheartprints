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

import type { PrintValidationAssetSummary, PrintValidationInput } from "./contracts";

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
