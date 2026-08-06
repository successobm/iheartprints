import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ConceptEvaluation,
  ConceptEvaluationCriterionKey,
  ConceptEvaluationCriterionScore,
  ConceptEvaluationStatus,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";
import { CONCEPT_EVALUATION_CRITERION_KEYS } from "@/capabilities/concept-evaluation";
import type { BriefSectionKey, RevisionImpact } from "@/capabilities/shared/contracts";
import type { RevisionTimeline } from "@/capabilities/revision-timeline";

import {
  buildRegenerationPlan,
  createRegenerationIntelligenceCapability,
  resolveGenerationAttemptNumber,
  type RegenerationConceptEvaluationInput,
  type RegenerationIntelligenceInput,
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
    exclusions: null,
    deferredSections: [],
    ...overrides,
  };
}

/** Builds a full evaluation with every criterion "not assessed" by default, then applies overrides by key. */
function evaluation(
  overrides: Partial<Record<ConceptEvaluationCriterionKey, Partial<ConceptEvaluationCriterionScore>>> = {},
  status: ConceptEvaluationStatus = "needs_review",
): RegenerationConceptEvaluationInput {
  const criteria: ConceptEvaluationCriterionScore[] = CONCEPT_EVALUATION_CRITERION_KEYS.map(
    (key) => ({
      key,
      score: null,
      passed: null,
      confidence: 0,
      notes: null,
      ...(overrides[key] ?? {}),
    }),
  );
  const result: ConceptEvaluation = {
    overallScore: null,
    passed: null,
    confidence: 50,
    criteria,
    warnings: [],
    recommendations: [],
    missingRequirements: [],
    matchedRequirements: [],
    providerMetadata: {},
  };
  return { status, result };
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


/** Minimal timeline whose customer_revision events mirror a former RevisionImpact history. */
function timelineFromImpacts(
  impacts: RevisionImpact[],
): RevisionTimeline {
  return {
    events: impacts
      .filter((entry) => !entry.isNoOp && entry.changedSections.length > 0)
      .map((entry, index) => ({
        kind: "customer_revision" as const,
        label: `Customer changed ${entry.changedSections.join(", ")}`,
        occurredAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
        sequenceKey: `customer_revision:test-${index}`,
        sections: entry.changedSections,
      })),
  };
}

function baseInput(
  overrides: Partial<RegenerationIntelligenceInput> = {},
): RegenerationIntelligenceInput {
  return {
    approvedBrief: brief(),
    latestEvaluation: null,
    revisionTimeline: { events: [] },
    currentGeneration: { attemptNumber: 1 },
    ...overrides,
  };
}

const capability = createRegenerationIntelligenceCapability();

describe("RegenerationIntelligenceCapability — no-op evaluations", () => {
  it("produces a baseline plan on the very first generation attempt (no evaluation, no revisions)", () => {
    const plan = capability.planNextGeneration(baseInput());

    assert.equal(plan.generationAttempt, 1);
    assert.deepEqual(plan.avoid, []);
    assert.deepEqual(plan.strengthen, []);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.replace, []);
    assert.deepEqual(plan.customerRequestedChanges, []);
    assert.deepEqual(plan.evaluationDrivenChanges, []);
    assert.deepEqual(plan.priorityChanges, []);
    assert.ok(plan.unchangedSections.length > 0);
    assert.match(plan.reason, /no prior evaluation or revisions/i);
  });

  it("an evaluation where every criterion is not_assessed produces no evaluation-driven actions", () => {
    const plan = buildRegenerationPlan(
      baseInput({ latestEvaluation: evaluation() }),
    );
    assert.deepEqual(plan.evaluationDrivenChanges, []);
    assert.deepEqual(plan.preserve, []);
  });
});

