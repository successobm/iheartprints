import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
} from "./sign-fixtures";
import type { SignProductionSpec } from "./contracts";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { inspectSignArtwork } from "./sign-inspection";
import { planSignRepair } from "./sign-repair-planner";
import { describeSignPlanForCustomer } from "./sign-preparation-copy";

/**
 * LIVE PRODUCT BLOCKER #3: proves the copy module translates REAL planner
 * output (the same fixtures + expected outcomes `sign-repair-planner.test.ts`
 * already proves) rather than deciding anything itself. Every planning
 * outcome used here is one already established by that suite — this file
 * never asserts a NEW diagnosis, only that the copy layer renders an
 * existing one honestly and without leaking internal vocabulary.
 */

function spec(orderedWidthIn: number, orderedHeightIn: number): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-08-30T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function plan(image: RgbaImage, orderedWidthIn: number, orderedHeightIn: number) {
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

/** Every code/kind string this module must never leak into a finding or the proposed action. */
const INTERNAL_VOCABULARY = [
  "rigid_sign_raster",
  "SignPreparation",
  "SignRepairPlan",
  "resolutionPolicyId",
  "resolution_below_minimum",
  "aspect_ratio_mismatch",
  "reconstruct_resolution",
  "extend_uniform_background",
  "pad_uniform_background",
  "proportional_resample",
  "downsample",
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
    assert.doesNotMatch(
      serialized,
      new RegExp(term, "i"),
      `leaked internal vocabulary: ${term}`,
    );
  }
}

describe("describeSignPlanForCustomer — ready (auto_safe)", () => {
  it("Real planner output: exact aspect + sufficient resolution, nothing to do", () => {
    // Reuses sign-repair-planner.test.ts case 1 verbatim: no repair needed.
    const { inspection, result } = plan(exactAspectSignArtwork(1800, 2400), 12, 16);
    assert.equal(result.status, "planned");

    const view = describeSignPlanForCustomer({
      orderedWidthIn: 12,
      orderedHeightIn: 16,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      defectCodes: result.defects.map((d) => d.code),
      plan: result.plan,
    });

    assert.equal(view.status, "ready");
    assert.equal(view.canProceed, true);
    assert.equal(view.reviewRequired, false);
    assert.equal(view.artworkWidthPx, 1800);
    assert.equal(view.artworkHeightPx, 2400);
    assert.equal(view.orderedWidthIn, 12);
    assert.equal(view.orderedHeightIn, 16);
    // No steps in the real plan → nothing to propose.
    assert.equal(view.proposedAction, null);
    assertNoLeakedVocabulary(view);
  });

  it("Real planner output: low resolution → reconstruction proposed, translated plainly", () => {
    // Reuses sign-repair-planner.test.ts case 2 verbatim.
    const { inspection, result } = plan(exactAspectSignArtwork(900, 1200), 18, 24);
    assert.equal(result.status, "planned");
    assert.equal(result.plan!.overallRisk, "auto_safe");

    const view = describeSignPlanForCustomer({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      defectCodes: result.defects.map((d) => d.code),
      plan: result.plan,
    });

    assert.equal(view.status, "ready");
    assert.match(view.proposedAction!, /resolution/i);
    assertNoLeakedVocabulary(view);
  });
});

describe("describeSignPlanForCustomer — needs_review", () => {
  it("Real planner output: Ruth-shaped mismatch, foreground reaches the extension edge", () => {
    // Reuses sign-repair-planner.test.ts case 4 verbatim — the exact same
    // real customer-shaped case this repo already proved is review-required.
    const { inspection, result } = plan(ruthLikeSignArtwork(), 18, 24);
    assert.equal(result.status, "planned");
    assert.equal(result.plan!.overallRisk, "review_required");

    const view = describeSignPlanForCustomer({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      defectCodes: result.defects.map((d) => d.code),
      plan: result.plan,
    });

    assert.equal(view.status, "needs_review");
    assert.equal(view.reviewRequired, true);
    assert.equal(view.canProceed, true);
    // A plan DOES exist here — the proposed action is still describable,
    // just flagged as needing review by the status/reviewRequired fields.
    assert.notEqual(view.proposedAction, null);
    assert.ok(view.findings.length > 0);
    // Plain language, not the defect code.
    assert.ok(
      view.findings.some((f) => /edge/i.test(f)),
      "expected a finding mentioning the edge, translated from foreground_reaches_extension_edge",
    );
    // LIVE PRODUCT BLOCKER #3A: the real defects here include BOTH
    // foreground_reaches_extension_edge AND repair_requires_review — the
    // second must never surface as ITS OWN finding sentence, because the
    // caller (UploadedArtworkPanel) already renders one dedicated "Review
    // required" section from `reviewRequired` alone. A second, differently
    // worded review explanation inside `findings` would repeat the screen.
    assert.ok(
      result.defects.some((d) => d.code === "repair_requires_review"),
      "sanity check: this real result does carry the review-meta defect",
    );
    // The removed `repair_requires_review` sentence, verbatim, must not
    // reappear under any other mapping — this is the exact duplicate the
    // customer originally saw. (The `foreground_reaches_extension_edge`
    // finding legitimately says "needs a closer look" too, but that's a
    // substantively different, artwork-specific reason — not the generic
    // review-meta sentence this test guards against.)
    assert.equal(
      view.findings.filter(
        (f) => f === "This needs a closer look from our team before we make any changes.",
      ).length,
      0,
      "the generic review-meta sentence must not appear as a finding — the dedicated review section says this once",
    );
    // LIVE PRODUCT BLOCKER #3A: canvas/background extension is never
    // called a "border" — a print customer could read that as a graphic
    // border being added to their design.
    assert.doesNotMatch(view.proposedAction!, /border/i);
    assert.match(view.proposedAction!, /space around the design/i);
    assert.match(view.proposedAction!, /without stretching or trimming/i);
    assertNoLeakedVocabulary(view);
  });
});

