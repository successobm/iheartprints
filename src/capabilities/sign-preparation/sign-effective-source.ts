/**
 * R6B repair (Cursor independent review, Required Repairs #1-#4): the ONE
 * shared Signs effective-source authority, extracted so `planning`, `view`,
 * `authorization`, `production request`, `operator review`, and `worker
 * execution` all ask the SAME question the SAME way — never a second,
 * independently-drifting resolver.
 *
 * Two questions, two functions:
 *
 *   - `resolveSignEffectiveSource`: "is there a current reconstruction/
 *     recovery lifecycle, and if so, what master (if any) is current?" —
 *     the original R6B resolver, unchanged in behavior, now exported
 *     rather than a private closure inside `sign-preparation-capability.ts`.
 *   - `resolveSignSourceAssetId`: layers Constitution amendment 3.2's own
 *     KEEP/REMOVE background-treatment asset selection on top of the
 *     answer above, returning the SINGLE asset id the rest of the Signs
 *     pipeline should treat as "the current source" — exactly what
 *     `decodeSignSource` used to compute inline. Cheap: repository reads
 *     only, no asset download, no pixel decode — safe to call from a
 *     read-only review/authorization gate as well as from planning.
 *
 * Neither function ever reads, compares, or mutates
 * `SignPreparation.originalAssetId` as anything but immutable provenance
 * (it is read here only as the fallback asset id, never rebound).
 */

import type { ArtworkGeometryQualificationCapability } from "@/capabilities/artwork-reconstruction/artwork-geometry-qualification-capability";
import type { ProjectRepository } from "@/lib/db/repository";
import type { SignPreparation } from "@/lib/domain/types";
import { resolveSignBackgroundTreatment } from "@/lib/domain/types";

import type { SignRepairPlan } from "./contracts";
import type { SignBackgroundRemovalRecord } from "./sign-background-removal";

export type SignEffectiveSourceResolution =
  | { status: "original" }
  | { status: "master"; assetId: string }
  | { status: "blocked"; reason: string };

/**
 * "Is there a current reconstruction/recovery lifecycle for this project,
 * and if so, what master (if any) is current?"
 *
 *   - No `ArtworkFidelityContract` for this project, or a contract with no
 *     reconstruction job ever requested against its `sourceAssetId` →
 *     `{ status: "original" }` — no lifecycle has begun; the immutable
 *     original remains the Signs source.
 *   - A lifecycle HAS begun but `getCurrentProductionQualifiedMaster`
 *     returns nothing (pending review, geometry pending, rejected,
 *     unusable, or superseded with no confirmed geometry of its own yet)
 *     → `{ status: "blocked" }`. Never a silent fallback to the original.
 *   - A current confirmed master exists → `{ status: "master", assetId }`,
 *     the master's own `derivedAssetId`.
 *
 * "Current" is never re-derived here — `getCurrentProductionQualifiedMaster`
 * is the one authority for that chain-walk; this function only asks it.
 */
export async function resolveSignEffectiveSource(
  repo: ProjectRepository,
  artworkGeometryQualification: ArtworkGeometryQualificationCapability | undefined,
  projectId: string,
): Promise<SignEffectiveSourceResolution> {
  if (!artworkGeometryQualification) return { status: "original" };

  const contract = await repo.getArtworkFidelityContract(projectId);
  if (!contract) return { status: "original" };

  const job = await repo.getLatestArtworkReconstructionJobForSource(
    projectId,
    contract.sourceAssetId,
  );
  if (!job) return { status: "original" };

  const master = await artworkGeometryQualification.getCurrentProductionQualifiedMaster(projectId);
  if (!master || !master.derivedAssetId) {
    return {
      status: "blocked",
      reason:
        "This artwork is going through image recovery review. Sign preparation is paused until recovery is confirmed.",
    };
  }
  return { status: "master", assetId: master.derivedAssetId };
}

export type SignSourceAssetIdResolution =
  | { status: "resolved"; assetId: string }
  | { status: "blocked"; reason: string };

