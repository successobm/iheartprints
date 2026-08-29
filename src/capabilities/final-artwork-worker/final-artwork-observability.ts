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
