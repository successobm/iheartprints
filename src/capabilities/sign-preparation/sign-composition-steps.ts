/**
 * Signs Phase 3B (Canvas-First Correction): the four, and ONLY four,
 * composition PRIMITIVES the canvas-first pipeline admits —
 * `crop_region`, `fit_artwork_to_canvas`, `move_region`, `fill_rect`.
 *
 * Deliberately its own file, never folded into `sign-transform-executor.ts`
 * (which stays the dispatcher/replay-discipline module and the home of the
 * v1-v3 legacy step kinds this phase RETIRES from authority over new
 * straight-rectangle plans, but never deletes — see that module's own
 * updated doc). This module is the "genuinely different pixel producer"
 * Phase 3B's `SIGN_EXECUTION_IMPLEMENTATION_VERSION` bump to
 * `"sign-execution-v4"` refers to.
 *
 * THE CANVAS-FIRST INVARIANT: `fit_artwork_to_canvas` is the ONLY step that
 * may create/resize the working canvas, and it always does so from
 * plan-time-fixed `canvasWidthPx`/`canvasHeightPx` params — never derived
 * from the artwork it is about to place. Those params are themselves built
 * (by `sign-composition-plan-builder.ts`) from `buildSignProductionTemplate`
 * (`sign-production-template.ts`) — the ordered spec + resolution policy
 * ALONE. No function in this file ever reads a canvas dimension off the
 * artwork; `crop_region` operates on the artwork BEFORE any canvas exists,
 * and `move_region`/`fill_rect` operate strictly WITHIN the canvas
 * `fit_artwork_to_canvas` already fixed, never resizing it.
 *
 * Execution model — why `move_region`/`fill_rect` do NOT use the ordinary
 * single-image fold every other Signs executor step uses: a genuine
 * reflow (move ATTENTION up, move the bottom warning down, redistribute
 * middle bands) needs every `move_region` step to read its SOURCE band
 * from the canvas exactly as `fit_artwork_to_canvas` left it — never from
 * whatever an EARLIER `move_region`/`fill_rect` in the same plan already
 * overwrote, which a naive fold (each step's output feeding the next
 * step's input) would silently corrupt for any plan where two bands'
 * source/destination ranges overlap (a real possibility whenever spacing
 * is redistributed, not just translated). `executeCompositionSteps` fixes
 * this by taking ONE immutable snapshot right after `fit_artwork_to_canvas`
 * (`baseCanvas`) and having every subsequent `move_region` read from it,
 * while writes accumulate into a single mutable `working` buffer that
 * starts as a copy of `baseCanvas` (so any band the operator never
 * explicitly moves/fills simply keeps its base-canvas content — the
 * identity default, never an unrelated blank/black fill) and is returned
 * once every step has applied.
 *
 * No AI, no generative fill, no OCR, no resize/warp inside `move_region`,
 * no implicit full-width `fill_rect`. Every fill colour and every
 * rectangle is a plan-time, operator-approved, explicit number — nothing
 * here ever measures or invents a colour itself (that happens once, at
 * plan-build time, in `sign-composition-plan-builder.ts`, exactly the
 * "measured, never typed" discipline `sign-operator-structural-override.ts`
 * already established).
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { resampleExact } from "@/capabilities/final-artwork/raster-transform";

import type { SignRepairStep } from "./contracts";
import { deriveUniformBackgroundExtension } from "./sign-geometry";
import { signSafeInsetPxForAxis } from "./sign-fit-to-production";
import type { SignExecutionBounds, SignExecutionResult } from "./sign-transform-executor";

export const COMPOSITION_STEP_KINDS = new Set<SignRepairStep["kind"]>([
  "crop_region",
  "fit_artwork_to_canvas",
  "move_region",
  "fill_rect",
  "replace_region_with_background",
  "replace_masked_region_with_background",
]);

/** True iff `kind` is one of the four Phase 3B composition primitives. */
export function isCompositionStepKind(kind: SignRepairStep["kind"]): boolean {
  return COMPOSITION_STEP_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Small, local parameter helpers — deliberately duplicated rather than
// imported from `sign-transform-executor.ts` (those are module-private,
// and every other step-kind module in this capability already carries its
// own tiny copy of the identical checks; see that module's own doc on this
// convention).
// ---------------------------------------------------------------------------

function requirePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return null;
  return value;
}

function requireNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  return value;
}

function requireByteChannel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function refuse(detail: string): { status: "refused"; reason: "unsupported_step_kind"; detail: string } {
  return { status: "refused", reason: "unsupported_step_kind", detail };
}

// ---------------------------------------------------------------------------
// crop_region
// ---------------------------------------------------------------------------

