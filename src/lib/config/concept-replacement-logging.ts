/**
 * Phase 2C: server-side-only observability for AUTOMATIC HARD-FAIL CONCEPT
 * REPLACEMENT.
 *
 * The Phase 2C0.5 paid-intent lines already answer "was this image paid for,
 * and why?". They cannot answer "why did this direction get replaced, and
 * what happened to the replacement?" — that decision is made from an
 * evaluation verdict the spend layer never sees. This module is the second
 * half of the record, joinable to the first by `logicalPaidIntentKey`.
 *
 * From these lines alone an operator must be able to reconstruct, for any
 * generation job:
 *
 *   initial direction verdict → hard fail → replacement requested
 *     → which paid ordinal it took, and what remained of the budget
 *     → the replacement's own verdict
 *     → accepted / accepted-unverified / rejected
 *     → and, when a customer received fewer than three concepts, exactly why
 *
 * Whitelisted fields only. Never prompt text, never image bytes, never an
 * API key, never a customer secret. `directionKey` is a catalog constant;
 * every id here is internal.
 */

import type { ReplacementSkipReason } from "@/capabilities/generation-worker/hard-palette-replacement-policy";

/** What was decided about one direction's automatic replacement. */
export type ConceptReplacementDecision =
  /** A hard failure was detected and a replacement is about to be reserved. */
  | "replacement_requested"
  /** A replacement image exists (freshly bought OR reused after a reclaim). */
  | "replacement_generated"
  /** The replacement is customer-visible as evaluated. */
  | "replacement_accepted"
  /** Customer-visible, but downgraded to needs_review (unverified palette). */
  | "replacement_accepted_unverified"
  /** No replacement is shown, and no further generation is attempted. */
  | "replacement_rejected"
  /** No replacement could be attempted at all — see `skipReason`. */
  | "replacement_unavailable";

export interface ConceptReplacementLogDetails {
  projectId: string;
  generationJobId: string;
  /** `GenerationJob.attempts` — which claim of the job this is. */
  jobAttempt: number;
  directionKey: string;
  /** The logical paid intent of the candidate being replaced. */
  replacedPaidIntentKey: string;
  /** The replacement's own logical paid intent identity. */
  replacementPaidIntentKey: string;
  /** Always 1 in this phase — one automatic replacement per direction. */
  replacementEpoch: number;
  decision: ConceptReplacementDecision;
  /** Phase 2B verdict on the candidate being replaced. Always `"fail"` here. */
  deterministicStatusBefore: string;
  /** Phase 2B verdict on the replacement. `null` until one is evaluated. */
  deterministicStatusAfter: string | null;
  /** Budget bookkeeping, so a block is explainable without a second query. */
  paidIntentOrdinal: number | null;
  paidIntentBudget: number;
  /** Slots left in this job's durable paid-intent budget after this decision. */
  paidIntentBudgetRemaining: number | null;
  /** True only when this decision cost money; false on a reclaim reuse. */
  paidCallMade: boolean | null;
  providerKey: string | null;
  /** Resolution-affecting production settings, when the caller knows them. */
  model?: string | null;
  quality?: string | null;
  providerRequestId?: string | null;
  skipReason?: ReplacementSkipReason | null;
}

/** Never customer-facing. Whitelisted fields only — see module doc. */
export function logConceptReplacement(
  details: ConceptReplacementLogDetails,
): void {
  console.info("[concept-generation] hard-palette-replacement", {
    projectId: details.projectId,
    generationJobId: details.generationJobId,
    jobAttempt: details.jobAttempt,
    directionKey: details.directionKey,
    replacedPaidIntentKey: details.replacedPaidIntentKey,
    replacementPaidIntentKey: details.replacementPaidIntentKey,
    replacementEpoch: details.replacementEpoch,
    decision: details.decision,
    deterministicStatusBefore: details.deterministicStatusBefore,
    deterministicStatusAfter: details.deterministicStatusAfter,
    paidIntentOrdinal: details.paidIntentOrdinal,
    paidIntentBudget: details.paidIntentBudget,
    paidIntentBudgetRemaining: details.paidIntentBudgetRemaining,
    paidCallMade: details.paidCallMade,
    providerKey: details.providerKey,
    model: details.model ?? null,
    quality: details.quality ?? null,
    providerRequestId: details.providerRequestId ?? null,
    skipReason: details.skipReason ?? null,
  });
}

export interface ConceptSetOutcomeLogDetails {
  projectId: string;
  generationJobId: string;
  /** What the job was enqueued to produce. */
  requestedConceptCount: number;
  /** What the customer will actually be shown. */
  deliveredConceptCount: number;
  /** Directions withheld because a hard failure could not be resolved. */
  withheldDirectionKeys: string[];
  /** Directions whose customer-visible concept IS a replacement. */
  replacedDirectionKeys: string[];
  /** Total logical paid intents this job has consumed, of its budget. */
  paidIntentsUsed: number;
  paidIntentBudget: number;
}

/**
 * The single closing line for a concept set. Emitted on every completed
 * generation, not only degraded ones, so "three delivered, nothing withheld"
 * is a positive record rather than an absence of evidence.
 */
export function logConceptSetOutcome(
  details: ConceptSetOutcomeLogDetails,
): void {
  console.info("[concept-generation] concept-set-outcome", {
    projectId: details.projectId,
    generationJobId: details.generationJobId,
    requestedConceptCount: details.requestedConceptCount,
    deliveredConceptCount: details.deliveredConceptCount,
    withheldDirectionKeys: details.withheldDirectionKeys,
    replacedDirectionKeys: details.replacedDirectionKeys,
    paidIntentsUsed: details.paidIntentsUsed,
    paidIntentBudget: details.paidIntentBudget,
  });
}
