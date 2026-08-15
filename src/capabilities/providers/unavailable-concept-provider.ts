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
  /** Never generates anything — every call throws before any image work. */
  readonly editsSourceArtwork = false;

  constructor(
    private readonly safeErrorCode: GenerationUnavailableSafeErrorCode,
    private readonly intendedProviderKey: string,
    private readonly internalReason: string,
  ) {}

  /**
   * Sprint A4 Correction 3: this adapter is the canonical "local
   * configuration is wrong" case, so it is the one that most needs to fail
   * BEFORE a physical dispatch is claimed.
   *
   * Throws the identical error `generate` would have thrown — deliberately
   * the same failure, just moved to the side of the paid boundary where it
   * belongs. Nothing here contacts anything; there is nothing to contact.
   */
  async assertReadyToDispatch(): Promise<void> {
    throw this.unavailable();
  }

  async generate(): Promise<ConceptGenerationResult> {
    // Still throws, and must keep throwing: preflight is a courtesy that
    // moves the failure earlier, never the only thing standing between a
    // misconfigured deployment and a fabricated concept.
    throw this.unavailable();
  }

  private unavailable(): GenerationUnavailableError {
    return new GenerationUnavailableError(
      this.safeErrorCode,
      this.intendedProviderKey,
      this.internalReason,
    );
  }
}
