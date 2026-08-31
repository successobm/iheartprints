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

import type { SignRepairPlan, SignRepairStep, SignRepairStepKind } from "./contracts";
import { deriveUniformBackgroundExtension } from "./sign-geometry";

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
 * executed output's geometry and opacity must match what the caller
 * declares as expected before it is ever persisted. Exported (Signs Phase
 * S3A) so the worker's post-reconstruction continuation applies the exact
 * same final checks `executeSignRepairPlan` applies to a fully-local
 * execution.
 *
 * Signs Phase S3C: takes `expectedWidthPx`/`expectedHeightPx` explicitly
 * rather than a whole `SignRepairPlan` — for a fully-local execution these
 * are always `plan.expectedOutputWidthPx`/`expectedOutputHeightPx`
 * (unchanged, see `executeSignRepairPlan` below), but a reconstruction-
 * continued execution may need to check against ACTUAL-reconstruction-
 * derived dimensions instead (see
 * `adaptGeometryStepsToActualReconstruction`) when the provider's admitted
 * output diverged from what the plan predicted — the plan's own persisted
 * `expectedOutputWidthPx`/`expectedOutputHeightPx` stay untouched either
 * way; only what THIS check validates against can differ.
 */
export function finalizeSignExecution(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  expectedWidthPx: number,
  expectedHeightPx: number,
): SignExecutionResult {
  if (image.width !== expectedWidthPx || image.height !== expectedHeightPx) {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail:
        `Executed output is ${image.width}x${image.height}px, but the expected output is ` +
        `${expectedWidthPx}x${expectedHeightPx}px. Refusing rather than persisting a plate the plan does not describe.`,
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
  return finalizeSignExecution(executed.image, executed.contentBounds, plan.expectedOutputWidthPx, plan.expectedOutputHeightPx);
}

// ---------------------------------------------------------------------------
// Signs Phase S3C: adaptive post-reconstruction geometry.
// ---------------------------------------------------------------------------

export type AdaptGeometryStepsOutcome =
  | {
      status: "unchanged" | "adapted";
      steps: SignRepairStep[];
      /** What to validate the final executed output against — see `finalizeSignExecution`'s own doc comment. */
      expectedOutputWidthPx: number;
      expectedOutputHeightPx: number;
    }
  | { status: "refused"; reason: string; detail: string };

/**
 * Signs Phase S3C: re-derives the geometry-stage step(s) that follow a
 * `reconstruct_resolution` step (`extend_uniform_background`/
 * `pad_uniform_background`) from the ACTUAL admitted reconstruction
 * dimensions, when they diverge from what the plan's `reconstruct_resolution`
 * step requested — the real S3B Ruth acceptance run proved a real provider
 * (Topaz) can honestly return more than requested (its own proven 4x
 * ceiling, proportionally, `validateReconstructedGeometry`'s "sufficiency,
 * not exact sizing" contract) while the plan's baked-in pad amounts assumed
 * the exact requested size.
 *
 * NEVER mutates the persisted plan, never changes plan identity/`planKey`,
 * never re-plans, never invents an operation the plan did not already
 * approve. It only recomputes the NUMBER OF PIXELS the plan's own approved
 * semantic operation ("extend axis X, centered, in colour C, to reach the
 * ordered aspect") requires for the actual input — axis, alignment
 * convention, and fill colour are carried over from the persisted step
 * UNCHANGED; only `leadingPx`/`trailingPx` (and, only in the returned
 * result, the expected final canvas) are recomputed.
 *
 * Refuses — never silently reinterprets — the instant the actual input
 * would require a DIFFERENT axis than the plan approved, or a geometry
 * step the plan never included at all. Both are defensive: proportional
 * reconstruction (already enforced by `validateReconstructedGeometry`
 * before this ever runs) preserves aspect ratio exactly, so the axis
 * decision is invariant under it — these branches exist to fail closed on
 * an assumption violation, not because either is expected to fire.
 */
export function adaptGeometryStepsToActualReconstruction(
  afterSteps: SignRepairStep[],
  actualReconstructedWidthPx: number,
  actualReconstructedHeightPx: number,
  requestedReconstructionWidthPx: number,
  requestedReconstructionHeightPx: number,
  orderedWidthIn: number,
  orderedHeightIn: number,
  plannedExpectedOutputWidthPx: number,
  plannedExpectedOutputHeightPx: number,
): AdaptGeometryStepsOutcome {
  if (
    actualReconstructedWidthPx === requestedReconstructionWidthPx &&
    actualReconstructedHeightPx === requestedReconstructionHeightPx
  ) {
    // The provider returned EXACTLY what was requested — the plan's own
    // steps and expected dimensions already apply verbatim. Zero behavior
    // change from before S3C for this (the previously only-tested) case.
    return {
      status: "unchanged",
      steps: afterSteps,
      expectedOutputWidthPx: plannedExpectedOutputWidthPx,
      expectedOutputHeightPx: plannedExpectedOutputHeightPx,
    };
  }

  const geometryStepIndex = afterSteps.findIndex(
    (step) => step.kind === "extend_uniform_background" || step.kind === "pad_uniform_background",
  );

  if (geometryStepIndex === -1) {
    // The plan expected reconstruction ALONE to already land on the
    // ordered aspect — no geometry step to adapt. Proportionality
    // (enforced upstream) means the actual output is still exact-aspect
    // too, so its own dimensions are simply the expected output. If that
    // assumption is ever wrong, refuse rather than invent an extension
    // step the plan never approved.
    const geometry = deriveUniformBackgroundExtension(
      actualReconstructedWidthPx,
      actualReconstructedHeightPx,
      orderedWidthIn,
      orderedHeightIn,
    );
    if (geometry.needsExtension) {
      return {
        status: "refused",
        reason: "unapproved_geometry_step_required",
        detail:
          `The actual reconstruction (${actualReconstructedWidthPx}x${actualReconstructedHeightPx}px) requires a background ` +
          "extension the approved plan never included — refusing rather than inventing an unapproved operation.",
      };
    }
    return {
      status: "adapted",
      steps: afterSteps,
      expectedOutputWidthPx: actualReconstructedWidthPx,
      expectedOutputHeightPx: actualReconstructedHeightPx,
    };
  }

  const geometryStep = afterSteps[geometryStepIndex]!;
  const plannedAxis = geometryStep.params.axis;
  const geometry = deriveUniformBackgroundExtension(
    actualReconstructedWidthPx,
    actualReconstructedHeightPx,
    orderedWidthIn,
    orderedHeightIn,
  );
  if (!geometry.needsExtension || geometry.axis !== plannedAxis) {
    return {
      status: "refused",
      reason: "axis_or_extension_mismatch",
      detail:
        `The approved plan's geometry step assumed axis "${plannedAxis}", but the actual reconstruction ` +
        `(${actualReconstructedWidthPx}x${actualReconstructedHeightPx}px) requires ` +
        `${geometry.needsExtension ? `axis "${geometry.axis}"` : "no extension at all"} — refusing rather than ` +
        "silently reinterpreting the approved plan.",
    };
  }

  // Axis, alignment convention, and fill colour/`"unconfirmed"` carry over
  // UNCHANGED from the approved step — only the pixel amounts are
  // recomputed. A step whose colour was never confirmed stays
  // `"unconfirmed"` here too, so the existing `executeExtend` refusal for
  // that case is entirely unaffected by this adaptation.
  const adaptedStep: SignRepairStep = {
    ...geometryStep,
    params: { ...geometryStep.params, leadingPx: geometry.leadingPx, trailingPx: geometry.trailingPx },
  };
  const adaptedSteps = [...afterSteps];
  adaptedSteps[geometryStepIndex] = adaptedStep;

  return {
    status: "adapted",
    steps: adaptedSteps,
    expectedOutputWidthPx: geometry.plateWidthPx,
    expectedOutputHeightPx: geometry.plateHeightPx,
  };
}

// ---------------------------------------------------------------------------
// Signs Phase S3C review follow-up: DERIVED EXECUTION GEOMETRY EVIDENCE.
// ---------------------------------------------------------------------------

/**
 * The approved, persisted `SignRepairPlan` is APPROVAL/AUDIT AUTHORITY —
 * immutable, never rewritten, its `planKey` never recomputed to match
 * whatever actually executed. When `adaptGeometryStepsToActualReconstruction`
 * adapts a geometry step's pixel amounts, the plan's own recorded step
 * (e.g. `leadingPx: 153`) and what actually executed (e.g. `leadingPx: 256`)
 * genuinely differ — this record exists so that fact is never silently
 * elided. It is PRODUCTION PROVENANCE, not a second authority: it records
 * what happened; it never authorizes anything the approved plan's own
 * semantic intent (axis, fill colour, risk classification) did not already
 * permit — `adaptGeometryStepsToActualReconstruction` enforces that
 * constraint before this evidence is ever built, not this type.
 */
export interface SignExecutionGeometryEvidence {
  /** Why re-derivation happened — currently the only reason this architecture admits. */
  reason: "provider_output_geometry_diverged_from_requested";
  /** The plan's own `reconstruct_resolution` step's requested target — what the persisted plan predicted. */
  reconstructionRequestedWidthPx: number;
  reconstructionRequestedHeightPx: number;
  /** What the provider actually returned (already validated sufficient + proportional before this is ever built). */
  reconstructionActualWidthPx: number;
  reconstructionActualHeightPx: number;
  /**
   * The geometry-stage step as ACTUALLY executed, with its pixel amounts
   * re-derived — `null` when the plan had no geometry step at all (the
   * reconstruction alone, at its actual size, already reached the ordered
   * aspect). `kind`/`axis`/fill colour are always identical to the approved
   * plan's own step; only `leadingPx`/`trailingPx` ever differ.
   */
  executedStep: {
    kind: SignRepairStepKind;
    axis: string | null;
    leadingPx: number | null;
    trailingPx: number | null;
    colorR: number | null;
    colorG: number | null;
    colorB: number | null;
    color: string | null;
  } | null;
  outputWidthPx: number;
  outputHeightPx: number;
}

/**
 * Builds the persisted evidence record for an adapted execution — `null`
 * when `adaptation.status !== "adapted"` (nothing diverged from the plan's
 * own recorded prediction, so the plan's own steps already are the
 * complete, truthful transformation record; recording a redundant copy
 * would be noise, not evidence).
 */
export function buildSignExecutionGeometryEvidence(
  adaptation: AdaptGeometryStepsOutcome,
  requestedReconstructionWidthPx: number,
  requestedReconstructionHeightPx: number,
  actualReconstructionWidthPx: number,
  actualReconstructionHeightPx: number,
): SignExecutionGeometryEvidence | null {
  if (adaptation.status !== "adapted") return null;

  const executedStep = adaptation.steps.find(
    (step) => step.kind === "extend_uniform_background" || step.kind === "pad_uniform_background",
  );

  return {
    reason: "provider_output_geometry_diverged_from_requested",
    reconstructionRequestedWidthPx: requestedReconstructionWidthPx,
    reconstructionRequestedHeightPx: requestedReconstructionHeightPx,
    reconstructionActualWidthPx: actualReconstructionWidthPx,
    reconstructionActualHeightPx: actualReconstructionHeightPx,
    executedStep: executedStep
      ? {
          kind: executedStep.kind,
          axis: typeof executedStep.params.axis === "string" ? executedStep.params.axis : null,
          leadingPx: typeof executedStep.params.leadingPx === "number" ? executedStep.params.leadingPx : null,
          trailingPx: typeof executedStep.params.trailingPx === "number" ? executedStep.params.trailingPx : null,
          colorR: typeof executedStep.params.colorR === "number" ? executedStep.params.colorR : null,
          colorG: typeof executedStep.params.colorG === "number" ? executedStep.params.colorG : null,
          colorB: typeof executedStep.params.colorB === "number" ? executedStep.params.colorB : null,
          color: typeof executedStep.params.color === "string" ? executedStep.params.color : null,
        }
      : null,
    outputWidthPx: adaptation.expectedOutputWidthPx,
    outputHeightPx: adaptation.expectedOutputHeightPx,
  };
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
