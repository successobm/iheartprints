import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

import {
  CONCEPT_EVALUATION_CRITERION_KEYS,
  CONCEPT_EVALUATION_STATUSES,
  createConceptEvaluationCapability,
  PlaceholderConceptEvaluationProvider,
  type ConceptEvaluationProvider,
  type ConceptEvaluationRequest,
  type ConceptEvaluationResult,
} from "./index";

function brief(
  overrides: Partial<DesignBriefSnapshotContent> = {},
): DesignBriefSnapshotContent {
  return {
    productSummary: "Camp t-shirts",
    designDescription: "A friendly bear logo",
    exactText: "Camp Wildwood 2026",
    shirtColor: "Navy",
    printPlacement: "full_front",
    preferredColors: ["Gold", "Cream"],
    designStyle: "Rustic hand-drawn",
    additionalInstructions: "Keep it simple",
    audience: "Camp families",
    purpose: "Fundraiser",
    exclusions: "No cartoon animals",
    deferredSections: [],
    ...overrides,
  };
}

function evaluationInput(
  overrides: Partial<{
    brief: DesignBriefSnapshotContent;
    idempotencyKey: string;
  }> = {},
) {
  return {
    brief: overrides.brief ?? brief(),
    concept: {
      title: "Concept A",
      summary: "A rustic bear mark",
      placeholderLabel: "Concept A",
    },
    assets: [
      {
        assetId: "asset-1",
        contentType: "image/png",
        widthPx: 1024,
        heightPx: 1024,
        isThumbnail: false,
        sourceUrl: "https://assets.example.test/signed/asset-1",
      },
    ],
    idempotencyKey: overrides.idempotencyKey ?? "eval-key-1",
  };
}

