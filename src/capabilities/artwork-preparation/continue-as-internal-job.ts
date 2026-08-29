/**
 * Phase 28P: "Continue as Internal Job" — the narrow, owner-safe answer to
 * a real operational gap Phases 28M/28N/28O kept running into. Print'em All
 * staff, working as a genuinely internal session, need to pick up an
 * ordinary CUSTOMER project's already-approved, already-corrected artwork
 * and carry it into production WITHOUT repeating Magic Wand/background
 * correction and WITHOUT granting the customer's own project free
 * production.
 *
 * THE CORE RULE THIS FILE ENFORCES
 *
 * The source project is never touched. Not its entitlement, not its
 * `acquisition_session_id`, not a single row it owns. This function only
 * ever WRITES to a brand-new project it creates itself. Every read against
 * the source is a plain, non-mutating repository/asset read.
 *
 * WHY A NEW PROJECT, NOT A FLAG ON THE OLD ONE
 *
 * `PrintProject.acquisitionSessionId` is bound once, at INSERT, and every
 * paid-value gate (`authorizeFinalization`, `isInternalProject`,
 * `resolveAuthority` — see `acquisition-capability.ts`) reads that binding
 * as the durable, non-retroactive authority for the project's entire life.
 * There is deliberately no "make this project internal after the fact"
 * operation anywhere in this codebase, and this phase does not invent one —
 * doing so would let visiting `/internal/access` later silently convert any
 * customer's project into a free one, which is exactly the regression this
 * phase's mission forbids. Instead this function creates a SECOND project
 * bound to the acting internal session (the exact same `repo.createProject`
 * primitive `POST /api/projects` already uses for a brand-new customer),
 * which is internal by the same construction every other internal project
 * already is.
 *
 * WHY A BYTE-IDENTICAL COPY, NOT A CROSS-PROJECT ASSET REFERENCE
 *
 * `AssetRecord.projectId` is a real column and `AssetStorageProvider.upload`
 * keys every object's storage path by the `projectId` it was uploaded under
 * (`asset-capability.ts`'s `uploadCustomerArtwork`/`uploadConceptImage`).
 * Every existing preparation/asset relationship in this codebase assumes an
 * `ArtworkPreparation`'s `originalAssetId`/`preparedAssetId` point at an
 * asset that belongs to THAT SAME project — nothing anywhere checks that
 * invariant explicitly, which is exactly why it must never be the thing
 * that's first violated. Pointing the new project's preparation at the old
 * project's asset ROWS would create a project whose "original artwork" is
 * silently owned by someone else's project, for no benefit (storage cost of
 * one small PNG twice). So this downloads the exact accepted bytes and
 * re-uploads them under the new project's own id — a true, byte-identical,
 * project-scoped copy — and records where they really came from in
 * `metadata.internalContinuation` instead, mirroring the exact pattern
 * `correctionLineage`/`derivedFromAssetId` already use for "how did this
 * asset really come to exist" provenance (see `finalizeCorrection` in
 * `artwork-preparation-capability.ts`).
 *
 * WHAT IS ELIGIBLE
 *
 * Only a source preparation whose `status === "approved"` with a real
 * `preparedAssetId`/`preparedArtworkVersionId`/`approvedAt`. `"approved"` is
 * only ever reached after `isReadyForFinalApproval` passes (see
 * `artwork-preparation-capability.ts`'s two approval paths), so this
 * predicate alone already guarantees no consequential separation decision
 * is left unresolved on the artwork being continued — there is deliberately
 * no separate "is separation fully resolved" re-check here.
 *
 * IDEMPOTENCY — WHY A SCAN, NOT A UNIQUE CONSTRAINT, AND WHY THAT IS AN
 * HONEST V1 TRADE-OFF RATHER THAN A "FRAGILE CLIENT-ONLY GUARD"
 *
 * Every other idempotent creation in this codebase (`createFinalDirectionApproval`,
 * `createFinalArtworkJob`, free-concept consumption) is enforced by a real
 * database UNIQUE constraint, and `ARCHITECTURE.md` is explicit that
 * "call at-most-once needs a real UNIQUE constraint, so it needs a
 * migration." That remains true here in principle. This phase does not add
 * that migration, for a concrete, current reason: this environment's
 * `.env.local` carries a Supabase URL and a service-role API key but no
 * database connection string and no linked Supabase CLI project, so there
 * is no channel available right now to actually apply new DDL to the real
 * database this dev server is pointed at — creating the migration file
 * without a way to run it would leave the real acceptance test unable to
 * prove anything.
 *
 * `findExistingContinuation` below is the honest substitute: a real,
 * SERVER-SIDE read against durable state (every project's current
 * preparation and prepared asset) performed BEFORE creating anything — not
 * a client-side disabled button, not a request header the caller supplies,
 * not anything a retried request could route around. It is not atomic under
 * true concurrent double-submission (two requests within the same
 * read-check-write window could both pass the check), which is why this is
 * documented as a V1 trade-off rather than presented as equivalent to a
 * unique constraint: this feature is operated by one person (Eric, as
 * internal staff) clicking one button at human speed, not a high-throughput
 * customer path, so the exposure this leaves open is a duplicate row on a
 * true double-click within the same instant — recoverable by deleting the
 * extra internal project — never a security or entitlement defect. A real
 * `internal_artwork_continuations` table with a
 * `unique (source_project_id, source_prepared_artwork_version_id)`
 * constraint is the recommended upgrade once this feature sees enough use
 * for that race to matter.
 */

