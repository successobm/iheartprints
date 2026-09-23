/**
 * Phase R6A (Geometry-Qualified Clean Master v1): deterministic, colour-based
 * content-bounds qualification for an APPROVED raster reconstruction
 * candidate whose canvas is fully (or near-fully) opaque.
 *
 * WHY THIS EXISTS: `content-bounds-normalization.ts` reconciles provider
 * canvas geometry using `trimToAlphaBounds` — purely alpha-based. For a
 * fully opaque candidate (the R6A investigation's own measured evidence: a
 * 1024x1024 provider canvas containing an off-center ~803x201 wordmark),
 * that trim is a documented no-op — an opaque image's alpha bounding box is
 * the whole canvas by definition, so `normalizeReconstructionCanvas` can
 * only ever report `geometryStatus: "review_required"` for such a
 * candidate, never a genuine content box. This module is the ONE place a
 * genuinely COLOUR-based measurement is attempted for that case, strictly
 * as an ADDITIONAL, opt-in derived qualification — it never replaces or
 * mutates the approved candidate, never runs unless invoked, and its own
 * "qualified" verdict is machine evidence only, never customer approval on
 * its own (a durable customer geometry confirmation is layered on top of
 * this pure result elsewhere — see this phase's own report on why that
 * layer is currently gated behind a persistence decision, not implemented
 * in this module).
 *
 * REUSES `artwork-preparation`'s neutral classification/removal engine —
 * `analyzeArtwork`, `classifyRepairability`, `isolateBackground` — exactly
 * like `sign-preparation/sign-background-removal.ts`'s own documented
 * crossing of the `artwork-preparation` capability boundary, extended here
 * to a SECOND, independent caller rather than a new algorithm. See that
 * module's own doc comment for the shared safety invariant this inherits
 * completely unchanged: background removal may remove pixels only when the
 * system has affirmative evidence they belong to the background; any
 * ambiguous case (`classifyRepairability` returning anything other than
 * `remove_exterior`) is ALWAYS `"abstained"` here, never a destructive
 * guess. There is no generative fallback and no provider call anywhere in
 * this module.
 *
 * The final physical content box/dimensions/aspect ratio are computed by
 * `trimToAlphaBounds` (`final-artwork/alpha-trim.ts`) — the SAME
 * deterministic alpha-bounds primitive `content-bounds-normalization.ts`
 * already trusts — run AFTER `isolateBackground` has turned real exterior
 * background into real alpha=0. This is deliberate: no second, hand-rolled
 * bounding-box computation exists in this module.
 */

import { trimToAlphaBounds } from "@/capabilities/final-artwork/alpha-trim";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  analyzeArtwork,
  artworkHasTransparency,
} from "@/capabilities/artwork-preparation/image-analysis";
import { classifyRepairability } from "@/capabilities/artwork-preparation/repairability";
import { isolateBackground } from "@/capabilities/artwork-preparation/background-isolation";
import type {
  ArtworkBounds,
  RepairabilityClassification,
  RepairabilityReasonCode,
  RgbColor,
} from "@/capabilities/artwork-preparation/contracts";

import { RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE } from "./content-bounds-normalization";

export const GEOMETRY_QUALIFICATION_VERSION =
  "artwork-reconstruction-geometry-qualification:v1";

/**
 * Abstention reasons NOT already covered by `classifyRepairability`'s own
 * `RepairabilityReasonCode` vocabulary — deliberately narrow, reusing the
 * existing codes wherever they already say the right thing (Section 4 of
 * the R6A implementation task: "do not invent arbitrary duplicate
 * thresholds when existing capability already owns them").
 */
export type GeometryQualificationAbstainReason =
  | RepairabilityReasonCode
  | "content_touches_canvas_border"
  | "aspect_ratio_drift_exceeds_tolerance";

export interface GeometryQualificationContentBounds {
  left: number;
  top: number;
  /** Exclusive. */
  right: number;
  /** Exclusive. */
  bottom: number;
}

export type GeometryQualificationOutcome =
  | {
      status: "qualified";
      /** The final, physically-trimmed, colour-unmodified-except-for-decontaminated-edges image. Real alpha=0 background, real alpha=255 content. */
      image: RgbaImage;
      originalCanvasWidthPx: number;
      originalCanvasHeightPx: number;
      /** Content bounds BEFORE the physical trim's small artwork-edge safety margin — the tight box the colour-based isolation pass itself found. */
      contentBounds: GeometryQualificationContentBounds;
      normalizedWidthPx: number;
      normalizedHeightPx: number;
      contentAspectRatio: number;
      detectedBackgroundColor: RgbColor;
      backgroundTolerance: number;
      classifierReasons: RepairabilityReasonCode[];
      /** `classifyRepairability`'s own verdict — persisted as a sanitized internal diagnostic by callers, never customer-facing. */
      classification: RepairabilityClassification;
    }
  | {
      status: "abstained";
      reason: GeometryQualificationAbstainReason;
      classifierReasons: RepairabilityReasonCode[];
      classification: RepairabilityClassification;
    };

