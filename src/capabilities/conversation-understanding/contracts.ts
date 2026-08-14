/**
 * Sprint 2L Phase 1: provider-neutral Conversation Understanding contracts.
 *
 * Conversation Understanding answers one question only: "what did the
 * customer mean, in context?" It never mutates the Design Brief, never
 * decides what to ask next, and never persists anything on its own —
 * `IntentExtractionCapability` (via `reconcile-understanding.ts`) validates
 * and normalizes this output into the same `BriefPatchProposal` shape
 * deterministic extraction already produces, so there is exactly one
 * authoritative path from "customer said something" to "Design Brief
 * changed" (see `capability-boundaries.ts`).
 *
 * These contracts are pure data. A provider adapter receives/returns them
 * and owns 100% of its own prompt dialect internally — never here.
 *
 * Security/privacy (see ARCHITECTURE.md §Conversation Understanding):
 *   - `evidence` is short customer-text only — never chain-of-thought,
 *     never provider reasoning.
 *   - `confidence` is a coarse three-value enum, never a numeric score —
 *     it must never become customer-facing and is never persisted.
 *   - Nothing here is ever persisted verbatim; only the *validated,
 *     reconciled* Design Brief fields it produces are ever written, exactly
 *     like every other `BriefPatchProposal` source.
 */

import type { IpSafetySignal } from "@/capabilities/ip-safety/contracts";
import type { DesignSummaryView } from "@/capabilities/shared/contracts";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";

/**
 * Deliberately three coarse buckets, not a numeric score (Goal 7):
 *   - "explicit"  — the customer directly stated this.
 *   - "inferred"  — strongly implied by language/context; safe to apply.
 *   - "ambiguous" — plausible, but not safe to apply without asking.
 * An "ambiguous" proposed update is never applied to the Design Brief — see
 * `reconcile-understanding.ts`. This is what turns Goal 6 ("ask when
 * uncertainty is real") into code rather than a prompt-only hope.
 */
export type UnderstandingConfidence = "explicit" | "inferred" | "ambiguous";

export interface ProposedFieldUpdate {
  section: BriefSectionKey;
  /**
   * Plain-language value. For multi-value sections (`colors`) a
   * comma/"and"-separated list; reconciliation splits it the same way the
   * deterministic pending-section fallback already does. For
   * `requiredWording`, `""` means an explicit, confident "no wording" — see
   * `reconcile-understanding.ts` for the guard on when that is honored.
   */
  value: string;
  confidence: UnderstandingConfidence;
  /**
   * Short, bounded, verbatim-or-near-verbatim quote from the customer's
   * message that grounds this update. Required-wording updates are only
   * ever accepted when `value` is actually contained in `evidence` — this
   * is the concrete guard against a paraphrased or hallucinated required
   * wording reaching the brief (Goal 8 / Constitution §6.12).
   */
  evidence: string;
  /** True when this update corrects a previously different value, not merely provides a new one. */
  isCorrection: boolean;
}

export interface ProposedDeferral {
  section: BriefSectionKey;
  evidence: string;
}

/** A section the interpretation could not confidently resolve — never silently guessed at. */
export interface UnderstandingAmbiguity {
  section: BriefSectionKey | "general";
  /** Short, plain-language, customer-safe description — never chain-of-thought. */
  note: string;
}

export type CustomerIntent =
  | "provide_info"
  | "correct"
  | "defer"
  | "approve"
  | "request_revision"
  | "ask_question"
  | "unclear";

/**
 * What a `ConversationUnderstandingProvider` returns. Never persisted
 * verbatim — see module doc.
 *
 * Deliberately no separate `corrections` array: a correction is still a
 * `ProposedFieldUpdate`, just one with `isCorrection: true` — duplicating it
 * into a second list would let the two disagree about the same field for no
 * benefit (Goal 2: "choose the smallest correct contract").
 */
export interface ConversationUnderstandingResult {
  proposedUpdates: ProposedFieldUpdate[];
  deferrals: ProposedDeferral[];
  ambiguities: UnderstandingAmbiguity[];
  customerIntent: CustomerIntent;
  /**
   * The section the customer's message answers, when a question was
   * pending and this reply resolves it. Informational/corroborating only —
   * reconciliation still requires the actual value to appear in
   * `proposedUpdates`; this field never independently applies a value.
   */
  answeredPendingSection: BriefSectionKey | null;
  /**
   * Sprint A3: what this message appears to ask us to create with respect to
   * third-party protected branding — carried on the ONE semantic
   * interpretation call the turn already makes, so the IP safety boundary
   * costs no additional paid model call (Goal 16).
   *
   * A HINT ONLY. It is type-only coupling to `@/capabilities/ip-safety`
   * (contracts, not the capability), Conversation Understanding never
   * interprets it, never enforces it, and never persists it — exactly like
   * every other field here. `IpSafetyCapability` decides; the deterministic
   * detector is the floor and the sole input to the pre-provider fence,
   * because this field is absent whenever no provider is configured, the
   * call is skipped, or the provider fails.
   *
   * OPTIONAL by design: a provider that says nothing about IP is reporting
   * the common case, and every consumer must already behave identically
   * whether the field is absent or `null`.
   */
  ipSignal?: IpSafetySignal | null;
}

/** A result meaning "nothing understood" — the safe default on skip/failure/malformed output. */
export const EMPTY_UNDERSTANDING_RESULT: ConversationUnderstandingResult = {
  proposedUpdates: [],
  deferrals: [],
  ambiguities: [],
  customerIntent: "unclear",
  answeredPendingSection: null,
  ipSignal: null,
};

/** One prior turn in the bounded conversation window sent to a provider. */
export interface BoundedConversationTurn {
  role: "customer" | "assistant";
  /** Truncated plain text only — no metadata, ids, or structured payloads. */
  text: string;
}

/**
 * Provider-neutral, bounded, customer-safe interpretation request.
 *
 * Bounded-context policy (Goal 4 / Goal 12 — see ARCHITECTURE.md):
 *   - `knownBrief` carries only sections already resolved, in the exact
 *     plain-language form the customer would see in a Design Summary — the
 *     same `DesignSummaryView` shape, never raw brief ids/timestamps.
 *   - `recentTurns` is capped to the last few turns (see
 *     `conversation-understanding-capability.ts`), each truncated, role +
 *     text only.
 *   - Never includes storage object keys, signed asset URLs, GenerationJob
 *     internals, provider metadata, evaluation internals, secrets, or any
 *     other project's data.
 */
export interface ConversationUnderstandingRequest {
  message: string;
  knownBrief: DesignSummaryView;
  unresolvedSections: BriefSectionKey[];
  pendingSection: BriefSectionKey | null;
  recentTurns: BoundedConversationTurn[];
}
