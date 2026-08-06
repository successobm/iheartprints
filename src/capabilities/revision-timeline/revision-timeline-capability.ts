import { sectionTitle } from "@/capabilities/shared/question-phrasing";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type {
  ArtworkVersion,
  ConceptEvaluation,
  ConceptEvaluationCriterionKey,
  DesignBriefVersion,
  GenerationJob,
} from "@/lib/domain/types";

import type {
  RevisionTimeline,
  RevisionTimelineEvent,
  RevisionTimelineInput,
  TimedRevisionImpact,
} from "./contracts";

/**
 * Revision Timeline (Sprint 2J Phase 2).
 *
 * Derives an ordered revision timeline from existing immutable records.
 * Pure and deterministic: same inputs → same timeline. No repository, no
 * persistence, no clock reads, no UI. The timeline is always ephemeral.
 *
 * Pipeline placement:
 *   RevisionIntelligence (produces RevisionImpact per change)
 *        ↓
 *   RevisionTimelineCapability.derive(...)
 *        ↓
 *   RegenerationIntelligenceCapability.planNextGeneration(...)
 *        ↓
 *   PromptTranslationCapability.translate(brief, plan?)
 *        ↓
 *   GenerationWorkerCapability
 *
 * ## GenerationAttempt authority
 *
 * `GenerationJob` is the sole authoritative source for generation-attempt
 * numbering. Timeline "Generation N" labels and
 * `resolveGenerationAttemptNumber` both derive from completed
 * `GenerationJob` rows ordered by `completedAt` / `createdAt`.
 *
 * Do **not** maintain a parallel attempt counter. Do **not** confuse this
 * with `GenerationJob.attempts`, which is the per-job claim/retry budget
 * (worker recovery), not the cross-job generation ordinal used by
 * Regeneration Intelligence.
 */
export interface RevisionTimelineCapability {
  derive(input: RevisionTimelineInput): RevisionTimeline;
}

export function createRevisionTimelineCapability(): RevisionTimelineCapability {
  return {
    derive(input) {
      return buildRevisionTimeline(input);
    },
  };
}

/**
 * 1-based ordinal for the *next* generation attempt, derived only from
 * completed GenerationJob records. Authoritative — never invent a second
 * counter.
 *
 * Example: zero completed jobs → attempt 1 (first generation). Two
 * completed jobs → attempt 3 (planning the third generation).
 */
export function resolveGenerationAttemptNumber(
  generationJobs: readonly GenerationJob[],
): number {
  return completedJobsInOrder(generationJobs).length + 1;
}

export function buildRevisionTimeline(
  input: RevisionTimelineInput,
): RevisionTimeline {
  const events: RevisionTimelineEvent[] = [
    ...generationEvents(input.generationJobs),
    ...customerRevisionEvents(
      input.revisionImpacts,
      input.designBriefVersions,
    ),
    ...evaluationEvents(input.generationJobs, input.artworkVersions),
  ];

  events.sort(compareEvents);

  return { events };
}

