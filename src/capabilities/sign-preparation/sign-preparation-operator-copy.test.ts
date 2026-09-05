import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { framedSignArtwork, noisyEdgeSignArtwork, ruthLikeSignArtwork } from "./sign-fixtures";
import {
  RIGID_SIGN_CATEGORY,
  SIGN_INSPECTION_VERSION,
  SIGN_REPAIR_PLAN_SCHEMA_VERSION,
  type SignEdge,
  type SignEdgeEvidence,
  type SignEdgeClassification,
  type SignInspectionReport,
  type SignProductionSpec,
  type SignRepairPlan,
  type SignRepairStep,
  type SignRiskClass,
} from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { inspectSignArtwork } from "./sign-inspection";
import { planSignRepair } from "./sign-repair-planner";
import { describeSignPlanForOperator } from "./sign-preparation-operator-copy";

/**
 * LIVE PRODUCT BLOCKER #4A: proves the operator-copy module translates
 * REAL plan/inspection shapes without leaking internal vocabulary — same
 * discipline `sign-preparation-copy.test.ts` applies to the customer
 * module. Every internal code/kind string below must never appear in a
 * rendered `summary`/`detail`/`reviewReason`.
 */

const INTERNAL_VOCABULARY = [
  "rigid_sign_raster",
  "SignPreparation",
  "SignRepairPlan",
  "resolutionPolicyId",
  "mixed_or_uncertain",
  "foreground_bleed",
  "uniform_background",
  "reconstruct_resolution",
  "extend_uniform_background",
  "pad_uniform_background",
  "proportional_resample",
  "reconstruct_perimeter_structure",
  "reconstruct_parametric_frame",
  "approved_crop",
  "rotate_90",
  "plan_key",
  "planKey",
  "auto_safe",
  "review_required",
  "fit_artwork_to_canvas",
  "crop_region",
  "move_region",
  "fill_rect",
  "replace_region_with_background",
  "replace_masked_region_with_background",
  "scaleTargetWidthPx",
  "scaleTargetHeightPx",
  "expectedArtworkWidthPx",
  "canvasWidthPx",
  "sourceStartYPx",
  "destStartYPx",
];

function assertNoLeakedVocabulary(view: unknown): void {
  const serialized = JSON.stringify(view);
  for (const term of INTERNAL_VOCABULARY) {
    assert.doesNotMatch(serialized, new RegExp(term, "i"), `leaked internal vocabulary: ${term}`);
  }
}

// ---------------------------------------------------------------------------
// Tier 1: hand-built minimal fixtures — exercises every step kind's
// translation in isolation, with full control over edge classifications.
// ---------------------------------------------------------------------------

function edgeEvidence(edge: SignEdge, classification: SignEdgeClassification): SignEdgeEvidence {
  return {
    edge,
    classification,
    bandDepthPx: 50,
    edgeLengthPx: 1000,
    dominantColor: classification === "uniform_background" ? { r: 250, g: 250, b: 248 } : null,
    dominantCoverage: classification === "uniform_background" ? 0.99 : 0.4,
    outermostCoverage: 0.5,
    maxChannelStdDev: 10,
    tolerance: 12,
    longestNonBackgroundRunPx: 5,
    transparentFraction: 0,
    // Internal-only rationale — must never appear verbatim in operator copy.
    reason: `internal reason for ${edge}: ${classification}`,
  };
}

function inspectionWithEdges(edges: SignEdgeEvidence[]): SignInspectionReport {
  return {
    inspectionVersion: SIGN_INSPECTION_VERSION,
    source: { widthPx: 1000, heightPx: 1000, aspectRatio: 1 },
    ordered: { widthIn: 18, heightIn: 24, aspectRatio: 0.75 },
    aspectMismatch: true,
    aspectDeltaRatio: 0.1,
    orientation: { source: "square", ordered: "portrait", rotatedAspectMatches: false },
    placements: { contain: null, fill: null },
    resolution: null,
    transparency: { hasAlphaPixels: false, transparentPixelFraction: 0 },
    edges,
  };
}

function planWithSteps(steps: SignRepairStep[], overallRisk: SignRiskClass): SignRepairPlan {
  return {
    schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
    policyId: RIGID_RECT_UP_TO_24X36_V1.id,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    sourceWidthPx: 1000,
    sourceHeightPx: 1000,
    orderedWidthIn: 18,
    orderedHeightIn: 24,
    steps,
    expectedOutputWidthPx: 1000,
    expectedOutputHeightPx: 1333,
    expectedEffectivePpi: 150,
    overallRisk,
    defects: [],
    reasons: [],
    planKey: "sign-repair-plan:v1:test-key",
  };
}

