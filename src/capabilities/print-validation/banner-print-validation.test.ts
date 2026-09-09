import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPrintValidationCapability } from "./print-validation-capability";
import type { PrintValidationAssetSummary, PrintValidationInput, RigidSignPlanEvidence } from "./contracts";
import {
  BANNER_CATEGORY,
  BANNER_RECT_UP_TO_36X96_V1,
  deriveRigidSignProductionRequirements,
} from "@/capabilities/sign-preparation";

/**
 * Banner Production Profile (Constitution amendment 3.3, §16A-bis):
 * `banner_raster` reuses `validateRigidSign` (the SAME shared validator
 * rigid_sign_raster uses, profile-parameterized) — never a duplicated
 * validator. This file proves the dispatch works and that Banner's OWN,
 * lower resolution thresholds (72 target / 50 minimum PPI, vs rigid's
 * 150/100) are what actually govern under this profile — never rigid's
 * figures borrowed by accident. Every OTHER check (exact dimensions, no
 * stretch, transparency policy, QR/machine-readable integrity, candidate-
 * bound acceptance, plan/authorization identity, substrate boundary) is
 * the identical shared logic already exhaustively proven correct for
 * rigid_sign_raster in `rigid-sign-print-validation.test.ts` — not
 * re-derived here, since it is the SAME code path, not a second one.
 */

const printValidation = createPrintValidationCapability();

const REQUIREMENTS = deriveRigidSignProductionRequirements(
  {
    category: BANNER_CATEGORY,
    orderedWidthIn: 84,
    orderedHeightIn: 24,
    confirmedAt: "2026-09-08T12:00:00.000Z",
    resolutionPolicyId: BANNER_RECT_UP_TO_36X96_V1.id,
  },
  BANNER_RECT_UP_TO_36X96_V1,
);

function evidence(overrides: Partial<RigidSignPlanEvidence> = {}): RigidSignPlanEvidence {
  return {
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    planKey: "sign-repair-plan:v1:banner-abc",
    planSchemaVersion: "sign-repair-plan:v1",
    policyId: BANNER_RECT_UP_TO_36X96_V1.id,
    planKeyVerified: true,
    executedStepsMatchPlan: true,
    planOverallRisk: "auto_safe",
    containsOnlyAdmittedSteps: true,
    planRequiresBoundedReconstruction: false,
    executedGeometryAdaptation: null,
    orderedWidthIn: 84,
    orderedHeightIn: 24,
    targetPpi: BANNER_RECT_UP_TO_36X96_V1.targetPpi,
    minPpi: BANNER_RECT_UP_TO_36X96_V1.minPpi,
    contentBoundsWithinOutput: true,
    contentBoundsReason: "content fully within bounds",
    finalAssetId: "asset-final-1",
    preservationVerification: null,
    planRequiresSemanticPreservationVerification: false,
    expectedPreservationAlgorithmVersion: "sign-preservation-combined:test-v1",
    authorization: { planKey: "sign-repair-plan:v1:banner-abc", authorizedBy: "customer" },
    substrateBoundary: { edgeDependentStructureOnAffectedEdge: false, perimeterAlignmentAnswer: null },
    fitToProduction: {
      safeInsetIn: BANNER_RECT_UP_TO_36X96_V1.minimumSafeInsetIn,
      achievedPpiX: BANNER_RECT_UP_TO_36X96_V1.targetPpi,
      achievedPpiY: BANNER_RECT_UP_TO_36X96_V1.targetPpi,
      overallResult: "pass" as const,
      edges: (["top", "right", "bottom", "left"] as const).map((edge) => ({
        edge,
        requiredProtectedInsetIn: BANNER_RECT_UP_TO_36X96_V1.minimumSafeInsetIn,
        requiredProtectedInsetPx: 9,
        nearestProtectedContentPx: 200,
        nearestProtectedContentIn: 200 / BANNER_RECT_UP_TO_36X96_V1.targetPpi,
        violatingPositionPx: null,
        protectedResult: "pass" as const,
        edgeIntentPresent: false,
        edgeIntentNearestCutPx: null,
        edgeIntentAdvisory: false,
        unresolvedAmbiguousPresent: false,
        reason: "test fixture default — comfortably clear",
      })),
    },
    machineReadableContent: { regions: [], overallResult: "not_applicable" },
    // 84x24in @ 72 PPI: round(72 * 39.3700787402) = 2835.
    deliveredPhysicalDensity: { pixelsPerMetreX: 2835, pixelsPerMetreY: 2835 },
    ...overrides,
  };
}

