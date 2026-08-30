import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { SignProductionSpec, SignRepairPlan } from "./contracts";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { inspectSignArtwork } from "./sign-inspection";
import { computeSignPlanKey } from "./sign-plan-identity";
import { planSignRepair } from "./sign-repair-planner";
import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  transparentSignArtwork,
  uniformBackgroundSignArtwork,
} from "./sign-fixtures";

function spec(orderedWidthIn: number, orderedHeightIn: number): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-08-30T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function plan(
  image: RgbaImage,
  orderedWidthIn: number,
  orderedHeightIn: number,
  sha256 = "a".repeat(64),
) {
  const s = spec(orderedWidthIn, orderedHeightIn);
  const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
  return planSignRepair({
    spec: s,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: sha256,
  });
}

describe("sign repair planner", () => {
  it("1: exact aspect + sufficient resolution → no unnecessary repair", () => {
    // 1800×2400 at 12×16in = exactly 150 PPI.
    const result = plan(exactAspectSignArtwork(1800, 2400), 12, 16);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.deepEqual(p.steps, []);
    assert.equal(p.overallRisk, "auto_safe");
    assert.equal(p.expectedOutputWidthPx, 1800);
    assert.equal(p.expectedOutputHeightPx, 2400);
    assert.ok(Math.abs(p.expectedEffectivePpi - 150) < 0.01);
  });

  it("2: exact aspect + low resolution → bounded reconstruction proposed, nothing else", () => {
    // 900×1200 at 18×24in = 50 PPI → 3× to target, ×1.02 headroom.
    const result = plan(exactAspectSignArtwork(900, 1200), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.equal(p.steps.length, 1);
    assert.equal(p.steps[0]!.kind, "reconstruct_resolution");
    assert.equal(p.steps[0]!.risk, "auto_safe");
    assert.equal(p.steps[0]!.params.requestedWidthPx, 2754);
    assert.equal(p.steps[0]!.params.requestedHeightPx, 3672);
    assert.equal(p.expectedOutputWidthPx, 2754);
    assert.equal(p.expectedOutputHeightPx, 3672);
    assert.equal(p.overallRisk, "auto_safe");
  });

  it("3: aspect mismatch with provably uniform background edges → deterministic extension, AUTO_SAFE", () => {
    // 1000×1500 (2:3) on 18×24 (3:4): contain 16×24 @62.5 PPI.
    const result = plan(uniformBackgroundSignArtwork(1000, 1500), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.deepEqual(
      p.steps.map((step) => step.kind),
      ["reconstruct_resolution", "extend_uniform_background"],
    );
    const extend = p.steps[1]!;
    assert.equal(extend.risk, "auto_safe");
    assert.equal(extend.params.axis, "horizontal");
    // Measured background continues — near-black, never an invented colour.
    assert.ok(Math.abs((extend.params.colorR as number) - 6) <= 2);
    assert.equal(p.overallRisk, "auto_safe");
    assert.equal(p.expectedOutputWidthPx, 2754);
    assert.equal(p.expectedOutputHeightPx, 3672);
  });

  it("4: Ruth-shaped mismatch — foreground reaches the extension edges → REVIEW_REQUIRED, exact audit math", () => {
    const result = plan(ruthLikeSignArtwork(), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;

    // Reconstruct first (provider never sees a synthetic seam), then fill.
    assert.deepEqual(
      p.steps.map((step) => step.kind),
      ["reconstruct_resolution", "pad_uniform_background"],
    );
    const reconstruct = p.steps[0]!;
    // (150/64) × 1.02 headroom = 2.390625
    assert.ok(
      Math.abs((reconstruct.params.requestedScale as number) - 2.390625) < 1e-9,
    );
    assert.equal(reconstruct.params.requestedWidthPx, 2448);
    assert.equal(reconstruct.params.requestedHeightPx, 3672);

    const pad = p.steps[1]!;
    assert.equal(pad.risk, "review_required");
    assert.equal(pad.params.axis, "horizontal");
    assert.equal(pad.params.leadingPx, 153);
    assert.equal(pad.params.trailingPx, 153);

    assert.equal(p.expectedOutputWidthPx, 2754);
    assert.equal(p.expectedOutputHeightPx, 3672);
    assert.ok(Math.abs(p.expectedEffectivePpi - 153) < 0.01);
    assert.equal(p.overallRisk, "review_required");
    assert.ok(p.defects.includes("foreground_reaches_extension_edge"));
    assert.ok(p.defects.includes("repair_requires_review"));
  });

  it("5: fill/crop is never AUTO_SAFE and the planner never emits approved_crop on its own", () => {
    const ruth = plan(ruthLikeSignArtwork(), 18, 24);
    const uniform = plan(uniformBackgroundSignArtwork(1000, 1500), 18, 24);
    for (const result of [ruth, uniform]) {
      assert.equal(result.status, "planned");
      assert.ok(
        result.plan!.steps.every((step) => step.kind !== "approved_crop"),
        "approved_crop must never be auto-planned",
      );
      // The crop alternative is diagnosed explicitly instead.
      assert.ok(
        result.defects.some((defect) => defect.code === "meaningful_crop_required"),
      );
    }
  });

  it("8: transparent source → diagnosed for opaque sign production and escalated to review", () => {
    const result = plan(transparentSignArtwork(600, 800), 18, 24);
    assert.equal(result.status, "planned");
    assert.ok(
      result.defects.some(
        (defect) => defect.code === "transparency_present" && defect.severity === "review",
      ),
    );
    assert.equal(result.plan!.overallRisk, "review_required");
  });

  it("9: below minimum but within the admitted ceiling → a plan is produced", () => {
    // 62.5 PPI < 100 minimum; 2.448× requested — well inside 4×.
    const result = plan(uniformBackgroundSignArtwork(1000, 1500), 18, 24);
    assert.equal(result.status, "planned");
    assert.ok(
      result.defects.some((defect) => defect.code === "resolution_below_minimum"),
    );
  });

  it("10: a need beyond the admitted reconstruction ceiling is BLOCKED before any dispatch could exist", () => {
    // 300×400 at 18×24 = 16.7 PPI; even 4× ≈ 66.7 PPI < 100 minimum.
    const result = plan(exactAspectSignArtwork(300, 400), 18, 24);
    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);
    assert.ok(
      result.defects.some(
        (defect) =>
          defect.code === "reconstruction_exceeds_supported_scale" &&
          defect.severity === "blocking",
      ),
    );
  });

  it("rotate: a 90°-matching source gets a review-required rotation, never an automatic one", () => {
    // 1200×900 landscape; rotated 900×1200 matches 3:4 exactly.
    const result = plan(exactAspectSignArtwork(1200, 900), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.equal(p.steps[0]!.kind, "rotate_90");
    assert.equal(p.steps[0]!.risk, "review_required");
    assert.equal(p.overallRisk, "review_required");
  });

  it("oversized source → deterministic downsample, AUTO_SAFE", () => {
    // 3600×4800 at 12×16in = 300 PPI → downsample to the 150 PPI target.
    const result = plan(exactAspectSignArtwork(3600, 4800), 12, 16);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.deepEqual(p.steps.map((step) => step.kind), ["downsample"]);
    assert.equal(p.steps[0]!.params.targetWidthPx, 1800);
    assert.equal(p.steps[0]!.params.targetHeightPx, 2400);
    assert.equal(p.overallRisk, "auto_safe");
  });
});

describe("canonical plan identity", () => {
  const baseImage = uniformBackgroundSignArtwork(1000, 1500);

  it("11: changing the ordered dimensions changes the plan key", () => {
    const a = plan(baseImage, 18, 24);
    const b = plan(baseImage, 18, 30);
    assert.equal(a.status, "planned");
    assert.equal(b.status, "planned");
    assert.notEqual(a.plan!.planKey, b.plan!.planKey);
  });

  it("12: changing the source bytes changes the plan key", () => {
    const a = plan(baseImage, 18, 24, "a".repeat(64));
    const b = plan(baseImage, 18, 24, "b".repeat(64));
    assert.notEqual(a.plan!.planKey, b.plan!.planKey);
  });

  it("13: identity is stable across recomputation and cosmetic serialization order", () => {
    const a = plan(baseImage, 18, 24);
    const b = plan(baseImage, 18, 24);
    assert.equal(a.plan!.planKey, b.plan!.planKey);

    // Same plan, params objects built in a different insertion order.
    const p = a.plan as SignRepairPlan;
    const shuffledSteps = p.steps.map((step) => {
      const keys = Object.keys(step.params).reverse();
      const params: Record<string, number | string> = {};
      for (const key of keys) params[key] = step.params[key]!;
      return { ...step, params };
    });
    const rekeyed = computeSignPlanKey({ ...p, steps: shuffledSteps });
    assert.equal(rekeyed, p.planKey);

    // Rationale and risk are gating/explanation, not identity.
    const reworded = computeSignPlanKey({
      ...p,
      steps: p.steps.map((step) => ({
        ...step,
        risk: "review_required" as const,
        reasons: ["different words"],
      })),
    });
    assert.equal(reworded, p.planKey);
  });
});