import type { AssetCapability } from "@/capabilities/assets/asset-capability";
import type { AcquisitionCapability } from "@/capabilities/acquisition/acquisition-capability";
import type { ProjectRepository } from "@/lib/db/repository";
import type { AssetRecord } from "@/lib/domain/types";

export interface ContinueAsInternalJobDeps {
  repo: ProjectRepository;
  assets: AssetCapability;
  acquisition: AcquisitionCapability;
}

export interface ContinueAsInternalJobInput {
  sourceProjectId: string;
  /**
   * The ACTING session — i.e. the caller's own already-verified internal
   * session id. This function does not itself check `entitlement ===
   * "internal"`; the route calling it is responsible for that (mirroring
   * how `isAuthorizedForArtworkCorrection` callers are responsible for
   * their own project-existence check). Binding the new project to this
   * exact session id is what makes the new project internal.
   */
  actingSessionId: string;
}

export type ContinueAsInternalJobResult =
  | { outcome: "created"; newProjectId: string }
  | { outcome: "already_continued"; newProjectId: string }
  | { outcome: "not_found" }
  | { outcome: "ineligible"; reason: string };

const INTERNAL_CONTINUATION_KIND = "artwork_continuation" as const;

interface InternalContinuationMarker {
  kind: typeof INTERNAL_CONTINUATION_KIND;
  sourceProjectId: string;
  sourcePreparedArtworkVersionId: string;
  sourcePreparedAssetId: string;
  sourceOriginalAssetId: string;
  sourceApprovedAt: string;
  sourceCorrectionLineage: unknown;
  continuedAt: string;
  continuedByAcquisitionSessionId: string;
}

function readContinuationMarker(asset: AssetRecord | null): InternalContinuationMarker | null {
  if (!asset) return null;
  const metadata = asset.metadata as Record<string, unknown> | undefined;
  const marker = metadata?.internalContinuation as InternalContinuationMarker | undefined;
  if (!marker || marker.kind !== INTERNAL_CONTINUATION_KIND) return null;
  return marker;
}

/**
 * See the module doc comment's "IDEMPOTENCY" section. Scans every project's
 * CURRENT preparation for one whose prepared asset already carries a
 * continuation marker matching this exact `(sourceProjectId,
 * sourcePreparedArtworkVersionId)` pair. Matching on the ARTWORK VERSION,
 * not merely the project, is deliberate: if the source project's artwork is
 * later corrected again and re-approved as a new version, that is a
 * genuinely new accepted result and a fresh continuation is not a
 * duplicate.
 */
async function findExistingContinuation(
  repo: ProjectRepository,
  sourceProjectId: string,
  sourcePreparedArtworkVersionId: string,
): Promise<string | null> {
  const projects = await repo.listProjects();
  for (const project of projects) {
    if (project.id === sourceProjectId) continue;
    const preparation = await repo.getArtworkPreparation(project.id);
    if (!preparation?.preparedAssetId) continue;
    const asset = await repo.getAssetById(preparation.preparedAssetId);
    const marker = readContinuationMarker(asset);
    if (
      marker &&
      marker.sourceProjectId === sourceProjectId &&
      marker.sourcePreparedArtworkVersionId === sourcePreparedArtworkVersionId
    ) {
      return project.id;
    }
  }
  return null;
}

