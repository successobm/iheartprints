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
  | "timeout"
  /**
   * True Source-Image Targeted Revision: the platform asked this provider
   * for something it cannot honestly perform — specifically, a targeted
   * revision with no source artwork image attached. Never retried (retrying
   * an incomplete request cannot make it complete) and never degraded into
   * a different operation: the whole point is that a revision without its
   * source image must fail rather than silently become a fresh
   * text-to-image generation.
   */
  | "invalid_request";

/**
 * Phase 2C0.5 (§6): how much the HTTP stack can HONESTLY say about whether
 * a failed paid request ever reached the provider — and therefore about
 * whether retrying it risks paying twice.
 *
 * This is deliberately a separate axis from `ProviderErrorClassification`.
 * "Why did it fail" and "could it already have been billed" are different
 * questions, and the same classification can answer the second one
 * differently: a `network` failure at DNS resolution provably never
 * dispatched, while a `network` failure mid-response provably did.
 *
 *   "not_dispatched"       No request reached the provider. Retrying cannot
 *                          double-bill. Bounded retry is safe.
 *   "dispatched_ambiguous" The request left this process and the outcome is
 *                          unknown. The provider may or may not have
 *                          produced (and billed) an image. NEVER blindly
 *                          retried — a re-dispatch is a knowingly-bounded
 *                          spend decision made one level up, by the paid
 *                          intent layer.
 *   "dispatched_billed"    The provider returned a success status we could
 *                          not use (e.g. HTTP 200 with an empty/malformed
 *                          body). Treat as billed. Never retried at the
 *                          transport layer — an unusable success that
 *                          retries in a loop is the most expensive possible
 *                          failure mode.
 *
 * Nothing here claims certainty `fetch` cannot provide: anything not
 * provably pre-dispatch is classified ambiguous, not safe.
 */
export type ProviderDispatchState =
  | "not_dispatched"
  | "dispatched_ambiguous"
  | "dispatched_billed";

export class ProviderError extends Error {
  readonly classification: ProviderErrorClassification;
  /**
   * Phase 2C0.5. Defaults to the conservative reading for the given
   * classification (see `defaultDispatchState`) so every existing call site
   * stays valid and none of them silently become "safe to retry".
   */
  readonly dispatch: ProviderDispatchState;
  /**
   * "Fix Topaz Resume/Download Failure" — an OPTIONAL, free-text label for
   * which step of a provider's own pipeline raised this (e.g. `"submit"`,
   * `"poll"`, `"download"`). Purely additive/diagnostic: `undefined` for
   * every existing call site that does not set it (nothing changes for
   * them), and never itself affects `classification`/`dispatch`/retry
   * behavior. Exists so a failure log can say WHERE in a multi-step
   * provider pipeline something broke without callers having to parse
   * `message` text to find out — see `describeFinalArtworkError`'s doc
   * comment: `message` is internal-only (never customer-facing), but a
   * structured field is still more useful for logging than string-parsing
   * it back out.
   */
  readonly stage?: string;

  constructor(
    classification: ProviderErrorClassification,
    message: string,
    dispatch?: ProviderDispatchState,
    stage?: string,
  ) {
    super(message);
    this.name = "ProviderError";
    this.classification = classification;
    this.dispatch = dispatch ?? defaultDispatchState(classification);
    this.stage = stage;
  }
}

/**
 * The safe reading of a classification when a caller does not state the
 * dispatch state explicitly.
 *
 * Everything the platform refuses to send, or that the provider rejected
 * before doing any work, is `not_dispatched`. Anything that could plausibly
 * have reached — and been charged by — the provider defaults to ambiguous.
 */
function defaultDispatchState(
  classification: ProviderErrorClassification,
): ProviderDispatchState {
  switch (classification) {
    // Never left this process, or was rejected by the provider before it
    // did any billable work.
    case "invalid_request":
    case "auth":
    case "insufficient_credits":
    case "rate_limited":
      return "not_dispatched";
    // A success status we could not consume — assume it was billed.
    case "malformed_response":
      return "dispatched_billed";
    // Everything else: the request may have reached the provider and the
    // stack cannot prove otherwise.
    default:
      return "dispatched_ambiguous";
  }
}

/**
 * Phase 2C0.5: transport-level retry is now allowed ONLY for failures that
 * provably never reached the provider.
 *
 * Before this phase every `network`/`rate_limited`/`unavailable` failure was
 * retried up to three times regardless of whether the request had already
 * been dispatched — so a single 5xx after a successful (billable) image
 * generation could pay for the same image three times over.
 *
 * A dispatched-but-ambiguous failure is not "not retryable" in the sense of
 * being hopeless; it is not retryable HERE. The decision to spend again on
 * the same logical image belongs to the paid-intent layer, which has a
 * durable, cross-worker dispatch budget (`MAX_PAID_DISPATCHES_PER_INTENT`)
 * — the transport layer has only a local loop counter that resets on every
 * reclaim, which is exactly why it must not be the thing deciding.
 */
export function isRetryableProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.dispatch === "not_dispatched" &&
    (error.classification === "network" ||
      error.classification === "rate_limited" ||
      error.classification === "unavailable")
  );
}

/**
 * Phase 2C0.5: whether this failure means a paid image may already have
 * been produced and charged for. Used by the paid-intent layer to decide
 * whether a re-dispatch is a bounded, knowingly-accepted spend risk.
 */
export function isPossiblyBilledProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderError && error.dispatch !== "not_dispatched"
  );
}

/**
 * Phase 2C0.5: classifies a `fetch` rejection into a dispatch state.
 *
 * Undici surfaces the underlying cause on `error.cause.code`. Only codes
 * that can ONLY occur before any bytes of the request were accepted by a
 * remote peer are treated as provably pre-dispatch — DNS resolution
 * failures, refused connections, and unreachable networks. A reset,
 * timeout, or aborted socket can all happen after the request was fully
 * sent (and after the provider began billable work), so they stay
 * ambiguous, as does anything unrecognized.
 */
const PROVABLY_PRE_DISPATCH_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_INVALID_URL",
]);

export function classifyFetchRejectionDispatch(
  error: unknown,
): ProviderDispatchState {
  const code = extractErrorCode(error);
  if (code && PROVABLY_PRE_DISPATCH_CODES.has(code)) return "not_dispatched";
  return "dispatched_ambiguous";
}

function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && causeCode.length > 0) return causeCode;
  }
  return null;
}
