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

const EXPECTED_ALGORITHM_VERSION = "sign-preservation-combined:test-v1";

/**
 * A verification record matching every identity field `evidence()`'s
 * defaults assert against — the "everything lines up" case. Individual
 * tests override exactly one field to prove that ONE mismatch alone is
 * sufficient to fail closed.
 */
function preservationVerification(
  overrides: Partial<RigidSignPlanEvidence["preservationVerification"]> = {},
) {
  return {
    finalAssetId: "asset-final-1",
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    planKey: "sign-repair-plan:v1:abc",
    verificationAlgorithmVersion: EXPECTED_ALGORITHM_VERSION,
    status: "preserved" as const,
    ...overrides,
  };
}

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
    // LIVE PRODUCT BLOCKER #4B: the default fixture is a no-reconstruction
    // plan, so this stays false unless a test explicitly overrides it.
    planRequiresBoundedReconstruction: false,
    // LIVE PRODUCT BLOCKER #4D: the default fixture is an unmodified
    // replay, so this stays null unless a test explicitly overrides it.
    executedGeometryAdaptation: null,
    orderedWidthIn: 18,
    orderedHeightIn: 24,
    targetPpi: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
    minPpi: RIGID_RECT_UP_TO_24X36_V1.minPpi,
    contentBoundsWithinOutput: true,
    contentBoundsReason: "content fully within bounds",
    finalAssetId: "asset-final-1",
    // Fails closed by default — a native (non-reconstructed) plate never
    // reads this, and a reconstructed one must opt IN to evidence
    // explicitly (see the "Signs preservation → print_ready" suite below).
    preservationVerification: null,
    // Semantic Worker Wiring Phase: the default fixture's plan needs no
    // semantic verification, so this stays false unless a test explicitly
    // overrides it (every test that pairs `reconstructedAsset()` with this
    // helper does — see the "Signs preservation → print_ready" suite and
    // every other suite exercising a reconstructed plate below).
    planRequiresSemanticPreservationVerification: false,
    expectedPreservationAlgorithmVersion: EXPECTED_ALGORITHM_VERSION,
    // LIVE PRODUCT BLOCKER #4: matches the default `planKey`/`auto_safe`
    // above with a sufficient actor, so every PRE-EXISTING test in this
    // file (written before authorization existed) keeps meaning what it
    // always meant. Tests that specifically exercise authorization
    // override this explicitly (see the "Signs authorization → print_ready"
    // suite below).
    authorization: { planKey: "sign-repair-plan:v1:abc", authorizedBy: "customer" },
    // Signs Perimeter Safety Phase: the default fixture extended nothing
    // edge-dependent, so this stays trivially passing unless a test
    // explicitly overrides it (see the "Signs substrate boundary →
    // print_ready" suite below).
    substrateBoundary: { edgeDependentStructureOnAffectedEdge: false, perimeterAlignmentAnswer: null },
    // Signs Phase 3B (Fit to Production): the default fixture's plate
    // clears every edge's safe inset with generous, affirmatively measured
    // clearance, so this stays trivially passing unless a test explicitly
    // overrides it (see the "Signs Fit to Production -> print_ready" suite
    // below).
    fitToProduction: {
      safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
      achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      overallResult: "pass" as const,
      edges: (["top", "right", "bottom", "left"] as const).map((edge) => ({
        edge,
        requiredProtectedInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
        requiredProtectedInsetPx: 20,
        nearestProtectedContentPx: 200,
        nearestProtectedContentIn: 200 / RIGID_RECT_UP_TO_24X36_V1.targetPpi,
        violatingPositionPx: null,
        protectedResult: "pass" as const,
        edgeIntentPresent: false,
        edgeIntentNearestCutPx: null,
        edgeIntentAdvisory: false,
        unresolvedAmbiguousPresent: false,
        reason: "test fixture default — comfortably clear",
      })),
    },
    // SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION: the default
    // fixture never ran the QR check, so this stays `null` (never
    // evaluated — never a manufactured failure) unless a test explicitly
    // overrides it.
    machineReadableContent: null,
    ...overrides,
  };
}

