/**
 * Sprint 2M Phase 2G (Goal 4): distinguishes an explicit customer
 * instruction to change the artwork from a tentative, uncertain, or purely
 * exploratory remark. Automatic revision-generation enqueue is customer
 * authority ("EXPLICIT CONVERSATIONAL REVISION REQUESTS SHOULD
 * AUTOMATICALLY ENQUEUE REVISION GENERATION" — the durable clarification of
 * ARCHITECTURE.md's "automatic regeneration is forbidden" rule: it forbids
 * SYSTEM-initiated speculative regeneration, never a clear customer
 * instruction) — it must never fire on hedged language or a bare question,
 * only on an unambiguous instruction or direct factual correction.
 *
 * Deliberately generic: no product/domain nouns, only sentence-shape and
 * hedging-cue heuristics, so this never grows a per-scenario keyword list.
 */

import { clauseBodySource } from "@/lib/domain/clause-boundaries";

const TENTATIVE_CUE_PATTERN =
  /\b(maybe|perhaps|possibly|i'?m not sure|not sure|do you think|might|not certain|i wonder|wondering|what if|i guess|kind of|sort of|not 100%|unsure)\b/i;

/**
 * A message that is ENTIRELY a question (no declarative/imperative clause
 * alongside it) reads as exploratory — "Do you think this needs more
 * color?" — rather than an instruction. A message that mixes a question
 * with a clear instruction ("Can you make the boat larger?") still counts
 * as a question grammatically but is intentionally treated the same way
 * here: without an accompanying declarative clause, the customer is asking
 * for an opinion or confirmation, not issuing a standing instruction.
 */
// The `.` exclusion is decimal-safe (`lib/domain/clause-boundaries.ts`):
// before that, "Should the lift be 2.5 inches?" failed this test purely
// because of the decimal point, and a hedged question was treated as a
// standing instruction — which enqueues a paid regeneration.
const WHOLE_MESSAGE_QUESTION_PATTERN = new RegExp(
  `^${clauseBodySource(".!")}*\\?\\s*$`,
);

export function isExplicitRevisionIntent(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (TENTATIVE_CUE_PATTERN.test(trimmed)) return false;
  if (WHOLE_MESSAGE_QUESTION_PATTERN.test(trimmed)) return false;
  return true;
}
