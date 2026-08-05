import {
  applyUserReplyToBrief,
  isLegacyScriptedPhase,
} from "@/lib/domain/conversation";
import type {
  ConversationPhase,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  BriefSectionKey,
  DetectedIntent,
  IntentExtractionResult,
} from "@/capabilities/shared/contracts";
import { extractAdaptive } from "./extraction";

export interface IntentExtractionInput {
  brief: TShirtDesignBrief;
  phase: ConversationPhase;
  reply: string;
  /**
   * Sprint 2F: the section Interview Intelligence most recently asked or
   * clarified, when running the adaptive engine. Ignored for legacy phases
   * (the ladder already knows which single field each phase maps to).
   */
  pendingSection?: BriefSectionKey | null;
}

/**
 * Produces provider-neutral patch proposals.
 * Must never generate image prompts or mutate the brief directly.
 *
 * Sprint 2F: extracts every supported field a reply can confidently
 * support (not just the one tied to the current question), recognizes
 * corrections, explicit deferrals, and an explicit "no wording" signal —
 * all deterministic, no LLM dependency. Legacy `ask_*`/revision phases
 * (see `isLegacyScriptedPhase`) keep the exact Sprint 1 single-field
 * behavior so historical, still-in-flight conversations are unaffected.
 */
export interface IntentExtractionCapability {
  extract(input: IntentExtractionInput): IntentExtractionResult;
}

export function createIntentExtractionCapability(): IntentExtractionCapability {
  return {
    extract({ brief, phase, reply, pendingSection }) {
      if (isLegacyScriptedPhase(phase)) {
        const fields = applyUserReplyToBrief(brief, phase, reply);
        const intents = legacyIntents(phase, fields);

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
      }

      const { fields, intents } = extractAdaptive({
        brief,
        reply,
        pendingSection: pendingSection ?? null,
      });

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
            rationale: "sprint2f_adaptive",
          },
        ],
      };
    },
  };
}

function legacyIntents(
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