/**
 * The single asset id the Signs pipeline should treat as "the current
 * source" right now — `resolveSignEffectiveSource`'s answer, with
 * amendment 3.2's own KEEP/REMOVE background-treatment selection layered
 * on top exactly as `decodeSignSource` always applied it. No asset
 * download, no pixel decode — a cheap, repository-reads-only check safe to
 * call from `authorizeSignRepairPlan`, `requestSignFinalArtwork`,
 * `loadSignPlanOperatorReview`, and the final-artwork worker alike.
 *
 * While a Production-Qualified Clean Master is the effective source, the
 * Signs-owned "remove" background-removal derivative (always keyed to
 * `preparation.originalAssetId`, and therefore stale relative to the
 * master) is never consulted — the master is already a governed,
 * background-isolated derivative in its own right and is used directly.
 */
export async function resolveSignSourceAssetId(
  repo: ProjectRepository,
  artworkGeometryQualification: ArtworkGeometryQualificationCapability | undefined,
  preparation: Pick<SignPreparation, "projectId" | "originalAssetId" | "backgroundTreatment" | "backgroundRemoval">,
): Promise<SignSourceAssetIdResolution> {
  const effectiveSource = await resolveSignEffectiveSource(
    repo,
    artworkGeometryQualification,
    preparation.projectId,
  );
  if (effectiveSource.status === "blocked") {
    return { status: "blocked", reason: effectiveSource.reason };
  }
  if (effectiveSource.status === "master") {
    return { status: "resolved", assetId: effectiveSource.assetId };
  }

  const treatment = resolveSignBackgroundTreatment(preparation.backgroundTreatment);
  const removal = preparation.backgroundRemoval as unknown as SignBackgroundRemovalRecord | null;
  const assetId =
    treatment === "remove" &&
    removal?.status === "removed" &&
    removal.preparedAssetId &&
    removal.sourceAssetId === preparation.originalAssetId
      ? removal.preparedAssetId
      : preparation.originalAssetId;
  return { status: "resolved", assetId };
}

export type SignPlanCurrencyResolution =
  | { status: "current" }
  | { status: "stale" }
  | { status: "blocked"; reason: string };

/**
 * R6B repair (Cursor independent review, Required Repairs #1-#4): the ONE
 * "is this persisted plan still current?" check, reused identically by
 * `authorizeSignRepairPlan`, `isSignPlanCurrent` (the customer view's
 * replan trigger), `requestSignFinalArtwork`, `loadSignPlanOperatorReview`,
 * and the final-artwork worker's own pre-execution fence. Never a second,
 * independently-drifting notion of "current" — every caller asks this one
 * function the same way.
 *
 * Cheap: resolves the CURRENT effective source's asset id
 * (`resolveSignSourceAssetId` — repository reads only, no asset download)
 * and compares it against `plan.sourceAssetId`, the exact asset id the
 * plan was formulated against. Assets in this codebase are immutable/
 * append-only once created, so an asset-id match is exactly as strong a
 * guarantee as a byte-level hash comparison here, at a fraction of the
 * cost — the worker's own execution-time fence separately re-verifies the
 * actual downloaded bytes against `plan.sourceSha256` as a final,
 * independent safety net once it has committed to executing.
 */
export async function resolveSignPlanCurrency(
  repo: ProjectRepository,
  artworkGeometryQualification: ArtworkGeometryQualificationCapability | undefined,
  preparation: Pick<SignPreparation, "projectId" | "originalAssetId" | "backgroundTreatment" | "backgroundRemoval">,
  plan: Pick<SignRepairPlan, "sourceAssetId">,
): Promise<SignPlanCurrencyResolution> {
  const resolved = await resolveSignSourceAssetId(repo, artworkGeometryQualification, preparation);
  if (resolved.status === "blocked") {
    return { status: "blocked", reason: resolved.reason };
  }
  return resolved.assetId === plan.sourceAssetId ? { status: "current" } : { status: "stale" };
}
