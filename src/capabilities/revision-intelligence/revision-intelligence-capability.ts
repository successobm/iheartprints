import type { TShirtDesignBrief } from "@/lib/domain/types";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";
import { rulePacksAffectedBySections } from "@/capabilities/shared/product-rule-packs";
import type { RevisionImpact } from "@/capabilities/shared/contracts";

/**
 * Revision Intelligence (Sprint 2G Part 2).
 *
 * Understands the *impact* of a Design Brief change — never the change
 * itself (it does not mutate the brief; ConversationCapability already
 * applied the patch through DesignBriefCapability before this runs) and
 * never what to do about it (that is Design Intelligence's / Interview
 * Intelligence's job). Given only the brief before and after a turn, it
 * answers: which sections changed, which Product Intelligence rule packs
 * that touches, and whether re-evaluation, a summary refresh, new
 * recommendations, or concept regeneration are warranted.
 *
 * Pure and deterministic: same two briefs in, same impact out. No
 * Conversation, no persistence, no providers, no UI.
 */
export interface RevisionIntelligenceCapability {
  analyze(
    previousBrief: TShirtDesignBrief,
    updatedBrief: TShirtDesignBrief,
  ): RevisionImpact;
}

export function createRevisionIntelligenceCapability(): RevisionIntelligenceCapability {
  return {
    analyze(previousBrief, updatedBrief) {
      const changedSections = diffBriefSections(previousBrief, updatedBrief);
      const conceptRelevant = isConceptRelevantChange(changedSections);

      return {
        changedSections,
        affectedRulePacks: rulePacksAffectedBySections(changedSections),
        needsReevaluation: changedSections.length > 0,
        needsSummaryRefresh: changedSections.length > 0,
        needsNewRecommendations: conceptRelevant,
        needsConceptRegeneration: conceptRelevant,
        isNoOp: changedSections.length === 0,
      };
    },
  };
}
