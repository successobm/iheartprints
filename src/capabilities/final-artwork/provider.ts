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
  /** Last known raw provider status string, if any — informational only. */
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
   * Sprint 2M Phase 2E (Goal 3): called exactly once, synchronously, the
   * instant a NEW paid request is actually submitted to an external
   * provider — before any polling begins. The caller persists this
   * durably (`FinalArtworkJob.providerRequestId`) so a worker crash between
   * submission and completion is resumable on retry without a second paid
   * call. Must never be called when resuming `existingProviderRequest`, and
   * is safely optional/ignorable for a provider with no paid-request
   * concept.
   */
  onProviderRequestSubmitted?: (providerRequestId: string) => Promise<void>;
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

export interface FinalArtworkProvider {
  readonly providerKey: string;
  produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput>;
}
