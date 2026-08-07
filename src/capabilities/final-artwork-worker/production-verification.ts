/**
 * Sprint 2M Phase 2E (Goal 7/9): independent production-asset verification.
 *
 * A reconstruction provider that cannot honestly declare
 * `preservesApprovedContent: true` (Sprint 2M Phase 2E's Topaz adapter never
 * does — see `provider.ts`'s doc) must never let the source concept's own
 * Concept Evaluation stand in for verification of the actual reconstructed
 * OUTPUT. This module re-runs the existing `ConceptEvaluationCapability` /
 * `ConceptEvaluationProvider` infrastructure — never a bespoke OCR
 * implementation — against the real production asset, compared against the
 * exact approved Design Brief snapshot tied to the `FinalDirectionApproval`
 * (never a newer, possibly-mutated working brief).
 *
 * This single re-evaluation serves two Phase 2E goals at once, deliberately
 * reusing one mechanism rather than inventing two:
 *   - Goal 7 (production required-wording verification) — the resulting
 *     `required_wording` criterion flows into
 *     `PrintValidationCapability`'s existing `required_wording_verification`
 *     check unchanged.
 *   - Goal 9 (design-fidelity / review escape hatch) — the resulting
 *     overall alignment / style / graphics / exclusions criteria flow into
 *     the existing `concept_evaluation_alignment` check, so a reconstruction
 *     that visibly redrew or lost content is caught the same way a
 *     misaligned generated concept always has been, without inventing a new
 *     "ArtworkFidelityEvaluationCapability" this sprint does not need yet.
 *     `needs_review`/`failed` here never provider-success-auto-passes —
 *     provider success (HTTP 200) is never confused with print readiness.
 *
 * Provider-neutral and safe by construction: when `ConceptEvaluationProvider`
 * resolves to the deterministic placeholder (the default, no
 * `OPENAI_API_KEY` configured), every criterion — including
 * `required_wording` — resolves `passed: null` ("not assessed"), which
 * `PrintValidationCapability.checkRequiredWordingVerification` already
 * treats as `"unknown"` → blocking → `finalization_required`. Nothing here
 * can ever fabricate a pass.
 */

import type { ConceptEvaluationCapability } from "@/capabilities/concept-evaluation";
import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";

export interface ProductionVerificationAsset {
  assetId: string;
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  /** Short-lived signed URL the provider adapter fetches itself — never a raw storage key (mirrors `ConceptEvaluationAssetReference`). `null` when one could not be minted; verification still proceeds and honestly resolves "not assessed". */
  sourceUrl: string | null;
}

export interface ProductionVerificationInput {
  /** The approved Design Brief snapshot tied to the FinalDirectionApproval — never a newer working brief (Goal 7). */
  brief: DesignBriefSnapshotContent;
  concept: {
    title: string;
    summary: string;
    placeholderLabel: string;
  };
  productionAsset: ProductionVerificationAsset;
  /** Deterministic identity for this verification attempt — the production asset id is already unique per job/attempt. */
  idempotencyKey: string;
}

export interface ProductionVerificationResult {
  evaluationStatus: ConceptEvaluationStatus;
  evaluation: ConceptEvaluation;
}

export async function verifyProductionArtwork(
  conceptEvaluation: ConceptEvaluationCapability,
  input: ProductionVerificationInput,
): Promise<ProductionVerificationResult> {
  let result;
  try {
    result = await conceptEvaluation.evaluate({
      brief: input.brief,
      concept: input.concept,
      assets: [
        {
          assetId: input.productionAsset.assetId,
          contentType: input.productionAsset.contentType,
          widthPx: input.productionAsset.widthPx,
          heightPx: input.productionAsset.heightPx,
          isThumbnail: false,
          sourceUrl: input.productionAsset.sourceUrl,
        },
      ],
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    // Never lets a provider failure crash the finalization job (mirrors
    // GenerationWorkerCapability's identical treatment of Concept
    // Evaluation failures) — an inconclusive result still honestly resolves
    // to `finalization_required` downstream, never a fabricated pass.
    result = conceptEvaluation.evaluationFailureFallback(error);
  }

  const persisted = conceptEvaluation.toPersistedEvaluation(result);
  return {
    evaluationStatus: persisted.evaluationStatus,
    evaluation: persisted.evaluation,
  };
}
