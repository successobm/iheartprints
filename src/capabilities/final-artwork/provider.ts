/**
 * Sprint 2M Phase 2C (Goal 6): provider-neutral raster production
 * transformation boundary. `FinalArtworkWorkerCapability` (domain code)
 * depends only on this interface — it must never know whether the
 * implementation is a local deterministic resample, a provider-hosted
 * reconstruction (Sprint 2M Phase 2E — Topaz Transparency Upscale), or
 * anything else. Mirrors `ConceptGenerationProvider` /
 * `ConceptEvaluationProvider`'s "provider owns 100% of its own mechanism;
 * domain code sees only provider-neutral input/output" shape.
 *
 * Print-Ready Normalization Phase 1: a provider owns RECONSTRUCTION only.
 * The production transform that follows it (alpha trim → safety margin →
 * physical-width sizing → proportional resample → PNG encode) is one shared,
 * auditable implementation in `production-normalization.ts` that every
 * provider runs its reconstructed raster through, so the printer's
 * deliverable is never per-provider geometry.
 */

import type { HalftoneScreenMetadata } from "./halftone-screen";

import type {
  ProductionNormalizationMetadata,
  ProductionSizingRequest,
} from "./production-normalization";

/**
 * Phase 28V — a durably-persisted PASS 1 reconstruction from an earlier
 * attempt at THIS exact job, when a controlled two-pass reconstruction
 * (see `topaz-transparency-upscale-provider.ts`'s
 * `planStandardRasterReconstruction`) already completed and validated its
 * first pass before a crash interrupted pass 2. `providerRequestId` is
 * pass 1's own paid request identity — carried along purely for audit/cost
 * accounting; a provider recognizing this input MUST treat pass 1 as
 * already done and never resubmit it.
 */
export interface FinalArtworkProviderIntermediateReconstruction {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  providerRequestId: string;
}

export interface FinalArtworkProviderResumeContext {
  /**
   * Sprint 2M Phase 2E (Goal 3): must match the resuming provider's own
   * `providerKey` exactly. A job whose last recorded attempt used a
   * different provider (e.g. `FINAL_ARTWORK_PROVIDER` changed between
   * attempts) is never treated as resumable — the worker passes `null`
   * instead, and the current provider starts a fresh attempt.
   */
  providerKey: string;
  providerRequestId: string;
  /**
   * Last known raw provider status string, if any. Bounded FinalArtwork
   * Production-Execution Repair (short-step follow-up): no longer purely
   * informational — a value of `FINAL_ARTWORK_PROVIDER_STATUS.resultReady`
   * is the sole signal a bounded provider uses to skip straight to its
   * download step rather than re-checking status (see `resultReadyRequest`
   * in `topaz-transparency-upscale-provider.ts`).
   */
  providerStatus: string | null;
}

