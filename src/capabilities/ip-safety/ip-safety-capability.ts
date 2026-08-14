/**
 * Sprint A3 — ENFORCEMENT. "May iHeartPrints send this request to the
 * concept-generation provider?"
 *
 * Detection (`ip-safety-detection.ts`) answers what the customer appears to
 * be asking for. This capability answers whether the product will do it, and
 * is the ONLY thing the three fences consult. Splitting the two is what keeps
 * provider behavior from becoming the product's policy: a provider may
 * independently refuse things this capability allowed, and this capability
 * refuses things a provider would happily have billed for.
 *
 * SHAPE. Pure and synchronous, mirroring `BriefEvaluationCapability` and
 * `PrintValidationCapability`: no repository, no provider, no I/O, and
 * `createIpSafetyCapability()` takes zero arguments. The caller resolves the
 * brief content / conversation record and passes plain data — the same
 * "caller does I/O, capability only decides" contract Print Validation uses.
 *
 * ONE CANONICAL SUBJECT (Correction 2). Both generation fences evaluate the
 * exact same composed text, built by
 * `safety-subject.ts::buildGenerationIntentSubject`, so a request split
 * across structured fields is seen the way the prompt translator will see it
 * — as one thing — and the two fences cannot drift.
 *
 * DERIVED, NEVER PERSISTED. There is no `ip_safety` column, no migration, and
 * no stored verdict. Every decision is recomputed from whatever the CURRENT
 * intent actually is, which gives both required lifecycle behaviors for free:
 *
 *     unsafe request → customer revises → safe → generation allowed
 *     safe project   → customer adds a protected-mark request → blocked
 *
 * A stored flag would have had to be explicitly un-set to get the first one,
 * and A3's rule is that one bad turn never permanently poisons a project.
 * The stability Goal 9 asks for comes from the input being STRUCTURED (the
 * approved brief's design content plus the job's literal revision
 * instruction) rather than from freezing an old answer — and specifically
 * NOT from re-scanning the conversation transcript at provider-call time,
 * which would resurrect retracted requests forever.
 */

import {
  ALLOWED_IP_SAFETY_DECISION,
  type CustomerRequestSafetyInput,
  type GenerationIntentSafetyInput,
  type IpSafetyDecision,
  type IpSafetyFinding,
  type IpSafetyReason,
  type IpSafetySignal,
} from "./contracts";
import {
  detectProtectedIpRisk,
  IP_SAFETY_REASON_ORDER,
  isCoveredBySafeEvidence,
} from "./ip-safety-detection";
import {
  buildConversationTurnSubject,
  buildGenerationIntentSubject,
} from "./safety-subject";

export interface IpSafetyCapability {
  /**
   * The conversational gate: the customer's current turn composed with a
   * bounded window of their own recent, non-refused turns, so a request
   * split across turns is still one request. Optionally strengthened by the
   * semantic hint the already-required Conversation Understanding call may
   * carry (no new paid call — Goal 16).
   */
  evaluateCustomerRequest(input: CustomerRequestSafetyInput): IpSafetyDecision;
  /**
   * The generation fences: the canonical subject for the complete current
   * generation request. Deterministic only — it never depends on a semantic
   * layer that may be unconfigured, skipped, or failed.
   */
  evaluateGenerationIntent(input: GenerationIntentSafetyInput): IpSafetyDecision;
}

export function createIpSafetyCapability(): IpSafetyCapability {
  return {
    evaluateCustomerRequest(input) {
      const subject = buildConversationTurnSubject({
        message: input.message,
        messages: input.messages ?? [],
      });
      return decide(detectProtectedIpRisk([subject]), subject, input.semanticSignal);
    },

    evaluateGenerationIntent(input) {
      const subject = buildGenerationIntentSubject({
        design: {
          designDescription: input.designDescription,
          designStyle: input.designStyle,
          additionalInstructions: input.additionalInstructions,
          exclusions: input.exclusions,
        },
        revisionInstruction: input.revisionInstruction,
      });
      return decide(detectProtectedIpRisk([subject]), subject, null);
    },
  };
}