describe("describeSignPlanForOperator — per-step translation", () => {
  it("reconstruct_resolution: auto_safe, no review reason, real params translated", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_resolution",
          params: { requestedScale: 2.5, requestedWidthPx: 2500, requestedHeightPx: 2500 },
          risk: "auto_safe",
          reasons: ["internal-only"],
        },
      ],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]),
      plan,
    });

    assert.equal(view.steps.length, 1);
    const step = view.steps[0]!;
    assert.match(step.summary, /resolution/i);
    assert.match(step.detail!, /2500/);
    assert.match(step.detail!, /2\.50/);
    assert.equal(step.needsReview, false);
    assert.equal(step.reviewReason, null);
    assertNoLeakedVocabulary(view);
  });

  it("downsample: auto_safe, target size translated", () => {
    const plan = planWithSteps(
      [
        {
          kind: "downsample",
          params: { targetWidthPx: 2700, targetHeightPx: 3600 },
          risk: "auto_safe",
          reasons: ["internal-only"],
        },
      ],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 5000,
      artworkHeightPx: 5000,
      inspection: inspectionWithEdges([]),
      plan,
    });

    const step = view.steps[0]!;
    assert.match(step.detail!, /2700/);
    assert.match(step.detail!, /3600/);
    assert.equal(step.needsReview, false);
    assertNoLeakedVocabulary(view);
  });

  it("extend_uniform_background: auto_safe, both edges provably uniform — no review reason", () => {
    const plan = planWithSteps(
      [
        {
          kind: "extend_uniform_background",
          params: { axis: "vertical", leadingPx: 306, trailingPx: 306, colorR: 250, colorG: 250, colorB: 248 },
          risk: "auto_safe",
          reasons: ["internal-only"],
        },
      ],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([
        edgeEvidence("top", "uniform_background"),
        edgeEvidence("bottom", "uniform_background"),
      ]),
      plan,
    });

    const step = view.steps[0]!;
    assert.match(step.detail!, /306 px to the top and bottom/);
    assert.match(step.detail!, /near-white/);
    assert.equal(step.needsReview, false);
    assert.equal(step.reviewReason, null);
    assertNoLeakedVocabulary(view);
  });

  it("pad_uniform_background: review_required, mixed_or_uncertain edges — THIS real customer's exact shape", () => {
    // The real customer's persisted plan (LIVE PRODUCT BLOCKER #4A audit):
    // 306 px top and bottom, near-white fill, both edges mixed_or_uncertain.
    const plan = planWithSteps(
      [
        {
          kind: "pad_uniform_background",
          params: { axis: "vertical", leadingPx: 306, trailingPx: 306, colorR: 250, colorG: 250, colorB: 248 },
          risk: "review_required",
          reasons: [
            "Extension edges are not provably uniform background (top: mixed_or_uncertain; bottom: mixed_or_uncertain) — the fill terminates content visibly and a human must approve the seam.",
          ],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([
        edgeEvidence("top", "mixed_or_uncertain"),
        edgeEvidence("bottom", "mixed_or_uncertain"),
      ]),
      plan,
    });

    assert.equal(view.canAuthorize, true);
    assert.match(view.riskLabel, /review/i);
    const step = view.steps[0]!;
    assert.match(step.detail!, /306 px to the top and bottom/);
    assert.equal(step.needsReview, true);
    assert.match(step.reviewReason!, /top edge is not clearly uniform background/i);
    assert.match(step.reviewReason!, /bottom edge is not clearly uniform background/i);
    assert.match(step.reviewReason!, /visible seam/i);
    assert.match(step.reviewReason!, /production review/i);
    assertNoLeakedVocabulary(view);
  });

  it("pad_uniform_background: foreground_bleed edge translated distinctly from mixed_or_uncertain", () => {
    const plan = planWithSteps(
      [
        {
          kind: "pad_uniform_background",
          params: { axis: "horizontal", leadingPx: 40, trailingPx: 40, colorR: 10, colorG: 10, colorB: 10 },
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([
        edgeEvidence("left", "foreground_bleed"),
        edgeEvidence("right", "foreground_bleed"),
      ]),
      plan,
    });

    const step = view.steps[0]!;
    assert.match(step.detail!, /40 px to the left and right/);
    assert.match(step.detail!, /near-black/);
    assert.match(step.reviewReason!, /part of the design reaches the left edge/i);
    assert.match(step.reviewReason!, /part of the design reaches the right edge/i);
    assertNoLeakedVocabulary(view);
  });

  it("pad_uniform_background: no confirmed fill colour is stated honestly, never fabricated", () => {
    const plan = planWithSteps(
      [
        {
          kind: "pad_uniform_background",
          params: { axis: "vertical", leadingPx: 10, trailingPx: 12, color: "unconfirmed" },
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([
        edgeEvidence("top", "mixed_or_uncertain"),
        edgeEvidence("bottom", "foreground_bleed"),
      ]),
      plan,
    });

    const step = view.steps[0]!;
    // Different leading/trailing must not be misreported as equal.
    assert.match(step.detail!, /10 px to the top and 12 px to the bottom/);
    assert.match(step.detail!, /could not be confidently determined/i);
    assert.doesNotMatch(step.detail!, /RGB/);
    assertNoLeakedVocabulary(view);
  });

  it("rotate_90: review_required, plain rotation explanation", () => {
    const plan = planWithSteps(
      [{ kind: "rotate_90", params: { direction: "cw" }, risk: "review_required", reasons: ["internal-only"] }],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]),
      plan,
    });

    const step = view.steps[0]!;
    assert.match(step.summary, /rotate/i);
    assert.equal(step.needsReview, true);
    assert.match(step.reviewReason!, /confirm/i);
    assertNoLeakedVocabulary(view);
  });

  it("approved_crop: always flagged for review even if the plan somehow marked it otherwise", () => {
    const plan = planWithSteps(
      [{ kind: "approved_crop", params: { cropPx: 20 }, risk: "auto_safe", reasons: ["internal-only"] }],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]),
      plan,
    });

    const step = view.steps[0]!;
    assert.equal(step.needsReview, true);
    assert.match(step.reviewReason!, /trim/i);
    assertNoLeakedVocabulary(view);
  });

  /** A `reconstruct_parametric_frame` step's own flat param shape — mirrors `sign-repair-planner.ts`'s `encodeFrameStructuralModelParams` exactly. */
  function parametricFrameParams(overrides?: {
    cornerRadiusPx?: number;
    hasHole?: boolean;
  }): Record<string, number | string> {
    const cornerRadiusPx = overrides?.cornerRadiusPx ?? -1;
    const hasHole = overrides?.hasHole ?? false;
    const params: Record<string, number | string> = {
      axis: "vertical",
      leadingPx: 30,
      trailingPx: 40,
      leadingShare: 0.4,
      modelSourceWidthPx: 1086,
      modelSourceHeightPx: 1448,
      frameDepthPx: 27,
      bandCount: 1,
      fillColorR: 202,
      fillColorG: 14,
      fillColorB: 14,
      cornerRadiusPx,
      hasHole: hasHole ? "true" : "false",
      band0R: 4,
      band0G: 4,
      band0B: 4,
      band0ThicknessPx: 27,
    };
    if (cornerRadiusPx >= 0) {
      params.outerBackgroundColorR = 255;
      params.outerBackgroundColorG = 255;
      params.outerBackgroundColorB = 255;
    }
    if (hasHole) {
      params.holeRadiusPx = 9;
      params.holeOffsetXPx = 33;
      params.holeOffsetYPx = 33;
      params.holeRingColorR = 4;
      params.holeRingColorG = 4;
      params.holeRingColorB = 4;
      params.holeInteriorColorR = 253;
      params.holeInteriorColorG = 253;
      params.holeInteriorColorB = 253;
    }
    return params;
  }

  it("reconstruct_parametric_frame: square corners, no hole — never uses the generic fallback, never claims a feature the model didn't measure", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_parametric_frame",
          params: parametricFrameParams(),
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([]),
      plan,
    });

    const step = view.steps[0]!;
    assert.notEqual(step.summary, "A production adjustment is proposed for this artwork.", "must never fall through to the generic fallback");
    assert.match(step.summary, /perimeter|frame/i);
    assert.match(step.detail!, /frame\/border/i);
    assert.match(step.detail!, /preserving the central artwork/i);
    assert.match(step.detail!, /will not be stretched/i);
    // Neither feature was measured for this step — never claimed.
    assert.doesNotMatch(step.detail!, /rounded/i);
    assert.doesNotMatch(step.detail!, /hole/i);
    assert.equal(step.needsReview, true);
    assert.match(step.reviewReason!, /production/i);
    assertNoLeakedVocabulary(view);
  });

  it("reconstruct_parametric_frame: geometry (axis/leadingPx/trailingPx) translated to plain edges", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_parametric_frame",
          params: parametricFrameParams(),
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([]),
      plan,
    });
    const step = view.steps[0]!;
    assert.match(step.detail!, /30px on the top edge/i);
    assert.match(step.detail!, /40px on the bottom edge/i);
  });

  it("reconstruct_parametric_frame: rounded corners measured — copy conditionally includes rounded-corner language, no hole claim", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_parametric_frame",
          params: parametricFrameParams({ cornerRadiusPx: 42 }),
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([]),
      plan,
    });
    const step = view.steps[0]!;
    assert.match(step.detail!, /rounded-corner/i);
    assert.match(step.reviewReason!, /rounding/i);
    assert.doesNotMatch(step.detail!, /hole/i);
  });

  it("reconstruct_parametric_frame: corner-hole indicators measured — copy conditionally includes hole language, explicitly artwork-not-manufacturing", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_parametric_frame",
          params: parametricFrameParams({ hasHole: true }),
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([]),
      plan,
    });
    const step = view.steps[0]!;
    assert.match(step.detail!, /corner-hole indicators/i);
    assert.match(step.detail!, /not a manufacturing drilling instruction/i);
    assert.match(step.reviewReason!, /corner-hole indicators/i);
    // Never implies a manufacturing/hardware specification.
    assert.doesNotMatch(step.detail!, /drill diameter|hardware size|physical corner radius/i);
    assert.doesNotMatch(step.detail!, /rounded-corner/i, "no rounding was measured for this fixture");
  });

  it("reconstruct_parametric_frame: rounded corners AND holes both measured — both conditionally described together", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_parametric_frame",
          params: parametricFrameParams({ cornerRadiusPx: 55, hasHole: true }),
          risk: "review_required",
          reasons: ["internal-only"],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([]),
      plan,
    });
    const step = view.steps[0]!;
    assert.match(step.detail!, /rounded-corner/i);
    assert.match(step.detail!, /corner-hole indicators/i);
    assert.match(step.reviewReason!, /rounding/i);
    assert.match(step.reviewReason!, /corner-hole indicators/i);
  });

  it("reconstruct_parametric_frame: always flagged for review even if the plan somehow marked it otherwise (constitutional requirement, mirrors reconstruct_perimeter_structure's own discipline)", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_parametric_frame",
          params: parametricFrameParams(),
          risk: "auto_safe",
          reasons: ["internal-only"],
        },
      ],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: 1086,
      artworkHeightPx: 1448,
      inspection: inspectionWithEdges([]),
      plan,
    });
    assert.equal(view.steps[0]!.needsReview, true);
  });

  it("only parameters actually present in the step are shown — nothing fabricated", () => {
    const plan = planWithSteps(
      [{ kind: "reconstruct_resolution", params: {}, risk: "auto_safe", reasons: [] }],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]),
      plan,
    });

    assert.equal(view.steps[0]!.detail, null);
  });
});

