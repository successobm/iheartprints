import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";

import type { ConceptEvaluationProvider } from "./concept-evaluation-provider";
import type {
  ConceptEvaluationAssetReference,
  ConceptEvaluationRequest,
  ConceptEvaluationResult,
  PersistedConceptEvaluation,
} from "./contracts";
import { CONCEPT_EVALUATION_CRITERION_KEYS } from "./contracts";

export interface ConceptEvaluationInput {
  brief: DesignBriefSnapshotContent;
  concept: {
    title: string;
    summary: string;
    placeholderLabel: string;
  };
  assets: ConceptEvaluationAssetReference[];
  idempotencyKey: string;
}

/**
 * Sprint 2I Phase 1: orchestrates Concept Evaluation against an approved
 * Design Brief. Provider-neutral — never knows OpenAI, GPT, Vision, or any
 * vendor API. Never writes repositories, mutates briefs, or produces
 * customer-facing copy. Persistence is the caller's responsibility
 * (GenerationWorkerCapability).
 */
export interface ConceptEvaluationCapability {
  evaluate(input: ConceptEvaluationInput): Promise<ConceptEvaluationResult>;
  /**
   * Maps a provider result into the persistable ArtworkVersion evaluation
   * fields. Strips nothing structural; `providerMetadata` stays internal on
   * the persisted payload (never rendered as customer copy).
   */
  toPersistedEvaluation(result: ConceptEvaluationResult): {
    evaluation: PersistedConceptEvaluation;
    evaluationStatus: ConceptEvaluationStatus;
    evaluationProviderKey: string;
  };
  /** Deterministic fallback when a provider throws — never discards concepts. */
  evaluationFailureFallback(error: unknown): ConceptEvaluationResult;
  readonly providerKey: string;
}

export function createConceptEvaluationCapability(
  provider: ConceptEvaluationProvider,
): ConceptEvaluationCapability {
  return {
    get providerKey() {
      return provider.providerKey;
    },

    async evaluate(input) {
      const request: ConceptEvaluationRequest = {
        brief: input.brief,
        concept: input.concept,
        assets: input.assets,
        idempotencyKey: input.idempotencyKey,
      };
      const result = await provider.evaluate(request);
      return normalizeResult(result);
    },

    toPersistedEvaluation(result) {
      const normalized = normalizeResult(result);
      const evaluation: ConceptEvaluation = {
        overallScore: normalized.overallScore,
        passed: normalized.passed,
        confidence: normalized.confidence,
        criteria: normalized.criteria,
        warnings: normalized.warnings,
        recommendations: normalized.recommendations,
        missingRequirements: normalized.missingRequirements,
        matchedRequirements: normalized.matchedRequirements,
        providerMetadata: normalized.providerMetadata,
      };
      return {
        evaluation,
        evaluationStatus: normalized.status,
        evaluationProviderKey: provider.providerKey,
      };
    },

    evaluationFailureFallback(error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "unknown")
          : "unknown";
      return {
        overallScore: null,
        passed: null,
        confidence: 0,
        status: "needs_review",
        criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
          key,
          score: null,
          passed: null,
          confidence: 0,
          notes: "evaluation_provider_error",
        })),
        warnings: [
          "Concept evaluation provider failed; concept retained for customer review.",
        ],
        recommendations: [],
        missingRequirements: [],
        matchedRequirements: [],
        providerMetadata: {
          mode: "failure_fallback",
          errorClass: error instanceof Error ? error.name : "unknown",
          // Sanitized — never stack traces or secrets.
          errorSummary: message.slice(0, 200),
        },
      };
    },
  };
}

function normalizeResult(result: ConceptEvaluationResult): ConceptEvaluationResult {
  const confidence = clampScore(result.confidence) ?? 0;
  const overallScore = clampScore(result.overallScore);
  return {
    ...result,
    confidence,
    overallScore,
    criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => {
      const found = result.criteria.find((c) => c.key === key);
      return {
        key,
        score: clampScore(found?.score ?? null),
        passed: found?.passed ?? null,
        confidence: clampScore(found?.confidence ?? 0) ?? 0,
        notes: found?.notes ?? null,
      };
    }),
    warnings: [...result.warnings],
    recommendations: [...result.recommendations],
    missingRequirements: [...result.missingRequirements],
    matchedRequirements: [...result.matchedRequirements],
    providerMetadata: { ...result.providerMetadata },
  };
}

function clampScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
}
