/**
 * Sprint 2L Phase 1: server-side-only diagnostics for Conversation
 * Understanding configuration. Never called with — and never prints — API
 * keys, authorization headers, provider request bodies, prompts, customer
 * messages, or provider responses. Kept separate from
 * `conversation-understanding-provider-config.ts` so that module stays a
 * pure function with no console side effects (same split as
 * `concept-evaluation-provider-logging.ts`).
 */

export interface ConversationUnderstandingFallbackLogDetails {
  requestedProvider: string;
  environment: string;
}

/**
 * Logged whenever `openai` conversation understanding was requested but
 * could not be used (missing `OPENAI_API_KEY`) and the deterministic-only
 * path is used instead. Safe in every environment — see
 * `conversation-understanding-provider-config.ts`.
 */
export function logConversationUnderstandingFallback(
  details: ConversationUnderstandingFallbackLogDetails,
): void {
  console.warn(
    `[conversation-understanding] CONVERSATION_UNDERSTANDING_PROVIDER=${details.requestedProvider} was requested but OPENAI_API_KEY is not set. ` +
      `Falling back to deterministic-only interpretation for this ${details.environment} environment. ` +
      "See getConversationUnderstandingConfig.",
  );
}
