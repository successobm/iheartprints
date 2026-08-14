import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArtworkVersion, ConceptEvaluation } from "@/lib/domain/types";
import { toCustomerArtworkVersion } from "@/capabilities/shared/contracts";

import { createPrintValidationCapability } from "./print-validation-capability";
import {
  calculateEffectiveResolution,
  minimumRasterDimensionsFor,
} from "./effective-resolution";
import { classifyProduction, deriveProductionRequirements } from "./production-requirements";
import { targetDimensionsForPlacement } from "@/capabilities/shared/print-placement-dimensions";
import type {
  PrintValidationInput,
  ProductionNormalizationSummary,
} from "./contracts";

function conceptEvaluation(
  overrides: Partial<ConceptEvaluation> = {},
): ConceptEvaluation {
  return {
    overallScore: 90,
    passed: true,
    confidence: 90,
    criteria: [
      {
        key: "required_wording",
        score: 100,
        passed: true,
        confidence: 90,
        notes: null,
      },
    ],
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
    ...overrides,
  };
}

function baseInput(overrides: Partial<PrintValidationInput> = {}): PrintValidationInput {
  return {
    artworkVersionId: "artwork-1",
    designBriefVersionId: "brief-v1",
    currentApprovedDesignBriefVersionId: "brief-v1",
    printPlacement: "full_back",
    productSummary: "T-shirt",
    designDescription: "A bear mascot",
    conceptEvaluationStatus: "passed",
    conceptEvaluation: conceptEvaluation(),
    primaryAsset: {
      contentType: "image/png",
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      vectorAssetId: null,
      resolutionProvenance: "native",
      nativeWidthPx: 1024,
      nativeHeightPx: 1024,
    },
    ...overrides,
  };
}

/**
 * A correctly normalized full-back plate: 10.5in x 11.25in at 300 PPI
 * (3150x3375px), trimmed tight to its artwork with only the small
 * artwork-edge safety margin around it.
 */
function normalizedFullBackInput(
  overrides: {
    input?: Partial<PrintValidationInput>;
    normalization?: Partial<ProductionNormalizationSummary>;
    asset?: Partial<NonNullable<PrintValidationInput["primaryAsset"]>>;
  } = {},
): PrintValidationInput {
  return baseInput({
    printPlacement: "full_back",
    primaryAsset: {
      contentType: "image/png",
      widthPx: 3150,
      heightPx: 3375,
      hasTransparency: true,
      vectorAssetId: null,
      resolutionProvenance: "reconstructed",
      nativeWidthPx: 1024,
      nativeHeightPx: 1024,
      ...overrides.asset,
    },
    productionNormalization: {
      strategy: "width_constrained_preserve_aspect",
      alphaBBoxWidthPx: 3100,
      alphaBBoxHeightPx: 3320,
      trimmedWidthPx: 3128,
      trimmedHeightPx: 3352,
      artworkOccupancy: (3100 * 3320) / (3128 * 3352),
      targetWidthIn: 10.5,
      widthToleranceIn: 0.05,
      targetPpi: 300,
      intendedWidthIn: 10.5,
      intendedHeightIn: 11.25,
      constrainedBy: "width",
      densityPixelsPerMetre: 11811,
      ...overrides.normalization,
    },
    ...overrides.input,
  });
}

