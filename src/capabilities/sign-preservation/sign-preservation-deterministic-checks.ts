/**
 * Signs Phase S4.1: pure, deterministic preservation-verification checks.
 *
 * No I/O, no capability imports (mirrors `sign-geometry.ts`'s own
 * discipline) — every function here takes already-decoded `RgbaImage`s and
 * already-resolved facts, and returns structured evidence. The orchestrating
 * `sign-preservation-capability.ts` is the only place that reads assets,
 * hashes bytes, or persists anything.
 *
 * NONE of these checks may ever conclude "preserved" — that vocabulary
 * value does not exist in this file's own result type
 * (`SignPreservationCheckResult`). `aggregateDeterministicEvidence`'s
 * overall status is hard-capped at `"unknown"` unless a catastrophic,
 * structural impossibility is independently proven, in which case it is
 * `"changed"`. Preserved is unreachable here by construction, not by
 * convention — Signs Phase S4.2's semantic verification is required before
 * that value can ever be written.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { resampleExact } from "@/capabilities/final-artwork/raster-transform";

import type {
  SignPreservationCheckResult,
  SignPreservationContentRegion,
  SignPreservationDeterministicEvidence,
  SignPreservationExtensionRegionEvidence,
  SignPreservationLineageEvidence,
  SignPreservationRegionMappingEvidence,
  SignPreservationRgbIntegrityEvidence,
  SignPreservationSimilarityEvidence,
} from "./contracts";
import { SIGN_PRESERVATION_ALGORITHM_VERSION } from "./contracts";

// ---------------------------------------------------------------------
// A. Lineage
// ---------------------------------------------------------------------

export interface LineageCheckInputs {
  sourceAssetExists: boolean;
  /** SHA-256 of the SOURCE asset's actual bytes, rehashed independently right now — never trusted from a caller claim. */
  rehashedSourceSha256: string;
  /** The approved plan's own recorded `sourceSha256`. */
  planSourceSha256: string;
  /** The final asset's own `rigidSign.sourceSha256` metadata claim. */
  finalAssetClaimedSourceSha256: string;
  /** Whether the final asset's `finalArtworkJobId` resolves to the SAME sign preparation this verification was asked about. */
  finalAssetBelongsToSignPreparation: boolean;
  /** The final asset's own `rigidSign.planKey` claim. */
  finalAssetPlanKey: string;
  /** The sign preparation's CURRENT `planKey`, read fresh. */
  currentPlanKey: string;
  /** The final asset's own `rigidSign.resolutionProvenance` claim. */
  resolutionProvenance: string;
  geometryAdapted: boolean;
  /** Whether `rigidSign.executionGeometry` is present (non-null). Required exactly when `geometryAdapted` is true. */
  executionEvidencePresent: boolean;
  intermediateAssetExists: boolean;
  /** Whether the intermediate's own `finalArtworkJobId` matches the final asset's. */
  intermediateAssetTiedToSameJob: boolean;
}