function assetAt(widthPx: number, heightPx: number): PrintValidationAssetSummary {
  return {
    contentType: "image/png",
    widthPx,
    heightPx,
    hasTransparency: false,
    vectorAssetId: null,
    resolutionProvenance: "native",
    nativeWidthPx: null,
    nativeHeightPx: null,
  };
}

function baseInput(overrides: Partial<PrintValidationInput> = {}): PrintValidationInput {
  return {
    artworkVersionId: "sign-preparation-banner-1",
    validationProfile: "banner_raster",
    designBriefVersionId: null,
    currentApprovedDesignBriefVersionId: null,
    printPlacement: null,
    productSummary: null,
    designDescription: null,
    conceptEvaluationStatus: null,
    conceptEvaluation: null,
    primaryAsset: assetAt(6048, 1728), // 84x24in @ 72 PPI — the real customer case, at target
    rigidSignRequirements: REQUIREMENTS,
    rigidSign: evidence(),
    ...overrides,
  };
}

describe("banner_raster print validation profile: dispatches to the SAME shared validator, with Banner's OWN thresholds", () => {
  it("REAL CUSTOMER CASE: 84x24in @ 72 PPI (target) → ready", () => {
    const report = printValidation.validateArtwork(baseInput());
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("between 50 and 72 PPI is a warning, not a blocker — Banner's own target/minimum, not rigid's 150/100", () => {
    // 84in @ 60 PPI = 5040px, 24in @ 60 PPI = 1440px.
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: assetAt(5040, 1440),
        rigidSign: evidence({ deliveredPhysicalDensity: { pixelsPerMetreX: 2362, pixelsPerMetreY: 2362 } }),
      }),
    );
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "warning");
    assert.equal(report.status, "ready");
  });

  it("below 50 PPI blocks — Banner's own minimum, never treated as satisfying rigid's higher one or vice versa", () => {
    // 84in @ 40 PPI = 3360px, 24in @ 40 PPI = 960px.
    const report = printValidation.validateArtwork(baseInput({ primaryAsset: assetAt(3360, 960) }));
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("a resolution that would satisfy rigid's 100 PPI minimum but is examined under banner_raster is judged by Banner's own 50/72 figures, not rigid's", () => {
    // 60 PPI is below rigid's minPpi (100) but comfortably a Banner warning, not a Banner fail.
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: assetAt(5040, 1440),
        rigidSign: evidence({ deliveredPhysicalDensity: { pixelsPerMetreX: 2362, pixelsPerMetreY: 2362 } }),
      }),
    );
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.notEqual(check?.status, "fail");
  });

  it("exact 3.5:1 physical dimensions required — a stretched/wrong-aspect asset still fails closed under Banner", () => {
    const report = printValidation.validateArtwork(
      baseInput({ primaryAsset: assetAt(6048, 2000) }), // wrong aspect vs 84x24
    );
    const check = report.checks.find((c) => c.check === "exact_physical_dimensions");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("transparency policy is unchanged under Banner: KEEP still blocks transparency, opaque intent preserved", () => {
    const report = printValidation.validateArtwork(
      baseInput({ primaryAsset: { ...assetAt(6048, 1728), hasTransparency: true } }),
    );
    const check = report.checks.find((c) => c.check === "no_unintended_transparency");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("candidate-bound acceptance (plan/authorization identity) is the identical shared rule: stale/wrong-plan authorization fails", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          authorization: { planKey: "sign-repair-plan:v1:SUPERSEDED", authorizedBy: "operator" },
        }),
      }),
    );
    const check = report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(check?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("no apparel-specific checks are emitted under banner_raster either", () => {
    const report = printValidation.validateArtwork(baseInput());
    const codes = report.checks.map((c) => c.check);
    for (const apparelOnly of [
      "transparency",
      "alpha_bound_artwork",
      "transparent_dead_canvas",
      "physical_width_policy",
      "halftone_treatment",
    ] as const) {
      assert.ok(!codes.includes(apparelOnly), `unexpected apparel check emitted: ${apparelOnly}`);
    }
  });
});