/**
 * The read side of eligibility — shared by the mutating
 * `continueAsInternalJob` below and by the operator page's server-rendered
 * preview (`describeContinuationEligibility`), so the two can never
 * disagree about what counts as eligible. Never creates anything.
 */
export type ContinuationEligibility =
  | { status: "not_found" }
  | { status: "ineligible"; reason: string }
  | { status: "already_continued"; newProjectId: string }
  | { status: "eligible" };

async function resolveEligibility(
  repo: ProjectRepository,
  sourceProjectId: string,
): Promise<ContinuationEligibility> {
  const sourceSnapshot = await repo.getProject(sourceProjectId);
  if (!sourceSnapshot) return { status: "not_found" };

  const preparation = await repo.getArtworkPreparation(sourceProjectId);
  if (!preparation) {
    return {
      status: "ineligible",
      reason: "This project has no uploaded artwork to continue.",
    };
  }
  if (
    preparation.status !== "approved" ||
    !preparation.preparedAssetId ||
    !preparation.preparedArtworkVersionId ||
    !preparation.approvedAt
  ) {
    return {
      status: "ineligible",
      reason:
        "This artwork hasn't been approved yet. Resolve any outstanding review or correction in the original project first.",
    };
  }

  const existing = await findExistingContinuation(
    repo,
    sourceProjectId,
    preparation.preparedArtworkVersionId,
  );
  if (existing) {
    return { status: "already_continued", newProjectId: existing };
  }

  return { status: "eligible" };
}

/** Read-only. Never mutates. Safe to call from a Server Component render. */
export async function describeContinuationEligibility(
  repo: ProjectRepository,
  sourceProjectId: string,
): Promise<ContinuationEligibility> {
  return resolveEligibility(repo, sourceProjectId);
}

