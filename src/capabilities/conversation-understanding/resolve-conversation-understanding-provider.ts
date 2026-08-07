import {
  getConversationUnderstandingConfig,
  type ConversationUnderstandingConfig,
} from "@/lib/config/conversation-understanding-provider-config";
import { logConversationUnderstandingFallback } from "@/lib/config/conversation-understanding-provider-logging";
import { traceConversationUnderstanding } from "@/lib/debug/conversation-understanding-trace";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

import type { ConversationUnderstandingProvider } from "./conversation-understanding-provider";
import { NoneConversationUnderstandingProvider } from "./none-conversation-understanding-provider";
import { OpenAIConversationUnderstandingProvider } from "./openai-conversation-understanding-provider";

/**
 * Sprint 2L Phase 1: turns a `ConversationUnderstandingConfig` decision
 * into an actual provider instance. Composition-layer concern, not a
 * domain or capability one — `ConversationUnderstandingCapability` never
 * inspects environment variables itself (see `capability-boundaries.ts`).
 *
 * Never throws and never resolves to an "unavailable" provider — a
 * misconfigured `openai` request always resolves to
 * `NoneConversationUnderstandingProvider` instead (see
 * `conversation-understanding-provider-config.ts` for why this differs
 * from concept generation's fail-closed behavior).
 *
 * Accepts an explicit `config` (default: the live environment) so it can
 * be unit-tested without mutating `process.env`.
 *
 * Release-blocker hotfix: when `config` is omitted (the live-environment
 * default `getCapabilityGraph()`/`createCapabilityGraph()` always uses),
 * `isAutomatedTestEnvironment()` unconditionally forces
 * `NoneConversationUnderstandingProvider` — no network call is possible —
 * no matter what `CONVERSATION_UNDERSTANDING_PROVIDER`/`OPENAI_API_KEY`
 * happen to be set to in the ambient environment. A caller that passes an
 * explicit `config` (this module's own resolver unit tests) is unaffected
 * — see `lib/config/automated-test-safety.ts`.
 */
export function resolveConversationUnderstandingProvider(
  config?: ConversationUnderstandingConfig,
): ConversationUnderstandingProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new NoneConversationUnderstandingProvider();
  }
  const resolvedConfig = config ?? getConversationUnderstandingConfig();

  // Sprint 2L Phase 1C (Goal: prove active configuration): a one-time,
  // dev-only snapshot of what actually got resolved — the concrete way to
  // answer "is CONVERSATION_UNDERSTANDING_PROVIDER=openai really in effect
  // right now?" without guessing. `getCapabilityGraph()`'s singleton means
  // this resolver typically runs once per server process — a debugging
  // session that never sees this line at all is itself informative (the
  // composition root was already constructed before
  // `CONVERSATION_UNDERSTANDING_DEBUG` was set — see ARCHITECTURE.md §10c).
  traceConversationUnderstanding({
    stage: "config",
    configuredProvider: (process.env.CONVERSATION_UNDERSTANDING_PROVIDER ?? "none")
      .trim()
      .toLowerCase(),
    resolvedMode: resolvedConfig.mode,
    model: resolvedConfig.mode === "openai" ? resolvedConfig.model : null,
    debugEnabled: true,
  });

  switch (resolvedConfig.mode) {
    case "openai":
      return new OpenAIConversationUnderstandingProvider({
        apiKey: resolvedConfig.apiKey,
        model: resolvedConfig.model,
      });

    case "none":
      if (resolvedConfig.reason === "fallback") {
        logConversationUnderstandingFallback({
          requestedProvider: "openai",
          environment: process.env.NODE_ENV ?? "development",
        });
      }
      return new NoneConversationUnderstandingProvider();
  }
}
