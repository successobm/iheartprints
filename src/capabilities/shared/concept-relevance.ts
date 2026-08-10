import type { BriefSectionKey } from "./contracts";

/**
 * Sections that materially change what a generated concept would look
 * like (Sprint 2G Part 2, extracted to `shared/` in Part 3 so both
 * RevisionIntelligenceCapability and ConceptGenerationCapability's
 * read-only status check agree on the same definition). Audience/purpose/
 * notes/references inform the brief but don't change the visual result of
 * today's placeholder generation, so they don't warrant a "would you like
 * updated concepts?" prompt or a Design Intelligence re-run.
 *
 * Sprint 2M Phase 2G (Goal 12): `exclusions` moved into this set. A
 * customer telling the system something must NOT visibly appear ("no
 * cartoon characters", or the explanatory wording excluded from a
 * required-wording correction) changes what pixels a correct concept may
 * contain just as much as a positive instruction does — it is exactly as
 * concept-relevant as `requiredWording`, `graphics`, or `style`. Prior to
 * this, an exclusion silently never marked existing concepts stale and
 * never fed the finalization staleness check below.
 */
export const CONCEPT_RELEVANT_SECTIONS = new Set<BriefSectionKey>([
  "product",
  "productColor",
  "colors",
  "graphics",
  "requiredWording",
  "style",
  "printLocation",
  "exclusions",
]);

export function isConceptRelevantChange(
  changedSections: BriefSectionKey[],
): boolean {
  return changedSections.some((section) => CONCEPT_RELEVANT_SECTIONS.has(section));
}
