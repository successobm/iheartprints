import { applyUserReplyToBrief } from "@/lib/domain/conversation";
import type {
  ConversationPhase,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  DetectedIntent,
  IntentExtractionResult,
} from "@/capabilities/shared/contracts";

export interface IntentExtractionInput {
  brief: TShirtDesignBrief;
  phase: ConversationPhase;
  reply: string;
}

/**
 * Produces provider-neutral patch proposals.
 * Must never generate image prompts or mutate the brief directly.
 */
export interface IntentExtractionCapability {
  extract(input: IntentExtractionInput): IntentExtractionResult;
}

/**
 * Sprint 1 bridge: phase → field mapping via existing applyUserReplyToBrief.
 * Behavior identical; boundary established for future adaptive extraction.
 */
export function createIntentExtractionCapability(): IntentExtractionCapability {
  return {
    extract({ brief, phase, reply }) {
      const fields = applyUserReplyToBrief(brief, phase, reply);
      const intents = detectIntents(phase, fields);

      if (Object.keys(fields).length === 0) {
        return { intents, proposals: [] };
      }

      return {
        intents,
        proposals: [
          {
            fields,
            source: "intent_extraction",
            phase,
            rationale: `sprint1_phase:${phase}`,
          },
        ],
      };
    },
  };
}

function detectIntents(
  phase: ConversationPhase,
  fields: Partial<TShirtDesignBrief>,
): DetectedIntent[] {
  if (phase === "ask_revisions" || phase === "revision_received") {
    return ["request_revision"];
  }
  if (Object.keys(fields).length > 0) {
    return ["provide_info"];
  }
  return ["unknown"];
}
