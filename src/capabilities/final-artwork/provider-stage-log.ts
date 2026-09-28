/**
 * Download Crash-Boundary Diagnostics (live incident: Pedro Back job
 * `5ccc9d2f-…`, two reproducible whole-container deaths).
 *
 * WHY THIS EXISTS. Two production attempts died inside
 * `produceBounded()` within ~1.2s of the worker's own
 * `provider_download_started` marker, with DigitalOcean reporting
 * `exited with code: 128` — which DO's own Error Code Reference defines as
 * "Invalid Exit Code — the container tried to exit with an invalid code;
 * this might be a script or signal handling issue", explicitly NOT the
 * SIGABRT (134) / SIGKILL-OOM (137) / SIGSEGV (139) / SIGTERM (143) codes
 * it lists separately. A local memory profile of the exact same source
 * bytes through the exact same production functions measured a peak
 * increment of only ~63 MiB against ~236 MiB of container headroom, so
 * memory exhaustion is ruled out as well. That leaves a genuinely unknown
 * boundary somewhere between "decode the source" and "persist the
 * intermediate", and NOTHING in the existing logs distinguishes those
 * boundaries from each other — the worker's single `provider_download_started`
 * marker covers the entire span.
 *
 * WHAT THIS IS. One stdout line per boundary, so that ONE future production
 * attempt identifies the exact statement the process dies on rather than
 * costing a recovery attempt for no information. Purely additive: it
 * changes no ordering, no error handling, no timeout, no retry, no recovery
 * accounting, and allocates nothing beyond the log record itself.
 *
 * WHY A SIBLING MODULE RATHER THAN `final-artwork-worker/final-artwork-observability.ts`.
 * These boundaries are INSIDE the provider, and `final-artwork` must never
 * import from `final-artwork-worker` — the dependency runs the other way
 * (see `ARCHITECTURE.md` / `capability-boundaries.ts`). This module mirrors
 * that file's discipline exactly rather than reaching across the boundary.
 *
 * SECRET SAFETY — STRUCTURAL, NOT CONVENTIONAL. `FinalArtworkProviderStageLogDetails`
 * admits a CLOSED set of fields, every payload one of them a `number | null`.
 * There is no `string` field a caller could pass a signed result URL,
 * `X-API-Key`, `Authorization` header, or response body into, and
 * TypeScript's excess-property checking refuses an object literal carrying
 * anything else. The signed download URL in particular is never logged, in
 * whole or in part — only the HTTP status it answered with. `providerRequestId`
 * is logged deliberately: it is an internal diagnostic id, not a secret,
 * exactly as `final-artwork-observability.ts` already treats it.
 *
 * CORRELATION. The provider has no project/job id and this module
 * deliberately does not add one to `FinalArtworkProviderInput` (that would
 * be a contract change across every provider and fake). It does not need
 * one: `FinalArtworkSchedulerCapability.runBatch()` claims AT MOST ONE job
 * per invocation and dedupes concurrent batches per process, so at most one
 * final-artwork job is ever in flight in a given process. The worker's own
 * `[final-artwork-worker] stage` lines — which DO carry `projectId` and
 * `finalArtworkJobId` — bracket these lines unambiguously.
 */

export type FinalArtworkProviderStage =
  /** `PNG.sync.read(input.sourceBytes)` — the first heavy synchronous step after the worker's `provider_download_started`. */
  | "source_png_decode_started"
  | "source_png_decode_completed"
  /** `planStandardRasterReconstruction` — contains the FIRST `trimToAlphaBounds` full-canvas pass. */
  | "reconstruction_plan_started"
  | "reconstruction_plan_completed"
  /** `resolveReconstructionRequest` — contains the SECOND `trimToAlphaBounds` full-canvas pass. */
  | "reconstruction_request_resolve_started"
  | "reconstruction_request_resolve_completed"
  /** `GET {TOPAZ_API_BASE}/download/{processId}` — the first outbound provider call on this path. */
  | "download_metadata_fetch_started"
  | "download_metadata_fetch_responded"
  /** The signed result link. The URL itself is NEVER logged — status and declared length only. */
  | "download_result_bytes_fetch_started"
  | "download_result_bytes_headers_received"
  /** `readResponseBodyWithSizeCap` — where the result is materialised into one Buffer. */
  | "download_result_body_buffering_started"
  | "download_result_body_buffering_completed"
  | "result_png_decode_started"
  | "result_png_decode_completed"
  | "result_geometry_validation_started"
  | "result_geometry_validation_completed"
  /** `PNG.sync.write` — the full synchronous re-encode performed before anything is durable. */
  | "result_png_encode_started"
  | "result_png_encode_completed";

/**
 * Whitelisted fields only — see this module's own "SECRET SAFETY" note.
 * Every optional payload field is numeric by construction, so no URL,
 * header, credential, or artwork byte can be routed through it.
 */
export interface FinalArtworkProviderStageLogDetails {
  stage: FinalArtworkProviderStage;
  providerKey: string;
  /** Internal diagnostic id, never a secret — same treatment as `final-artwork-observability.ts`. */
  providerRequestId: string | null;
  /** HTTP status of the response this stage closes out. Never a URL, never a header value. */
  httpStatus?: number | null;
  /** `content-length` as declared by the response, when present. */
  declaredContentLengthBytes?: number | null;
  /** Bytes actually buffered/encoded — a COUNT, never the bytes. */
  byteCount?: number | null;
  widthPx?: number | null;
  heightPx?: number | null;
  /** Milliseconds spent in the operation this stage closes out — `null` for a pure start marker. */
  elapsedMs?: number | null;
}

/**
 * `console.info`, matching `logFinalArtworkWorkerStage` exactly so both
 * streams interleave in one DigitalOcean runtime log with the same shape.
 */
export function logFinalArtworkProviderStage(
  details: FinalArtworkProviderStageLogDetails,
): void {
  console.info("[final-artwork-provider] stage", details);
}
