/**
 * Diagnostic-Hardening Phase / Final Recovery Instrumentation Phase (real
 * Signs acceptance incident): shared, provider-neutral diagnostic
 * formatting used across capabilities that persist DB/storage writes and
 * need a safe, bounded, non-secret description of whatever they caught —
 * originally built inside `final-artwork-worker-capability.ts`, extracted
 * here so `AssetCapability`'s own persistence sub-steps (Part A of the
 * intermediate-asset-persistence-durability phase) can reuse the identical
 * formatter and timing wrapper rather than a second, possibly-drifting
 * copy. Every consumer's own call sites are internal-only diagnostics
 * (never a customer-facing string) — see each consumer's own doc comment
 * for its specific customer-exposure audit.
 */

/**
 * The ONLY scalar fields ever read off a non-`Error` thrown/rejected value,
 * in this exact priority order. Every name here was chosen because it is a
 * plain, human-readable label (never a secret, credential, or a full
 * request/response payload) — deliberately the same shape `PostgrestError`/
 * `StorageError`/`ProviderError` themselves already expose. This is a
 * strict ALLOWLIST, not a denylist: a field not named here is never read,
 * no matter what it's called, so there is no separate "sensitive field"
 * list to keep in sync — leaving one out here is the only way to exclude
 * it.
 */
const ERROR_DESCRIPTION_ALLOWED_FIELDS = [
  "message",
  "msg",
  "error",
  "code",
  "status",
  "statusCode",
  "name",
  "details",
  "hint",
] as const;

/** Hard ceiling on the resulting diagnostic string — never grows unbounded from a hostile or oversized caught value. */
const MAX_ERROR_DESCRIPTION_LENGTH = 500;

export function boundedErrorDescription(value: string): string {
  return value.length > MAX_ERROR_DESCRIPTION_LENGTH
    ? `${value.slice(0, MAX_ERROR_DESCRIPTION_LENGTH)}…`
    : value;
}

/**
 * Sanitized, non-secret description of an arbitrary caught value. Every
 * caller must independently confirm (and document, in its own doc comment)
 * that its own `lastError`-equivalent sink is never surfaced to a
 * customer — this function only guarantees the STRING ITSELF is safe to
 * store, never that the field it lands in is safe to read back.
 *
 * Deliberately never calls `JSON.stringify` on an arbitrary caught value
 * and never recurses into a nested object — only the named scalar fields
 * above are ever read, so a caught value carrying credentials, a signed
 * URL, or a full request/response body (none of which are among the
 * allowed field names) can never leak through this function, and a
 * circular reference elsewhere in the object is never touched in the first
 * place.
 */
export function describeOperationError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return boundedErrorDescription(error.message);
  }
  if (typeof error === "string" && error) {
    return boundedErrorDescription(error);
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return boundedErrorDescription(`Unrecognized failure value (${typeof error}): ${String(error)}`);
  }
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const field of ERROR_DESCRIPTION_ALLOWED_FIELDS) {
      const value = record[field];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(`${field}=${String(value)}`);
      }
    }
    if (parts.length > 0) {
      return boundedErrorDescription(`Unrecognized failure value: ${parts.join("; ")}`);
    }
  }
  return "Operation failed for an unknown reason.";
}

/**
 * Wraps ONE async operation (a DB write, a storage call) with a label and
 * elapsed-ms timing, purely so a future failure identifies WHICH operation
 * was slow — never used to change control flow.
 *
 * On success, logs a concise, non-sensitive timing line and returns the
 * result unchanged. On failure, logs the same line with `outcome=error`,
 * then re-throws a NEW `Error` whose message is
 * `"<label> failed after <n>ms: <safe description>"` — the safe
 * description comes from `describeOperationError` itself, so this
 * introduces no new leakage surface beyond what that function already
 * allows. The original error's own type/identity is intentionally NOT
 * preserved — use this ONLY for leaf DB/storage calls whose result nothing
 * downstream inspects by `instanceof`/`.classification`/`.dispatch`; a
 * caller that needs the original error's own type/identity preserved
 * (e.g. because a sibling branch checks `error instanceof ProviderError`)
 * must NOT route that specific call through this helper — see
 * `runSignReconstructionAndContinue`'s own produce-vs-resume dispatch for
 * a worked example of exactly this distinction.
 */
export async function withOperationTiming<T>(
  logPrefix: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.info(`[${logPrefix}] operation=${label} elapsed_ms=${Date.now() - startedAt} outcome=success`);
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.info(`[${logPrefix}] operation=${label} elapsed_ms=${elapsedMs} outcome=error`);
    // Bounded the same way `describeOperationError` itself bounds its own
    // output — the label+timing prefix must never push the TOTAL persisted
    // message past the same length ceiling.
    throw new Error(boundedErrorDescription(`${label} failed after ${elapsedMs}ms: ${describeOperationError(error)}`));
  }
}