export function checkLineage(inputs: LineageCheckInputs): SignPreservationLineageEvidence {
  const sourceShaMatchesPlan = inputs.rehashedSourceSha256 === inputs.planSourceSha256;
  const sourceShaMatchesRehash =
    inputs.rehashedSourceSha256 === inputs.finalAssetClaimedSourceSha256;
  const finalAssetPlanKeyMatches = inputs.finalAssetPlanKey === inputs.currentPlanKey;
  const resolutionProvenanceIsReconstructed = inputs.resolutionProvenance === "reconstructed";
  const executionEvidencePresentWhenAdapted =
    !inputs.geometryAdapted || inputs.executionEvidencePresent;

  const reasons: string[] = [];
  if (!inputs.sourceAssetExists) reasons.push("The original source asset could not be found.");
  if (!sourceShaMatchesPlan) {
    reasons.push("The source asset's rehashed SHA-256 does not match the approved plan's own recorded source hash.");
  }
  if (!sourceShaMatchesRehash) {
    reasons.push("The source asset's rehashed SHA-256 does not match the final asset's own recorded source-lineage claim.");
  }
  if (!inputs.finalAssetBelongsToSignPreparation) {
    reasons.push("The final asset does not resolve back to the expected sign preparation.");
  }
  if (!finalAssetPlanKeyMatches) {
    reasons.push("The final asset's recorded planKey does not match the sign preparation's current planKey.");
  }
  if (!resolutionProvenanceIsReconstructed) {
    reasons.push('Preservation verification was requested against an asset whose resolutionProvenance is not "reconstructed".');
  }
  if (!executionEvidencePresentWhenAdapted) {
    reasons.push("Adaptive geometry was recorded (geometryAdapted=true) but no executionGeometry evidence is present.");
  }
  if (!inputs.intermediateAssetExists) reasons.push("No reconstruction-intermediate asset could be found.");
  if (!inputs.intermediateAssetTiedToSameJob) {
    reasons.push("The reconstruction-intermediate asset is not tied to the same final-artwork job as the final asset.");
  }

  const allOk =
    inputs.sourceAssetExists &&
    sourceShaMatchesPlan &&
    sourceShaMatchesRehash &&
    inputs.finalAssetBelongsToSignPreparation &&
    finalAssetPlanKeyMatches &&
    resolutionProvenanceIsReconstructed &&
    executionEvidencePresentWhenAdapted &&
    inputs.intermediateAssetExists &&
    inputs.intermediateAssetTiedToSameJob;

  const result: SignPreservationCheckResult = allOk ? "pass" : "unknown";

  return {
    result,
    sourceAssetExists: inputs.sourceAssetExists,
    sourceShaMatchesPlan,
    sourceShaMatchesRehash,
    finalAssetBelongsToSignPreparation: inputs.finalAssetBelongsToSignPreparation,
    finalAssetPlanKeyMatches,
    resolutionProvenanceIsReconstructed,
    executionEvidencePresentWhenAdapted,
    intermediateAssetExists: inputs.intermediateAssetExists,
    intermediateAssetTiedToSameJob: inputs.intermediateAssetTiedToSameJob,
    reasons,
  };
}

// ---------------------------------------------------------------------
// B. Region mapping
// ---------------------------------------------------------------------

export interface PadStepGeometry {
  axis: "horizontal" | "vertical";
  leadingPx: number;
  trailingPx: number;
  colorR: number | null;
  colorG: number | null;
  colorB: number | null;
}

export interface RegionMappingInputs {
  finalWidthPx: number;
  finalHeightPx: number;
  reconstructedWidthPx: number;
  reconstructedHeightPx: number;
  /** From `rigidSign.executionGeometry.executedStep`, when `geometryAdapted` is true. */
  executedPadStep: PadStepGeometry | null;
  /** From the approved PLAN's own pad/extend step, used ONLY when `executedPadStep` is null (no adaptation occurred, so the plan's own unmodified step governs). */
  plannedPadStep: PadStepGeometry | null;
}

/**
 * Derives the customer-content region entirely from ALREADY-PERSISTED
 * evidence — never a new field, never guessed. Mirrors exactly what the
 * production executor itself computed, so a disagreement here is itself
 * evidence of a problem, not a false alarm.
 */
