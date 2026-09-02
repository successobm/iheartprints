/**
 * Structural Layout Reflow Phase 2 (Planner Wiring). Kept as its own file,
 * deliberately separate from `sign-repair-planner.test.ts` (which stays
 * completely untouched by this phase) — every test here supplies the new,
 * OPT-IN `structuralLayoutSegmentation` input; every existing test in the
 * other file never does, so this phase changes zero existing behaviour.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { SignProductionSpec } from "./contracts";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import { measureFrameStructuralModel } from "./frame-structure-model";
import { RIGID_RECT_UP_TO_24X36_V1, SIGN_MINIMUM_SAFE_INSET_IN } from "./resolution-policy";
import {
  acceptanceBannerSignArtwork,
  ambiguousAdjacentFillArtwork,
  bannerSignArtwork,
  bannerSignEdgeContentArtwork,
  framedSignArtwork,
} from "./sign-fixtures";
import type { SignStructuralLayoutSegmentationResult } from "./sign-layout-segmentation";
import { segmentStructuralLayout } from "./sign-layout-segmentation";
import { computeSignPlanKey } from "./sign-plan-identity";
import { planSignRepair, type SignPlanningInput } from "./sign-repair-planner";
import { inspectSignArtwork } from "./sign-inspection";
import { planContainsOnlyAdmittedSteps } from "./sign-transform-executor";

function spec(orderedWidthIn: number, orderedHeightIn: number): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-09-02T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

/**
 * Plans with the image's OWN measured structural-layout segmentation
 * supplied — exactly what a future capability-level wiring would compute
 * alongside inspection, mirroring `sign-repair-planner.test.ts`'s own
 * `planWithFrameModel`/`planWithBands` precedent. `extra` layers in any
 * additional evidence (e.g. `frameStructuralModel`) a specific test needs.
 */
function planWithSegmentation(
  image: RgbaImage,
  orderedWidthIn: number,
  orderedHeightIn: number,
  extra?: Partial<SignPlanningInput>,
) {
  const s = spec(orderedWidthIn, orderedHeightIn);
  const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
  const structuralLayoutSegmentation = segmentStructuralLayout(image);
  return planSignRepair({
    spec: s,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    structuralLayoutSegmentation,
    ...extra,
  });
}