function completedJobsInOrder(
  generationJobs: readonly GenerationJob[],
): GenerationJob[] {
  return generationJobs
    .filter((job) => job.status === "completed")
    .slice()
    .sort((a, b) => {
      const timeA = a.completedAt ?? a.createdAt;
      const timeB = b.completedAt ?? b.createdAt;
      if (timeA !== timeB) return timeA < timeB ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function generationEvents(
  generationJobs: readonly GenerationJob[],
): RevisionTimelineEvent[] {
  return completedJobsInOrder(generationJobs).map((job, index) => {
    const attempt = index + 1;
    return {
      kind: "generation" as const,
      label: `Generation ${attempt}`,
      occurredAt: job.completedAt ?? job.createdAt,
      sequenceKey: `generation:${job.id}`,
      generationAttempt: attempt,
    };
  });
}

function customerRevisionEvents(
  revisionImpacts: readonly TimedRevisionImpact[],
  designBriefVersions: readonly DesignBriefVersion[],
): RevisionTimelineEvent[] {
  const versionById = new Map(
    designBriefVersions.map((version) => [version.id, version]),
  );
  const events: RevisionTimelineEvent[] = [];
  for (const timed of revisionImpacts) {
    if (timed.impact.isNoOp || timed.impact.changedSections.length === 0) {
      continue;
    }
    const sections = [...timed.impact.changedSections].sort(compareSectionKeys);
    const matchedVersion = versionById.get(timed.sourceId);
    const occurredAt =
      timed.occurredAt ||
      matchedVersion?.approvedAt ||
      matchedVersion?.createdAt ||
      timed.occurredAt;
    events.push({
      kind: "customer_revision",
      label: customerRevisionLabel(sections),
      occurredAt,
      sequenceKey: `customer_revision:${timed.sourceId}`,
      sections,
    });
  }
  return events;
}

/**
 * One evaluation milestone per completed generation job that has evaluated
 * concepts — not one event per concept card. Aggregate: any failed criterion
 * or failed status → evaluation_failed; otherwise passed when status/result
 * say so; pending/unevaluated jobs produce no event.
 */
function evaluationEvents(
  generationJobs: readonly GenerationJob[],
  artworkVersions: readonly ArtworkVersion[],
): RevisionTimelineEvent[] {
  const events: RevisionTimelineEvent[] = [];

  for (const job of completedJobsInOrder(generationJobs)) {
    const concepts = artworkVersions.filter(
      (art) => art.generationJobId === job.id && art.evaluation != null,
    );
    if (concepts.length === 0) continue;

    const failedSections = collectFailedSections(concepts);
    const allPassed = concepts.every(
      (art) =>
        art.evaluationStatus === "passed" || art.evaluation?.passed === true,
    );
    const anyFailed =
      failedSections.length > 0 ||
      concepts.some(
        (art) =>
          art.evaluationStatus === "failed" || art.evaluation?.passed === false,
      );

    const occurredAt =
      maxIso(
        concepts.map((art) => art.evaluationEvaluatedAt).filter(Boolean) as string[],
      ) ??
      job.completedAt ??
      job.createdAt;

    if (anyFailed) {
      events.push({
        kind: "evaluation_failed",
        label: evaluationFailedLabel(failedSections),
        occurredAt,
        sequenceKey: `evaluation_failed:${job.id}`,
        sections: failedSections.length > 0 ? failedSections : undefined,
      });
    } else if (allPassed) {
      events.push({
        kind: "evaluation_passed",
        label: "Evaluation passed",
        occurredAt,
        sequenceKey: `evaluation_passed:${job.id}`,
      });
    }
  }

  return events;
}

const CRITERION_TO_SECTION: Partial<
  Record<ConceptEvaluationCriterionKey, BriefSectionKey>
> = {
  required_wording: "requiredWording",
  style: "style",
  graphics: "graphics",
  color_palette: "colors",
  product_compatibility: "productColor",
  exclusions: "exclusions",
};

function collectFailedSections(
  concepts: readonly ArtworkVersion[],
): BriefSectionKey[] {
  const failed = new Set<BriefSectionKey>();
  for (const art of concepts) {
    const evaluation: ConceptEvaluation | null = art.evaluation;
    if (!evaluation) continue;
    for (const criterion of evaluation.criteria) {
      if (criterion.passed !== false) continue;
      const section = CRITERION_TO_SECTION[criterion.key];
      if (section) failed.add(section);
    }
  }
  return [...failed].sort(compareSectionKeys);
}

function customerRevisionLabel(sections: BriefSectionKey[]): string {
  if (sections.length === 1) {
    return `Customer changed ${sectionTitle(sections[0]!).toLowerCase()}`;
  }
  if (sections.length === 2) {
    return `Customer changed ${sectionTitle(sections[0]!).toLowerCase()} and ${sectionTitle(sections[1]!).toLowerCase()}`;
  }
  return "Customer changed the design";
}

function evaluationFailedLabel(sections: BriefSectionKey[]): string {
  if (sections.length === 1) {
    return `Evaluation failed ${sectionTitle(sections[0]!).toLowerCase()}`;
  }
  if (sections.length > 1) {
    return `Evaluation failed ${sections.map((s) => sectionTitle(s).toLowerCase()).join(", ")}`;
  }
  return "Evaluation failed";
}

function compareEvents(
  a: RevisionTimelineEvent,
  b: RevisionTimelineEvent,
): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? -1 : 1;
  }
  // Same timestamp: generations before their evaluation; revisions by key.
  const kindOrder = kindSortIndex(a.kind) - kindSortIndex(b.kind);
  if (kindOrder !== 0) return kindOrder;
  return a.sequenceKey < b.sequenceKey
    ? -1
    : a.sequenceKey > b.sequenceKey
      ? 1
      : 0;
}

function kindSortIndex(kind: RevisionTimelineEvent["kind"]): number {
  switch (kind) {
    case "customer_revision":
      return 0;
    case "generation":
      return 1;
    case "evaluation_failed":
    case "evaluation_passed":
      return 2;
    default:
      return 3;
  }
}

const SECTION_SORT_ORDER: BriefSectionKey[] = [
  "exclusions",
  "requiredWording",
  "product",
  "productColor",
  "colors",
  "style",
  "graphics",
  "printLocation",
  "audience",
  "purpose",
  "additionalNotes",
  "references",
  "production",
  "layoutPreference",
];

function compareSectionKeys(a: BriefSectionKey, b: BriefSectionKey): number {
  const ia = SECTION_SORT_ORDER.indexOf(a);
  const ib = SECTION_SORT_ORDER.indexOf(b);
  const sa = ia === -1 ? SECTION_SORT_ORDER.length : ia;
  const sb = ib === -1 ? SECTION_SORT_ORDER.length : ib;
  if (sa !== sb) return sa - sb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxIso(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((best, next) => (next > best ? next : best));
}