describe("PrintValidationCapability — normalized production plates (Print-Ready Normalization Phase 1)", () => {
  const printValidation = createPrintValidationCapability();

  // --- N: a correctly normalized plate validates ready ----------------------
  it("N: a plate trimmed to its artwork at 10.5in x 300 PPI validates ready", () => {
    const report = printValidation.validateArtwork(normalizedFullBackInput());

    assert.equal(report.status, "ready");
    assert.deepEqual(report.blockingIssues, []);
    for (const check of [
      "production_normalization",
      "alpha_bound_artwork",
      "transparent_dead_canvas",
      "physical_width_policy",
      "aspect_ratio_preserved",
      "effective_resolution",
      "minimum_raster_dimensions",
    ]) {
      assert.equal(report.checks.find((c) => c.check === check)?.status, "pass", check);
    }
  });

  // --- L: effective resolution is measured against intended physical size ---
  it("L: effective resolution is pixels ÷ intended inches, and 3150px over 10.5in is exactly 300 PPI", () => {
    const report = printValidation.validateArtwork(normalizedFullBackInput());
    const check = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(check?.status, "pass");
    assert.match(check!.reason, /~300 PPI/);
  });

  it("a plate sized below the target PPI fails effective_resolution", () => {
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({
        asset: { widthPx: 1575, heightPx: 1688 },
        normalization: { intendedWidthIn: 10.5, intendedHeightIn: 11.25 },
      }),
    );
    assert.equal(
      report.checks.find((c) => c.check === "effective_resolution")?.status,
      "fail",
    );
    assert.notEqual(report.status, "ready");
  });

  it("a wide plate is never failed for having fewer pixels than the placement ENVELOPE demands", () => {
    // 10.5in x 5.25in at 300 PPI — legitimately only 1575px tall, far below
    // the envelope's 4200px, and completely correct.
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({
        asset: { widthPx: 3150, heightPx: 1575 },
        normalization: {
          alphaBBoxWidthPx: 3120,
          alphaBBoxHeightPx: 1550,
          trimmedWidthPx: 3136,
          trimmedHeightPx: 1568,
          artworkOccupancy: (3120 * 1550) / (3136 * 1568),
          intendedWidthIn: 10.5,
          intendedHeightIn: 5.25,
        },
      }),
    );
    assert.equal(report.status, "ready");
    assert.equal(
      report.checks.find((c) => c.check === "minimum_raster_dimensions")?.status,
      "pass",
    );
  });

  // --- M: excessive transparent dead canvas fails --------------------------
  it("M: a plate that is mostly transparent dead canvas fails validation", () => {
    // The audited live shape: 2662x2861 of artwork inside a 3600x4200 plate.
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({
        asset: { widthPx: 3600, heightPx: 4200 },
        normalization: {
          alphaBBoxWidthPx: 2662,
          alphaBBoxHeightPx: 2861,
          trimmedWidthPx: 3600,
          trimmedHeightPx: 4200,
          artworkOccupancy: (2662 * 2861) / (3600 * 4200),
          intendedWidthIn: 12,
          intendedHeightIn: 14,
        },
      }),
    );

    assert.notEqual(report.status, "ready");
    const deadCanvas = report.checks.find((c) => c.check === "transparent_dead_canvas");
    assert.equal(deadCanvas?.status, "fail");
    assert.match(deadCanvas!.reason, /dead canvas/i);
    assert.ok(report.requiredTransformations.includes("resize_to_final_dimensions"));
  });

  it("the small artwork-edge safety margin never trips the dead-canvas rule", () => {
    const report = printValidation.validateArtwork(normalizedFullBackInput());
    assert.equal(
      report.checks.find((c) => c.check === "transparent_dead_canvas")?.status,
      "pass",
    );
  });

  it("a plate with no meaningful alpha-bound artwork fails", () => {
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({
        normalization: { alphaBBoxWidthPx: 4, alphaBBoxHeightPx: 4 },
      }),
    );
    assert.equal(
      report.checks.find((c) => c.check === "alpha_bound_artwork")?.status,
      "fail",
    );
    assert.notEqual(report.status, "ready");
  });

  // --- H/I: physical width policy, with an explicit tolerance ---------------
  it("H/I: a plate printed at the placement's 10.5in target width passes the width policy", () => {
    const report = printValidation.validateArtwork(normalizedFullBackInput());
    assert.equal(
      report.checks.find((c) => c.check === "physical_width_policy")?.status,
      "pass",
    );
  });

  it("width policy uses an explicit tolerance rather than exact equality", () => {
    const within = printValidation.validateArtwork(
      normalizedFullBackInput({ normalization: { intendedWidthIn: 10.53 } }),
    );
    assert.equal(
      within.checks.find((c) => c.check === "physical_width_policy")?.status,
      "pass",
    );

    const outside = printValidation.validateArtwork(
      normalizedFullBackInput({ normalization: { intendedWidthIn: 12 } }),
    );
    assert.equal(
      outside.checks.find((c) => c.check === "physical_width_policy")?.status,
      "fail",
    );
  });

  it("a tall artwork honestly reduced to the printable height passes the width policy", () => {
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({
        asset: { widthPx: 1050, heightPx: 4200 },
        normalization: {
          alphaBBoxWidthPx: 1030,
          alphaBBoxHeightPx: 4170,
          trimmedWidthPx: 1046,
          trimmedHeightPx: 4184,
          artworkOccupancy: (1030 * 4170) / (1046 * 4184),
          intendedWidthIn: 3.5,
          intendedHeightIn: 14,
          constrainedBy: "max_height",
        },
      }),
    );
    const check = report.checks.find((c) => c.check === "physical_width_policy");
    assert.equal(check?.status, "pass");
    assert.match(check!.reason, /printable height/i);
  });

  // --- G: aspect ratio preservation ----------------------------------------
  it("G: aspect ratio preserved through trim + resize passes; a distorted plate fails", () => {
    const preserved = printValidation.validateArtwork(normalizedFullBackInput());
    assert.equal(
      preserved.checks.find((c) => c.check === "aspect_ratio_preserved")?.status,
      "pass",
    );

    const stretched = printValidation.validateArtwork(
      normalizedFullBackInput({
        // Trimmed artwork was square, but the plate is 10.5 x 11.25 — squashed.
        normalization: { trimmedWidthPx: 3200, trimmedHeightPx: 3200 },
      }),
    );
    const check = stretched.checks.find((c) => c.check === "aspect_ratio_preserved");
    assert.equal(check?.status, "fail");
    assert.match(check!.reason, /distorted/i);
    assert.notEqual(stretched.status, "ready");
  });

  it("recorded pixel dimensions must agree with the recorded physical specification", () => {
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({ asset: { widthPx: 2000, heightPx: 3375 } }),
    );
    const check = report.checks.find((c) => c.check === "production_normalization");
    assert.equal(check?.status, "fail");
    assert.match(check!.reason, /resized after normalization/i);
  });

  // --- Density metadata is recorded, never authoritative --------------------
  it("density metadata agreeing with 300 PPI is recorded as an informational pass", () => {
    const report = printValidation.validateArtwork(normalizedFullBackInput());
    const check = report.checks.find((c) => c.check === "density_metadata");
    assert.equal(check?.status, "pass");
    assert.equal(check?.severity, "info");
  });

  it("a plate with a WRONG density tag but correct pixel geometry is still ready — metadata never overrides geometry", () => {
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({ normalization: { densityPixelsPerMetre: 2835 } }), // ~72 PPI
    );
    assert.equal(report.status, "ready", "pixel geometry remains authoritative");
    const check = report.checks.find((c) => c.check === "density_metadata");
    assert.equal(check?.status, "warning");
    assert.equal(check?.severity, "info");
  });

  it("a plate with a CORRECT density tag but insufficient pixels is never ready — metadata never substitutes for geometry", () => {
    const report = printValidation.validateArtwork(
      normalizedFullBackInput({
        asset: { widthPx: 1050, heightPx: 1125 },
        normalization: { densityPixelsPerMetre: 11811 },
      }),
    );
    assert.notEqual(report.status, "ready");
  });

  it("provisional concept validation is unaffected — no production checks are emitted", () => {
    const report = printValidation.validateArtwork(baseInput());
    for (const check of [
      "production_normalization",
      "alpha_bound_artwork",
      "transparent_dead_canvas",
      "physical_width_policy",
      "aspect_ratio_preserved",
      "density_metadata",
    ]) {
      assert.equal(
        report.checks.find((c) => c.check === check),
        undefined,
        `${check} must not appear for a concept that was never normalized`,
      );
    }
  });
});

