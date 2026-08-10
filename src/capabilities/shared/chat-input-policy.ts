/**
 * Live Acceptance UX Pass: when free-text chat is and is not the expected
 * interaction, in one place.
 *
 * This used to be two independent lists — `CHAT_BLOCKED_PHASES` inside
 * `ConversationCapability` (which refuses the message server-side) and a
 * hand-maintained boolean chain in `ChatApp` (which greys out the
 * composer). Two copies of the same rule can drift, and when they drift
 * the customer either sees an enabled input that throws on send, or a
 * dead input in a phase the platform would happily have accepted. The
 * live "chat looks stuck after a revision" report was the second kind.
 *
 * Provider-neutral, dependency-free, and safe to import from a client
 * component — it is policy, not persistence.
 */

import type { ConversationPhase } from "@/lib/domain/types";

/**
 * Phases where the customer is expected to act on a control rather than
 * type: generation is in flight, a Design Summary decision is pending, or
 * three fresh concepts are waiting to be chosen between.
 *
 * Deliberately NOT here: `ask_revisions` / `revision_received`. Those are
 * the revision loop, where describing a change in chat is the whole point.
 */
export const CHAT_BLOCKED_PHASES: readonly ConversationPhase[] = [
  "generating",
  "skip_references",
  "concepts_ready",
  "awaiting_summary_confirmation",
  "brief_approved",
];

/** Post-concept revision loop — the customer describing changes to artwork. */
export const REVISION_LOOP_PHASES: readonly ConversationPhase[] = [
  "ask_revisions",
  "revision_received",
];

export function isChatBlockedPhase(phase: ConversationPhase): boolean {
  return CHAT_BLOCKED_PHASES.includes(phase);
}

export function isRevisionLoopPhase(phase: ConversationPhase): boolean {
  return REVISION_LOOP_PHASES.includes(phase);
}
