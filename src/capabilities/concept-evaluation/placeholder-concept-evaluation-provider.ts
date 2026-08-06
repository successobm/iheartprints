import type { ConceptEvaluationCriterionScore } from "@/lib/domain/types";

import type { ConceptEvaluationProvider } from "./concept-evaluation-provider";
import {
  CONCEPT_EVALUATION_CRITERION_KEYS,
  type ConceptEvaluationRequest,
  type ConceptEvaluationResult,
} from "./contracts";

/**
 * Sprint 2I Phase 1: deterministic placeholder evaluator.
 *
 * Does not inspect pixels, run OCR, or call vision models. It records that
 * evaluation architecture ran and that automated brief-alignment scoring is
 * not yet implemented — every criterion is explicitly "not assessed", overall
 * status is `needs_review`. Replaceable by any future adapter behind
 * `ConceptEvaluationProvider`.
 */
export class PlaceholderConceptEvaluationProvider
  implements ConceptEvaluationProvider
{
  readonly providerKey = "placeholder_concept_evaluation";

  async evaluate(
    request: ConceptEvaluationRequest,
  ): Promise<ConceptEvaluationResult> {
    const criteria: ConceptEvaluationCriterionScore[] =
      CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
        key,
        score: null,
        passed: null,
        confidence: 0,
        notes: "not_assessed",
      }));

    return {
      overallScore: null,
      passed: null,
      confidence: 0,
      status: "needs_review",
      criteria,
      warnings: [
        "Automated concept evaluation is not yet implemented; concept retained for customer review.",
      ],
      recommendations: [],
      missingRequirements: [],
      matchedRequirements: [],
      providerMetadata: {
        mode: "placeholder",
        assetCount: request.assets.length,
        hasRequiredWording: Boolean(request.brief.exactText?.trim()),
        hasStyle: Boolean(request.brief.designStyle?.trim()),
        hasExclusions: Boolean(request.brief.exclusions?.trim()),
      },
    };
  }
}
