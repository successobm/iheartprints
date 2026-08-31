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
 */

import { ProviderError } from "@/capabilities/providers/provider-error";

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
    throw new ProviderError("network", "The OpenAI Files transport could not be reached.");
  } finally {
    clearTimeout(timeout);
  }
}

function classifyNonOkResponse(status: number): ProviderError {
  if (status === 429) {
    return new ProviderError("rate_limited", "OpenAI Files rate-limited this transport request.");
  }
  if (status === 401 || status === 403) {
    return new ProviderError("auth", "OpenAI Files rejected the configured credentials.");
  }
  if (status >= 500) {
    return new ProviderError("unavailable", "OpenAI Files is temporarily unavailable.");
  }
  return new ProviderError("malformed_response", `OpenAI Files returned an unexpected status (${status}).`);
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
  form.append(
    "expires_after",
    JSON.stringify({ anchor: "created_at", seconds: input.expiresAfterSeconds }),
  );
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
    throw classifyNonOkResponse(response.status);
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
    throw classifyNonOkResponse(response.status);
  }
  return { deleted: true };
}
