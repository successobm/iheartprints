/**
 * Sprint 2M Phase 2E (Goal 14): internal structured logging for the
 * final-art reconstruction lifecycle. Server-side only. Deliberately
 * whitelists fields rather than spreading a report/response object, so a
 * future field added to `PrintValidationReport`, a provider response, or an
 * `AssetRecord` can never leak into logs by accident.
 *
 * Never logs: `TOPAZ_API_KEY` (or any provider credential), signed storage
 * URLs, raw provider response bodies, or storage secrets. `providerRequestId`
 * is logged deliberately — it is an internal diagnostic id, not a secret —
 * but never reaches a customer-facing surface (see the `Y` test scenario in
 * `final-artwork-worker-capability.test.ts`).
 */

export interface FinalArtworkReconstructionLogDetails {
  projectId: string;
  finalArtworkJobId: string;
  artworkVersionId: string;
  providerKey: string;
  providerRequestId: string | null;
  sourceWidthPx: number;
  sourceHeightPx: number;
  reconstructedWidthPx: number | null;
  reconstructedHeightPx: number | null;
  finalCanvasWidthPx: number;
  finalCanvasHeightPx: number;
  requiredWordingVerification: string;
  conceptEvaluationAlignment: string;
  transparencyCheck: string;
  finalValidationStatus: string;
  /** Milliseconds spent inside the provider call — `null` when not measured (e.g. an existing asset was reused, Goal 16). */
  providerLatencyMs: number | null;
}

export function logFinalArtworkReconstructionOutcome(
  details: FinalArtworkReconstructionLogDetails,
): void {
  console.info("[final-artwork-worker] reconstruction outcome", details);
}

export interface FinalArtworkPaidCallLogDetails {
  projectId: string;
  finalArtworkJobId: string;
  providerKey: string;
  /** `true` only when a NEW paid submission was actually made this attempt — `false` when resuming an existing request or when no paid request is involved (Goal 13). */
  submittedNewPaidRequest: boolean;
  providerRequestId: string | null;
}

/** Sprint 2M Phase 2E (Goal 13): explicit, always-emitted signal of whether a paid call was made this attempt — never inferred after the fact from logs elsewhere. */
export function logFinalArtworkPaidCallDecision(
  details: FinalArtworkPaidCallLogDetails,
): void {
  console.info("[final-artwork-worker] paid-call decision", details);
}

/**
 * Phase 28I Section 0/6/9(I/J): `decideEnhancement` correctly determined
 * this job NEEDS a real reconstruction provider, but the environment's
 * configured provider is `local_raster_interpolation` — pure geometric
 * resampling, which invents no detail and is architecturally certain to
 * fail `reconstruction_sufficiency`/`effective_resolution`/
 * `minimum_raster_dimensions` (see those checks' own doc comments).
 *
 * This is NOT the same as "reconstruction was not required, local
 * normalization is correct" — that path never reaches this log at all. It
 * fires ONLY when local interpolation is about to stand in for a genuine
 * enhancement provider that either was never configured
 * (`FINAL_ARTWORK_PROVIDER` unset — the default in this repository's
 * `.env.example`) or was deliberately refused (test/dev safety). Purely
 * diagnostic — it changes no behavior and blocks nothing; the existing
 * validation checks are what actually refuse the result, honestly, exactly
 * as designed. This log exists so that refusal's ROOT CAUSE (a missing
 * real-enhancement provider, not a validation defect) is visible without
 * having to re-derive it from a validation report every time.
 */
export function logFinalArtworkEnhancementProviderGap(details: {
  projectId: string;
  finalArtworkJobId: string;
  configuredProviderKey: string;
  requiredScale: number;
}): void {
  console.warn(
    "[final-artwork-worker] reconstruction required but no real enhancement provider is configured -- local interpolation will produce a plate that print-validation is expected to correctly refuse",
    details,
  );
}

/**
 * "Fix Topaz Resume/Download Failure" Phase 4: the live INCREDI-BOWLS-class
 * incident that motivated this was "nearly invisible" — a job persisted as
 * `failed` while the terminal showed an unrelated batch progressing. Every
 * claimed final-artwork job that ends in `failJob` now logs this, so the
 * NEXT such failure is visible the moment it happens, without needing to
 * separately query job state.
 *
 * Whitelisted fields only — same discipline as every other function in this
 * file. `sanitizedError` is `ProviderError.message` (or an `Error.message`
 * for a non-provider failure) — already internal-only and never containing
 * a URL, header, or credential (see `describeFinalArtworkError`'s doc
 * comment in `final-artwork-worker-capability.ts` and
 * `describeFetchFailure`'s in `topaz-transparency-upscale-provider.ts`),
 * but this function additionally accepts it as a plain string precisely so
 * it can never receive a raw `Error`/`ProviderError` object (and, with it,
 * a stack trace or anything else not already reviewed for safety).
 */
export interface FinalArtworkProviderFailureLogDetails {
  projectId: string;
  finalArtworkJobId: string;
  providerKey: string;
  providerRequestId: string | null;
  /** `ProviderError.stage`, when the failure carried one (e.g. `"submit"`, `"poll"`, `"download"`) — `null` for a failure with no such concept (e.g. asset persistence, a non-`ProviderError` throw). */
  stage: string | null;
  sanitizedError: string;
  /** `true` only when THIS attempt actually made a new paid submission before failing — mirrors `FinalArtworkPaidCallLogDetails.submittedNewPaidRequest`. */
  submittedNewPaidRequest: boolean;
  /** Whether this attempt started from an existing paid request it intended to resume, regardless of whether resuming actually succeeded. `false` on a genuine first attempt or for a provider with no paid-request concept. */
  attemptedResume: boolean;
}

