/**
 * Sprint 2J Phase 1: provider-neutral Regeneration Intelligence contracts.
 *
 * Regeneration Intelligence answers one question only: "what should change
 * in the NEXT generation attempt?" It does not generate artwork (that is
 * Prompt Translation + a `ConceptGenerationProvider`), and it does not
 * evaluate artwork (that is Concept Evaluation). It reads the approved
 * Design Brief, the most recent Concept Evaluation, and the revision
 * history since that brief was approved, and produces a `RegenerationPlan`
 * — a provider-neutral instruction set. The provider (via Prompt
 * Translation) later decides *how* to realize that plan; this module must
 * never contain prompt dialect or quality-boosting language of any kind
 * ("masterpiece", "8k", "highly detailed", etc.).
 *
 * Pure and deterministic: same inputs in, same `RegenerationPlan` out. No
 * repository, no provider, no UI, no persistence, no clock reads. Plans are
 * always recomputed, never stored.
 */

import type {
  BriefSectionKey,
  RevisionImpact,
} from "@/capabilities/shared/contracts";
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
 * Supplied by the caller — this capability never counts attempts itself
 * (no repository access) and never remembers anything between calls (no
 * persistence).
 */
export interface CurrentGenerationMetadata {
  /** 1-based count of generation attempts already made for this approved brief version. */
  attemptNumber: number;
  /**
   * Sections whose prior direction the customer has already explicitly
   * rejected (e.g. asked to move away from), across any point in this
   * design's history. Supplied by the caller — Regeneration Intelligence
   * has no persistence of its own to derive this. Always routed to
   * `avoid[]`, regardless of what the brief or evaluation currently say.
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
   * Chronological (oldest → newest) `RevisionImpact` entries produced by
   * Revision Intelligence since the approved brief was generated against.
   * A section appearing in more than one entry means a later customer
   * revision superseded an earlier one for that section.
   */
  revisionHistory: RevisionImpact[];
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
 * Provider-neutral regeneration plan. Prompt Translation consumes this
 * (in a later sprint) to build the next `GenerationPromptRequest` — this
 * module never touches Prompt Translation or a provider directly.
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
  /** Deterministically ordered subset of the above — see priority rules in the capability module doc. */
  priorityChanges: RegenerationChange[];
  /** Regeneration-relevant sections with no signal to act on either way. */
  unchangedSections: BriefSectionKey[];
  /** Every regeneration-relevant section the customer touched since approval, regardless of status. */
  customerRequestedChanges: RegenerationChange[];
  /** Regeneration-relevant sections evaluation flagged as failed, that the customer did not already request a change to. */
  evaluationDrivenChanges: RegenerationChange[];
  generationAttempt: number;
  /** Plain-language, provider-neutral summary of why this plan looks the way it does. */
  reason: string;
}
