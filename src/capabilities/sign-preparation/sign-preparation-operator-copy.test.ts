import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noisyEdgeSignArtwork, ruthLikeSignArtwork } from "./sign-fixtures";
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
  "approved_crop",
  "rotate_90",
  "plan_key",
  "planKey",
  "auto_safe",
  "review_required",
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
});