describe("PrintValidationCapability — Upscaling Truthfulness (Sprint 2M Phase 2C)", () => {
  const printValidation = createPrintValidationCapability();

  it("an interpolated-upscale asset never passes effective_resolution merely because its file dimensions look big enough", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "full_back",
        primaryAsset: {
          contentType: "image/png",
          // File dimensions exactly match the 3600x4200 target...
          widthPx: 3600,
          heightPx: 4200,
          hasTransparency: true,
          vectorAssetId: null,
          // ...but they were manufactured by interpolation from a much
          // smaller real source — the check must judge against the native
          // dimensions, not the enlarged file.
          resolutionProvenance: "interpolated_upscale",
          nativeWidthPx: 1024,
          nativeHeightPx: 1024,
        },
      }),
    );

    assert.notEqual(report.status, "ready");
    const resolutionCheck = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(resolutionCheck?.status, "fail");
    const minDimensionsCheck = report.checks.find(
      (c) => c.check === "minimum_raster_dimensions",
    );
    assert.equal(minDimensionsCheck?.status, "fail");
  });

  it("a native-resolution asset whose pixels already meet the target validates ready with zero fabricated detail", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "sleeve",
        primaryAsset: {
          contentType: "image/png",
          widthPx: 1024,
          heightPx: 1024,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: 1024,
          nativeHeightPx: 1024,
        },
      }),
    );

    assert.equal(report.status, "ready");
  });

  it("unknown resolution provenance is treated conservatively — never assumed native", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "full_back",
        primaryAsset: {
          contentType: "image/png",
          widthPx: 3600,
          heightPx: 4200,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "unknown",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );

    assert.notEqual(report.status, "ready");
    const resolutionCheck = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(resolutionCheck?.status, "unknown");
  });

  // Sprint 2M Phase 2E: genuine provider-side reconstruction (Topaz
  // Transparency Upscale) is real, provider-manufactured detail — never
  // fabricated local interpolation — so it is trusted exactly like
  // "native", not penalized down to the tiny pre-reconstruction source.
  it("a reconstructed asset is trusted like native — genuine provider detail is never penalized down to the pre-reconstruction source size", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "full_back",
        primaryAsset: {
          contentType: "image/png",
          // The final production canvas — distinct from both the true
          // 1024x1024 source and the provider's 4096x4096 reconstruction.
          widthPx: 3600,
          heightPx: 4200,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "reconstructed",
          nativeWidthPx: 1024,
          nativeHeightPx: 1024,
        },
      }),
    );

    assert.equal(report.status, "ready");
    const resolutionCheck = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(resolutionCheck?.status, "pass");
    const minDimensionsCheck = report.checks.find(
      (c) => c.check === "minimum_raster_dimensions",
    );
    assert.equal(minDimensionsCheck?.status, "pass");
    const provenanceCheck = report.checks.find((c) => c.check === "resolution_provenance");
    assert.equal(provenanceCheck?.status, "pass");
  });
});

