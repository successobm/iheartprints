/**
 * Signs Phase S2: the deterministic rigid-sign transform EXECUTOR.
 *
 * Replays a persisted `SignRepairPlan`'s steps, exactly and in order, against
 * the immutable source image. It does not plan, does not decide, and does
 * not reinterpret — it is the smallest component that turns "here is a
 * plan" into "here are the pixels that plan describes," nothing more.
 *
 * S2 EXECUTES exactly five step kinds: `extend_uniform_background`,
 * `pad_uniform_background`, `proportional_resample`, `downsample`,
 * `rotate_90`. `reconstruct_resolution` and `approved_crop` are NEVER
 * executed here — encountering either in the plan is an immediate, honest
 * refusal before any pixel is touched (Constitution §16A.3: S2 performs zero
 * provider reconstruction; `approved_crop` remains approval-gated, and no
 * approval mechanism exists yet).
 *
 * Never performs: crop, seam blending, generative extension, content-aware
 * fill, arbitrary color replacement, reconstruction, redraw, or text change.
 * A fill color the plan itself could not determine (`params.color ===
 * "unconfirmed"`) is refused rather than invented.
 */

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { hasAnyTransparentPixel, resampleExact } from "@/capabilities/final-artwork/raster-transform";

import type { SignRepairPlan, SignRepairStep } from "./contracts";

export interface SignExecutionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SignExecutionRefusalReason =
  | "contains_reconstruct_resolution"
  | "contains_approved_crop"
  | "source_transparent"
  | "unconfirmed_fill_color"
  | "unsupported_step_kind"
  | "output_geometry_mismatch"
  | "output_not_opaque";

export type SignExecutionResult =
  | {
      status: "executed";
      image: RgbaImage;
      /** The original source content's own bounds, in OUTPUT image coordinates — every original pixel lies within this rectangle, and every added region lies outside it. */
      contentBounds: SignExecutionBounds;
    }
  | { status: "refused"; reason: SignExecutionRefusalReason; detail: string };

const ADMITTED_STEP_KINDS = new Set<SignRepairStep["kind"]>([
  "extend_uniform_background",
  "pad_uniform_background",
  "proportional_resample",
  "downsample",
  "rotate_90",
]);

/** True iff every step in the plan is one of S2's admitted, executable kinds. */
export function planContainsOnlyAdmittedSteps(plan: SignRepairPlan): boolean {
  return plan.steps.every((step) => ADMITTED_STEP_KINDS.has(step.kind));
}

/**
 * Signs Phase S3A: true iff `plan` contains exactly one `reconstruct_resolution`
 * step and every OTHER step (before or after it — `rotate_90`, when present,
 * always precedes it; `extend_uniform_background`/`pad_uniform_background`/
 * `downsample`/`proportional_resample` always follow it, per the planner's
 * own "reconstruct FIRST [among resolution/geometry steps], extend SECOND"
 * ordering) is one of S2's admitted deterministic kinds. Distinct from
 * `planContainsOnlyAdmittedSteps` (which is false for any such plan, since
 * `reconstruct_resolution` itself is never S2-admitted): this predicate
 * identifies the plan shape S3A's bounded-provider-reconstruction dispatch
 * exists for, as opposed to a plan that is genuinely unsupported (e.g. one
 * containing `approved_crop`, or a plan with `reconstruct_resolution`
 * appearing more than once — never produced by the current planner, but not
 * trusted here either).
 */
export function planRequiresBoundedReconstruction(plan: SignRepairPlan): boolean {
  const reconstructCount = plan.steps.filter((step) => step.kind === "reconstruct_resolution").length;
  if (reconstructCount !== 1) return false;
  return plan.steps.every(
    (step) => step.kind === "reconstruct_resolution" || ADMITTED_STEP_KINDS.has(step.kind),
  );
}

/**
 * Signs Phase S3A: splits a plan satisfying `planRequiresBoundedReconstruction`
 * into the steps to execute locally BEFORE the provider reconstruction (e.g.
 * a review-gated `rotate_90`), the reconstruction step itself, and the steps
 * to execute locally AFTER it (e.g. `pad_uniform_background`). `null` when
 * the plan does not have exactly that shape — callers must check
 * `planRequiresBoundedReconstruction` first.
 */
export function splitPlanAroundReconstruction(
  plan: SignRepairPlan,
): { before: SignRepairStep[]; reconstruct: SignRepairStep; after: SignRepairStep[] } | null {
  if (!planRequiresBoundedReconstruction(plan)) return null;
  const index = plan.steps.findIndex((step) => step.kind === "reconstruct_resolution");
  return {
    before: plan.steps.slice(0, index),
    reconstruct: plan.steps[index]!,
    after: plan.steps.slice(index + 1),
  };
}

