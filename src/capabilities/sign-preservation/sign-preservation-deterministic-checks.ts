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
import { resolveProportionalReconstructionScale } from "./sign-preservation-geometry";

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
  /**
   * What the asset's OWN plan actually required — `"reconstructed"` for a
   * plan needing `reconstruct_resolution`, `"native"` otherwise (including
   * a `reconstruct_perimeter_structure`-only plan, which never dispatches a
   * provider and truthfully stays native). Computed by the caller from the
   * plan's own steps, never guessed here.
   */
  expectedResolutionProvenance: "reconstructed" | "native";
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
  const resolutionProvenanceConsistentWithPlan =
    inputs.resolutionProvenance === inputs.expectedResolutionProvenance;
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
  if (!resolutionProvenanceConsistentWithPlan) {
    reasons.push(
      `The final asset's resolutionProvenance ("${inputs.resolutionProvenance}") does not match what its own plan required ("${inputs.expectedResolutionProvenance}").`,
    );
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
    resolutionProvenanceConsistentWithPlan &&
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
    resolutionProvenanceConsistentWithPlan,
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

export interface ParametricFrameRegionMappingInputs {
  finalWidthPx: number;
  finalHeightPx: number;
  /** The dimensions of the asset `reconstruct_parametric_frame` actually ran against — the Topaz intermediate when combined with `reconstruct_resolution`, otherwise the source itself. */
  intermediateWidthPx: number;
  intermediateHeightPx: number;
  axis: "horizontal" | "vertical";
  leadingPx: number;
  trailingPx: number;
  /** The frame model's own measured band depths, already scaled to the intermediate's resolution — `frameDepthPxScaled` from `scaleFrameModel`. */
  frameDepthPxScaled: number;
}

/**
 * `deriveContentRegion`'s own `regionDimensionsMatchReconstruction`
 * invariant (content region dims === reconstruction dims) does not hold for
 * `reconstruct_parametric_frame`: that step CROPS the interior away from the
 * old frame band before redrawing at the new boundary, so the protected
 * interior is by design a strictly SMALLER sub-rectangle than the
 * intermediate it was cropped from. This mirrors
 * `sign-transform-executor.ts`'s own `executeReconstructParametricFrame`
 * interior-placement arithmetic exactly (duplicated, never imported, the
 * same discipline every other check in this file already follows).
 */
export function deriveParametricFrameContentRegion(
  inputs: ParametricFrameRegionMappingInputs,
): SignPreservationRegionMappingEvidence {
  const reasons: string[] = [];
  const interiorWidth = inputs.intermediateWidthPx - 2 * inputs.frameDepthPxScaled;
  const interiorHeight = inputs.intermediateHeightPx - 2 * inputs.frameDepthPxScaled;
  const positiveInteriorArea = interiorWidth > 0 && interiorHeight > 0;
  if (!positiveInteriorArea) {
    reasons.push("The scaled frame depth leaves no positive-area protected interior to derive a content region from.");
    return {
      result: "unknown",
      finalWidthPx: inputs.finalWidthPx,
      finalHeightPx: inputs.finalHeightPx,
      contentRegion: null,
      derivedFrom: "execution_geometry",
      regionFitsWithinFinalCanvas: false,
      regionDimensionsMatchReconstruction: false,
      reasons,
    };
  }

  const interiorOffsetX =
    inputs.axis === "horizontal" ? inputs.leadingPx + inputs.frameDepthPxScaled : inputs.frameDepthPxScaled;
  const interiorOffsetY =
    inputs.axis === "vertical" ? inputs.leadingPx + inputs.frameDepthPxScaled : inputs.frameDepthPxScaled;
  const contentRegion: SignPreservationContentRegion = {
    x: interiorOffsetX,
    y: interiorOffsetY,
    width: interiorWidth,
    height: interiorHeight,
  };

  const regionFitsWithinFinalCanvas =
    contentRegion.x >= 0 &&
    contentRegion.y >= 0 &&
    contentRegion.x + contentRegion.width <= inputs.finalWidthPx &&
    contentRegion.y + contentRegion.height <= inputs.finalHeightPx;
  if (!regionFitsWithinFinalCanvas) {
    reasons.push("The derived content region does not fit inside the final asset's own dimensions.");
  }

  // The reconstruction-dims-match invariant `deriveContentRegion` enforces
  // does not apply to this step by design (see doc comment above) — the
  // analogous structural invariant here is that the interior is STRICTLY
  // smaller than the intermediate it was cropped from on at least one axis,
  // proving the old frame band was actually discarded rather than merely
  // padded around.
  const regionDimensionsMatchReconstruction =
    contentRegion.width < inputs.intermediateWidthPx || contentRegion.height < inputs.intermediateHeightPx;
  if (!regionDimensionsMatchReconstruction) {
    reasons.push("The derived content region is not strictly smaller than the intermediate it was cropped from — the old frame band may not have been discarded.");
  }

  const result: SignPreservationCheckResult =
    regionFitsWithinFinalCanvas && regionDimensionsMatchReconstruction ? "pass" : "unknown";

  return {
    result,
    finalWidthPx: inputs.finalWidthPx,
    finalHeightPx: inputs.finalHeightPx,
    contentRegion,
    derivedFrom: "execution_geometry",
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

/**
 * Semantic Worker Wiring Phase: the `reconstruct_perimeter_structure`
 * sibling of `checkExtensionRegions` above — same "verify EVERY pixel, not
 * a sample" discipline, but against a TILED expected colour per line
 * rather than one flat fill, since that step's own extension region is
 * never a single colour by construction.
 *
 * The tiling formula is deliberately duplicated from `sign-preparation/
 * perimeter-reconstruction.ts`'s `tiledRowColor` (never imported — this
 * module resolves every fact independently, the same discipline
 * `readPadStepFromParams` already follows for step shape) — both compute
 * the identical `(depth - 1 - (distance % depth) + depth) % depth`
 * periodic index into the measured rows.
 */
function tiledRowColorAt(
  rows: { r: number; g: number; b: number }[],
  distanceFromContentPx: number,
): { r: number; g: number; b: number } {
  const depth = rows.length;
  const index = (depth - 1 - (distanceFromContentPx % depth) + depth) % depth;
  return rows[index]!;
}

export function checkPerimeterTileExtensionRegions(
  finalImage: RgbaImage,
  contentRegion: SignPreservationContentRegion | null,
  axis: "horizontal" | "vertical" | null,
  leadingPx: number | null,
  trailingPx: number | null,
  leadingRows: { r: number; g: number; b: number }[] | null,
  trailingRows: { r: number; g: number; b: number }[] | null,
): SignPreservationExtensionRegionEvidence {
  const reasons: string[] = [];
  if (!contentRegion) {
    reasons.push("No content region was derivable — extension regions cannot be checked.");
    return { result: "unknown", regionsChecked: 0, totalExtensionPixels: 0, mismatchedPixelCount: 0, approvedFillRgb: null, reasons };
  }
  if (!axis || leadingPx === null || trailingPx === null || !leadingRows?.length || !trailingRows?.length) {
    reasons.push("The reconstructed perimeter's own measured band rows could not be resolved — extension regions cannot be checked.");
    return { result: "unknown", regionsChecked: 0, totalExtensionPixels: 0, mismatchedPixelCount: 0, approvedFillRgb: null, reasons };
  }

  let totalExtensionPixels = 0;
  let mismatchedPixelCount = 0;
  let regionsChecked = 0;

  function checkPixel(x: number, y: number, expected: { r: number; g: number; b: number }): void {
    totalExtensionPixels += 1;
    const idx = (y * finalImage.width + x) * 4;
    const r = finalImage.data[idx];
    const g = finalImage.data[idx + 1];
    const b = finalImage.data[idx + 2];
    const a = finalImage.data[idx + 3];
    if (r !== expected.r || g !== expected.g || b !== expected.b || a !== 255) {
      mismatchedPixelCount += 1;
    }
  }

  if (axis === "vertical") {
    if (leadingPx > 0) {
      regionsChecked += 1;
      for (let y = 0; y < leadingPx; y += 1) {
        const color = tiledRowColorAt(leadingRows, leadingPx - 1 - y);
        for (let x = 0; x < finalImage.width; x += 1) checkPixel(x, y, color);
      }
    }
    const bottomY = contentRegion.y + contentRegion.height;
    if (trailingPx > 0) {
      regionsChecked += 1;
      for (let y = 0; y < trailingPx; y += 1) {
        const color = tiledRowColorAt(trailingRows, y);
        for (let x = 0; x < finalImage.width; x += 1) checkPixel(x, bottomY + y, color);
      }
    }
  } else {
    if (leadingPx > 0) {
      regionsChecked += 1;
      for (let x = 0; x < leadingPx; x += 1) {
        const color = tiledRowColorAt(leadingRows, leadingPx - 1 - x);
        for (let y = 0; y < finalImage.height; y += 1) checkPixel(x, y, color);
      }
    }
    const rightX = contentRegion.x + contentRegion.width;
    if (trailingPx > 0) {
      regionsChecked += 1;
      for (let x = 0; x < trailingPx; x += 1) {
        const color = tiledRowColorAt(trailingRows, x);
        for (let y = 0; y < finalImage.height; y += 1) checkPixel(rightX + x, y, color);
      }
    }
  }

  if (mismatchedPixelCount > 0) {
    reasons.push(
      `${mismatchedPixelCount} of ${totalExtensionPixels} tiled extension pixel(s) did not exactly match the expected measured colour (or were not fully opaque).`,
    );
  }

  return {
    result: mismatchedPixelCount === 0 ? "pass" : "catastrophic",
    regionsChecked,
    totalExtensionPixels,
    mismatchedPixelCount,
    // No SINGLE approved fill colour exists for a tiled reconstruction —
    // the measured rows themselves are the approval, not one RGB triple.
    approvedFillRgb: null,
    reasons,
  };
}

// ---------------------------------------------------------------------
// D.2 Parametric Perimeter Frame Reconstruction Phase: verifies every
// pixel OUTSIDE the content region against the plan's own already-
// measured, already-scaled frame model — the `reconstruct_parametric_frame`
// sibling of `checkPerimeterTileExtensionRegions` above. Deliberately
// duplicates `sign-preparation/frame-structure-model.ts`'s rounded-rect
// depth formula and band lookup (never imported — this module resolves
// every fact independently, the same discipline every other check here
// already follows).
// ---------------------------------------------------------------------

export interface SignPreservationFrameBand {
  color: { r: number; g: number; b: number };
  thicknessPx: number;
}
export interface SignPreservationFrameHole {
  radiusPx: number;
  offsetFromCornerXPx: number;
  offsetFromCornerYPx: number;
  ringColor: { r: number; g: number; b: number };
  interiorColor: { r: number; g: number; b: number };
}

function parametricFrameDepthAt(x: number, y: number, w: number, h: number, radius: number): number | null {
  const inCornerX = x < radius ? radius - x : x > w - 1 - radius ? x - (w - 1 - radius) : 0;
  const inCornerY = y < radius ? radius - y : y > h - 1 - radius ? y - (h - 1 - radius) : 0;
  if (inCornerX > 0 && inCornerY > 0) {
    const dist = Math.sqrt(inCornerX * inCornerX + inCornerY * inCornerY);
    return dist > radius ? null : radius - dist;
  }
  return Math.min(x, y, w - 1 - x, h - 1 - y);
}

/**
 * Parametric Frame Geometry Defect Correction Phase (real Signs acceptance
 * incident): the verification-side twin of `sign-transform-executor.ts`'s
 * own `bandColorAtDepthWithOuterExtension` — this module deliberately
 * duplicates the executor's rounded-rect depth/band-lookup formula rather
 * than importing it (see this section's own header comment), so the two
 * independent implementations must be kept in agreement by hand whenever
 * either changes. Before this phase, BOTH sides independently encoded the
 * same defect (a flat `fillColor` fallback once `depth` exceeds every
 * measured band) — which meant this check could never have caught the
 * real defect: it was comparing the actual image against an "expected"
 * value that reproduced the exact same bug. Fixed identically on both
 * sides: once `depth` exceeds every measured band, the expectation is the
 * OUTERMOST band's own colour (`bands[0]`) continuing to the interior —
 * never an unrelated fill colour — so this check now actually verifies
 * the frame reaches the substrate boundary, and would fail closed again if
 * the executor's own fix were ever reverted.
 */
function parametricFrameColorAt(
  depth: number | null,
  bands: SignPreservationFrameBand[],
  outerBackgroundColor: { r: number; g: number; b: number } | null,
): { r: number; g: number; b: number } {
  if (bands.length === 0) {
    return outerBackgroundColor ?? { r: 0, g: 0, b: 0 };
  }
  if (depth === null) return outerBackgroundColor ?? bands[0]!.color;
  let acc = 0;
  for (const band of bands) {
    if (depth < acc + band.thicknessPx) return band.color;
    acc += band.thicknessPx;
  }
  return bands[0]!.color;
}

function parametricFrameHoleColorAt(
  x: number,
  y: number,
  w: number,
  h: number,
  hole: SignPreservationFrameHole,
): { r: number; g: number; b: number } | null {
  const corners: [number, number, 1 | -1, 1 | -1][] = [
    [0, 0, 1, 1],
    [w - 1, 0, -1, 1],
    [0, h - 1, 1, -1],
    [w - 1, h - 1, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    const centerX = cx + sx * hole.offsetFromCornerXPx;
    const centerY = cy + sy * hole.offsetFromCornerYPx;
    const d = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
    if (d <= hole.radiusPx) return hole.interiorColor;
    if (d <= hole.radiusPx + 2) return hole.ringColor;
  }
  return null;
}

export function checkParametricFrameRegions(
  finalImage: RgbaImage,
  contentRegion: SignPreservationContentRegion | null,
  cornerRadiusPx: number | null,
  bands: SignPreservationFrameBand[] | null,
  fillColor: { r: number; g: number; b: number } | null,
  outerBackgroundColor: { r: number; g: number; b: number } | null,
  hole: SignPreservationFrameHole | null,
): SignPreservationExtensionRegionEvidence {
  const reasons: string[] = [];
  if (!contentRegion) {
    reasons.push("No content region was derivable — extension regions cannot be checked.");
    return { result: "unknown", regionsChecked: 0, totalExtensionPixels: 0, mismatchedPixelCount: 0, approvedFillRgb: null, reasons };
  }
  if (!bands || bands.length === 0 || !fillColor) {
    reasons.push("The reconstructed frame's own measured band model could not be resolved — extension regions cannot be checked.");
    return { result: "unknown", regionsChecked: 0, totalExtensionPixels: 0, mismatchedPixelCount: 0, approvedFillRgb: null, reasons };
  }

  const w = finalImage.width;
  const h = finalImage.height;
  let totalExtensionPixels = 0;
  let mismatchedPixelCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= contentRegion.x && x < contentRegion.x + contentRegion.width && y >= contentRegion.y && y < contentRegion.y + contentRegion.height) {
        continue; // interior — not this check's territory.
      }
      totalExtensionPixels++;
      const holeColor = hole ? parametricFrameHoleColorAt(x, y, w, h, hole) : null;
      const expected = holeColor ?? parametricFrameColorAt(parametricFrameDepthAt(x, y, w, h, cornerRadiusPx ?? 0), bands, outerBackgroundColor);
      const idx = (y * w + x) * 4;
      const r = finalImage.data[idx];
      const g = finalImage.data[idx + 1];
      const b = finalImage.data[idx + 2];
      const a = finalImage.data[idx + 3];
      if (r !== expected.r || g !== expected.g || b !== expected.b || a !== 255) mismatchedPixelCount++;
    }
  }

  if (mismatchedPixelCount > 0) {
    reasons.push(
      `${mismatchedPixelCount} of ${totalExtensionPixels} redrawn frame pixel(s) did not exactly match the plan's own measured band/hole model.`,
    );
  }

  return {
    result: mismatchedPixelCount === 0 ? "pass" : "catastrophic",
    regionsChecked: 1,
    totalExtensionPixels,
    mismatchedPixelCount,
    approvedFillRgb: null,
    reasons,
  };
}

// ---------------------------------------------------------------------
// D.3 Parametric Perimeter Frame Reconstruction Phase: replays the LOCAL,
// deterministic S2 geometry steps that can sit between the source/Topaz-
// intermediate and `reconstruct_parametric_frame` in a plan that needed no
// resolution reconstruction of its own axis alone (`rotate_90`,
// `downsample`, `proportional_resample`) — never `reconstruct_resolution`
// itself (that step's real output is already available as the resolved
// intermediate asset's own bytes; this only ever reproduces LOCAL,
// algorithmic steps). Exists because the persisted asset model has no
// separate row for "the image after a local resample" — only Topaz's own
// output gets a durable intermediate asset — so the RGB-integrity proof
// must re-derive that exact byte-for-byte input itself, the same
// discipline every other duplicated formula in this file already follows
// (`resampleExact` is a genuinely shared, neutral raster utility — never a
// `sign-preparation` import).
// ---------------------------------------------------------------------

function rotate90ForReplay(image: RgbaImage): RgbaImage {
  const outputWidth = image.height;
  const outputHeight = image.width;
  const data = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const srcIdx = (y * image.width + x) * 4;
      const destX = outputWidth - 1 - y;
      const destY = x;
      const destIdx = (destY * outputWidth + destX) * 4;
      data[destIdx] = image.data[srcIdx]!;
      data[destIdx + 1] = image.data[srcIdx + 1]!;
      data[destIdx + 2] = image.data[srcIdx + 2]!;
      data[destIdx + 3] = image.data[srcIdx + 3]!;
    }
  }
  return { width: outputWidth, height: outputHeight, data };
}