function reconstructedAsset(
  overrides: Partial<PrintValidationInput["primaryAsset"]> = {},
) {
  return {
    contentType: "image/png",
    widthPx: 2754,
    heightPx: 3672,
    hasTransparency: false,
    vectorAssetId: null,
    resolutionProvenance: "reconstructed" as const,
    nativeWidthPx: 1024,
    nativeHeightPx: 1365,
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

  it("S3C review follow-up: executedStepsMatchPlan=false (the truthful value once execution geometry diverges from the recorded plan) blocks — and it is the ONLY channel through which the divergence can reach validation", () => {
    // `RigidSignPlanEvidence` has no `axis`/`colour`/`executionGeometry`
    // field at all (see the type in `./contracts`) — so even a compromised
    // or hand-edited `rigidSign.executionGeometry` blob on the asset's own
    // metadata has no way to reach the validator. The only channel through
    // which "the recorded plan and what actually executed differ" can move
    // this check is the single truthful boolean below.
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ executedStepsMatchPlan: false }) }),
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

  it("Rule 1: provider-reconstructed pixels with NO preservation evidence never reach ready (superseded by the Signs preservation suite below: reconstruction alone is no longer an automatic block once authoritative evidence exists)", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({ planRequiresSemanticPreservationVerification: true, preservationVerification: null }),
      }),
    );
    const check = report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
    assert.equal(check?.status, "fail");
    assert.match(check!.reason, /no authoritative record could be resolved/i);
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

/**
 * LIVE PRODUCT BLOCKER #3B: Signs preservation verification →
 * PrintValidation integration.
 *
 * The obsolete rule this replaces was "reconstructed === automatically
 * invalid". The new rule: reconstruction is acceptable ONLY when an
 * authoritative `SignPreservationVerification` — identity-bound to THIS
 * exact final asset, source, plan, and verification-algorithm — concluded
 * `"preserved"`. Every case below proves ONE way that authority can fail to
 * hold, and that failing in that one way alone is sufficient to refuse
 * readiness — never a bare `preservationPassed: true` shortcut.
 */
describe("Signs preservation → print_ready (LIVE PRODUCT BLOCKER #3B)", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
  }

  it("1: non-reconstructed valid output — existing behavior preserved, untouched by this phase", () => {
    const report = printValidation.validateArtwork(baseInput());
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("2: reconstructed + no preservation record → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({ planRequiresSemanticPreservationVerification: true, preservationVerification: null }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("3: reconstructed + status unknown → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({ status: "unknown" }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /concluded "unknown"/i);
    assert.notEqual(report.status, "ready");
  });

  it("4: reconstructed + status changed → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({ status: "changed" }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /concluded "changed"/i);
    assert.notEqual(report.status, "ready");
  });

  it("5: reconstructed + preserved but wrong final asset → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({
            finalAssetId: "some-other-asset",
          }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /does not match this exact asset/i);
    assert.notEqual(report.status, "ready");
  });

  it("6: reconstructed + preserved but wrong source → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({
            sourceAssetId: "some-other-source",
          }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("6b: reconstructed + preserved but wrong source sha256 → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({ sourceSha256: "b".repeat(64) }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("7: reconstructed + preserved but stale/wrong plan key → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({
            planKey: "sign-repair-plan:v1:superseded",
          }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("8: reconstructed + preserved but wrong algorithm/version → not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification({
            verificationAlgorithmVersion: "sign-preservation-combined:old-v0",
          }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("9: reconstructed + authoritative preserved evidence + auto_safe + every other check passes → eligible for print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification(),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("10: reconstructed + authoritative preserved evidence + review_required plan → STILL not print_ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          planOverallRisk: "review_required",
          preservationVerification: preservationVerification(),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /requires operator authorization/i);
    assert.notEqual(report.status, "ready");
    // This is the exact real-customer situation this phase must NOT change:
    // review_required stays refused regardless of how good the preservation
    // evidence is — that's a SEPARATE authority, not solved here.
  });

  it("12: preservation status can never be inferred from mere existence of a record — a record that DISAGREES (status !== preserved) still fails, even with every identity field matching", () => {
    for (const status of ["changed", "unknown"] as const) {
      const report = printValidation.validateArtwork(
        baseInput({
          primaryAsset: reconstructedAsset(),
          rigidSign: evidence({
            planRequiresSemanticPreservationVerification: true,
            preservationVerification: preservationVerification({ status }),
          }),
        }),
      );
      assert.equal(checkOf(report)?.status, "fail", `status=${status} must not pass`);
      assert.notEqual(report.status, "ready");
    }
  });

  it("a native (non-reconstructed) plate never reads preservationVerification at all — absent or garbage, it still passes on its own merits", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          preservationVerification: preservationVerification({ status: "changed" }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });
});

