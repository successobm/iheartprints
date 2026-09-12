/**
 * Phase R5 (Confirmed-Authority Raster Reconstruction v1): the thin,
 * repository-only capability that owns the `ArtworkReconstructionJob`
 * lifecycle's AUTHORITY boundary — mirrors `ArtworkFidelityCapability`'s
 * own structural role exactly (depends on `ProjectRepository` only, no
 * provider port here; the actual provider call lives in
 * `RasterReconstructionWorkerCapability`, a SEPARATE module, exactly like
 * `FinalArtworkCapability` vs `FinalArtworkWorkerCapability`).
 *
 * This capability — and the reconstruction concept as a whole — must know
 * NOTHING about: DTF, Signs, physical print size, DTF placement, QR
 * composition, bleed, print validation, or Print Ready. It never declares
 * a candidate accepted on its own — see `approveCandidate`'s own doc
 * comment for the full authority this now enforces — never performs final
 * sign sizing or DTF placement, never decides QR integrity, and never
 * silently mutates confirmed fidelity authority.
 *
 * AUTHORITY INVARIANT (Section 8 of the R4B audit, now enforced here):
 *   - only a contract with `status === "confirmed"` may become
 *     reconstruction authority — `proposedFacts` is NEVER read as
 *     authority by this module;
 *   - the CURRENT source sha256 (freshly measured by the caller, never
 *     trusted from a stale request) must match the contract's own
 *     `sourceSha256` before a job may be created;
 *   - `deriveArtworkFidelityContractKey` is recomputed from the loaded
 *     contract's own fields and compared against its stored `contractKey`
 *     — a mismatch means data corruption or an unexpected code path, and
 *     is refused rather than trusted;
 *   - the recomputed key (never a client-supplied one) is what gets frozen
 *     onto the job.
 *
 * Phase R5-R (independent-review repair): the SAME authority discipline
 * that already governed job CREATION is now enforced a SECOND time at
 * APPROVAL — see `approveCandidate`'s own doc comment for the three
 * blockers this closes.
 */

import type { ProjectRepository } from "@/lib/db/repository";
import {
  ArtworkReconstructionJobConflictError,
  UniqueConstraintViolationError,
} from "@/lib/db/repository";
import type { ArtworkReconstructionJob, SignPlanAuthorizationActor } from "@/lib/domain/types";
import {
  deriveArtworkFidelityContractKey,
  type ArtworkFidelityContractIdentityInput,
} from "@/capabilities/artwork-fidelity";

export class ArtworkReconstructionAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkReconstructionAuthorityError";
  }
}

export class ArtworkReconstructionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkReconstructionStateError";
  }
}

export interface RequestArtworkReconstructionInput {
  sourceAssetId: string;
  /** The CURRENT source sha256, freshly measured by the caller — never trusted from a stale request body. */
  currentSourceSha256: string;
  /** The confirmed contract this reconstruction binds to — resolved by the caller as "the current confirmed contract for this project," never trusted blind: this capability independently re-verifies it below. */
  fidelityContractId: string;
}

/**
 * Phase R5-R (independent-review repair, Blocker 1): the customer's
 * explicit attestation that they reviewed a confirmed protected mark on
 * the candidate — never a machine verdict. `confirmedBy` mirrors
 * `ArtworkFidelityContract.confirmedBy`'s own narrow customer/operator
 * actor type.
 */
export interface ApproveArtworkReconstructionCandidateInput {
  /**
   * Required (and must be strictly `true`) whenever the CURRENT confirmed
   * fidelity contract lists one or more protected marks; ignored when it
   * explicitly confirms none. Missing, `false`, or any other falsy value
   * REFUSES approval outright — see `approveCandidate`'s own doc comment.
   */
  protectedMarksConfirmed?: boolean;
  confirmedBy: SignPlanAuthorizationActor;
}

