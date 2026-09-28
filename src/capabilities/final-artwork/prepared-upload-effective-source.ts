/**
 * DTF-R1 (Production-Qualified Clean Master -> DTF Clean-Master Handoff):
 * the ONE shared apparel/prepared-upload effective-source authority, in the
 * same structural role `sign-preparation/sign-effective-source.ts` already
 * plays for Signs — extracted into its own module so the DTF REQUEST path
 * (`FinalArtworkCapability.requestPreparedUploadFinalArtwork`) and the DTF
 * WORKER path (`FinalArtworkWorkerCapability`'s `runPreparedUploadJob`) ask
 * the SAME question the SAME way, never two independently-drifting
 * resolvers.
 *
 * WHY THIS EXISTS
 *
 * The apparel/prepared-upload production path predates the shared artwork
 * recovery lifecycle. It resolved its production source from
 * `ArtworkPreparation.preparedAssetId` alone — a deterministic transparent
 * derivative of the customer's immutable original — with no knowledge of
 * whether the system had since decided that original was too degraded to
 * print from and had begun a recovery/reconstruction lifecycle against it.
 * Signs closed exactly that gap in R6B; this module closes it for DTF.
 *
 * It is a SOURCE-SELECTION change and nothing else. No reconstruction is
 * started here, no provider is contacted, no candidate is judged, no
 * historical `ArtworkPreparation` row is rewritten, and no new notion of
 * "an approved reconstruction" is invented. The one authority for whether a
 * clean master is eligible remains
 * `ArtworkGeometryQualificationCapability.getCurrentProductionQualifiedMaster`
 * — this module only asks it.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE
 *
 * Nothing here makes anything `print_ready`. Selecting a Production-
 * Qualified Clean Master as the source a plate descends FROM is a different
 * act from certifying the plate that results, and authoritative Print
 * Validation remains entirely in charge of the second — see
 * `print-validation`'s own `reconstruction_certification_evidence`, which
 * DTF-R1 strengthens rather than relaxes (a plate descending from a clean
 * master still carries no reconstruction-quality/fidelity certification, so
 * automatic Print Ready is still withheld and human review is still
 * required).
 *
 * Cheap: repository reads plus one capability read. No asset download, no
 * pixel decode — safe to call from a request-time gate as well as from the
 * worker's own pre-execution fence.
 */

import type { ArtworkGeometryQualificationCapability } from "@/capabilities/artwork-reconstruction/artwork-geometry-qualification-capability";
import type { ProjectRepository } from "@/lib/db/repository";
import type { ArtworkPreparation } from "@/lib/domain/types";

/**
 * WHICH ARTWORK AUTHORITY a prepared-upload production plate descends from.
 *
 * Recorded in production provenance (`UploadedPreserveEvidence.
 * sourceAuthority`) so a plate can state what it trusted without anyone
 * inferring it from an asset id's position in a table — and so
 * authoritative Print Validation can apply the right certification
 * question to it.
 */
export type PreparedUploadSourceAuthority =
  /** The customer-approved prepared transparent derivative of their own upload. */
  | "prepared_upload"
  /**
   * The shared recovery lifecycle's current Production-Qualified Clean
   * Master — a geometry-normalized derivative of a customer-approved
   * raster reconstruction, resolved ONLY through
   * `getCurrentProductionQualifiedMaster`.
   */
  | "production_qualified_clean_master";

export type PreparedUploadEffectiveSource =
  /** CASE A: no recovery lifecycle. The approved prepared asset, exactly as before DTF-R1. */
  | { status: "prepared"; assetId: string; authority: "prepared_upload" }
  /** CASE C: a current, authorized clean master supersedes `preparedAssetId` for NEW production. */
  | {
      status: "master";
      assetId: string;
      authority: "production_qualified_clean_master";
    }
  /** CASE B: recovery has begun and no current authorized master exists. Never a silent fallback. */
  | { status: "blocked"; reason: string };