export interface ReplayableGeometryStep {
  kind: string;
  params: Record<string, unknown> | undefined;
}

/**
 * Applies each of `steps` (in order) to `image` — `rotate_90` (a fixed 90°
 * clockwise turn) and `downsample`/`proportional_resample` (an exact
 * resample to that step's own recorded `targetWidthPx`/`targetHeightPx`)
 * — and returns the result. Any other step kind, or a resample step with
 * missing/malformed target dimensions, is left un-applied (a no-op) —
 * the caller's own downstream dimension-match check is what fails closed
 * on that, never a guess made here.
 */
export function replayLocalGeometrySteps(image: RgbaImage, steps: ReplayableGeometryStep[]): RgbaImage {
  let current = image;
  for (const step of steps) {
    if (step.kind === "rotate_90") {
      current = rotate90ForReplay(current);
    } else if (step.kind === "downsample" || step.kind === "proportional_resample") {
      const targetWidthPx = step.params?.targetWidthPx;
      const targetHeightPx = step.params?.targetHeightPx;
      if (
        typeof targetWidthPx === "number" &&
        typeof targetHeightPx === "number" &&
        targetWidthPx > 0 &&
        targetHeightPx > 0
      ) {
        current = resampleExact(current, Math.round(targetWidthPx), Math.round(targetHeightPx)).image;
      }
    }
  }
  return current;
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
  const scale = resolveProportionalReconstructionScale(
    sourceImage.width,
    sourceImage.height,
    reconstructionContentImage.width,
    reconstructionContentImage.height,
  );

  if (!scale) {
    reasons.push(
      "The reconstruction's X/Y scale relative to the source is not proportional within tolerance — similarity evidence is unavailable, not guessed.",
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
    scaleFactor: scale.scaleX,
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