/**
 * Semantic precedence (Correction P2, scoped by Correction 2).
 *
 * The hint may EXTEND deterministic recall — it is the only way a mark
 * nobody enumerated gets caught — but it may never contradict safety the
 * customer wrote plainly. An inferred model reading of "don't use the
 * Raiders logo" or "remove the Nike logo" must not refuse work whose safety
 * the deterministic layer just established structurally.
 *
 * CORRECTION 3 — SUPPRESSION IS SCOPED TO THE SAME REQUEST. A signal is
 * suppressed only when deterministic safe evidence explains the request the
 * signal is actually about. Not "there is safe structure somewhere in the
 * subject", and not "there is an ownership claim somewhere in the clause" —
 * both were tried, and both leaked:
 *
 *     "Recreate our logo, then reproduce theirs."
 *      |-- owned, explained --|  |- someone else's, NOT explained -|
 *
 *     "Don't use the old logo, draw that famous cartoon mouse exactly."
 *      |----- neutralized -----|  |- invisible to the lexicon entirely -|
 *
 * The second is decisive: nothing deterministic exists for "that famous
 * cartoon mouse", so no amount of occurrence counting can represent it. The
 * signal's own `evidence` quote is the only handle on WHERE the semantic
 * request lives, and `isCoveredBySafeEvidence` answers the single positional
 * question that matters — do the customer's quoted words sit inside a
 * neutralizing operator's scope, or inside an ownership-explained segment?
 *
 * This subsumes any per-kind rule. "Don't use that famous cartoon mouse" is
 * allowed and "…, draw that famous cartoon mouse exactly" is blocked for the
 * same positional reason, with no character lexicon involved in either.
 *
 * `"ambiguous"` is discarded outright, matching how an ambiguous Design
 * Brief proposal is handled in `reconcile-understanding.ts`: a guess that is
 * not safe to apply to a brief field is not safe to refuse a customer's
 * artwork over either. A malformed signal never reaches here at all — it is
 * sanitized to `null` by `ConversationUnderstandingCapability`.
 */
const SEMANTIC_REASON: Readonly<Record<IpSafetySignal["kind"], IpSafetyReason>> = {
  protection_evasion: "protection_evasion_request",
  protected_character_reproduction: "protected_character_reproduction",
  protected_mark_imitation: "recognizable_mark_imitation",
  protected_mark_reproduction: "third_party_mark_reproduction",
};

const BLOCKING_SEMANTIC_CONFIDENCE: ReadonlySet<IpSafetySignal["confidence"]> =
  new Set(["explicit", "inferred"]);

function fromSemanticSignal(
  signal: IpSafetySignal | null | undefined,
  subject: string | null,
): IpSafetyFinding[] {
  if (!signal) return [];

  // Defence in depth. `ConversationUnderstandingCapability` already discards
  // a malformed signal, but "malformed output cannot disable deterministic
  // enforcement" is an invariant of the ENFORCEMENT boundary, not of one
  // upstream sanitizer — an unrecognized kind or confidence is discarded
  // here too rather than being coerced into a refusal.
  const reason = SEMANTIC_REASON[signal.kind];
  if (!reason) return [];
  if (!BLOCKING_SEMANTIC_CONFIDENCE.has(signal.confidence)) return [];

  // Same-request scoping. Unlocatable evidence (empty, or paraphrased past
  // recognition) means safety cannot be established for this request, so it
  // does not suppress — the conservative direction on a spend boundary, and
  // the provider prompt requires a real quote.
  if (isCoveredBySafeEvidence(subject, signal.evidence)) return [];

  return [{ reason, evidence: typeof signal.evidence === "string" ? signal.evidence : "" }];
}

function decide(
  findings: IpSafetyFinding[],
  subject: string | null,
  signal: IpSafetySignal | null | undefined,
): IpSafetyDecision {
  // A deterministic block is final: the semantic layer can never lift it,
  // and its absence can never disable it.
  const resolved =
    findings.length > 0 ? findings : fromSemanticSignal(signal, subject);

  if (resolved.length === 0) return ALLOWED_IP_SAFETY_DECISION;

  const reasons = IP_SAFETY_REASON_ORDER.filter((reason) =>
    resolved.some((finding) => finding.reason === reason),
  );

  return { outcome: "block", reasons, findings: resolved };
}
