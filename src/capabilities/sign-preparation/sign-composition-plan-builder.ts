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
import type { SignResolutionPolicy } from "./resolution-policy";
import {
  deriveUniformFitDimensions,
  encodeCropRegionParams,
  encodeFillRectParams,
  encodeFitArtworkToCanvasParams,
  encodeMoveRegionParams,
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

  const { scaledWidthPx, scaledHeightPx } = deriveUniformFitDimensions(
    artworkWidthPx, artworkHeightPx, canvasWidthPx, canvasHeightPx,
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
