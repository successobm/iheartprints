import type { ConceptGenerationResult } from "@/capabilities/shared/contracts";
import type { ConceptGenerationProvider } from "./concept-generation-provider";
import {
  GenerationUnavailableError,
  type GenerationUnavailableSafeErrorCode,
} from "./generation-unavailable-error";

/**
 * Sprint 2H Part 1A: stands in for a real provider when configuration is
 * invalid in an environment that must not silently fall back to
 * placeholder concepts (production with `CONCEPT_GENERATION_PROVIDER=openai`
 * and no `OPENAI_API_KEY`). `generate()` always fails with a typed, safe
 * error — never placeholder concepts a customer could mistake for real
 * generated artwork. `ConceptGenerationCapability` recognizes
 * `GenerationUnavailableError` explicitly and handles it: the job is
 * created and marked failed, no concepts or assets are created, and the
 * customer sees a plain "temporarily unavailable" message.
 */
export class UnavailableConceptGenerationProvider
  implements ConceptGenerationProvider
{
  readonly providerKey = "unavailable";

  constructor(
    private readonly safeErrorCode: GenerationUnavailableSafeErrorCode,
    private readonly intendedProviderKey: string,
    private readonly internalReason: string,
  ) {}

  async generate(): Promise<ConceptGenerationResult> {
    throw new GenerationUnavailableError(
      this.safeErrorCode,
      this.intendedProviderKey,
      this.internalReason,
    );
  }
}
