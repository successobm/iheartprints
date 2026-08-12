/**
 * Phase 2C0.5: server-side-only observability for every paid-image
 * DECISION, extending the Phase 2C0 `[concept-generation] paid-image-call`
 * line that only ever fired once a call had already been made.
 *
 * The point of this module is reconstructability: from these lines alone an
 * operator must be able to answer "why was this image paid for — or why was
 * it not?" for any generation job, including after a crash and a reclaim.
 * That means a line is emitted for the decisions that DON'T spend money
 * (reuse, budget block) just as much as for the one that does.
 *
 * Whitelisted fields only. Never an API key, never an authorization header,
 * never image bytes, never prompt text, never any customer secret. The
 * intent key is composed exclusively of internal identifiers (project id,
 * job id, direction, epoch) — no customer content is encoded in it.
 */

/**
 * What was decided about one logical paid image intent, at the moment it
 * was decided.
 *
 *   "paid_call"               a genuinely new logical intent; a paid
 *                             provider dispatch is about to happen.
 *   "reused_completed_intent" this intent already succeeded durably; the
 *                             stored result is being reused and NO paid
 *                             call is made.
 *   "retry_same_intent"       a previous dispatch of THIS SAME intent left
 *                             no durable image (crash, storage failure,
 *                             ambiguous transport failure). A bounded
 *                             re-dispatch of the same intent — never a new
 *                             one, so it never consumes budget.
 *   "blocked_budget"          the job's paid-intent ceiling is reached.
 *                             Refused BEFORE the provider is contacted.
 */
export type PaidImageDecision =
  | "paid_call"
  | "reused_completed_intent"
  | "retry_same_intent"
  | "blocked_budget";

export interface PaidImageIntentDecisionLogDetails {
  projectId: string;
  generationJobId: string;
  /** `GenerationJob.attempts` — which claim of the job this is. */
  jobAttempt: number;
  logicalPaidIntentKey: string;
  directionKey: string;
  /** `"initial_concept" | "targeted_revision" | "replacement"`. */
  generationKind: string;
  decision: PaidImageDecision;
  /**
   * Which provider dispatch of THIS logical intent this is (1-based), across
   * every worker and reclaim. `0` when no dispatch is happening (reuse or a
   * budget block).
   */
  transportAttempt: number;
  /** Budget bookkeeping, so a block is explainable without a second query. */
  paidIntentOrdinal: number | null;
  paidIntentBudget: number;
  providerKey: string | null;
  /** Resolution-affecting production settings, when the caller knows them. */
  model?: string | null;
  quality?: string | null;
  size?: string | null;
  /** Present only once the provider has answered. */
  providerRequestId?: string | null;
}

/** Never customer-facing. Whitelisted fields only — see module doc. */
export function logPaidImageIntentDecision(
  details: PaidImageIntentDecisionLogDetails,
): void {
  console.info("[concept-generation] paid-image-intent", {
    projectId: details.projectId,
    generationJobId: details.generationJobId,
    jobAttempt: details.jobAttempt,
    logicalPaidIntentKey: details.logicalPaidIntentKey,
    directionKey: details.directionKey,
    generationKind: details.generationKind,
    decision: details.decision,
    transportAttempt: details.transportAttempt,
    paidIntentOrdinal: details.paidIntentOrdinal,
    paidIntentBudget: details.paidIntentBudget,
    providerKey: details.providerKey,
    model: details.model ?? null,
    quality: details.quality ?? null,
    size: details.size ?? null,
    providerRequestId: details.providerRequestId ?? null,
  });
}

export interface PaidImageIntentOutcomeLogDetails {
  projectId: string;
  generationJobId: string;
  logicalPaidIntentKey: string;
  directionKey: string;
  transportAttempt: number;
  /** `"succeeded"` means the bytes are durably persisted, not merely returned. */
  outcome: "succeeded" | "failed" | "fenced_out";
  providerRequestId?: string | null;
  /** Sanitized classification only — never a raw provider error body. */
  failureClassification?: string | null;
}

/**
 * The other half of the record: what actually became of a dispatch. Paired
 * with the decision line by `logicalPaidIntentKey` + `transportAttempt`.
 *
 * `"fenced_out"` is the zombie-worker case — a worker whose job was
 * reclaimed while it was still running finished its paid call and was
 * refused the durable write. Worth its own outcome because it is the one
 * state where money was spent and the resulting image is deliberately
 * discarded in favour of the live worker's.
 */
export function logPaidImageIntentOutcome(
  details: PaidImageIntentOutcomeLogDetails,
): void {
  console.info("[concept-generation] paid-image-intent-outcome", {
    projectId: details.projectId,
    generationJobId: details.generationJobId,
    logicalPaidIntentKey: details.logicalPaidIntentKey,
    directionKey: details.directionKey,
    transportAttempt: details.transportAttempt,
    outcome: details.outcome,
    providerRequestId: details.providerRequestId ?? null,
    failureClassification: details.failureClassification ?? null,
  });
}
