import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

import { assembleProvisionalPrintValidationInput } from "./assemble-input";
import { createPrintValidationCapability } from "./print-validation-capability";

function brief(overrides: Partial<DesignBriefSnapshotContent> = {}): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirt",
    designDescription: "A bear mascot",
    exactText: "Camp Wildwood 2026",
    shirtColor: "Navy",
    printPlacement: "full_back",
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    ...overrides,
  };
}

describe("assembleProvisionalPrintValidationInput (Sprint 2M Phase 2A)", () => {
  it("maps a null asset to a null primaryAsset (no fabricated metadata)", () => {
    const input = assembleProvisionalPrintValidationInput({
      artworkVersionId: "art-1",
      designBriefVersionId: "brief-v1",
      currentApprovedDesignBriefVersionId: "brief-v1",
      brief: brief(),
      asset: null,
      conceptEvaluationStatus: "passed",
      conceptEvaluation: null,
    });
    assert.equal(input.primaryAsset, null);
  });

  it("never populates vectorAssetId — Phase 2A produces no vector companion asset", () => {
    const input = assembleProvisionalPrintValidationInput({
      artworkVersionId: "art-1",
      designBriefVersionId: "brief-v1",
      currentApprovedDesignBriefVersionId: "brief-v1",
      brief: brief(),
      asset: {
        contentType: "image/png",
        widthPx: 1024,
        heightPx: 1024,
        hasTransparency: true,
      },
      conceptEvaluationStatus: "passed",
      conceptEvaluation: null,
    });
    assert.equal(input.primaryAsset?.vectorAssetId, null);
  });

  it("is a pure function — same params always produce a deeply equal PrintValidationInput", () => {
    const params = {
      artworkVersionId: "art-1",
      designBriefVersionId: "brief-v1",
      currentApprovedDesignBriefVersionId: "brief-v1",
      brief: brief(),
      asset: {
        contentType: "image/png",
        widthPx: 1024,
        heightPx: 1024,
        hasTransparency: true,
      },
      conceptEvaluationStatus: "passed" as const,
      conceptEvaluation: null,
    };
    const first = assembleProvisionalPrintValidationInput(params);
    const second = assembleProvisionalPrintValidationInput(params);
    assert.deepEqual(first, second);
  });

  it("feeds cleanly into PrintValidationCapability — end-to-end determinism through both pure functions", () => {
    const printValidation = createPrintValidationCapability();
    const input = assembleProvisionalPrintValidationInput({
      artworkVersionId: "art-1",
      designBriefVersionId: "brief-v1",
      currentApprovedDesignBriefVersionId: "brief-v1",
      brief: brief(),
      asset: {
        contentType: "image/png",
        widthPx: 1024,
        heightPx: 1024,
        hasTransparency: true,
      },
      conceptEvaluationStatus: "passed",
      conceptEvaluation: null,
    });
    const first = printValidation.validateArtwork(input);
    const second = printValidation.validateArtwork(input);
    const strip = (r: typeof first) => {
      const rest: Partial<typeof r> = { ...r };
      delete rest.evaluatedAt;
      return rest;
    };
    assert.deepEqual(strip(first), strip(second));
    assert.equal(first.status, "finalization_required");
  });
});
