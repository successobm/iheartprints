import {
  applyUserReplyToBrief,
  isLegacyScriptedPhase,
} from "@/lib/domain/conversation";
import type {
  ConversationPhase,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import type {
  BriefSectionKey,
  DetectedIntent,
  IntentExtractionResult,
} from "@/capabilities/shared/contracts";
import { traceConversationUnderstanding } from "@/lib/debug/conversation-understanding-trace";
import { extractAdaptive, type BriefFieldPatch } from "./extraction";
import { reconcileUnderstanding } from "./reconcile-understanding";

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
  /**
   * Sprint 2L Phase 1: the (already provider-agnostic, already sanitized)
   * semantic interpretation of this same reply, if
   * `ConversationUnderstandingCapability` produced one. `null`/omitted for
   * legacy phases, when the provider was skipped, or on any provider
   * failure — `extractAdaptive` alone then behaves exactly as before this
   * sprint. See `reconcile-understanding.ts` for precedence.
   */
  understanding?: ConversationUnderstandingResult | null;
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
    extract({ brief, phase, reply, pendingSection, understanding }) {
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

      const deterministic = extractAdaptive({
        brief,
        reply,
        pendingSection: pendingSection ?? null,
        // Sprint 2M Phase 2G (Goal 2): derived from `phase`, not a new
        // public input — only the post-concept-selection revision loop
        // gets the design-change-imperative → `designDescription` fallback.
        isPostSelectionRevision: phase === "ask_revisions" || phase === "revision_received",
      });
      traceConversationUnderstanding({
        stage: "deterministic_extraction",
        fields: Object.keys(deterministic.fields),
        intents: deterministic.intents,
      });

      // Sprint 2L Phase 1: exactly one authoritative merge — never two
      // independent systems fighting over the same brief (see
      // `capability-boundaries.ts`). Per Design Brief field, a validated
      // semantic-understanding value (when present) is authoritative;
      // `extractAdaptive`'s deterministic pass fills every field
      // understanding did not confidently resolve, and is the *only*
      // source when `understanding` is absent (provider skipped/
      // unconfigured/failed) — today's exact pre-Sprint-2L behavior.
      const reconciled = reconcileUnderstanding(understanding ?? null, {
        brief,
        // Detailed-Description Fidelity (Phase 1): reconciliation needs the
        // customer's own words to notice what a polished-but-lossy graphics
        // synthesis dropped. Read-only — see `preserveDesignDetail`.
        message: reply,
      });
      const fields: BriefFieldPatch = {
        ...deterministic.fields,
        ...reconciled.fields,
      };

      const deferredSections = unionDeferredSections(
        brief.deferredSections,
        deterministic.fields.deferredSections,
        reconciled.deferredSections,
      );
      if (deferredSections) fields.deferredSections = deferredSections;

      const intents = new Set<DetectedIntent>(deterministic.intents);
      if (reconciled.hadExplicitCorrection) intents.add("correct");
      if (Object.keys(fields).length > 0) intents.delete("unknown");

      traceConversationUnderstanding({
        stage: "merged_patch",
        fields: Object.keys(fields),
      });

      if (Object.keys(fields).length === 0) {
        return { intents: [...intents], proposals: [] };
      }

      return {
        intents: [...intents],
        proposals: [
          {
            fields,
            source: "intent_extraction",
            phase,
            rationale: understanding
              ? "sprint2l_understanding_plus_adaptive"
              : "sprint2f_adaptive",
          },
        ],
      };
    },
  };
}

/**
 * Sprint 2L Phase 1: a section deferred by *either* source stays deferred —
 * a plain per-key override (like every other field) would let whichever
 * source ran second silently drop the other's deferral, or drop the
 * brief's already-deferred sections entirely when only one source proposed
 * something new this turn. `deterministicNew` (when present) already
 * includes the brief's prior `deferredSections` (see `extractAdaptive`'s
 * early-return deferral branch) — `existing` is the fallback baseline when
 * it's absent. `understandingNew` is only ever the newly-deferred sections
 * this turn.
 */
function unionDeferredSections(
  existing: string[],
  deterministicNew: string[] | undefined,
  understandingNew: BriefSectionKey[],
): string[] | undefined {
  if (!deterministicNew && understandingNew.length === 0) return undefined;
  const set = new Set(deterministicNew ?? existing);
  for (const section of understandingNew) set.add(section);
  return [...set];
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
