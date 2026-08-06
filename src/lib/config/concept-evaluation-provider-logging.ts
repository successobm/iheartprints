/**
 * Sprint 2I Phase 2: server-side-only diagnostics for Concept Evaluation
 * configuration. Never called with — and never prints — API keys,
 * authorization headers, provider request bodies, prompts, provider
 * responses, or customer images. Kept separate from
 * `concept-evaluation-provider-config.ts` so that module stays a pure
 * function with no console side effects (same split as
 * `generation-provider-logging.ts`).
 */

export interface ConceptEvaluationFallbackLogDetails {
  requestedProvider: string;
  environment: string;
}

/**
 * Logged whenever `openai` evaluation was requested but could not be used
 * (missing `OPENAI_API_KEY`) and the deterministic placeholder evaluator is
 * used instead. Unlike concept generation's equivalent, this fallback is
 * safe in every environment — see `concept-evaluation-provider-config.ts`.
 */
export function logConceptEvaluationFallback(
  details: ConceptEvaluationFallbackLogDetails,
): void {
  console.warn(
    `[concept-evaluation] CONCEPT_EVALUATION_PROVIDER=${details.requestedProvider} was requested but OPENAI_API_KEY is not set. ` +
      `Falling back to the placeholder evaluator for this ${details.environment} environment. ` +
      "Evaluation is advisory-only, so no concept is affected — see getConceptEvaluationConfig.",
  );
}