describe("Concept Evaluation contracts (Sprint 2I Phase 1)", () => {
  it("defines the reserved evaluation statuses", () => {
    assert.deepEqual([...CONCEPT_EVALUATION_STATUSES], [
      "pending",
      "passed",
      "needs_review",
      "failed",
    ]);
  });

  it("defines independent scoring criteria including brief-alignment concerns", () => {
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("required_wording"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("style"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("graphics"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("color_palette"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("product_compatibility"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("composition"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("readability"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("exclusions"));
    assert.ok(CONCEPT_EVALUATION_CRITERION_KEYS.includes("overall_alignment"));
    assert.equal(CONCEPT_EVALUATION_CRITERION_KEYS.length, 9);
  });

  it("does not include print-validation concerns in criteria keys", () => {
    const joined = CONCEPT_EVALUATION_CRITERION_KEYS.join(",");
    assert.doesNotMatch(joined, /dpi|transparency|embroidery|raster|vector|print_size/i);
  });
});

describe("ConceptEvaluationProvider interface", () => {
  it("accepts a provider-neutral request and returns a ConceptEvaluationResult", async () => {
    const provider: ConceptEvaluationProvider = {
      providerKey: "fake",
      async evaluate(request: ConceptEvaluationRequest): Promise<ConceptEvaluationResult> {
        assert.equal(request.brief.exactText, "Camp Wildwood 2026");
        assert.equal(request.assets.length, 1);
        assert.equal(request.idempotencyKey, "eval-key-1");
        return {
          overallScore: 80,
          passed: true,
          confidence: 70,
          status: "passed",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: 80,
            passed: true,
            confidence: 70,
            notes: null,
          })),
          warnings: [],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: ["required wording"],
          providerMetadata: { dialect: "private-to-adapter" },
        };
      },
    };

    const capability = createConceptEvaluationCapability(provider);
    const result = await capability.evaluate(evaluationInput());
    assert.equal(result.status, "passed");
    assert.equal(result.overallScore, 80);
    assert.equal(capability.providerKey, "fake");
  });
});

describe("ConceptEvaluationCapability orchestration", () => {
  it("normalizes criteria to the full contract set even when a provider omits some", async () => {
    const sparse: ConceptEvaluationProvider = {
      providerKey: "sparse",
      async evaluate() {
        return {
          overallScore: 150,
          passed: true,
          confidence: -10,
          status: "passed",
          criteria: [
            {
              key: "required_wording",
              score: 200,
              passed: true,
              confidence: 50,
              notes: "ok",
            },
          ],
          warnings: ["w"],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: {},
        };
      },
    };

    const capability = createConceptEvaluationCapability(sparse);
    const result = await capability.evaluate(evaluationInput());
    assert.equal(result.overallScore, 100);
    assert.equal(result.confidence, 0);
    assert.equal(result.criteria.length, CONCEPT_EVALUATION_CRITERION_KEYS.length);
    const wording = result.criteria.find((c) => c.key === "required_wording");
    assert.equal(wording?.score, 100);
    assert.equal(
      result.criteria.filter((c) => c.key !== "required_wording").every((c) => c.score === null),
      true,
    );
  });

  it("maps provider results into persistable evaluation fields", async () => {
    const capability = createConceptEvaluationCapability(
      new PlaceholderConceptEvaluationProvider(),
    );
    const result = await capability.evaluate(evaluationInput());
    const persisted = capability.toPersistedEvaluation(result);
    assert.equal(persisted.evaluationStatus, "needs_review");
    assert.equal(persisted.evaluationProviderKey, "placeholder_concept_evaluation");
    assert.equal(persisted.evaluation.criteria.length, 9);
    assert.ok(persisted.evaluation.providerMetadata);
  });

  it("provides a deterministic failure fallback that never claims pass/fail", () => {
    const capability = createConceptEvaluationCapability(
      new PlaceholderConceptEvaluationProvider(),
    );
    const fallback = capability.evaluationFailureFallback(new Error("vision down"));
    assert.equal(fallback.status, "needs_review");
    assert.equal(fallback.passed, null);
    assert.match(fallback.warnings[0] ?? "", /failed/i);
    assert.equal(fallback.providerMetadata.mode, "failure_fallback");
  });
});

describe("PlaceholderConceptEvaluationProvider", () => {
  it("is deterministic and marks every criterion not_assessed", async () => {
    const provider = new PlaceholderConceptEvaluationProvider();
    const a = await provider.evaluate({
      brief: brief(),
      concept: { title: "A", summary: "s", placeholderLabel: "A" },
      assets: [],
      idempotencyKey: "k",
    });
    const b = await provider.evaluate({
      brief: brief(),
      concept: { title: "A", summary: "s", placeholderLabel: "A" },
      assets: [],
      idempotencyKey: "k",
    });
    assert.deepEqual(a.criteria, b.criteria);
    assert.equal(a.status, "needs_review");
    assert.ok(a.criteria.every((c) => c.notes === "not_assessed"));
  });
});

describe("provider neutrality and future replacement", () => {
  it("never puts OpenAI / GPT / Vision vendor names in the capability layer", () => {
    const capability = createConceptEvaluationCapability(
      new PlaceholderConceptEvaluationProvider(),
    );
    assert.doesNotMatch(capability.providerKey, /openai|gpt|vision/i);
  });

  it("swaps evaluators behind the same interface without changing orchestration", async () => {
    class FutureVisionProvider implements ConceptEvaluationProvider {
      readonly providerKey = "future_vision_v1";
      async evaluate(): Promise<ConceptEvaluationResult> {
        return {
          overallScore: 42,
          passed: false,
          confidence: 90,
          status: "failed",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: 42,
            passed: false,
            confidence: 90,
            notes: null,
          })),
          warnings: [],
          recommendations: ["tighten exclusions"],
          missingRequirements: ["exclusions"],
          matchedRequirements: [],
          providerMetadata: { model: "internal-only" },
        };
      }
    }

    const capability = createConceptEvaluationCapability(new FutureVisionProvider());
    const result = await capability.evaluate(evaluationInput());
    assert.equal(result.status, "failed");
    assert.equal(capability.providerKey, "future_vision_v1");
    const persisted = capability.toPersistedEvaluation(result);
    assert.equal(persisted.evaluationProviderKey, "future_vision_v1");
  });

  it("request shape excludes customer, conversation, and job identifiers", async () => {
    let seen: ConceptEvaluationRequest | null = null;
    const provider: ConceptEvaluationProvider = {
      providerKey: "spy",
      async evaluate(request) {
        seen = request;
        return {
          overallScore: null,
          passed: null,
          confidence: 0,
          status: "needs_review",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: null,
            passed: null,
            confidence: 0,
            notes: null,
          })),
          warnings: [],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: {},
        };
      },
    };

    await createConceptEvaluationCapability(provider).evaluate(evaluationInput());
    assert.ok(seen);
    const keys = Object.keys(seen!);
    assert.deepEqual(keys.sort(), ["assets", "brief", "concept", "idempotencyKey"].sort());
    assert.equal("customerId" in seen!, false);
    assert.equal("conversationId" in seen!, false);
    assert.equal("generationJobId" in seen!, false);
    assert.equal("projectId" in seen!, false);
  });
});