export interface RasterReconstructionCapability {
  /**
   * Verifies confirmed authority, then creates (or idempotently reuses) a
   * reconstruction job for this exact source + contract binding. Refuses
   * (fails closed, NO job created, NO provider ever consulted) if the
   * contract is not confirmed, if the source has changed underneath it, or
   * if the contract's own stored `contractKey` does not match what
   * recomputing it from the contract's current fields produces.
   *
   * Idempotent against an already-in-flight or already-completed job for
   * the identical (source, contractKey) binding — a repeat call (e.g. a
   * page refresh) never creates a second paid job. Phase R5-R: this is now
   * also enforced at the storage boundary (a partial unique index), not
   * only by this check-then-act read — two genuinely concurrent requests
   * resolve to exactly one created job, the loser transparently reusing
   * the winner's row rather than erroring.
   */
  requestReconstruction(
    projectId: string,
    input: RequestArtworkReconstructionInput,
  ): Promise<ArtworkReconstructionJob>;
  getJob(id: string): Promise<ArtworkReconstructionJob | null>;
  getLatestJobForSource(
    projectId: string,
    sourceAssetId: string,
  ): Promise<ArtworkReconstructionJob | null>;
  /**
   * Phase R5-R (independent-review repair): "the latest job" and "the
   * current accepted clean master" are NOT the same question — a newer
   * rejected/pending job must never hide an earlier still-valid approved
   * one, and an approved job whose contract has since been superseded must
   * never be returned as current. Requires: `reviewStatus === "approved"`,
   * a candidate asset present, the fidelity contract still `"confirmed"`
   * and still the project's CURRENT contract, and the job's own frozen
   * `contractKey` matching that current contract's recomputed key. `null`
   * when no job satisfies all of these.
   */
  getCurrentAcceptedMaster(
    projectId: string,
    sourceAssetId: string,
  ): Promise<ArtworkReconstructionJob | null>;
  /**
   * The CUSTOMER'S explicit post-reconstruction approval — genuinely
   * separate from whether the provider call succeeded (Section 17 of the
   * R5 task).
   *
   * Phase R5-R (independent-review repair, closing three proven
   * BLOCKERS):
   *   1. Protected-mark confirmation is now a REQUIRED, SERVER-SIDE input
   *      whenever the bound contract confirmed one or more marks — a
   *      missing/false attestation is refused before any write, and a
   *      successful review is durably recorded
   *      (`protectedMarksReviewed`/`At`/`By`), never merely passed through
   *      memory.
   *   2. Authority is REVALIDATED here, not only at request/execution
   *      time: the bound contract must still be `"confirmed"` AND still
   *      be the project's CURRENT contract (a confirmed contract is
   *      immutable, so recomputing ITS OWN key can never detect it was
   *      superseded — only comparing against `getArtworkFidelityContract`'s
   *      "current" pointer does, the exact same two-check reasoning
   *      `RasterReconstructionWorkerCapability` already uses before
   *      spending). A candidate whose contract was corrected after
   *      reconstruction can no longer be approved.
   *   3. The `pending_review -> approved` transition is now a
   *      compare-and-swap at the storage boundary — two concurrent
   *      approve/reject calls resolve to exactly one winner.
   *
   * Still never creates a production asset and never grants Print Ready —
   * see this module's own doc comment.
   */
  approveCandidate(
    projectId: string,
    jobId: string,
    input: ApproveArtworkReconstructionCandidateInput,
  ): Promise<ArtworkReconstructionJob>;
  /** The customer's explicit rejection. Does not accept the candidate; does not automatically enqueue a retry (Section "REJECT / RETRY" of the R5 task). Phase R5-R: also CAS-protected against a concurrent approval. */
  rejectCandidate(projectId: string, jobId: string): Promise<ArtworkReconstructionJob>;
}

