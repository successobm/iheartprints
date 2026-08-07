/**
 * Sprint 2M Phase 2E: mirrors `capabilities/providers/generation-unavailable-error.ts`
 * for the final-artwork provider boundary. Deliberately a plain literal
 * union — not imported from `@/lib/config/final-artwork-provider-config` —
 * so a capability-layer file never depends on the composition-layer config
 * module directly.
 */
export type FinalArtworkUnavailableSafeErrorCode =
  | "FINAL_ARTWORK_PROVIDER_NOT_CONFIGURED";

/**
 * Thrown by `UnavailableFinalArtworkProvider` when `FINAL_ARTWORK_PROVIDER`
 * requests a paid provider (topaz) that isn't actually usable (missing
 * `TOPAZ_API_KEY`). `safeErrorCode` is the only part of this ever meant to
 * travel further than a server log. `message` (the `internalReason`) is
 * non-secret and server-log-only — never the key itself, never shown to a
 * customer. `FinalArtworkWorkerCapability` treats this exactly like any
 * other infrastructure failure: the job fails (never `print_ready`), and is
 * retryable once configuration is fixed.
 */
export class FinalArtworkUnavailableError extends Error {
  readonly safeErrorCode: FinalArtworkUnavailableSafeErrorCode;
  readonly intendedProviderKey: string;

  constructor(
    safeErrorCode: FinalArtworkUnavailableSafeErrorCode,
    intendedProviderKey: string,
    internalReason: string,
  ) {
    super(internalReason);
    this.name = "FinalArtworkUnavailableError";
    this.safeErrorCode = safeErrorCode;
    this.intendedProviderKey = intendedProviderKey;
  }
}