/**
 * General Product Rule audit (Parametric Frame Operator Review Copy Phase):
 * every `SignRepairStepKind` `sign-repair-planner.ts` can ACTUALLY emit
 * today must render real, non-generic operator copy — never the silent
 * "A production adjustment is proposed for this artwork." fallback.
 *
 * `"proportional_resample"` is DELIBERATELY excluded from this list: it is
 * a reserved, dormant `SignRepairStepKind` (declared in `contracts.ts`,
 * admitted by `sign-transform-executor.ts`) that `sign-repair-planner.ts`
 * never actually emits — grep-verified. Writing operator-facing copy for a
 * step kind with no established planner semantics would be inventing
 * intent the codebase has not yet decided, exactly what this phase's own
 * "never claim a feature the plan/model cannot substantiate" rule forbids.
 * A dormant hook is not an unfinished requirement (`AGENTS.md`) — if a
 * future phase ever makes the planner emit it, this same audit (and the
 * generic-fallback assertion below) will need a first-class case added
 * alongside it, exactly like `reconstruct_parametric_frame` got here.
 */
describe("General Product Rule audit: no currently-reachable SignRepairStepKind falls through to generic copy", () => {
  const GENERIC_FALLBACK_SUMMARY = "A production adjustment is proposed for this artwork.";

  const REACHABLE_STEPS: SignRepairStep[] = [
    { kind: "reconstruct_resolution", params: { requestedScale: 2, requestedWidthPx: 2000, requestedHeightPx: 2000 }, risk: "auto_safe", reasons: [] },
    { kind: "downsample", params: { targetWidthPx: 2000, targetHeightPx: 2000 }, risk: "auto_safe", reasons: [] },
    { kind: "extend_uniform_background", params: { axis: "vertical", leadingPx: 10, trailingPx: 10, colorR: 250, colorG: 250, colorB: 250 }, risk: "auto_safe", reasons: [] },
    { kind: "pad_uniform_background", params: { axis: "vertical", leadingPx: 10, trailingPx: 10, colorR: 250, colorG: 250, colorB: 250 }, risk: "review_required", reasons: [] },
    { kind: "reconstruct_perimeter_structure", params: { axis: "vertical", leadingPx: 10, trailingPx: 10, leadingBandDepthPx: 1, trailingBandDepthPx: 1 }, risk: "review_required", reasons: [] },
    {
      kind: "reconstruct_parametric_frame",
      params: {
        axis: "vertical", leadingPx: 10, trailingPx: 10, leadingShare: 0.5,
        modelSourceWidthPx: 1000, modelSourceHeightPx: 1000, frameDepthPx: 10, bandCount: 1,
        fillColorR: 200, fillColorG: 10, fillColorB: 10, cornerRadiusPx: -1, hasHole: "false",
        band0R: 4, band0G: 4, band0B: 4, band0ThicknessPx: 10,
      },
      risk: "review_required",
      reasons: [],
    },
    { kind: "rotate_90", params: {}, risk: "review_required", reasons: [] },
    { kind: "approved_crop", params: {}, risk: "auto_safe", reasons: [] },
    // Signs Flat-Raster Production Workflow Correction / real Get Hibachi
    // authorization-screen defect: the canvas-first composition primitives
    // (Signs Phase 3B) were never added to this audit when they shipped —
    // exactly the gap that let `fit_artwork_to_canvas` silently fall
    // through to the generic fallback on the real Get Hibachi plan.
    {
      kind: "fit_artwork_to_canvas",
      params: {
        expectedArtworkWidthPx: 2000, expectedArtworkHeightPx: 2000,
        canvasWidthPx: 2000, canvasHeightPx: 2000,
        placementXPx: 0, placementYPx: 0,
        backgroundR: 0, backgroundG: 0, backgroundB: 0,
      },
      risk: "review_required",
      reasons: [],
    },
    {
      kind: "crop_region",
      params: { expectedInputWidthPx: 2000, expectedInputHeightPx: 2000, xPx: 0, yPx: 0, widthPx: 1000, heightPx: 1000 },
      risk: "review_required",
      reasons: [],
    },
    {
      kind: "move_region",
      params: { sourceStartYPx: 0, heightPx: 100, destStartYPx: 200 },
      risk: "review_required",
      reasons: [],
    },
    {
      kind: "fill_rect",
      params: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100, colorR: 200, colorG: 10, colorB: 10 },
      risk: "review_required",
      reasons: [],
    },
    {
      kind: "replace_region_with_background",
      params: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 8 },
      risk: "review_required",
      reasons: [],
    },
    {
      kind: "replace_masked_region_with_background",
      params: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100, colorR: 200, colorG: 10, colorB: 10, contextDepthPx: 8, maskBase64: "AAAA" },
      risk: "review_required",
      reasons: [],
    },
  ];

  it("every currently-reachable step kind produces a real summary, never the generic fallback", () => {
    for (const step of REACHABLE_STEPS) {
      const plan = planWithSteps([step], step.risk);
      const view = describeSignPlanForOperator({
        orderedWidthIn: 18,
        orderedHeightIn: 24,
        artworkWidthPx: 1000,
        artworkHeightPx: 1000,
        inspection: inspectionWithEdges([]),
        plan,
      });
      assert.notEqual(
        view.steps[0]!.summary,
        GENERIC_FALLBACK_SUMMARY,
        `step kind "${step.kind}" fell through to the generic fallback — add first-class operator-review copy for it`,
      );
    }
  });
});

