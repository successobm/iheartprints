/**
 * Sprint 2H Part 1: a customer-safe classification of a generation
 * provider failure. Messages here are plain, non-technical, and never
 * contain the provider's raw error text, request payload, or credentials —
 * they are also used as the `GenerationJob.lastError` value, which stays
 * internal but should still never leak a secret if ever logged.
 */
export type ProviderErrorClassification =
  | "network"
  | "rate_limited"
  | "unavailable"
  | "malformed_response"
  | "unknown";

export class ProviderError extends Error {
  readonly classification: ProviderErrorClassification;

  constructor(classification: ProviderErrorClassification, message: string) {
    super(message);
    this.name = "ProviderError";
    this.classification = classification;
  }
}

/** Transient failures worth retrying; malformed responses and unknown errors are not. */
export function isRetryableProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.classification === "network" ||
      error.classification === "rate_limited" ||
      error.classification === "unavailable")
  );
}
