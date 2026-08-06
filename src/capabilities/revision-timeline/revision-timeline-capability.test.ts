import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArtworkVersion,
  ConceptEvaluation,
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  GenerationJob,
} from "@/lib/domain/types";
import { CONCEPT_EVALUATION_CRITERION_KEYS } from "@/capabilities/concept-evaluation";
import type { BriefSectionKey, RevisionImpact } from "@/capabilities/shared/contracts";

import {
  buildRevisionTimeline,
  createRevisionTimelineCapability,
  EMPTY_REJECTED_CONCEPT_MEMORY,
  resolveGenerationAttemptNumber,
} from "./index";

function briefContent(
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
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    ...overrides,
  };
}

function briefVersion(
  overrides: Partial<DesignBriefVersion> & Pick<DesignBriefVersion, "id" | "versionNumber">,
): DesignBriefVersion {
  return {
    projectId: "proj-1",
    briefId: "brief-1",
    status: "approved",
    content: briefContent(),
    approvedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function job(
  overrides: Partial<GenerationJob> & Pick<GenerationJob, "id" | "status">,
): GenerationJob {
  return {
    projectId: "proj-1",
    designBriefVersionId: "v1",
    kind: "initial",
    conceptCount: 3,
    providerKey: "placeholder",
    idempotencyKey: `key-${overrides.id}`,
    attempts: 1,
    lastError: null,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: overrides.status === "completed" ? "2026-01-01T00:01:00Z" : null,
    heartbeatAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function evaluationResult(
  overrides: Partial<Record<string, { passed: boolean | null }>> = {},
  passed: boolean | null = null,
): ConceptEvaluation {
  return {
    overallScore: null,
    passed,
    confidence: 50,
    criteria: CONCEPT_EVALUATION_CRITERION_KEYS.map((key) => ({
      key,
      score: null,
      passed: overrides[key]?.passed ?? null,
      confidence: 0,
      notes: null,
    })),
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
  };
}

function artwork(
  overrides: Partial<ArtworkVersion> & Pick<ArtworkVersion, "id">,
): ArtworkVersion {
  return {
    projectId: "proj-1",
    versionNumber: 1,
    kind: "concept",
    title: "Concept",
    summary: "A concept",
    placeholderLabel: "C1",
    accentColor: "#000",
    isSelected: false,
    designBriefVersionId: "v1",
    generationJobId: null,
    primaryAssetId: null,
    thumbnailAssetId: null,
    providerKey: "placeholder",
    customerRating: null,
    evaluationStatus: null,
    evaluation: null,
    evaluationEvaluatedAt: null,
    evaluationProviderKey: null,
    printValidationStatus: null,
    createdAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function impact(changedSections: BriefSectionKey[]): RevisionImpact {
  return {
    changedSections,
    affectedRulePacks: [],
    needsReevaluation: changedSections.length > 0,
    needsSummaryRefresh: changedSections.length > 0,
    needsNewRecommendations: false,
    needsConceptRegeneration: changedSections.length > 0,
    isNoOp: changedSections.length === 0,
  };
}

const capability = createRevisionTimelineCapability();

describe("RevisionTimelineCapability — derivation", () => {
  it("returns an empty timeline when there are no records", () => {
    const timeline = capability.derive({
      designBriefVersions: [],
      generationJobs: [],
      artworkVersions: [],
      revisionImpacts: [],
    });
    assert.deepEqual(timeline.events, []);
  });

  it("derives Generation N labels from completed jobs in chronological order", () => {
    const timeline = buildRevisionTimeline({
      designBriefVersions: [briefVersion({ id: "v1", versionNumber: 1 })],
      generationJobs: [
        job({
          id: "j2",
          status: "completed",
          createdAt: "2026-01-02T00:00:00Z",
          completedAt: "2026-01-02T00:01:00Z",
        }),
        job({
          id: "j1",
          status: "completed",
          createdAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:01:00Z",
        }),
        job({ id: "j3", status: "failed", createdAt: "2026-01-03T00:00:00Z" }),
      ],
      artworkVersions: [],
      revisionImpacts: [],
    });

    const generations = timeline.events.filter((e) => e.kind === "generation");
    assert.equal(generations.length, 2);
    assert.equal(generations[0]?.label, "Generation 1");
    assert.equal(generations[0]?.generationAttempt, 1);
    assert.equal(generations[1]?.label, "Generation 2");
    assert.equal(generations[1]?.generationAttempt, 2);
  });

  it("derives customer revision events from RevisionImpacts with plain-language labels", () => {
    const timeline = buildRevisionTimeline({
      designBriefVersions: [
        briefVersion({ id: "v1", versionNumber: 1 }),
        briefVersion({
          id: "v2",
          versionNumber: 2,
          approvedAt: "2026-01-01T02:00:00Z",
        }),
      ],
      generationJobs: [],
      artworkVersions: [],
      revisionImpacts: [
        {
          impact: impact(["requiredWording"]),
          occurredAt: "2026-01-01T02:00:00Z",
          sourceId: "v2",
        },
      ],
    });

    assert.equal(timeline.events.length, 1);
    assert.equal(timeline.events[0]?.kind, "customer_revision");
    assert.match(timeline.events[0]?.label ?? "", /Customer changed wording/i);
    assert.deepEqual(timeline.events[0]?.sections, ["requiredWording"]);
  });

  it("skips no-op revision impacts", () => {
    const timeline = buildRevisionTimeline({
      designBriefVersions: [],
      generationJobs: [],
      artworkVersions: [],
      revisionImpacts: [
        {
          impact: impact([]),
          occurredAt: "2026-01-01T02:00:00Z",
          sourceId: "noop",
        },
      ],
    });
    assert.deepEqual(timeline.events, []);
  });

  it("derives evaluation failed / passed events from ArtworkVersion evaluations per job", () => {
    const timeline = buildRevisionTimeline({
      designBriefVersions: [briefVersion({ id: "v1", versionNumber: 1 })],
      generationJobs: [
        job({
          id: "j1",
          status: "completed",
          completedAt: "2026-01-01T00:01:00Z",
        }),
        job({
          id: "j2",
          status: "completed",
          createdAt: "2026-01-02T00:00:00Z",
          completedAt: "2026-01-02T00:01:00Z",
        }),
      ],
      artworkVersions: [
        artwork({
          id: "a1",
          generationJobId: "j1",
          evaluationStatus: "failed",
          evaluation: evaluationResult({ required_wording: { passed: false } }, false),
          evaluationEvaluatedAt: "2026-01-01T00:02:00Z",
        }),
        artwork({
          id: "a2",
          generationJobId: "j2",
          evaluationStatus: "passed",
          evaluation: evaluationResult({ required_wording: { passed: true } }, true),
          evaluationEvaluatedAt: "2026-01-02T00:02:00Z",
        }),
      ],
      revisionImpacts: [],
    });

    const failed = timeline.events.find((e) => e.kind === "evaluation_failed");
    const passed = timeline.events.find((e) => e.kind === "evaluation_passed");
    assert.ok(failed);
    assert.match(failed?.label ?? "", /Evaluation failed wording/i);
    assert.ok(passed);
    assert.equal(passed?.label, "Evaluation passed");
  });
});

describe("RevisionTimelineCapability — ordering", () => {
  it("orders the example pipeline chronologically as pure domain events", () => {
    const timeline = buildRevisionTimeline({
      designBriefVersions: [
        briefVersion({ id: "v1", versionNumber: 1, approvedAt: "2026-01-01T00:00:00Z" }),
        briefVersion({ id: "v2", versionNumber: 2, approvedAt: "2026-01-01T03:00:00Z" }),
        briefVersion({ id: "v3", versionNumber: 3, approvedAt: "2026-01-01T06:00:00Z" }),
      ],
      generationJobs: [
        job({
          id: "j1",
          status: "completed",
          createdAt: "2026-01-01T01:00:00Z",
          completedAt: "2026-01-01T01:30:00Z",
        }),
        job({
          id: "j2",
          status: "completed",
          kind: "regeneration",
          createdAt: "2026-01-01T04:00:00Z",
          completedAt: "2026-01-01T04:30:00Z",
        }),
        job({
          id: "j3",
          status: "completed",
          kind: "regeneration",
          createdAt: "2026-01-01T07:00:00Z",
          completedAt: "2026-01-01T07:30:00Z",
        }),
      ],
      artworkVersions: [
        artwork({
          id: "a1",
          generationJobId: "j2",
          evaluationStatus: "failed",
          evaluation: evaluationResult({ required_wording: { passed: false } }, false),
          evaluationEvaluatedAt: "2026-01-01T04:45:00Z",
        }),
        artwork({
          id: "a2",
          generationJobId: "j3",
          evaluationStatus: "passed",
          evaluation: evaluationResult({ required_wording: { passed: true } }, true),
          evaluationEvaluatedAt: "2026-01-01T07:45:00Z",
        }),
      ],
      revisionImpacts: [
        {
          impact: impact(["requiredWording"]),
          occurredAt: "2026-01-01T03:00:00Z",
          sourceId: "v2",
        },
        {
          impact: impact(["colors"]),
          occurredAt: "2026-01-01T06:00:00Z",
          sourceId: "v3",
        },
      ],
    });

    assert.deepEqual(
      timeline.events.map((e) => e.label),
      [
        "Generation 1",
        "Customer changed wording",
        "Generation 2",
        "Evaluation failed wording",
        "Customer changed colors",
        "Generation 3",
        "Evaluation passed",
      ],
    );
  });

  it("is deterministic for the same inputs regardless of input array order", () => {
    const versions = [
      briefVersion({ id: "v1", versionNumber: 1 }),
      briefVersion({ id: "v2", versionNumber: 2, approvedAt: "2026-01-01T02:00:00Z" }),
    ];
    const jobs = [
      job({ id: "j1", status: "completed", completedAt: "2026-01-01T01:00:00Z" }),
    ];
    const arts = [
      artwork({
        id: "a1",
        generationJobId: "j1",
        evaluationStatus: "passed",
        evaluation: evaluationResult({}, true),
        evaluationEvaluatedAt: "2026-01-01T01:10:00Z",
      }),
    ];
    const impacts = [
      {
        impact: impact(["style"]),
        occurredAt: "2026-01-01T02:00:00Z",
        sourceId: "v2",
      },
    ];

    const a = buildRevisionTimeline({
      designBriefVersions: versions,
      generationJobs: jobs,
      artworkVersions: arts,
      revisionImpacts: impacts,
    });
    const b = buildRevisionTimeline({
      designBriefVersions: [...versions].reverse(),
      generationJobs: [...jobs],
      artworkVersions: [...arts],
      revisionImpacts: [...impacts],
    });
    assert.deepEqual(a, b);
  });
});

describe("RevisionTimelineCapability — GenerationAttempt authority", () => {
  it("resolveGenerationAttemptNumber uses completed GenerationJobs only", () => {
    assert.equal(resolveGenerationAttemptNumber([]), 1);
    assert.equal(
      resolveGenerationAttemptNumber([
        job({ id: "j1", status: "completed" }),
        job({ id: "j2", status: "queued" }),
        job({ id: "j3", status: "failed", attempts: 9 }),
      ]),
      2,
    );
  });

  it("does not treat GenerationJob.attempts as the generation ordinal", () => {
    // A single completed job with attempts=3 (claim retries) is still Generation 1
    // for timeline purposes; next plan is attempt 2.
    assert.equal(
      resolveGenerationAttemptNumber([
        job({ id: "j1", status: "completed", attempts: 3 }),
      ]),
      2,
    );
  });
});

describe("RevisionTimelineCapability — purity and persistence", () => {
  it("never mutates input records", () => {
    const input = {
      designBriefVersions: [briefVersion({ id: "v1", versionNumber: 1 })],
      generationJobs: [job({ id: "j1", status: "completed" })],
      artworkVersions: [] as ArtworkVersion[],
      revisionImpacts: [
        {
          impact: impact(["colors"]),
          occurredAt: "2026-01-01T02:00:00Z",
          sourceId: "v2",
        },
      ],
    };
    const before = JSON.stringify(input);
    buildRevisionTimeline(input);
    assert.equal(JSON.stringify(input), before);
  });

  it("never persists — repeated derive calls are idempotent and identical", () => {
    const input = {
      designBriefVersions: [briefVersion({ id: "v1", versionNumber: 1 })],
      generationJobs: [job({ id: "j1", status: "completed" })],
      artworkVersions: [] as ArtworkVersion[],
      revisionImpacts: [] as {
        impact: RevisionImpact;
        occurredAt: string;
        sourceId: string;
      }[],
    };
    const a = capability.derive(input);
    const b = capability.derive(input);
    assert.deepEqual(a, b);
  });

  it("never emits provider or prompt language", () => {
    const timeline = buildRevisionTimeline({
      designBriefVersions: [briefVersion({ id: "v1", versionNumber: 1 })],
      generationJobs: [job({ id: "j1", status: "completed" })],
      artworkVersions: [
        artwork({
          id: "a1",
          generationJobId: "j1",
          evaluationStatus: "failed",
          evaluation: evaluationResult({ style: { passed: false } }, false),
          evaluationEvaluatedAt: "2026-01-01T00:02:00Z",
        }),
      ],
      revisionImpacts: [
        {
          impact: impact(["style"]),
          occurredAt: "2026-01-01T02:00:00Z",
          sourceId: "v2",
        },
      ],
    });
    const serialized = JSON.stringify(timeline);
    assert.doesNotMatch(
      serialized,
      /openai|gpt|masterpiece|8k|prompt|dall-?e/i,
    );
  });

  it("EMPTY_REJECTED_CONCEPT_MEMORY is safe to use when rejection persistence does not exist", () => {
    assert.deepEqual(EMPTY_REJECTED_CONCEPT_MEMORY.rejectedSections, []);
  });
});
