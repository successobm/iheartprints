/**
 * Sprint 2J Phase 2: provider-neutral Regeneration Intelligence contracts.
 *
 * Regeneration Intelligence answers one question only: "what should change
 * in the NEXT generation attempt?" It does not generate artwork (that is
 * Prompt Translation + a `ConceptGenerationProvider`), and it does not
 * evaluate artwork (that is Concept Evaluation). It reads the approved
 * Design Brief, the most recent Concept Evaluation, and a derived
 * `RevisionTimeline` (never a persisted RevisionHistory), and produces a
 * `RegenerationPlan` — a provider-neutral instruction set.
 *
 * Pure and deterministic: same inputs in, same `RegenerationPlan` out. No
 * repository, no provider, no UI, no persistence, no clock reads. Plans are
 * always recomputed, never stored.
 */

import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type { RevisionTimeline } from "@/capabilities/revision-timeline";
import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";

/**
 * Mirrors `ArtworkVersion.evaluationStatus` / `evaluation` — the persisted,
 * provider-neutral evaluation payload for the most recent concept batch.
 * `null` when no concept has been evaluated yet (e.g. the very first
 * generation attempt for an approved brief version).
 */
export interface RegenerationConceptEvaluationInput {
  status: ConceptEvaluationStatus;
  result: ConceptEvaluation;
}

/**
 * Bookkeeping about the generation attempt a plan is being built for.
 *
 * ## GenerationAttempt authority
 *
 * `attemptNumber` MUST be derived from `GenerationJob` records via
 * `resolveGenerationAttemptNumber` (completed jobs + 1). `GenerationJob`
 * is the sole authoritative source. Do not maintain a parallel counter.
 *
 * Note: `GenerationJob.attempts` is a different field — the per-job
 * claim/retry budget used by the worker. It must not be copied into
 * `attemptNumber`.
 *
 * ## Rejected concepts (future)
 *
 * `rejectedSections` comes from `RejectedConceptMemory` when a future
 * sprint adds rejection capture. Until then, omit it or pass `[]` —
 * Regeneration Intelligence operates correctly with no rejection memory.
 */
export interface CurrentGenerationMetadata {
  /**
   * 1-based ordinal of the generation attempt being planned, derived from
   * completed `GenerationJob` rows (see `resolveGenerationAttemptNumber`).
   */
  attemptNumber: number;
  /**
   * Sections whose prior direction the customer has already explicitly
   * rejected. Supplied by the caller from `RejectedConceptMemory` when
   * available — Regeneration Intelligence has no persistence of its own.
   * Always routed to `avoid[]` when present. Gracefully ignored when empty.
   */
  rejectedSections?: BriefSectionKey[];
}

/** Full input to a single `planNextGeneration` call. */
export interface RegenerationIntelligenceInput {
  /** Frozen approved Design Brief snapshot content — never a working brief. */
  approvedBrief: DesignBriefSnapshotContent;
  /** Concept Evaluation for the current (most recent) concept batch, if any exists yet. */
  latestEvaluation: RegenerationConceptEvaluationInput | null;
  /**
   * Ephemeral timeline derived by RevisionTimelineCapability from immutable
   * records. Customer-revision events drive touch counts; older revisions
   * never override newer ones. Never a persisted RevisionHistory.
   */
  revisionTimeline: RevisionTimeline;
  currentGeneration: CurrentGenerationMetadata;
}

/** Where a single planned change originated. Never a provider identity. */
export type RegenerationChangeSource =
  | "customer_revision"
  | "evaluation"
  | "brief";

/**
 * One planned change (or preservation) for a single Design Brief section.
 * `description` and `reason` are plain-language and provider-neutral —
 * never prompt syntax, never a quality-boosting keyword.
 */
export interface RegenerationChange {
  section: BriefSectionKey;
  description: string;
  source: RegenerationChangeSource;
  reason: string;
}

/**
 * Provider-neutral regeneration plan. Prompt Translation consumes this to
 * build the next `GenerationPromptRequest` — this module never touches a
 * provider directly.
 */
export interface RegenerationPlan {
  /** Confirmed-working elements to carry forward unchanged. */
  preserve: RegenerationChange[];
  /** Elements present in the brief that should come through more clearly next time. */
  strengthen: RegenerationChange[];
  /** Elements the customer explicitly asked to drop. */
  remove: RegenerationChange[];
  /** Elements whose latest customer-requested value supersedes an earlier one. */
  replace: RegenerationChange[];
  /** Elements that must never appear — exclusions and previously rejected directions. */
  avoid: RegenerationChange[];
  /** Deterministically ordered subset — see priority rules in the capability module doc. */
  priorityChanges: RegenerationChange[];
  /** Regeneration-relevant sections with no signal to act on either way. */
  unchangedSections: BriefSectionKey[];
  /** Every regeneration-relevant section the customer touched since approval, regardless of status. */
  customerRequestedChanges: RegenerationChange[];
  /** Regeneration-relevant sections evaluation flagged as failed, that the customer did not already request a change to. */
  evaluationDrivenChanges: RegenerationChange[];
  /**
   * Copied from `currentGeneration.attemptNumber`, which must itself be
   * derived from GenerationJob (see GenerationAttempt authority).
   */
  generationAttempt: number;
  /** Plain-language, provider-neutral summary of why this plan looks the way it does. */
  reason: string;
}
