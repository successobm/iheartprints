/**
 * Signs Phase S4.2C.1: a narrow, raw-`fetch` OpenAI Files transport client
 * — upload + delete only, nothing else. Mirrors this repository's existing
 * no-SDK convention exactly (no `openai` package installed; every adapter
 * talks to OpenAI via `fetch` directly, per `openai-sign-preservation-
 * semantic-provider.ts`'s own doc comment).
 *
 * Externally verified this phase (Signs Phase S4.2C.1's own authoritative-
 * contract section, not re-derived here): `POST /v1/files` accepts
 * `purpose: "user_data"` and an optional `expires_after`; a non-batch file
 * otherwise persists until manually deleted. `DELETE /v1/files/{id}` frees
 * it early — used here as the PRIMARY cleanup mechanism, with
 * `expires_after` as crash/leak defense in depth only (Signs Phase
 * S4.2C.1 §9).
 *
 * `OPENAI_FILES_EXPIRES_AFTER_SECONDS` below is now a CONFIRMED value —
 * Signs Phase S4.2C.1's reviewed-integration step recorded OpenAI's
 * documented `expires_after.seconds` bounds for `purpose: "user_data"` as
 * minimum 3600 (1 hour), maximum 2592000 (30 days); 3600 is used here —
 * the shortest supported duration for a transient verification artifact,
 * consistent with explicit deletion remaining the PRIMARY cleanup
 * mechanism and this expiry existing purely as crash/leak defense in depth
 * (Signs Phase S4.2C.1 §9).
 *
 * Signs Phase S4.2C.3: the real S4.2C.2 smoke test's ONE authorized live
 * upload returned HTTP 400 — root-caused to `expires_after` being sent as
 * a single JSON-stringified multipart field
 * (`form.append("expires_after", JSON.stringify({...}))`), which does not
 * match OpenAI's documented multipart shape. The Files API expects
 * bracket-notation multipart fields instead:
 * `expires_after[anchor]` / `expires_after[seconds]` (each its own plain
 * string field) — fixed below. Narrow request-encoding correction only;
 * `purpose`, the expiration duration, and every other behavior are
 * unchanged.
 *
 * Signs Phase S4.2C.6: the real S4.2C.5 Ruth attempt's first upload
 * (~1.93 MB) failed with a bare "could not be reached" — `withTimeout`'s
 * catch block was discarding the original `fetch` rejection entirely
 * (everything Node's Undici-backed `fetch` attaches to a connection-level
 * failure). Fixed below: a bounded, STRUCTURED-SCALAR-ONLY network-cause
 * description (`name`/`code`/`errno`/`syscall`, top-level and nested
 * `cause` — never `message`, see `describeNetworkCause`'s own doc comment
 * and Signs Phase S4.2C.6A) is folded into the `ProviderError` message,
 * and the dispatch state is now classified via the EXISTING,
 * already-reviewed `classifyFetchRejectionDispatch` (Phase 2C0.5 — already
 * used by `openai-concept-provider.ts`/`stripe-checkout-provider.ts`)
 * instead of always defaulting to `dispatched_ambiguous` — a DNS/connect
 * failure that provably never reached OpenAI is now correctly
 * `not_dispatched`; every other network failure remains
 * `dispatched_ambiguous`, unchanged. Purely additive observability — no
 * retry behavior changes (this file never retried internally before, and
 * still doesn't).
 */

import { ProviderError, classifyFetchRejectionDispatch } from "@/capabilities/providers/provider-error";

const OPENAI_FILES_ENDPOINT = "https://api.openai.com/v1/files";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The shortest OpenAI-documented `expires_after.seconds` duration for
 * `purpose: "user_data"` (confirmed minimum: 3600; maximum: 2592000) —
 * chosen because every comparison image here is a transient verification
 * artifact that explicit deletion should already have removed long before
 * this backstop would ever matter.
 */
export const OPENAI_FILES_EXPIRES_AFTER_SECONDS = 3600;

export interface OpenAIFilesTransportConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface UploadOpenAIFileInput {
  /** Deterministic, non-customer-identifying filename (Signs Phase S4.2C.1 §3) — e.g. "sign-preservation-source-r0-c0.png". */
  filename: string;
  bytes: Buffer;
  contentType: string;
  /** Explicit short expiration — provider-side backstop only; explicit deletion remains mandatory. */
  expiresAfterSeconds: number;
}