export interface FinalArtworkProviderInput {
  sourceBytes: Buffer;
  sourceContentType: string;
  /**
   * Print-Ready Normalization Phase 1: the placement's production SIZING
   * POLICY (target physical print width, PPI, printable-height bound) — not a
   * pre-computed pixel canvas. Output pixel dimensions cannot be known until
   * the artwork has been alpha-trimmed, so a provider resolves them via
   * `normalizeProductionRaster` rather than being handed a fixed
   * `targetWidthPx`/`targetHeightPx` frame to pad artwork into.
   */
  sizing: ProductionSizingRequest;
  /**
   * Sprint 2M Phase 2E (Goal 3): a prior in-flight or completed paid-request
   * identity recorded for this exact `FinalArtworkJob`, if any — `null` on a
   * first attempt, or when the last attempt used a different provider. A
   * provider that performs a real paid submission MUST resume this request
   * (poll/download it) instead of submitting a new one when present.
   * Optional and safely ignorable by a provider with no paid-request
   * concept (e.g. local raster interpolation).
   */
  existingProviderRequest?: FinalArtworkProviderResumeContext | null;
  /**
   * Sprint 2M Phase 2E (Goal 3): called once per NEW paid submission,
   * synchronously, the instant that submission is actually accepted by an
   * external provider — before any polling begins. The caller persists
   * this durably (`FinalArtworkJob.providerRequestId`) so a worker crash
   * between submission and completion is resumable on retry without a
   * second paid call. Never called when resuming `existingProviderRequest`,
   * and safely optional/ignorable for a provider with no paid-request
   * concept.
   *
   * Phase 28V: most providers submit at most once per `produce()` call, so
   * "exactly once" was true for every provider until this phase. A
   * provider that legitimately makes TWO sequential paid submissions
   * within one `produce()` call (the two-pass Topaz provider, only when a
   * single pass cannot satisfy the request) calls this once per
   * submission, in order, each still strictly before that submission's own
   * polling begins — never violating the "persist before continuing"
   * guarantee this hook exists for.
   */
  onProviderRequestSubmitted?: (providerRequestId: string) => Promise<void>;
  /**
   * Phase 28V: a durably-persisted PASS 1 reconstruction from an earlier
   * attempt at THIS exact job, if the worker already produced and stored
   * one — present only when this job needed (and already paid for) a
   * first Topaz pass whose validated output was saved before a crash
   * interrupted pass 2. `null`/absent on a first attempt, for a job whose
   * single-pass reconstruction sufficed, or for any provider with no
   * multi-pass concept. A provider that recognizes this MUST use it as
   * pass 2's source instead of resubmitting pass 1.
   */
  existingIntermediateReconstruction?: FinalArtworkProviderIntermediateReconstruction | null;
  /**
   * Phase 28V: called exactly once, the instant a provider's PASS 1 output
   * has been produced and independently validated as geometrically valid,
   * but BEFORE pass 2 is submitted — mirrors `onProviderRequestSubmitted`'s
   * "persist before continuing" ordering. The caller durably stores these
   * bytes as an internal reconstruction-stage asset (never the customer-
   * facing production deliverable) so a crash during or after pass 2 never
   * re-spends pass 1's paid credit. Safely optional/ignorable by a
   * provider with no multi-pass concept.
   */
  onIntermediateReconstructionProduced?: (
    result: FinalArtworkProviderIntermediateReconstruction,
  ) => Promise<void>;
  /**
   * Bounded FinalArtwork Production-Execution Repair (short-step follow-up):
   * a durably-persisted, ALREADY-DOWNLOADED, ALREADY-GEOMETRY-VALIDATED raw
   * provider result from an earlier bounded claim's download step, when the
   * worker already has one for this exact job. Present only on the
   * "finalize" claim — the one whose entire job is to normalize/encode
   * these bytes into the production deliverable. A provider that sees this
   * populated MUST NOT contact the provider at all (no status check, no
   * download): it is the sole authority for this stage, mirroring
   * `existingIntermediateReconstruction`'s "trust the persisted evidence,
   * never re-derive it" contract.
   */
  existingDownloadedResult?: FinalArtworkProviderDownloadedResult | null;
}

/**
 * Bounded FinalArtwork Production-Execution Repair (short-step follow-up):
 * the raw bytes of a provider's finished (last-pass) reconstruction, already
 * downloaded and already validated as sufficient/proportional
 * (`validateReconstructedGeometry`) by an earlier bounded claim's download
 * step — but NOT YET normalized to the exact production canvas. Distinct
 * from `FinalArtworkProviderIntermediateReconstruction` (a two-pass job's
 * PASS 1 result, which still needs a PASS 2 provider submission): this is
 * the LAST pass' result, with zero further provider contact remaining.
 */
export interface FinalArtworkProviderDownloadedResult {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  /** True pre-transformation source pixel dimensions, carried through from the original claim that resolved the reconstruction plan. */
  nativeWidthPx: number;
  nativeHeightPx: number;
  providerRequestId: string;
}

