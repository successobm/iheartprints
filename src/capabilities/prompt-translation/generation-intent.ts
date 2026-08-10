/**
 * Sprint 2J Phase 3: GenerationIntent — the single provider-neutral input
 * into Prompt Translation.
 *
 * Immutable. Never persisted. Never exposed to customers. Contains only
 * design intent derived from an approved Design Brief plus an optional
 * RegenerationPlan. No prompt wording, no AI terminology, no provider
 * dialect.
 */

import type {
  ConceptDirectionKey,
  DesignBriefSnapshotContent,
} from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";

/**
 * Provider-neutral instruction set for one generation attempt.
 * Does not mutate the approved Design Brief — it only describes what
 * this generation should emphasize.
 */
export interface GenerationIntent {
  readonly approvedBrief: DesignBriefSnapshotContent;
  /**
   * `null` for initial generation. Present only on the explicit customer
   * regeneration path (`GenerationJob.kind === "regeneration"`).
   */
  readonly regenerationPlan: RegenerationPlan | null;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: set only for a targeted
   * single-concept revision of a customer-selected artwork — generation
   * must produce exactly one concept, in this direction, never a fresh
   * three-direction exploration. `null` for initial generation and for an
   * explicit "show me alternatives" regeneration.
   */
  readonly targetConceptDirectionKey: ConceptDirectionKey | null;
  /**
   * True Source-Image Targeted Revision: the customer's literal revision
   * instruction ("make the border red and change it to a shield"), carried
   * verbatim from `GenerationJob.revisionInstruction`.
   *
   * This is the ONLY input that carries the requested DELTA. `approvedBrief`
   * describes design state and `regenerationPlan` describes which sections
   * were touched — neither can express "change it to a shield". Still
   * provider-neutral: it is customer language, not prompt wording, and
   * Prompt Translation (never a provider) decides how it is expressed.
   *
   * `null` for initial generation and for a three-direction regeneration.
   */
  readonly revisionInstruction: string | null;
}

/** Initial generation — brief only, no regeneration fields. */
export function createInitialGenerationIntent(
  approvedBrief: DesignBriefSnapshotContent,
): GenerationIntent {
  return Object.freeze({
    approvedBrief,
    regenerationPlan: null,
    targetConceptDirectionKey: null,
    revisionInstruction: null,
  });
}

/**
 * Explicit regeneration — brief + plan. Never used for initial generation.
 * `targetConceptDirectionKey` is `null` for an ordinary "explore three
 * alternatives" regeneration, and set for a targeted single-concept
 * revision (Sprint 2G Live Acceptance Corrective Pass).
 */
export function createRegenerationGenerationIntent(
  approvedBrief: DesignBriefSnapshotContent,
  regenerationPlan: RegenerationPlan,
  targetConceptDirectionKey: ConceptDirectionKey | null = null,
  /**
   * True Source-Image Targeted Revision: only meaningful alongside a
   * `targetConceptDirectionKey` — a three-direction regeneration has no
   * single source concept to apply a delta to.
   */
  revisionInstruction: string | null = null,
): GenerationIntent {
  return Object.freeze({
    approvedBrief,
    regenerationPlan,
    targetConceptDirectionKey,
    revisionInstruction,
  });
}
