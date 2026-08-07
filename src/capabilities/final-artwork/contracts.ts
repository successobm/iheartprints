/**
 * Sprint 2M Phase 2B: provider-neutral contracts for the reserved Final
 * Artwork / production-transformation orchestration boundary.
 *
 * `FinalDirectionApproval` and `FinalArtworkJob` are durable, persisted
 * records — their shape lives in `@/lib/domain/types` alongside
 * `GenerationJob`/`DesignBriefVersion`, not here (mirrors how every other
 * persisted entity in this codebase is defined once, in the domain layer,
 * and re-used by whichever capability owns writing to it).
 *
 * `FinalArtworkInput` below is the one new thing this module defines: an
 * ephemeral, never-persisted, provider-neutral input contract for a future
 * production-transformation provider. Nothing in Phase 2B constructs or
 * consumes it yet — no transformation runs — but the shape exists now so a
 * later phase's real orchestration doesn't have to invent it under
 * pressure, and so nothing downstream is tempted to pass a raw
 * `AssetRecord`/`TShirtDesignBrief` into a provider instead.
 */

import type {
  FinalizationTransformation,
  PrintValidationReport,
  ProductionRequirements,
} from "@/capabilities/print-validation/contracts";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

/**
 * Reserved — not constructed or consumed anywhere in Phase 2B.
 *
 * Everything a future production-transformation provider would need,
 * already resolved by the caller (mirrors `PrintValidationInput` and
 * `GenerationPromptRequest`'s "caller does I/O, the contract only carries
 * validated data" shape). Never a raw customer/API object; never a storage
 * key or other implementation detail (Goal 7) — IDs and validated domain
 * snapshots only.
 */
export interface FinalArtworkInput {
  readonly projectId: string;
  readonly artworkVersionId: string;
  readonly designBriefVersionId: string;
  readonly approvedBrief: DesignBriefSnapshotContent;
  readonly productionRequirements: ProductionRequirements;
  /**
   * The provisional (or, once one exists, a recomputed) Print Validation
   * report for the source concept — never re-derived by this capability
   * itself (Goal 9: Final Artwork must not duplicate Print Validation's
   * rules).
   */
  readonly provisionalPrintValidation: PrintValidationReport;
  /** Internal id only — never a storage key (Goal 7/15). */
  readonly sourceAssetId: string;
  readonly requiredTransformations: FinalizationTransformation[];
}