describe("describeSignPlanForCustomer — blocked", () => {
  it("Real planner output: need beyond the supported reconstruction ceiling", () => {
    // Reuses sign-repair-planner.test.ts case 10 verbatim.
    const { inspection, result } = plan(exactAspectSignArtwork(300, 400), 18, 24);
    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);

    const view = describeSignPlanForCustomer({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: inspection.source.widthPx,
      artworkHeightPx: inspection.source.heightPx,
      defectCodes: result.defects.map((d) => d.code),
      plan: result.plan,
    });

    assert.equal(view.status, "blocked");
    assert.equal(view.canProceed, false);
    // Blocked never claims a proposed action the plan doesn't have.
    assert.equal(view.proposedAction, null);
    assert.ok(view.findings.length > 0, "a blocked result must still explain something");
    assertNoLeakedVocabulary(view);
  });
});

describe("describeSignPlanForCustomer — canvas/background extension wording (LIVE PRODUCT BLOCKER #3A)", () => {
  function planWith(stepKind: "extend_uniform_background" | "pad_uniform_background") {
    return describeSignPlanForCustomer({
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      artworkWidthPx: 1000,
      artworkHeightPx: 1500,
      defectCodes: [],
      plan: {
        schemaVersion: "sign-repair-plan:v1" as never,
        policyId: RIGID_RECT_UP_TO_24X36_V1.id,
        sourceAssetId: "asset-1",
        sourceSha256: "a".repeat(64),
        sourceWidthPx: 1000,
        sourceHeightPx: 1500,
        orderedWidthIn: 18,
        orderedHeightIn: 24,
        steps: [
          {
            kind: stepKind,
            params: {},
            risk: "auto_safe",
            reasons: [],
          },
        ],
        expectedOutputWidthPx: 1500,
        expectedOutputHeightPx: 2000,
        expectedEffectivePpi: 83,
        overallRisk: "auto_safe",
        defects: [],
        reasons: [],
        planKey: "irrelevant",
      },
    });
  }

  it("extend_uniform_background never says 'border'", () => {
    const view = planWith("extend_uniform_background");
    assert.doesNotMatch(view.proposedAction!, /border/i);
    assert.match(view.proposedAction!, /space around the design/i);
  });

  it("pad_uniform_background never says 'border'", () => {
    const view = planWith("pad_uniform_background");
    assert.doesNotMatch(view.proposedAction!, /border/i);
    assert.match(view.proposedAction!, /space around the design/i);
  });
});

describe("describeSignPlanForCustomer — never invents a repair the plan doesn't contain", () => {
  it("a plan with zero steps never gets a proposed action synthesized for it", () => {
    const view = describeSignPlanForCustomer({
      orderedWidthIn: 12,
      orderedHeightIn: 16,
      artworkWidthPx: 1800,
      artworkHeightPx: 2400,
      defectCodes: [],
      plan: {
        schemaVersion: "sign-repair-plan:v1" as never,
        policyId: RIGID_RECT_UP_TO_24X36_V1.id,
        sourceAssetId: "asset-1",
        sourceSha256: "a".repeat(64),
        sourceWidthPx: 1800,
        sourceHeightPx: 2400,
        orderedWidthIn: 12,
        orderedHeightIn: 16,
        steps: [],
        expectedOutputWidthPx: 1800,
        expectedOutputHeightPx: 2400,
        expectedEffectivePpi: 150,
        overallRisk: "auto_safe",
        defects: [],
        reasons: [],
        planKey: "irrelevant",
      },
    });
    assert.equal(view.proposedAction, null);
  });

  it("an unmapped defect code is silently omitted rather than leaking its spelling", () => {
    const view = describeSignPlanForCustomer({
      orderedWidthIn: 12,
      orderedHeightIn: 16,
      artworkWidthPx: 1800,
      artworkHeightPx: 2400,
      defectCodes: ["totally_unknown_future_code" as never],
      plan: null,
    });
    assert.equal(view.findings.length, 0);
    assertNoLeakedVocabulary(view);
  });
});