describe("RegenerationIntelligenceCapability — evaluation failures", () => {
  it("a failed style criterion becomes an evaluation-driven strengthen action", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        latestEvaluation: evaluation({ style: { passed: false, score: 20 } }),
      }),
    );

    assert.equal(plan.evaluationDrivenChanges.length, 1);
    assert.equal(plan.evaluationDrivenChanges[0]?.section, "style");
    assert.equal(plan.evaluationDrivenChanges[0]?.source, "evaluation");
    assert.ok(plan.strengthen.some((c) => c.section === "style"));
    assert.equal(plan.unchangedSections.includes("style"), false);
  });

  it("a failed required-wording criterion is surfaced and never silently dropped", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        latestEvaluation: evaluation({
          required_wording: { passed: false, score: 0 },
        }),
      }),
    );

    assert.ok(plan.strengthen.some((c) => c.section === "requiredWording"));
    assert.ok(plan.evaluationDrivenChanges.some((c) => c.section === "requiredWording"));
  });

  it("a passed criterion becomes a preservation action, not an evaluation-driven change", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        latestEvaluation: evaluation({ graphics: { passed: true, score: 90 } }),
      }),
    );

    assert.ok(plan.preserve.some((c) => c.section === "graphics"));
    assert.equal(plan.evaluationDrivenChanges.some((c) => c.section === "graphics"), false);
  });

  it("sections with no mapped criterion (product, printLocation) never produce evaluation-driven changes", () => {
    const plan = buildRegenerationPlan(baseInput({ latestEvaluation: evaluation() }));
    assert.equal(plan.evaluationDrivenChanges.some((c) => c.section === "product"), false);
    assert.equal(
      plan.evaluationDrivenChanges.some((c) => c.section === "printLocation"),
      false,
    );
  });
});

describe("RegenerationIntelligenceCapability — customer revisions", () => {
  it("a single customer style revision (not yet evaluated) becomes a strengthen action", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Modern" }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
      }),
    );

    assert.equal(plan.customerRequestedChanges.length, 1);
    assert.equal(plan.customerRequestedChanges[0]?.section, "style");
    assert.equal(plan.customerRequestedChanges[0]?.source, "customer_revision");
    assert.ok(plan.strengthen.some((c) => c.section === "style"));
  });

  it("a customer revision that cleared a field becomes a remove action", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ additionalInstructions: null, designDescription: "" }),
        revisionTimeline: timelineFromImpacts([impact(["graphics"])]),
      }),
    );

    assert.ok(plan.remove.some((c) => c.section === "graphics"));
    assert.equal(plan.strengthen.some((c) => c.section === "graphics"), false);
  });

  it("customer revisions always override an evaluation suggestion for the same section", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Modern" }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
        latestEvaluation: evaluation({ style: { passed: false, score: 10 } }),
      }),
    );

    // Exactly one style entry (from the customer side), never a duplicate
    // evaluation-sourced one for the same section.
    const styleEntries = [
      ...plan.strengthen,
      ...plan.preserve,
      ...plan.remove,
      ...plan.replace,
    ].filter((c) => c.section === "style");
    assert.equal(styleEntries.length, 1);
    assert.equal(styleEntries[0]?.source, "customer_revision");
    assert.equal(plan.evaluationDrivenChanges.some((c) => c.section === "style"), false);
  });

  it("a customer request already confirmed by evaluation is treated as satisfied (preserve)", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Modern" }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
        latestEvaluation: evaluation({ style: { passed: true, score: 95 } }),
      }),
    );

    assert.ok(plan.preserve.some((c) => c.section === "style"));
    assert.equal(plan.strengthen.some((c) => c.section === "style"), false);
    // Still recorded as a customer-requested change (the customer did ask), just satisfied.
    assert.ok(plan.customerRequestedChanges.some((c) => c.section === "style"));
  });
});

describe("RegenerationIntelligenceCapability — conflicting revisions", () => {
  it("a section touched twice is categorized replace, superseding the earlier request", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Bold graffiti" }),
        revisionTimeline: timelineFromImpacts([impact(["style"]), impact(["style"])]),
      }),
    );

    assert.ok(plan.replace.some((c) => c.section === "style"));
    assert.equal(plan.strengthen.some((c) => c.section === "style"), false);
    assert.match(
      plan.replace.find((c) => c.section === "style")?.description ?? "",
      /supersed/i,
    );
  });

  it("a section touched once stays a strengthen action, not a replace", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Modern" }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
      }),
    );
    assert.ok(plan.strengthen.some((c) => c.section === "style"));
    assert.equal(plan.replace.some((c) => c.section === "style"), false);
  });
});

