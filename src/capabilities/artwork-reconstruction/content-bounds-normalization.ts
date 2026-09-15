/**
 * Phase R5 (Section 15 of the task): provider canvas -> actual artwork
 * content bounds normalization. R1/R2 research showed OpenAI's image
 * endpoints can return a square canvas even for wide/narrow source
 * artwork — this module is the ONE place that reconciles the two, and it
 * lives INSIDE the reconstruction capability (never left to downstream
 * DTF/Signs preparation) per the R5 task's own instruction to pick one
 * owner.
 *
 * Deliberately reuses existing, already-tested deterministic machinery
 * rather than inventing a new content-detection heuristic:
 *   - `trimToAlphaBounds` (`@/capabilities/final-artwork/alpha-trim`) — the
 *     SAME alpha-bounds crop the apparel production pipeline already uses,
 *     for the case where the provider padded a non-square source with real
 *     transparent canvas.
 *   - a simple aspect-ratio comparison against the confirmed contract's own
 *     `sourceContentBoundingBoxAspectRatio` for the case a trim cannot
 *     resolve at all (a fully opaque source, or no alpha padding to trim) —
 *     mirroring `TopazTransparencyUpscaleProvider.validateReconstructedGeometry`'s
 *     own "compare provider output geometry against known-good evidence,
 *     never trust it blindly" precedent, at a deliberately coarser (v1)
 *     tolerance appropriate to a single aspect-ratio number rather than a
 *     precise upscale-factor check.
 *
 * NEVER distorts/stretches the artwork to fill a canvas, and never guesses
 * a crop box for an opaque image it cannot verify — geometry drift it
 * cannot resolve becomes `"review_required"` evidence for the customer
 * compare/approve step, never a silent "close enough."
 */

import { PNG } from "pngjs";

import { trimToAlphaBounds } from "@/capabilities/final-artwork/alpha-trim";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { ArtworkReconstructionGeometryStatus } from "@/lib/domain/types";

/**
 * Conservative v1 tolerance for a single aspect-ratio comparison — NEW,
 * deliberately looser than `TopazTransparencyUpscaleProvider`'s own 1%
 * geometric-distortion check (that check compares a provider's output
 * dimensions against ITS OWN input at a known scale factor; this one
 * compares a generative provider's output against a coarser piece of
 * evidence — a single previously-measured aspect ratio — so a wider
 * tolerance is the honest choice rather than manufacturing false
 * precision).
 */
export const RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE = 0.05;

export interface ContentBoundsNormalizationResult {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  geometryStatus: ArtworkReconstructionGeometryStatus;
  /** Sanitized, internal-only explanation — never customer-facing jargon. */
  geometryNote: string;
}

export function normalizeReconstructionCanvas(
  rawBytes: Buffer,
  sourceContentAspectRatio: number | null,
): ContentBoundsNormalizationResult {
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(rawBytes);
  } catch (error) {
    throw new Error(
      `Reconstruction candidate bytes could not be decoded as a PNG: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const image: RgbaImage = { width: decoded.width, height: decoded.height, data: decoded.data };

  // Only a genuine transparent-padding trim narrows the content box — a
  // fully opaque result is passed through unchanged (never guessed at),
  // exactly like `trimToAlphaBounds`'s own documented contract.
  const trimmed = trimToAlphaBounds(image);
  const finalImage: RgbaImage =
    trimmed.status === "trimmed" && !trimmed.metadata.sourceFullyOpaque ? trimmed.image : image;

  const resultAspectRatio = finalImage.width / finalImage.height;

  let geometryStatus: ArtworkReconstructionGeometryStatus;
  let geometryNote: string;
  if (sourceContentAspectRatio === null || sourceContentAspectRatio <= 0) {
    // No prior measurement to check against — never silently "verified"
    // without evidence.
    geometryStatus = "review_required";
    geometryNote =
      "No source content aspect ratio evidence was available to verify reconstructed geometry against.";
  } else {
    const drift =
      Math.abs(resultAspectRatio - sourceContentAspectRatio) / sourceContentAspectRatio;
    if (drift > RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE) {
      geometryStatus = "review_required";
      geometryNote = `Reconstructed content aspect ratio (${resultAspectRatio.toFixed(3)}) drifted ${(drift * 100).toFixed(1)}% from the source's measured aspect ratio (${sourceContentAspectRatio.toFixed(3)}), exceeding the ${(RECONSTRUCTION_ASPECT_RATIO_DRIFT_TOLERANCE * 100).toFixed(0)}% v1 tolerance.`;
    } else {
      geometryStatus = "verified";
      geometryNote = `Reconstructed content aspect ratio (${resultAspectRatio.toFixed(3)}) is within tolerance of the source's measured aspect ratio (${sourceContentAspectRatio.toFixed(3)}).`;
    }
  }

  const png = new PNG({ width: finalImage.width, height: finalImage.height });
  finalImage.data.copy(png.data);
  const encoded = PNG.sync.write(png);

  return {
    bytes: encoded,
    widthPx: finalImage.width,
    heightPx: finalImage.height,
    geometryStatus,
    geometryNote,
  };
}