export function logFinalArtworkProviderFailure(details: FinalArtworkProviderFailureLogDetails): void {
  console.error("[final-artwork-worker] job failed", details);
}

/**
 * "Separate Provider Recovery Attempt Budget" Phase 6: fires whenever
 * `produceProductionAsset` refuses a claim outright because its relevant
 * attempt budget is exhausted — BEFORE any source download, provider poll,
 * or provider download. This is a genuinely different moment from
 * `logFinalArtworkProviderFailure`: that log fires only when
 * `activeProvider.produce()` was actually invoked and threw; a
 * budget-exhaustion refusal never reaches that call at all, which is
 * exactly the gap the live INCREDI-BOWLS-class incident exposed — a job
 * claimed and "processed" (see `local-final-artwork-trigger.ts`'s own
 * `claimedJobIds` naming note) with no structured failure output anywhere.
 *
 * Exactly one of `freshExecutionBudget`/`recoveryBudget` is non-null,
 * matching `classification` — never both, never neither.
 */
export interface FinalArtworkAttemptBudgetExhaustedLogDetails {
  projectId: string;
  finalArtworkJobId: string;
  /** The job's generic claim counter at the moment of refusal (see `FinalArtworkJob.attempts`'s own doc for what this counts). */
  attempts: number;
  classification: "fresh_execution" | "resume";
  providerKey: string;
  hasProviderRequestId: boolean;
  freshExecutionBudget: { used: number; max: number } | null;
  recoveryBudget: { used: number; max: number } | null;
}

export function logFinalArtworkAttemptBudgetExhausted(
  details: FinalArtworkAttemptBudgetExhaustedLogDetails,
): void {
  console.error("[final-artwork-worker] attempt budget exhausted", details);
}

/**
 * Bounded FinalArtwork Production-Execution Repair (short-step follow-up,
 * Repair 1 — observability): the audit could not identify which stage a
 * production HTTP 504 failed inside, because no stage-level timing existed
 * anywhere in this pipeline. This is the minimum structured instrumentation
 * needed to answer that the next time: one whitelisted-field log line per
 * durable-state-machine stage, with elapsed milliseconds for whichever
 * stages have a meaningful duration.
 *
 * Same discipline as every other function in this file: whitelisted fields
 * only, never a spread of a richer object. Never logs a provider secret,
 * a signed storage/download URL, artwork bytes, or customer-sensitive
 * content — `providerRequestId` is an internal diagnostic id, not a secret,
 * same as elsewhere in this module.
 */
export type FinalArtworkWorkerStage =
  | "job_claimed"
  | "provider_status_check_started"
  | "provider_status_check_completed"
  | "provider_download_started"
  | "provider_download_completed"
  | "provider_result_intermediate_persisted"
  | "intermediate_readback_completed"
  | "normalize_started"
  | "normalize_completed"
  | "production_asset_upload_started"
  | "production_asset_upload_completed"
  | "production_asset_row_persisted"
  | "checkpoint_persisted"
  | "recovery_charge_refunded"
  | "validation_started"
  | "validation_completed"
  | "job_completed";

export interface FinalArtworkWorkerStageLogDetails {
  projectId: string;
  finalArtworkJobId: string;
  providerKey: string | null;
  stage: FinalArtworkWorkerStage;
  /** Milliseconds spent in the operation this stage event closes out — `null` for a stage marker with no meaningful duration of its own (e.g. `job_claimed`). */
  elapsedMs: number | null;
}

export function logFinalArtworkWorkerStage(details: FinalArtworkWorkerStageLogDetails): void {
  console.info("[final-artwork-worker] stage", details);
}

/**
 * Bounded FinalArtwork Production-Execution Repair (short-step follow-up,
 * Repair 8): fires when a TRANSIENT infrastructure hiccup (network blip,
 * rate limit, provider unavailable, or this repair's own new per-call
 * timeout) during the bounded status-check or download step is deferred to
 * a later claim rather than failing the job. Unbounded Transient-Deferral
 * Loop Repair (Blocker 2 correction): the recovery-budget charge this
 * claim's own classification already made is deliberately LEFT CHARGED
 * (never refunded) here — a PERSISTENT transient condition must still
 * reach the existing recovery-attempt ceiling, never defer forever with
 * neither budget ever moving. Only a claim that never ran at all (an
 * external interruption before any code executed) is genuinely free; this
 * function fires for a claim that DID run and caught a transient error, so
 * it always costs one unit. Distinct from `logFinalArtworkProviderFailure`,
 * which fires only when a claim genuinely fails the job; this is the
 * intermediate signal — a controlled, bounded deferral, neither a clean
 * success nor a terminal failure.
 */
export interface FinalArtworkBoundedTransientDeferralLogDetails {
  projectId: string;
  finalArtworkJobId: string;
  providerKey: string;
  providerRequestId: string | null;
  stage: string;
  sanitizedError: string;
}

export function logFinalArtworkBoundedTransientDeferral(
  details: FinalArtworkBoundedTransientDeferralLogDetails,
): void {
  console.warn(
    "[final-artwork-worker] transient poll/download hiccup deferred to a later claim -- recovery budget charged, never an unconditional free pass (Blocker 2 correction)",
    details,
  );
}
