import { isConversationUnderstandingDebugEnabled } from "@/lib/config/conversation-understanding-debug";

/**
 * Sprint 2L Phase 1A: structured, allowlisted tracing for the Conversation
 * Understanding → Intent Extraction → Design Brief → Brief Evaluation →
 * Interview Intelligence pipeline, for debugging exactly one thing: which
 * pipeline stage dropped or rejected a field.
 *
 * Gated by `CONVERSATION_UNDERSTANDING_DEBUG=true` — off by default in
 * every environment (including this one, until explicitly set for a
 * single debugging session). Never enabled automatically.
 *
 * Security boundary: this discriminated union IS the allowlist. It is not
 * possible to pass an API key, a full prompt, a raw provider response,
 * chain-of-thought, unrelated conversation history, a signed URL, or any
 * other generation/provider internal through this function — the type has
 * no field for any of them. Every event carries only section names,
 * coarse confidence categories, short rejection codes, act types, and
 * counts.
 */
export type ConversationUnderstandingTraceEvent =
  | {
      /**
       * Sprint 2L Phase 1C: a one-time (per composition-root construction)
       * snapshot proving which provider mode is actually active — the
       * concrete way to answer "is CONVERSATION_UNDERSTANDING_PROVIDER=openai
       * really in effect for this server process, or did it resolve to
       * `none`?" Logged from `resolveConversationUnderstandingProvider`, so
       * if it never appears at all, the composition root was never
       * (re)constructed with debug tracing enabled for this process —
       * itself a diagnostic fact (e.g. a stale `getCapabilityGraph()`
       * singleton built before `CONVERSATION_UNDERSTANDING_DEBUG` was set).
       */
      stage: "config";
      configuredProvider: string;
      resolvedMode: "openai" | "none";
      model: string | null;
      debugEnabled: true; // always true — this event only exists when debug is on
    }
  | {
      stage: "request";
      pendingSection: string | null;
      unresolvedSections: string[];
      messageWordCount: number;
      /** False when the single-token skip policy (Goal 12) means the provider is never called this turn. */
      willCallProvider: boolean;
    }
  | {
      stage: "provider_result";
      proposals: Array<{ section: string; confidence: string }>;
      deferrals: string[];
      ambiguities: string[];
      customerIntent: string;
      /** True when the provider call itself threw (network/timeout/malformed response) — distinct from a legitimate empty result. */
      failed: boolean;
    }
  | {
      stage: "reconciled";
      accepted: string[];
      rejected: Array<{ section: string; code: string }>;
      deferredSections: string[];
    }
  | {
      stage: "deterministic_extraction";
      fields: string[];
      intents: string[];
    }
  | {
      stage: "merged_patch";
      fields: string[];
    }
  | {
      stage: "brief_updated";
      resolvedSections: string[];
    }
  | {
      stage: "next_act";
      actType: string;
      section: string | null;
      pendingSection: string | null;
    };

export function traceConversationUnderstanding(
  event: ConversationUnderstandingTraceEvent,
): void {
  if (!isConversationUnderstandingDebugEnabled()) return;
  console.log(`[conversation-understanding-trace] ${JSON.stringify(event)}`);
}