/**
 * Executes an ORDERED SUBSET of S2-admitted steps (never
 * `reconstruct_resolution`/`approved_crop`) against `image`/`bounds`,
 * refusing immediately on the first step this executor cannot honor.
 * Exported (Signs Phase S3A) so a caller that needs to run part of a plan
 * around an out-of-band operation — S3A's provider reconstruction sits
 * between `before` and `after` — can do so without duplicating the
 * step-dispatch switch `executeSignRepairPlan` itself uses for the ordinary,
 * fully-local case.
 */
export function executeAdmittedSignSteps(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  steps: SignRepairStep[],
): SignExecutionResult {
  let currentImage = image;
  let currentBounds = bounds;
  for (const step of steps) {
    const result = executeStep(currentImage, currentBounds, step);
    if (result.status === "refused") return result;
    currentImage = result.image;
    currentBounds = result.contentBounds;
  }
  return { status: "executed", image: currentImage, contentBounds: currentBounds };
}

/**
 * The tail of every execution, local-only or S3A-continued alike: the
 * executed output's geometry and opacity must match what the plan itself
 * declared before it is ever persisted. Exported (Signs Phase S3A) so the
 * worker's post-reconstruction continuation applies the exact same final
 * checks `executeSignRepairPlan` applies to a fully-local execution.
 */
export function finalizeSignExecution(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  plan: SignRepairPlan,
): SignExecutionResult {
  if (image.width !== plan.expectedOutputWidthPx || image.height !== plan.expectedOutputHeightPx) {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail:
        `Executed output is ${image.width}x${image.height}px, but the recorded plan expected ` +
        `${plan.expectedOutputWidthPx}x${plan.expectedOutputHeightPx}px. Refusing rather than persisting a plate the plan does not describe.`,
    };
  }
  if (hasAnyTransparentPixel(image)) {
    return {
      status: "refused",
      reason: "output_not_opaque",
      detail:
        "Executed output carries transparency despite an opaque, verified-opaque source and fill colours with full alpha. Refusing rather than persisting an unexpectedly non-opaque plate.",
    };
  }
  return { status: "executed", image, contentBounds: bounds };
}

/**
 * Replays `plan.steps`, in order, against `source`. `source` must already be
 * verified (by the caller) to be the exact bytes `plan.sourceSha256`
 * describes — this function performs no lineage check of its own; it only
 * refuses to execute plans it structurally cannot honor.
 */
export function executeSignRepairPlan(
  source: RgbaImage,
  plan: SignRepairPlan,
): SignExecutionResult {
  const reconstructStep = plan.steps.find((step) => step.kind === "reconstruct_resolution");
  if (reconstructStep) {
    return {
      status: "refused",
      reason: "contains_reconstruct_resolution",
      detail:
        "Plan requires provider reconstruction. S2 performs zero provider reconstruction — refusing before any pixel is touched, and no provider was dispatched.",
    };
  }
  const cropStep = plan.steps.find((step) => step.kind === "approved_crop");
  if (cropStep) {
    return {
      status: "refused",
      reason: "contains_approved_crop",
      detail:
        "Plan requires an approved crop. approved_crop remains approval-gated and is not part of S2 automatic execution.",
    };
  }
  if (hasAnyTransparentPixel(source)) {
    return {
      status: "refused",
      reason: "source_transparent",
      detail:
        "Source artwork carries transparency. No S2 step flattens transparency or invents a fill colour, so a legally opaque plate cannot be produced from it.",
    };
  }

  // The original content's own bounds, tracked through every transform in
  // OUTPUT coordinates. Starts as the whole source frame; extension/padding
  // offsets it, resample/downsample/rotation scale or reorient it, but no
  // step ever shrinks it to exclude a real source pixel.
  const initialBounds: SignExecutionBounds = { x: 0, y: 0, width: source.width, height: source.height };
  const executed = executeAdmittedSignSteps(source, initialBounds, plan.steps);
  if (executed.status === "refused") return executed;
  return finalizeSignExecution(executed.image, executed.contentBounds, plan);
}