export interface CropRegionParams {
  expectedInputWidthPx: number;
  expectedInputHeightPx: number;
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

export function encodeCropRegionParams(p: CropRegionParams): Record<string, number | string> {
  return { ...p };
}

export function decodeCropRegionParams(params: Record<string, number | string>): CropRegionParams | null {
  const expectedInputWidthPx = requirePositiveInt(params.expectedInputWidthPx);
  const expectedInputHeightPx = requirePositiveInt(params.expectedInputHeightPx);
  const xPx = requireNonNegativeInt(params.xPx);
  const yPx = requireNonNegativeInt(params.yPx);
  const widthPx = requirePositiveInt(params.widthPx);
  const heightPx = requirePositiveInt(params.heightPx);
  if (
    expectedInputWidthPx === null || expectedInputHeightPx === null ||
    xPx === null || yPx === null || widthPx === null || heightPx === null
  ) {
    return null;
  }
  return { expectedInputWidthPx, expectedInputHeightPx, xPx, yPx, widthPx, heightPx };
}

/**
 * Operator-authorized rectangular crop of the artwork (the reconstructed
 * intermediate, or the native source when no reconstruction ran). Exact
 * source identity binding: refuses unless the incoming image's own
 * dimensions equal `expectedInputWidthPx`/`expectedInputHeightPx` — the
 * same "never assume, always re-verify" discipline `runSignPreparationJob`
 * already applies to `plan.sourceSha256`. NEVER assumes a "frame interior"
 * — the rectangle is exactly what the operator chose, nothing else.
 */
export function executeCropRegion(
  image: RgbaImage,
  step: SignRepairStep,
): { status: "executed"; image: RgbaImage } | { status: "refused"; reason: "unsupported_step_kind"; detail: string } {
  const p = decodeCropRegionParams(step.params);
  if (!p) return refuse(`Step "crop_region" is missing valid parameters.`);
  if (image.width !== p.expectedInputWidthPx || image.height !== p.expectedInputHeightPx) {
    return refuse(
      `Step "crop_region" expected a ${p.expectedInputWidthPx}x${p.expectedInputHeightPx}px input, but received ` +
        `${image.width}x${image.height}px — refusing rather than cropping the wrong source identity.`,
    );
  }
  if (p.xPx + p.widthPx > image.width || p.yPx + p.heightPx > image.height) {
    return refuse(
      `Step "crop_region" rectangle [${p.xPx},${p.yPx},${p.widthPx}x${p.heightPx}] exceeds the ` +
        `${image.width}x${image.height}px input bounds.`,
    );
  }
  const data = Buffer.alloc(p.widthPx * p.heightPx * 4);
  for (let y = 0; y < p.heightPx; y++) {
    const srcRowStart = ((p.yPx + y) * image.width + p.xPx) * 4;
    const destRowStart = y * p.widthPx * 4;
    image.data.copy(data, destRowStart, srcRowStart, srcRowStart + p.widthPx * 4);
  }
  return { status: "executed", image: { width: p.widthPx, height: p.heightPx, data } };
}

// ---------------------------------------------------------------------------
// fit_artwork_to_canvas
// ---------------------------------------------------------------------------

export interface FitArtworkToCanvasParams {
  expectedArtworkWidthPx: number;
  expectedArtworkHeightPx: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  /**
   * Signs Flat-Raster Production Workflow Correction: the rectangle the
   * artwork's uniform scale is derived AGAINST, when smaller than the full
   * canvas — e.g. a safe-inset rectangle for a "Fit artwork to safe area"
   * correction (Section I/J). Buffer allocation and the placement bounds
   * check always still use `canvasWidthPx`/`canvasHeightPx` — only the
   * SCALE calculation reads this pair instead, when present. Omitted (or
   * equal to the canvas) reproduces the ordinary "fit to fill the whole
   * canvas" behavior every plan built before this phase already uses —
   * 100% backward compatible; every existing caller is unaffected.
   */
  scaleTargetWidthPx?: number;
  scaleTargetHeightPx?: number;
  placementXPx: number;
  placementYPx: number;
  backgroundR: number;
  backgroundG: number;
  backgroundB: number;
}

export function encodeFitArtworkToCanvasParams(p: FitArtworkToCanvasParams): Record<string, number | string> {
  const encoded: Record<string, number | string> = {
    expectedArtworkWidthPx: p.expectedArtworkWidthPx,
    expectedArtworkHeightPx: p.expectedArtworkHeightPx,
    canvasWidthPx: p.canvasWidthPx,
    canvasHeightPx: p.canvasHeightPx,
    placementXPx: p.placementXPx,
    placementYPx: p.placementYPx,
    backgroundR: p.backgroundR,
    backgroundG: p.backgroundG,
    backgroundB: p.backgroundB,
  };
  // Only ever persisted when genuinely smaller than the canvas — keeps
  // every plan built before this phase byte-identical in shape.
  if (p.scaleTargetWidthPx !== undefined) encoded.scaleTargetWidthPx = p.scaleTargetWidthPx;
  if (p.scaleTargetHeightPx !== undefined) encoded.scaleTargetHeightPx = p.scaleTargetHeightPx;
  return encoded;
}

export function decodeFitArtworkToCanvasParams(params: Record<string, number | string>): FitArtworkToCanvasParams | null {
  const expectedArtworkWidthPx = requirePositiveInt(params.expectedArtworkWidthPx);
  const expectedArtworkHeightPx = requirePositiveInt(params.expectedArtworkHeightPx);
  const canvasWidthPx = requirePositiveInt(params.canvasWidthPx);
  const canvasHeightPx = requirePositiveInt(params.canvasHeightPx);
  const placementXPx = requireNonNegativeInt(params.placementXPx);
  const placementYPx = requireNonNegativeInt(params.placementYPx);
  const backgroundR = requireByteChannel(params.backgroundR);
  const backgroundG = requireByteChannel(params.backgroundG);
  const backgroundB = requireByteChannel(params.backgroundB);
  if (
    expectedArtworkWidthPx === null || expectedArtworkHeightPx === null ||
    canvasWidthPx === null || canvasHeightPx === null ||
    placementXPx === null || placementYPx === null ||
    backgroundR === null || backgroundG === null || backgroundB === null
  ) {
    return null;
  }
  // Optional: absent for every plan built before this phase. Present but
  // invalid (e.g. non-positive) is a genuine decode failure, never
  // silently ignored — a malformed inset must never fall back to "fit to
  // fill" behind the operator's back.
  let scaleTargetWidthPx: number | undefined;
  let scaleTargetHeightPx: number | undefined;
  if (params.scaleTargetWidthPx !== undefined) {
    const v = requirePositiveInt(params.scaleTargetWidthPx);
    if (v === null) return null;
    scaleTargetWidthPx = v;
  }
  if (params.scaleTargetHeightPx !== undefined) {
    const v = requirePositiveInt(params.scaleTargetHeightPx);
    if (v === null) return null;
    scaleTargetHeightPx = v;
  }
  return {
    expectedArtworkWidthPx, expectedArtworkHeightPx, canvasWidthPx, canvasHeightPx,
    scaleTargetWidthPx, scaleTargetHeightPx,
    placementXPx, placementYPx, backgroundR, backgroundG, backgroundB,
  };
}

/** The uniform (never non-uniform) scale + resampled pixel size a `fit_artwork_to_canvas` step must place its artwork at — recomputed, never trusted from a stored value, by BOTH execution and verification. */
export function deriveUniformFitDimensions(
  artworkWidthPx: number,
  artworkHeightPx: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
): { scale: number; scaledWidthPx: number; scaledHeightPx: number } {
  const scale = Math.min(canvasWidthPx / artworkWidthPx, canvasHeightPx / artworkHeightPx);
  return {
    scale,
    scaledWidthPx: Math.max(1, Math.round(artworkWidthPx * scale)),
    scaledHeightPx: Math.max(1, Math.round(artworkHeightPx * scale)),
  };
}

/**
 * Creates the authoritative output canvas FIRST (exactly `canvasWidthPx` x
 * `canvasHeightPx` — the plan's own already-fixed, artwork-independent
 * dimensions), then uniformly fits the artwork into it at the plan's own
 * explicit `placementXPx`/`placementYPx`, filling every uncovered canvas
 * pixel with the plan's own explicit, operator-measured background colour.
 * Uniform scale only (never non-uniform/stretched) — `deriveUniform
 * FitDimensions` derives both axes from ONE scale factor.
 */
export function executeFitArtworkToCanvas(
  artwork: RgbaImage,
  step: SignRepairStep,
): { status: "executed"; image: RgbaImage } | { status: "refused"; reason: "unsupported_step_kind"; detail: string } {
  const p = decodeFitArtworkToCanvasParams(step.params);
  if (!p) return refuse(`Step "fit_artwork_to_canvas" is missing valid parameters.`);
  if (artwork.width !== p.expectedArtworkWidthPx || artwork.height !== p.expectedArtworkHeightPx) {
    return refuse(
      `Step "fit_artwork_to_canvas" expected a ${p.expectedArtworkWidthPx}x${p.expectedArtworkHeightPx}px artwork, ` +
        `but received ${artwork.width}x${artwork.height}px — refusing rather than fitting the wrong source identity.`,
    );
  }
  const scaleTargetWidthPx = p.scaleTargetWidthPx ?? p.canvasWidthPx;
  const scaleTargetHeightPx = p.scaleTargetHeightPx ?? p.canvasHeightPx;
  if (scaleTargetWidthPx > p.canvasWidthPx || scaleTargetHeightPx > p.canvasHeightPx) {
    return refuse(
      `Step "fit_artwork_to_canvas" scale target ${scaleTargetWidthPx}x${scaleTargetHeightPx}px exceeds the ` +
        `${p.canvasWidthPx}x${p.canvasHeightPx}px canvas — refusing rather than scaling past the canvas bounds.`,
    );
  }
  const { scaledWidthPx, scaledHeightPx } = deriveUniformFitDimensions(
    artwork.width, artwork.height, scaleTargetWidthPx, scaleTargetHeightPx,
  );
  if (p.placementXPx + scaledWidthPx > p.canvasWidthPx || p.placementYPx + scaledHeightPx > p.canvasHeightPx) {
    return refuse(
      `Step "fit_artwork_to_canvas" placement [${p.placementXPx},${p.placementYPx}] with fitted size ` +
        `${scaledWidthPx}x${scaledHeightPx}px does not fit inside the ${p.canvasWidthPx}x${p.canvasHeightPx}px canvas.`,
    );
  }
  const { image: fitted } = resampleExact(artwork, scaledWidthPx, scaledHeightPx);

  const data = Buffer.alloc(p.canvasWidthPx * p.canvasHeightPx * 4);
  for (let i = 0; i < p.canvasWidthPx * p.canvasHeightPx; i++) {
    data[i * 4] = p.backgroundR;
    data[i * 4 + 1] = p.backgroundG;
    data[i * 4 + 2] = p.backgroundB;
    data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < scaledHeightPx; y++) {
    const srcRowStart = y * scaledWidthPx * 4;
    const destRowStart = ((y + p.placementYPx) * p.canvasWidthPx + p.placementXPx) * 4;
    fitted.data.copy(data, destRowStart, srcRowStart, srcRowStart + scaledWidthPx * 4);
  }
  return { status: "executed", image: { width: p.canvasWidthPx, height: p.canvasHeightPx, data } };
}

// ---------------------------------------------------------------------------
// Post-Reconstruction Geometry Adaptation for fit_artwork_to_canvas (S3C
// extension, Phase 3B): the composition-primitive sibling of
// `sign-transform-executor.ts`'s own `adaptGeometryStepsToActualReconstruction`
// for the four LEGACY geometry-stage step kinds — that function never
// recognized any Phase 3B composition primitive (it predates them), which is
// exactly the gap that let a real, authorized `[reconstruct_resolution,
// fit_artwork_to_canvas]` plan refuse deterministically forever whenever the
// provider's actual reconstruction diverged from the planner's assumed
// (requested) size: `expectedArtworkWidthPx`/`expectedArtworkHeightPx` stayed
// pinned to the REQUESTED reconstruction size, so `executeFitArtworkToCanvas`
// correctly (and by design) refused the ACTUAL, differently-sized artwork it
// was actually handed.
// ---------------------------------------------------------------------------

export type AdaptFitArtworkToCanvasOutcome =
  | {
      status: "unchanged" | "adapted";
      step: SignRepairStep;
      /** The step's own (possibly re-derived) canvas dimensions — what the caller must validate the final executed output against, mirroring `AdaptGeometryStepsOutcome`'s own `expectedOutputWidthPx`/`expectedOutputHeightPx` contract. */
      canvasWidthPx: number;
      canvasHeightPx: number;
    }
  | { status: "refused"; reason: string; detail: string };

/**
 * Re-derives a persisted `fit_artwork_to_canvas` step's params from the
 * ACTUAL reconstructed artwork dimensions, when they diverge from the step's
 * own planning-time `expectedArtworkWidthPx`/`expectedArtworkHeightPx` — by
 * running the artwork's ACTUAL dimensions through the exact same formula
 * `buildSignCompositionPlan` used to build the step in the first place
 * (`deriveCanvasPixelDensity` → canvas size → `signSafeInsetPxForAxis` →
 * scale target → `deriveUniformFitDimensions` → centered placement), never a
 * separate or approximated calculation. This guarantees the adapted step
 * describes EXACTLY the physical composition (36x24in canvas, artwork
 * uniformly scaled, centered, 0.125in protected-content safe area,
 * background extended to every uncovered edge) the operator actually
 * authorized — only which PIXELS represent it changes.
 *
 * NEVER mutates the persisted plan, never changes plan identity/`planKey`,
 * never re-plans. Refuses — never silently reinterprets — the instant any
 * of the physical relationships the authorized step encoded cannot be
 * proven to carry over safely:
 *
 *   - the step's own params cannot be decoded at all;
 *   - the actual artwork's aspect ratio no longer matches the ordered
 *     physical size closely enough (reuses the SAME
 *     `deriveUniformBackgroundExtension` aspect check
 *     `adaptGeometryStepsToActualReconstruction`'s own "no geometry step to
 *     adapt" branch already applies, so both paths agree on what counts as
 *     "too far off to salvage" — a `fit_artwork_to_canvas`-only segment has
 *     no step of its own that could add a corrective extension);
 *   - the recomputed physical safe-area inset would leave no positive fit
 *     area on the adapted canvas;
 *   - the persisted placement was NOT the ordinary centered default (proven
 *     by recomputing that default from the step's OWN persisted values and
 *     comparing) — an explicit, non-centered operator placement has no
 *     provably-correct translation to a differently-sized canvas, so this
 *     never guesses one; or
 *   - the recomputed placement would not fit inside the adapted canvas.
 */
export function adaptFitArtworkToCanvasStepToActualReconstruction(
  step: SignRepairStep,
  actualArtworkWidthPx: number,
  actualArtworkHeightPx: number,
  orderedWidthIn: number,
  orderedHeightIn: number,
  minimumSafeInsetIn: number,
): AdaptFitArtworkToCanvasOutcome {
  const p = decodeFitArtworkToCanvasParams(step.params);
  if (!p) {
    return {
      status: "refused",
      reason: "missing_or_invalid_params",
      detail: `Step "fit_artwork_to_canvas" has missing or invalid persisted parameters — refusing to adapt rather than guessing.`,
    };
  }

  if (actualArtworkWidthPx === p.expectedArtworkWidthPx && actualArtworkHeightPx === p.expectedArtworkHeightPx) {
    // The provider returned EXACTLY what was requested — the persisted step
    // already applies verbatim.
    return { status: "unchanged", step, canvasWidthPx: p.canvasWidthPx, canvasHeightPx: p.canvasHeightPx };
  }

  // The adapted canvas must still be EXACTLY the ordered physical aspect
  // ratio. `deriveUniformBackgroundExtension`'s `plateWidthPx`/`plateHeightPx`
  // in the `!needsExtension` case are simply the actual artwork's own
  // dimensions — identical to `buildSignCompositionPlan`'s own
  // `deriveCanvasPixelDensity` → `round(orderedIn * canvasPpi)` whenever the
  // actual artwork is genuinely proportional (which it always reduces to,
  // for an exact-aspect input); reusing this ALREADY-PROVEN helper rather
  // than re-deriving canvas density independently.
  const geometry = deriveUniformBackgroundExtension(
    actualArtworkWidthPx,
    actualArtworkHeightPx,
    orderedWidthIn,
    orderedHeightIn,
  );
  if (geometry.needsExtension) {
    return {
      status: "refused",
      reason: "aspect_ratio_drift",
      detail:
        `The actual reconstruction (${actualArtworkWidthPx}x${actualArtworkHeightPx}px) no longer matches the ` +
        `ordered ${orderedWidthIn}x${orderedHeightIn}in aspect ratio closely enough for fit_artwork_to_canvas ` +
        "alone to adapt — refusing rather than fabricating an extension the approved plan never included.",
    };
  }
  const newCanvasWidthPx = geometry.plateWidthPx;
  const newCanvasHeightPx = geometry.plateHeightPx;

  // Presence of scaleTargetWidthPx/HeightPx is the reliable, persisted
  // signal that this step encodes a genuine physical safe-area inset
  // (`encodeFitArtworkToCanvasParams`'s own doc) rather than the ordinary
  // "fit to fill the whole canvas" shape — recompute the SAME physical inset
  // (never a stale pixel value scaled by a ratio) at the adapted canvas's
  // own achieved density, via the identical `signSafeInsetPxForAxis`
  // function the validator itself uses, so an adapted fit is guaranteed to
  // land inside the SAME validator SAFE guide a non-adapted one would.
  const hadSafeAreaInset = p.scaleTargetWidthPx !== undefined && p.scaleTargetHeightPx !== undefined;
  let newScaleTargetWidthPx: number | undefined;
  let newScaleTargetHeightPx: number | undefined;
  if (hadSafeAreaInset) {
    const newInsetPxX = signSafeInsetPxForAxis(minimumSafeInsetIn, newCanvasWidthPx / orderedWidthIn);
    const newInsetPxY = signSafeInsetPxForAxis(minimumSafeInsetIn, newCanvasHeightPx / orderedHeightIn);
    newScaleTargetWidthPx = newCanvasWidthPx - 2 * newInsetPxX;
    newScaleTargetHeightPx = newCanvasHeightPx - 2 * newInsetPxY;
    if (newScaleTargetWidthPx <= 0 || newScaleTargetHeightPx <= 0) {
      return {
        status: "refused",
        reason: "safe_area_inset_exceeds_canvas",
        detail:
          `The recomputed ${minimumSafeInsetIn}in physical safe-area inset leaves no positive area to fit ` +
          `artwork into on the adapted ${newCanvasWidthPx}x${newCanvasHeightPx}px canvas.`,
      };
    }
  }

  // Placement translation is only ever attempted when the PERSISTED
  // placement is provably the ordinary centered default — recomputed here
  // from the step's OWN persisted (planning-time) values, never assumed.
  // An explicit, operator-chosen non-centered placement has no
  // provably-correct translation to a differently-sized canvas.
  const oldScaleTargetWidthPx = p.scaleTargetWidthPx ?? p.canvasWidthPx;
  const oldScaleTargetHeightPx = p.scaleTargetHeightPx ?? p.canvasHeightPx;
  const oldFit = deriveUniformFitDimensions(
    p.expectedArtworkWidthPx, p.expectedArtworkHeightPx, oldScaleTargetWidthPx, oldScaleTargetHeightPx,
  );
  const oldDefaultPlacementXPx = Math.floor((p.canvasWidthPx - oldFit.scaledWidthPx) / 2);
  const oldDefaultPlacementYPx = Math.floor((p.canvasHeightPx - oldFit.scaledHeightPx) / 2);
  if (p.placementXPx !== oldDefaultPlacementXPx || p.placementYPx !== oldDefaultPlacementYPx) {
    return {
      status: "refused",
      reason: "explicit_placement_cannot_be_translated",
      detail:
        `Step "fit_artwork_to_canvas" was placed at an explicit, non-default position ` +
        `[${p.placementXPx},${p.placementYPx}] — refusing to guess how that placement should translate to the ` +
        `adapted ${newCanvasWidthPx}x${newCanvasHeightPx}px canvas.`,
    };
  }

  const newFit = deriveUniformFitDimensions(
    actualArtworkWidthPx, actualArtworkHeightPx,
    newScaleTargetWidthPx ?? newCanvasWidthPx, newScaleTargetHeightPx ?? newCanvasHeightPx,
  );
  const newPlacementXPx = Math.floor((newCanvasWidthPx - newFit.scaledWidthPx) / 2);
  const newPlacementYPx = Math.floor((newCanvasHeightPx - newFit.scaledHeightPx) / 2);
  if (
    newPlacementXPx < 0 || newPlacementYPx < 0 ||
    newPlacementXPx + newFit.scaledWidthPx > newCanvasWidthPx ||
    newPlacementYPx + newFit.scaledHeightPx > newCanvasHeightPx
  ) {
    return {
      status: "refused",
      reason: "adapted_placement_out_of_bounds",
      detail:
        `The adapted placement [${newPlacementXPx},${newPlacementYPx}] with fitted size ` +
        `${newFit.scaledWidthPx}x${newFit.scaledHeightPx}px does not fit inside the adapted ` +
        `${newCanvasWidthPx}x${newCanvasHeightPx}px canvas.`,
    };
  }

  const adaptedStep: SignRepairStep = {
    ...step,
    params: encodeFitArtworkToCanvasParams({
      expectedArtworkWidthPx: actualArtworkWidthPx,
      expectedArtworkHeightPx: actualArtworkHeightPx,
      canvasWidthPx: newCanvasWidthPx,
      canvasHeightPx: newCanvasHeightPx,
      scaleTargetWidthPx: newScaleTargetWidthPx,
      scaleTargetHeightPx: newScaleTargetHeightPx,
      placementXPx: newPlacementXPx,
      placementYPx: newPlacementYPx,
      backgroundR: p.backgroundR,
      backgroundG: p.backgroundG,
      backgroundB: p.backgroundB,
    }),
  };

  return { status: "adapted", step: adaptedStep, canvasWidthPx: newCanvasWidthPx, canvasHeightPx: newCanvasHeightPx };
}

// ---------------------------------------------------------------------------
// move_region — V1: horizontal (full-width) bands only.
// ---------------------------------------------------------------------------

export interface MoveRegionParams {
  sourceStartYPx: number;
  heightPx: number;
  destStartYPx: number;
}

export function encodeMoveRegionParams(p: MoveRegionParams): Record<string, number | string> {
  return { ...p };
}

export function decodeMoveRegionParams(params: Record<string, number | string>): MoveRegionParams | null {
  const sourceStartYPx = requireNonNegativeInt(params.sourceStartYPx);
  const heightPx = requirePositiveInt(params.heightPx);
  const destStartYPx = requireNonNegativeInt(params.destStartYPx);
  if (sourceStartYPx === null || heightPx === null || destStartYPx === null) return null;
  return { sourceStartYPx, heightPx, destStartYPx };
}

/**
 * Translates a full-canvas-width horizontal band from `baseCanvas` (the
 * fixed, immutable post-`fit_artwork_to_canvas` snapshot — NEVER the
 * progressively-mutated `working` buffer, see this module's own doc) to a
 * new Y position in `working`. Byte-for-byte copy — no resize, no warp, no
 * independent OCR/text manipulation, no colour touched.
 */
export function applyMoveRegion(
  baseCanvas: RgbaImage,
  working: Buffer,
  step: SignRepairStep,
): { status: "refused"; reason: "unsupported_step_kind"; detail: string } | null {
  const p = decodeMoveRegionParams(step.params);
  if (!p) return refuse(`Step "move_region" is missing valid parameters.`);
  if (p.sourceStartYPx + p.heightPx > baseCanvas.height) {
    return refuse(
      `Step "move_region" source band [${p.sourceStartYPx},${p.heightPx}] exceeds the ` +
        `${baseCanvas.height}px canvas height.`,
    );
  }
  if (p.destStartYPx + p.heightPx > baseCanvas.height) {
    return refuse(
      `Step "move_region" destination band [${p.destStartYPx},${p.heightPx}] exceeds the ` +
        `${baseCanvas.height}px canvas height.`,
    );
  }
  const rowBytes = baseCanvas.width * 4;
  for (let y = 0; y < p.heightPx; y++) {
    const srcRowStart = (p.sourceStartYPx + y) * rowBytes;
    const destRowStart = (p.destStartYPx + y) * rowBytes;
    baseCanvas.data.copy(working, destRowStart, srcRowStart, srcRowStart + rowBytes);
  }
  return null;
}

// ---------------------------------------------------------------------------
// fill_rect — bounded rectangle only, never implicit full-width.
// ---------------------------------------------------------------------------

export interface FillRectParams {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  colorR: number;
  colorG: number;
  colorB: number;
}

export function encodeFillRectParams(p: FillRectParams): Record<string, number | string> {
  return { ...p };
}

export function decodeFillRectParams(params: Record<string, number | string>): FillRectParams | null {
  const xPx = requireNonNegativeInt(params.xPx);
  const yPx = requireNonNegativeInt(params.yPx);
  const widthPx = requirePositiveInt(params.widthPx);
  const heightPx = requirePositiveInt(params.heightPx);
  const colorR = requireByteChannel(params.colorR);
  const colorG = requireByteChannel(params.colorG);
  const colorB = requireByteChannel(params.colorB);
  if (
    xPx === null || yPx === null || widthPx === null || heightPx === null ||
    colorR === null || colorG === null || colorB === null
  ) {
    return null;
  }
  return { xPx, yPx, widthPx, heightPx, colorR, colorG, colorB };
}

/**
 * Fills EXACTLY the plan's own explicit `[xPx,yPx,widthPx,heightPx]`
 * rectangle with the plan's own explicit, operator-measured flat colour.
 * Never implicit full-width — the Phase 3A defect ("large blank red
 * extensions… broke the visual composition") this primitive exists to make
 * structurally impossible: there is no parameter here through which a fill
 * could ever cover more than the exact rectangle the operator chose.
 */
export function applyFillRect(
  working: Buffer,
  canvasWidthPx: number,
  canvasHeightPx: number,
  step: SignRepairStep,
): { status: "refused"; reason: "unsupported_step_kind"; detail: string } | null {
  const p = decodeFillRectParams(step.params);
  if (!p) return refuse(`Step "fill_rect" is missing valid parameters.`);
  if (p.xPx + p.widthPx > canvasWidthPx || p.yPx + p.heightPx > canvasHeightPx) {
    return refuse(
      `Step "fill_rect" rectangle [${p.xPx},${p.yPx},${p.widthPx}x${p.heightPx}] exceeds the ` +
        `${canvasWidthPx}x${canvasHeightPx}px canvas.`,
    );
  }
  for (let y = 0; y < p.heightPx; y++) {
    const rowStart = ((p.yPx + y) * canvasWidthPx + p.xPx) * 4;
    for (let x = 0; x < p.widthPx; x++) {
      const i = rowStart + x * 4;
      working[i] = p.colorR;
      working[i + 1] = p.colorG;
      working[i + 2] = p.colorB;
      working[i + 3] = 255;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// replace_region_with_background — operator-authorized REMOVAL of an
// unwanted artifact (e.g. a decorative rounded-corner arc, a mounting-hole
// graphic), never a `fill_rect`-shaped "construct known background" op.
// ---------------------------------------------------------------------------

/**
 * Chebyshev RGB membership tolerance for the surrounding-context check.
 * Deliberately LOOSER than `edge-inspection.ts`'s own `EDGE_BACKGROUND_
 * TOLERANCE` (12) — that figure was calibrated for a genuinely flat,
 * computer-generated EXPORT; the real cc6cfc4b-… acceptance sign's own
 * "solid" red banners measured a genuine ±20-30 unit variance across their
 * own field (a subtle rendered gradient/shading, not a defect, confirmed
 * by direct measurement at multiple points before this constant was set)
 * — a print/photographic sign mockup, unlike a flat vector export, is
 * legitimately not perfectly flat. Still meaningfully strict: a genuinely
 * DIFFERENT colour (black border residue against red, or vice versa) is
 * an order of magnitude further away than this and is still refused
 * every time — see this module's own tests.
 */
export const REPLACE_REGION_CONTEXT_TOLERANCE = 40;

export interface ReplaceRegionWithBackgroundParams {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  colorR: number;
  colorG: number;
  colorB: number;
  /** How many px of surrounding context (outside the rect, clamped to canvas bounds) must independently verify as the same uniform colour before this step is allowed to run. */
  contextDepthPx: number;
}

export function encodeReplaceRegionWithBackgroundParams(p: ReplaceRegionWithBackgroundParams): Record<string, number | string> {
  return { ...p };
}

export function decodeReplaceRegionWithBackgroundParams(params: Record<string, number | string>): ReplaceRegionWithBackgroundParams | null {
  const xPx = requireNonNegativeInt(params.xPx);
  const yPx = requireNonNegativeInt(params.yPx);
  const widthPx = requirePositiveInt(params.widthPx);
  const heightPx = requirePositiveInt(params.heightPx);
  const colorR = requireByteChannel(params.colorR);
  const colorG = requireByteChannel(params.colorG);
  const colorB = requireByteChannel(params.colorB);
  const contextDepthPx = requirePositiveInt(params.contextDepthPx);
  if (
    xPx === null || yPx === null || widthPx === null || heightPx === null ||
    colorR === null || colorG === null || colorB === null || contextDepthPx === null
  ) {
    return null;
  }
  return { xPx, yPx, widthPx, heightPx, colorR, colorG, colorB, contextDepthPx };
}

function chebyshevDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}

/**
 * Independently re-measures the ring of pixels immediately surrounding
 * `[xPx,yPx,widthPx,heightPx]` (out to `contextDepthPx`, clamped to the
 * canvas) and requires EVERY one to match `(colorR,colorG,colorB)` within
 * `REPLACE_REGION_CONTEXT_TOLERANCE` — the "refuses ambiguous/nonuniform
 * background" requirement, made real and executable rather than a
 * documentation-only promise. Reads from `working` (the canvas as it
 * ACTUALLY stands at this point in the plan — after any prior fit/move/
 * fill — never the pre-move base snapshot), because what must blend
 * seamlessly is the FINAL output, not an earlier intermediate state.
 */
export function verifyReplaceRegionSurroundingContext(
  working: Buffer,
  canvasWidthPx: number,
  canvasHeightPx: number,
  p: ReplaceRegionWithBackgroundParams,
): { uniform: boolean; detail: string; sampledPx: number; mismatchedPx: number } {
  const ringX0 = Math.max(0, p.xPx - p.contextDepthPx);
  const ringY0 = Math.max(0, p.yPx - p.contextDepthPx);
  const ringX1 = Math.min(canvasWidthPx, p.xPx + p.widthPx + p.contextDepthPx);
  const ringY1 = Math.min(canvasHeightPx, p.yPx + p.heightPx + p.contextDepthPx);
  let sampled = 0;
  let mismatched = 0;
  for (let y = ringY0; y < ringY1; y++) {
    const insideRectRow = y >= p.yPx && y < p.yPx + p.heightPx;
    for (let x = ringX0; x < ringX1; x++) {
      if (insideRectRow && x >= p.xPx && x < p.xPx + p.widthPx) continue; // inside the rect itself — not context
      sampled++;
      const i = (y * canvasWidthPx + x) * 4;
      if (chebyshevDistance(working[i]!, working[i + 1]!, working[i + 2]!, p.colorR, p.colorG, p.colorB) > REPLACE_REGION_CONTEXT_TOLERANCE) {
        mismatched++;
      }
    }
  }
  const uniform = sampled > 0 && mismatched === 0;
  return {
    uniform,
    detail: uniform
      ? `${sampled}px of surrounding context all matched rgb(${p.colorR},${p.colorG},${p.colorB}) within tolerance ${REPLACE_REGION_CONTEXT_TOLERANCE}.`
      : sampled === 0
        ? "No surrounding context pixels were available to verify (contextDepthPx entirely clipped by canvas bounds)."
        : `${mismatched} of ${sampled} surrounding context px did not match rgb(${p.colorR},${p.colorG},${p.colorB}) within tolerance ${REPLACE_REGION_CONTEXT_TOLERANCE} — refusing rather than risk erasing something that crosses non-uniform artwork.`,
    sampledPx: sampled,
    mismatchedPx: mismatched,
  };
}

/**
 * Operator-authorized removal of an unwanted artifact — mechanically a
 * bounded flat fill (identical pixel loop to `applyFillRect`), but gated
 * on an independent re-measurement of the surrounding context FIRST (see
 * `verifyReplaceRegionSurroundingContext`). Never generative, never a
 * brush, never a freehand mask — exactly one rectangle, exactly one
 * already-measured colour.
 */
export function applyReplaceRegionWithBackground(
  working: Buffer,
  canvasWidthPx: number,
  canvasHeightPx: number,
  step: SignRepairStep,
): { status: "refused"; reason: "unsupported_step_kind"; detail: string } | null {
  const p = decodeReplaceRegionWithBackgroundParams(step.params);
  if (!p) return refuse(`Step "replace_region_with_background" is missing valid parameters.`);
  if (p.xPx + p.widthPx > canvasWidthPx || p.yPx + p.heightPx > canvasHeightPx) {
    return refuse(
      `Step "replace_region_with_background" rectangle [${p.xPx},${p.yPx},${p.widthPx}x${p.heightPx}] exceeds the ` +
        `${canvasWidthPx}x${canvasHeightPx}px canvas.`,
    );
  }
  const context = verifyReplaceRegionSurroundingContext(working, canvasWidthPx, canvasHeightPx, p);
  if (!context.uniform) {
    return refuse(`Step "replace_region_with_background" refused: ${context.detail}`);
  }
  for (let y = 0; y < p.heightPx; y++) {
    const rowStart = ((p.yPx + y) * canvasWidthPx + p.xPx) * 4;
    for (let x = 0; x < p.widthPx; x++) {
      const i = rowStart + x * 4;
      working[i] = p.colorR;
      working[i + 1] = p.colorG;
      working[i + 2] = p.colorB;
      working[i + 3] = 255;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// replace_masked_region_with_background — Wand-First Correction UX Phase:
// the mask-shaped sibling of replace_region_with_background, for a wand
// (flood-fill) selection that is not itself rectangular. Reuses
// `verifyReplaceRegionSurroundingContext` UNCHANGED for the gate (measured
// against the selection's own bounding rectangle — what's AROUND the
// selection, never the selection's own interior shape); only the WRITE
// differs, honoring the persisted mask pixel-for-pixel so a non-rectangular
// selection can never silently widen into deleting unrelated artwork that
// merely shares its bounding box.
// ---------------------------------------------------------------------------

/**
 * A bounding-rectangle area ceiling for a persisted wand-selection mask —
 * generous enough for any localized artifact (a hole, a mark, a border
 * segment) at real production resolution, far short of the full ~20.7MP
 * canvas. Exists only to keep a plan step's own persisted size bounded and
 * predictable; it is never silently raised by truncating or resampling a
 * larger mask — a selection over this ceiling is refused outright, with the
 * operator directed to select a smaller area or use the rectangle-based
 * tool instead.
 */
export const MAX_MASKED_REGION_PIXELS = 4_000_000;

export interface ReplaceMaskedRegionWithBackgroundParams {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  colorR: number;
  colorG: number;
  colorB: number;
  /** How many px of surrounding context (outside the bounding rect, clamped to canvas bounds) must independently verify as the same uniform colour before this step is allowed to run. */
  contextDepthPx: number;
  /** `widthPx * heightPx` bytes (1 = selected), row-major, base64-encoded — the exact persisted selection mask, sized to the bounding rectangle above, never the full canvas. */
  maskBase64: string;
}

export function encodeReplaceMaskedRegionWithBackgroundParams(
  p: ReplaceMaskedRegionWithBackgroundParams,
): Record<string, number | string> {
  return { ...p };
}

export function decodeReplaceMaskedRegionWithBackgroundParams(
  params: Record<string, number | string>,
): ReplaceMaskedRegionWithBackgroundParams | null {
  const xPx = requireNonNegativeInt(params.xPx);
  const yPx = requireNonNegativeInt(params.yPx);
  const widthPx = requirePositiveInt(params.widthPx);
  const heightPx = requirePositiveInt(params.heightPx);
  const colorR = requireByteChannel(params.colorR);
  const colorG = requireByteChannel(params.colorG);
  const colorB = requireByteChannel(params.colorB);
  const contextDepthPx = requirePositiveInt(params.contextDepthPx);
  const maskBase64 = typeof params.maskBase64 === "string" ? params.maskBase64 : null;
  if (
    xPx === null || yPx === null || widthPx === null || heightPx === null ||
    colorR === null || colorG === null || colorB === null || contextDepthPx === null ||
    maskBase64 === null
  ) {
    return null;
  }
  if (widthPx * heightPx > MAX_MASKED_REGION_PIXELS) return null;
  let maskBytes: Buffer;
  try {
    maskBytes = Buffer.from(maskBase64, "base64");
  } catch {
    return null;
  }
  // Fail closed on any mismatch between the declared rectangle and the
  // actual decoded mask length — a corrupted/tampered/short mask must never
  // be silently padded, truncated, or reinterpreted at a different shape.
  if (maskBytes.length !== widthPx * heightPx) return null;
  return { xPx, yPx, widthPx, heightPx, colorR, colorG, colorB, contextDepthPx, maskBase64 };
}

/**
 * Mechanically identical gate to `applyReplaceRegionWithBackground` (same
 * `verifyReplaceRegionSurroundingContext` call, against the SAME bounding
 * rectangle) — the only difference is the write loop below, which touches
 * ONLY pixels the persisted mask marks selected. Every other pixel inside
 * `[xPx,yPx,widthPx,heightPx]` — anything the operator's wand click did NOT
 * actually select — is left byte-identical to `working`.
 */
export function applyReplaceMaskedRegionWithBackground(
  working: Buffer,
  canvasWidthPx: number,
  canvasHeightPx: number,
  step: SignRepairStep,
): { status: "refused"; reason: "unsupported_step_kind"; detail: string } | null {
  const p = decodeReplaceMaskedRegionWithBackgroundParams(step.params);
  if (!p) return refuse(`Step "replace_masked_region_with_background" is missing valid parameters, or its mask does not match its own declared rectangle.`);
  if (p.xPx + p.widthPx > canvasWidthPx || p.yPx + p.heightPx > canvasHeightPx) {
    return refuse(
      `Step "replace_masked_region_with_background" rectangle [${p.xPx},${p.yPx},${p.widthPx}x${p.heightPx}] exceeds the ` +
        `${canvasWidthPx}x${canvasHeightPx}px canvas.`,
    );
  }
  const context = verifyReplaceRegionSurroundingContext(working, canvasWidthPx, canvasHeightPx, {
    xPx: p.xPx, yPx: p.yPx, widthPx: p.widthPx, heightPx: p.heightPx,
    colorR: p.colorR, colorG: p.colorG, colorB: p.colorB, contextDepthPx: p.contextDepthPx,
  });
  if (!context.uniform) {
    return refuse(`Step "replace_masked_region_with_background" refused: ${context.detail}`);
  }
  const mask = Buffer.from(p.maskBase64, "base64");
  for (let y = 0; y < p.heightPx; y++) {
    const rowStart = ((p.yPx + y) * canvasWidthPx + p.xPx) * 4;
    const maskRowStart = y * p.widthPx;
    for (let x = 0; x < p.widthPx; x++) {
      if (!mask[maskRowStart + x]) continue; // not part of the persisted selection — untouched
      const i = rowStart + x * 4;
      working[i] = p.colorR;
      working[i + 1] = p.colorG;
      working[i + 2] = p.colorB;
      working[i + 3] = 255;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// measureUniformSurroundingBackground — Operator Production Correction UX
// (Smart Remove): auto-MEASURES a candidate replacement colour from the
// context ring around an operator-selected rectangle, rather than requiring
// the operator to type RGB values. Built strictly ON TOP of the existing,
// unweakened `verifyReplaceRegionSurroundingContext` — this never
// introduces a second tolerance or a looser membership rule; it only adds a
// MEASUREMENT step in front of the SAME verifier every `replace_region_
// with_background` step is already gated on. Reused UNCHANGED for a wand
// (masked) selection's own background measurement too — measurement is
// always against the selection's bounding rectangle, exactly like the
// rectangle tool, regardless of what shape the interior selection is.
// ---------------------------------------------------------------------------

/**
 * Measures a candidate background colour from the ring immediately
 * surrounding `[xPx,yPx,widthPx,heightPx]` (the mean of every ring pixel,
 * out to `contextDepthPx`, clamped to canvas bounds — excluding the
 * rectangle itself), then re-verifies EVERY ring pixel against that
 * candidate via `verifyReplaceRegionSurroundingContext` unchanged. Returns
 * the measured colour only when that verification genuinely passes —
 * exactly the same "refuses ambiguous/nonuniform background" guarantee
 * `applyReplaceRegionWithBackground` itself enforces at execution time, now
 * available BEFORE the operator commits to a colour. Never invents a colour
 * the surrounding pixels do not actually, uniformly have.
 */
export function measureUniformSurroundingBackground(
  image: RgbaImage,
  rect: { xPx: number; yPx: number; widthPx: number; heightPx: number },
  contextDepthPx: number,
):
  | { status: "measured"; color: { r: number; g: number; b: number }; context: ReturnType<typeof verifyReplaceRegionSurroundingContext> }
  | { status: "refused"; detail: string } {
  const xPx = requireNonNegativeInt(rect.xPx);
  const yPx = requireNonNegativeInt(rect.yPx);
  const widthPx = requirePositiveInt(rect.widthPx);
  const heightPx = requirePositiveInt(rect.heightPx);
  const depth = requirePositiveInt(contextDepthPx);
  if (xPx === null || yPx === null || widthPx === null || heightPx === null || depth === null) {
    return { status: "refused", detail: "The selected rectangle or context depth is not a valid set of whole-pixel bounds." };
  }
  if (xPx + widthPx > image.width || yPx + heightPx > image.height) {
    return { status: "refused", detail: `The selected rectangle [${xPx},${yPx},${widthPx}x${heightPx}] exceeds the ${image.width}x${image.height}px canvas.` };
  }

  const ringX0 = Math.max(0, xPx - depth);
  const ringY0 = Math.max(0, yPx - depth);
  const ringX1 = Math.min(image.width, xPx + widthPx + depth);
  const ringY1 = Math.min(image.height, yPx + heightPx + depth);
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = ringY0; y < ringY1; y++) {
    const insideRectRow = y >= yPx && y < yPx + heightPx;
    for (let x = ringX0; x < ringX1; x++) {
      if (insideRectRow && x >= xPx && x < xPx + widthPx) continue; // inside the rect itself — not context.
      const i = (y * image.width + x) * 4;
      sumR += image.data[i]!;
      sumG += image.data[i + 1]!;
      sumB += image.data[i + 2]!;
      count++;
    }
  }
  if (count === 0) {
    return { status: "refused", detail: "No surrounding context pixels were available to measure (contextDepthPx entirely clipped by canvas bounds)." };
  }
  const candidate = { r: Math.round(sumR / count), g: Math.round(sumG / count), b: Math.round(sumB / count) };

  const params: ReplaceRegionWithBackgroundParams = {
    xPx, yPx, widthPx, heightPx,
    colorR: candidate.r, colorG: candidate.g, colorB: candidate.b,
    contextDepthPx: depth,
  };
  const context = verifyReplaceRegionSurroundingContext(image.data, image.width, image.height, params);
  if (!context.uniform) {
    return {
      status: "refused",
      detail:
        `Background is not uniform enough for safe automatic removal (measured mean rgb(${candidate.r},${candidate.g},${candidate.b}), ` +
        `but ${context.detail}). Adjust the selection or leave this artwork for review.`,
    };
  }
  return { status: "measured", color: candidate, context };
}

// ---------------------------------------------------------------------------
// applyCorrectionsToCanvas — Operator Production Correction UX: applies an
// ordered sequence of move_region/fill_rect/replace_region_with_background
// steps directly on top of an ALREADY-COMPOSED canvas (e.g. the current
// production candidate), reusing the IDENTICAL fold `executeCompositionSteps`
// itself applies to its own move/fill/replace tail (`baseCanvas` — what
// move_region's SOURCE band reads, immutable for the whole call — and
// `working` — the mutable accumulator every step writes into — both start
// as the SAME candidate pixels). This is not a second implementation of
// that fold; it is the same functions (`applyMoveRegion`/`applyFillRect`/
// `applyReplaceRegionWithBackground`), called the same way, so an operator
// correction preview can never silently disagree with real plan execution
// about what one of these steps does.
// ---------------------------------------------------------------------------

export function applyCorrectionsToCanvas(
  candidate: RgbaImage,
  steps: SignRepairStep[],
): SignExecutionResult {
  if (
    !steps.every(
      (step) =>
        step.kind === "move_region" ||
        step.kind === "fill_rect" ||
        step.kind === "replace_region_with_background" ||
        step.kind === "replace_masked_region_with_background",
    )
  ) {
    return refuse(
      "Only move_region, fill_rect, replace_region_with_background, and replace_masked_region_with_background may be applied on top of an existing production candidate.",
    );
  }
  const baseCanvas = candidate;
  const working = Buffer.from(candidate.data);
  for (const step of steps) {
    let refusal: { status: "refused"; reason: "unsupported_step_kind"; detail: string } | null;
    if (step.kind === "move_region") {
      refusal = applyMoveRegion(baseCanvas, working, step);
    } else if (step.kind === "fill_rect") {
      refusal = applyFillRect(working, baseCanvas.width, baseCanvas.height, step);
    } else if (step.kind === "replace_region_with_background") {
      refusal = applyReplaceRegionWithBackground(working, baseCanvas.width, baseCanvas.height, step);
    } else {
      refusal = applyReplaceMaskedRegionWithBackground(working, baseCanvas.width, baseCanvas.height, step);
    }
    if (refusal) return refusal;
  }
  const outputImage: RgbaImage = { width: baseCanvas.width, height: baseCanvas.height, data: working };
  return {
    status: "executed",
    image: outputImage,
    contentBounds: { x: 0, y: 0, width: outputImage.width, height: outputImage.height },
  };
}

// ---------------------------------------------------------------------------
// Orchestration — the single entry point `sign-transform-executor.ts`
// delegates a whole composition-primitive step sequence to.
// ---------------------------------------------------------------------------

/**
 * Executes an ordered sequence of ONLY composition-primitive steps:
 * `[crop_region?] fit_artwork_to_canvas (move_region|fill_rect)*`. Any other
 * shape (composition kinds mixed with legacy kinds, more than one
 * `crop_region`, a `crop_region` after `fit_artwork_to_canvas`, no
 * `fit_artwork_to_canvas` at all, or an unrecognized kind anywhere in the
 * move/fill tail) refuses outright, before any pixel is touched beyond what
 * already ran.
 */
export function executeCompositionSteps(
  image: RgbaImage,
  _bounds: SignExecutionBounds,
  steps: SignRepairStep[],
): SignExecutionResult {
  if (steps.length === 0) {
    return refuse("A composition plan segment must contain at least a fit_artwork_to_canvas step.");
  }
  let index = 0;
  let artwork = image;
  if (steps[index]!.kind === "crop_region") {
    const cropped = executeCropRegion(artwork, steps[index]!);
    if (cropped.status === "refused") return cropped;
    artwork = cropped.image;
    index++;
  }
  if (steps[index]?.kind !== "fit_artwork_to_canvas") {
    return refuse(
      "A composition plan segment must contain exactly one fit_artwork_to_canvas step, immediately after an " +
        "optional leading crop_region — none was found at the expected position.",
    );
  }
  const fitted = executeFitArtworkToCanvas(artwork, steps[index]!);
  if (fitted.status === "refused") return fitted;
  index++;

  const baseCanvas = fitted.image;
  const working = Buffer.from(baseCanvas.data);
  for (; index < steps.length; index++) {
    const step = steps[index]!;
    let refusal: { status: "refused"; reason: "unsupported_step_kind"; detail: string } | null;
    if (step.kind === "move_region") {
      refusal = applyMoveRegion(baseCanvas, working, step);
    } else if (step.kind === "fill_rect") {
      refusal = applyFillRect(working, baseCanvas.width, baseCanvas.height, step);
    } else if (step.kind === "replace_region_with_background") {
      refusal = applyReplaceRegionWithBackground(working, baseCanvas.width, baseCanvas.height, step);
    } else if (step.kind === "replace_masked_region_with_background") {
      refusal = applyReplaceMaskedRegionWithBackground(working, baseCanvas.width, baseCanvas.height, step);
    } else {
      refusal = refuse(`Step "${step.kind}" is not admitted inside a composition plan's move/fill stage.`);
    }
    if (refusal) return refusal;
  }

  const outputImage: RgbaImage = { width: baseCanvas.width, height: baseCanvas.height, data: working };
  return {
    status: "executed",
    image: outputImage,
    // The entire canvas is meaningful production content under the
    // canvas-first model (crop/fit/reflow never leave a "blank added
    // margin" the way the legacy extend/pad steps did) — trivially within
    // bounds by construction.
    contentBounds: { x: 0, y: 0, width: outputImage.width, height: outputImage.height },
  };
}