export function deriveContentRegion(
  inputs: RegionMappingInputs,
): SignPreservationRegionMappingEvidence {
  const reasons: string[] = [];
  const step = inputs.executedPadStep ?? inputs.plannedPadStep;
  const derivedFrom: SignPreservationRegionMappingEvidence["derivedFrom"] = inputs.executedPadStep
    ? "execution_geometry"
    : inputs.plannedPadStep
      ? "plan_step"
      : "no_extension_step";

  let contentRegion: SignPreservationContentRegion | null;
  if (step) {
    contentRegion =
      step.axis === "horizontal"
        ? {
            x: step.leadingPx,
            y: 0,
            width: inputs.reconstructedWidthPx,
            height: inputs.reconstructedHeightPx,
          }
        : {
            x: 0,
            y: step.leadingPx,
            width: inputs.reconstructedWidthPx,
            height: inputs.reconstructedHeightPx,
          };
  } else {
    // No pad/extend step at all — the reconstruction alone reached the
    // ordered aspect, so the content region is the entire final canvas.
    contentRegion = {
      x: 0,
      y: 0,
      width: inputs.reconstructedWidthPx,
      height: inputs.reconstructedHeightPx,
    };
  }

  const regionFitsWithinFinalCanvas =
    contentRegion.x >= 0 &&
    contentRegion.y >= 0 &&
    contentRegion.x + contentRegion.width <= inputs.finalWidthPx &&
    contentRegion.y + contentRegion.height <= inputs.finalHeightPx;
  if (!regionFitsWithinFinalCanvas) {
    reasons.push("The derived content region does not fit inside the final asset's own dimensions.");
  }

  const regionDimensionsMatchReconstruction =
    contentRegion.width === inputs.reconstructedWidthPx &&
    contentRegion.height === inputs.reconstructedHeightPx;
  if (!regionDimensionsMatchReconstruction) {
    reasons.push("The derived content region's dimensions do not match the recorded reconstruction dimensions — possible unexplained crop.");
  }

  const result: SignPreservationCheckResult =
    regionFitsWithinFinalCanvas && regionDimensionsMatchReconstruction ? "pass" : "unknown";

  return {
    result,
    finalWidthPx: inputs.finalWidthPx,
    finalHeightPx: inputs.finalHeightPx,
    contentRegion,
    derivedFrom,
    regionFitsWithinFinalCanvas,
    regionDimensionsMatchReconstruction,
    reasons,
  };
}

// ---------------------------------------------------------------------
// C. Reconstruction -> final RGB integrity
// ---------------------------------------------------------------------

/**
 * Compares the persisted reconstruction-intermediate's own RGB bytes
 * (never the final asset's alpha-normalized copy — the intermediate is
 * never rewritten, Signs Phase S3D) against the final asset's content
 * region. RGB ONLY — alpha is deliberately ignored, since Signs Phase
 * S3D's own contract is alpha-only normalization (`rgbModified: false`);
 * this check independently PROVES that claim rather than trusting it.
 *
 * Zero tolerance: padding never resamples the content region, so ANY RGB
 * mismatch here is structural/catastrophic evidence, never an ordinary
 * "concern".
 */
export function checkReconstructionToFinalRgb(
  reconstructionImage: RgbaImage,
  finalImage: RgbaImage,
  contentRegion: SignPreservationContentRegion | null,
): SignPreservationRgbIntegrityEvidence {
  const reasons: string[] = [];
  if (!contentRegion) {
    reasons.push("No content region was derivable — RGB integrity cannot be checked.");
    return {
      result: "unknown",
      compared: false,
      reconstructionWidthPx: reconstructionImage.width,
      reconstructionHeightPx: reconstructionImage.height,
      contentRegionWidthPx: null,
      contentRegionHeightPx: null,
      mismatchedPixelCount: 0,
      maxChannelDelta: 0,
      reasons,
    };
  }

  if (
    reconstructionImage.width !== contentRegion.width ||
    reconstructionImage.height !== contentRegion.height
  ) {
    // The currently-implemented reconstructed + padding path never
    // resamples content — a dimension mismatch here means either a
    // lineage contradiction or a not-yet-supported transform. Fail
    // closed rather than assume a resample happened.
    reasons.push(
      "The reconstruction's own dimensions do not match the derived content region's dimensions — cannot prove RGB integrity without assuming an unverified resample.",
    );
    return {
      result: "unknown",
      compared: false,
      reconstructionWidthPx: reconstructionImage.width,
      reconstructionHeightPx: reconstructionImage.height,
      contentRegionWidthPx: contentRegion.width,
      contentRegionHeightPx: contentRegion.height,
      mismatchedPixelCount: 0,
      maxChannelDelta: 0,
      reasons,
    };
  }

  let mismatchedPixelCount = 0;
  let maxChannelDelta = 0;
  const { width, height } = contentRegion;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const reconIdx = (y * reconstructionImage.width + x) * 4;
      const finalIdx = ((contentRegion.y + y) * finalImage.width + (contentRegion.x + x)) * 4;
      let pixelMismatched = false;
      for (let c = 0; c < 3; c += 1) {
        const delta = Math.abs(
          reconstructionImage.data[reconIdx + c] - finalImage.data[finalIdx + c],
        );
        if (delta > 0) pixelMismatched = true;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
      if (pixelMismatched) mismatchedPixelCount += 1;
    }
  }

  if (mismatchedPixelCount > 0) {
    reasons.push(
      `${mismatchedPixelCount} pixel(s) in the final asset's content region have RGB values that differ from the persisted reconstruction — unexpected, since padding/normalization never modifies RGB.`,
    );
  }

  return {
    result: mismatchedPixelCount === 0 ? "pass" : "catastrophic",
    compared: true,
    reconstructionWidthPx: reconstructionImage.width,
    reconstructionHeightPx: reconstructionImage.height,
    contentRegionWidthPx: contentRegion.width,
    contentRegionHeightPx: contentRegion.height,
    mismatchedPixelCount,
    maxChannelDelta,
    reasons,
  };
}