describe("RegenerationIntelligenceCapability — exclusions", () => {
  it("brief exclusions always land in avoid, at the front of priorityChanges", () => {
    const plan = buildRegenerationPlan(
      baseInput({ approvedBrief: brief({ exclusions: "No skulls or weapons" }) }),
    );

    assert.ok(plan.avoid.some((c) => c.section === "exclusions"));
    assert.equal(plan.priorityChanges[0]?.section, "exclusions");
  });

  it("an evaluation-confirmed exclusion violation adds a second avoid entry", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ exclusions: "No skulls" }),
        latestEvaluation: evaluation({ exclusions: { passed: false, score: 10 } }),
      }),
    );

    const exclusionEntries = plan.avoid.filter((c) => c.section === "exclusions");
    assert.equal(exclusionEntries.length, 2);
    assert.ok(exclusionEntries.some((c) => c.source === "brief"));
    assert.ok(exclusionEntries.some((c) => c.source === "evaluation"));
  });

  it("exclusions override everything — present even alongside customer revisions and evaluation failures", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ exclusions: "No skulls", designStyle: "Modern" }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
        latestEvaluation: evaluation({ graphics: { passed: false, score: 5 } }),
      }),
    );
    assert.equal(plan.priorityChanges[0]?.section, "exclusions");
  });

  it("previously rejected sections are always routed to avoid, regardless of the brief's current content", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Bold graffiti" }),
        currentGeneration: { attemptNumber: 2, rejectedSections: ["style"] },
      }),
    );

    assert.ok(plan.avoid.some((c) => c.section === "style"));
    assert.equal(plan.strengthen.some((c) => c.section === "style"), false);
    assert.equal(plan.preserve.some((c) => c.section === "style"), false);
  });

  it("a rejected section stays rejected even when the customer revises it again this cycle", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Bold graffiti" }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
        currentGeneration: { attemptNumber: 3, rejectedSections: ["style"] },
      }),
    );

    assert.ok(plan.avoid.some((c) => c.section === "style"));
    assert.equal(plan.customerRequestedChanges.some((c) => c.section === "style"), false);
  });
});

describe("RegenerationIntelligenceCapability — required wording preservation", () => {
  it("required wording present and confirmed by evaluation is preserved, never marked for removal", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        latestEvaluation: evaluation({ required_wording: { passed: true, score: 100 } }),
      }),
    );

    assert.ok(plan.preserve.some((c) => c.section === "requiredWording"));
    assert.equal(plan.remove.some((c) => c.section === "requiredWording"), false);
  });

  it("required wording is surfaced at the front of priorityChanges (after avoid) whenever it has any action", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ exclusions: "No profanity" }),
        latestEvaluation: evaluation({ required_wording: { passed: false, score: 0 } }),
      }),
    );

    assert.equal(plan.priorityChanges[0]?.section, "exclusions");
    assert.equal(plan.priorityChanges[1]?.section, "requiredWording");
  });

  it("a customer explicitly clearing required wording is respected as their own decision (remove)", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ exactText: "" }),
        revisionTimeline: timelineFromImpacts([impact(["requiredWording"])]),
      }),
    );

    assert.ok(plan.remove.some((c) => c.section === "requiredWording"));
  });

  it("required wording untouched and unassessed stays out of every action bucket", () => {
    const plan = buildRegenerationPlan(baseInput());
    const touched = [
      ...plan.preserve,
      ...plan.strengthen,
      ...plan.remove,
      ...plan.replace,
      ...plan.avoid,
    ].some((c) => c.section === "requiredWording");
    assert.equal(touched, false);
    assert.ok(plan.unchangedSections.includes("requiredWording"));
  });
});

