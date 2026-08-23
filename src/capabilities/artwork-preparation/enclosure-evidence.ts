/**
 * Intelligent Separation Phase 2: THE STRONGER TOPOLOGICAL SIGNAL.
 *
 * Promotes the Phase 1 experimental measurement
 * (`.local-acceptance/phase0-prep-intelligence/signal-probe.ts`) into a
 * production evidence function. Identical arithmetic — this file does not
 * paraphrase that experiment, it IS it, moved into `src/`.
 *
 * THE QUESTION THIS ANSWERS
 *
 * `interiorBackgroundColoredPixelsPreserved > 0` (the existing signal driving
 * `describePreparedArtworkReview`) proves only a COLOUR fact: the design
 * contains pixels near the background's colour. It says nothing about WHERE
 * removal actually happened relative to what survived.
 *
 * This function asks a TOPOLOGY question instead: of the pixels standard
 * background removal actually took, how many sit at a position the
 * SURVIVING artwork surrounds on every side? A removed pixel with surviving
 * artwork above, below, left, and right of it was not removed from the open
 * exterior — it was removed from a position enclosed by whatever the
 * customer's design left behind.
 *
 * WHAT THE RATIO DOES NOT PROVE
 *
 * `ratio === 0` — no measured enclosure intrusion. Removal never reached a
 * position the surviving design surrounds.
 *
 * `ratio > 0` — removal reached at least one such position. This is NOT
 * proof that content was damaged, that a recognisable object was affected, or
 * that the removal was wrong. Phase 1's synthetic controls (`foregroundRing`,
 * `letterCounter`, `multipleCounters`) all measure a strictly positive ratio
 * and are CORRECT removals — a letter's counter or a ring's open middle is
 * exactly the shape this signal also lights up on. The number says where
 * removal happened, never why, and never whether it mattered.
 *
 * Pure — no I/O, no provider, no randomness. Same bytes in, same ratio out.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { VISIBLE_ALPHA_THRESHOLD } from "./pixel-metrics";

export interface ExteriorRemovalEnclosureEvidence {
  /** Pixels visible in the ORIGINAL that are no longer visible in the PREPARED result. */
  removedPixelCount: number;
  /**
   * Of those, how many have surviving (prepared-visible) artwork on all four
   * scanline directions — up, down, left, and right.
   */
  enclosedRemovedPixelCount: number;
  /**
   * `enclosedRemovedPixelCount / removedPixelCount`, or `0` when nothing was
   * removed. The single number persisted and read by the assessor.
   */
  exteriorRemovalEnclosureRatio: number;
}

function visibleMask(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = data[i * 4 + 3]! >= VISIBLE_ALPHA_THRESHOLD ? 1 : 0;
  }
  return mask;
}

/**
 * Measures the enclosure evidence between an original upload and its
 * prepared (background-removed) result. Both images must share dimensions —
 * background preparation never resizes, so a mismatch means the caller
 * passed the wrong pair.
 */
export function measureExteriorRemovalEnclosure(
  original: RgbaImage,
  prepared: RgbaImage,
): ExteriorRemovalEnclosureEvidence {
  if (original.width !== prepared.width || original.height !== prepared.height) {
    throw new Error(
      `measureExteriorRemovalEnclosure requires matching dimensions (original ${original.width}x${original.height}, prepared ${prepared.width}x${prepared.height}).`,
    );
  }

  const { width, height } = original;
  const originalVisible = visibleMask(original);
  const preparedVisible = visibleMask(prepared);

  // For every pixel, "is there surviving (prepared-visible) artwork strictly
  // before this position along this scanline" — computed once per direction
  // in linear time rather than re-scanning per pixel.
  const left = new Uint8Array(width * height);
  const right = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    let seen = 0;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      left[i] = seen;
      if (preparedVisible[i]) seen = 1;
    }
    seen = 0;
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      right[i] = seen;
      if (preparedVisible[i]) seen = 1;
    }
  }

  const up = new Uint8Array(width * height);
  const down = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    let seen = 0;
    for (let y = 0; y < height; y += 1) {
      const i = y * width + x;
      up[i] = seen;
      if (preparedVisible[i]) seen = 1;
    }
    seen = 0;
    for (let y = height - 1; y >= 0; y -= 1) {
      const i = y * width + x;
      down[i] = seen;
      if (preparedVisible[i]) seen = 1;
    }
  }

  let removed = 0;
  let enclosed = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (originalVisible[i] && !preparedVisible[i]) {
      removed += 1;
      if (left[i] && right[i] && up[i] && down[i]) enclosed += 1;
    }
  }

  return {
    removedPixelCount: removed,
    enclosedRemovedPixelCount: enclosed,
    exteriorRemovalEnclosureRatio: removed > 0 ? enclosed / removed : 0,
  };
}