describe("PrintValidationCapability (Sprint 2M Phase 1)", () => {
  const printValidation = createPrintValidationCapability();

  // --- Goal 14 Scenario A --------------------------------------------------
  it("A: a real ~1024x1024 concept intended for a large full-back DTF print is finalization_required, not ready", () => {
    const report = printValidation.validateArtwork(baseInput());

    assert.equal(report.status, "finalization_required");
    const resolutionCheck = report.checks.find((c) => c.check === "effective_resolution");
    assert.equal(resolutionCheck?.status, "fail");
    assert.ok(report.requiredTransformations.includes("regenerate_at_production_dimensions"));
    assert.ok(report.requiredTransformations.includes("upscale_raster_artwork"));
  });

  // --- Goal 14 Scenario B --------------------------------------------------
  it("B: a small left-chest DTF concept with sufficient raster dimensions can be ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "left_chest",
        primaryAsset: {
          contentType: "image/png",
          widthPx: 1536,
          heightPx: 1536,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: 1536,
          nativeHeightPx: 1536,
        },
      }),
    );

    assert.equal(report.status, "ready");
    assert.deepEqual(report.requiredTransformations, []);
    assert.deepEqual(report.blockingIssues, []);
  });

  // --- Goal 14 Scenario C --------------------------------------------------
  it("C: an opaque PNG where transparency is required is finalization_required", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "left_chest",
        primaryAsset: {
          contentType: "image/png",
          widthPx: 1536,
          heightPx: 1536,
          hasTransparency: false,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: 1536,
          nativeHeightPx: 1536,
        },
      }),
    );

    assert.equal(report.status, "finalization_required");
    const transparencyCheck = report.checks.find((c) => c.check === "transparency");
    assert.equal(transparencyCheck?.status, "fail");
    assert.ok(report.requiredTransformations.includes("remove_background"));
  });

  // --- Goal 14 Scenario D --------------------------------------------------
  // Sprint A2 rewrote D and E. They previously asserted the defect this
  // sprint removed: naming a decoration method pushed an ordinary garment
  // design onto a vector deliverable nothing produces, so the customer's
  // raster artwork could never be finalized. Mentioning screen printing or
  // embroidery is now decoration CONTEXT and changes no requirement.
  it("D: a screen-print MENTION is decoration context — the raster profile and its requirements are unchanged", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        productSummary: "Screen printed T-shirt",
        designDescription: "Bold team logo",
      }),
    );

    assert.equal(report.requirements.category, "apparel_raster");
    // The method is still recorded — it is useful to know — it simply does
    // not select the artifact.
    assert.equal(report.requirements.printMethod, "screen_print");
    assert.equal(report.requirements.requestedUnsupportedOutput, null);
    assert.equal(report.requirements.requiredOutputType, "raster");
    assert.deepEqual(report.requirements.allowedFileFormats, ["png"]);
    const vectorCheck = report.checks.find((c) => c.check === "vector_source");
    assert.equal(vectorCheck?.status, "pass");
    assert.ok(!report.requiredTransformations.includes("create_vector_version"));

    // Byte-for-byte the same requirements as the identical brief without the
    // method word — the strongest statement that the mention changed nothing.
    const withoutMention = printValidation.validateArtwork(
      baseInput({
        productSummary: "T-shirt",
        designDescription: "Bold team logo",
      }),
    );
    assert.equal(report.status, withoutMention.status);
    assert.deepEqual(
      report.requirements.minRasterDimensionsPx,
      withoutMention.requirements.minRasterDimensionsPx,
    );
    assert.deepEqual(report.requirements.sizing, withoutMention.requirements.sizing);
  });

  // --- Goal 14 Scenario E --------------------------------------------------
  it("E: an embroidery MENTION keeps the raster profile, and never claims embroidery readiness", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        productSummary: "Embroidered cap",
        designDescription: "Small crest logo",
        printPlacement: null,
      }),
    );

    assert.equal(report.requirements.category, "apparel_raster");
    assert.equal(report.requirements.printMethod, "embroidery");
    assert.equal(report.requirements.requestedUnsupportedOutput, null);
    assert.equal(report.requirements.requiredOutputType, "raster");
    const vectorCheck = report.checks.find((c) => c.check === "vector_source");
    assert.equal(vectorCheck?.status, "pass");

    // Honesty: the deliverable is a raster design artifact. Nothing in the
    // report may describe it as digitized or embroidery-ready.
    const trail = [...report.requirements.notes, ...report.blockingIssues, ...report.warnings].join(" ");
    assert.ok(!/digitiz/i.test(trail));
    assert.ok(!/embroidery[\s-]?ready/i.test(trail));
    assert.ok(/decoration context only \(embroidery\)/i.test(trail));
  });

  // --- Goal 14 Scenario F --------------------------------------------------
  // Sprint A2: a vinyl banner is not an apparel production profile awaiting
  // implementation — it is a different product category, outside scope.
  it("F: a banner is out of product scope, not a signage production job", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        productSummary: "Vinyl banner",
        designDescription: "Grand opening banner",
        printPlacement: null,
      }),
    );

    assert.equal(report.requirements.category, "out_of_scope_product");
    // `blocked`, not `finalization_required`: there is no amount of
    // finalization work that turns this into something iHeartPrints makes.
    assert.equal(report.status, "blocked");
    assert.equal(
      report.checks.find((c) => c.check === "product_scope")?.status,
      "fail",
    );
    // No deliverable is described for it, in any format.
    assert.deepEqual(report.requirements.allowedFileFormats, []);
    assert.equal(report.requirements.targetDimensions, null);
    assert.equal(report.requirements.sizing, null);
    // It never enters a vector/signage production pipeline.
    assert.ok(!report.requiredTransformations.includes("convert_fonts_to_outlines"));
    assert.ok(!report.requiredTransformations.includes("resize_to_final_dimensions"));
  });

  // --- Goal 14 Scenario G --------------------------------------------------
  it("G: a missing asset is blocked", () => {
    const report = printValidation.validateArtwork(
      baseInput({ primaryAsset: null }),
    );

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.some((issue) => /no generated asset/i.test(issue)));
  });

  // --- Goal 14 Scenario H --------------------------------------------------
  it("H: a concept from an obsolete approved brief version is blocked", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        designBriefVersionId: "brief-v1",
        currentApprovedDesignBriefVersionId: "brief-v2",
      }),
    );

    assert.equal(report.status, "blocked");
    const provenanceCheck = report.checks.find((c) => c.check === "brief_provenance");
    assert.equal(provenanceCheck?.status, "fail");
  });

  it("H2: a concept with no recorded brief version at all is blocked", () => {
    const report = printValidation.validateArtwork(
      baseInput({ designBriefVersionId: null }),
    );

    assert.equal(report.status, "blocked");
  });

  // --- Goal 14 Scenario I --------------------------------------------------
  it("I: a required-wording mismatch already identified by Concept Evaluation is never production-ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "left_chest",
        primaryAsset: {
          contentType: "image/png",
          widthPx: 1536,
          heightPx: 1536,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: 1536,
          nativeHeightPx: 1536,
        },
        conceptEvaluation: conceptEvaluation({
          criteria: [
            {
              key: "required_wording",
              score: 20,
              passed: false,
              confidence: 90,
              notes: "Wording missing",
            },
          ],
        }),
      }),
    );

    assert.notEqual(report.status, "ready");
    assert.equal(report.status, "finalization_required");
    const wordingCheck = report.checks.find(
      (c) => c.check === "required_wording_verification",
    );
    assert.equal(wordingCheck?.status, "fail");
    assert.ok(report.requiredTransformations.includes("verify_or_recreate_text"));
  });

  it("I2: a concept that failed Concept Evaluation is never production-ready", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        printPlacement: "left_chest",
        primaryAsset: {
          contentType: "image/png",
          widthPx: 1536,
          heightPx: 1536,
          hasTransparency: true,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: 1536,
          nativeHeightPx: 1536,
        },
        conceptEvaluationStatus: "failed",
      }),
    );

    assert.notEqual(report.status, "ready");
    assert.ok(report.requiredTransformations.includes("require_human_review"));
  });

  // --- Goal 14 Scenario J --------------------------------------------------
  it("J: unknown asset metadata never fabricates a pass — always unknown/finalization_required", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        primaryAsset: {
          contentType: null,
          widthPx: null,
          heightPx: null,
          hasTransparency: null,
          vectorAssetId: null,
          resolutionProvenance: "native",
          nativeWidthPx: null,
          nativeHeightPx: null,
        },
      }),
    );

    assert.notEqual(report.status, "ready");
    assert.equal(report.status, "finalization_required");
    for (const code of [
      "content_type",
      "raster_dimensions_known",
      "transparency",
      "effective_resolution",
      "minimum_raster_dimensions",
    ] as const) {
      const check = report.checks.find((c) => c.check === code);
      assert.notEqual(check?.status, "pass", `${code} must not silently pass`);
    }
  });

  // --- Determinism / immutability -----------------------------------------
  it("is deterministic for the same input", () => {
    const input = baseInput();
    const first = printValidation.validateArtwork(input);
    const second = printValidation.validateArtwork(input);

    const strip = (r: typeof first) => {
      const rest: Partial<typeof r> = { ...r };
      delete rest.evaluatedAt;
      return rest;
    };
    assert.deepEqual(strip(first), strip(second));
  });

  it("never mutates its input", () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    printValidation.validateArtwork(input);
    assert.deepEqual(input, snapshot);
  });

  it("carries no provider or UI dependency (pure data in, pure data out)", () => {
    // Structural guarantee: the capability factory takes zero arguments —
    // no repository, no provider, no storage handle can be injected.
    assert.equal(createPrintValidationCapability.length, 0);
  });
});