describe("describeSignPlanForOperator — fit_artwork_to_canvas (Show the Actual Fit-to-Safe-Area Change on the Authorization Screen)", () => {
  // 2. fit-only plan shows Fit-to-Safe-Area summary
  // 5. scale percentage derived from persisted plan when safely available
  it("a genuine safe-area inset fit (scaleTargetWidthPx/HeightPx present) is described as Fit to Safe Area, with the derived scale percentage", () => {
    const plan = planWithSteps(
      [
        {
          kind: "fit_artwork_to_canvas",
          params: {
            expectedArtworkWidthPx: 5508, expectedArtworkHeightPx: 3672,
            canvasWidthPx: 5508, canvasHeightPx: 3672,
            scaleTargetWidthPx: 5468, scaleTargetHeightPx: 3632,
            placementXPx: 30, placementYPx: 20,
            backgroundR: 0, backgroundG: 0, backgroundB: 0,
          },
          risk: "review_required",
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36,
      orderedHeightIn: 24,
      artworkWidthPx: 1536,
      artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]),
      plan,
    });
    const step = view.steps[0]!;
    assert.match(step.summary, /safe area/i);
    assert.match(step.summary, /0\.125/);
    // 3632/3672 = 0.98910675... -> 98.9%, the exact real Get Hibachi value.
    assert.match(step.detail!, /98\.9%/);
    assert.equal(step.needsReview, true);
    assert.match(step.reviewReason!, /production review/i);
    assertNoLeakedVocabulary(view);
  });

  // 7. aspect ratio preserved / no stretch stated where guaranteed by the actual primitive
  // 8. background extends to cut edge stated where the actual step performs that behavior
  it("the Fit to Safe Area summary states background extension and aspect-ratio/no-stretch, matching what the primitive actually guarantees", () => {
    const plan = planWithSteps(
      [
        {
          kind: "fit_artwork_to_canvas",
          params: {
            expectedArtworkWidthPx: 5508, expectedArtworkHeightPx: 3672,
            canvasWidthPx: 5508, canvasHeightPx: 3672,
            scaleTargetWidthPx: 5468, scaleTargetHeightPx: 3632,
            placementXPx: 30, placementYPx: 20,
            backgroundR: 0, backgroundG: 0, backgroundB: 0,
          },
          risk: "review_required",
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    const step = view.steps[0]!;
    assert.match(step.detail!, /background will extend to the cut edge/i);
    assert.match(step.detail!, /aspect ratio will be preserved/i);
    assert.match(step.detail!, /not be stretched/i);
  });

  it("an ordinary 'fit to fill the canvas' step (no scaleTarget present — every initial composition plan's own shape) is described as placement, never Fit to Safe Area, and never mentions a scale percentage", () => {
    const plan = planWithSteps(
      [
        {
          kind: "fit_artwork_to_canvas",
          params: {
            expectedArtworkWidthPx: 1000, expectedArtworkHeightPx: 1000,
            canvasWidthPx: 1000, canvasHeightPx: 1000,
            placementXPx: 0, placementYPx: 0,
            backgroundR: 255, backgroundG: 255, backgroundB: 255,
          },
          risk: "review_required",
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18, orderedHeightIn: 24, artworkWidthPx: 1000, artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]), plan,
    });
    const step = view.steps[0]!;
    assert.doesNotMatch(step.summary, /safe area/i);
    assert.doesNotMatch(step.detail ?? "", /%/);
    assert.match(step.summary, /production canvas/i);
  });

  // 6. Fit percentage omitted when not safely derivable
  it("omits the scale percentage rather than fabricating one when the artwork dimensions needed to derive it are missing", () => {
    const plan = planWithSteps(
      [
        {
          kind: "fit_artwork_to_canvas",
          params: {
            // expectedArtworkWidthPx/HeightPx deliberately absent/invalid.
            canvasWidthPx: 5508, canvasHeightPx: 3672,
            scaleTargetWidthPx: 5468, scaleTargetHeightPx: 3632,
            placementXPx: 30, placementYPx: 20,
            backgroundR: 0, backgroundG: 0, backgroundB: 0,
          },
          risk: "review_required",
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    const step = view.steps[0]!;
    assert.doesNotMatch(step.detail ?? "", /%/);
    // Still correctly identified as a safe-area fit (scaleTarget IS present) — only the percentage is withheld.
    assert.match(step.summary, /safe area/i);
  });

  // 3. fit + resolution plan shows BOTH summaries
  // 4. ordering of internal steps does not cause one material adjustment to vanish
  it("a plan with BOTH reconstruct_resolution and fit_artwork_to_canvas shows BOTH summaries — the real Get Hibachi plan shape, reconstruct-then-fit order", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_resolution",
          params: { requestedScale: 3.5859375, requestedWidthPx: 5508, requestedHeightPx: 3672 },
          risk: "auto_safe",
          reasons: [],
        },
        {
          kind: "fit_artwork_to_canvas",
          params: {
            expectedArtworkWidthPx: 5508, expectedArtworkHeightPx: 3672,
            canvasWidthPx: 5508, canvasHeightPx: 3672,
            scaleTargetWidthPx: 5468, scaleTargetHeightPx: 3632,
            placementXPx: 30, placementYPx: 20,
            backgroundR: 0, backgroundG: 0, backgroundB: 0,
          },
          risk: "review_required",
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.equal(view.steps.length, 2);
    assert.match(view.steps[0]!.summary, /resolution/i);
    assert.match(view.steps[0]!.detail!, /5508/);
    assert.match(view.steps[0]!.detail!, /3672/);
    assert.match(view.steps[1]!.summary, /safe area/i);
    assert.match(view.steps[1]!.detail!, /98\.9%/);
  });

  it("the same two steps in the OPPOSITE order still show both summaries — ordering never hides a material adjustment", () => {
    const plan = planWithSteps(
      [
        {
          kind: "fit_artwork_to_canvas",
          params: {
            expectedArtworkWidthPx: 5508, expectedArtworkHeightPx: 3672,
            canvasWidthPx: 5508, canvasHeightPx: 3672,
            scaleTargetWidthPx: 5468, scaleTargetHeightPx: 3632,
            placementXPx: 30, placementYPx: 20,
            backgroundR: 0, backgroundG: 0, backgroundB: 0,
          },
          risk: "review_required",
          reasons: [],
        },
        {
          kind: "reconstruct_resolution",
          params: { requestedScale: 3.5859375, requestedWidthPx: 5508, requestedHeightPx: 3672 },
          risk: "auto_safe",
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.equal(view.steps.length, 2);
    assert.match(view.steps[0]!.summary, /safe area/i);
    assert.match(view.steps[1]!.summary, /resolution/i);
  });

  // 1. resolution-only plan shows resolution summary
  it("a resolution-only plan (no fit step at all) shows only the resolution summary", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_resolution",
          params: { requestedScale: 3.5859375, requestedWidthPx: 5508, requestedHeightPx: 3672 },
          risk: "auto_safe",
          reasons: [],
        },
      ],
      "auto_safe",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.equal(view.steps.length, 1);
    assert.match(view.steps[0]!.summary, /resolution/i);
  });

  // 9. exact ordered size shown from project/production spec, not hard-coded
  it("the ordered size shown comes from the caller's own orderedWidthIn/orderedHeightIn input, never a fixed value", () => {
    const plan = planWithSteps([], "auto_safe");
    const viewA = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    const viewB = describeSignPlanForOperator({
      orderedWidthIn: 18, orderedHeightIn: 12, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.equal(viewA.orderedWidthIn, 36);
    assert.equal(viewA.orderedHeightIn, 24);
    assert.equal(viewB.orderedWidthIn, 18);
    assert.equal(viewB.orderedHeightIn, 12);
  });

  // The exact real Get Hibachi persisted plan shape (read-only trace,
  // 2026 acceptance): reconstruct_resolution then fit_artwork_to_canvas,
  // scale 3632/3672 = 98.9%.
  it("the REAL Get Hibachi persisted plan's exact shape: both steps render real, distinct, non-generic copy", () => {
    const plan = planWithSteps(
      [
        {
          kind: "reconstruct_resolution",
          risk: "auto_safe",
          params: { requestedScale: 3.5859375, requestedWidthPx: 5508, requestedHeightPx: 3672 },
          reasons: [],
        },
        {
          kind: "fit_artwork_to_canvas",
          risk: "review_required",
          params: {
            backgroundB: 0, backgroundG: 0, backgroundR: 0,
            placementXPx: 30, placementYPx: 20,
            canvasWidthPx: 5508, canvasHeightPx: 3672,
            scaleTargetWidthPx: 5468, scaleTargetHeightPx: 3632,
            expectedArtworkWidthPx: 5508, expectedArtworkHeightPx: 3672,
          },
          reasons: [],
        },
      ],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 36, orderedHeightIn: 24, artworkWidthPx: 1536, artworkHeightPx: 1024,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.equal(view.steps.length, 2);
    assert.notEqual(view.steps[0]!.summary, "A production adjustment is proposed for this artwork.");
    assert.notEqual(view.steps[1]!.summary, "A production adjustment is proposed for this artwork.");
    assert.match(view.steps[1]!.detail!, /98\.9%/);
    assert.match(view.steps[1]!.detail!, /background will extend to the cut edge/i);
    assertNoLeakedVocabulary(view);
  });
});

describe("describeSignPlanForOperator — other canvas-first composition primitives (never the generic fallback)", () => {
  it("crop_region: dimensions translated, no bare internal identifiers", () => {
    const plan = planWithSteps(
      [{ kind: "crop_region", params: { expectedInputWidthPx: 2000, expectedInputHeightPx: 2000, xPx: 100, yPx: 100, widthPx: 1800, heightPx: 1800 }, risk: "review_required", reasons: [] }],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18, orderedHeightIn: 24, artworkWidthPx: 2000, artworkHeightPx: 2000,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.match(view.steps[0]!.summary, /crop/i);
    assert.match(view.steps[0]!.detail!, /1800/);
    assertNoLeakedVocabulary(view);
  });

  it("move_region: source/destination y translated", () => {
    const plan = planWithSteps(
      [{ kind: "move_region", params: { sourceStartYPx: 50, heightPx: 100, destStartYPx: 500 }, risk: "review_required", reasons: [] }],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18, orderedHeightIn: 24, artworkWidthPx: 1000, artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.match(view.steps[0]!.summary, /move/i);
    assert.match(view.steps[0]!.detail!, /50/);
    assert.match(view.steps[0]!.detail!, /500/);
    assertNoLeakedVocabulary(view);
  });

  it("replace_region_with_background: colour translated via the same colorDescription helper as pad steps", () => {
    const plan = planWithSteps(
      [{ kind: "replace_region_with_background", params: { xPx: 0, yPx: 0, widthPx: 30, heightPx: 30, colorR: 10, colorG: 10, colorB: 10, contextDepthPx: 8 }, risk: "review_required", reasons: [] }],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18, orderedHeightIn: 24, artworkWidthPx: 1000, artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.match(view.steps[0]!.summary, /remove/i);
    assert.match(view.steps[0]!.detail!, /near-black/i);
    assertNoLeakedVocabulary(view);
  });

  it("replace_masked_region_with_background: described as an exact-shape removal, distinct from the rectangular variant", () => {
    const plan = planWithSteps(
      [{ kind: "replace_masked_region_with_background", params: { xPx: 0, yPx: 0, widthPx: 30, heightPx: 30, colorR: 10, colorG: 10, colorB: 10, contextDepthPx: 8, maskBase64: "AAAA" }, risk: "review_required", reasons: [] }],
      "review_required",
    );
    const view = describeSignPlanForOperator({
      orderedWidthIn: 18, orderedHeightIn: 24, artworkWidthPx: 1000, artworkHeightPx: 1000,
      inspection: inspectionWithEdges([]), plan,
    });
    assert.match(view.steps[0]!.summary, /exact shape/i);
    assertNoLeakedVocabulary(view);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: real planner output, real fixtures — proves end-to-end wiring
// through the ACTUAL inspection/planning authority, not a hand-built stand-in.
// ---------------------------------------------------------------------------

function spec(orderedWidthIn: number, orderedHeightIn: number): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-08-30T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function realPlan(image: Parameters<typeof inspectSignArtwork>[0], orderedWidthIn: number, orderedHeightIn: number) {
  const s = spec(orderedWidthIn, orderedHeightIn);
  const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
  const result = planSignRepair({
    spec: s,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
  });
  return { inspection, result };
}

/** Like `realPlan`, but also measures and supplies the frame structural model — required for the planner to admit `reconstruct_parametric_frame` at all. */
async function realFramePlan(
  image: Parameters<typeof inspectSignArtwork>[0],
  orderedWidthIn: number,
  orderedHeightIn: number,
) {
  const { measureCleanFillRunPx, measureFrameStructuralModel } = await import("./frame-structure-model");
  const s = spec(orderedWidthIn, orderedHeightIn);
  const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
  const frameStructuralModel = measureFrameStructuralModel(image);
  const frameCleanFillRunPx: Partial<Record<SignEdge, number>> = {};
  if (frameStructuralModel.status === "measured") {
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      frameCleanFillRunPx[edge] = measureCleanFillRunPx(image, edge, frameStructuralModel.model.frameDepthPx);
    }
  }
  const result = planSignRepair({
    spec: s,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    frameStructuralModel,
    frameCleanFillRunPx,
  });
  return { inspection, result };
}

describe("describeSignPlanForOperator — real planner output", () => {
  it("Ruth-shaped artwork: review_required plan renders a step-level reason mentioning production review, no raw JSON, no leaked vocabulary", () => {
    const { inspection, result } = realPlan(ruthLikeSignArtwork(), 18, 24);
    assert.equal(result.status, "planned");
    assert.equal(result.plan!.overallRisk, "review_required");

    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      inspection,
      plan: result.plan!,
    });

    assert.match(view.riskLabel, /review/i);
    const reviewSteps = view.steps.filter((step) => step.needsReview);
    assert.ok(reviewSteps.length > 0, "at least one step must explain why it needs review");
    for (const step of reviewSteps) {
      assert.ok(step.reviewReason, "every review step must carry a plain-language reason");
      assert.match(step.reviewReason!, /production review/i);
    }
    assertNoLeakedVocabulary(view);
    // Never a raw dump of the plan/inspection objects themselves.
    assert.doesNotMatch(JSON.stringify(view), /sourceSha256|inspectionVersion|schemaVersion/i);
  });

  it("Noisy-edge artwork (mixed_or_uncertain) at a mismatched ordered size: review reason names the uncertain edges plainly", () => {
    const { inspection, result } = realPlan(noisyEdgeSignArtwork(), 18, 24);
    assert.equal(result.status, "planned");
    assert.equal(result.plan!.overallRisk, "review_required");

    const view = describeSignPlanForOperator({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      inspection,
      plan: result.plan!,
    });

    const padStep = view.steps.find((step) => step.needsReview && /space around the design/i.test(step.summary));
    assert.ok(padStep, "expected a background/canvas adjustment step needing review");
    assert.match(padStep!.reviewReason!, /not clearly uniform background/i);
    assertNoLeakedVocabulary(view);
  });

  it("Exact-aspect, low-resolution artwork: auto_safe plan shows a resolution step with no review reason", () => {
    const { inspection, result } = realPlan(
      ruthLikeSignArtwork(), // reused only for a valid decoded image; aspect mismatch is irrelevant here
      // Use a size whose aspect exactly matches the source (1024x1536 → 2:3) so
      // the ONLY driver is resolution, mirroring sign-repair-planner.test.ts's
      // own low-resolution/auto_safe case shape.
      16,
      24,
    );
    assert.equal(result.status, "planned");
    // Source (1024×1536) and ordered (16×24) share the exact same aspect
    // ratio, so no geometry/padding step is possible — the plan can only
    // ever be a resolution decision, which the planner always risks
    // `auto_safe`.
    assert.equal(result.plan!.overallRisk, "auto_safe");

    const view = describeSignPlanForOperator({
      orderedWidthIn: 16,
      orderedHeightIn: 24,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      inspection,
      plan: result.plan!,
    });

    assert.match(view.riskLabel, /no production review needed/i);
    for (const step of view.steps) {
      assert.equal(step.needsReview, false);
      assert.equal(step.reviewReason, null);
    }
    assertNoLeakedVocabulary(view);
  });

  it("Framed sign artwork (rounded corners + 4 holes, real measured geometry): operator copy names both features, never generic, never leaked vocabulary", async () => {
    const { inspection, result } = await realFramePlan(
      framedSignArtwork({ width: 4000, height: 5333, rounded: true, withHoles: true }),
      24,
      36,
    );
    assert.equal(result.status, "planned");
    assert.ok(result.plan!.steps.some((step) => step.kind === "reconstruct_parametric_frame"), "sanity: this is genuinely the parametric-frame plan shape");

    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      inspection,
      plan: result.plan!,
    });

    const frameStep = view.steps.find((step) => /perimeter|frame/i.test(step.summary));
    assert.ok(frameStep, "expected a real, non-generic parametric-frame step summary");
    assert.notEqual(frameStep!.summary, "A production adjustment is proposed for this artwork.");
    assert.match(frameStep!.detail!, /rounded-corner/i, "the real fixture's own measured model has rounding — must be named");
    assert.match(frameStep!.detail!, /corner-hole indicators/i, "the real fixture's own measured model has holes — must be named");
    assert.match(frameStep!.detail!, /will not be stretched/i);
    assert.equal(frameStep!.needsReview, true);
    assertNoLeakedVocabulary(view);
  });

  it("The real cc6cfc4b-... project's own shape (1086×1448 source, 24×36 ordered, resolution + frame combined): both steps render real, distinct, non-generic copy", async () => {
    const { inspection, result } = await realFramePlan(
      framedSignArtwork({ width: 1086, height: 1448, rounded: true, withHoles: true }),
      24,
      36,
    );
    assert.equal(result.status, "planned");
    assert.ok(result.plan!.steps.some((step) => step.kind === "reconstruct_resolution"));
    assert.ok(result.plan!.steps.some((step) => step.kind === "reconstruct_parametric_frame"));

    const view = describeSignPlanForOperator({
      orderedWidthIn: 24,
      orderedHeightIn: 36,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      inspection,
      plan: result.plan!,
    });

    assert.equal(view.steps.length, 2);
    for (const step of view.steps) {
      assert.notEqual(step.summary, "A production adjustment is proposed for this artwork.");
    }
    assert.match(view.steps[0]!.summary, /resolution/i, "resolution reconstruction is presented first, matching the proven transform order");
    assert.match(view.steps[1]!.summary, /perimeter|frame/i);
    assert.match(view.steps[1]!.detail!, /rounded-corner/i);
    assert.match(view.steps[1]!.detail!, /corner-hole indicators/i);
    assertNoLeakedVocabulary(view);
  });
});
