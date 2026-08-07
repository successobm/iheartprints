/**
 * Sprint 2L Phase 1: provider selection for Conversation Understanding is
 * configuration-driven, exactly like `concept-evaluation-provider-config.ts`
 * — adding a future provider means one more branch here plus one adapter
 * file, never a domain or capability change.
 *
 * Deliberately independent of concept generation's configuration (Goal 11):
 * `CONVERSATION_UNDERSTANDING_PROVIDER` is its own switch, never gated by
 * `CONCEPT_GENERATION_ENABLE_REAL`. Real image generation and real
 * conversational understanding are two unrelated capabilities that happen
 * to both be able to use OpenAI.
 *
 * Deliberately simpler than concept *generation* configuration and modeled
 * on Concept Evaluation's asymmetry instead: Conversation Understanding is
 * a best-effort semantic layer over an always-correct deterministic
 * fallback (`IntentExtractionCapability`'s existing `extractAdaptive`
 * engine) — see `ConversationUnderstandingCapability`. A misconfigured or
 * unavailable `openai` request never fails closed; it always resolves to
 * `NoneConversationUnderstandingProvider` instead, in every environment,
 * because the conversation must keep working with or without it (Goal 10).
 *
 * Pure and side-effect-free (no logging here) so it stays trivially
 * testable — logging belongs to whatever consumes the result.
 */

const DEFAULT_OPENAI_UNDERSTANDING_MODEL = "gpt-4o-mini";

export type ConversationUnderstandingConfig =
  | {
      mode: "none";
      /**
       * "configured" — `none` was explicitly selected, or is simply the
       * default with nothing else requested (the default in every
       * environment, including production, until this is intentionally
       * turned on).
       * "fallback" — `openai` was requested but `OPENAI_API_KEY` is not
       * set.
       */
      reason: "configured" | "fallback";
    }
  | {
      mode: "openai";
      apiKey: string;
      model: string;
    };

export function getConversationUnderstandingConfig(): ConversationUnderstandingConfig {
  const requestedProvider = (
    process.env.CONVERSATION_UNDERSTANDING_PROVIDER ?? "none"
  )
    .trim()
    .toLowerCase();

  if (requestedProvider !== "openai") {
    return { mode: "none", reason: "configured" };
  }

  // Reuses the same OpenAI credential as concept generation/evaluation —
  // same vendor account/key; conversation understanding does not require
  // its own separate secret.
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) {
    return { mode: "none", reason: "fallback" };
  }

  const model =
    process.env.CONVERSATION_UNDERSTANDING_MODEL?.trim() ||
    DEFAULT_OPENAI_UNDERSTANDING_MODEL;

  return { mode: "openai", apiKey, model };
}
