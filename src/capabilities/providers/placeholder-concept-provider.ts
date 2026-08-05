import { buildPlaceholderConcepts } from "@/lib/domain/concepts";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ConceptGenerationProvider } from "./concept-generation-provider";

/**
 * Sprint 1 / 2C placeholder adapter, updated in Sprint 2H Part 1 to take the
 * same provider-neutral `GenerationPromptRequest` a real provider does
 * (rather than re-fetching the brief itself) — it is now a pure function of
 * its request, with no repository or Design Brief access, exactly like any
 * other provider adapter. No external AI provider. Translates the prompt
 * request into concept card drafts only.
 */
export class PlaceholderConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "placeholder";

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    const seeds = buildPlaceholderConcepts(request.prompt).slice(
      0,
      request.conceptCount,
    );

    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: seeds.map((seed) => ({
        ...seed,
        kind: "concept" as const,
      })),
    };
  }
}
