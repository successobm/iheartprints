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
 *
 * Sprint 2I Phase 2 boundary enforcement: before a result is treated as
 * persistable, `providerMetadata` is allowlisted and every persisted string
 * field is scrubbed of URLs so ephemeral `sourceUrl` values (and any other
 * http(s) links) cannot land in `ArtworkVersion.evaluation` /
 * `ProjectSnapshot`.
 */
export interface ConceptEvaluationCapability {
  evaluate(input: ConceptEvaluationInput): Promise<ConceptEvaluationResult>;
  /**
   * Maps a provider result into the persistable ArtworkVersion evaluation
   * fields. Sanitizes `providerMetadata` (allowlist only) and redacts URLs
   * from string fields. Never customer-facing copy.
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

/** Keys allowed on persisted `providerMetadata`. Everything else is dropped. */
const PROVIDER_METADATA_ALLOWLIST = new Set([
  "mode",
  "model",
  "assetCount",
  "hasRequiredWording",
  "hasStyle",
  "hasExclusions",
  "errorClass",
  "errorSummary",
]);

/** Matches http(s) URLs — used to scrub ephemeral signed URLs from persisted text. */
const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

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
      return normalizeResult({
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
          // Sanitized — never stack traces, secrets, or signed URLs.
          errorSummary: message.slice(0, 200),
        },
      });
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
        notes: redactUrls(found?.notes ?? null),
      };
    }),
    warnings: result.warnings.map((w) => redactUrls(w) ?? "").filter(Boolean),
    recommendations: result.recommendations
      .map((r) => redactUrls(r) ?? "")
      .filter(Boolean),
    missingRequirements: result.missingRequirements
      .map((r) => redactUrls(r) ?? "")
      .filter(Boolean),
    matchedRequirements: result.matchedRequirements
      .map((r) => redactUrls(r) ?? "")
      .filter(Boolean),
    providerMetadata: sanitizeProviderMetadata(result.providerMetadata),
  };
}

/**
 * Sprint 2I Phase 2: persist only known-safe, non-secret metadata keys.
 * Drops `sourceUrl` / URL-bearing values so ephemeral signed URLs cannot
 * reach ArtworkVersion.evaluation or ProjectSnapshot.
 */
function sanitizeProviderMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!PROVIDER_METADATA_ALLOWLIST.has(key)) continue;
    if (typeof value === "string") {
      const scrubbed = redactUrls(value);
      if (scrubbed !== null) sanitized[key] = scrubbed.slice(0, 200);
      continue;
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function redactUrls(value: string | null): string | null {
  if (value === null) return null;
  const scrubbed = value.replace(HTTP_URL_PATTERN, "[redacted]").trim();
  return scrubbed.length > 0 ? scrubbed : null;
}

function clampScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
}
