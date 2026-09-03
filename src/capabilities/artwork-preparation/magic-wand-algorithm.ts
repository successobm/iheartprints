/**
 * Phase 27E — GRADUATED FROM EXPERIMENTAL (Phase 27C/27D). This file
 * originally was a byte-for-byte copy of
 * `src/experimental/magic-wand/magic-wand.ts` as it stood at the end of
 * Phase 27D. The lab under `src/experimental/magic-wand/` and its
 * standalone `/internal/magic-wand` page are left untouched and keep using
 * their own copy — deliberate duplication there, so neither copy can
 * accidentally destabilize the other.
 *
 * Wand-First Correction UX Phase: the pure selection algorithm below
 * (`floodFillSelect`, `colorDistance`, the tolerance ladder, connectivity
 * choice, `renderSelectionOverlay`, `unionMasks`/`filterClicksContaining`)
 * has been RELOCATED, unchanged, to
 * `src/capabilities/shared/flood-fill-selection.ts` — a genuinely shared,
 * capability-neutral module — because a NEW Signs wand tool needs the
 * IDENTICAL, already-proven algorithm and this codebase's own established
 * rule is that `artwork-preparation` internals are not imported across
 * capability boundaries (see the experimental/production split above). This
 * file now imports from that shared module and RE-EXPORTS every one of
 * those names under their exact original identifiers — every existing
 * import of this file (`from "@/capabilities/artwork-preparation/magic-
 * wand-algorithm"`) continues to resolve to the exact same functions,
 * values, and behavior as before this phase; nothing here changed. Proven
 * by running this capability's own full existing test suite unmodified
 * after the move.
 *
 * What stays HERE, not in the shared module: `applyMagicWandCorrection` and
 * `CorrectionAction` — DTF's OWN delete/restore policy (alpha-zero
 * "remove", byte-copy-from-original "restore"), never a generic artwork-
 * selection primitive. Signs has its own, different delete policy (masked
 * background replacement, never transparency) and does not import this
 * function.
 *
 * FROZEN per the Phase 27E mandate: the flood-fill algorithm, connectivity
 * choice, tolerance ladder, restore/remove authority semantics, and byte
 * invariants must not change without a demonstrated integration bug (not a
 * UX preference). Do not "improve" this file here — if the algorithm itself
 * needs to change, that is out of scope for graduation (or any later) work.
 *
 * CORE SEMANTIC: a click does not mean "select every pixel of this color in
 * the image." It means "select the CONNECTED region of sufficiently similar
 * color reachable from this exact pixel, without crossing disconnected
 * areas that merely happen to share a color." Two visually identical but
 * physically separate black shapes (a bowling ball and a line of black
 * lettering elsewhere on the same artwork) must never be treated as one
 * selection just because they're both "black" — see the adversarial tests
 * in magic-wand.test.ts (cases A/B/C in the Phase 27C report).
 *
 * No semantic AI. No "dark = background" inference. No garment-color pixel
 * authority. `applyMagicWandCorrection`'s signature takes only
 * (current, source, mask, action) — there is no way to pass garment/preview
 * context into the geometry.
 */

import {
  BROAD_SELECTION_CANVAS_FRACTION,
  DEFAULT_CONNECTIVITY,
  FLOOD_FILL_ALGORITHM_VERSION,
  TOLERANCE_LEVELS,
  colorDistance,
  filterClicksContaining,
  floodFillSelect,
  isToleranceLevel,
  renderSelectionOverlay,
  unionMasks,
  type Point,
  type RgbaImage,
  type SelectionResult,
  type ToleranceLevel,
} from "@/capabilities/shared/flood-fill-selection";

export type { Point, RgbaImage, SelectionResult, ToleranceLevel };
export {
  BROAD_SELECTION_CANVAS_FRACTION,
  DEFAULT_CONNECTIVITY,
  TOLERANCE_LEVELS,
  colorDistance,
  filterClicksContaining,
  floodFillSelect,
  isToleranceLevel,
  renderSelectionOverlay,
  unionMasks,
};

/** Unchanged identifier and value — re-exported under its original DTF name. */
export const MAGIC_WAND_ALGORITHM_VERSION = FLOOD_FILL_ALGORITHM_VERSION;

export type CorrectionAction = "restore" | "remove";

/**
 * Applies a computed selection mask to the current image.
 *
 * `restore`: copies RGBA bytes byte-for-byte from `source` (the immutable
 * original) at every masked pixel. Never synthesizes, recolors, or
 * interpolates.
 * `remove`: zeroes alpha only at masked pixels; RGB is left untouched.
 *
 * Neither branch mutates its inputs — always operates on a fresh copy of
 * `current`. Pixels outside the mask are guaranteed byte-identical to
 * `current`.
 */
export function applyMagicWandCorrection(
  current: RgbaImage,
  source: RgbaImage,
  mask: Uint8Array,
  action: CorrectionAction,
): RgbaImage {
  const data = Buffer.from(current.data);
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const o = i * 4;
    if (action === "restore") {
      source.data.copy(data, o, o, o + 4);
    } else {
      data[o + 3] = 0;
    }
  }
  return { width: current.width, height: current.height, data };
}