export interface UploadOpenAIFileResult {
  fileId: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Signs Phase S4.2C.6A: bound on any single extracted scalar field (`name`/`code`/`errno`/`syscall` are always short by construction, but this is defense-in-depth regardless — never trust a third-party-populated field's length). */
const MAX_NETWORK_CAUSE_FIELD_LENGTH = 64;

/**
 * Signs Phase S4.2C.6A: normalizes one scalar diagnostic field — string or
 * number only, bounded, trimmed. Never an object, never `message`.
 */
function normalizeScalarField(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value.slice(0, MAX_NETWORK_CAUSE_FIELD_LENGTH);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * Signs Phase S4.2C.6 (network-cause surfacing), amended S4.2C.6A
 * (STRUCTURED SCALAR FIELDS ONLY — no free-form message): extracts a
 * bounded, sanitized description of the underlying network failure from a
 * raw `fetch` rejection. Reads ONLY `name`/`code`/`errno`/`syscall` —
 * top-level on the thrown `Error`, and the same four fields on
 * `error.cause` (Node's Undici-backed `fetch` attaches these to
 * connection-level failures, e.g. a `SocketError` with
 * `cause.code = "UND_ERR_SOCKET"`, `cause.errno = "ECONNRESET"`,
 * `cause.syscall = "read"`). Read-only observability only — never used for
 * classification (see `classifyFetchRejectionDispatch`, unchanged,
 * imported from the existing Phase 2C0.5 module).
 *
 * ARBITRARY ERROR.MESSAGE IS NOT INCLUDED. ARBITRARY ERROR.CAUSE.MESSAGE IS
 * NOT INCLUDED. Neither `error.message` nor `error.cause.message` is ever
 * read by this function — a prior version of this diagnostic (Signs Phase
 * S4.2C.6, before this amendment) did surface a bounded `cause.message`
 * excerpt; that was withdrawn because a free-form message field is not a
 * structured, enumerable value this code controls the shape of, unlike
 * `name`/`code`/`errno`/`syscall` — Node/Undici's OWN low-level error
 * vocabulary. Never serializes `error.stack`, the whole `Error`/`cause`
 * object, headers, the request, a response body, multipart contents, a URL
 * query string, or any socket object — none of those are ever read here in
 * the first place (this function's only inputs are the four named scalar
 * fields, checked by name, nothing else).
 */
function describeNetworkCause(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const parts: string[] = [];

  const name = normalizeScalarField(error.name);
  if (name) parts.push(`network_cause_name=${name}`);
  const code = normalizeScalarField((error as { code?: unknown }).code);
  if (code) parts.push(`network_cause_code=${code}`);
  const errno = normalizeScalarField((error as { errno?: unknown }).errno);
  if (errno) parts.push(`network_cause_errno=${errno}`);
  const syscall = normalizeScalarField((error as { syscall?: unknown }).syscall);
  if (syscall) parts.push(`network_cause_syscall=${syscall}`);

  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    const underlyingName = normalizeScalarField(causeRecord.name);
    if (underlyingName) parts.push(`network_cause_underlying_name=${underlyingName}`);
    const underlyingCode = normalizeScalarField(causeRecord.code);
    if (underlyingCode) parts.push(`network_cause_underlying_code=${underlyingCode}`);
    const underlyingErrno = normalizeScalarField(causeRecord.errno);
    if (underlyingErrno) parts.push(`network_cause_underlying_errno=${underlyingErrno}`);
    const underlyingSyscall = normalizeScalarField(causeRecord.syscall);
    if (underlyingSyscall) parts.push(`network_cause_underlying_syscall=${underlyingSyscall}`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new ProviderError("unavailable", "The OpenAI Files transport timed out.");
    }
    const cause = describeNetworkCause(error);
    throw new ProviderError(
      "network",
      cause
        ? `The OpenAI Files transport could not be reached. (${cause})`
        : "The OpenAI Files transport could not be reached.",
      // Signs Phase S4.2C.6: existing dispatch evidence, not a new rule —
      // a DNS/connect failure that provably never reached OpenAI is
      // `not_dispatched`; every other network failure (a reset, a timeout,
      // an unrecognized cause) stays `dispatched_ambiguous`, exactly as
      // before this phase.
      classifyFetchRejectionDispatch(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Signs Phase S4.2C.3: how much of a non-2xx error body to surface — enough to be actionable, bounded enough to never risk leaking something unbounded (never the request itself, never a secret). */
const MAX_ERROR_DETAIL_LENGTH = 500;

/**
 * Signs Phase S4.2C.3: classifies a non-2xx RESPONSE (never the request) —
 * reads the error body/response headers ONLY, bounded and truncated,
 * appended to the existing classification message so a future rejection
 * (like the real HTTP 400 this phase root-caused) is actionable without a
 * second live call. Never reads/logs the `Authorization` header, the
 * request body, image bytes, or multipart content — none of those are
 * even in scope here (this function only ever sees `response`, not the
 * request that produced it). Classification semantics (which status maps
 * to which `ProviderErrorClassification`) are unchanged from before this
 * phase.
 */
async function classifyNonOkResponse(response: Response): Promise<ProviderError> {
  const status = response.status;
  const requestId =
    response.headers.get("x-request-id") ?? response.headers.get("openai-request-id") ?? null;

  let detail = "";
  try {
    const text = await response.text();
    detail = text.slice(0, MAX_ERROR_DETAIL_LENGTH);
  } catch {
    detail = "";
  }
  const diagnostics = [
    requestId ? `request_id=${requestId}` : null,
    detail ? `detail=${detail}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const suffix = diagnostics ? ` (${diagnostics})` : "";

  if (status === 429) {
    return new ProviderError("rate_limited", `OpenAI Files rate-limited this transport request.${suffix}`);
  }
  if (status === 401 || status === 403) {
    return new ProviderError("auth", `OpenAI Files rejected the configured credentials.${suffix}`);
  }
  if (status >= 500) {
    return new ProviderError("unavailable", `OpenAI Files is temporarily unavailable.${suffix}`);
  }
  return new ProviderError(
    "malformed_response",
    `OpenAI Files returned an unexpected status (${status}).${suffix}`,
  );
}

/**
 * Uploads one derived comparison-image PNG to OpenAI Files with
 * `purpose: "user_data"` and an explicit `expires_after`. Never retried
 * internally — Signs Phase S4.2C.1 §6 makes the CALLER responsible for
 * upload-level idempotency/recovery (durable per-role bookkeeping), not
 * this narrow transport function.
 */
export async function uploadOpenAIFile(
  config: OpenAIFilesTransportConfig,
  input: UploadOpenAIFileInput,
): Promise<UploadOpenAIFileResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const form = new FormData();
  form.append("purpose", "user_data");
  // Signs Phase S4.2C.3: OpenAI's documented multipart shape for
  // `expires_after` is bracket-notation, each its own plain string field —
  // NOT a single JSON-stringified field (that was the real S4.2C.2 smoke
  // test's HTTP 400 root cause).
  form.append("expires_after[anchor]", "created_at");
  form.append("expires_after[seconds]", String(input.expiresAfterSeconds));
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
    input.filename,
  );

  const response = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(OPENAI_FILES_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal,
    }),
  );

  if (!response.ok) {
    throw await classifyNonOkResponse(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError("malformed_response", "OpenAI Files returned an unreadable upload response.");
  }

  const fileId =
    payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "string"
      ? (payload as { id: string }).id
      : null;
  if (!fileId) {
    throw new ProviderError(
      "malformed_response",
      "OpenAI Files upload response did not include a valid file id.",
    );
  }

  return { fileId };
}

export interface DeleteOpenAIFileResult {
  /** `true` whether this call actually deleted the file OR the file was already gone (404) — deletion is idempotent by design (Signs Phase S4.2C.1 §9). */
  deleted: boolean;
}

/**
 * Deletes one previously-uploaded file. Idempotent: a 404 (already
 * deleted, or never existed) is treated as success, never an error — a
 * cleanup retry pass must be safe to call more than once per file.
 */
export async function deleteOpenAIFile(
  config: OpenAIFilesTransportConfig,
  fileId: string,
): Promise<DeleteOpenAIFileResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const response = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(`${OPENAI_FILES_ENDPOINT}/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal,
    }),
  );

  if (response.status === 404) {
    return { deleted: true };
  }
  if (!response.ok) {
    throw await classifyNonOkResponse(response);
  }
  return { deleted: true };
}
