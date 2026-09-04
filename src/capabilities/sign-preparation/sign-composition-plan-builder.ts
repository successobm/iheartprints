/**
 * Signs Phase 3B (Canvas-First Correction): the OPERATOR-DRIVEN builder for
 * a canvas-first `SignRepairPlan` — the entry point that replaces
 * `sign-repair-planner.ts`'s automatic evidence-driven branches for NEW
 * straight-rectangle production plans.
 *
 * Deliberately NOT algorithmic. `sign-repair-planner.ts`'s
 * `planSignRepair` remains fully intact for historical plans/tests (see
 * its own doc — nothing in this phase deletes or rewires it), but the
 * operator-facing canvas-first workflow never calls it: this phase's own
 * architecture correction is precisely that a rectangle sign's composition
 * (what to crop, how to fit, where each band moves, what to fill) is an
 * OPERATOR decision, never a deterministic inference from the artwork's
 * own perimeter. `buildSignCompositionPlan` therefore takes the operator's
 * already-decided choices as plain data and assembles them into the exact
 * same `SignRepairPlan`/`SignRepairStep` shape every other Signs plan
 * uses — full reuse of `computeSignPlanKey`, `runSignPreparationJob`'s
 * replay/idempotency discipline, the authorize workflow, and PrintValidation,
 * with zero new plan/job plumbing.
 *
 * `buildSignProductionTemplate` (`sign-production-template.ts`) is called
 * FIRST and is the sole source of the canvas's physical shape/size — no
 * argument to this function is ever pixel data; artwork geometry only ever
 * informs the canvas's PIXEL RESOLUTION (via `deriveCanvasPixelDensity`,
 * honestly grounded in the actually-available reconstructed artwork
 * fidelity, never an unrelated arbitrary number), never its shape or
 * physical size.
 */

import type { SignProductionSpec } from "./contracts";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION, type SignRepairPlan, type SignRepairStep } from "./contracts";
import { buildSignProductionTemplate } from "./sign-production-template";
import { computeSignPlanKey } from "./sign-plan-identity";
import { signSafeInsetPxForAxis } from "./sign-fit-to-production";
import type { SignResolutionPolicy } from "./resolution-policy";
import {
  decodeCropRegionParams,
  decodeFillRectParams,
  decodeFitArtworkToCanvasParams,
  decodeMoveRegionParams,
  decodeReplaceMaskedRegionWithBackgroundParams,
  decodeReplaceRegionWithBackgroundParams,
  deriveUniformFitDimensions,
  encodeCropRegionParams,
  encodeFillRectParams,
  encodeFitArtworkToCanvasParams,
  encodeMoveRegionParams,
  encodeReplaceMaskedRegionWithBackgroundParams,
  encodeReplaceRegionWithBackgroundParams,
} from "./sign-composition-steps";