export interface FinalArtworkProviderOutput {
  bytes: Buffer;
  contentType: string;
  /**
   * The produced file's actual pixel dimensions — the normalized artwork's
   * own dimensions (`normalization.outputWidthPx`/`outputHeightPx`), never a
   * fixed canvas the artwork was padded into.
   */
  widthPx: number;
  heightPx: number;
  /** Verified by actually scanning the output's alpha channel — never assumed (Goal 9). */
  hasTransparency: boolean;
  /** True pre-transformation source pixel dimensions — see `ResolutionProvenance`'s doc in print-validation/contracts.ts. */
  nativeWidthPx: number;
  nativeHeightPx: number;
  /**
   * Sprint 2M Phase 2E (Goal 4/5): the genuine provider-reconstructed pixel
   * dimensions, BEFORE the final deterministic canvas fit (contain +
   * transparent padding) — a third, distinct measurement from
   * `nativeWidthPx`/`nativeHeightPx` (the true original source) and
   * `widthPx`/`heightPx` (the final production canvas). `null` when the
   * provider performs no distinct reconstruction stage at all (e.g. local
   * raster interpolation only ever resamples straight to the final canvas —
   * there is no separate "reconstructed" size to report).
   */
  reconstructedWidthPx: number | null;
  reconstructedHeightPx: number | null;
  resolutionProvenance:
    | "native"
    | "interpolated_upscale"
    | "reconstructed"
    /**
     * Print'em All Phase 2: the plate's pixels are a halftone dot lattice
     * GENERATED at the final production dimensions. Distinct from all three
     * others — see `ResolutionProvenance` in print-validation/contracts.ts.
     */
    | "halftone_generated";
  /** Short, internal-only identifier for what produced these bytes — e.g. `"local_raster_contain_resample_v1"`. Never customer-facing. */
  transformationMethod: string;
  /**
   * Sprint 2M Phase 2C (Goal 8): declared honestly by the provider, never
   * assumed by the caller. `true` only when the output is provably a pure
   * geometric transform of the exact same source pixels (composition,
   * wording, colors all byte-identical modulo resampling) — the one case
   * where Concept Evaluation's already-persisted `required_wording`
   * criterion may honestly be treated as still valid for this production
   * asset. A provider that can redraw/regenerate/reconstruct content —
   * including Sprint 2M Phase 2E's Topaz Transparency Upscale, even though
   * the Phase 2D bake-off found it visually faithful on tested samples —
   * MUST report `false`, forcing `FinalArtworkWorkerCapability` to withhold
   * the source concept's Concept Evaluation from authoritative Print
   * Validation input and instead run independent production verification
   * (which correctly resolves `required_wording_verification` to
   * `"unknown"` → `finalization_required` until that independent
   * verification actually runs and passes, rather than silently inheriting
   * a verdict that may no longer be true).
   */
  preservesApprovedContent: boolean;
  /**
   * Sprint 2M Phase 2E: the paid provider's own request/job identifier, when
   * applicable — internal-only, never customer-facing, never logged as part
   * of a customer-visible surface. `null` for a provider with no paid
   * request concept (e.g. local raster interpolation).
   */
  providerRequestId: string | null;
  /**
   * Print-Ready Normalization Phase 1: the production transform's own
   * measurements — where the artwork actually was, the safety margin applied,
   * the intended physical print size, and the density written into the file.
   * `FinalArtworkWorkerCapability` persists this on the production asset and
   * hands it to authoritative Print Validation, which RECOMPUTES from it
   * rather than trusting any claim in it.
   */
  normalization: ProductionNormalizationMetadata;
  /**
   * Print'em All Phase 2: the halftone screen's own measurements, when this
   * provider applied one. `null`/absent for every continuous-tone provider —
   * there is no screen to describe, and inventing an empty one would make
   * "no halftone" and "a halftone nobody recorded" indistinguishable.
   *
   * Persisted on the production asset and handed to authoritative Print
   * Validation, which RECOMPUTES the screen's physical geometry from it in
   * exactly the same "verify, never trust" way it treats `normalization`.
   */
  halftone?: HalftoneScreenMetadata | null;
}

/**
 * Bounded FinalArtwork Production-Execution Repair (short-step follow-up):
 * the exact, centralized set of raw string values `FinalArtworkJob.providerStatus`
 * (and `FinalArtworkProviderResumeContext.providerStatus`) may durably hold
 * while a request is in flight through a bounded provider's short-step
 * pipeline. Centralized so no caller invents an equivalent magic string —
 * there is exactly one source of truth for what each stage name means.
 */
