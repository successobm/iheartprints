import type {
  BriefSectionKey,
  SectionRequirementTier,
} from "@/capabilities/shared/contracts";

/**
 * InterviewCoveragePolicy (Sprint 2F; re-scoped Sprint 2L Phase 1B).
 *
 * Sprint 2E intentionally reused the four Sprint 1 scripted fields
 * (product, graphics, productColor, requiredWording) as "blocking" purely
 * for backward compatibility with the fixed interview ladder. Sprint 2F
 * additionally treated purpose/audience/style/colors/printLocation as a
 * uniform "high value — must be resolved or explicitly deferred before
 * summary" tier. A live acceptance test showed that uniform treatment
 * produces a questionnaire: every one of those five sections got asked (or
 * required an explicit "you choose" deferral) even when the customer's own
 * message already established the same meaning in context, and even
 * though none of them actually change what gets *generated* the way
 * product/graphics/color/placement do.
 *
 * Sprint 2L Phase 1B re-scopes this policy around **generation readiness**
 * rather than schema completeness (see ARCHITECTURE.md §10b "Brief
 * Completeness vs. Generation Readiness"). This module is the single
 * source of truth for which Design Brief sections gate summary/approval
 * (the "generation readiness" view — `BriefEvaluation.summaryReadiness` /
 * `approvalReadiness`) versus which are simply tracked and shown when
 * known but never proactively asked about or required (the "brief
 * completeness" view — `BriefEvaluation.overall`, which still covers every
 * section regardless of tier).
 *
 * Pure, deterministic, provider-neutral data — no capability instance, no
 * side effects — so both `BriefEvaluationCapability` (tier/deferrability
 * per section) and `InterviewIntelligenceCapability` (tie-break ordering,
 * question-necessity) can import it directly without creating a
 * capability dependency cycle.
 */

/**
 * Required / blocking — must be explicitly resolved (provided, or "none"
 * for requiredWording specifically). Deferral is never allowed: the print
 * shop cannot proceed at all without knowing what is being printed, what
 * the design should depict, what text (if any) must appear, and what
 * garment color it prints on — these are the facts every other decision
 * hangs off of, not points of taste a designer could reasonably choose on
 * the customer's behalf. Generation would likely be wrong or unusable
 * without any one of these (Sprint 2L Phase 1B Goal 2, category A).
 */
const REQUIRED_SECTIONS: BriefSectionKey[] = [
  "product",
  "graphics",
  "requiredWording",
  "productColor",
];

/**
 * High-value / contextually important — worth one targeted question if
 * genuinely unresolved, because it is a physical production fact a print
 * shop cannot safely guess (where the print goes) rather than a creative
 * preference (Sprint 2L Phase 1B Goal 2, category B). Deferrable: a
 * customer with no preference can hand it to the designer without
 * blocking progress.
 *
 * Sprint 2L Phase 1B narrowed this tier from five sections to one.
 * `purpose`, `audience`, `style`, and `colors` moved to
 * `OPTIONAL_SECTIONS` below — see that array's doc comment for why.
 */
const HIGH_VALUE_SECTIONS: BriefSectionKey[] = ["printLocation"];

/**
 * Optional — never gates summary/approval, never asked proactively;
 * captured and shown normally whenever the customer volunteers or context
 * establishes them, otherwise simply absent from the Design Summary (the
 * same way `exclusions`/`additionalNotes` have always behaved).
 *
 * Sprint 2L Phase 1B moved `purpose`, `audience`, `style`, and `colors`
 * (artwork colors) here from `HIGH_VALUE_SECTIONS`. None of these change
 * *what artwork gets generated* the way product/graphics/wording/color/
 * placement do — they describe context around the design, and a live
 * acceptance test showed that asking about each of them in turn (even
 * with a deferral escape hatch) produces a questionnaire, not a
 * conversation:
 *
 *   - `purpose` / `audience` are Goal 2 category C (inferable/derivable):
 *     "I'm in a bowling league and our team is called My 3 Sons" already
 *     establishes both without a separate question, and forcing the
 *     customer to restate them as isolated answers ("bowling league" /
 *     "my team") produces exactly the low-quality, unsynthesized values
 *     Goal 8 calls out.
 *   - `style` / `colors` (artwork colors) are Goal 2 category D
 *     (designer-delegatable): once `graphics` (design direction) is
 *     known, a designer can make a reasonable creative call on palette
 *     and finer stylistic details without the customer being forced to
 *     say "no preference" every time (Goal 11).
 *
 * None of the four stop being *tracked* — `ALL_SECTIONS_IN_POLICY_ORDER`
 * still includes them, `BriefEvaluation` still reports their resolution,
 * and `DesignSummaryCapability` still shows them in the summary whenever
 * they do have a value (customer-volunteered or understood from context).
 * They simply never block summary/approval readiness and are never the
 * subject of a proactively-generated question — see
 * `InterviewIntelligenceCapability`, which only walks
 * `REQUIRED_TIE_BREAK`/`HIGH_VALUE_TIE_BREAK` for `ask`/`clarify` acts.
 */
const OPTIONAL_SECTIONS: BriefSectionKey[] = [
  "purpose",
  "audience",
  "style",
  "colors",
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
 * Sprint 2L Phase 1B (Goal 4): the static half of question-necessity —
 * "does this section's *tier* ever warrant a proactively-generated
 * question at all?" The dynamic half (is it already resolved/inferred/
 * ambiguous *right now*) lives in `InterviewIntelligenceCapability`, which
 * consumes this alongside per-turn `BriefEvaluation` state; this function
 * only answers the static, section-level question so both capabilities
 * share one answer instead of re-deriving it from `tierOf` independently.
 *
 *   - `"blocking"` — required tier; always worth asking until resolved
 *     (or, for `requiredWording`, resolved to explicit "none").
 *   - `"askWorthy"` — high-value tier; worth one question if still
 *     genuinely unresolved, because it is a production fact, not a
 *     creative preference.
 *   - `"delegable"` — optional tier; never proactively asked. Captured
 *     normally when volunteered or inferred; otherwise silently absent
 *     from the Design Summary, never blocking, never requiring an
 *     explicit "you choose."
 */
export type QuestionNecessity = "blocking" | "askWorthy" | "delegable";

export function questionNecessity(section: BriefSectionKey): QuestionNecessity {
  switch (tierOf(section)) {
    case "required":
      return "blocking";
    case "high_value":
      return "askWorthy";
    case "optional":
      return "delegable";
  }
}

/**
 * Tie-break order within each tier (the priority *between* tiers — required
 * fully before high-value, high-value fully before optional — is decided by
 * `InterviewIntelligenceCapability`, not here). Extracted from the sprint
 * brief's flat "practical starting order" by taking each tier's relative
 * ordering from that list: product → graphics → requiredWording →
 * productColor, and printLocation.
 */
export const REQUIRED_TIE_BREAK: BriefSectionKey[] = [
  "product",
  "graphics",
  "requiredWording",
  "productColor",
];

/** Sprint 2L Phase 1B: narrowed to `printLocation` only — see `HIGH_VALUE_SECTIONS`'s doc comment. */
export const HIGH_VALUE_TIE_BREAK: BriefSectionKey[] = ["printLocation"];

export const OPTIONAL_TIE_BREAK: BriefSectionKey[] = [
  "purpose",
  "audience",
  "style",
  "colors",
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