/** `ArtworkFidelityCapability`'s own identity input shape, loaded via the repository directly — this module depends on `ProjectRepository`, never on an `ArtworkFidelityCapability` instance, mirroring how sibling capabilities read a shared table without depending on each other's capability object. */
async function loadConfirmedContractOrThrow(
  repo: ProjectRepository,
  projectId: string,
  fidelityContractId: string,
  currentSourceSha256: string,
) {
  const contract = await repo.getArtworkFidelityContractById(fidelityContractId);
  if (!contract || contract.projectId !== projectId) {
    throw new ArtworkReconstructionAuthorityError(
      "No fidelity contract exists for this project with that id.",
    );
  }
  if (contract.status !== "confirmed") {
    throw new ArtworkReconstructionAuthorityError(
      "Artwork must be confirmed before it can be reconstructed.",
    );
  }
  if (contract.sourceSha256 !== currentSourceSha256) {
    throw new ArtworkReconstructionAuthorityError(
      "The source artwork has changed since fidelity was confirmed; confirm it again before reconstructing.",
    );
  }
  // A confirmed contract is IMMUTABLE, so its own fields (and therefore a
  // recomputed key over them) can never drift — that alone cannot detect
  // that a NEWER correction has since superseded it (see
  // `RasterReconstructionWorkerCapability`'s own doc comment for the exact
  // same two-check reasoning, applied here BEFORE a job is even created
  // rather than only at execution time).
  const current = await repo.getArtworkFidelityContract(projectId);
  if (!current || current.id !== contract.id) {
    throw new ArtworkReconstructionAuthorityError(
      "This contract has been corrected since it was confirmed; confirm your artwork details again.",
    );
  }
  const identity: ArtworkFidelityContractIdentityInput = {
    sourceAssetId: contract.sourceAssetId,
    sourceSha256: contract.sourceSha256,
    confirmedWording: contract.confirmedWording,
    confirmedMarks: contract.confirmedMarks,
    sourceContentBoundingBoxAspectRatio: contract.sourceContentBoundingBoxAspectRatio,
  };
  const recomputedKey = deriveArtworkFidelityContractKey(identity);
  if (recomputedKey !== contract.contractKey) {
    // Never trust a stored key alone (the contract's own doc comment on
    // `contractKey`) — a mismatch here means the row's own fields disagree
    // with its own recorded key, which should be impossible for an
    // immutable confirmed contract and is refused rather than silently
    // reconciled.
    throw new ArtworkReconstructionAuthorityError(
      "This confirmed contract's authority could not be verified. Please confirm your artwork details again.",
    );
  }
  return { contract, contractKey: recomputedKey };
}

/**
 * Phase R5-R (independent-review repair, Blocker 2): the SAME
 * "is this contract still confirmed AND still the project's CURRENT
 * contract" re-verification `loadConfirmedContractOrThrow` performs at
 * request time — run again here, given only a job (not a fresh client
 * request), for `approveCandidate`/`getCurrentAcceptedMaster` to share.
 * Returns `null` (never throws) when authority is stale — the caller
 * decides how to report that for its own operation.
 */
async function reloadCurrentAuthorityForJob(
  repo: ProjectRepository,
  job: Pick<
    ArtworkReconstructionJob,
    "projectId" | "fidelityContractId" | "sourceAssetId" | "sourceSha256" | "contractKey"
  >,
) {
  const contract = await repo.getArtworkFidelityContractById(job.fidelityContractId);
  if (!contract || contract.status !== "confirmed") return null;
  const current = await repo.getArtworkFidelityContract(job.projectId);
  if (!current || current.id !== contract.id) return null;
  const recomputedKey = deriveArtworkFidelityContractKey({
    sourceAssetId: contract.sourceAssetId,
    sourceSha256: contract.sourceSha256,
    confirmedWording: contract.confirmedWording,
    confirmedMarks: contract.confirmedMarks,
    sourceContentBoundingBoxAspectRatio: contract.sourceContentBoundingBoxAspectRatio,
  });
  if (recomputedKey !== job.contractKey || recomputedKey !== contract.contractKey) return null;
  // Phase R5-R "SOURCE STALENESS AT APPROVAL": assets are append-only —
  // this codebase has no method that updates an already-created asset's
  // bytes or metadata (Constitution §6.11), so a source asset's bytes
  // cannot change after creation. Re-downloading and re-hashing them here
  // would therefore prove nothing a durable comparison against the
  // contract's OWN already-immutable `sourceSha256`/`sourceAssetId`
  // doesn't already prove, at the cost of an unnecessary storage round
  // trip. Comparing the two durable bindings is the strongest correct
  // invariant available without that redundant work.
  if (contract.sourceAssetId !== job.sourceAssetId || contract.sourceSha256 !== job.sourceSha256) {
    return null;
  }
  return { contract, contractKey: recomputedKey };
}

