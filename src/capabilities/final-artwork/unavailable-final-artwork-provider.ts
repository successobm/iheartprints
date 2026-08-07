import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "./provider";
import {
  FinalArtworkUnavailableError,
  type FinalArtworkUnavailableSafeErrorCode,
} from "./final-artwork-unavailable-error";

/**
 * Sprint 2M Phase 2E: stands in for a real provider when
 * `FINAL_ARTWORK_PROVIDER=topaz` is requested but not actually usable
 * (missing `TOPAZ_API_KEY`). `produce()` always fails with a typed, safe
 * error — never silently falls back to local interpolation and lets that be
 * mistaken for equivalent production quality (Goal 16). Mirrors
 * `UnavailableConceptGenerationProvider`'s shape exactly.
 */
export class UnavailableFinalArtworkProvider implements FinalArtworkProvider {
  readonly providerKey = "unavailable";

  constructor(
    private readonly safeErrorCode: FinalArtworkUnavailableSafeErrorCode,
    private readonly intendedProviderKey: string,
    private readonly internalReason: string,
  ) {}

  async produce(_input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    throw new FinalArtworkUnavailableError(
      this.safeErrorCode,
      this.intendedProviderKey,
      this.internalReason,
    );
  }
}