/**
 * The customer-facing sentence for CASE B.
 *
 * Deliberately NOT a "processing failed" message: nothing failed. The
 * honest condition is unresolved production authority — the system has
 * already decided this artwork needs recovery, and recovery has not
 * resolved yet. Mirrors the Signs resolver's own wording discipline.
 */
export const PREPARED_UPLOAD_RECOVERY_UNRESOLVED_REASON =
  "This artwork is going through image recovery review. Print-ready production is paused until recovery is confirmed.";

/**
 * THE PRECEDENCE, in one place:
 *
 *   1. No `ArtworkFidelityContract` for this project, or a contract with no
 *      reconstruction job ever requested against its `sourceAssetId` ->
 *      `{ status: "prepared" }`. The recovery lifecycle never began; good
 *      files are never forced through reconstruction and existing DTF
 *      behavior is bit-for-bit unchanged.
 *   2. A lifecycle HAS begun but no CURRENT, AUTHORIZED Production-
 *      Qualified Clean Master exists (job queued/running, candidate pending
 *      review, rejected, geometry pending confirmation, geometry rejected,
 *      classifier-abstained "unusable", or superseded authority) ->
 *      `{ status: "blocked" }`. NEVER a fallback to `preparedAssetId`: once
 *      the system has determined that recovery is necessary, quietly
 *      printing the pre-recovery source is the exact failure this phase
 *      exists to prevent.
 *   3. A current confirmed master exists -> `{ status: "master" }`, the
 *      master's own `derivedAssetId`, superseding `preparedAssetId` for new
 *      production work.
 *
 * "Current" is never re-derived here. `getCurrentProductionQualifiedMaster`
 * is the ONE authority for that chain-walk (project -> current confirmed
 * fidelity contract -> current accepted reconstruction -> that job's own
 * qualification row -> `"confirmed"` -> a derivative asset); this function
 * only asks it, and treats every `null` answer as "not eligible."
 *
 * FAIL-CLOSED ON A MISSING CAPABILITY. If the recovery lifecycle has begun
 * but no `ArtworkGeometryQualificationCapability` was wired in, this
 * BLOCKS rather than falling back — an unwired dependency must not be able
 * to reopen the exact silent-fallback hole this module closes. Detecting
 * the lifecycle itself needs only repository reads, so that detection is
 * never gated on the capability being present. (This is deliberately
 * stricter than `resolveSignEffectiveSource`, which returns "original"
 * when its own optional capability is absent.)
 */
export async function resolvePreparedUploadEffectiveSource(
  repo: ProjectRepository,
  artworkGeometryQualification: ArtworkGeometryQualificationCapability | undefined,
  preparation: Pick<ArtworkPreparation, "projectId"> & { preparedAssetId: string },
): Promise<PreparedUploadEffectiveSource> {
  const prepared = {
    status: "prepared",
    assetId: preparation.preparedAssetId,
    authority: "prepared_upload",
  } as const;

  const contract = await repo.getArtworkFidelityContract(preparation.projectId);
  if (!contract) return prepared;

  const job = await repo.getLatestArtworkReconstructionJobForSource(
    preparation.projectId,
    contract.sourceAssetId,
  );
  if (!job) return prepared;

  // The recovery lifecycle has begun. From here the ONLY acceptable
  // answers are "the current authorized master" or "blocked".
  if (!artworkGeometryQualification) {
    return { status: "blocked", reason: PREPARED_UPLOAD_RECOVERY_UNRESOLVED_REASON };
  }

  const master = await artworkGeometryQualification.getCurrentProductionQualifiedMaster(
    preparation.projectId,
  );
  if (!master || !master.derivedAssetId) {
    return { status: "blocked", reason: PREPARED_UPLOAD_RECOVERY_UNRESOLVED_REASON };
  }
  return {
    status: "master",
    assetId: master.derivedAssetId,
    authority: "production_qualified_clean_master",
  };
}