export function createRasterReconstructionCapability(
  repo: ProjectRepository,
): RasterReconstructionCapability {
  return {
    async requestReconstruction(projectId, input) {
      const { contract, contractKey } = await loadConfirmedContractOrThrow(
        repo,
        projectId,
        input.fidelityContractId,
        input.currentSourceSha256,
      );
      if (contract.sourceAssetId !== input.sourceAssetId) {
        throw new ArtworkReconstructionAuthorityError(
          "The confirmed contract is bound to a different source asset.",
        );
      }

      // Idempotent against an already-in-flight/completed/approved job for
      // the IDENTICAL (source, contractKey) binding — never a second paid
      // job on a repeat call/refresh. A job bound to a STALE contractKey
      // (the contract was corrected since), a FAILED/CANCELLED attempt, or
      // a REJECTED candidate is never reused — a fresh job is created
      // instead, mirroring the migration's own
      // `artwork_reconstruction_jobs_active_binding_uidx` partial-index
      // exclusion exactly (Phase R5-R: previously this reuse check did not
      // exclude `"rejected"`, which would have silently resurfaced an
      // already-rejected candidate instead of honoring a later "Try
      // again").
      const existing = await repo.getLatestArtworkReconstructionJobForSource(
        projectId,
        input.sourceAssetId,
      );
      if (
        existing &&
        existing.contractKey === contractKey &&
        existing.status !== "failed" &&
        existing.status !== "cancelled" &&
        existing.reviewStatus !== "rejected"
      ) {
        return existing;
      }

      try {
        return await repo.createArtworkReconstructionJob(projectId, {
          sourceAssetId: input.sourceAssetId,
          sourceSha256: input.currentSourceSha256,
          fidelityContractId: contract.id,
          contractKey,
        });
      } catch (error) {
        // Phase R5-R (closing the paid-duplicate-request race): a
        // concurrent request won the race at the storage boundary (the
        // migration's partial unique index) — this is not a genuine
        // failure, it means another request already created the job this
        // one would have. Resolve to that winner rather than erroring the
        // customer.
        if (error instanceof UniqueConstraintViolationError) {
          const winner = await repo.getLatestArtworkReconstructionJobForSource(
            projectId,
            input.sourceAssetId,
          );
          if (winner && winner.contractKey === contractKey) return winner;
        }
        throw error;
      }
    },

    async getJob(id) {
      return repo.getArtworkReconstructionJob(id);
    },

    async getLatestJobForSource(projectId, sourceAssetId) {
      return repo.getLatestArtworkReconstructionJobForSource(projectId, sourceAssetId);
    },

    async getCurrentAcceptedMaster(projectId, sourceAssetId) {
      const current = await repo.getArtworkFidelityContract(projectId);
      if (!current || current.status !== "confirmed") return null;
      const recomputedCurrentKey = deriveArtworkFidelityContractKey({
        sourceAssetId: current.sourceAssetId,
        sourceSha256: current.sourceSha256,
        confirmedWording: current.confirmedWording,
        confirmedMarks: current.confirmedMarks,
        sourceContentBoundingBoxAspectRatio: current.sourceContentBoundingBoxAspectRatio,
      });
      if (recomputedCurrentKey !== current.contractKey) return null;

      const jobs = await repo.listArtworkReconstructionJobsForSource(projectId, sourceAssetId);
      // Newest-first: if more than one historical job somehow matches (it
      // shouldn't, given the active-binding unique index), the most
      // recently approved one wins rather than an arbitrary one.
      const approved = [...jobs]
        .reverse()
        .find(
          (job) =>
            job.reviewStatus === "approved" &&
            job.candidateAssetId !== null &&
            job.contractKey === recomputedCurrentKey,
        );
      return approved ?? null;
    },

    async approveCandidate(projectId, jobId, input) {
      const job = await repo.getArtworkReconstructionJob(jobId);
      if (!job || job.projectId !== projectId) {
        throw new ArtworkReconstructionStateError(
          "No reconstruction job exists for this project with that id.",
        );
      }
      if (job.status !== "completed" || !job.candidateAssetId || job.reviewStatus !== "pending_review") {
        throw new ArtworkReconstructionStateError(
          "This reconstruction has no pending candidate to approve.",
        );
      }

      // BLOCKER 2 (independent-review repair): authority must still be
      // current RIGHT NOW, not merely at request/execution time.
      const authority = await reloadCurrentAuthorityForJob(repo, job);
      if (!authority) {
        throw new ArtworkReconstructionAuthorityError(
          "The confirmed fidelity contract has changed since this artwork was rebuilt; request reconstruction again before approving.",
        );
      }

      // BLOCKER 1 (independent-review repair): the customer's explicit,
      // server-enforced protected-mark review — never a machine verdict,
      // never satisfied merely because the UI's checkbox was rendered.
      const confirmedMarks = authority.contract.confirmedMarks ?? [];
      const requiresMarkConfirmation = confirmedMarks.length > 0;
      if (requiresMarkConfirmation && input.protectedMarksConfirmed !== true) {
        throw new ArtworkReconstructionStateError(
          "You must confirm the protected mark before approving this artwork.",
        );
      }

      const reviewedAt = new Date().toISOString();
      try {
        return await repo.updateArtworkReconstructionJob(
          jobId,
          {
            reviewStatus: "approved",
            reviewedAt,
            // Durable proof of review — ONLY written when a review was
            // actually required, and only ever `true` (a refused/false
            // attestation never reaches this write at all). Never
            // persisted for a contract that confirmed no marks — there is
            // nothing to attest to.
            ...(requiresMarkConfirmation
              ? {
                  protectedMarksReviewed: true as const,
                  protectedMarksReviewedAt: reviewedAt,
                  protectedMarksReviewedBy: input.confirmedBy,
                }
              : {}),
          },
          "pending_review",
        );
      } catch (error) {
        if (error instanceof ArtworkReconstructionJobConflictError) {
          throw new ArtworkReconstructionStateError(
            "This reconstruction was already reviewed by another request.",
          );
        }
        throw error;
      }
    },

    async rejectCandidate(projectId, jobId) {
      const job = await repo.getArtworkReconstructionJob(jobId);
      if (!job || job.projectId !== projectId) {
        throw new ArtworkReconstructionStateError(
          "No reconstruction job exists for this project with that id.",
        );
      }
      if (job.status !== "completed" || !job.candidateAssetId || job.reviewStatus !== "pending_review") {
        throw new ArtworkReconstructionStateError(
          "This reconstruction has no pending candidate to reject.",
        );
      }
      try {
        return await repo.updateArtworkReconstructionJob(
          jobId,
          {
            reviewStatus: "rejected",
            reviewedAt: new Date().toISOString(),
          },
          "pending_review",
        );
      } catch (error) {
        if (error instanceof ArtworkReconstructionJobConflictError) {
          throw new ArtworkReconstructionStateError(
            "This reconstruction was already reviewed by another request.",
          );
        }
        throw error;
      }
    },
  };
}
