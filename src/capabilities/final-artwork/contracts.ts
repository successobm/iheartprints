/**
 * Sprint 2M Phase 2B: provider-neutral contracts for the Final Artwork /
 * production-transformation orchestration boundary. Sprint 2M Phase 2C is
 * the first phase that actually constructs and consumes `FinalArtworkInput`
 * — see `final-artwork-worker/build-final-artwork-input.ts`.
 *
 * `FinalDirectionApproval` and `FinalArtworkJob` are durable, persisted
 * records — their shape lives in `@/lib/domain/types` alongside
 * `GenerationJob`/`DesignBriefVersion`, not here (mirrors how every other
 * persisted entity in this codebase is defined once, in the domain layer,
 * and re-used by whichever capability owns writing to it).
 *
 * `FinalArtworkInput` below is an ephemeral, never-persisted, provider-
 * neutral input contract — the caller (`FinalArtworkWorkerCapability`)
 * resolves every field from already-persisted, immutable records before
 * constructing one; nothing downstream is tempted to pass a raw
 * `AssetRecord`/`TShirtDesignBrief` into a provider instead.
 */

import type {
  FinalizationTransformation,
  PrintValidationReport,
  ProductionRequirements,
} from "@/capabilities/print-validation/contracts";
import type { DesignBriefSnapshotContent } from "@/lib/domain/types";

/**
 * Everything the Final Artwork orchestration needs, already resolved by the
 * caller (mirrors `PrintValidationInput` and `GenerationPromptRequest`'s
 * "caller does I/O, the contract only carries validated data" shape).
 * Never a raw customer/API object; never a storage key or other
 * implementation detail (Goal 7) — IDs and validated domain snapshots only.
 */
export interface FinalArtworkInput {
  readonly projectId: string;
  /** Sprint 2M Phase 2C addition: the exact job this input was resolved for — never "whatever is currently active" (Goal 3). */
  readonly finalArtworkJobId: string;
  /** Sprint 2M Phase 2C addition: the exact, active approval that authorized this job — resolved once, never re-derived mid-job. */
  readonly finalDirectionApprovalId: string;
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
