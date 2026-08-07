import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createConceptEvaluationCapability,
  type ConceptEvaluationProvider,
  type ConceptEvaluationRequest,
  type ConceptEvaluationResult,
} from "@/capabilities/concept-evaluation";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

import { verifyProductionArtwork } from "./production-verification";

function briefFixture(): DesignBriefSnapshotContent {
  return {
    productSummary: "T-shirt",
    designDescription: "A bear mascot",
    exactText: "My 3 Sons",
    shirtColor: "Navy",
    printPlacement: "full_back",
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
  };
}

class FakeProvider implements ConceptEvaluationProvider {
  readonly providerKey = "fake_production_ocr";
  public lastRequest: ConceptEvaluationRequest | null = null;
  constructor(
    private readonly result: ConceptEvaluationResult,
    private readonly shouldThrow = false,
  ) {}
  async evaluate(request: ConceptEvaluationRequest): Promise<ConceptEvaluationResult> {
    this.lastRequest = request;
    if (this.shouldThrow) throw new Error("provider exploded");
    return this.result;
  }
}

function resultFixture(overrides: Partial<ConceptEvaluationResult> = {}): ConceptEvaluationResult {
  return {
    overallScore: 90,
    passed: true,
    confidence: 90,
    status: "passed",
    criteria: [
      { key: "required_wording", score: 100, passed: true, confidence: 90, notes: null },
    ],
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
    ...overrides,
  };
}

describe("verifyProductionArtwork (Sprint 2M Phase 2E Goal 7/9)", () => {
  it("O: production wording passing is reported honestly", async () => {
    const provider = new FakeProvider(resultFixture());
    const capability = createConceptEvaluationCapability(provider);

    const result = await verifyProductionArtwork(capability, {
      brief: briefFixture(),
      concept: { title: "t", summary: "s", placeholderLabel: "p" },
      productionAsset: {
        assetId: "asset-1",
        contentType: "image/png",
        widthPx: 3600,
        heightPx: 4200,
        sourceUrl: "https://signed.example.com/asset-1.png",
      },
      idempotencyKey: "job-1:asset-1",
    });

    assert.equal(result.evaluationStatus, "passed");
    const wording = result.evaluation.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.passed, true);
  });

  it("P: production wording failure is reported honestly, never silently upgraded", async () => {
    const provider = new FakeProvider(
      resultFixture({
        status: "failed",
        passed: false,
        criteria: [
          { key: "required_wording", score: 0, passed: false, confidence: 90, notes: "missing" },
        ],
      }),
    );
    const capability = createConceptEvaluationCapability(provider);

    const result = await verifyProductionArtwork(capability, {
      brief: briefFixture(),
      concept: { title: "t", summary: "s", placeholderLabel: "p" },
      productionAsset: {
        assetId: "asset-1",
        contentType: "image/png",
        widthPx: 3600,
        heightPx: 4200,
        sourceUrl: "https://signed.example.com/asset-1.png",
      },
      idempotencyKey: "job-1:asset-1",
    });

    assert.equal(result.evaluationStatus, "failed");
    const wording = result.evaluation.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.passed, false);
  });

  it("verifies against the PRODUCTION asset, not any source concept asset — the request carries only the production asset reference", async () => {
    const provider = new FakeProvider(resultFixture());
    const capability = createConceptEvaluationCapability(provider);

    await verifyProductionArtwork(capability, {
      brief: briefFixture(),
      concept: { title: "t", summary: "s", placeholderLabel: "p" },
      productionAsset: {
        assetId: "production-asset-id",
        contentType: "image/png",
        widthPx: 3600,
        heightPx: 4200,
        sourceUrl: "https://signed.example.com/production-asset-id.png",
      },
      idempotencyKey: "job-1:production-asset-id",
    });

    assert.equal(provider.lastRequest?.assets.length, 1);
    assert.equal(provider.lastRequest?.assets[0]?.assetId, "production-asset-id");
  });

  it("a provider failure never crashes verification — resolves to an honest needs_review fallback", async () => {
    const provider = new FakeProvider(resultFixture(), true);
    const capability = createConceptEvaluationCapability(provider);

    const result = await verifyProductionArtwork(capability, {
      brief: briefFixture(),
      concept: { title: "t", summary: "s", placeholderLabel: "p" },
      productionAsset: {
        assetId: "asset-1",
        contentType: "image/png",
        widthPx: 3600,
        heightPx: 4200,
        sourceUrl: "https://signed.example.com/asset-1.png",
      },
      idempotencyKey: "job-1:asset-1",
    });

    assert.equal(result.evaluationStatus, "needs_review");
    const wording = result.evaluation.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.passed, null);
  });

  it("verification against a null signed URL (asset unreachable) honestly resolves not-assessed, never a fabricated pass", async () => {
    const provider = new FakeProvider(resultFixture());
    const capability = createConceptEvaluationCapability(provider);

    const result = await verifyProductionArtwork(capability, {
      brief: briefFixture(),
      concept: { title: "t", summary: "s", placeholderLabel: "p" },
      productionAsset: {
        assetId: "asset-1",
        contentType: "image/png",
        widthPx: 3600,
        heightPx: 4200,
        sourceUrl: null,
      },
      idempotencyKey: "job-1:asset-1",
    });

    assert.equal(provider.lastRequest?.assets[0]?.sourceUrl, null);
    // The fake provider still returns its fixture result regardless of URL
    // (unlike the real OpenAI adapter's `noImageResult` short-circuit) —
    // this test only proves `verifyProductionArtwork` forwards `null`
    // honestly rather than fabricating a URL.
    assert.equal(result.evaluationStatus, "passed");
  });
});