/**
 * LIVE PRODUCT BLOCKER #4: production-risk authorization → print_ready.
 * The counterpart to the preservation suite above — `riskAuthorized` is no
 * longer `planOverallRisk === "auto_safe"` alone; it requires an
 * identity-bound authorization whose actor is sufficient for the plan's
 * own risk class. Uses only NATIVE (non-reconstructed) assets throughout,
 * so preservation evidence never enters into these results — isolating
 * exactly what this phase changed.
 */
describe("Signs authorization → print_ready (LIVE PRODUCT BLOCKER #4)", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
  }

  it("11: auto_safe + valid authorization (customer) → riskAuthorized", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          planOverallRisk: "auto_safe",
          authorization: { planKey: "sign-repair-plan:v1:abc", authorizedBy: "customer" },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("11b: auto_safe + valid authorization (operator) → riskAuthorized — operator is sufficient for every risk class", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          planOverallRisk: "auto_safe",
          authorization: { planKey: "sign-repair-plan:v1:abc", authorizedBy: "operator" },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("12: review_required + valid operator authorization → riskAuthorized", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          planOverallRisk: "review_required",
          authorization: { planKey: "sign-repair-plan:v1:abc", authorizedBy: "operator" },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("13: review_required + customer authorization → fails — a customer action alone is never sufficient for a review-class plan", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          planOverallRisk: "review_required",
          authorization: { planKey: "sign-repair-plan:v1:abc", authorizedBy: "customer" },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /not sufficient/i);
    assert.notEqual(report.status, "ready");
  });

  it("14a: missing authorization → fails", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ authorization: null }) }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /no production-risk authorization was found/i);
    assert.notEqual(report.status, "ready");
  });

  it("14b: stale/wrong-plan authorization → fails, even though the actor type alone would have been sufficient", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          planOverallRisk: "auto_safe",
          authorization: { planKey: "sign-repair-plan:v1:SUPERSEDED", authorizedBy: "operator" },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /does not match this exact plan/i);
    assert.notEqual(report.status, "ready");
  });

  it("blocked risk can never be authorized by any actor", () => {
    for (const authorizedBy of ["customer", "operator"] as const) {
      const report = printValidation.validateArtwork(
        baseInput({
          rigidSign: evidence({
            planOverallRisk: "blocked",
            authorization: { planKey: "sign-repair-plan:v1:abc", authorizedBy },
          }),
        }),
      );
      assert.equal(checkOf(report)?.status, "fail", `authorizedBy=${authorizedBy} must not pass`);
      assert.notEqual(report.status, "ready");
    }
  });

  it("THIS REAL CUSTOMER's exact situation: reconstructed + review_required + no authorization + no preservation evidence — refused on every independent ground at once", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          planOverallRisk: "review_required",
          authorization: null,
          preservationVerification: null,
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });
});

/**
 * LIVE PRODUCT BLOCKER #4B: `planIntegrityOk` used to require
 * `containsOnlyAdmittedSteps` alone — and any plan needing bounded
 * provider reconstruction has `containsOnlyAdmittedSteps === false` by
 * construction (`reconstruct_resolution` is never S2-admitted), so no
 * such plan could ever reach `"ready"`, no matter how well reconstruction
 * or preservation went. Every test ABOVE that exercises `reconstructedAsset()`
 * relies on `evidence()`'s default `containsOnlyAdmittedSteps: true` — a
 * combination the REAL worker never actually produces for a reconstructed
 * asset (that field is computed independently of `resolutionProvenance`,
 * and is genuinely `false` whenever any `reconstruct_resolution` step
 * exists) — so none of them, before this fix, actually proved a REALISTIC
 * reconstruction could ever reach ready. These do, with the realistic
 * `containsOnlyAdmittedSteps: false` a genuine worker run sends.
 */
