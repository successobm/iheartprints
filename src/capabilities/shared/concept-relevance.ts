import type { BriefSectionKey } from "./contracts";

/**
 * Sections that materially change what a generated concept would look
 * like (Sprint 2G Part 2, extracted to `shared/` in Part 3 so both
 * RevisionIntelligenceCapability and ConceptGenerationCapability's
 * read-only status check agree on the same definition). Audience/purpose/
 * exclusions/notes/references inform the brief but don't change the
 * visual result of today's placeholder generation, so they don't warrant
 * a "would you like updated concepts?" prompt or a Design Intelligence
 * re-run.
 */
export const CONCEPT_RELEVANT_SECTIONS = new Set<BriefSectionKey>([
  "product",
  "productColor",
  "colors",
  "graphics",
  "requiredWording",
  "style",
  "printLocation",
]);

export function isConceptRelevantChange(
  changedSections: BriefSectionKey[],
): boolean {
  return changedSections.some((section) => CONCEPT_RELEVANT_SECTIONS.has(section));
}
