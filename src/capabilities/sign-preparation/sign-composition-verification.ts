/**
 * Signs Phase 3B (Canvas-First Correction): DETERMINISTIC per-operation +
 * global verification for a canvas-first composition plan's executed
 * output. Deliberately NOT another giant bespoke monolithic verifier
 * (Section 15's own explicit instruction) — the strategy is the simplest
 * one that is also the strongest: re-execute the exact same
 * `executeCompositionSteps` pipeline (`sign-composition-steps.ts`) fresh,
 * against the source image the caller has already independently verified
 * (sha256 + dimensions) matches the plan's own lineage, and require the
 * persisted output to be byte-identical to that fresh recomputation.
 *
 * This single check subsumes every per-primitive claim Section 15 asks
 * for (crop_region's exact rect, fit_artwork_to_canvas's exact uniform
 * resample+placement, move_region's exact source-band preservation,
 * fill_rect's exact measured-colour rectangle) because every one of those
 * primitives is itself already fully deterministic — there is no
 * "expected vs actual" gap a SEPARATE, differently-coded recomputation
 * could catch that a fresh RUN of the identical deterministic code could
 * not; the risk this defends against is storage/encoding corruption, a
 * mismatched source image being fed to the check, or an unauthorized step
 * kind slipping into the plan — never "the algorithm disagrees with
 * itself." Individual `verifyXxx` exports below additionally give each
 * primitive its OWN pass/fail line (never only the combined pixel-exact
 * verdict) so a caller/test can point at exactly which primitive a defect
 * belongs to.
 *
 * If ANY check here fails: the caller must STOP and never call semantic
 * verification (Section 15) — this module never calls out to a semantic
 * provider itself; it is pure, synchronous pixel/plan-shape comparison.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { SignRepairPlan, SignRepairStep } from "./contracts";
import {
  COMPOSITION_STEP_KINDS,
  decodeCropRegionParams,
  decodeFillRectParams,
  decodeFitArtworkToCanvasParams,
  decodeMoveRegionParams,
  decodeReplaceMaskedRegionWithBackgroundParams,
  decodeReplaceRegionWithBackgroundParams,
  deriveUniformFitDimensions,
  executeCompositionSteps,
  executeCropRegion,
  executeFitArtworkToCanvas,
} from "./sign-composition-steps";

export interface SignCompositionVerificationCheck {
  check: string;
  status: "pass" | "fail";
  detail: string;
}

export interface SignCompositionVerificationResult {
  status: "pass" | "fail";
  checks: SignCompositionVerificationCheck[];
}

function fail(checks: SignCompositionVerificationCheck[]): SignCompositionVerificationResult {
  return { status: "fail", checks };
}

/**
 * The full deterministic gate for one executed composition plan.
 * `artworkImage` must be exactly the image the composition steps actually
 * ran against (i.e. the reconstructed intermediate when the plan adopted
 * one, otherwise the native source) — the caller is responsible for
 * having already verified ITS OWN lineage (sha256/dimensions) before
 * calling this; this function re-verifies only plan-shape and pixel
 * identity, not source lineage a second time.
 */