describe("customer snapshot sanitization (Goal 13)", () => {
  it("toCustomerArtworkVersion always redacts printValidationStatus, even when a real report status is stored on it", () => {
    const artwork: ArtworkVersion = {
      id: "art-1",
      projectId: "proj-1",
      versionNumber: 1,
      kind: "concept",
      title: "Concept 1",
      summary: "summary",
      placeholderLabel: "Concept 1",
      accentColor: "#000",
      isSelected: false,
      designBriefVersionId: "brief-v1",
      generationJobId: null,
      primaryAssetId: "asset-1",
      thumbnailAssetId: null,
      providerKey: null,
      customerRating: null,
      evaluationStatus: "passed",
      evaluation: null,
      evaluationEvaluatedAt: null,
      evaluationProviderKey: null,
      // A hypothetical future write of a real Print Validation status —
      // the customer projection must still redact it (Goal 13).
      printValidationStatus: "finalization_required",
      createdAt: new Date().toISOString(),
    };

    const customerView = toCustomerArtworkVersion(artwork);
    assert.equal(customerView.printValidationStatus, null);
  });
});

describe("classifyProduction / deriveProductionRequirements", () => {
  it("classifies a plain T-shirt as apparel_raster with unknown method confidence", () => {
    const classification = classifyProduction({
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
    });
    assert.equal(classification.category, "apparel_raster");
    assert.equal(classification.printMethodConfidence, "unknown");
  });

  it("classifies unrecognized product text as unknown, never a fabricated category", () => {
    const classification = classifyProduction({
      productSummary: "Something I haven't decided yet",
      designDescription: null,
    });
    assert.equal(classification.category, "unknown");
    assert.equal(classification.printMethodConfidence, "unknown");
  });

  it("derives null target dimensions when print location is unknown", () => {
    const requirements = deriveProductionRequirements({
      printPlacement: null,
      productSummary: "T-shirt",
      designDescription: null,
    });
    assert.equal(requirements.targetDimensions, null);
    assert.equal(requirements.minRasterDimensionsPx, null);
    assert.equal(requirements.sizing, null);
  });

  it("carries the placement's width-constrained sizing policy for apparel raster", () => {
    const requirements = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "T-shirt",
      designDescription: null,
    });
    assert.equal(requirements.sizing?.strategy, "width_constrained_preserve_aspect");
    assert.equal(requirements.sizing?.targetWidthIn, 10.5);
    assert.equal(requirements.sizing?.targetPpi, 300);
  });
});

