import { EMPTY_UNDERSTANDING_RESULT } from "./contracts";
import type { ConversationUnderstandingProvider } from "./conversation-understanding-provider";

/**
 * The default provider when Conversation Understanding is not configured
 * (no `CONVERSATION_UNDERSTANDING_PROVIDER=openai`, or `openai` requested
 * without credentials — see `conversation-understanding-provider-config.ts`).
 *
 * Always resolves to "nothing understood" — never throws, never makes a
 * network call. This is what makes deterministic Intent Extraction the
 * sole interpreter in local dev, CI, and any environment that hasn't opted
 * in to real semantic understanding (Goal 10 / Goal 12): every existing,
 * already-passing conversation test keeps working unchanged because
 * `reconcile-understanding.ts` sees an empty result and contributes no
 * fields, leaving `extractAdaptive` as the only source.
 */
export class NoneConversationUnderstandingProvider
  implements ConversationUnderstandingProvider
{
  readonly providerKey = "none";

  async interpret() {
    return EMPTY_UNDERSTANDING_RESULT;
  }
}
