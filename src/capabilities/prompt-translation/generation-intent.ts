/**
 * Sprint 2J Phase 3: GenerationIntent — the single provider-neutral input
 * into Prompt Translation.
 *
 * Immutable. Never persisted. Never exposed to customers. Contains only
 * design intent derived from an approved Design Brief plus an optional
 * RegenerationPlan. No prompt wording, no AI terminology, no provider
 * dialect.
 */

import type { DesignBriefSnapshotContent } from "@/lib/domain/types";
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
}

/** Initial generation — brief only, no regeneration fields. */
export function createInitialGenerationIntent(
  approvedBrief: DesignBriefSnapshotContent,
): GenerationIntent {
  return Object.freeze({
    approvedBrief,
    regenerationPlan: null,
  });
}

/** Explicit regeneration — brief + plan. Never used for initial generation. */
export function createRegenerationGenerationIntent(
  approvedBrief: DesignBriefSnapshotContent,
  regenerationPlan: RegenerationPlan,
): GenerationIntent {
  return Object.freeze({
    approvedBrief,
    regenerationPlan,
  });
}
