/**
 * Wand-First Correction UX Phase: the Signs-side wand SELECTION surface —
 * click a source pixel, get back the contiguous flood-fill region reachable
 * from it. Reuses `floodFillSelect` and the tolerance ladder VERBATIM from
 * `@/capabilities/shared/flood-fill-selection` (the same, already-proven
 * algorithm DTF's own Magic Wand runs on) — this module never reimplements
 * selection. It exists only for the parts that ARE genuinely different for
 * Signs:
 *
 * 1. `renderSignSelectionOverlayCrop` — DTF's own `renderSelectionOverlay`
 *    bakes the overlay into a FULL COPY of the base image (appropriate for
 *    DTF's "always re-fetch the whole displayed PNG" client architecture —
 *    see the DTF audit). The Signs workspace instead layers a translucent
 *    `<canvas>` over the already-loaded candidate `<img>` (exactly like its
 *    existing CUT/SAFE guide overlay), so what it needs is a SMALL,
 *    alpha-transparent RGBA crop sized to the selection's own bounding
 *    rectangle (never the ~20.7MP full canvas) that the client draws at the
 *    correct offset — cheap to transmit, cheap to composite.
 *
 * 2. `rectExact` — Section N's safety gate: whether this selection's mask
 *    fills its own bounding rectangle exactly (`maskExactlyFillsBounds`,
 *    also reused verbatim). Only a `rectExact` selection may ever be
 *    classified as governed EDGE_INTENT_ARTWORK ("Keep") without risking
 *    that the rectangle silently exempts pixels the operator never actually
 *    selected — see `SignFitToProductionCorrectionTool.tsx`'s own doc for
 *    where this gate is enforced.
 *
 * 3. `MAX_MASKED_REGION_PIXELS` eligibility — whether this selection is
 *    small enough to persist as a masked DELETE at all (re-exported from
 *    `sign-composition-steps.ts`, the single source of truth the actual
 *    execution primitive also enforces — never a second, possibly-drifting
 *    limit).
 *
 * Provider calls: zero. This module never calls Topaz, never calls OpenAI,
 * never touches a database, never mutates anything — pure, synchronous
 * pixel analysis over an already-decoded image, exactly like
 * `measureUniformSurroundingBackground` already is.
 */

import {
  DEFAULT_CONNECTIVITY,
  type Point,
  type RgbaImage,
  type SelectionResult,
  type ToleranceLevel,
  floodFillSelect,
  maskExactlyFillsBounds,
} from "@/capabilities/shared/flood-fill-selection";

import type { SignEdge } from "./contracts";
import { MAX_MASKED_REGION_PIXELS } from "./sign-composition-steps";

export { MAX_MASKED_REGION_PIXELS };
export type { Point, RgbaImage, SelectionResult, ToleranceLevel };

export interface SignWandSelection extends SelectionResult {
  /** True iff `mask` fills its own `bounds` rectangle exactly — see this module's own doc, item 2. */
  rectExact: boolean;
  /** True iff `bounds`' own pixel area is small enough to be persisted as a masked DELETE (`MAX_MASKED_REGION_PIXELS`). A selection over this ceiling can still be inspected, but Delete must be refused — the operator is directed to a smaller selection or the rectangle-based Advanced tool. */
  eligibleForMaskedDelete: boolean;
  /** Which of the four canvas edges this selection's bounding rectangle actually touches (x===0, x+width===canvasWidth, y===0, y+height===canvasHeight) — the deterministic, geometry-only basis for auto-deriving which edge(s) a "Keep" (edge-intent) classification applies to. Never inferred from pixel content. */
  touchedCanvasEdges: SignEdge[];
}

/**
 * Runs the proven flood-fill algorithm from a single clicked seed pixel and
 * augments the raw result with the Signs-specific safety/eligibility facts
 * above. Throws iff `seed` is outside the image bounds — identical failure
 * mode to `floodFillSelect` itself, since this is a thin wrapper, not a
 * reimplementation.
 */
export function computeSignWandSelection(
  image: RgbaImage,
  seed: Point,
  toleranceLevel: ToleranceLevel,
): SignWandSelection {
  const result = floodFillSelect(image, seed, toleranceLevel, DEFAULT_CONNECTIVITY);
  const rectExact = maskExactlyFillsBounds(result.mask, image.width, result.bounds);
  const eligibleForMaskedDelete = result.bounds.width * result.bounds.height <= MAX_MASKED_REGION_PIXELS;
  const touchedCanvasEdges: SignWandSelection["touchedCanvasEdges"] = [];
  if (result.bounds.top === 0) touchedCanvasEdges.push("top");
  if (result.bounds.left + result.bounds.width === image.width) touchedCanvasEdges.push("right");
  if (result.bounds.top + result.bounds.height === image.height) touchedCanvasEdges.push("bottom");
  if (result.bounds.left === 0) touchedCanvasEdges.push("left");
  return { ...result, rectExact, eligibleForMaskedDelete, touchedCanvasEdges };
}

/**
 * A small, alpha-transparent RGBA crop (sized to `bounds`, never the full
 * canvas) showing the selection: a translucent cyan fill over the interior,
 * a two-tone marching-ants boundary — the identical visual language DTF's
 * own `renderSelectionOverlay` uses, deliberately NOT reused verbatim
 * because the OUTPUT SHAPE is fundamentally different (a small transparent
 * layer to composite at an offset, vs. a full opaque base-image copy) — see
 * this module's own doc, item 1.
 */
export function renderSignSelectionOverlayCrop(mask: Uint8Array, imageWidth: number, bounds: SelectionResult["bounds"]): RgbaImage {
  const { left, top, width, height } = bounds;
  const data = Buffer.alloc(width * height * 4); // zero-initialized: fully transparent by default

  const isSelected = (x: number, y: number): boolean => {
    if (x < 0 || x >= imageWidth || y < 0) return false;
    return mask[y * imageWidth + x] === 1;
  };

  for (let cy = 0; cy < height; cy++) {
    const y = top + cy;
    for (let cx = 0; cx < width; cx++) {
      const x = left + cx;
      if (!isSelected(x, y)) continue;
      const o = (cy * width + cx) * 4;
      const boundary =
        !isSelected(x + 1, y) || !isSelected(x - 1, y) || !isSelected(x, y + 1) || !isSelected(x, y - 1);
      if (boundary) {
        const bright = (x + y) % 6 < 3;
        if (bright) {
          data[o] = 255; data[o + 1] = 0; data[o + 2] = 200;
        } else {
          data[o] = 0; data[o + 1] = 255; data[o + 2] = 255;
        }
        data[o + 3] = 255;
      } else {
        data[o] = 0; data[o + 1] = 220; data[o + 2] = 255;
        data[o + 3] = 110; // translucent interior fill
      }
    }
  }
  return { width, height, data };
}

/** `mask` (full-image-sized, from `SignWandSelection.mask`) cropped and base64-encoded to just `bounds` — the exact shape `replace_masked_region_with_background`'s own params expect, and the transport shape sent between preview/commit requests. */
export function encodeSignWandMaskForBounds(mask: Uint8Array, imageWidth: number, bounds: SelectionResult["bounds"]): string {
  const { left, top, width, height } = bounds;
  const cropped = Buffer.alloc(width * height);
  for (let cy = 0; cy < height; cy++) {
    const y = top + cy;
    const rowStart = y * imageWidth + left;
    cropped.set(mask.subarray(rowStart, rowStart + width), cy * width);
  }
  return cropped.toString("base64");
}
