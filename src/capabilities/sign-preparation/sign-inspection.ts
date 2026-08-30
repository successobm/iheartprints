/**
 * Signs Phase S1: the deterministic inspection — pure measurement of the
 * supplied artwork against the ordered substrate. Measures; never decides,
 * never repairs, never touches a pixel.
 *
 * Stretching is not measured because stretching is not a strategy
 * (Constitution §16A.2): only the two truthful proportional placements —
 * contain (fit) and fill (cover/crop) — exist here.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type {
  SignEdge,
  SignInspectionReport,
  SignOrientation,
  SignPlacementOption,
  SignProductionSpec,
  SignResolutionAssessment,
} from "./contracts";
import { SIGN_INSPECTION_VERSION } from "./contracts";
import { inspectAllSignEdges } from "./edge-inspection";
import type { SignResolutionPolicy } from "./resolution-policy";

/**
 * Relative aspect tolerance — the existing production
 * `ASPECT_RATIO_TOLERANCE` figure (1%), reused as a value rather than
 * re-decided.
 */
export const SIGN_ASPECT_TOLERANCE = 0.01;

/**
 * Effective-PPI comparison tolerance — the existing
 * `EFFECTIVE_PPI_TOLERANCE` figure (0.5 PPI), reused as a value.
 */
export const SIGN_PPI_TOLERANCE = 0.5;

