import type { BriefSectionKey, ProductionRulePackId } from "./contracts";

/**
 * Pure registry of which Design Brief sections each Product Intelligence
 * rule pack depends on (Sprint 2G Part 2). Lives in `shared/` — like
 * `interview-coverage-policy.ts` and `question-phrasing.ts` — so both
 * `ProductIntelligenceCapability` (which sections trigger which pack) and
 * `RevisionIntelligenceCapability` (which packs a revision affects) read
 * the same table without either depending on the other.
 */
export const RULE_PACK_DEPENDENCIES: Record<ProductionRulePackId, BriefSectionKey[]> = {
  small_placement_long_wording: ["printLocation", "requiredWording"],
  small_placement_dense_graphics: ["printLocation", "graphics"],
  full_placement_wall_of_text: ["printLocation", "requiredWording"],
};

export const ALL_RULE_PACK_IDS = Object.keys(
  RULE_PACK_DEPENDENCIES,
) as ProductionRulePackId[];

/** Which rule packs are relevant given a set of changed sections. */
export function rulePacksAffectedBySections(
  sections: BriefSectionKey[],
): ProductionRulePackId[] {
  const changed = new Set(sections);
  return ALL_RULE_PACK_IDS.filter((id) =>
    RULE_PACK_DEPENDENCIES[id].some((section) => changed.has(section)),
  );
}