function touchesCanvasBorder(
  bounds: ArtworkBounds | null,
  width: number,
  height: number,
): boolean {
  if (!bounds) return true;
  return bounds.left === 0 || bounds.top === 0 || bounds.right === width || bounds.bottom === height;
}

/**
 * Pure — reads the candidate's pixels and returns a verdict. Never touches
 * a provider, never phrases anything for a customer (mirrors
 * `classifyRepairability`'s and `prepareSignBackgroundRemoval`'s own "pure"
 * discipline), never mutates `candidate`.
 *
 * `sourceContentAspectRatio` is the SAME optional evidence
 * `normalizeReconstructionCanvas` already accepts (the confirmed fidelity
 * contract's `sourceContentBoundingBoxAspectRatio`) — when present, the
 * resulting content aspect ratio is checked against it with the SAME
 * tolerance, never a second one. `null` (the common case today — see the
 * R6A investigation's own finding that this field is unpopulated for every
 * confirmed contract) simply skips that extra check; the classifier and
 * border-touch guards below still apply in full.
 */
export function qualifyReconstructionGeometry(
  candidate: RgbaImage,
  sourceContentAspectRatio: number | null,
): GeometryQualificationOutcome {
  const analysis = analyzeArtwork({
    image: candidate,
    format: "image/png",
    byteSize: candidate.data.length,
    declaresAlphaChannel: artworkHasTransparency(candidate),
    // Geometry qualification has no apparel placement/enhancement concept
    // of its own — mirrors `sign-preparation/sign-background-removal.ts`'s
    // own reasoning for the identical nulls.
    printPlacement: null,
    intendedPrintWidthIn: null,
  });
  const assessment = classifyRepairability(analysis);

  if (assessment.backgroundTreatment !== "remove_exterior") {
    return {
      status: "abstained",
      reason: assessment.reasons[0] ?? "no_visible_artwork",
      classifierReasons: assessment.reasons,
      classification: assessment.classification,
    };
  }

  // Never removes background from artwork already touching the canvas
  // edge — a border-connected fill cannot distinguish exterior canvas from
  // a legitimately edge-to-edge design (R6A investigation §9/§19-E).
  if (touchesCanvasBorder(analysis.artworkBounds, candidate.width, candidate.height)) {
    return {
      status: "abstained",
      reason: "content_touches_canvas_border",
      classifierReasons: assessment.reasons,
      classification: assessment.classification,
    };
  }

  const isolated = isolateBackground(candidate, {
    backgroundColor: analysis.estimatedBackgroundColor,
    tolerance: analysis.backgroundTolerance,
  });

  // `isolateBackground` only ever zeroes alpha for background pixels — the
  // canvas dimensions never change here (no stretch, no resample). Turning
  // that real alpha into an actual physical content box reuses
  // `trimToAlphaBounds` rather than a second bounding-box computation.
  const trimmed = trimToAlphaBounds(isolated.image);
  if (trimmed.status !== "trimmed" || trimmed.metadata.sourceFullyOpaque) {
    // `sourceFullyOpaque` here would mean isolation ultimately left nothing
    // transparent at all — treated as no meaningful content ever having
    // been separated from background, never a silent pass-through.
    return {
      status: "abstained",
      reason: "no_visible_artwork",
      classifierReasons: assessment.reasons,
      classification: assessment.classification,
    };
  }

  const contentAspectRatio = trimmed.image.width / trimmed.image.height;
  if (sourceContentAspectRatio !== null && sourceContentAspectRatio > 0) {
    const drift =
      Math.abs(contentAspectRatio - sourceContentAspectRatio) / sourceContentAspectRatio;
    if (drift > RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE) {
      return {
        status: "abstained",
        reason: "aspect_ratio_drift_exceeds_tolerance",
        classifierReasons: assessment.reasons,
        classification: assessment.classification,
      };
    }
  }

  return {
    status: "qualified",
    image: trimmed.image,
    originalCanvasWidthPx: candidate.width,
    originalCanvasHeightPx: candidate.height,
    contentBounds: trimmed.metadata.alphaBBox,
    normalizedWidthPx: trimmed.image.width,
    normalizedHeightPx: trimmed.image.height,
    contentAspectRatio,
    detectedBackgroundColor: analysis.estimatedBackgroundColor,
    backgroundTolerance: analysis.backgroundTolerance,
    classifierReasons: assessment.reasons,
    classification: assessment.classification,
  };
}
