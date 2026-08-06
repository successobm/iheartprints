import { deriveRequiredWording } from "@/lib/domain/required-wording";
import type {
  ConceptEvaluationCriterionKey,
  ConceptEvaluationCriterionScore,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";
import { CONCEPT_RELEVANT_SECTIONS } from "@/capabilities/shared/concept-relevance";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";

import type {
  RegenerationChange,
  RegenerationConceptEvaluationInput,
  RegenerationIntelligenceInput,
  RegenerationPlan,
} from "./contracts";

/**
 * Regeneration Intelligence (Sprint 2J Phase 1).
 *
 * Determines what should change in the NEXT generation attempt. It does not
 * generate artwork, does not evaluate artwork, does not re-score concepts,
 * and does not mutate the Design Brief. See the module doc in `contracts.ts`
 * for the full pipeline placement and purity guarantees.
 *
 * ## Priority order (deterministic; documented per Sprint 2J requirements)
 *
 * 1. **Explicit exclusions override everything.** `approvedBrief.exclusions`
 *    — and any evaluation-confirmed exclusion violation — always lands in
 *    `avoid[]` first, ahead of every other signal.
 * 2. **Previously rejected ideas are never reintroduced.**
 *    `currentGeneration.rejectedSections` always routes to `avoid[]`,
 *    regardless of what the brief or evaluation currently say about that
 *    section.
 * 3. **Required wording is never removed.** Whenever `requiredWording` has
 *    any action at all (preserve/strengthen/remove/replace), it is
 *    surfaced at the front of `priorityChanges` — a provider can never miss
 *    it. "Removed" here only ever means the customer themselves explicitly
 *    cleared it; Regeneration Intelligence never drops present wording on
 *    its own initiative.
 * 4. **Customer revisions always override evaluation suggestions.** A
 *    section the customer touched (per `revisionHistory`) is decided from
 *    the customer's side only; Evaluation is not consulted a second time to
 *    produce a competing suggestion for that same section.
 * 5. **Evaluation failures produce regeneration actions.** Any
 *    regeneration-relevant section evaluation marked failed, that the
 *    customer did not already touch, becomes an entry in
 *    `evaluationDrivenChanges` / `strengthen`.
 * 6. **Satisfied requirements become preservation actions.** A
 *    customer-touched section already confirmed by evaluation, or an
 *    untouched section evaluation confirmed passed, moves to `preserve`
 *    rather than being re-requested.
 * 7. **Later customer revisions supersede earlier ones.** A section touched
 *    more than once across `revisionHistory` is categorized `replace`
 *    (using the current approved brief value — the latest one) rather than
 *    `strengthen`.
 *
 * Only sections in `CONCEPT_RELEVANT_SECTIONS` (the same shared policy
 * `RevisionIntelligenceCapability` and `ConceptGenerationCapability` use to
 * decide what actually changes generated artwork) produce plan entries.
 * Sections like audience/purpose/notes matter to the brief but do not
 * change what a provider generates, so they are intentionally out of scope
 * here — exactly as they are out of scope for concept staleness today.
 */
export interface RegenerationIntelligenceCapability {
  planNextGeneration(input: RegenerationIntelligenceInput): RegenerationPlan;
}

export function createRegenerationIntelligenceCapability(): RegenerationIntelligenceCapability {
  return {
    planNextGeneration(input) {
      return buildRegenerationPlan(input);
    },
  };
}

/**
 * Canonical, deterministic ordering for every plan array. `exclusions` is
 * not itself a `CONCEPT_RELEVANT_SECTIONS` member (it is handled as its own
 * unconditional `avoid` source) but still needs a stable sort position, so
 * it is pinned first.
 */
const SECTION_ORDER: BriefSectionKey[] = [
  "exclusions",
  "requiredWording",
  "product",
  "productColor",
  "colors",
  "style",
  "graphics",
  "printLocation",
];

/** Only sections that actually change what a provider generates (Sprint 2G Part 3 policy, reused). */
const REGENERATION_SECTIONS: BriefSectionKey[] = SECTION_ORDER.filter((section) =>
  CONCEPT_RELEVANT_SECTIONS.has(section),
);

/**
 * Which Concept Evaluation criterion (if any) speaks to a given brief
 * section. Sections with no natural criterion (e.g. `product`,
 * `printLocation` — the garment/placement themselves, not an artwork
 * quality) never produce evaluation-driven entries; that is a deliberate
 * scope limit, not an oversight.
 */
const SECTION_TO_CRITERION: Partial<
  Record<BriefSectionKey, ConceptEvaluationCriterionKey>
> = {
  requiredWording: "required_wording",
  style: "style",
  graphics: "graphics",
  colors: "color_palette",
  productColor: "product_compatibility",
};

const SECTION_LABELS: Partial<Record<BriefSectionKey, string>> = {
  exclusions: "the exclusions",
  requiredWording: "the required wording",
  product: "the product",
  productColor: "the product color",
  colors: "the design colors",
  style: "the design style",
  graphics: "the graphics",
  printLocation: "the print location",
};

function sectionLabel(section: BriefSectionKey): string {
  return SECTION_LABELS[section] ?? section;
}

function sectionOrderIndex(section: BriefSectionKey): number {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

function sortBySection(changes: RegenerationChange[]): RegenerationChange[] {
  return [...changes].sort(
    (a, b) => sectionOrderIndex(a.section) - sectionOrderIndex(b.section),
  );
}

function getSectionValue(
  brief: DesignBriefSnapshotContent,
  section: BriefSectionKey,
): string | string[] | null {
  switch (section) {
    case "product":
      return brief.productSummary;
    case "productColor":
      return brief.shirtColor;
    case "colors":
      return brief.preferredColors;
    case "graphics":
      return brief.designDescription;
    case "requiredWording":
      return deriveRequiredWording({ exactText: brief.exactText }).text;
    case "style":
      return brief.designStyle;
    case "printLocation":
      return brief.printPlacement;
    default:
      return null;
  }
}

function isEmptySectionValue(value: string | string[] | null): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value === null || value.trim().length === 0;
}

function findCriterion(
  evaluation: RegenerationConceptEvaluationInput | null,
  key: ConceptEvaluationCriterionKey | undefined,
): ConceptEvaluationCriterionScore | null {
  if (!evaluation || !key) return null;
  return evaluation.result.criteria.find((c) => c.key === key) ?? null;
}

export function buildRegenerationPlan(
  input: RegenerationIntelligenceInput,
): RegenerationPlan {
  const { approvedBrief, latestEvaluation, revisionHistory, currentGeneration } =
    input;
  const rejected = new Set(
    (currentGeneration.rejectedSections ?? []).filter((section) =>
      REGENERATION_SECTIONS.includes(section),
    ),
  );

  const avoid: RegenerationChange[] = [];
  const preserve: RegenerationChange[] = [];
  const strengthen: RegenerationChange[] = [];
  const remove: RegenerationChange[] = [];
  const replace: RegenerationChange[] = [];
  const customerRequestedChanges: RegenerationChange[] = [];
  const evaluationDrivenChanges: RegenerationChange[] = [];

  // Priority 1: explicit exclusions override everything.
  const exclusionsText = approvedBrief.exclusions?.trim();
  if (exclusionsText) {
    avoid.push({
      section: "exclusions",
      description: exclusionsText,
      source: "brief",
      reason: "Explicit exclusions always override every other instruction.",
    });
  }
  const exclusionCriterion = findCriterion(latestEvaluation, "exclusions");
  if (exclusionCriterion?.passed === false && exclusionsText) {
    avoid.push({
      section: "exclusions",
      description: `Previous concept did not respect: ${exclusionsText}`,
      source: "evaluation",
      reason: "Evaluation flagged a violated exclusion — it must not recur.",
    });
  }

  // Priority 2: previously rejected ideas are never reintroduced.
  for (const section of sortBySection(
    [...rejected].map((section) => ({
      section,
      description: `Do not reintroduce the previously rejected direction for ${sectionLabel(section)}.`,
      source: "brief" as const,
      reason: "Previously rejected ideas are never reintroduced.",
    })),
  )) {
    avoid.push(section);
  }

  // Which sections the customer touched since approval, and how many times
  // (more than once ⇒ a later revision supersedes an earlier one).
  const touchCounts = new Map<BriefSectionKey, number>();
  for (const impact of revisionHistory) {
    for (const section of impact.changedSections) {
      if (!REGENERATION_SECTIONS.includes(section)) continue;
      touchCounts.set(section, (touchCounts.get(section) ?? 0) + 1);
    }
  }

  // Priority 4/6/7: customer-touched sections — decided from the customer's
  // side only; evaluation is not consulted again for these sections below.
  for (const section of REGENERATION_SECTIONS) {
    const count = touchCounts.get(section);
    if (!count || rejected.has(section)) continue;

    const value = getSectionValue(approvedBrief, section);
    const criterion = findCriterion(latestEvaluation, SECTION_TO_CRITERION[section]);
    const satisfied = criterion?.passed === true;

    let change: RegenerationChange;
    if (isEmptySectionValue(value)) {
      change = {
        section,
        description: `Customer removed ${sectionLabel(section)} — do not include it in the next generation.`,
        source: "customer_revision",
        reason: "Customer explicitly requested this be removed.",
      };
      remove.push(change);
    } else if (satisfied) {
      change = {
        section,
        description: `${sectionLabel(section)} already reflects the customer's request — keep as-is.`,
        source: "customer_revision",
        reason: "Customer request already satisfied by the latest evaluation.",
      };
      preserve.push(change);
    } else if (count > 1) {
      change = {
        section,
        description: `Use the customer's latest direction for ${sectionLabel(section)}, superseding earlier requests.`,
        source: "customer_revision",
        reason: "A later customer revision supersedes an earlier one for this section.",
      };
      replace.push(change);
    } else {
      change = {
        section,
        description: `Make sure ${sectionLabel(section)} reflects the customer's requested change.`,
        source: "customer_revision",
        reason: "Customer requested this change and it is not yet confirmed by evaluation.",
      };
      strengthen.push(change);
    }
    customerRequestedChanges.push(change);
  }

  // Priority 5/6: evaluation-driven signal, but only for sections the
  // customer did not already touch this cycle (customer override).
  if (latestEvaluation) {
    for (const section of REGENERATION_SECTIONS) {
      if (touchCounts.has(section) || rejected.has(section)) continue;
      const criterion = findCriterion(latestEvaluation, SECTION_TO_CRITERION[section]);
      if (!criterion || criterion.passed === null) continue;

      if (criterion.passed) {
        preserve.push({
          section,
          description: `${sectionLabel(section)} matched the brief — keep it.`,
          source: "evaluation",
          reason: "Evaluation confirmed this criterion is satisfied.",
        });
        continue;
      }

      const value = getSectionValue(approvedBrief, section);
      const change: RegenerationChange = {
        section,
        description: isEmptySectionValue(value)
          ? `${sectionLabel(section)} was missing from the previous concept.`
          : `Strengthen ${sectionLabel(section)} so it clearly matches the brief.`,
        source: "evaluation",
        reason: "Evaluation reported this criterion failed.",
      };
      strengthen.push(change);
      evaluationDrivenChanges.push(change);
    }
  }

  // Sections regeneration cares about that had no signal either way.
  const touchedOrAssessed = new Set<BriefSectionKey>([
    ...touchCounts.keys(),
    ...rejected,
    ...[...preserve, ...strengthen].map((c) => c.section),
  ]);
  const unchangedSections = REGENERATION_SECTIONS.filter(
    (section) => !touchedOrAssessed.has(section),
  );

  // Priority 3: required wording, whichever bucket it landed in, is always
  // surfaced first in priorityChanges (right after avoid).
  const requiredWordingChange = [...preserve, ...strengthen, ...remove, ...replace].find(
    (c) => c.section === "requiredWording",
  );

  const priorityChanges: RegenerationChange[] = [
    ...avoid,
    ...(requiredWordingChange ? [requiredWordingChange] : []),
    ...sortBySection(
      customerRequestedChanges.filter((c) => c.section !== "requiredWording"),
    ),
    ...sortBySection(
      evaluationDrivenChanges.filter((c) => c.section !== "requiredWording"),
    ),
  ];

  return {
    preserve: sortBySection(preserve),
    strengthen: sortBySection(strengthen),
    remove: sortBySection(remove),
    replace: sortBySection(replace),
    avoid: sortBySection(avoid),
    priorityChanges,
    unchangedSections,
    customerRequestedChanges: sortBySection(customerRequestedChanges),
    evaluationDrivenChanges: sortBySection(evaluationDrivenChanges),
    generationAttempt: currentGeneration.attemptNumber,
    reason: describePlan({
      avoidCount: avoid.length,
      customerCount: customerRequestedChanges.length,
      evaluationCount: evaluationDrivenChanges.length,
      preserveCount: preserve.length,
      attemptNumber: currentGeneration.attemptNumber,
    }),
  };
}

function describePlan(counts: {
  avoidCount: number;
  customerCount: number;
  evaluationCount: number;
  preserveCount: number;
  attemptNumber: number;
}): string {
  const parts: string[] = [];
  if (counts.avoidCount > 0) parts.push(`${counts.avoidCount} thing(s) to avoid`);
  if (counts.customerCount > 0) {
    parts.push(`${counts.customerCount} customer-requested change(s)`);
  }
  if (counts.evaluationCount > 0) {
    parts.push(`${counts.evaluationCount} evaluation-driven fix(es)`);
  }
  if (counts.preserveCount > 0) {
    parts.push(`${counts.preserveCount} confirmed working element(s) preserved`);
  }

  if (parts.length === 0) {
    return `Generation attempt ${counts.attemptNumber}: no prior evaluation or revisions to act on — following the approved brief as-is.`;
  }
  return `Generation attempt ${counts.attemptNumber}: ${parts.join(", ")}.`;
}