describe("effective-resolution (Goal 7)", () => {
  it("computes ~85 PPI for a 1024px asset at a 12in target width — matches the sprint's own worked example", () => {
    const result = calculateEffectiveResolution(
      { widthPx: 1024, heightPx: 1024 },
      { widthIn: 12, heightIn: 14 },
    );
    assert.ok(Math.abs(result.ppiWidth - 1024 / 12) < 0.001);
    // The binding dimension is whichever is more constrained.
    assert.ok(result.effectivePpi <= result.ppiWidth);
    assert.ok(result.effectivePpi < 90);
  });

  it("never trusts PNG DPI metadata — only pixel ÷ physical dimensions", () => {
    const result = calculateEffectiveResolution(
      { widthPx: 3600, heightPx: 4200 },
      { widthIn: 12, heightIn: 14 },
    );
    assert.equal(result.effectivePpi, 300);
  });

  it("minimumRasterDimensionsFor derives the sprint's own 3600x4200 example", () => {
    const dims = minimumRasterDimensionsFor({ widthIn: 12, heightIn: 14 }, 300);
    assert.deepEqual(dims, { widthPx: 3600, heightPx: 4200 });
  });
});

describe("print placement target dimensions", () => {
  // Print-Ready Normalization Phase 1: the envelope's width is the 10.5in
  // production target; its height is the placement's printable BOUND, never a
  // canvas height the deliverable is padded out to.
  it("full_back and full_front use a 10.5in target width within a 14in printable height", () => {
    assert.deepEqual(targetDimensionsForPlacement("full_back"), {
      widthIn: 10.5,
      heightIn: 14,
    });
    assert.deepEqual(targetDimensionsForPlacement("full_front"), {
      widthIn: 10.5,
      heightIn: 14,
    });
  });

  it("returns null for an unknown placement", () => {
    assert.equal(targetDimensionsForPlacement(null), null);
  });
});
