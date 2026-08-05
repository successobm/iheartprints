/**
 * Sprint 2H Part 1B: widened to also cover a production-unsafe asset
 * storage backend (`PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED`) alongside the
 * original missing-provider-credential case. Deliberately a plain literal
 * union — not imported from `@/lib/config/generation-provider-config` —
 * so a capability-layer file never depends on the composition-layer config
 * module directly; the two are kept structurally identical by hand, the
 * same way `resolveConceptGenerationProvider` already bridges the two
 * layers today.
 */
export type GenerationUnavailableSafeErrorCode =
  | "GENERATION_PROVIDER_NOT_CONFIGURED"
  | "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED"
  /**
   * Sprint 2H Part 2A: real provider generation is intentionally kept off
   * — regardless of how well everything else is configured — until this
   * sprint's background job / storage pipeline has been fully verified.
   * See `resolveConceptGenerationProvider` and `CONCEPT_GENERATION_ENABLE_REAL`.
   */
  | "REAL_GENERATION_NOT_YET_ENABLED";

/**
 * Sprint 2H Part 1A: thrown by `UnavailableConceptGenerationProvider` when
 * production configuration is invalid. `safeErrorCode` is the only part of
 * this ever meant to travel further than a server log — it identifies the
 * failure class without any provider/key detail. `message` (the
 * `internalReason`) is non-secret and server-log-only; it is never shown to
 * a customer.
 */
export class GenerationUnavailableError extends Error {
  readonly safeErrorCode: GenerationUnavailableSafeErrorCode;
  /** The provider that was requested but could not be used. Never a secret. */
  readonly intendedProviderKey: string;

  constructor(
    safeErrorCode: GenerationUnavailableSafeErrorCode,
    intendedProviderKey: string,
    internalReason: string,
  ) {
    super(internalReason);
    this.name = "GenerationUnavailableError";
    this.safeErrorCode = safeErrorCode;
    this.intendedProviderKey = intendedProviderKey;
  }
}