describe("RegenerationIntelligenceCapability — priority ordering", () => {
  it("orders priorityChanges: avoid, then required wording, then customer requests, then evaluation-driven fixes", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({
          exclusions: "No skulls",
          exactText: "Strike First",
          designStyle: "Modern",
        }),
        revisionTimeline: timelineFromImpacts([impact(["style"])]),
        latestEvaluation: evaluation({
          required_wording: { passed: false, score: 0 },
          graphics: { passed: false, score: 10 },
        }),
      }),
    );

    const sections = plan.priorityChanges.map((c) => c.section);
    assert.equal(sections[0], "exclusions");
    assert.equal(sections[1], "requiredWording");
    assert.equal(sections[2], "style");
    assert.equal(sections[3], "graphics");
  });

  it("orders same-tier entries by canonical section order regardless of input order", () => {
    const planA = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Modern", shirtColor: "Black" }),
        revisionTimeline: timelineFromImpacts([impact(["productColor", "style"])]),
      }),
    );
    const planB = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({ designStyle: "Modern", shirtColor: "Black" }),
        revisionTimeline: timelineFromImpacts([impact(["style", "productColor"])]),
      }),
    );

    assert.deepEqual(
      planA.customerRequestedChanges.map((c) => c.section),
      planB.customerRequestedChanges.map((c) => c.section),
    );
    assert.deepEqual(
      planA.customerRequestedChanges.map((c) => c.section),
      ["productColor", "style"],
    );
  });
});

describe("RegenerationIntelligenceCapability — determinism", () => {
  it("the same input always produces a deepEqual plan", () => {
    const input = baseInput({
      approvedBrief: brief({ designStyle: "Modern", exclusions: "No skulls" }),
      revisionTimeline: timelineFromImpacts([impact(["style"]), impact(["colors"])]),
      latestEvaluation: evaluation({ graphics: { passed: false, score: 15 } }),
      currentGeneration: { attemptNumber: 2, rejectedSections: ["printLocation"] },
    });

    const planA = buildRegenerationPlan(input);
    const planB = buildRegenerationPlan(input);
    assert.deepEqual(planA, planB);
  });
});

describe("RegenerationIntelligenceCapability — idempotency", () => {
  it("calling planNextGeneration repeatedly with identical input never accumulates or drifts", () => {
    const input = baseInput({
      approvedBrief: brief({ designStyle: "Modern" }),
      revisionTimeline: timelineFromImpacts([impact(["style"])]),
      latestEvaluation: evaluation({ style: { passed: true, score: 90 } }),
    });

    const plans = [1, 2, 3].map(() => capability.planNextGeneration(input));
    assert.deepEqual(plans[0], plans[1]);
    assert.deepEqual(plans[1], plans[2]);
  });

  it("a fully satisfied, unrevised brief converges to a stable all-preserve-or-unchanged plan", () => {
    const input = baseInput({
      latestEvaluation: evaluation({
        required_wording: { passed: true, score: 100 },
        style: { passed: true, score: 100 },
        graphics: { passed: true, score: 100 },
        color_palette: { passed: true, score: 100 },
        product_compatibility: { passed: true, score: 100 },
      }),
    });

    const plan = buildRegenerationPlan(input);
    assert.deepEqual(plan.strengthen, []);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.replace, []);
    assert.deepEqual(plan.avoid, []);
    assert.deepEqual(plan.evaluationDrivenChanges, []);
    assert.ok(plan.preserve.length > 0);
  });
});

describe("RegenerationIntelligenceCapability — provider neutrality", () => {
  const forbiddenPattern = /masterpiece|8k|4k|photorealistic|highly detailed|trending on|award.winning|ultra|hyperrealistic/i;

  it("never emits provider prompt dialect or quality-boosting language anywhere in the plan", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({
          exclusions: "No skulls",
          designStyle: "Modern",
          exactText: "Strike First",
        }),
        revisionTimeline: timelineFromImpacts([impact(["style"]), impact(["style"]), impact(["colors"])]),
        latestEvaluation: evaluation({
          required_wording: { passed: false, score: 0 },
          graphics: { passed: false, score: 5 },
        }),
        currentGeneration: { attemptNumber: 4, rejectedSections: ["printLocation"] },
      }),
    );

    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, forbiddenPattern);
  });

  it("never references a provider, model, or vendor name", () => {
    const plan = buildRegenerationPlan(
      baseInput({ latestEvaluation: evaluation({ style: { passed: false, score: 10 } }) }),
    );
    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /openai|gpt|dall-?e|stable diffusion|midjourney/i);
  });
});

