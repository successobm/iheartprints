import {
  EMPTY_UNDERSTANDING_RESULT,
  type ConversationUnderstandingProvider,
  type ConversationUnderstandingRequest,
  type ConversationUnderstandingResult,
} from "@/capabilities/conversation-understanding";

/**
 * Deterministic, scripted `ConversationUnderstandingProvider` for tests.
 * No network, no real model — the whole point is to exercise the pipeline
 * (bounding → provider → sanitize → reconcile → Design Brief) against a
 * known, hand-authored interpretation, exactly as a real LLM's parsed JSON
 * output would arrive.
 *
 * Rules are checked in order; the first whose `when` predicate matches the
 * (already-bounded) request wins. No match → `EMPTY_UNDERSTANDING_RESULT`,
 * matching a real provider's honest "nothing confidently understood" case.
 */
export interface FakeUnderstandingRule {
  when: (request: ConversationUnderstandingRequest) => boolean;
  result: ConversationUnderstandingResult;
}

export class FakeConversationUnderstandingProvider
  implements ConversationUnderstandingProvider
{
  readonly providerKey = "fake_conversation_understanding";

  private readonly rules: FakeUnderstandingRule[];
  private readonly failWith: unknown;
  calls: ConversationUnderstandingRequest[] = [];

  constructor(options: { rules?: FakeUnderstandingRule[]; failWith?: unknown } = {}) {
    this.rules = options.rules ?? [];
    this.failWith = options.failWith;
  }

  async interpret(
    request: ConversationUnderstandingRequest,
  ): Promise<ConversationUnderstandingResult> {
    this.calls.push(request);
    if (this.failWith !== undefined) throw this.failWith;
    const rule = this.rules.find((r) => r.when(request));
    return rule?.result ?? EMPTY_UNDERSTANDING_RESULT;
  }
}

/** Convenience: match on the exact (trimmed) customer message. */
export function whenMessageIs(
  message: string,
  result: ConversationUnderstandingResult,
): FakeUnderstandingRule {
  return { when: (req) => req.message.trim() === message, result };
}
