/**
 * Sprint A3 — IP / trademark safety contracts.
 *
 * WHAT THIS IS
 *
 * A PRODUCT SAFETY BOUNDARY: iHeartPrints will not knowingly help a customer
 * create artwork that reproduces, or deliberately imitates, recognizable
 * third-party protected branding — and it will not help a customer evade
 * those protections.
 *
 * WHAT THIS IS NOT
 *
 * It is NOT a legal-clearance system. Nothing here determines, asserts, or
 * implies that artwork is legally safe, licensed, trademark-cleared,
 * copyright-cleared, or owned by anybody. An `"allow"` decision means only
 * "this request does not trip the product boundary" — never "this is legal".
 * A `"block"` decision means only "iHeartPrints will not produce this" —
 * never "you are infringing".
 *
 * SEPARATE FROM OWNERSHIP. `OwnershipCapability` is future provenance /
 * licensing architecture (Constitution §17). IP Safety is a
 * generation/use-policy gate that runs BEFORE paid generation. The two must
 * never be merged: an ownership classification is not trademark or copyright
 * verification, and a passing IP Safety decision is not an ownership claim.
 *
 * SEPARATE FROM PROVIDER SAFETY. A concept-generation provider runs its own,
 * independent safety systems. This boundary is strictly ADDITIVE and sits in
 * front of them so that a request iHeartPrints will not make is never paid
 * for:
 *
 *     customer intent
 *       → iHeartPrints IP safety   (this capability — deterministic)
 *       → allowed generation request
 *       → the provider's own safety systems
 *       → result
 *
 * These contracts are pure data. Nothing here is persisted, and nothing here
 * is ever customer-facing — see `customer-response.ts`, which is the one and
 * only place a decision becomes language a customer reads.
 */

/**
 * Deliberately two values, not three.
 *
 * A `"review"` outcome was considered and rejected: iHeartPrints has no
 * manual-review queue, no reviewer role, no review surface, and no state a
 * project could sit in while a human looked at it. Adding the enum value
 * would have created a review workflow that does not exist — a request would
 * either silently behave as `"allow"` (and reach a paid provider) or
 * silently behave as `"block"` (and dead-end with no way out). Either is
 * worse than saying plainly that the product supports two answers today.
 */
export type IpSafetyOutcome = "allow" | "block";

/**
 * INTERNAL machine-readable reasons. Never rendered, never returned to a
 * customer, never placed in a `ProjectSnapshot`, a conversation message, or
 * message metadata — `customer-response.ts` owns everything a customer sees,
 * and it deliberately produces the SAME redirect for every reason so that
 * the classification cannot be inferred from the wording either.
 */
export type IpSafetyReason =
  /** Asked to produce a specific, named third-party mark (logo, emblem, crest, wordmark). */
  | "third_party_mark_reproduction"
  /** Asked to produce something recognizably the same as a third-party mark without naming reproduction outright. */
  | "recognizable_mark_imitation"
  /** Asked to depict a protected third-party character, mascot, or franchise property. */
  | "protected_character_reproduction"
  /** Asked to help circumvent trademark/copyright protection (alter "just enough", strip a ™/®, make a knockoff). */
  | "protection_evasion_request";

/**
 * One deterministic detection hit. `evidence` is a short span of the
 * customer's own text, kept for internal diagnostics only — it is never
 * logged with the message, never persisted, and never surfaced.
 */
export interface IpSafetyFinding {
  reason: IpSafetyReason;
  evidence: string;
}

/**
 * The decision. Structured, derived, and never persisted: it is recomputed
 * from whatever the current generation intent actually is, so a customer who
 * revises an unsafe request into a safe one is generating again on the very
 * next evaluation. Nothing about a blocked request is durable, which is what
 * makes "a project is never permanently poisoned" a structural property
 * rather than a policy.
 */
export interface IpSafetyDecision {
  outcome: IpSafetyOutcome;
  /** Internal only — see `IpSafetyReason`. Empty for `"allow"`. */
  reasons: IpSafetyReason[];
  /** Internal only — short customer-text spans that produced the reasons. Empty for `"allow"`. */
  findings: IpSafetyFinding[];
}

export const ALLOWED_IP_SAFETY_DECISION: IpSafetyDecision = {
  outcome: "allow",
  reasons: [],
  findings: [],
};