// ---------------------------------------------------------------------
// D. Extension-region verification
// ---------------------------------------------------------------------

/**
 * Verifies EVERY pixel (not a sample) outside the content region against
 * the approved fill colour — exact RGB match and alpha=255, since the
 * deterministic padding step is supposed to be 100% exact by construction.
 * Never judges the seam aesthetically (that is review-risk approval's
 * concern, Signs Phase S4.3) — this only proves the authorized deterministic
 * background regions were produced correctly.
 */
export function checkExtensionRegions(
  finalImage: RgbaImage,
  contentRegion: SignPreservationContentRegion | null,
  approvedFillRgb: { r: number; g: number; b: number } | null,
): SignPreservationExtensionRegionEvidence {
  const reasons: string[] = [];
  if (!contentRegion) {
    reasons.push("No content region was derivable — extension regions cannot be checked.");
    return {
      result: "unknown",
      regionsChecked: 0,
      totalExtensionPixels: 0,
      mismatchedPixelCount: 0,
      approvedFillRgb,
      reasons,
    };
  }
  if (!approvedFillRgb) {
    // No pad/extend step in the plan at all — nothing to verify, and
    // correctly so (the content region already covers the whole canvas).
    const noExtensionExists =
      contentRegion.x === 0 &&
      contentRegion.y === 0 &&
      contentRegion.width === finalImage.width &&
      contentRegion.height === finalImage.height;
    if (noExtensionExists) {
      return {
        result: "pass",
        regionsChecked: 0,
        totalExtensionPixels: 0,
        mismatchedPixelCount: 0,
        approvedFillRgb: null,
        reasons: [],
      };
    }
    reasons.push("An extension region exists but no approved fill colour could be determined.");
    return {
      result: "unknown",
      regionsChecked: 0,
      totalExtensionPixels: 0,
      mismatchedPixelCount: 0,
      approvedFillRgb: null,
      reasons,
    };
  }

  const rects: SignPreservationContentRegion[] = [];
  // Horizontal extension (left/right of content).
  if (contentRegion.x > 0) {
    rects.push({ x: 0, y: 0, width: contentRegion.x, height: finalImage.height });
  }
  const rightX = contentRegion.x + contentRegion.width;
  if (rightX < finalImage.width) {
    rects.push({ x: rightX, y: 0, width: finalImage.width - rightX, height: finalImage.height });
  }
  // Vertical extension (above/below content).
  if (contentRegion.y > 0) {
    rects.push({ x: 0, y: 0, width: finalImage.width, height: contentRegion.y });
  }
  const bottomY = contentRegion.y + contentRegion.height;
  if (bottomY < finalImage.height) {
    rects.push({ x: 0, y: bottomY, width: finalImage.width, height: finalImage.height - bottomY });
  }

  let totalExtensionPixels = 0;
  let mismatchedPixelCount = 0;
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        totalExtensionPixels += 1;
        const idx = (y * finalImage.width + x) * 4;
        const r = finalImage.data[idx];
        const g = finalImage.data[idx + 1];
        const b = finalImage.data[idx + 2];
        const a = finalImage.data[idx + 3];
        if (r !== approvedFillRgb.r || g !== approvedFillRgb.g || b !== approvedFillRgb.b || a !== 255) {
          mismatchedPixelCount += 1;
        }
      }
    }
  }

  if (mismatchedPixelCount > 0) {
    reasons.push(
      `${mismatchedPixelCount} of ${totalExtensionPixels} extension pixel(s) did not exactly match the approved fill colour (or were not fully opaque).`,
    );
  }

  return {
    result: mismatchedPixelCount === 0 ? "pass" : "catastrophic",
    regionsChecked: rects.length,
    totalExtensionPixels,
    mismatchedPixelCount,
    approvedFillRgb,
    reasons,
  };
}

