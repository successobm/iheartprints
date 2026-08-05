import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";

/**
 * Provider port for concept generation.
 * Domain and capabilities depend on this interface only — never concrete vendors.
 */
export interface ConceptGenerationProvider {
  readonly providerKey: string;
  generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult>;
}
