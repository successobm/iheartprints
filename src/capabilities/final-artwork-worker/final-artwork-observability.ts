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