// ---------------------------------------------------------------------
// E. Source <-> reconstruction similarity (ADVISORY evidence only)
// ---------------------------------------------------------------------

/**
 * ADVISORY ONLY. Ordinary similarity scores never independently authorize
 * or reject customer content (a changed price cannot be detected this
 * way) — this exists purely as bounded, auditable evidence, and as a
 * circuit breaker for genuinely catastrophic, structurally-obvious
 * mismatches. The floor below is deliberately set at the extreme tail,
 * calibrated against exactly one real acceptance case (Ruth) — treat it as
 * provisional until a larger real corpus exists (see S4 architecture
 * audit's own "Risks/open questions").
 */
const CATASTROPHIC_MEAN_ABSOLUTE_ERROR_FLOOR = 220; // out of 255 — "almost entirely different colours everywhere"
const SIMILARITY_TILE_GRID_SIZE = 16;

export function checkSourceSimilarity(
  sourceImage: RgbaImage,
  reconstructionContentImage: RgbaImage,
): SignPreservationSimilarityEvidence {
  const reasons: string[] = [];
  const scaleX = reconstructionContentImage.width / sourceImage.width;
  const scaleY = reconstructionContentImage.height / sourceImage.height;
  const isExactIntegerScale =
    Number.isInteger(scaleX) && Number.isInteger(scaleY) && scaleX === scaleY && scaleX > 0;

  if (!isExactIntegerScale) {
    reasons.push(
      "The reconstruction is not an exact integer multiple of the source dimensions — similarity evidence is unavailable, not guessed.",
    );
    return {
      result: "unknown",
      computed: false,
      scaleFactor: null,
      globalMeanAbsoluteError: null,
      worstTileMeanAbsoluteError: null,
      tileGridSize: null,
      reasons,
    };
  }

  const { image: downsampled } = resampleExact(
    reconstructionContentImage,
    sourceImage.width,
    sourceImage.height,
  );

  let totalError = 0;
  const tileCols = Math.max(1, Math.ceil(sourceImage.width / SIMILARITY_TILE_GRID_SIZE));
  const tileRows = Math.max(1, Math.ceil(sourceImage.height / SIMILARITY_TILE_GRID_SIZE));
  const tileErrorSums = new Array<number>(tileCols * tileRows).fill(0);
  const tilePixelCounts = new Array<number>(tileCols * tileRows).fill(0);

  for (let y = 0; y < sourceImage.height; y += 1) {
    const tileRow = Math.min(tileRows - 1, Math.floor(y / SIMILARITY_TILE_GRID_SIZE));
    for (let x = 0; x < sourceImage.width; x += 1) {
      const tileCol = Math.min(tileCols - 1, Math.floor(x / SIMILARITY_TILE_GRID_SIZE));
      const tileIdx = tileRow * tileCols + tileCol;
      const srcIdx = (y * sourceImage.width + x) * 4;
      const dsIdx = (y * downsampled.width + x) * 4;
      const pixelError =
        (Math.abs(sourceImage.data[srcIdx] - downsampled.data[dsIdx]) +
          Math.abs(sourceImage.data[srcIdx + 1] - downsampled.data[dsIdx + 1]) +
          Math.abs(sourceImage.data[srcIdx + 2] - downsampled.data[dsIdx + 2])) /
        3;
      totalError += pixelError;
      tileErrorSums[tileIdx] += pixelError;
      tilePixelCounts[tileIdx] += 1;
    }
  }

  const totalPixels = sourceImage.width * sourceImage.height;
  const globalMeanAbsoluteError = totalError / totalPixels;
  let worstTileMeanAbsoluteError = 0;
  for (let i = 0; i < tileErrorSums.length; i += 1) {
    if (tilePixelCounts[i] === 0) continue;
    const tileMae = tileErrorSums[i] / tilePixelCounts[i];
    if (tileMae > worstTileMeanAbsoluteError) worstTileMeanAbsoluteError = tileMae;
  }

  const catastrophic = globalMeanAbsoluteError >= CATASTROPHIC_MEAN_ABSOLUTE_ERROR_FLOOR;
  if (catastrophic) {
    reasons.push(
      `Global mean absolute colour error (${globalMeanAbsoluteError.toFixed(1)}/255) exceeds the extreme, conservative catastrophic floor — content appears structurally unrecognizable, not merely different in detail.`,
    );
  } else {
    reasons.push(
      `Global mean absolute colour error ${globalMeanAbsoluteError.toFixed(1)}/255, worst tile ${worstTileMeanAbsoluteError.toFixed(1)}/255 — advisory evidence only, never sole preservation authority.`,
    );
  }

  return {
    result: catastrophic ? "catastrophic" : "concern",
    computed: true,
    scaleFactor: scaleX,
    globalMeanAbsoluteError,
    worstTileMeanAbsoluteError,
    tileGridSize: SIMILARITY_TILE_GRID_SIZE,
    reasons,
  };
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

export function aggregateDeterministicEvidence(parts: {
  lineage: SignPreservationLineageEvidence;
  regionMapping: SignPreservationRegionMappingEvidence;
  reconstructionToFinalRgb: SignPreservationRgbIntegrityEvidence;
  extensionRegions: SignPreservationExtensionRegionEvidence;
  sourceSimilarity: SignPreservationSimilarityEvidence;
}): SignPreservationDeterministicEvidence {
  const results = [
    parts.lineage.result,
    parts.regionMapping.result,
    parts.reconstructionToFinalRgb.result,
    parts.extensionRegions.result,
    parts.sourceSimilarity.result,
  ];
  const catastrophicAnomalyDetected = results.includes("catastrophic");

  // Every sub-check's own reasons, concatenated in full — including the
  // similarity check's advisory-only reason string when nothing is wrong.
  // This is a bounded audit trail, not a "problems only" list.
  const concerns: string[] = [
    ...parts.lineage.reasons,
    ...parts.regionMapping.reasons,
    ...parts.reconstructionToFinalRgb.reasons,
    ...parts.extensionRegions.reasons,
    ...parts.sourceSimilarity.reasons,
  ];

  return {
    schemaVersion: SIGN_PRESERVATION_ALGORITHM_VERSION,
    lineage: parts.lineage,
    regionMapping: parts.regionMapping,
    reconstructionToFinalRgb: parts.reconstructionToFinalRgb,
    extensionRegions: parts.extensionRegions,
    sourceSimilarity: parts.sourceSimilarity,
    catastrophicAnomalyDetected,
    concerns,
  };
}

/**
 * S4.1's own hard invariant: deterministic evidence alone may resolve to
 * `"changed"` (a proven structural impossibility) or `"unknown"` (the
 * fail-closed default) — NEVER `"preserved"`. Signs Phase S4.2's semantic
 * verification is required before that value can ever be produced.
 */
export function overallStatusFromDeterministicEvidence(
  evidence: SignPreservationDeterministicEvidence,
): "changed" | "unknown" {
  return evidence.catastrophicAnomalyDetected ? "changed" : "unknown";
}
