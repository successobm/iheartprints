/**
 * Sprint 2H Part 1A: server-side-only diagnostics for concept generation
 * configuration. Never called with — and never prints — API keys,
 * authorization headers, provider request bodies, or customer prompts.
 * Kept separate from `generation-provider-config.ts` so that module stays a
 * pure function with no console side effects.
 */

export interface DevelopmentFallbackLogDetails {
  requestedProvider: string;
  environment: string;
}

/** Sprint 1A: dev/test convenience fallback — never allowed in production (see `getConceptGenerationConfig`). */
export function logConceptGenerationDevelopmentFallback(
  details: DevelopmentFallbackLogDetails,
): void {
  console.warn(
    `[concept-generation] CONCEPT_GENERATION_PROVIDER=${details.requestedProvider} was requested but OPENAI_API_KEY is not set. ` +
      `Falling back to the placeholder provider for this ${details.environment} environment. ` +
      "This fallback is not available in production — see getConceptGenerationConfig.",
  );
}

export interface UnavailableConfigurationLogDetails {
  safeErrorCode: string;
  /** The provider that was requested but could not be used — never a secret. */
  intendedProvider: string;
  /**
   * Sprint 2H Part 1B: the same non-secret, plain-language reason carried on
   * `GenerationUnavailableError.message` — e.g. spells out that
   * `ASSET_STORAGE_MODE` is not a production-safe backend, not just the
   * `safeErrorCode`. Never includes an API key, request body, or prompt.
   */
  internalReason: string;
  environment: string;
  generationJobId?: string | null;
  projectId?: string | null;
}

/**
 * Structured log for the production-unsafe-configuration failure path.
 * Deliberately whitelists fields rather than spreading an error object, so
 * a future field added to an internal error type can never leak into logs
 * by accident.
 */
export function logConceptGenerationUnavailable(
  details: UnavailableConfigurationLogDetails,
): void {
  console.error("[concept-generation] configuration error", {
    safeErrorCode: details.safeErrorCode,
    provider: details.intendedProvider,
    internalReason: details.internalReason,
    environment: details.environment,
    generationJobId: details.generationJobId ?? null,
    projectId: details.projectId ?? null,
  });
}