function executeStep(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  switch (step.kind) {
    case "rotate_90":
      return { status: "executed", image: rotate90(image), contentBounds: rotateBounds(bounds, image) };
    case "downsample":
    case "proportional_resample":
      return executeResample(image, bounds, step);
    case "extend_uniform_background":
    case "pad_uniform_background":
      return executeExtend(image, bounds, step);
    default:
      return {
        status: "refused",
        reason: "unsupported_step_kind",
        detail: `Step kind "${step.kind}" is not part of S2's admitted execution vocabulary.`,
      };
  }
}

function requirePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function executeResample(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  const targetWidthPx = requirePositiveInt(step.params.targetWidthPx);
  const targetHeightPx = requirePositiveInt(step.params.targetHeightPx);
  if (targetWidthPx === null || targetHeightPx === null) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" is missing valid targetWidthPx/targetHeightPx parameters.`,
    };
  }
  const { image: resampled } = resampleExact(image, targetWidthPx, targetHeightPx);
  const scaleX = targetWidthPx / image.width;
  const scaleY = targetHeightPx / image.height;
  return {
    status: "executed",
    image: resampled,
    contentBounds: {
      x: Math.round(bounds.x * scaleX),
      y: Math.round(bounds.y * scaleY),
      width: Math.round(bounds.width * scaleX),
      height: Math.round(bounds.height * scaleY),
    },
  };
}

function executeExtend(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  const axis = step.params.axis;
  if (axis !== "horizontal" && axis !== "vertical") {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" has an invalid axis parameter.`,
    };
  }
  if (step.params.color === "unconfirmed") {
    return {
      status: "refused",
      reason: "unconfirmed_fill_color",
      detail:
        "Plan step has no confirmed fill colour (no affirmatively uniform background was measured). Refusing rather than inventing one.",
    };
  }
  const leadingPx = requirePositiveIntOrZero(step.params.leadingPx);
  const trailingPx = requirePositiveIntOrZero(step.params.trailingPx);
  const colorR = requireByteChannel(step.params.colorR);
  const colorG = requireByteChannel(step.params.colorG);
  const colorB = requireByteChannel(step.params.colorB);
  if (
    leadingPx === null ||
    trailingPx === null ||
    colorR === null ||
    colorG === null ||
    colorB === null
  ) {
    return {
      status: "refused",
      reason: "unconfirmed_fill_color",
      detail: `Step "${step.kind}" is missing valid leadingPx/trailingPx/colour parameters.`,
    };
  }

  const outputWidth = axis === "horizontal" ? image.width + leadingPx + trailingPx : image.width;
  const outputHeight = axis === "vertical" ? image.height + leadingPx + trailingPx : image.height;
  const offsetX = axis === "horizontal" ? leadingPx : 0;
  const offsetY = axis === "vertical" ? leadingPx : 0;

  const data = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let i = 0; i < outputWidth * outputHeight; i++) {
    data[i * 4] = colorR;
    data[i * 4 + 1] = colorG;
    data[i * 4 + 2] = colorB;
    data[i * 4 + 3] = 255;
  }
  // Blit the CURRENT image verbatim at the exact expected offset — original
  // content pixels are copied byte-for-byte, never touched.
  for (let y = 0; y < image.height; y++) {
    const srcRowStart = y * image.width * 4;
    const destRowStart = ((y + offsetY) * outputWidth + offsetX) * 4;
    image.data.copy(data, destRowStart, srcRowStart, srcRowStart + image.width * 4);
  }

  return {
    status: "executed",
    image: { width: outputWidth, height: outputHeight, data },
    contentBounds: { x: bounds.x + offsetX, y: bounds.y + offsetY, width: bounds.width, height: bounds.height },
  };
}

function requirePositiveIntOrZero(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function requireByteChannel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    return null;
  }
  return value;
}

/** Exact 90° clockwise rotation. Lossless — every pixel is preserved, dimensions swap exactly, no interpolation. */
function rotate90(image: RgbaImage): RgbaImage {
  const outputWidth = image.height;
  const outputHeight = image.width;
  const data = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const srcIdx = (y * image.width + x) * 4;
      // (x, y) -> (outputWidth - 1 - y, x) for a clockwise rotation.
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

function rotateBounds(bounds: SignExecutionBounds, preRotateImage: RgbaImage): SignExecutionBounds {
  const outputWidth = preRotateImage.height;
  // (x, y) -> (outputWidth - 1 - y, x); a rectangle's rotated bounds are
  // derived from its two extreme corners under that same mapping.
  const newX = outputWidth - (bounds.y + bounds.height);
  const newY = bounds.x;
  return { x: newX, y: newY, width: bounds.height, height: bounds.width };
}

/** Encodes an RGBA image to PNG bytes. The single encode path this executor uses. */
export function encodeSignPlate(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}