describe("Signs reconstruction plan-integrity (LIVE PRODUCT BLOCKER #4B)", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
  }

  it("realistic reconstruction shape (containsOnlyAdmittedSteps: false, planRequiresBoundedReconstruction: true) + preserved → ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          containsOnlyAdmittedSteps: false,
          planRequiresBoundedReconstruction: true,
          preservationVerification: preservationVerification(),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass", "the fix: a genuinely preserved, S3A-shaped reconstruction now passes");
    assert.equal(report.status, "ready");
  });

  it("NOT the S3A-admitted shape (containsOnlyAdmittedSteps: false, planRequiresBoundedReconstruction: false) → still never ready, even preserved", () => {
    // The negative proof this fix is narrowly scoped: some OTHER
    // unrecognized non-admitted step shape (e.g. `approved_crop`, or a
    // plan a future build no longer recognizes) is never silently admitted
    // just because a preservation record happens to say "preserved".
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          containsOnlyAdmittedSteps: false,
          planRequiresBoundedReconstruction: false,
          preservationVerification: preservationVerification(),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("realistic reconstruction shape, but preservation not preserved → still not ready — the fix does not weaken the preservation gate", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          containsOnlyAdmittedSteps: false,
          planRequiresBoundedReconstruction: true,
          preservationVerification: preservationVerification({ status: "unknown" }),
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("a plan needing NO reconstruction at all (containsOnlyAdmittedSteps: true) is unaffected by this fix — unchanged, still ready", () => {
    const report = printValidation.validateArtwork(baseInput());
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });
});

/**
 * LIVE PRODUCT BLOCKER #4D: `executedStepsMatchPlan` is `false` whenever a
 * real reconstruction-provider result diverged (proportionally) from the
 * plan's own requested reconstruction size and the geometry step's pixel
 * amounts were re-derived (Signs Phase S3C). This suite proves the SEPARATE,
 * independently-verified `executedGeometryAdaptation` path this phase adds —
 * never a trusted "the adaptation was valid" claim, and never a general
 * escape hatch for anything OTHER than a genuine, kind/axis/fill-preserving
 * pixel-amount re-derivation.
 */
describe("Signs S3C adaptive-geometry plan-integrity (LIVE PRODUCT BLOCKER #4D)", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "executed_plan_matches_recorded_plan");
  }

  const plannedPadStep = {
    kind: "pad_uniform_background",
    axis: "vertical",
    colorR: 251,
    colorG: 252,
    colorB: 252,
    color: null,
  };

  function adaptedInput(overrides: {
    executedGeometryAdaptation: NonNullable<RigidSignPlanEvidence["executedGeometryAdaptation"]>;
  }) {
    return baseInput({
      primaryAsset: reconstructedAsset(),
      rigidSign: evidence({
        planRequiresSemanticPreservationVerification: true,
        executedStepsMatchPlan: false,
        containsOnlyAdmittedSteps: false,
        planRequiresBoundedReconstruction: true,
        preservationVerification: preservationVerification(),
        ...overrides,
      }),
    });
  }

  it("proportional oversized reconstruction + step identity preserved + preserved → ready (the fix)", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344, // exactly 2x the requested, both axes — proportional
          plannedStep: plannedPadStep,
          executedStep: plannedPadStep, // identical kind/axis/fill — only pixel amounts (not carried here) differ
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("NO adaptation evidence at all (executedGeometryAdaptation: null) while executedStepsMatchPlan is false → still fails — this is not a general escape hatch", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          executedStepsMatchPlan: false,
          containsOnlyAdmittedSteps: false,
          planRequiresBoundedReconstruction: true,
          preservationVerification: preservationVerification(),
          executedGeometryAdaptation: null,
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("materially non-proportional (distorted) reconstruction → fails even with everything else aligned", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896, // 2x
          reconstructionActualHeightPx: 6000, // ~1.63x — over 10% off from 2x
          plannedStep: plannedPadStep,
          executedStep: plannedPadStep,
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("executed step KIND differs from the planned step (e.g. an unapproved crop substituted in) → fails", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344,
          plannedStep: plannedPadStep,
          executedStep: { ...plannedPadStep, kind: "approved_crop" },
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("executed step AXIS differs from the planned step → fails", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344,
          plannedStep: plannedPadStep,
          executedStep: { ...plannedPadStep, axis: "horizontal" },
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("executed step FILL colour differs from the planned step → fails", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344,
          plannedStep: plannedPadStep,
          executedStep: { ...plannedPadStep, colorR: 0, colorG: 0, colorB: 0 },
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("plannedStep present but executedStep null (inconsistent presence) → fails", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344,
          plannedStep: plannedPadStep,
          executedStep: null,
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("both plannedStep and executedStep null (bare reconstruction, no geometry step on either side), proportional → ready", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344,
          plannedStep: null,
          executedStep: null,
        },
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("review_required + adapted geometry + NO operator authorization → still refused (Blocker #4's gate is untouched)", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          executedStepsMatchPlan: false,
          containsOnlyAdmittedSteps: false,
          planRequiresBoundedReconstruction: true,
          planOverallRisk: "review_required",
          authorization: null,
          preservationVerification: preservationVerification(),
          executedGeometryAdaptation: {
            reconstructionRequestedWidthPx: 2448,
            reconstructionRequestedHeightPx: 3672,
            reconstructionActualWidthPx: 4896,
            reconstructionActualHeightPx: 7344,
            plannedStep: plannedPadStep,
            executedStep: plannedPadStep,
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("adapted geometry + preservation status 'changed' → still refused (Blocker #3B's gate is untouched)", () => {
    const report = printValidation.validateArtwork(
      adaptedInput({
        executedGeometryAdaptation: {
          reconstructionRequestedWidthPx: 2448,
          reconstructionRequestedHeightPx: 3672,
          reconstructionActualWidthPx: 4896,
          reconstructionActualHeightPx: 7344,
          plannedStep: plannedPadStep,
          executedStep: plannedPadStep,
        },
      }),
    );
    // Sanity re-check with preservation swapped to "changed".
    const changedReport = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          executedStepsMatchPlan: false,
          containsOnlyAdmittedSteps: false,
          planRequiresBoundedReconstruction: true,
          preservationVerification: preservationVerification({ status: "changed" }),
          executedGeometryAdaptation: {
            reconstructionRequestedWidthPx: 2448,
            reconstructionRequestedHeightPx: 3672,
            reconstructionActualWidthPx: 4896,
            reconstructionActualHeightPx: 7344,
            plannedStep: plannedPadStep,
            executedStep: plannedPadStep,
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass", "sanity: the preserved control case still passes");
    assert.equal(checkOf(changedReport)?.status, "fail");
    assert.notEqual(changedReport.status, "ready");
  });
});

/**
 * Signs Perimeter Safety Phase (real incident: project cc6cfc4b-..., where
 * every check above passed — dimensions, PPI, opacity, content bounds,
 * ordinary semantic preservation, crop checks, plan authorization — while a
 * geometry-extension repair still pushed edge-relative artwork away from
 * the finished substrate edge it depended on). Defense in depth: this check
 * must independently refuse `print_ready` even when planning itself has a
 * future bug that admits such a repair anyway.
 */
describe("Signs substrate boundary → print_ready (Perimeter Safety Phase)", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "substrate_boundary_semantics");
  }

  it("K: no edge-dependent structure on any extended edge — passes trivially, existing behavior unaffected", () => {
    const report = printValidation.validateArtwork(baseInput());
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("edge-dependent structure present, but no semantic verification of the finished-edge relationship exists at all → fails closed", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: null,
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /no semantic verification/i);
    assert.notEqual(report.status, "ready");
  });

  it("edge-dependent structure present, semantic verification concluded 'changed' → fails", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: "changed",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /concluded "changed"/i);
    assert.notEqual(report.status, "ready");
  });

  it("edge-dependent structure present, semantic verification 'cannot_determine' → fails (an inconclusive answer never authorizes)", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: "cannot_determine",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("I: edge-dependent structure present, semantic verification affirmatively 'same' → passes this specific check", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: "same",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("edge-dependent structure present, semantic verification 'not_applicable' → also passes (the element genuinely does not depend on the edge after all)", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: "not_applicable",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("J: fails Print Ready even when EVERY other check passes — dimensions, PPI, opacity, content bounds, ordinary preservation, plan authorization all green", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: reconstructedAsset(),
        rigidSign: evidence({
          planRequiresSemanticPreservationVerification: true,
          preservationVerification: preservationVerification(),
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: "cannot_determine",
          },
        }),
      }),
    );
    // Sanity: every OTHER blocking check genuinely passed.
    for (const other of [
      "exact_physical_dimensions",
      "effective_resolution",
      "no_unintended_transparency",
      "content_within_bounds",
      "executed_plan_matches_recorded_plan",
      "repair_plan_recorded",
      "source_lineage",
    ]) {
      const check = report.checks.find((c) => c.check === other);
      assert.ok(check, `expected a "${other}" check to exist`);
      assert.equal(check!.status, "pass", `"${other}" was expected to pass in this control scenario`);
    }
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready", "the false-positive shape this phase exists to close");
  });

  it("12: a plan using ONLY reconstruct_perimeter_structure (no reconstruct_resolution) reaches ready once every other check — including substrate boundary — passes; PrintValidation's checks are step-kind-agnostic by design", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          containsOnlyAdmittedSteps: true,
          planRequiresBoundedReconstruction: false,
          substrateBoundary: {
            edgeDependentStructureOnAffectedEdge: true,
            perimeterAlignmentAnswer: "same",
          },
        }),
      }),
    );
    assert.equal(report.status, "ready");
  });
});