function orientationOf(width: number, height: number): SignOrientation {
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

/** Exported for the planner (post-rotation recompute). Pure geometry. */
export function containPlacement(
  srcW: number,
  srcH: number,
  orderedW: number,
  orderedH: number,
): SignPlacementOption {
  const srcAspect = srcW / srcH;
  const orderedAspect = orderedW / orderedH;
  let artworkWidthIn: number;
  let artworkHeightIn: number;
  let affectedEdges: SignEdge[];
  if (srcAspect >= orderedAspect) {
    // Wider than the substrate: width-bound; padding above and below.
    artworkWidthIn = orderedW;
    artworkHeightIn = orderedW / srcAspect;
    affectedEdges = artworkHeightIn < orderedH ? ["top", "bottom"] : [];
  } else {
    // Taller/narrower: height-bound; padding left and right (the Ruth case).
    artworkHeightIn = orderedH;
    artworkWidthIn = orderedH * srcAspect;
    affectedEdges = artworkWidthIn < orderedW ? ["left", "right"] : [];
  }
  const padW = (orderedW - artworkWidthIn) / 2;
  const padH = (orderedH - artworkHeightIn) / 2;
  return {
    strategy: "contain",
    artworkWidthIn,
    artworkHeightIn,
    effectivePpi: srcW / artworkWidthIn,
    paddingIn: {
      left: padW,
      right: padW,
      top: padH,
      bottom: padH,
    },
    cropSourcePx: { horizontal: 0, vertical: 0 },
    affectedEdges,
    meaningfulContentMayBeAffected: false,
  };
}

function fillPlacement(
  srcW: number,
  srcH: number,
  orderedW: number,
  orderedH: number,
): SignPlacementOption {
  const srcAspect = srcW / srcH;
  const orderedAspect = orderedW / orderedH;
  let cropHorizontalPx = 0;
  let cropVerticalPx = 0;
  let effectivePpi: number;
  let affectedEdges: SignEdge[];
  if (srcAspect >= orderedAspect) {
    // Cover by height; excess width is cut left/right.
    effectivePpi = srcH / orderedH;
    const coveredWIn = orderedH * srcAspect;
    cropHorizontalPx = Math.round(srcW * (1 - orderedW / coveredWIn));
    affectedEdges = cropHorizontalPx > 0 ? ["left", "right"] : [];
  } else {
    // Cover by width; excess height is cut top/bottom (the Ruth case: 3in).
    effectivePpi = srcW / orderedW;
    const coveredHIn = orderedW / srcAspect;
    cropVerticalPx = Math.round(srcH * (1 - orderedH / coveredHIn));
    affectedEdges = cropVerticalPx > 0 ? ["top", "bottom"] : [];
  }
  const cropped = cropHorizontalPx > 0 || cropVerticalPx > 0;
  return {
    strategy: "fill",
    artworkWidthIn: orderedW,
    artworkHeightIn: orderedH,
    effectivePpi,
    paddingIn: { left: 0, right: 0, top: 0, bottom: 0 },
    cropSourcePx: { horizontal: cropHorizontalPx, vertical: cropVerticalPx },
    affectedEdges,
    // V1 conservatism: ANY non-zero crop may remove meaningful content.
    // Only a human approving an exact preview may ever say otherwise.
    meaningfulContentMayBeAffected: cropped,
  };
}

function assessResolution(
  srcW: number,
  srcH: number,
  contain: SignPlacementOption,
  policy: SignResolutionPolicy,
): SignResolutionAssessment {
  const ppi = contain.effectivePpi;
  const status =
    ppi + SIGN_PPI_TOLERANCE >= policy.targetPpi
      ? "meets_target"
      : ppi + SIGN_PPI_TOLERANCE >= policy.minPpi
        ? "below_target"
        : "below_minimum";
  return {
    sourceWidthPx: srcW,
    sourceHeightPx: srcH,
    containEffectivePpi: ppi,
    targetPpi: policy.targetPpi,
    minPpi: policy.minPpi,
    status,
    requiredScaleToTarget: Math.max(1, policy.targetPpi / ppi),
    requiredScaleToMinimum: Math.max(1, policy.minPpi / ppi),
  };
}

/**
 * Inspects `image` against an optional confirmed spec + policy. Without a
 * spec, only spec-independent facts (source geometry, edges, transparency)
 * are reported — nothing is defaulted or inferred (Constitution §16A.2).
 */
export function inspectSignArtwork(
  image: RgbaImage,
  spec: SignProductionSpec | null,
  policy: SignResolutionPolicy | null,
): SignInspectionReport {
  const srcW = image.width;
  const srcH = image.height;
  const srcAspect = srcW / srcH;

  // Transparency: measured from the actual alpha plane, never inferred.
  let transparent = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i]! < 255) transparent++;
  }
  const pixelCount = srcW * srcH;

  const ordered = spec
    ? {
        widthIn: spec.orderedWidthIn,
        heightIn: spec.orderedHeightIn,
        aspectRatio: spec.orderedWidthIn / spec.orderedHeightIn,
      }
    : null;

  const aspectDeltaRatio = ordered
    ? Math.abs(srcAspect - ordered.aspectRatio) / ordered.aspectRatio
    : null;
  const rotatedDeltaRatio = ordered
    ? Math.abs(1 / srcAspect - ordered.aspectRatio) / ordered.aspectRatio
    : null;

  const contain = ordered
    ? containPlacement(srcW, srcH, ordered.widthIn, ordered.heightIn)
    : null;
  const fill = ordered
    ? fillPlacement(srcW, srcH, ordered.widthIn, ordered.heightIn)
    : null;

  return {
    inspectionVersion: SIGN_INSPECTION_VERSION,
    source: { widthPx: srcW, heightPx: srcH, aspectRatio: srcAspect },
    ordered,
    aspectMismatch:
      aspectDeltaRatio === null ? null : aspectDeltaRatio > SIGN_ASPECT_TOLERANCE,
    aspectDeltaRatio,
    orientation: {
      source: orientationOf(srcW, srcH),
      ordered: ordered ? orientationOf(ordered.widthIn, ordered.heightIn) : null,
      rotatedAspectMatches:
        rotatedDeltaRatio === null
          ? null
          : rotatedDeltaRatio <= SIGN_ASPECT_TOLERANCE,
    },
    placements: { contain, fill },
    resolution:
      contain && policy ? assessResolution(srcW, srcH, contain, policy) : null,
    transparency: {
      hasAlphaPixels: transparent > 0,
      transparentPixelFraction: pixelCount === 0 ? 0 : transparent / pixelCount,
    },
    edges: inspectAllSignEdges(image),
  };
}
