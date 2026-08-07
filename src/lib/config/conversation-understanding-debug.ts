/**
 * Sprint 2L Phase 1A: development-only tracing switch for the Conversation
 * Understanding pipeline. Off by default in every environment — must be
 * explicitly set to enable. See `lib/debug/conversation-understanding-trace.ts`
 * for the allowlisted event shapes this gates.
 */
export function isConversationUnderstandingDebugEnabled(): boolean {
  return (
    (process.env.CONVERSATION_UNDERSTANDING_DEBUG ?? "").trim().toLowerCase() ===
    "true"
  );
}