describe("sign repair planner — structural layout reflow (opt-in evidence)", () => {
  it("1: a valid structured banner artwork proposes reflow_structural_layout, never blocked", () => {
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.ok(p.steps.some((step) => step.kind === "reflow_structural_layout"));
    assert.ok(p.defects.includes("structural_layout_reflow_proposed"));
    assert.doesNotMatch(JSON.stringify(p.steps), /"kind":"reconstruct_parametric_frame"/);
    assert.doesNotMatch(JSON.stringify(p.steps), /"kind":"pad_uniform_background"/);
  });

  it("2: the proposal carries straight_rectangle template semantics", () => {
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    const step = result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.equal(step.params.templateShape, "straight_rectangle");
    assert.equal(step.params.templateWidthIn, 12);
    assert.equal(step.params.templateHeightIn, 24);
  });

  it("3: minimum safe inset is 0.125in, read from the single central policy figure", () => {
    assert.equal(SIGN_MINIMUM_SAFE_INSET_IN, 0.125);
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    const step = result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.equal(step.params.templateMinimumSafeInsetIn, SIGN_MINIMUM_SAFE_INSET_IN);
  });

  it("4: top/middle/bottom region identities are captured deterministically", () => {
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    const step = result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.equal(step.params.regionCount, 4);
    assert.equal(step.params.region0Role, "top_anchor");
    assert.equal(step.params.region1Role, "middle");
    assert.equal(step.params.region2Role, "middle");
    assert.equal(step.params.region3Role, "bottom_anchor");
    assert.equal(typeof step.params.region0Id, "string");
    assert.equal(typeof step.params.region1Id, "string");
    assert.notEqual(step.params.region0Id, step.params.region1Id);

    // Deterministic: re-planning the identical source produces IDENTICAL params.
    const again = planWithSegmentation(bannerSignArtwork(), 12, 24);
    const stepAgain = again.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.deepEqual(step.params, stepAgain.params);
  });

  it("5: source inter-region gap measurements are captured", () => {
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    const step = result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.equal(step.params.gapCount, 3);
    for (let i = 0; i < 3; i++) {
      assert.equal(typeof step.params[`gap${i}SourceHeightPx`], "number");
      assert.ok((step.params[`gap${i}SourceHeightPx`] as number) > 0);
      assert.equal(typeof step.params[`gap${i}FillColorR`], "number");
      assert.equal(typeof step.params[`gap${i}FillColorG`], "number");
      assert.equal(typeof step.params[`gap${i}FillColorB`], "number");
    }
  });

  it("6: rounded source decoration cannot change the production template, and reflow is preferred over the parametric-frame reconstruction it would otherwise trigger", () => {
    // Independently real evidence: a genuinely rounded, measured frame
    // model from ONE fixture, and a genuinely measured banner segmentation
    // from a DIFFERENT fixture — testing the planner's own precedence
    // logic as a pure function of its inputs, exactly like `sign-repair-
    // planner.test.ts` already isolates `hasFrameEvidence` from
    // `perimeterBands`. A real capability caller would measure both from
    // the SAME source image; this isolates which evidence WINS.
    const roundedFrame = framedSignArtwork({ width: 4000, height: 5333, rounded: true, withHoles: true });
    const frameStructuralModel = measureFrameStructuralModel(roundedFrame);
    assert.equal(frameStructuralModel.status, "measured");
    if (frameStructuralModel.status === "measured") {
      assert.ok((frameStructuralModel.model.cornerRadiusPx ?? 0) > 0);
    }

    const result = planWithSegmentation(bannerSignArtwork(), 12, 24, { frameStructuralModel });
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.ok(p.steps.some((step) => step.kind === "reflow_structural_layout"));
    assert.doesNotMatch(JSON.stringify(p.steps), /"kind":"reconstruct_parametric_frame"/);
    const step = p.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.equal(step.params.templateShape, "straight_rectangle");
  });

  it("7: ambiguous segmentation fails closed — blocked, never silently ignored or falling back to another repair", () => {
    const result = planWithSegmentation(ambiguousAdjacentFillArtwork(), 18, 36);
    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);
    assert.ok(
      result.defects.some((d) => d.code === "perimeter_structure_at_extension_edge" && d.severity === "blocking"),
    );
    assert.doesNotMatch(JSON.stringify(result), /reflow_structural_layout/);
  });

  it("8: insufficient fill evidence (no edge-reaching fill to extend to the cut edge) fails closed", () => {
    const result = planWithSegmentation(bannerSignEdgeContentArtwork(), 12, 24);
    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);
    assert.ok(
      result.defects.some(
        (d) => d.code === "perimeter_structure_at_extension_edge" && /edge-reaching fill/.test(d.detail),
      ),
    );
    assert.doesNotMatch(JSON.stringify(result), /reflow_structural_layout/);
  });

  it("9: a case with no eligible gap to redistribute into is rejected rather than requiring non-uniform scaling", () => {
    // Hand-built: two anchor regions, each with its own edge-reaching fill,
    // but NO measured gap between them. This shape cannot be solved by
    // translation + gap redistribution alone — the only ways to close the
    // extra ordered space would be to invent a gap (never generative) or
    // stretch meaningful content (never permitted) — so it must refuse.
    const image = bannerSignArtwork();
    const s = spec(12, 24);
    const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
    const handBuilt: SignStructuralLayoutSegmentationResult = {
      status: "measured",
      regions: [
        {
          id: "r0",
          sourceBounds: { startYPx: 0, heightPx: 200 },
          contentBounds: { startYPx: 50, heightPx: 100 },
          role: "top_anchor",
          fillColor: { r: 10, g: 10, b: 10 },
          fillEdgeReaching: true,
          expandable: true,
        },
        {
          id: "r1",
          sourceBounds: { startYPx: 200, heightPx: 200 },
          contentBounds: { startYPx: 250, heightPx: 100 },
          role: "bottom_anchor",
          fillColor: { r: 10, g: 10, b: 10 },
          fillEdgeReaching: true,
          expandable: true,
        },
      ],
      gaps: [],
      analysisWindow: null,
    };
    const result = planSignRepair({
      spec: s,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      inspection,
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      structuralLayoutSegmentation: handBuilt,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);
    assert.ok(
      result.defects.some(
        (d) => d.code === "perimeter_structure_at_extension_edge" && /no measured inter-region gap/.test(d.detail),
      ),
    );
  });

  it("10: the reflow step, and the resulting plan, are always review_required — never auto_safe, regardless of evidence strength", () => {
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    const step = result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.equal(step.risk, "review_required");
    assert.equal(result.plan!.overallRisk, "review_required");
    assert.ok(result.plan!.defects.includes("repair_requires_review"));
  });

  it("11: planKey changes when structural layout evidence (a gap's own measured height) materially changes", () => {
    const image = bannerSignArtwork();
    const s = spec(12, 24);
    const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
    const baseSegmentation = segmentStructuralLayout(image);
    assert.equal(baseSegmentation.status, "measured");
    if (baseSegmentation.status !== "measured") return;

    const a = planSignRepair({
      spec: s,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      inspection,
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      structuralLayoutSegmentation: baseSegmentation,
    });

    const changedSegmentation: SignStructuralLayoutSegmentationResult = {
      ...baseSegmentation,
      gaps: baseSegmentation.gaps.map((gap, i) => (i === 0 ? { ...gap, sourceHeightPx: gap.sourceHeightPx + 25 } : gap)),
    };
    const b = planSignRepair({
      spec: s,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      inspection,
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      structuralLayoutSegmentation: changedSegmentation,
    });

    assert.equal(a.status, "planned");
    assert.equal(b.status, "planned");
    assert.notEqual(a.plan!.planKey, b.plan!.planKey);
  });

  it("12: prior reconstruct_parametric_frame plans (no segmentation supplied) remain canonicalizable — unaffected by the new step kind", () => {
    const image = framedSignArtwork({ width: 4000, height: 5333, rounded: true, withHoles: true });
    const s = spec(24, 36);
    const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
    const frameStructuralModel = measureFrameStructuralModel(image);
    const result = planSignRepair({
      spec: s,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      inspection,
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      frameStructuralModel,
    });
    assert.equal(result.status, "planned");
    assert.ok(result.plan!.steps.some((step) => step.kind === "reconstruct_parametric_frame"));
    assert.ok(result.plan!.planKey.length > 0);
    const recomputed = computeSignPlanKey(result.plan!);
    assert.equal(recomputed, result.plan!.planKey);
  });

  it("13: the reflow planner path never references literal customer wording", () => {
    const result = planWithSegmentation(acceptanceBannerSignArtwork(), 24, 36);
    assert.equal(result.status, "planned");
    assert.doesNotMatch(JSON.stringify(result), /ATTENTION|INSPECT|DELIVERIES/i);
  });

  it("14: a reflow plan is never admitted for execution — the executor's own admission set excludes it", () => {
    const result = planWithSegmentation(bannerSignArtwork(), 12, 24);
    assert.equal(result.status, "planned");
    assert.ok(result.plan!.steps.some((step) => step.kind === "reflow_structural_layout"));
    assert.equal(planContainsOnlyAdmittedSteps(result.plan!), false);
  });

  it("structuralLayoutSegmentation absent -> unaffected, existing behaviour unchanged (falls through to frame-model/block as before)", () => {
    const image = framedSignArtwork({ width: 4000, height: 5333, rounded: true, withHoles: true });
    const s = spec(24, 36);
    const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
    const frameStructuralModel = measureFrameStructuralModel(image);
    const result = planSignRepair({
      spec: s,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      inspection,
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      frameStructuralModel,
      // No structuralLayoutSegmentation supplied at all.
    });
    assert.equal(result.status, "planned");
    assert.ok(result.plan!.steps.some((step) => step.kind === "reconstruct_parametric_frame"));
    assert.doesNotMatch(JSON.stringify(result.plan!.steps), /reflow_structural_layout/);
  });

  it("horizontal-axis mismatch never routes through structural reflow evidence, even when supplied — segmentation is vertical-axis only", () => {
    // bannerSignArtwork is 900x800 (aspect 1.125); ordering far WIDER than
    // that (e.g. 36x12, aspect 3.0) drives the mismatch onto the
    // HORIZONTAL axis instead, which segmentation has nothing to say about.
    const result = planWithSegmentation(bannerSignArtwork(), 36, 12);
    assert.equal(result.status, "planned");
    assert.doesNotMatch(JSON.stringify(result), /reflow_structural_layout/);
  });
});