export async function continueAsInternalJob(
  deps: ContinueAsInternalJobDeps,
  input: ContinueAsInternalJobInput,
): Promise<ContinueAsInternalJobResult> {
  const { repo, assets } = deps;
  const { sourceProjectId, actingSessionId } = input;

  const eligibility = await resolveEligibility(repo, sourceProjectId);
  if (eligibility.status === "not_found") return { outcome: "not_found" };
  if (eligibility.status === "ineligible") {
    return { outcome: "ineligible", reason: eligibility.reason };
  }
  if (eligibility.status === "already_continued") {
    return { outcome: "already_continued", newProjectId: eligibility.newProjectId };
  }

  // Re-fetched rather than threaded through `eligibility`: `"eligible"`
  // deliberately carries no payload, keeping `resolveEligibility` a pure
  // yes/no/why-not answer that can never drift from what this function
  // actually acts on a moment later.
  const preparation = await repo.getArtworkPreparation(sourceProjectId);
  if (
    !preparation ||
    preparation.status !== "approved" ||
    !preparation.preparedAssetId ||
    !preparation.preparedArtworkVersionId ||
    !preparation.approvedAt
  ) {
    // Re-checked rather than assumed: eligibility could theoretically
    // change between the two reads above under real concurrency (the same
    // honest limitation `findExistingContinuation` already documents).
    return {
      outcome: "ineligible",
      reason: "This artwork's approved state changed while this request was in flight. Please try again.",
    };
  }

  // Defense in depth: the preparation record already scopes these ids to
  // `sourceProjectId` by construction, but confirm the asset rows actually
  // belong to the project we think they do before trusting their bytes.
  const [preparedAsset, originalAsset] = await Promise.all([
    repo.getAssetById(preparation.preparedAssetId),
    repo.getAssetById(preparation.originalAssetId),
  ]);
  if (!preparedAsset || preparedAsset.projectId !== sourceProjectId) {
    return { outcome: "ineligible", reason: "The approved prepared artwork could not be located." };
  }
  if (!originalAsset || originalAsset.projectId !== sourceProjectId) {
    return { outcome: "ineligible", reason: "The original uploaded artwork could not be located." };
  }

  const [preparedBytes, originalBytes] = await Promise.all([
    assets.downloadAssetBytes(preparation.preparedAssetId),
    assets.downloadAssetBytes(preparation.originalAssetId),
  ]);
  if (!preparedBytes || !originalBytes) {
    return { outcome: "ineligible", reason: "The approved artwork's stored bytes could not be read." };
  }

  const continuedAt = new Date().toISOString();
  const sourceCorrectionLineage =
    (preparedAsset.metadata as Record<string, unknown> | undefined)?.correctionLineage ?? null;

  const buildMarker = (): InternalContinuationMarker => ({
    kind: INTERNAL_CONTINUATION_KIND,
    sourceProjectId,
    sourcePreparedArtworkVersionId: preparation.preparedArtworkVersionId!,
    sourcePreparedAssetId: preparation.preparedAssetId!,
    sourceOriginalAssetId: preparation.originalAssetId,
    sourceApprovedAt: preparation.approvedAt!,
    sourceCorrectionLineage,
    continuedAt,
    continuedByAcquisitionSessionId: actingSessionId,
  });

  // The new project — bound to the ACTING internal session, exactly as
  // `POST /api/projects` binds any brand-new project to whichever session
  // the request carries. This is the entire reason the new project is
  // genuinely internal: nothing here flips a flag, it is the same
  // construction every other internal project already relies on.
  const newSnapshot = await repo.createProject(actingSessionId);
  const newProjectId = newSnapshot.project.id;

  const newOriginal = await assets.uploadCustomerArtwork(newProjectId, {
    conceptId: newProjectId,
    bytes: originalBytes.bytes,
    contentType: originalBytes.contentType,
    widthPx: originalAsset.widthPx,
    heightPx: originalAsset.heightPx,
    hasTransparency: originalAsset.hasTransparency,
    kind: "customer_upload",
    metadata: {
      internalContinuation: buildMarker(),
    },
  });

  const newPreparation = await repo.createArtworkPreparation(newProjectId, {
    originalAssetId: newOriginal.id,
    originalFilename: preparation.originalFilename,
    analysis: preparation.analysis,
  });

  const newPrepared = await assets.uploadCustomerArtwork(newProjectId, {
    conceptId: newProjectId,
    bytes: preparedBytes.bytes,
    contentType: preparedBytes.contentType,
    widthPx: preparedAsset.widthPx,
    heightPx: preparedAsset.heightPx,
    hasTransparency: preparedAsset.hasTransparency,
    kind: "png",
    metadata: {
      // Mirrors `finalizeCorrection`'s own metadata shape: "which asset,
      // within THIS project, this was derived from" stays honest and
      // project-local, exactly like every other prepared asset's metadata.
      derivedFromAssetId: newOriginal.id,
      artworkPreparationId: newPreparation.id,
      // Carried forward verbatim — this project's manual-correction
      // history really did happen, on the source project's pixels, and
      // erasing it here would misrepresent this as freshly-corrected work.
      ...(sourceCorrectionLineage ? { correctionLineage: sourceCorrectionLineage } : {}),
      internalContinuation: buildMarker(),
    },
  });

  const [artworkVersion] = await repo.addArtworkVersions(newProjectId, [
    {
      versionNumber: 1,
      kind: "prepared_upload",
      title: "Artwork continued from an approved source project",
      summary:
        "Authoritative artwork inherited from an approved, already-corrected source project — continued as a new internal production job, not re-corrected here.",
      placeholderLabel: "Continued artwork",
      accentColor: "#173F35",
      designBriefVersionId: null,
      generationJobId: null,
      providerKey: null,
      primaryAssetId: newPrepared.id,
      thumbnailAssetId: null,
      // The source of this lineage is an ASSET (via `metadata.internalContinuation`),
      // not an artwork version in this project's own history — same reasoning
      // `approveSeparationMaster`/`finalizeCorrection` already document for
      // why this stays null.
      sourceArtworkVersionId: null,
      conceptDirectionKey: null,
    },
  ]);

  await repo.updateArtworkPreparation(newPreparation.id, {
    status: "approved",
    preparedAssetId: newPrepared.id,
    preparedArtworkVersionId: artworkVersion!.id,
    // Reflects when THIS preparation record became approved (by
    // inheritance, right now) — not the original approval time, which
    // remains available at `metadata.internalContinuation.sourceApprovedAt`
    // on the prepared asset for anyone auditing provenance.
    approvedAt: continuedAt,
    // Carried forward verbatim for the same reason `analysis` is: it
    // describes decisions already made about these exact pixels, and
    // re-deciding them here would be dishonest, not merely redundant.
    separation: preparation.separation,
    preparation: preparation.preparation,
  });

  await repo.setProjectStatus(newProjectId, "approved");

  return { outcome: "created", newProjectId };
}
