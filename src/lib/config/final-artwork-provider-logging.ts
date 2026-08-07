/**
 * Sprint 2M Phase 2E: server-side-only diagnostics for final-artwork
 * provider configuration. Never called with — and never prints —
 * `TOPAZ_API_KEY`, signed storage URLs, or raw provider response bodies.
 * Kept separate from `final-artwork-provider-config.ts` so that module
 * stays a pure function with no console side effects (mirrors
 * `generation-provider-logging.ts`).
 */

export interface FinalArtworkProviderUnavailableLogDetails {
  safeErrorCode: string;
  /** The provider that was requested but could not be used — never a secret. */
  intendedProvider: string;
  /** Non-secret, plain-language reason — never the key itself. */
  internalReason: string;
  projectId?: string | null;
  finalArtworkJobId?: string | null;
}

/**
 * Structured log for the "a paid provider was requested but is not usable"
 * path. Deliberately whitelists fields rather than spreading an error
 * object, so a future field added to an internal config type can never leak
 * into logs by accident.
 */
export function logFinalArtworkProviderUnavailable(
  details: FinalArtworkProviderUnavailableLogDetails,
): void {
  console.error("[final-artwork] provider configuration error", {
    safeErrorCode: details.safeErrorCode,
    provider: details.intendedProvider,
    internalReason: details.internalReason,
    projectId: details.projectId ?? null,
    finalArtworkJobId: details.finalArtworkJobId ?? null,
  });
}
