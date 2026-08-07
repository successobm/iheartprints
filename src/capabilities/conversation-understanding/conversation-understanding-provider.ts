import type {
  ConversationUnderstandingRequest,
  ConversationUnderstandingResult,
} from "./contracts";

/**
 * Provider port for Conversation Understanding.
 * Capabilities depend on this interface only — never a concrete vendor.
 *
 * Adapters must never receive customer ids, conversation ids, project ids,
 * storage keys, signed URLs, generation job internals, provider metadata,
 * or secrets — only the provider-neutral, bounded
 * `ConversationUnderstandingRequest`. Adapters must never throw for
 * "the customer's message was hard to parse" — that is a normal,
 * `"ambiguous"`/empty result, not a failure. Adapters may throw for real
 * provider failures (network, timeout, malformed response); the capability
 * layer catches those and degrades gracefully (Goal 10).
 */
export interface ConversationUnderstandingProvider {
  readonly providerKey: string;
  interpret(
    request: ConversationUnderstandingRequest,
  ): Promise<ConversationUnderstandingResult>;
}
