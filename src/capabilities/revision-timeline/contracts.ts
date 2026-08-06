/**
 * Sprint 2J Phase 2: Revision Timeline contracts.
 *
 * RevisionTimelineCapability derives an ordered, ephemeral revision timeline
 * from existing immutable records. The timeline is always recomputable and
 * never persisted — there is no `revision_history` table and no mutable
 * history model.
 *
 * Events are pure domain language ("Generation 1", "Customer changed
 * wording", "Evaluation failed wording"). Never provider names, never
 * prompt dialect, never job/asset ids in customer-facing labels.
 */

import type {
  ArtworkVersion,
  DesignBriefVersion,
  GenerationJob,
} from "@/lib/domain/types";
import type { BriefSectionKey, RevisionImpact } from "@/capabilities/shared/contracts";

/** Domain event kinds — product language only. */
export type RevisionTimelineEventKind =
  | "generation"
  | "customer_revision"
  | "evaluation_failed"
  | "evaluation_passed";

/**
 * One milestone on the revision timeline. Labels are plain-language and
 * provider-neutral. `occurredAt` / `sequenceKey` exist only for
 * deterministic ordering — they are not customer-facing copy.
 */
export interface RevisionTimelineEvent {
  kind: RevisionTimelineEventKind;
  /** Plain-language domain label, e.g. "Generation 1". */
  label: string;
  /** ISO timestamp derived from the underlying immutable record. */
  occurredAt: string;
  /** Stable secondary sort key so equal timestamps stay deterministic. */
  sequenceKey: string;
  /** Sections involved, when applicable. */
  sections?: BriefSectionKey[];
  /**
   * 1-based generation ordinal when `kind === "generation"`.
   * Derived from GenerationJob ordering — see `resolveGenerationAttemptNumber`.
   */
  generationAttempt?: number;
}

/** Ephemeral, recomputable timeline. Never stored. */
export interface RevisionTimeline {
  events: RevisionTimelineEvent[];
}

/**
 * A RevisionImpact positioned in time. Impacts themselves are never
 * persisted as history — callers recompute them from consecutive brief
 * snapshots via RevisionIntelligenceCapability and pass them here.
 */
export interface TimedRevisionImpact {
  impact: RevisionImpact;
  /** When this revision occurred (typically the new brief version's approvedAt). */
  occurredAt: string;
  /** Stable id for sequenceKey (typically the new DesignBriefVersion.id). */
  sourceId: string;
}

/**
 * All inputs are existing immutable / recomputed records. Concept
 * evaluations are read from `ArtworkVersion.evaluation` /
 * `evaluationStatus` — there is no separate evaluation table input.
 */
export interface RevisionTimelineInput {
  designBriefVersions: DesignBriefVersion[];
  generationJobs: GenerationJob[];
  artworkVersions: ArtworkVersion[];
  revisionImpacts: TimedRevisionImpact[];
}

/**
 * Future interface for customer-rejected concept directions.
 *
 * No rejection persistence exists today. Callers pass `null` or
 * `EMPTY_REJECTED_CONCEPT_MEMORY`. A future sprint may populate this from
 * durable records without inventing a parallel revision-history model.
 */
export interface RejectedConceptMemory {
  rejectedSections: BriefSectionKey[];
}

export const EMPTY_REJECTED_CONCEPT_MEMORY: RejectedConceptMemory = {
  rejectedSections: [],
};