/* ------------------------------------------------------------------ */
/* The optional semantic signal                                        */
/* ------------------------------------------------------------------ */

/**
 * Coarse, provider-neutral confidence. Deliberately the same three buckets
 * Conversation Understanding already uses, and for the same reason: a
 * numeric score invites threshold tuning, and this must never become a dial.
 * Only `"explicit"` and `"inferred"` may ever block — an `"ambiguous"`
 * signal is discarded exactly like an ambiguous brief-field proposal is
 * (`reconcile-understanding.ts`).
 */
export type IpSafetySignalConfidence = "explicit" | "inferred" | "ambiguous";

export type IpSafetySignalKind =
  | "protected_mark_reproduction"
  | "protected_mark_imitation"
  | "protected_character_reproduction"
  | "protection_evasion";

/**
 * What the ALREADY-REQUIRED Conversation Understanding call may additionally
 * report about a customer message (Goal 16 — no new paid call is introduced
 * by A3; this rides on the one semantic interpretation per turn that the
 * pre-approval/revision pipeline already makes).
 *
 * It is a HINT, never the fence. Conversation Understanding is optional by
 * configuration (`CONVERSATION_UNDERSTANDING_PROVIDER` defaults to `none`),
 * is skipped for single-token replies, and degrades to an empty result on
 * any failure — so product safety can never depend on it. The deterministic
 * detector is the floor, and it is the only thing the two generation fences
 * consult.
 *
 * Correction (P2) — PRECEDENCE. The hint may only ever EXTEND recall, never
 * contradict what the customer plainly wrote:
 *
 *   - a deterministic block always blocks; no signal can lift it;
 *   - a malformed/unknown signal is discarded and changes nothing;
 *   - `"ambiguous"` never blocks;
 *   - `"explicit"` / `"inferred"` may block a request the deterministic
 *     layer had no opinion on;
 *   - but NEITHER may block once the deterministic layer found explicit safe
 *     structure — a negation, removal, or avoidance operator actually
 *     governing the protected referent, or an ownership claim over branding
 *     nobody recognizes. "Don't use the Raiders logo" must not be refused
 *     because a model guessed at the sentence.
 */
export interface IpSafetySignal {
  kind: IpSafetySignalKind;
  confidence: IpSafetySignalConfidence;
  /** Short customer-text quote. Never reasoning, never chain-of-thought. */
  evidence: string;
}

/* ------------------------------------------------------------------ */
/* Evaluation inputs                                                   */
/* ------------------------------------------------------------------ */

/**
 * The customer's own words for one conversation turn, plus the bounded
 * conversation window the canonical subject composes with them.
 *
 * Correction 3: a request split across turns ("I want a Raiders design." →
 * "Use their exact shield.") is one request, and the gate has to be able to
 * see it as one. `messages` is the project's own conversation record; the
 * capability bounds it itself (`safety-subject.ts`) — callers never
 * pre-truncate, and nothing is persisted.
 */
export interface CustomerRequestSafetyInput {
  message: string;
  /** The project's conversation so far. Bounded and filtered internally. */
  messages?: readonly { role: string; content: string }[];
  /** Optional hint from the already-required Conversation Understanding call. */
  semanticSignal?: IpSafetySignal | null;
}

/**
 * The structured generation intent — the authority BOTH generation fences
 * evaluate, composed into one canonical subject by
 * `safety-subject.ts::buildGenerationIntentSubject` so the enqueue fence and
 * the worker fence cannot drift apart.
 *
 * Deliberately NOT a transcript: re-scanning old conversation at
 * provider-call time would both re-block retracted requests forever and miss
 * design content that arrived structurally. The caller resolves these fields
 * (same "caller does I/O, capability only decides" shape as
 * `PrintValidationCapability`).
 *
 * See `safety-subject.ts` for the audit of which brief fields are included
 * and, just as importantly, which are excluded and why.
 */
export interface GenerationIntentSafetyInput {
  /** Generation-bearing design CONTENT from the approved Design Brief version. */
  designDescription: string | null;
  designStyle: string | null;
  additionalInstructions: string | null;
  exclusions: string | null;
  /**
   * A targeted revision's literal customer instruction
   * (`GenerationJob.revisionInstruction`) — the most authoritative part of
   * the request, and therefore first in the composed subject so a corrective
   * instruction ("remove the logo") governs the design context behind it.
   */
  revisionInstruction: string | null;
}