describe("RegenerationIntelligenceCapability — regression scenarios", () => {
  it("combines exclusions, a superseding revision, an evaluation failure, and a rejected section coherently", () => {
    const plan = buildRegenerationPlan(
      baseInput({
        approvedBrief: brief({
          exclusions: "No profanity",
          designStyle: "Vintage",
          shirtColor: "Black",
        }),
        revisionTimeline: timelineFromImpacts([impact(["style"]), impact(["style"]), impact(["productColor"])]),
        latestEvaluation: evaluation({
          graphics: { passed: false, score: 20 },
          color_palette: { passed: true, score: 88 },
        }),
        currentGeneration: { attemptNumber: 3, rejectedSections: ["printLocation"] },
      }),
    );

    assert.ok(plan.avoid.some((c) => c.section === "exclusions"));
    assert.ok(plan.avoid.some((c) => c.section === "printLocation"));
    assert.ok(plan.replace.some((c) => c.section === "style"));
    assert.ok(plan.customerRequestedChanges.some((c) => c.section === "productColor"));
    assert.ok(plan.evaluationDrivenChanges.some((c) => c.section === "graphics"));
    assert.ok(plan.preserve.some((c) => c.section === "colors"));
    assert.equal(plan.generationAttempt, 3);
    assert.equal(plan.unchangedSections.includes("printLocation"), false);
    assert.equal(plan.unchangedSections.includes("product"), true);
  });

  it("does not mutate the input brief, evaluation, or revision timeline objects", () => {
    const approvedBrief = brief({ exclusions: "No skulls", designStyle: "Modern" });
    const latestEvaluation = evaluation({ style: { passed: false, score: 10 } });
    const revisionTimeline = timelineFromImpacts([impact(["style"])]);
    const before = JSON.stringify({ approvedBrief, latestEvaluation, revisionTimeline });

    buildRegenerationPlan(
      baseInput({ approvedBrief, latestEvaluation, revisionTimeline }),
    );

    assert.equal(
      JSON.stringify({ approvedBrief, latestEvaluation, revisionTimeline }),
      before,
    );
  });

  it("an empty revision timeline with an evaluation-only signal never invents a customer-requested change", () => {
    const plan = buildRegenerationPlan(
      baseInput({ latestEvaluation: evaluation({ style: { passed: false, score: 5 } }) }),
    );
    assert.deepEqual(plan.customerRequestedChanges, []);
    assert.ok(plan.evaluationDrivenChanges.some((c) => c.section === "style"));
  });
});

describe("RegenerationIntelligenceCapability — GenerationAttempt authority", () => {
  it("resolveGenerationAttemptNumber derives the next attempt solely from completed GenerationJobs", () => {
    assert.equal(resolveGenerationAttemptNumber([]), 1);
    assert.equal(
      resolveGenerationAttemptNumber([
        {
          id: "j1",
          projectId: "p",
          designBriefVersionId: "v",
          status: "completed",
          kind: "initial",
          conceptCount: 3,
          providerKey: "placeholder",
          idempotencyKey: "k1",
          attempts: 1,
          lastError: null,
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:01:00Z",
          heartbeatAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
        },
        {
          id: "j2",
          projectId: "p",
          designBriefVersionId: "v",
          status: "failed",
          kind: "regeneration",
          conceptCount: 3,
          providerKey: "placeholder",
          idempotencyKey: "k2",
          attempts: 3,
          lastError: "x",
          startedAt: null,
          completedAt: null,
          heartbeatAt: null,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ]),
      2,
    );
  });

  it("plan.generationAttempt mirrors currentGeneration.attemptNumber from GenerationJob-derived metadata", () => {
    const plan = buildRegenerationPlan(
      baseInput({ currentGeneration: { attemptNumber: 4 } }),
    );
    assert.equal(plan.generationAttempt, 4);
  });

  it("operates without RejectedConceptMemory (no rejectedSections)", () => {
    const plan = buildRegenerationPlan(baseInput());
    assert.deepEqual(plan.avoid, []);
  });
});