export interface SignCompositionCropInput {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

export interface SignCompositionReconstructionInput {
  requestedScale: number;
  requestedWidthPx: number;
  requestedHeightPx: number;
}

export interface SignCompositionMoveInput {
  sourceStartYPx: number;
  heightPx: number;
  destStartYPx: number;
}

export interface SignCompositionFillInput {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  color: { r: number; g: number; b: number };
}

export interface SignCompositionReplacementInput {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  color: { r: number; g: number; b: number };
  /** How many px of surrounding context must independently re-verify as this same colour — see `verifyReplaceRegionSurroundingContext`'s own doc. */
  contextDepthPx: number;
}

/**
 * Wand-First Correction UX Phase: the mask-shaped sibling of
 * `SignCompositionReplacementInput` — an operator wand (flood-fill)
 * selection that is not itself a filled rectangle. `maskBase64` is the
 * exact persisted selection (`widthPx * heightPx` bytes, row-major, 1 =
 * selected), sized to this bounding rectangle, never the full canvas.
 */
export interface SignCompositionMaskedReplacementInput {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  color: { r: number; g: number; b: number };
  contextDepthPx: number;
  maskBase64: string;
}

export interface SignCompositionPlanInput {
  spec: SignProductionSpec;
  policy: SignResolutionPolicy;
  sourceAssetId: string;
  sourceSha256: string;
  /** The ORIGINAL immutable asset's own pixel dimensions — plan-lineage identity, unrelated to the (possibly much larger) reconstructed intermediate the composition steps actually operate on. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /**
   * `null` only for a plan that composes directly from the native source
   * (no bounded provider reconstruction needed/adopted). The real
   * cc6cfc4b-… acceptance sign always supplies this — it adopts the
   * existing paid Topaz intermediate via `runSignReconstructionAndContinue`'s
   * own cross-plan adoption (Section 14), unconditionally preserved by
   * this phase — never a fresh provider dispatch.
   */
  reconstruction: SignCompositionReconstructionInput | null;
  /** Operator's chosen crop of the artwork as it stands right after `reconstruction` (or of the native source, when `reconstruction` is null). `null` for no crop. */
  crop: SignCompositionCropInput | null;
  /** Operator-measured (never guessed) flat colour for every canvas pixel `fit_artwork_to_canvas` does not cover with the fitted artwork. */
  fitBackground: { r: number; g: number; b: number };
  /** Explicit placement override; centered (contain) placement when omitted. */
  fitPlacement: { xPx: number; yPx: number } | null;
  /**
   * Signs Flat-Raster Production Workflow Correction (Section I/J): when
   * present, the artwork is uniformly fit to a rectangle inset by this many
   * INCHES from every edge of the true canvas — a "fit artwork to safe
   * area" correction — rather than to the full canvas (the ordinary "fit
   * to fill" case every plan built before this phase used, and the default
   * when this field is omitted/undefined; 100% unaffected). Converted to
   * pixels per axis via `signSafeInsetPxForAxis`, the SAME function
   * `analyzeSignFitToProduction` uses for its own SAFE-inset math, so a
   * correction built with this field is guaranteed to land inside the
   * validator's own SAFE guide, never a client-approximated one.
   */
  fitSafeInsetIn?: number;
  /** Ordered, explicit horizontal-band translations, applied in this exact order. */
  moves: SignCompositionMoveInput[];
  /** Ordered, explicit bounded-rectangle fills, applied in this exact order, after every move. */
  fills: SignCompositionFillInput[];
  /**
   * Ordered, explicit artifact removals (Signs Phase 3B: Fit to
   * Production), applied in this exact order, LAST — after every move and
   * fill — so each removal's own independent surrounding-context
   * verification sees the canvas exactly as it will actually be produced.
   * Defaults to `[]` for a plan that needs none.
   */
  replacements: SignCompositionReplacementInput[];
  /**
   * Wand-First Correction UX Phase: mask-shaped removals, applied in this
   * exact order, LAST — after every move, fill, and rectangle replacement —
   * for the identical "each removal's own context verification sees the
   * canvas exactly as it will actually be produced" reasoning `replacements`
   * already follows. Optional/defaults to `[]` — every existing caller that
   * predates this phase needs no change.
   */
  maskedReplacements?: SignCompositionMaskedReplacementInput[];
}

export type SignCompositionPlanBuildResult =
  | { status: "built"; plan: SignRepairPlan }
  | { status: "refused"; reason: string };

/**
 * Honest, artwork-grounded canvas pixel density: the greater of the two
 * axes' own "native reconstructed pixels ÷ ordered inches" ratio — i.e. the
 * canvas is sized so the LIMITING axis of the (post-crop) artwork exactly
 * fills it under a uniform contain-fit, never claiming more density than
 * the actually-available reconstructed pixels support, and never wasting
 * genuine available density either. This never influences canvas SHAPE
 * (always `orderedWidthIn` x `orderedHeightIn`, straight rectangle) — only
 * how many pixels represent it.
 */
function deriveCanvasPixelDensity(
  artworkWidthPx: number,
  artworkHeightPx: number,
  orderedWidthIn: number,
  orderedHeightIn: number,
): number {
  return Math.min(artworkWidthPx / orderedWidthIn, artworkHeightPx / orderedHeightIn);
}

export function buildSignCompositionPlan(input: SignCompositionPlanInput): SignCompositionPlanBuildResult {
  const template = buildSignProductionTemplate(input.spec, input.policy);

  const steps: SignRepairStep[] = [];

  if (input.reconstruction) {
    steps.push({
      kind: "reconstruct_resolution",
      params: {
        requestedScale: input.reconstruction.requestedScale,
        requestedWidthPx: input.reconstruction.requestedWidthPx,
        requestedHeightPx: input.reconstruction.requestedHeightPx,
      },
      risk: "auto_safe",
      reasons: [
        "Canvas-first composition adopts a bounded provider reconstruction of the source artwork for print density — " +
          "cross-plan adoption (Signs Phase 3A, preserved) reuses an existing paid result rather than dispatching again " +
          "when one already exists for this exact source/provider/preparation.",
      ],
    });
  }

  const preCompositionWidthPx = input.reconstruction ? input.reconstruction.requestedWidthPx : input.sourceWidthPx;
  const preCompositionHeightPx = input.reconstruction ? input.reconstruction.requestedHeightPx : input.sourceHeightPx;

  let artworkWidthPx = preCompositionWidthPx;
  let artworkHeightPx = preCompositionHeightPx;

  if (input.crop) {
    if (
      input.crop.xPx < 0 || input.crop.yPx < 0 || input.crop.widthPx <= 0 || input.crop.heightPx <= 0 ||
      input.crop.xPx + input.crop.widthPx > preCompositionWidthPx ||
      input.crop.yPx + input.crop.heightPx > preCompositionHeightPx
    ) {
      return { status: "refused", reason: `Crop rectangle does not fit within the ${preCompositionWidthPx}x${preCompositionHeightPx}px pre-composition artwork.` };
    }
    steps.push({
      kind: "crop_region",
      params: encodeCropRegionParams({
        expectedInputWidthPx: preCompositionWidthPx,
        expectedInputHeightPx: preCompositionHeightPx,
        xPx: input.crop.xPx,
        yPx: input.crop.yPx,
        widthPx: input.crop.widthPx,
        heightPx: input.crop.heightPx,
      }),
      risk: "review_required",
      reasons: [
        "Operator-authorized rectangular crop — removes or retains decorative perimeter treatment as an explicit " +
          "production decision, never an automatic 'frame interior' assumption.",
      ],
    });
    artworkWidthPx = input.crop.widthPx;
    artworkHeightPx = input.crop.heightPx;
  }

  const canvasPpi = deriveCanvasPixelDensity(artworkWidthPx, artworkHeightPx, template.widthIn, template.heightIn);
  const canvasWidthPx = Math.max(1, Math.round(template.widthIn * canvasPpi));
  const canvasHeightPx = Math.max(1, Math.round(template.heightIn * canvasPpi));

  // Signs Flat-Raster Production Workflow Correction: a "fit to safe area"
  // correction derives scale against a rectangle inset by fitSafeInsetIn on
  // every side — per axis, exactly like the validator's own SAFE-inset math
  // (Section I/J doc above). Absent entirely reproduces today's "fit to
  // fill the canvas" behavior byte-for-byte (insetPx 0 on both axes).
  const insetPxX = input.fitSafeInsetIn ? signSafeInsetPxForAxis(input.fitSafeInsetIn, canvasWidthPx / template.widthIn) : 0;
  const insetPxY = input.fitSafeInsetIn ? signSafeInsetPxForAxis(input.fitSafeInsetIn, canvasHeightPx / template.heightIn) : 0;
  const scaleTargetWidthPx = canvasWidthPx - 2 * insetPxX;
  const scaleTargetHeightPx = canvasHeightPx - 2 * insetPxY;
  if (scaleTargetWidthPx <= 0 || scaleTargetHeightPx <= 0) {
    return { status: "refused", reason: `The safe-area inset (${insetPxX}px x / ${insetPxY}px y) leaves no positive area to fit artwork into on the ${canvasWidthPx}x${canvasHeightPx}px canvas.` };
  }

  const { scaledWidthPx, scaledHeightPx } = deriveUniformFitDimensions(
    artworkWidthPx, artworkHeightPx, scaleTargetWidthPx, scaleTargetHeightPx,
  );
  const placementXPx = input.fitPlacement?.xPx ?? Math.floor((canvasWidthPx - scaledWidthPx) / 2);
  const placementYPx = input.fitPlacement?.yPx ?? Math.floor((canvasHeightPx - scaledHeightPx) / 2);
  if (placementXPx < 0 || placementYPx < 0 || placementXPx + scaledWidthPx > canvasWidthPx || placementYPx + scaledHeightPx > canvasHeightPx) {
    return { status: "refused", reason: "Explicit fit placement does not keep the fitted artwork within the canvas." };
  }

  steps.push({
    kind: "fit_artwork_to_canvas",
    params: encodeFitArtworkToCanvasParams({
      expectedArtworkWidthPx: artworkWidthPx,
      expectedArtworkHeightPx: artworkHeightPx,
      canvasWidthPx,
      canvasHeightPx,
      scaleTargetWidthPx: input.fitSafeInsetIn ? scaleTargetWidthPx : undefined,
      scaleTargetHeightPx: input.fitSafeInsetIn ? scaleTargetHeightPx : undefined,
      placementXPx,
      placementYPx,
      backgroundR: input.fitBackground.r,
      backgroundG: input.fitBackground.g,
      backgroundB: input.fitBackground.b,
    }),
    risk: "review_required",
    reasons: [
      `Authoritative ${template.widthIn}x${template.heightIn}in straight-rectangle canvas created from the ordered ` +
        "spec alone, then the artwork uniformly fit into it at an explicit placement with an explicit background — " +
        "never the reverse.",
    ],
  });

  for (const move of input.moves) {
    if (move.sourceStartYPx < 0 || move.heightPx <= 0 || move.destStartYPx < 0 ||
        move.sourceStartYPx + move.heightPx > canvasHeightPx || move.destStartYPx + move.heightPx > canvasHeightPx) {
      return { status: "refused", reason: `move_region band [${move.sourceStartYPx},${move.heightPx}] -> ${move.destStartYPx} does not fit within the ${canvasHeightPx}px canvas.` };
    }
    steps.push({
      kind: "move_region",
      params: encodeMoveRegionParams(move),
      risk: "review_required",
      reasons: ["Operator-directed horizontal-band translation — byte-for-byte pixel copy, no resize, no warp."],
    });
  }

  for (const fill of input.fills) {
    if (fill.xPx < 0 || fill.yPx < 0 || fill.widthPx <= 0 || fill.heightPx <= 0 ||
        fill.xPx + fill.widthPx > canvasWidthPx || fill.yPx + fill.heightPx > canvasHeightPx) {
      return { status: "refused", reason: `fill_rect [${fill.xPx},${fill.yPx},${fill.widthPx}x${fill.heightPx}] does not fit within the ${canvasWidthPx}x${canvasHeightPx}px canvas.` };
    }
    steps.push({
      kind: "fill_rect",
      params: encodeFillRectParams({
        xPx: fill.xPx, yPx: fill.yPx, widthPx: fill.widthPx, heightPx: fill.heightPx,
        colorR: fill.color.r, colorG: fill.color.g, colorB: fill.color.b,
      }),
      risk: "review_required",
      reasons: ["Operator-measured, bounded rectangle fill — never implicit full-width."],
    });
  }

  for (const replacement of input.replacements) {
    if (
      replacement.xPx < 0 || replacement.yPx < 0 || replacement.widthPx <= 0 || replacement.heightPx <= 0 ||
      replacement.xPx + replacement.widthPx > canvasWidthPx || replacement.yPx + replacement.heightPx > canvasHeightPx
    ) {
      return { status: "refused", reason: `replace_region_with_background [${replacement.xPx},${replacement.yPx},${replacement.widthPx}x${replacement.heightPx}] does not fit within the ${canvasWidthPx}x${canvasHeightPx}px canvas.` };
    }
    if (replacement.contextDepthPx <= 0) {
      return { status: "refused", reason: "replace_region_with_background requires a positive contextDepthPx to verify against." };
    }
    steps.push({
      kind: "replace_region_with_background",
      params: encodeReplaceRegionWithBackgroundParams({
        xPx: replacement.xPx, yPx: replacement.yPx, widthPx: replacement.widthPx, heightPx: replacement.heightPx,
        colorR: replacement.color.r, colorG: replacement.color.g, colorB: replacement.color.b,
        contextDepthPx: replacement.contextDepthPx,
      }),
      risk: "review_required",
      reasons: [
        "Operator-authorized removal of an unwanted artifact (never a construction of new layout area) — " +
          "independently re-verified against its own measured surrounding context before execution.",
      ],
    });
  }

  for (const masked of input.maskedReplacements ?? []) {
    if (
      masked.xPx < 0 || masked.yPx < 0 || masked.widthPx <= 0 || masked.heightPx <= 0 ||
      masked.xPx + masked.widthPx > canvasWidthPx || masked.yPx + masked.heightPx > canvasHeightPx
    ) {
      return { status: "refused", reason: `replace_masked_region_with_background [${masked.xPx},${masked.yPx},${masked.widthPx}x${masked.heightPx}] does not fit within the ${canvasWidthPx}x${canvasHeightPx}px canvas.` };
    }
    if (masked.contextDepthPx <= 0) {
      return { status: "refused", reason: "replace_masked_region_with_background requires a positive contextDepthPx to verify against." };
    }
    steps.push({
      kind: "replace_masked_region_with_background",
      params: encodeReplaceMaskedRegionWithBackgroundParams({
        xPx: masked.xPx, yPx: masked.yPx, widthPx: masked.widthPx, heightPx: masked.heightPx,
        colorR: masked.color.r, colorG: masked.color.g, colorB: masked.color.b,
        contextDepthPx: masked.contextDepthPx, maskBase64: masked.maskBase64,
      }),
      risk: "review_required",
      reasons: [
        "Operator wand selection: removal of an unwanted artifact restricted to the exact selected shape — " +
          "independently re-verified against its own measured surrounding context before execution.",
      ],
    });
  }

  const planWithoutKey: Omit<SignRepairPlan, "planKey"> = {
    schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
    policyId: input.policy.id,
    sourceAssetId: input.sourceAssetId,
    sourceSha256: input.sourceSha256,
    sourceWidthPx: input.sourceWidthPx,
    sourceHeightPx: input.sourceHeightPx,
    orderedWidthIn: input.spec.orderedWidthIn,
    orderedHeightIn: input.spec.orderedHeightIn,
    steps,
    expectedOutputWidthPx: canvasWidthPx,
    expectedOutputHeightPx: canvasHeightPx,
    expectedEffectivePpi: canvasHeightPx / input.spec.orderedHeightIn,
    overallRisk: "review_required",
    defects: [],
    reasons: [
      "Canvas-first composition plan (Signs Phase 3B): the ordered spec alone defines the production canvas; the " +
        "artwork's own perimeter never defines substrate geometry.",
    ],
  };
  const planKey = computeSignPlanKey(planWithoutKey);
  return { status: "built", plan: { ...planWithoutKey, planKey } };
}

/**
 * Operator Production Correction UX: the exact inverse of the construction
 * above — decodes an EXISTING canvas-first plan's own `steps[]` back into
 * the operator-choice shape that built it (`reconstruction`/`crop`/
 * `fitBackground`/`fitPlacement`/`moves`/`fills`/`replacements`). Exists so
 * a NEW correction (an operator-selected `move_region`/
 * `replace_region_with_background`) can be appended to a plan's EXISTING
 * choices and the whole thing rebuilt through `buildSignCompositionPlan`
 * again — producing a new, independently re-authorizable plan/planKey
 * (Section K governance) — rather than requiring the operator to re-enter
 * every crop/fit/move/fill decision from scratch.
 *
 * `null` when `plan.steps` is not in the canvas-first shape this decoder
 * understands (`[reconstruct_resolution?] [crop_region?] fit_artwork_to_canvas
 * (move_region|fill_rect)* (replace_region_with_background)*`) — e.g. a
 * historical plan built by the automatic `planSignRepair`/`sign-repair-
 * planner.ts` path, which uses an entirely different step vocabulary. Never
 * guesses; the caller must treat `null` as "this plan cannot be edited by
 * the correction tool", not as an empty set of choices.
 */
export interface SignCompositionDecodedChoices {
  reconstruction: SignCompositionReconstructionInput | null;
  crop: SignCompositionCropInput | null;
  fitBackground: { r: number; g: number; b: number };
  fitPlacement: { xPx: number; yPx: number } | null;
  moves: SignCompositionMoveInput[];
  fills: SignCompositionFillInput[];
  replacements: SignCompositionReplacementInput[];
  maskedReplacements: SignCompositionMaskedReplacementInput[];
}

export function decodeSignCompositionPlanToOperatorChoices(
  plan: SignRepairPlan,
): SignCompositionDecodedChoices | null {
  const steps = plan.steps;
  let index = 0;

  let reconstruction: SignCompositionReconstructionInput | null = null;
  if (steps[index]?.kind === "reconstruct_resolution") {
    const p = steps[index]!.params;
    const requestedScale = p.requestedScale;
    const requestedWidthPx = p.requestedWidthPx;
    const requestedHeightPx = p.requestedHeightPx;
    if (typeof requestedScale !== "number" || typeof requestedWidthPx !== "number" || typeof requestedHeightPx !== "number") {
      return null;
    }
    reconstruction = { requestedScale, requestedWidthPx, requestedHeightPx };
    index++;
  }

  let crop: SignCompositionCropInput | null = null;
  if (steps[index]?.kind === "crop_region") {
    const p = decodeCropRegionParams(steps[index]!.params);
    if (!p) return null;
    crop = { xPx: p.xPx, yPx: p.yPx, widthPx: p.widthPx, heightPx: p.heightPx };
    index++;
  }

  if (steps[index]?.kind !== "fit_artwork_to_canvas") return null;
  const fit = decodeFitArtworkToCanvasParams(steps[index]!.params);
  if (!fit) return null;
  const fitBackground = { r: fit.backgroundR, g: fit.backgroundG, b: fit.backgroundB };
  const fitPlacement = { xPx: fit.placementXPx, yPx: fit.placementYPx };
  index++;

  const moves: SignCompositionMoveInput[] = [];
  const fills: SignCompositionFillInput[] = [];
  const replacements: SignCompositionReplacementInput[] = [];
  const maskedReplacements: SignCompositionMaskedReplacementInput[] = [];
  for (; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.kind === "move_region") {
      const p = decodeMoveRegionParams(step.params);
      if (!p) return null;
      moves.push(p);
    } else if (step.kind === "fill_rect") {
      const p = decodeFillRectParams(step.params);
      if (!p) return null;
      fills.push({ xPx: p.xPx, yPx: p.yPx, widthPx: p.widthPx, heightPx: p.heightPx, color: { r: p.colorR, g: p.colorG, b: p.colorB } });
    } else if (step.kind === "replace_region_with_background") {
      const p = decodeReplaceRegionWithBackgroundParams(step.params);
      if (!p) return null;
      replacements.push({
        xPx: p.xPx, yPx: p.yPx, widthPx: p.widthPx, heightPx: p.heightPx,
        color: { r: p.colorR, g: p.colorG, b: p.colorB }, contextDepthPx: p.contextDepthPx,
      });
    } else if (step.kind === "replace_masked_region_with_background") {
      const p = decodeReplaceMaskedRegionWithBackgroundParams(step.params);
      if (!p) return null;
      maskedReplacements.push({
        xPx: p.xPx, yPx: p.yPx, widthPx: p.widthPx, heightPx: p.heightPx,
        color: { r: p.colorR, g: p.colorG, b: p.colorB }, contextDepthPx: p.contextDepthPx, maskBase64: p.maskBase64,
      });
    } else {
      return null; // Not the canvas-first vocabulary this decoder understands.
    }
  }

  return { reconstruction, crop, fitBackground, fitPlacement, moves, fills, replacements, maskedReplacements };
}