/**
 * REAL ACCEPTANCE SHAPE TEST (synthetic only — never the real project, never
 * production DB state, never a provider call). `acceptanceBannerSignArtwork`
 * mirrors the real cc6cfc4b-... sign's own SOURCE pixel dimensions
 * (1086×1448) at its own ordered size (24×36in), but is a generic banner
 * layout — no customer wording, no customer geometry.
 */
describe("sign repair planner — real acceptance sign shape (synthetic)", () => {
  it("a banner-style fixture at the real 1086x1448 -> 24x36in scale produces a straight-rectangle reflow plan with top/bottom anchors, ordered middle regions, proportional gap data, the 0.125in safe inset, and no scaling permission", () => {
    const image = acceptanceBannerSignArtwork();
    const result = planWithSegmentation(image, 24, 36);
    assert.equal(result.status, "planned");
    const p = result.plan!;

    const step = p.steps.find((s) => s.kind === "reflow_structural_layout");
    assert.ok(step, "expected a reflow_structural_layout step");
    assert.equal(step!.params.templateShape, "straight_rectangle");
    assert.equal(step!.params.templateWidthIn, 24);
    assert.equal(step!.params.templateHeightIn, 36);
    assert.equal(step!.params.templateMinimumSafeInsetIn, 0.125);
    assert.equal(step!.params.scalingMode, "none");
    assert.equal(step!.params.layoutTransform, "translate_and_redistribute_gaps");

    const regionCount = step!.params.regionCount as number;
    assert.ok(regionCount >= 2);
    assert.equal(step!.params.region0Role, "top_anchor");
    assert.equal(step!.params[`region${regionCount - 1}Role`], "bottom_anchor");
    assert.ok((step!.params.gapCount as number) > 0);

    // Real project fact: low native PPI at this size needs reconstruction
    // TOO — proving reflow coexists with reconstruct_resolution, identical
    // to how reconstruct_parametric_frame already does (mirrors `sign-
    // repair-planner.test.ts`'s own "17" test for the same real geometry).
    const kinds = p.steps.map((s) => s.kind);
    assert.ok(kinds.includes("reconstruct_resolution"), `expected reconstruct_resolution in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("reflow_structural_layout"));
    assert.ok(kinds.indexOf("reconstruct_resolution") < kinds.indexOf("reflow_structural_layout"));

    // Straight rectangular target — expected output matches the ORDERED
    // aspect exactly, never the source's own rounded/decorative geometry.
    assert.ok(Math.abs(p.expectedOutputWidthPx / p.expectedOutputHeightPx - 24 / 36) < 0.001);
    assert.equal(p.overallRisk, "review_required");
    assert.doesNotMatch(JSON.stringify(p.steps), /"kind":"reconstruct_parametric_frame"/);
  });
});
