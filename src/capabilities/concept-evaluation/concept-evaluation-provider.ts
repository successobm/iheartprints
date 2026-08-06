import type {
  ConceptEvaluationRequest,
  ConceptEvaluationResult,
} from "./contracts";

/**
 * Provider port for concept evaluation.
 * Domain and capabilities depend on this interface only — never concrete vendors.
 *
 * Adapters must never receive customer ids, conversation ids, provider secrets,
 * repository handles, or generation job ids. Only the provider-neutral request.
 */
export interface ConceptEvaluationProvider {
  readonly providerKey: string;
  evaluate(
    request: ConceptEvaluationRequest,
  ): Promise<ConceptEvaluationResult>;
}
