/**
 * Signs Phase S4.1: deterministic preservation-verification evidence
 * shapes. Pure data — no I/O, no capability imports, mirroring the
 * `capability-boundaries.ts` discipline `print-validation/contracts.ts`
 * already follows for `RigidSignPlanEvidence`/`HalftoneProductionEvidence`.
 *
 * See `SignPreservationVerification`'s own doc comment
 * (`src/lib/domain/types.ts`) for the four-authority model this evidence is
 * exactly one part of, and `sign-preservation-deterministic-checks.ts` for
 * the functions that produce it.
 */

/** Explicit staleness lever — bump on any change to the deterministic-check algorithm below, forcing every prior verification to be re-run. */
export const SIGN_PRESERVATION_ALGORITHM_VERSION = "sign-preservation-deterministic:v1";

/**
 * One deterministic check's own verdict, deliberately distinct from the
 * OVERALL `SignPreservationStatus` — a single "concern" or even a
 * "catastrophic" sub-result does not by itself dictate the aggregate
 * (`aggregateDeterministicResult` below does that, conservatively).
 */
export type SignPreservationCheckResult = "pass" | "concern" | "catastrophic" | "unknown";

export interface SignPreservationLineageEvidence {
  result: SignPreservationCheckResult;
  sourceAssetExists: boolean;
  sourceShaMatchesPlan: boolean;
  sourceShaMatchesRehash: boolean;
  finalAssetBelongsToSignPreparation: boolean;
  finalAssetPlanKeyMatches: boolean;
  resolutionProvenanceIsReconstructed: boolean;
  executionEvidencePresentWhenAdapted: boolean;
  intermediateAssetExists: boolean;
  intermediateAssetTiedToSameJob: boolean;
  reasons: string[];
}

export interface SignPreservationContentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignPreservationRegionMappingEvidence {
  result: SignPreservationCheckResult;
  finalWidthPx: number;
  finalHeightPx: number;
  contentRegion: SignPreservationContentRegion | null;
  /** How the content region was derived — never a new persisted field, always re-derived from already-persisted evidence. */
  derivedFrom: "execution_geometry" | "plan_step" | "no_extension_step" | "unavailable";
  regionFitsWithinFinalCanvas: boolean;
  regionDimensionsMatchReconstruction: boolean;
  reasons: string[];
}

export interface SignPreservationRgbIntegrityEvidence {
  result: SignPreservationCheckResult;
  compared: boolean;
  reconstructionWidthPx: number | null;
  reconstructionHeightPx: number | null;
  contentRegionWidthPx: number | null;
  contentRegionHeightPx: number | null;
  /** Pixels whose R, G, or B channel differed between the reconstruction and the final content region. Any non-zero count is catastrophic — padding/normalization never resamples content. */
  mismatchedPixelCount: number;
  maxChannelDelta: number;
  reasons: string[];
}

export interface SignPreservationExtensionRegionEvidence {
  result: SignPreservationCheckResult;
  regionsChecked: number;
  totalExtensionPixels: number;
  /** Pixels in an extension region whose RGB did not exactly match the approved fill colour, or whose alpha was not exactly 255. */
  mismatchedPixelCount: number;
  approvedFillRgb: { r: number; g: number; b: number } | null;
  reasons: string[];
}

export interface SignPreservationSimilarityEvidence {
  result: SignPreservationCheckResult;
  /** `false` when the source/reconstruction dimensions are not an exact integer multiple — this evidence bucket is then simply unavailable, never guessed. */
  computed: boolean;
  scaleFactor: number | null;
  globalMeanAbsoluteError: number | null;
  worstTileMeanAbsoluteError: number | null;
  tileGridSize: number | null;
  reasons: string[];
}

/**
 * The full, versioned, bounded deterministic-evidence payload persisted on
 * `SignPreservationVerification.deterministicEvidence`. Deliberately no
 * per-pixel arrays anywhere in this shape — every field is a scalar,
 * boolean, small enum, or a short reasons list.
 */
export interface SignPreservationDeterministicEvidence {
  schemaVersion: typeof SIGN_PRESERVATION_ALGORITHM_VERSION;
  lineage: SignPreservationLineageEvidence;
  regionMapping: SignPreservationRegionMappingEvidence;
  reconstructionToFinalRgb: SignPreservationRgbIntegrityEvidence;
  extensionRegions: SignPreservationExtensionRegionEvidence;
  sourceSimilarity: SignPreservationSimilarityEvidence;
  /** `true` only when a deterministic check independently proved a structural impossibility — never set from ordinary similarity alone. */
  catastrophicAnomalyDetected: boolean;
  concerns: string[];
}
