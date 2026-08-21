/**
 * Sprint 2J Phase 3: assemble a GenerationIntent for a claimed generation
 * job. Pure orchestration helpers — no persistence of timeline/plan/intent.
 *
 * Initial jobs → brief-only intent (no timeline, no plan).
 * Regeneration jobs → RevisionTimeline → RegenerationPlan → intent with plan.
 */

import type {
  ArtworkVersion,
  ConceptEvaluationStatus,
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  GenerationJob,
  ProjectSnapshot,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type { RevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import {
  createRevisionTimelineCapability,
  resolveGenerationAttemptNumber,
  type RevisionTimelineCapability,
  type TimedRevisionImpact,
} from "@/capabilities/revision-timeline";
import {
  createRegenerationIntelligenceCapability,
  type RegenerationConceptEvaluationInput,
  type RegenerationIntelligenceCapability,
} from "@/capabilities/regeneration-intelligence";
import {
  createInitialGenerationIntent,
  createRegenerationGenerationIntent,
  type GenerationIntent,
} from "@/capabilities/prompt-translation";

export interface BuildGenerationIntentDeps {
  revisionIntelligence: RevisionIntelligenceCapability;
  revisionTimeline?: RevisionTimelineCapability;
  regenerationIntelligence?: RegenerationIntelligenceCapability;
}

/**
 * Build the provider-neutral GenerationIntent for this claimed job.
 * Never mutates the approved brief. Never persists timeline/plan/intent.
 */
export function buildGenerationIntentForJob(input: {
  job: GenerationJob;
  approvedVersion: DesignBriefVersion;
  project: ProjectSnapshot;
  generationJobs: GenerationJob[];
  deps: BuildGenerationIntentDeps;
}): GenerationIntent {
  const { job, approvedVersion, project, generationJobs, deps } = input;

  if (job.kind === "initial") {
    return createInitialGenerationIntent(approvedVersion.content);
  }

  const revisionTimeline =
    deps.revisionTimeline ?? createRevisionTimelineCapability();
  const regenerationIntelligence =
    deps.regenerationIntelligence ?? createRegenerationIntelligenceCapability();

  const versions = [...project.designBriefVersions].sort(
    (a, b) => a.versionNumber - b.versionNumber,
  );
  const timedImpacts = deriveTimedRevisionImpacts(
    versions,
    deps.revisionIntelligence,
  );

  const timeline = revisionTimeline.derive({
    designBriefVersions: versions,
    generationJobs,
    artworkVersions: project.artworkVersions,
    revisionImpacts: timedImpacts,
  });

  const latestEvaluation = latestEvaluationFromPriorGeneration(
    generationJobs,
    project.artworkVersions,
    job.id,
  );

  const plan = regenerationIntelligence.planNextGeneration({
    approvedBrief: approvedVersion.content,
    latestEvaluation,
    revisionTimeline: timeline,
    currentGeneration: {
      attemptNumber: resolveGenerationAttemptNumber(generationJobs),
    },
  });

  // Sprint 2G Live Acceptance Corrective Pass: a targeted single-concept
  // revision must regenerate in the SAME catalog direction the customer
  // already selected — resolved from the source artwork's own persisted
  // `conceptDirectionKey`, never re-derived or guessed.
  const targetConceptDirectionKey = job.targetArtworkVersionId
    ? (project.artworkVersions.find((a) => a.id === job.targetArtworkVersionId)
        ?.conceptDirectionKey ?? null)
    : null;

  // True Source-Image Targeted Revision: the customer's literal requested
  // delta, durable on the job itself. Only meaningful for a targeted
  // revision — a three-direction regeneration has no single source concept
  // to apply a delta to.
  const revisionInstruction = job.targetArtworkVersionId
    ? (job.revisionInstruction?.trim() || null)
    : null;

  return createRegenerationGenerationIntent(
    approvedVersion.content,
    plan,
    targetConceptDirectionKey,
    revisionInstruction,
  );
}

function deriveTimedRevisionImpacts(
  versions: DesignBriefVersion[],
  revisionIntelligence: RevisionIntelligenceCapability,
): TimedRevisionImpact[] {
  const impacts: TimedRevisionImpact[] = [];
  for (let i = 1; i < versions.length; i += 1) {
    const previous = versions[i - 1]!;
    const current = versions[i]!;
    const impact = revisionIntelligence.analyze(
      snapshotAsBrief(previous),
      snapshotAsBrief(current),
    );
    impacts.push({
      impact,
      occurredAt: current.approvedAt,
      sourceId: current.id,
    });
  }
  return impacts;
}

function snapshotAsBrief(version: DesignBriefVersion): TShirtDesignBrief {
  const content: DesignBriefSnapshotContent = version.content;
  return {
    id: version.briefId,
    projectId: version.projectId,
    customerName: null,
    projectName: null,
    productSummary: content.productSummary,
    designDescription: content.designDescription,
    exactText: content.exactText,
    shirtColor: content.shirtColor,
    printPlacement: content.printPlacement,
    intendedPrintWidthIn: null,
    // Sprint A2: `null`, exactly like `intendedPrintWidthIn` above and for
    // the same reason — both are production specifications that the approved
    // creative snapshot deliberately does not carry. Generation must not
    // depend on either: which artifact a customer asked us to produce cannot
    // change what the artwork looks like.
    requestedProductionOutput: null,
    // Print'em All Phase 1: `null` for the same reason again. Garment size
    // class and production-size confirmation are production specifications,
    // not creative content, so the approved creative snapshot does not carry
    // them and generation must not see them. Reconstructing a brief here that
    // claimed a confirmation would be the worst possible place to fabricate
    // one — this object exists purely to describe what the artwork should
    // look like, and it has no business authorizing spend.
    garmentSizeClass: null,
    productionSizeConfirmedAt: null,
    productionSizeConfirmedWidthIn: null,
    productionSizeConfirmedMaxHeightIn: null,
    preferredColors: content.preferredColors,
    designStyle: content.designStyle,
    additionalInstructions: content.additionalInstructions,
    audience: content.audience,
    purpose: content.purpose,
    exclusions: content.exclusions,
    deferredSections: content.deferredSections,
    createdAt: version.createdAt,
    updatedAt: version.approvedAt,
  };
}

function latestEvaluationFromPriorGeneration(
  generationJobs: readonly GenerationJob[],
  artworkVersions: readonly ArtworkVersion[],
  currentJobId: string,
): RegenerationConceptEvaluationInput | null {
  const priorCompleted = generationJobs
    .filter((job) => job.status === "completed" && job.id !== currentJobId)
    .slice()
    .sort((a, b) => {
      const timeA = a.completedAt ?? a.createdAt;
      const timeB = b.completedAt ?? b.createdAt;
      if (timeA !== timeB) return timeA < timeB ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const lastJob = priorCompleted[priorCompleted.length - 1];
  if (!lastJob) return null;

  const evaluated = artworkVersions.find(
    (art) =>
      art.generationJobId === lastJob.id &&
      art.evaluation != null &&
      art.evaluationStatus != null,
  );
  if (!evaluated?.evaluation || !evaluated.evaluationStatus) return null;

  return {
    status: evaluated.evaluationStatus as ConceptEvaluationStatus,
    result: evaluated.evaluation,
  };
}
