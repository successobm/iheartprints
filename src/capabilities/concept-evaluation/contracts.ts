/**
 * Sprint 2I Phase 1: provider-neutral Concept Evaluation contracts.
 *
 * Concept Evaluation answers whether a generated concept matches the
 * approved Design Brief. It is deliberately separate from Print Validation
 * (DPI, transparency, raster quality, embroidery limits, etc.).
 *
 * These contracts are pure data. Providers receive/return them; they never
 * write repositories, mutate briefs, or invent customer-facing copy.
 */

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";
import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
} from "@/lib/domain/types";

/**
 * Opaque asset references a provider may use to fetch bytes via its own
 * adapter wiring. Never includes storage keys, signed URLs, customer ids,
 * conversation ids, generation job ids, or repository handles.
 */
export interface ConceptEvaluationAssetReference {
  assetId: string;
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  isThumbnail: boolean;
}

/**
 * Provider-neutral evaluation request. Built by ConceptEvaluationCapability
 * from an approved brief snapshot + concept metadata + asset references.
 */
export interface ConceptEvaluationRequest {
  /** Frozen approved Design Brief snapshot content — never a working brief. */
  brief: DesignBriefSnapshotContent;
  /** Concept presentation fields already persisted on ArtworkVersion. */
  concept: {
    title: string;
    summary: string;
    placeholderLabel: string;
  };
  assets: ConceptEvaluationAssetReference[];
  /**
   * Deterministic identity for this evaluation attempt (typically
   * artworkVersionId + brief version id). Providers may use it to dedupe;
   * the platform also guards duplicate persistence.
   */
  idempotencyKey: string;
}

/**
 * What a ConceptEvaluationProvider returns. Includes internal-only
 * `providerMetadata`. Capability orchestration strips/sanitizes before
 * persistence and never forwards provider-specific payloads to customers.
 */
export interface ConceptEvaluationResult {
  overallScore: number | null;
  /** null when the provider could not determine pass/fail (e.g. placeholder). */
  passed: boolean | null;
  confidence: number;
  status: ConceptEvaluationStatus;
  criteria: ConceptEvaluation["criteria"];
  warnings: string[];
  recommendations: string[];
  missingRequirements: string[];
  matchedRequirements: string[];
  /** Internal only — never customer-facing. */
  providerMetadata: Record<string, unknown>;
}

/** Persistable slice of an evaluation result (no raw provider dialect). */
export type PersistedConceptEvaluation = ConceptEvaluation;

export const CONCEPT_EVALUATION_CRITERION_KEYS = [
  "required_wording",
  "style",
  "graphics",
  "color_palette",
  "product_compatibility",
  "composition",
  "readability",
  "exclusions",
  "overall_alignment",
] as const;

export const CONCEPT_EVALUATION_STATUSES = [
  "pending",
  "passed",
  "needs_review",
  "failed",
] as const;
