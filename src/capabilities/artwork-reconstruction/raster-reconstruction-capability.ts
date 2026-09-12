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
 * a candidate accepted on its own (that requires the CUSTOMER'S explicit
 * `approveCandidate` call, itself gated on the worker having already
 * produced `wordingVerified`/`geometryStatus` evidence), never performs
 * final sign sizing or DTF placement, never decides QR integrity, and
 * never silently mutates confirmed fidelity authority.
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
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type { ArtworkReconstructionJob } from "@/lib/domain/types";
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
   * page refresh) never creates a second paid job.
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
   * The CUSTOMER'S explicit post-reconstruction approval — genuinely
   * separate from whether the provider call succeeded (Section 17 of the
   * R5 task). Refuses unless a candidate actually exists and is still
   * `"pending_review"`. Approving does NOT create a production asset and
   * does NOT grant Print Ready — see this module's own doc comment.
   */
  approveCandidate(projectId: string, jobId: string): Promise<ArtworkReconstructionJob>;
  /** The customer's explicit rejection. Does not accept the candidate; does not automatically enqueue a retry (Section "REJECT / RETRY" of the R5 task). */
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

      // Idempotent against an already-in-flight/completed job for the
      // IDENTICAL (source, contractKey) binding — never a second paid job
      // on a repeat call/refresh. A job bound to a STALE contractKey (the
      // contract was corrected since) is never reused — a fresh job is
      // created against the current authority instead.
      const existing = await repo.getLatestArtworkReconstructionJobForSource(
        projectId,
        input.sourceAssetId,
      );
      if (
        existing &&
        existing.contractKey === contractKey &&
        existing.status !== "failed" &&
        existing.status !== "cancelled"
      ) {
        return existing;
      }

      return repo.createArtworkReconstructionJob(projectId, {
        sourceAssetId: input.sourceAssetId,
        sourceSha256: input.currentSourceSha256,
        fidelityContractId: contract.id,
        contractKey,
      });
    },

    async getJob(id) {
      return repo.getArtworkReconstructionJob(id);
    },

    async getLatestJobForSource(projectId, sourceAssetId) {
      return repo.getLatestArtworkReconstructionJobForSource(projectId, sourceAssetId);
    },

    async approveCandidate(projectId, jobId) {
      const job = await repo.getArtworkReconstructionJob(jobId);
      if (!job || job.projectId !== projectId) {
        throw new ArtworkReconstructionStateError(
          "No reconstruction job exists for this project with that id.",
        );
      }
      if (job.status !== "completed" || job.reviewStatus !== "pending_review") {
        throw new ArtworkReconstructionStateError(
          "This reconstruction has no pending candidate to approve.",
        );
      }
      return repo.updateArtworkReconstructionJob(jobId, {
        reviewStatus: "approved",
        reviewedAt: new Date().toISOString(),
      });
    },

    async rejectCandidate(projectId, jobId) {
      const job = await repo.getArtworkReconstructionJob(jobId);
      if (!job || job.projectId !== projectId) {
        throw new ArtworkReconstructionStateError(
          "No reconstruction job exists for this project with that id.",
        );
      }
      if (job.status !== "completed" || job.reviewStatus !== "pending_review") {
        throw new ArtworkReconstructionStateError(
          "This reconstruction has no pending candidate to reject.",
        );
      }
      return repo.updateArtworkReconstructionJob(jobId, {
        reviewStatus: "rejected",
        reviewedAt: new Date().toISOString(),
      });
    },
  };
}