/**
 * Signs Phase 3B (Fit to Production, Section J — "the most important
 * requirement"): `protected_content_safe_inset` — the blocking gate that
 * makes Print Ready impossible when protected content violates the
 * physical SAFE inset from any CUT edge, and confirms a BLEED field
 * genuinely reaching the cut edge is never itself a failure.
 */
describe("Signs Fit to Production → print_ready (Section J)", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "protected_content_safe_inset");
  }

  function passingEdge(edge: "top" | "right" | "bottom" | "left") {
    return {
      edge,
      requiredProtectedInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
      requiredProtectedInsetPx: 20,
      nearestProtectedContentPx: 200,
      nearestProtectedContentIn: 200 / RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      violatingPositionPx: null,
      protectedResult: "pass" as const,
      edgeIntentPresent: false,
      edgeIntentNearestCutPx: null,
      edgeIntentAdvisory: false,
      unresolvedAmbiguousPresent: false,
      reason: "comfortably clear",
    };
  }

  function failingEdge(edge: "top" | "right" | "bottom" | "left", nearestProtectedContentPx: number) {
    return {
      edge,
      requiredProtectedInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
      requiredProtectedInsetPx: 20,
      nearestProtectedContentPx,
      nearestProtectedContentIn: nearestProtectedContentPx / RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      violatingPositionPx: 42,
      protectedResult: "fail" as const,
      edgeIntentPresent: false,
      edgeIntentNearestCutPx: null,
      edgeIntentAdvisory: false,
      unresolvedAmbiguousPresent: true,
      reason: "too close to the cut edge",
    };
  }

  function unknownEdge(edge: "top" | "right" | "bottom" | "left") {
    return {
      edge,
      requiredProtectedInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
      requiredProtectedInsetPx: 20,
      nearestProtectedContentPx: null,
      nearestProtectedContentIn: null,
      violatingPositionPx: null,
      protectedResult: "unknown" as const,
      edgeIntentPresent: false,
      edgeIntentNearestCutPx: null,
      edgeIntentAdvisory: false,
      unresolvedAmbiguousPresent: false,
      reason: "no provable bleed colour",
    };
  }

  it("every edge clears the safe inset — passes, compliant candidate reaches ready", () => {
    const report = printValidation.validateArtwork(baseInput());
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("READY is impossible when protected content violates the safe inset on even one edge — every other check still passing", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "fail",
            edges: [passingEdge("top"), passingEdge("right"), failingEdge("bottom", 5), passingEdge("left")],
          },
        }),
      }),
    );
    for (const other of [
      "exact_physical_dimensions",
      "effective_resolution",
      "no_unintended_transparency",
      "content_within_bounds",
      "executed_plan_matches_recorded_plan",
    ]) {
      const check = report.checks.find((c) => c.check === other);
      assert.equal(check!.status, "pass", `"${other}" was expected to pass in this control scenario`);
    }
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /bottom/);
    assert.notEqual(report.status, "ready");
  });

  it("READY is impossible when an edge could not be affirmatively measured at all ('unknown' fails closed, never silently treated as safe)", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "unknown",
            edges: [passingEdge("top"), passingEdge("right"), passingEdge("bottom"), unknownEdge("left")],
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.notEqual(report.status, "ready");
  });

  it("no Fit to Production evidence at all (never measured) fails closed — never silently treated as pass", () => {
    const report = printValidation.validateArtwork(
      baseInput({ rigidSign: evidence({ fitToProduction: null }) }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.match(checkOf(report)!.reason, /No Fit to Production/i);
    assert.notEqual(report.status, "ready");
  });

  it("a BLEED field genuinely reaching the cut edge is never itself a failure — only non-bleed content too close is", () => {
    // nearestProtectedContentPx comfortably beyond the required inset on every
    // edge, even though the field itself (bleed) touches row/column 0 —
    // this evidence shape is exactly what a correctly-composed banner
    // background produces; it must read as pass, not as a violation.
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "pass",
            edges: [passingEdge("top"), passingEdge("right"), passingEdge("bottom"), passingEdge("left")],
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });
});

