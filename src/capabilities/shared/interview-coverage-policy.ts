import type {
  BriefSectionKey,
  SectionRequirementTier,
} from "@/capabilities/shared/contracts";

/**
 * InterviewCoveragePolicy (Sprint 2F).
 *
 * Sprint 2E intentionally reused the four Sprint 1 scripted fields
 * (product, graphics, productColor, requiredWording) as "blocking" purely
 * for backward compatibility with the fixed interview ladder. That was
 * never meant to be the permanent constitutional standard — Constitution
 * §9 (The Design Interview) expects purpose, audience, style, colors, and
 * print location to be gathered too, "adapting based on prior answers" and
 * "not ask[ing] unnecessary questions."
 *
 * This module is the one place that decides, for the T-shirt workflow, how
 * much each Design Brief section matters and whether it can be explicitly
 * deferred to the designer's judgment instead of answered. It is pure,
 * deterministic, provider-neutral data — no capability instance, no side
 * effects — so both `BriefEvaluationCapability` (tier/deferrability per
 * section) and `InterviewIntelligenceCapability` (tie-break ordering) can
 * import it directly without creating a capability dependency cycle.
 */

/**
 * Required — must be explicitly resolved (provided, or "none" for
 * requiredWording specifically). Deferral is never allowed: the print shop
 * cannot proceed at all without knowing what is being printed, what the
 * design should depict, what text (if any) must appear, and what garment
 * color it prints on — these are the facts every other decision hangs off
 * of, not points of taste a designer could reasonably choose on the
 * customer's behalf.
 */
const REQUIRED_SECTIONS: BriefSectionKey[] = [
  "product",
  "graphics",
  "requiredWording",
  "productColor",
];

/**
 * High-value — materially affects concept quality and is worth asking
 * about, but a customer who genuinely has no preference can hand it to the
 * designer without blocking progress. Each of these measurably changes what
 * gets generated (mood, who it needs to resonate with, look, palette,
 * placement) but none of them is a fact the shop cannot proceed without.
 */
const HIGH_VALUE_SECTIONS: BriefSectionKey[] = [
  "purpose",
  "audience",
  "style",
  "colors",
  "printLocation",
];

/**
 * Optional — nice-to-have context that never gates summary or approval.
 * Asking proactively would turn the interview into an exhaustive checklist
 * (explicitly disallowed); these are only ever captured when the customer
 * volunteers them.
 */
const OPTIONAL_SECTIONS: BriefSectionKey[] = [
  "references",
  "exclusions",
  "additionalNotes",
  // Not yet backed by a real extraction/production rule — reserved.
  "production",
  "layoutPreference",
];

const TIER_BY_SECTION: Record<BriefSectionKey, SectionRequirementTier> = {
  ...Object.fromEntries(REQUIRED_SECTIONS.map((s) => [s, "required"])),
  ...Object.fromEntries(HIGH_VALUE_SECTIONS.map((s) => [s, "high_value"])),
  ...Object.fromEntries(OPTIONAL_SECTIONS.map((s) => [s, "optional"])),
} as Record<BriefSectionKey, SectionRequirementTier>;

export function tierOf(section: BriefSectionKey): SectionRequirementTier {
  return TIER_BY_SECTION[section] ?? "optional";
}

export function isDeferrable(section: BriefSectionKey): boolean {
  return tierOf(section) !== "required";
}

/**
 * Tie-break order within each tier (the priority *between* tiers — required
 * fully before high-value, high-value fully before optional — is decided by
 * `InterviewIntelligenceCapability`, not here). Extracted from the sprint
 * brief's flat "practical starting order" by taking each tier's relative
 * ordering from that list: product → graphics → requiredWording →
 * productColor, and purpose → audience → style → colors → printLocation.
 */
export const REQUIRED_TIE_BREAK: BriefSectionKey[] = [
  "product",
  "graphics",
  "requiredWording",
  "productColor",
];

export const HIGH_VALUE_TIE_BREAK: BriefSectionKey[] = [
  "purpose",
  "audience",
  "style",
  "colors",
  "printLocation",
];

export const OPTIONAL_TIE_BREAK: BriefSectionKey[] = [
  "exclusions",
  "references",
  "additionalNotes",
  "production",
  "layoutPreference",
];

/** All evaluated sections, in a stable, documented order. */
export const ALL_SECTIONS_IN_POLICY_ORDER: BriefSectionKey[] = [
  ...REQUIRED_TIE_BREAK,
  ...HIGH_VALUE_TIE_BREAK,
  ...OPTIONAL_TIE_BREAK,
];
