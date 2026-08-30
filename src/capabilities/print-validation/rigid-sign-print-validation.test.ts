import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPrintValidationCapability } from "./print-validation-capability";
import type { PrintValidationInput, RigidSignPlanEvidence } from "./contracts";
import {
  RIGID_RECT_UP_TO_24X36_V1,
  RIGID_SIGN_CATEGORY,
  deriveRigidSignProductionRequirements,
} from "@/capabilities/sign-preparation";

const printValidation = createPrintValidationCapability();

const REQUIREMENTS = deriveRigidSignProductionRequirements(
  {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn: 18,
    orderedHeightIn: 24,
    confirmedAt: "2026-08-30T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  },
  RIGID_RECT_UP_TO_24X36_V1,
);

function evidence(overrides: Partial<RigidSignPlanEvidence> = {}): RigidSignPlanEvidence {
  return {
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    planKey: "sign-repair-plan:v1:abc",
    planSchemaVersion: "sign-repair-plan:v1",
    policyId: RIGID_RECT_UP_TO_24X36_V1.id,
    planKeyVerified: true,
    executedStepsMatchPlan: true,
    planOverallRisk: "auto_safe",
    containsOnlyAdmittedSteps: true,
    orderedWidthIn: 18,
    orderedHeightIn: 24,
    targetPpi: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
    minPpi: RIGID_RECT_UP_TO_24X36_V1.minPpi,
    contentBoundsWithinOutput: true,
    contentBoundsReason: "content fully within bounds",
    ...overrides,
  };
}

function baseInput(overrides: Partial<PrintValidationInput> = {}): PrintValidationInput {
  return {
    artworkVersionId: "sign-preparation-1",
    validationProfile: "rigid_sign_raster",
    designBriefVersionId: null,
    currentApprovedDesignBriefVersionId: null,
    printPlacement: null,
    productSummary: null,
    designDescription: null,
    conceptEvaluationStatus: null,
    conceptEvaluation: null,
    primaryAsset: {
      contentType: "image/png",
      widthPx: 2754, // 153 PPI @ 18in
      heightPx: 3672, // 153 PPI @ 24in
      hasTransparency: false,
      vectorAssetId: null,
      resolutionProvenance: "native",
      nativeWidthPx: null,
      nativeHeightPx: null,
    },
    rigidSignRequirements: REQUIREMENTS,
    rigidSign: evidence(),
    ...overrides,
  };
}

describe("rigid_sign_raster print validation profile", () => {
  it("14: at or above target PPI, resolution check passes and the report is ready", () => {
    const report = printValidation.validateArtwork(baseInput());
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "pass");
    assert.equal(check?.severity, "blocking");
    assert.equal(report.status, "ready");
  });

  it("15: 100-149 PPI is a warning, not a blocker — plate still reaches ready", () => {
    // 18in @ 130 PPI = 2340px, 24in @ 130 PPI = 3120px.
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: "image/png",
          widthPx: 2340,
          heightPx: 3120,
          hasTransparency: false,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "warning");
    assert.equal(check?.severity, "warning");
    assert.equal(report.status, "ready");
    assert.ok(report.warnings.length > 0);
  });

  it("16: below 100 PPI blocks — never ready", () => {
    // 18in @ 80 PPI = 1440px, 24in @ 80 PPI = 1920px.
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: "image/png",
          widthPx: 1440,
          heightPx: 1920,
          hasTransparency: false,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "fail");
    assert.equal(check?.severity, "blocking");
    assert.equal(report.status, "finalization_required");
  });

  it("17: transparency blocks, and no colour is ever invented to pass it", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: "image/png",
          widthPx: 2754,
          heightPx: 3672,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "no_unintended_transparency");
    assert.equal(check?.status, "fail");
    assert.equal(check?.severity, "blocking");
    assert.equal(report.status, "finalization_required");
  });

  it("unknown transparency is never treated as opaque", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: "image/png",
          widthPx: 2754,
          heightPx: 3672,
          hasTransparency: null,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "no_unintended_transparency");
    assert.equal(check?.status, "unknown");
    assert.notEqual(report.status, "ready");
  });

  it("18: missing source lineage evidence is a hard block", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ sourceAssetId: "", sourceSha256: "" }) }),
    );
    const check = report.checks.find((c) => c.check === "source_lineage");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "blocked");
  });

  it("19: a missing repair plan is a hard block", () => {
    const report = printValidation.validateArtwork(baseInput({ rigidSign: null }));
    const check = report.checks.find((c) => c.check === "repair_plan_recorded");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "blocked");
  });

  it("20a: executed-plan identity failure (tamper) blocks", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ planKeyVerified: false }) }),
    );
    const check = report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("20b: a review_required plan never reaches ready — no unapproved review-class action may reach print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ planOverallRisk: "review_required" }) }),
    );
    const check = report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("Rule 1: a plan containing non-admitted steps never reaches ready even if otherwise well-formed", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ containsOnlyAdmittedSteps: false }) }),
    );
    const check = report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("Rule 1: provider-reconstructed pixels never reach ready — S4 preservation verification does not exist yet", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: "image/png",
          widthPx: 2754,
          heightPx: 3672,
          hasTransparency: false,
          vectorAssetId: null,
          resolutionProvenance: "reconstructed",
          nativeWidthPx: 1024,
          nativeHeightPx: 1365,
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("exact_physical_dimensions fails when the two axes do not independently reconcile", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: "image/png",
          widthPx: 2754,
          heightPx: 3000, // wrong aspect vs 18x24
          hasTransparency: false,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "exact_physical_dimensions");
    assert.equal(check?.status, "fail");
    assert.equal(report.status, "finalization_required");
  });

  it("content_within_bounds reflects the worker-measured fact", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ contentBoundsWithinOutput: false, contentBoundsReason: "out of bounds" }) }),
    );
    const check = report.checks.find((c) => c.check === "content_within_bounds");
    assert.equal(check?.status, "fail");
    assert.equal(check?.reason, "out of bounds");
    assert.equal(report.status, "finalization_required");
  });

  it("no apparel-specific checks are emitted under this profile", () => {
    const report = printValidation.validateArtwork(baseInput());
    const codes = report.checks.map((c) => c.check);
    for (const apparelOnly of [
      "transparency",
      "alpha_bound_artwork",
      "transparent_dead_canvas",
      "physical_width_policy",
      "halftone_treatment",
      "brief_provenance",
      "concept_evaluation_alignment",
      "required_wording_verification",
    ] as const) {
      assert.ok(!codes.includes(apparelOnly), `unexpected apparel check emitted: ${apparelOnly}`);
    }
  });

  it("missing asset is a hard block", () => {
    const report = printValidation.validateArtwork(baseInput({ primaryAsset: null }));
    assert.equal(report.status, "blocked");
    const check = report.checks.find((c) => c.check === "asset_exists");
    assert.equal(check?.status, "fail");
  });

  it("missing rigidSignRequirements is a hard block", () => {
    const report = printValidation.validateArtwork(baseInput({ rigidSignRequirements: null }));
    assert.equal(report.status, "blocked");
  });
});