describe("Edge-Intent Correction Phase: edge_intent_advisory (Section I) + protected/ambiguous distinction (Section D/M)", () => {
  function advisoryCheckOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "edge_intent_advisory");
  }
  function safeInsetCheckOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "protected_content_safe_inset");
  }

  function passingEdgeNoIntent(edge: "top" | "right" | "bottom" | "left") {
    return {
      edge,
      requiredProtectedInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
      requiredProtectedInsetPx: 20,
      nearestProtectedContentPx: 200,
      nearestProtectedContentIn: 200 / RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      violatingPositionPx: null,
      protectedResult: "pass" as const,
      edgeIntentPresent: false,
      edgeIntentNearestCutPx: null,
      edgeIntentAdvisory: false,
      unresolvedAmbiguousPresent: false,
      reason: "comfortably clear, no edge artwork",
    };
  }

  function passingEdgeWithIntent(edge: "top" | "right" | "bottom" | "left") {
    return {
      ...passingEdgeNoIntent(edge),
      edgeIntentPresent: true,
      edgeIntentNearestCutPx: 0,
      edgeIntentAdvisory: true,
      reason: "clears the inset; a governed edge-intent border was present and excluded from measurement",
    };
  }

  it("edge_intent_advisory is always present, status pass/info, and never contributes to overall status", () => {
    const report = printValidation.validateArtwork(baseInput());
    const advisory = advisoryCheckOf(report);
    assert.ok(advisory);
    assert.equal(advisory?.status, "pass");
    assert.equal(advisory?.severity, "info");
  });

  it("no edge-intent artwork present -> advisory reports none, plate still reaches ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "pass",
            edges: [passingEdgeNoIntent("top"), passingEdgeNoIntent("right"), passingEdgeNoIntent("bottom"), passingEdgeNoIntent("left")],
          },
        }),
      }),
    );
    assert.match(advisoryCheckOf(report)!.reason, /No governed edge-intent artwork/i);
    assert.equal(report.status, "ready");
  });

  it("EDGE_INTENT alone (present, but clearance still passes) does NOT block READY — the advisory is informational only", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "pass",
            edges: [passingEdgeWithIntent("top"), passingEdgeWithIntent("right"), passingEdgeNoIntent("bottom"), passingEdgeNoIntent("left")],
          },
        }),
      }),
    );
    assert.equal(safeInsetCheckOf(report)?.status, "pass");
    assert.equal(advisoryCheckOf(report)?.status, "pass");
    assert.match(advisoryCheckOf(report)!.reason, /top, right/);
    assert.equal(report.status, "ready", "edge-intent presence alone must never block READY");
  });

  it("unresolved AMBIGUOUS_REVIEW content (unclassified, too close) still blocks READY exactly like PROTECTED_CONTENT", () => {
    const ambiguousEdge = {
      ...passingEdgeNoIntent("left"),
      protectedResult: "fail" as const,
      nearestProtectedContentPx: 5,
      nearestProtectedContentIn: 5 / RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      violatingPositionPx: 10,
      unresolvedAmbiguousPresent: true,
      reason: "too close, never classified",
    };
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "fail",
            edges: [passingEdgeNoIntent("top"), passingEdgeNoIntent("right"), passingEdgeNoIntent("bottom"), ambiguousEdge],
          },
        }),
      }),
    );
    assert.equal(safeInsetCheckOf(report)?.status, "fail");
    assert.match(safeInsetCheckOf(report)!.reason, /unresolved ambiguous review/i);
    assert.notEqual(report.status, "ready");
  });

  it("acknowledged PROTECTED_CONTENT too close ALSO blocks READY — an operator acknowledgment is not a pass", () => {
    const protectedEdge = {
      ...passingEdgeNoIntent("left"),
      protectedResult: "fail" as const,
      nearestProtectedContentPx: 5,
      nearestProtectedContentIn: 5 / RIGID_RECT_UP_TO_24X36_V1.targetPpi,
      violatingPositionPx: 10,
      unresolvedAmbiguousPresent: false,
      reason: "too close, explicitly acknowledged as protected content",
    };
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          fitToProduction: {
            safeInsetIn: RIGID_RECT_UP_TO_24X36_V1.minimumSafeInsetIn,
            achievedPpiX: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            achievedPpiY: RIGID_RECT_UP_TO_24X36_V1.targetPpi,
            overallResult: "fail",
            edges: [passingEdgeNoIntent("top"), passingEdgeNoIntent("right"), passingEdgeNoIntent("bottom"), protectedEdge],
          },
        }),
      }),
    );
    assert.equal(safeInsetCheckOf(report)?.status, "fail");
    assert.match(safeInsetCheckOf(report)!.reason, /acknowledged protected content/i);
    assert.notEqual(report.status, "ready");
  });
});

