/**
 * DTF Feature Integrity Phase 1: canonical alpha classification for
 * geometric measurement. Pure — no I/O.
 *
 * Section 6 of this phase's plan is explicit that not every alpha > 0 pixel
 * is equally printable, and that thresholds must be centralized and named
 * rather than scattered as ambiguous magic numbers. Three masks, named
 * explicitly:
 *
 *   - `visibleArtMask`  — alpha >= `DEFAULT_ALPHA_THRESHOLD` (this capability's
 *     own definition of "real artwork," from `alpha-trim.ts` — the same
 *     threshold production normalization itself trims to, so feature
 *     measurement and production trimming agree on what counts as visible).
 *   - `strongInkMask`   — alpha >= `STRONG_INK_ALPHA_THRESHOLD`. Positive-
 *     feature (stroke) width is measured on THIS mask, not `visibleArtMask`:
 *     a stroke's physically meaningful thickness is the width of ink solid
 *     enough to reliably carry adhesive powder, not the width including its
 *     anti-aliased, mostly-transparent outer rim. Measuring stroke width on
 *     `visibleArtMask` would systematically overstate every stroke's true
 *     printable thickness by roughly the width of its edge feather.
 *   - `partialAlphaMask` — `visibleArtMask AND NOT strongInkMask`: real,
 *     visible artwork whose alpha is too low to count as solid ink. Soft
 *     glows, drop shadows, faint distressed fragments, and anti-aliased
 *     edges all live here. Characterized separately (Section 6/Section 3)
 *     rather than folded into either mask, because neither "this behaves
 *     like solid ink" nor "this is invisible" is true of it.
 *
 * `STRONG_INK_ALPHA_THRESHOLD` is a MEASUREMENT-DEFINITION boundary (what
 * counts as "ink" for the purpose of measuring geometry), not a print-
 * readiness threshold — those live in `shared/dtf-feature-integrity-profile.ts`
 * and are evaluated against the physical widths this module's masks produce.
 * Like every other number in DTF Feature Integrity Phase 1, it is a
 * provisional engineering choice: 200/255 (~78%) is comfortably above
 * ordinary anti-aliasing (which mostly resolves within a pixel or two at
 * alpha values well under half) and comfortably below fully opaque, chosen
 * so a solid-filled stroke's interior reliably counts as ink while its edge
 * feather does not. It has not been calibrated against a physical DTF print.
 */

import type { RgbaImage } from "../raster-transform";
import { DEFAULT_ALPHA_THRESHOLD } from "../alpha-trim";

/** Re-exported so callers of this module never need to import `alpha-trim.ts` separately just to know the visibility floor. */
export { DEFAULT_ALPHA_THRESHOLD };

/**
 * Provisional. Alpha at or above this value counts as solid, reliably
 * printable ink for POSITIVE FEATURE geometry measurement. See module doc
 * comment. Requires physical DTF calibration.
 */
export const STRONG_INK_ALPHA_THRESHOLD = 200;

export interface AlphaMasks {
  width: number;
  height: number;
  /** Alpha >= `DEFAULT_ALPHA_THRESHOLD`. Real, visible artwork (matches production trimming's own definition). */
  visibleArt: Uint8Array;
  /** Alpha >= `STRONG_INK_ALPHA_THRESHOLD`. Solid ink — positive-feature geometry is measured on this mask. */
  strongInk: Uint8Array;
  /** `visibleArt AND NOT strongInk`. Real but non-solid artwork — soft edges, glows, faint distress. */
  partialAlpha: Uint8Array;
  /** `NOT visibleArt` — background/transparent. Negative-space geometry is measured against `strongInk`'s complement, not this mask directly; see `measure-feature-integrity.ts`. */
  background: Uint8Array;
}

/** Builds all four canonical masks from one pass over the image's alpha channel. */
export function buildAlphaMasks(image: RgbaImage): AlphaMasks {
  const n = image.width * image.height;
  const visibleArt = new Uint8Array(n);
  const strongInk = new Uint8Array(n);
  const partialAlpha = new Uint8Array(n);
  const background = new Uint8Array(n);

  for (let i = 0; i < n; i += 1) {
    const alpha = image.data[i * 4 + 3]!;
    const isVisible = alpha >= DEFAULT_ALPHA_THRESHOLD;
    const isStrong = alpha >= STRONG_INK_ALPHA_THRESHOLD;
    visibleArt[i] = isVisible ? 1 : 0;
    strongInk[i] = isStrong ? 1 : 0;
    partialAlpha[i] = isVisible && !isStrong ? 1 : 0;
    background[i] = isVisible ? 0 : 1;
  }

  return { width: image.width, height: image.height, visibleArt, strongInk, partialAlpha, background };
}