describe("Sprint 2I Phase 2 — sourceUrl and providerMetadata boundaries", () => {
  const signedUrl = "https://assets.example.test/signed/secret-asset?token=abc";

  it("never persists sourceUrl even when a provider puts it in providerMetadata", async () => {
    const leaky: ConceptEvaluationProvider = {
      providerKey: "leaky",
      async evaluate(): Promise<ConceptEvaluationResult> {
        return {
          overallScore: 50,
          passed: null,
          confidence: 40,
          status: "needs_review",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: null,
            passed: null,
            confidence: 0,
            notes: `see ${signedUrl}`,
          })),
          warnings: [`fetch failed for ${signedUrl}`],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: {
            mode: "openai_vision",
            model: "gpt-4o-mini",
            sourceUrl: signedUrl,
            imageUrl: signedUrl,
            prompt: "secret dialect",
            dialect: "should-drop",
          },
        };
      },
    };

    const capability = createConceptEvaluationCapability(leaky);
    const persisted = capability.toPersistedEvaluation(
      await capability.evaluate(evaluationInput()),
    );
    const serialized = JSON.stringify(persisted.evaluation);

    assert.equal(serialized.includes(signedUrl), false);
    assert.equal(serialized.includes("sourceUrl"), false);
    assert.equal(serialized.includes("imageUrl"), false);
    assert.equal(serialized.includes("secret dialect"), false);
    assert.equal(serialized.includes("should-drop"), false);
    assert.deepEqual(Object.keys(persisted.evaluation.providerMetadata).sort(), [
      "mode",
      "model",
    ]);
    assert.match(persisted.evaluation.warnings[0] ?? "", /\[redacted\]/);
    assert.match(persisted.evaluation.criteria[0]?.notes ?? "", /\[redacted\]/);
  });

  it("redacts signed URLs from failure-fallback errorSummary", () => {
    const capability = createConceptEvaluationCapability(
      new PlaceholderConceptEvaluationProvider(),
    );
    const fallback = capability.evaluationFailureFallback(
      new Error(`vision fetch failed: ${signedUrl}`),
    );
    const summary = String(fallback.providerMetadata.errorSummary ?? "");
    assert.equal(summary.includes(signedUrl), false);
    assert.match(summary, /\[redacted\]/);
    assert.deepEqual(Object.keys(fallback.providerMetadata).sort(), [
      "errorClass",
      "errorSummary",
      "mode",
    ]);
  });

  it("keeps request-path sourceUrl ephemeral — never copied onto the result", async () => {
    // Box the capture so TypeScript keeps `ConceptEvaluationRequest | null`
    // across the async provider callback (a bare `let` is CFA-narrowed to
    // the initializer `null` and then collapses at the read site).
    const capture: { request: ConceptEvaluationRequest | null } = {
      request: null,
    };
    const provider: ConceptEvaluationProvider = {
      providerKey: "echo",
      async evaluate(request) {
        capture.request = request;
        return {
          overallScore: null,
          passed: null,
          confidence: 0,
          status: "needs_review",
          criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
            key,
            score: null,
            passed: null,
            confidence: 0,
            notes: null,
          })),
          warnings: [],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: { mode: "echo" },
        };
      },
    };

    const capability = createConceptEvaluationCapability(provider);
    const result = await capability.evaluate(
      evaluationInput({
        // evaluationInput already includes a signed sourceUrl on assets
      }),
    );

    assert.equal(
      capture.request?.assets[0]?.sourceUrl,
      "https://assets.example.test/signed/asset-1",
    );
    assert.equal(JSON.stringify(result).includes("assets.example.test"), false);
    assert.equal("sourceUrl" in result.providerMetadata, false);
  });
});
