/**
 * Phase 2C.2C: the DURABLE FAILURE VOCABULARY for one logical paid image
 * intent.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * Phase 2C0.5 made the paid DECISION durable (reserve before paying, reuse
 * before paying, bounded dispatches). It did not make the paid FAILURE
 * durable. A live Soft replacement dispatch reached OpenAI, was billed, and
 * returned usable bytes — then local persistence failed. The durable row was
 * left `status = reserved`, `provider_request_id = null`, `last_error =
 * null`, and the only record that any money had moved was a provider-side
 * usage log nobody could join back to a project.
 *
 * The question an operator must be able to answer from durable state alone
 * is exactly one sentence long:
 *
 *   "We paid; why did the result disappear?"
 *
 * That needs two things this module supplies: a stable classification of
 * WHERE in the paid path the failure happened, and a sanitized description
 * safe to persist next to it.
 *
 * WHAT THIS IS NOT
 *
 * Not a second error framework. `ProviderError` remains the sole authority
 * on provider-side failure (`classification` = why, `dispatch` = could it
 * have been billed), and this module reads it rather than replacing it. The
 * only new error type here is `PaidImagePersistenceError`, which exists for
 * one reason: after the provider has answered, "storage refused the bytes"
 * and "the database refused the row" are indistinguishable from outside
 * `AssetCapability`, and they are the two failures that most need telling
 * apart when money has already been spent.
 *
 * NEVER PERSISTED OR LOGGED THROUGH THIS MODULE: API keys, authorization
 * headers, image bytes, base64 payloads, prompt text, or full provider
 * response bodies. `describePaidImageFailure` is the choke point that
 * enforces it.
 */

import { ProviderError } from "@/capabilities/providers/provider-error";

/**
 * Where in the paid path a logical paid image intent failed.
 *
 * Ordered as the paid path itself runs, because that ordering IS the
 * information: everything from `provider_ambiguous` downward means a paid
 * request may already have been billed, and everything below
 * `provider_billed_unusable` means it almost certainly was.
 */
export type PaidImageFailureClass =
  /**
   * The request provably never reached the provider (`ProviderError.dispatch
   * === "not_dispatched"`). Nothing was billed. The only class for which a
   * re-dispatch carries no double-billing risk at all.
   */
  | "provider_not_dispatched"
  /**
   * The request left this process and the outcome is unknown. May have been
   * billed; the stack cannot prove otherwise.
   */
  | "provider_ambiguous"
  /**
   * The provider returned a success we could not consume (e.g. HTTP 200 with
   * no image data). Treated as billed — an unusable success that loops is
   * the most expensive possible failure mode.
   */
  | "provider_billed_unusable"
  /**
   * Reserved: a decode step INSIDE the paid persistence path failed after
   * the provider returned bytes. No concept-path site raises this today —
   * the only decode in `uploadConceptImage` is thumbnail generation, which
   * is deliberately non-fatal (see `AssetCapability`). It is named here so a
   * future persistence-stage decode is classified rather than collapsed into
   * an opaque local failure.
   */
  | "local_decode_failure"
  /** The provider was billed; the object store refused the bytes. */
  | "storage_upload_failure"
  /**
   * The provider was billed, bytes landed in storage, and the `AssetRecord`
   * write failed. `AssetCapability`'s existing orphan cleanup has already
   * removed the stored object by the time this is raised.
   */
  | "asset_persistence_failure"
  /**
   * The provider was billed AND the bytes are durably stored, but the intent
   * row could not be marked succeeded. The most recoverable class in this
   * union: the stamped asset is findable by intent key, so orphan adoption
   * recovers it on the next claim at no cost.
   */
  | "intent_completion_failure"
  /**
   * A worker whose job was reclaimed finished its paid call and was refused
   * the durable write. Money moved; the image is deliberately discarded in
   * favour of the live worker's. Never persisted onto the intent — by
   * definition a newer worker owns that row (see claim fencing).
   */
  | "fenced_out"
  /**
   * The job's logical paid-intent budget is spent. Refused BEFORE the
   * provider was contacted, so nothing was billed.
   */
  | "budget_blocked"
  /** A local failure in the paid path that named none of the above. */
  | "unknown_local_failure";

/**
 * Whether a failure class means a paid provider response may already have
 * been billed. Deliberately conservative: only the two classes that provably
 * never reached the provider answer `false`.
 *
 * This never claims a billed image is RECOVERABLE — only that money may have
 * moved. Recoverability is a separate question answered by durable state
 * (`result`, or a stamped orphan asset), never by this.
 */
export function isPossiblyBilledFailureClass(
  failureClass: PaidImageFailureClass,
): boolean {
  return (
    failureClass !== "provider_not_dispatched" &&
    failureClass !== "budget_blocked"
  );
}

/**
 * Raised by the persistence stages of the paid path so the executor can tell
 * "storage refused the bytes" from "the database refused the row" — the two
 * failures that most need distinguishing once the provider has been billed.
 *
 * Preserves the original failure's message verbatim and carries it as
 * `cause`, so wrapping adds classification without destroying diagnostics or
 * changing what an existing `assert.rejects(..., /original message/)` sees.
 */