export const FINAL_ARTWORK_PROVIDER_STATUS = {
  /** A fresh paid submission was just accepted; not yet known complete. */
  submitted: "submitted",
  /**
   * The provider's OWN status endpoint reported completion, but the result
   * bytes have not yet been downloaded/persisted. The NEXT claim must
   * download — never re-check status, never resubmit.
   */
  resultReady: "result_ready",
  /**
   * A production asset has already been produced from this exact request.
   * Purely a diagnostic marker — the production asset's own existence
   * (`resolveExistingProductionAsset`) is what idempotency actually keys
   * off, never this string.
   */
  completed: "completed",
} as const;

export type FinalArtworkProviderStatusValue =
  (typeof FINAL_ARTWORK_PROVIDER_STATUS)[keyof typeof FINAL_ARTWORK_PROVIDER_STATUS];

/**
 * Bounded FinalArtwork Production-Execution Repair: the result of ONE
 * bounded unit of provider work — never a full submit-and-block-until-done
 * cycle, and never more than one of {submit-or-resume + one status check},
 * {one download}, or {local normalize/encode from an already-downloaded
 * result} per call. The caller persists whichever durable checkpoint each
 * outcome implies and returns, relying on a LATER invocation (an immediate
 * wake, or the recovery scheduler) to advance the next step, rather than
 * blocking the current one:
 *
 *   "pending"     — the provider's async job has not yet finished (or more
 *                    provider work remains, e.g. a two-pass job whose pass 1
 *                    just got persisted but pass 2 is not yet submitted).
 *   "result_ready" — the provider's status endpoint reported completion this
 *                    claim, but the result has not been downloaded yet. The
 *                    caller durably persists `providerStatus: "result_ready"`
 *                    and defers download to a later claim — never falls
 *                    through into downloading in the same invocation.
 *   "downloaded"   — this claim downloaded and geometry-validated the
 *                    provider's raw result, but has NOT normalized it to the
 *                    production canvas. The caller durably persists these
 *                    bytes as an internal intermediate asset and defers
 *                    normalize/upload to a later claim.
 *   "completed"    — the full `FinalArtworkProviderOutput`, ready to persist
 *                    as the production asset. Reached either by a provider
 *                    with no bounded/async concept (e.g. local raster
 *                    interpolation, via the `produce()` fallback) or by the
 *                    dedicated "finalize" claim that supplied
 *                    `existingDownloadedResult`.
 */
export type FinalArtworkProviderBoundedResult =
  | { status: "pending" }
  | { status: "result_ready"; providerRequestId: string }
  | ({ status: "downloaded" } & FinalArtworkProviderDownloadedResult)
  | ({ status: "completed" } & FinalArtworkProviderOutput);

export interface FinalArtworkProvider {
  readonly providerKey: string;
  produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput>;
  /**
   * Bounded FinalArtwork Production-Execution Repair (short-step follow-up):
   * an OPTIONAL bounded alternative to `produce()`. When present,
   * `FinalArtworkWorkerCapability` calls this instead of `produce()` — it
   * must perform AT MOST ONE of {submit-or-resume + one status check}, {one
   * download}, or {local normalize/encode of an already-downloaded result}
   * per call (see `FinalArtworkProviderBoundedResult`'s own doc for exactly
   * what each outcome means and durably implies), so a single HTTP worker
   * invocation can never be held open for the provider's full
   * submit/poll/download/normalize duration, and never spans more than one
   * of those stages.
   *
   * A provider with no asynchronous/paid-request concept (e.g. local raster
   * interpolation, which is already synchronous/instant) can omit this
   * entirely — the worker falls back to calling `produce()` directly, with
   * no change in behavior for that provider.
   *
   * Signs' own reconstruction paths (`SignReconstructionProvider`/
   * `SignReconstructionResumeProvider`) are untouched by this — this method
   * exists only on `FinalArtworkProvider`, the DTF-facing interface.
   */
  produceBounded?(
    input: FinalArtworkProviderInput,
  ): Promise<FinalArtworkProviderBoundedResult>;
}
