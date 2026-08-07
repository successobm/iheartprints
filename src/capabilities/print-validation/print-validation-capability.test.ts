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
import type { PrintValidationInput } from "./contracts";

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
  it("D: a screen-print workflow requires vector artwork even though a raster concept exists", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        productSummary: "Screen printed T-shirt",
        designDescription: "Bold team logo",
      }),
    );

    assert.equal(report.requirements.category, "apparel_vector");
    assert.equal(report.requirements.printMethod, "screen_print");
    assert.equal(report.status, "finalization_required");
    const vectorCheck = report.checks.find((c) => c.check === "vector_source");
    assert.equal(vectorCheck?.status, "fail");
    assert.ok(report.requiredTransformations.includes("create_vector_version"));
  });

  // --- Goal 14 Scenario E --------------------------------------------------
  it("E: an embroidery workflow requires vector/digitized artwork even though a raster concept exists", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        productSummary: "Embroidered cap",
        designDescription: "Small crest logo",
        printPlacement: null,
      }),
    );

    assert.equal(report.requirements.category, "apparel_vector");
    assert.equal(report.requirements.printMethod, "embroidery");
    assert.equal(report.status, "finalization_required");
    const vectorCheck = report.checks.find((c) => c.check === "vector_source");
    assert.equal(vectorCheck?.status, "fail");
  });

  // --- Goal 14 Scenario F --------------------------------------------------
  it("F: a banner/sign concept requires vector artwork at final size", () => {
    const report = printValidation.validateArtwork(
      baseInput({
        productSummary: "Vinyl banner",
        designDescription: "Grand opening banner",
        printPlacement: null,
      }),
    );

    assert.equal(report.requirements.category, "signage");
    assert.equal(report.status, "finalization_required");
    const vectorCheck = report.checks.find((c) => c.check === "vector_source");
    assert.equal(vectorCheck?.status, "fail");
    assert.ok(report.requiredTransformations.includes("convert_fonts_to_outlines"));
    assert.ok(report.requiredTransformations.includes("resize_to_final_dimensions"));
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
  it("full_back and full_front use the 12x14in reference size", () => {
    assert.deepEqual(targetDimensionsForPlacement("full_back"), {
      widthIn: 12,
      heightIn: 14,
    });
    assert.deepEqual(targetDimensionsForPlacement("full_front"), {
      widthIn: 12,
      heightIn: 14,
    });
  });

  it("returns null for an unknown placement", () => {
    assert.equal(targetDimensionsForPlacement(null), null);
  });
});
