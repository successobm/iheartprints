/**
 * Sprint 2M Phase 2C (Goal 6): provider-neutral raster production
 * transformation boundary. `FinalArtworkWorkerCapability` (domain code)
 * depends only on this interface — it must never know whether the
 * implementation is a local deterministic resample, a future provider-
 * hosted reconstruction, or anything else. Mirrors `ConceptGenerationProvider`
 * / `ConceptEvaluationProvider`'s "provider owns 100% of its own mechanism;
 * domain code sees only provider-neutral input/output" shape.
 */

export interface FinalArtworkProviderInput {
  sourceBytes: Buffer;
  sourceContentType: string;
  /** Target production canvas, in pixels — already resolved by the caller from `ProductionRequirements`. */
  targetWidthPx: number;
  targetHeightPx: number;
  /** Safe-margin-from-edge, as a fraction (0–1) of the target canvas — from `ProductionRequirements.artworkBoundaryMarginPercent`. */
  marginFraction: number;
}

export interface FinalArtworkProviderOutput {
  bytes: Buffer;
  contentType: string;
  /** The produced file's actual pixel dimensions — always exactly `targetWidthPx`x`targetHeightPx`. */
  widthPx: number;
  heightPx: number;
  /** Verified by actually scanning the output's alpha channel — never assumed (Goal 9). */
  hasTransparency: boolean;
  /** True pre-transformation source pixel dimensions — see `ResolutionProvenance`'s doc in print-validation/contracts.ts. */
  nativeWidthPx: number;
  nativeHeightPx: number;
  resolutionProvenance: "native" | "interpolated_upscale";
  /** Short, internal-only identifier for what produced these bytes — e.g. `"local_raster_contain_resample_v1"`. Never customer-facing. */
  transformationMethod: string;
  /**
   * Sprint 2M Phase 2C (Goal 8): declared honestly by the provider, never
   * assumed by the caller. `true` only when the output is provably a pure
   * geometric transform of the exact same source pixels (composition,
   * wording, colors all byte-identical modulo resampling) — the one case
   * where Concept Evaluation's already-persisted `required_wording`
   * criterion may honestly be treated as still valid for this production
   * asset. A future provider that can redraw/regenerate content must report
   * `false`, forcing `FinalArtworkWorkerCapability` to withhold the
   * concept's evaluation from authoritative Print Validation input (which
   * makes `required_wording_verification` correctly resolve `"unknown"` →
   * `finalization_required` rather than silently inheriting a verdict that
   * may no longer be true).
   */
  preservesApprovedContent: boolean;
}

export interface FinalArtworkProvider {
  readonly providerKey: string;
  produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput>;
}