describe("SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION → print_ready", () => {
  function checkOf(report: ReturnType<typeof printValidation.validateArtwork>) {
    return report.checks.find((c) => c.check === "machine_readable_content_preserved");
  }

  it("machineReadableContent: null (never evaluated) pushes NO check at all — never a manufactured failure", () => {
    const report = printValidation.validateArtwork(baseInput());
    assert.equal(checkOf(report), undefined);
    // Every other control check still passes, and the run still reaches ready.
    assert.equal(report.status, "ready");
  });

  it("overallResult 'pass': the check passes, ready is reachable", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          machineReadableContent: {
            regions: [{ id: "qr-1", kind: "qr", sourceDecodable: true, candidateDecodable: true, result: "pass" }],
            overallResult: "pass",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(checkOf(report)?.severity, "blocking");
    assert.equal(report.status, "ready");
  });

  it("overallResult 'not_applicable' (no QR at all): the check passes trivially, never treated as a failure", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          machineReadableContent: { regions: [], overallResult: "not_applicable" },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "pass");
    assert.equal(report.status, "ready");
  });

  it("overallResult 'fail' (source decoded, candidate unreadable): BLOCKS ready — every other check still passing", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          machineReadableContent: {
            regions: [{ id: "qr-1", kind: "qr", sourceDecodable: true, candidateDecodable: false, result: "fail" }],
            overallResult: "fail",
          },
        }),
      }),
    );
    for (const other of [
      "exact_physical_dimensions",
      "effective_resolution",
      "no_unintended_transparency",
      "content_within_bounds",
      "protected_content_safe_inset",
      "executed_plan_matches_recorded_plan",
    ]) {
      const check = report.checks.find((c) => c.check === other);
      assert.equal(check!.status, "pass", `"${other}" was expected to pass in this control scenario`);
    }
    assert.equal(checkOf(report)?.status, "fail");
    assert.equal(checkOf(report)?.severity, "blocking");
    assert.notEqual(report.status, "ready");
  });

  it("overallResult 'hard_fail' (candidate decodes a DIFFERENT payload): BLOCKS ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          machineReadableContent: {
            regions: [{ id: "qr-1", kind: "qr", sourceDecodable: true, candidateDecodable: true, result: "hard_fail" }],
            overallResult: "hard_fail",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "fail");
    assert.equal(checkOf(report)?.severity, "blocking");
    assert.notEqual(report.status, "ready");
  });

  it("overallResult 'review_required' (source not reliably decodable): surfaced, but does NOT block ready by itself — Section R's own exact scoping", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          machineReadableContent: {
            regions: [{ id: "qr-1", kind: "qr", sourceDecodable: false, candidateDecodable: false, result: "review_required" }],
            overallResult: "review_required",
          },
        }),
      }),
    );
    assert.equal(checkOf(report)?.status, "warning");
    assert.equal(checkOf(report)?.severity, "warning");
    // A non-blocking severity must not, by itself, prevent ready when every blocking check passes.
    assert.equal(report.status, "ready");
  });

  it("the check's reason never includes a decoded payload — internal rationale only, never the raw QR content", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        rigidSign: evidence({
          machineReadableContent: {
            regions: [{ id: "qr-1", kind: "qr", sourceDecodable: true, candidateDecodable: true, result: "hard_fail" }],
            overallResult: "hard_fail",
          },
        }),
      }),
    );
    assert.doesNotMatch(checkOf(report)!.reason, /https?:\/\//);
  });
});
