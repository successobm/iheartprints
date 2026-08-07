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
  | "unknown"
  /**
   * Sprint 2M Phase 2E: the provider rejected the configured credentials
   * (e.g. Topaz HTTP 401/403). Never retried, never logs the credential
   * itself — the message must stay generic.
   */
  | "auth"
  /**
   * Sprint 2M Phase 2E: the provider account cannot afford this paid
   * request (e.g. Topaz HTTP 412). Never retried — retrying an
   * insufficient-credits failure only wastes time and cannot succeed until
   * an operator adds credit.
   */
  | "insufficient_credits"
  /**
   * Sprint 2M Phase 2E: an in-flight or previously-submitted paid request
   * reached a terminal failure state at the provider itself (e.g. Topaz's
   * own job status becomes "Failed"/"Cancelled"). Distinct from every other
   * classification here because it is the one signal that makes it safe —
   * and correct — for a caller to discard a persisted `providerRequestId`
   * and allow a fresh paid submission on the next retry (the old request is
   * provably dead, so resuming it again would never succeed).
   */
  | "provider_job_failed"
  /**
   * Sprint 2M Phase 2E: bounded polling exceeded its time budget without
   * the provider reaching a terminal state. Never retried automatically —
   * but a persisted `providerRequestId` is NOT discarded for this
   * classification, since the provider may still complete the work
   * server-side; a later retry should resume polling the same request
   * rather than submitting a duplicate paid one.
   */
  | "timeout";

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
