import type { TShirtDesignBrief } from "@/lib/domain/types";
import { rulePacksAffectedBySections } from "@/capabilities/shared/product-rule-packs";
import type {
  BriefSectionKey,
  RevisionImpact,
} from "@/capabilities/shared/contracts";

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

/**
 * Sections that materially change what a generated concept would look
 * like. Audience/purpose/exclusions/notes/references inform the brief but
 * don't change the visual result of today's placeholder generation, so
 * they don't warrant a "would you like updated concepts?" prompt or a
 * Design Intelligence re-run.
 */
const CONCEPT_RELEVANT_SECTIONS = new Set<BriefSectionKey>([
  "product",
  "productColor",
  "colors",
  "graphics",
  "requiredWording",
  "style",
  "printLocation",
]);

export function createRevisionIntelligenceCapability(): RevisionIntelligenceCapability {
  return {
    analyze(previousBrief, updatedBrief) {
      const changedSections = [...diffBrief(previousBrief, updatedBrief)];
      const conceptRelevant = changedSections.some((section) =>
        CONCEPT_RELEVANT_SECTIONS.has(section),
      );

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

function diffBrief(
  previous: TShirtDesignBrief,
  updated: TShirtDesignBrief,
): Set<BriefSectionKey> {
  const changed = new Set<BriefSectionKey>();

  if (previous.productSummary !== updated.productSummary) changed.add("product");
  if (previous.designDescription !== updated.designDescription) changed.add("graphics");
  if (previous.shirtColor !== updated.shirtColor) changed.add("productColor");
  if (previous.exactText !== updated.exactText) changed.add("requiredWording");
  if (!sameStringSet(previous.preferredColors, updated.preferredColors)) {
    changed.add("colors");
  }
  if (previous.designStyle !== updated.designStyle) changed.add("style");
  if (previous.printPlacement !== updated.printPlacement) changed.add("printLocation");
  if (previous.audience !== updated.audience) changed.add("audience");
  if (previous.purpose !== updated.purpose) changed.add("purpose");
  if (previous.exclusions !== updated.exclusions) changed.add("exclusions");
  if (previous.additionalInstructions !== updated.additionalInstructions) {
    changed.add("additionalNotes");
  }

  // A section newly deferred, or newly un-deferred (the customer took it
  // back over), is itself a revision to that section — the customer's
  // resolution of it changed even if there's still no concrete content.
  const previousDeferred = new Set(previous.deferredSections);
  const updatedDeferred = new Set(updated.deferredSections);
  for (const section of previousDeferred) {
    if (!updatedDeferred.has(section)) changed.add(section as BriefSectionKey);
  }
  for (const section of updatedDeferred) {
    if (!previousDeferred.has(section)) changed.add(section as BriefSectionKey);
  }

  return changed;
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const normalize = (values: string[]) =>
    [...values].map((value) => value.toLowerCase()).sort();
  const na = normalize(a);
  const nb = normalize(b);
  return na.every((value, index) => value === nb[index]);
}