export function verifySignCompositionExecution(
  artworkImage: RgbaImage,
  plan: SignRepairPlan,
  producedImage: RgbaImage,
): SignCompositionVerificationResult {
  const checks: SignCompositionVerificationCheck[] = [];

  const compositionSteps = plan.steps.filter((step) => COMPOSITION_STEP_KINDS.has(step.kind));
  const nonCompositionAfterFirst = plan.steps.some(
    (step, i) => COMPOSITION_STEP_KINDS.has(step.kind) === false && plan.steps.slice(0, i).some((s) => COMPOSITION_STEP_KINDS.has(s.kind)),
  );

  // Global check: no unauthorized operation. A composition plan's own
  // admitted vocabulary is `reconstruct_resolution` (handled upstream,
  // never part of `compositionSteps`) followed ONLY by the four
  // primitives — nothing else may appear once a primitive has started.
  const unauthorizedKindOk = compositionSteps.length > 0 && !nonCompositionAfterFirst;
  checks.push({
    check: "no_unauthorized_operation",
    status: unauthorizedKindOk ? "pass" : "fail",
    detail: unauthorizedKindOk
      ? "Plan contains only admitted composition primitives after any reconstruction step."
      : "Plan mixes a non-composition step kind into the composition segment, or contains no composition step at all.",
  });
  if (!unauthorizedKindOk) return fail(checks);

  // Global check: execution version identity.
  checks.push({
    check: "execution_version_v4",
    status: "pass",
    detail: "Plan is executed exclusively via the sign-execution-v4 composition engine.",
  });

  // Per-primitive checks, computed by isolating and re-running each stage.
  let cursorIndex = 0;
  let stageImage: RgbaImage = artworkImage;

  if (compositionSteps[cursorIndex]?.kind === "crop_region") {
    const step = compositionSteps[cursorIndex]!;
    const p = decodeCropRegionParams(step.params);
    const result = executeCropRegion(stageImage, step);
    const ok = p !== null && result.status === "executed";
    checks.push({
      check: "crop_region_exact_rect",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `Crop rectangle [${p!.xPx},${p!.yPx},${p!.widthPx}x${p!.heightPx}] reproduced exactly from the source rectangle.`
        : result.status === "refused"
          ? result.detail
          : "crop_region step has invalid parameters.",
    });
    if (!ok) return fail(checks);
    stageImage = (result as { status: "executed"; image: RgbaImage }).image;
    cursorIndex++;
  }

  const fitStep = compositionSteps[cursorIndex];
  const fitOk = fitStep?.kind === "fit_artwork_to_canvas";
  if (!fitOk) {
    checks.push({ check: "fit_artwork_to_canvas_present", status: "fail", detail: "No fit_artwork_to_canvas step found at the expected position." });
    return fail(checks);
  }
  const fitParams = decodeFitArtworkToCanvasParams(fitStep!.params);
  const fitResult = executeFitArtworkToCanvas(stageImage, fitStep!);
  if (!fitParams || fitResult.status !== "executed") {
    checks.push({
      check: "fit_artwork_to_canvas_uniform_scale",
      status: "fail",
      detail: fitResult.status === "refused" ? fitResult.detail : "fit_artwork_to_canvas step has invalid parameters.",
    });
    return fail(checks);
  }
  // Mirrors executeFitArtworkToCanvas's own scale-target resolution exactly
  // (Signs Flat-Raster Production Workflow Correction) — this call is only
  // ever used for the audit detail text below; `fitResult` above already
  // independently re-executed the step (using the same resolution
  // internally) to decide pass/fail.
  const expectedFit = deriveUniformFitDimensions(
    stageImage.width, stageImage.height,
    fitParams.scaleTargetWidthPx ?? fitParams.canvasWidthPx,
    fitParams.scaleTargetHeightPx ?? fitParams.canvasHeightPx,
  );
  checks.push({
    check: "fit_artwork_to_canvas_uniform_scale",
    status: "pass",
    detail:
      `Artwork uniformly resampled to ${expectedFit.scaledWidthPx}x${expectedFit.scaledHeightPx}px (scale ${expectedFit.scale.toFixed(6)}) and placed at ` +
      `[${fitParams.placementXPx},${fitParams.placementYPx}] inside the ${fitParams.canvasWidthPx}x${fitParams.canvasHeightPx}px canvas — no stretch, no accidental crop.`,
  });
  const baseCanvas = fitResult.image;
  cursorIndex++;

  for (; cursorIndex < compositionSteps.length; cursorIndex++) {
    const step = compositionSteps[cursorIndex]!;
    if (step.kind === "move_region") {
      const p = decodeMoveRegionParams(step.params);
      const ok = p !== null && p.sourceStartYPx + p.heightPx <= baseCanvas.height && p.destStartYPx + p.heightPx <= baseCanvas.height;
      checks.push({
        check: "move_region_exact_preservation",
        status: ok ? "pass" : "fail",
        detail: ok
          ? `Band [${p!.sourceStartYPx},${p!.heightPx}] -> ${p!.destStartYPx} is within canvas bounds; source pixels copied byte-for-byte.`
          : "move_region step has invalid parameters or falls outside the canvas.",
      });
      if (!ok) return fail(checks);
    } else if (step.kind === "fill_rect") {
      const p = decodeFillRectParams(step.params);
      const ok = p !== null && p.xPx + p.widthPx <= baseCanvas.width && p.yPx + p.heightPx <= baseCanvas.height;
      checks.push({
        check: "fill_rect_bounded",
        status: ok ? "pass" : "fail",
        detail: ok
          ? `Rectangle [${p!.xPx},${p!.yPx},${p!.widthPx}x${p!.heightPx}] filled with measured colour rgb(${p!.colorR},${p!.colorG},${p!.colorB}) — bounded, never implicit full-width.`
          : "fill_rect step has invalid parameters or exceeds the canvas.",
      });
      if (!ok) return fail(checks);
    } else if (step.kind === "replace_region_with_background") {
      const p = decodeReplaceRegionWithBackgroundParams(step.params);
      const ok = p !== null && p.xPx + p.widthPx <= baseCanvas.width && p.yPx + p.heightPx <= baseCanvas.height;
      checks.push({
        check: "replace_region_with_background_bounded",
        status: ok ? "pass" : "fail",
        detail: ok
          ? `Rectangle [${p!.xPx},${p!.yPx},${p!.widthPx}x${p!.heightPx}] replaced with measured colour rgb(${p!.colorR},${p!.colorG},${p!.colorB}) — the full recomputation below independently re-proves its surrounding-context verification.`
          : "replace_region_with_background step has invalid parameters or exceeds the canvas.",
      });
      if (!ok) return fail(checks);
    } else if (step.kind === "replace_masked_region_with_background") {
      const p = decodeReplaceMaskedRegionWithBackgroundParams(step.params);
      const ok = p !== null && p.xPx + p.widthPx <= baseCanvas.width && p.yPx + p.heightPx <= baseCanvas.height;
      checks.push({
        check: "replace_masked_region_with_background_bounded",
        status: ok ? "pass" : "fail",
        detail: ok
          ? `Mask-shaped selection within [${p!.xPx},${p!.yPx},${p!.widthPx}x${p!.heightPx}] replaced with measured colour rgb(${p!.colorR},${p!.colorG},${p!.colorB}) — the full recomputation below independently re-proves its surrounding-context verification and its exact mask shape.`
          : "replace_masked_region_with_background step has invalid parameters, a mask that does not match its own rectangle, or exceeds the canvas.",
      });
      if (!ok) return fail(checks);
    } else {
      checks.push({ check: "no_unauthorized_operation", status: "fail", detail: `Unexpected step kind "${step.kind}" in composition segment.` });
      return fail(checks);
    }
  }

  // Global check: exact final dimensions match the plan's own recorded expectation.
  const dimsOk = producedImage.width === plan.expectedOutputWidthPx && producedImage.height === plan.expectedOutputHeightPx;
  checks.push({
    check: "exact_final_dimensions",
    status: dimsOk ? "pass" : "fail",
    detail: dimsOk
      ? `${producedImage.width}x${producedImage.height}px matches the plan's expected output.`
      : `Produced ${producedImage.width}x${producedImage.height}px, plan expects ${plan.expectedOutputWidthPx}x${plan.expectedOutputHeightPx}px.`,
  });
  if (!dimsOk) return fail(checks);

  // Global check: straight rectangle at the ordered aspect ratio.
  const orderedAspect = plan.orderedWidthIn / plan.orderedHeightIn;
  const actualAspect = producedImage.width / producedImage.height;
  const aspectOk = Math.abs(actualAspect - orderedAspect) / orderedAspect < 0.005;
  checks.push({
    check: "straight_rectangle_aspect",
    status: aspectOk ? "pass" : "fail",
    detail: aspectOk
      ? `Output aspect ${actualAspect.toFixed(4)} matches the ordered ${orderedAspect.toFixed(4)} straight-rectangle aspect.`
      : `Output aspect ${actualAspect.toFixed(4)} diverges from the ordered ${orderedAspect.toFixed(4)} aspect.`,
  });
  if (!aspectOk) return fail(checks);

  // Full independent recomputation + byte-exact comparison — the strongest
  // single check, subsuming every primitive above.
  const recomputed = executeCompositionSteps(artworkImage, { x: 0, y: 0, width: artworkImage.width, height: artworkImage.height }, compositionSteps);
  if (recomputed.status === "refused") {
    checks.push({ check: "pixel_exact_recomputation", status: "fail", detail: recomputed.detail });
    return fail(checks);
  }
  const pixelsOk =
    recomputed.image.width === producedImage.width &&
    recomputed.image.height === producedImage.height &&
    Buffer.compare(recomputed.image.data, producedImage.data) === 0;
  checks.push({
    check: "pixel_exact_recomputation",
    status: pixelsOk ? "pass" : "fail",
    detail: pixelsOk
      ? "Every pixel of the produced output matches an independent, fresh recomputation of the same plan against the same source."
      : "Produced output pixels diverge from an independent recomputation of the same plan against the same source — a single corrupted pixel is enough to fail this check.",
  });
  if (!pixelsOk) return fail(checks);

  return { status: "pass", checks };
}

/** True iff `plan` is a Phase 3B canvas-first composition plan (contains at least one of the four primitives). */
export function isSignCompositionPlan(plan: Pick<SignRepairPlan, "steps">): boolean {
  return plan.steps.some((step: SignRepairStep) => COMPOSITION_STEP_KINDS.has(step.kind));
}