export class PaidImagePersistenceError extends Error {
  readonly failureClass: PaidImageFailureClass;

  constructor(
    failureClass: PaidImageFailureClass,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PaidImagePersistenceError";
    this.failureClass = failureClass;
  }
}

/**
 * Tags a persistence-stage failure with its class, idempotently: an error
 * that already carries a classification keeps the one closest to the actual
 * failure rather than being relabelled by an outer layer.
 */
export function asPaidImagePersistenceError(
  error: unknown,
  failureClass: PaidImageFailureClass,
): PaidImagePersistenceError {
  if (error instanceof PaidImagePersistenceError) return error;
  return new PaidImagePersistenceError(failureClass, safeMessage(error), {
    cause: error,
  });
}

/**
 * Classifies a failure thrown by the PROVIDER DISPATCH stage.
 *
 * A non-`ProviderError` escaping a provider adapter is classified
 * `provider_ambiguous`, never "not dispatched": an adapter that threw
 * something unexpected cannot prove the request never left, and guessing in
 * the cheap direction is how an already-billed image gets bought twice.
 */
export function classifyProviderDispatchFailure(
  error: unknown,
): PaidImageFailureClass {
  if (!(error instanceof ProviderError)) return "provider_ambiguous";
  switch (error.dispatch) {
    case "not_dispatched":
      return "provider_not_dispatched";
    case "dispatched_billed":
      return "provider_billed_unusable";
    default:
      return "provider_ambiguous";
  }
}

/**
 * Classifies a failure thrown by a LOCAL stage that runs after the provider
 * has already answered.
 */
export function classifyPaidImagePersistenceFailure(
  error: unknown,
): PaidImageFailureClass {
  if (error instanceof PaidImagePersistenceError) return error.failureClass;
  return "unknown_local_failure";
}

/**
 * The single sanitized, durable failure description written to
 * `PaidImageIntent.lastError` and echoed into logs.
 *
 * Shape is `"<failureClass>: <message>"` — greppable by class, and readable
 * enough to diagnose without a second query. The message half passes through
 * `safeMessage`, which is the security boundary of this module.
 */
export function describePaidImageFailure(
  failureClass: PaidImageFailureClass,
  error: unknown,
): string {
  return `${failureClass}: ${safeMessage(error)}`;
}

/**
 * The inverse of `describePaidImageFailure`: recovers the classification
 * from a persisted `PaidImageIntent.lastError`.
 *
 * Exists so a caller can answer "was this attempt possibly billed?" from the
 * DURABLE row rather than from an in-memory error it may not have — which is
 * exactly the position the replacement path is in when it reports
 * `paidCallMade`, since the failure it is describing was thrown several
 * layers below it.
 *
 * Returns `null` for anything not written by this module (including the
 * pre-Phase-2C.2C rows that carry a bare provider message), so a caller can
 * distinguish "classified as safe" from "unclassified" and default to the
 * expensive reading.
 */
export function readPaidImageFailureClass(
  lastError: string | null | undefined,
): PaidImageFailureClass | null {
  if (!lastError) return null;
  const separator = lastError.indexOf(":");
  if (separator <= 0) return null;
  const candidate = lastError.slice(0, separator);
  return (PAID_IMAGE_FAILURE_CLASSES as readonly string[]).includes(candidate)
    ? (candidate as PaidImageFailureClass)
    : null;
}

/**
 * Every member of `PaidImageFailureClass`, as a value. Kept adjacent to the
 * type so a new class cannot be added to one without the other.
 */
const PAID_IMAGE_FAILURE_CLASSES = [
  "provider_not_dispatched",
  "provider_ambiguous",
  "provider_billed_unusable",
  "local_decode_failure",
  "storage_upload_failure",
  "asset_persistence_failure",
  "intent_completion_failure",
  "fenced_out",
  "budget_blocked",
  "unknown_local_failure",
] as const satisfies readonly PaidImageFailureClass[];

/** Maximum persisted/logged length of a failure message. */
const MAX_SAFE_MESSAGE_LENGTH = 300;

/**
 * Any unbroken run of this many token-ish characters is treated as an opaque
 * payload — a base64 image chunk, a bearer token, an API key — and redacted
 * rather than persisted. Deliberately well below the length of a real image
 * payload and well above any realistic identifier (a UUID is 36; an OpenAI
 * request id is far shorter than this).
 */
const OPAQUE_RUN_PATTERN = /[A-Za-z0-9+/=_-]{64,}/g;

/** Redacts anything that looks like a credential or an inline payload. */
function safeMessage(error: unknown): string {
  const raw = extractMessage(error);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const redacted = collapsed
    // A data URI can carry the whole image; never persist one.
    .replace(/data:[^\s,]*,[^\s]*/gi, "[redacted]")
    .replace(OPAQUE_RUN_PATTERN, "[redacted]");
  return redacted.length > MAX_SAFE_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_SAFE_MESSAGE_LENGTH)}…`
    : redacted;
}

function extractMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    // Provider errors are already customer-safe by construction, and their
    // dispatch state is the load-bearing half — keep both.
    return `${error.classification}/${error.dispatch}: ${error.message}`;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "Paid image intent failed for an unknown reason.";
}
