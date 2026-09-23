/**
 * Phase R6A (Geometry-Qualified Clean Master v1): the durable orchestration
 * layer around the pure `qualifyReconstructionGeometry` engine
 * (`geometry-qualification.ts`) — mirrors `RasterReconstructionCapability`'s
 * own structural role (repository + assets, no direct provider port; there
 * is no provider anywhere in this module).
 *
 * AUTHORITY INVARIANT (mirrors `RasterReconstructionWorkerCapability`'s own
 * two-check reasoning exactly): before ever qualifying a candidate, this
 * capability re-verifies the bound fidelity contract is still `"confirmed"`
 * AND is still the project's CURRENT contract, and recomputes
 * `deriveArtworkFidelityContractKey` from the loaded contract's own fields
 * rather than trusting the job's stored `contractKey`. Never qualifies a
 * job whose `reviewStatus` is not `"approved"`.
 *
 * CUSTOMER CONFIRMATION AUTHORITY: `confirmQualification`/
 * `rejectQualification` never accept a client-supplied qualification or
 * asset id — both resolve the CURRENT qualification server-side from
 * project -> current confirmed fidelity contract -> current accepted
 * reconstruction (`RasterReconstructionCapability.getCurrentAcceptedMaster`)
 * -> that job's own qualification row (R6A implementation task, Section
 * 13). A stale/superseded chain resolves to "nothing to confirm," never a
 * stale row.
 *
 * IDEMPOTENCY: `ensureQualification` checks for an existing row before
 * doing any work; on a genuine creation race it catches
 * `UniqueConstraintViolationError` and returns the winner's row (mirrors
 * `RasterReconstructionCapability.requestReconstruction`'s own established
 * pattern). Uploading the derivative asset before the row insert leaves a
 * narrow window where a losing concurrent request's derivative upload
 * becomes an orphaned (never-referenced) asset — never a paid-spend
 * concern (no provider is called here), and the same class of
 * accepted residual risk `requestReconstruction`'s own doc comment already
 * names for its own narrow window.
 */

import { randomUUID } from "node:crypto";

import { PNG } from "pngjs";

import type { AssetCapability } from "@/capabilities/assets";
import { deriveArtworkFidelityContractKey } from "@/capabilities/artwork-fidelity";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  ArtworkGeometryQualificationConflictError,
  UniqueConstraintViolationError,
  type CreateArtworkGeometryQualificationInput,
  type ProjectRepository,
} from "@/lib/db/repository";
import type {
  ArtworkGeometryQualification,
  SignPlanAuthorizationActor,
} from "@/lib/domain/types";

import {
  GEOMETRY_QUALIFICATION_VERSION,
  qualifyReconstructionGeometry,
} from "./geometry-qualification";
import type { RasterReconstructionCapability } from "./raster-reconstruction-capability";

export class ArtworkGeometryQualificationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkGeometryQualificationAuthorityError";
  }
}

export class ArtworkGeometryQualificationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkGeometryQualificationStateError";
  }
}

export interface ArtworkGeometryQualificationCapability {
  /**
   * Idempotent: returns the existing qualification row for this
   * reconstruction job if one already exists (never re-computes, never
   * re-uploads), or attempts deterministic geometry qualification against
   * the job's approved candidate and persists exactly one row — either
   * `"normalized_pending_confirmation"` (with a new derivative asset) or
   * `"unusable"` (no derivative, deterministic qualification abstained).
   * Refuses if the job is not this project's, or is not
   * `reviewStatus: "approved"`, or its bound fidelity authority is no
   * longer current.
   */
  ensureQualification(
    projectId: string,
    reconstructionJobId: string,
  ): Promise<ArtworkGeometryQualification>;
  getQualificationByJob(
    reconstructionJobId: string,
  ): Promise<ArtworkGeometryQualification | null>;
  /**
   * The qualification (in ANY status) belonging to the project's CURRENT
   * accepted reconstruction, or `null` if none exists yet / the chain is
   * stale. This is what a customer-facing review surface reads — `null`
   * and `"unusable"`/`"rejected"` are all legitimate, distinct answers a
   * caller must render differently, never collapsed into one.
   */
  getCurrentQualification(projectId: string): Promise<ArtworkGeometryQualification | null>;
  /** The customer's explicit "Looks good — continue." Server-authoritative — see this module's own doc comment. */
  confirmQualification(
    projectId: string,
    confirmedBy: SignPlanAuthorizationActor,
  ): Promise<ArtworkGeometryQualification>;
  /** The customer's explicit "Something is missing." Never mutates the derivative/candidate; never retries automatically. */
  rejectQualification(projectId: string): Promise<ArtworkGeometryQualification>;
  /**
   * Production input authority — see this module's own doc comment.
   * Returns the geometry-normalized derivative ONLY when the full chain
   * (current contract -> current accepted reconstruction -> its
   * qualification -> `"confirmed"` -> a derivative asset) holds. Never
   * sets Print Ready, never authorizes Signs/DTF production — see R6A's
   * own "PRINT READY BOUNDARY."
   */
  getCurrentProductionQualifiedMaster(
    projectId: string,
  ): Promise<ArtworkGeometryQualification | null>;
}

export function createArtworkGeometryQualificationCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  reconstruction: RasterReconstructionCapability,
): ArtworkGeometryQualificationCapability {
  async function createRowWithRaceHandling(
    projectId: string,
    input: CreateArtworkGeometryQualificationInput,
  ): Promise<ArtworkGeometryQualification> {
    try {
      return await repo.createArtworkGeometryQualification(projectId, input);
    } catch (error) {
      // The migration's own `artwork_geometry_qualifications_job_uidx` —
      // a concurrent request already created the row this one would have.
      // Resolve to that winner rather than erroring the customer (see this
      // module's own doc comment on the resulting orphan-asset tradeoff).
      if (error instanceof UniqueConstraintViolationError) {
        const winner = await repo.getArtworkGeometryQualificationByJob(
          input.reconstructionJobId,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }

  /**
   * project -> current confirmed fidelity contract -> current accepted
   * reconstruction -> that job's own qualification row. `null` at any
   * broken link — never partial/best-effort authority.
   */
  async function resolveCurrentQualification(
    projectId: string,
  ): Promise<ArtworkGeometryQualification | null> {
    const contract = await repo.getArtworkFidelityContract(projectId);
    if (!contract || contract.status !== "confirmed") return null;
    const job = await reconstruction.getCurrentAcceptedMaster(projectId, contract.sourceAssetId);
    if (!job) return null;
    const qualification = await repo.getArtworkGeometryQualificationByJob(job.id);
    if (!qualification) return null;
    // Never trust a stored key alone: the job returned by
    // `getCurrentAcceptedMaster` has already been proven current, so its
    // own `contractKey` is authoritative — a qualification whose frozen
    // key disagrees with it is stale by construction and refused.
    if (qualification.contractKey !== job.contractKey) return null;
    return qualification;
  }

  return {
    async ensureQualification(projectId, reconstructionJobId) {
      const existing = await repo.getArtworkGeometryQualificationByJob(reconstructionJobId);
      if (existing) return existing;

      const job = await repo.getArtworkReconstructionJob(reconstructionJobId);
      if (!job || job.projectId !== projectId) {
        throw new ArtworkGeometryQualificationStateError(
          "No reconstruction job exists for this project with that id.",
        );
      }
      if (job.reviewStatus !== "approved" || !job.candidateAssetId) {
        throw new ArtworkGeometryQualificationStateError(
          "This reconstruction has not been approved yet.",
        );
      }

      // Re-verify fidelity authority is still current — never trust the
      // job's own frozen `contractKey` alone (see this module's own doc
      // comment).
      const contract = await repo.getArtworkFidelityContractById(job.fidelityContractId);
      if (!contract || contract.status !== "confirmed") {
        throw new ArtworkGeometryQualificationAuthorityError(
          "The bound fidelity contract is no longer confirmed authority.",
        );
      }
      const currentContract = await repo.getArtworkFidelityContract(projectId);
      if (!currentContract || currentContract.id !== contract.id) {
        throw new ArtworkGeometryQualificationAuthorityError(
          "The confirmed fidelity contract has been corrected since this reconstruction was approved.",
        );
      }
      const recomputedKey = deriveArtworkFidelityContractKey({
        sourceAssetId: contract.sourceAssetId,
        sourceSha256: contract.sourceSha256,
        confirmedWording: contract.confirmedWording,
        confirmedMarks: contract.confirmedMarks,
        sourceContentBoundingBoxAspectRatio: contract.sourceContentBoundingBoxAspectRatio,
      });
      if (recomputedKey !== job.contractKey) {
        throw new ArtworkGeometryQualificationAuthorityError(
          "This confirmed contract's authority could not be verified.",
        );
      }

      const candidate = await assets.downloadAssetBytes(job.candidateAssetId);
      if (!candidate) {
        throw new ArtworkGeometryQualificationStateError(
          "The reconstruction candidate could not be read.",
        );
      }
      const decoded = PNG.sync.read(candidate.bytes);
      const image: RgbaImage = { width: decoded.width, height: decoded.height, data: decoded.data };

      const outcome = qualifyReconstructionGeometry(
        image,
        contract.sourceContentBoundingBoxAspectRatio,
      );

      if (outcome.status === "abstained") {
        return createRowWithRaceHandling(projectId, {
          reconstructionJobId: job.id,
          candidateAssetId: job.candidateAssetId,
          fidelityContractId: contract.id,
          contractKey: recomputedKey,
          classifierVerdict: outcome.classification,
          qualificationStatus: "unusable",
          derivedAssetId: null,
          originalCanvasWidthPx: image.width,
          originalCanvasHeightPx: image.height,
          contentBounds: null,
          normalizedWidthPx: null,
          normalizedHeightPx: null,
          contentAspectRatio: null,
          detectedBackgroundColor: null,
          normalizationMethod: GEOMETRY_QUALIFICATION_VERSION,
        });
      }

      const png = new PNG({ width: outcome.normalizedWidthPx, height: outcome.normalizedHeightPx });
      outcome.image.data.copy(png.data);
      const encoded = PNG.sync.write(png);

      // A fresh, internal-only storage-grouping id — deliberately NOT
      // `job.id` (already used by the candidate's own upload) and never a
      // database row id (`UploadConceptAssetInput.conceptId`'s own doc).
      const uploaded = await assets.uploadConceptImage(projectId, {
        conceptId: randomUUID(),
        bytes: encoded,
        contentType: "image/png",
        widthPx: outcome.normalizedWidthPx,
        heightPx: outcome.normalizedHeightPx,
        hasTransparency: true,
        providerKey: null,
        generationJobId: null,
        metadata: {
          geometryNormalizedDerivative: true,
          reconstructionJobId: job.id,
          sourceCandidateAssetId: job.candidateAssetId,
          fidelityContractId: contract.id,
          contractKey: recomputedKey,
          normalizationMethod: GEOMETRY_QUALIFICATION_VERSION,
          classifierVerdict: outcome.classification,
        },
      });

      return createRowWithRaceHandling(projectId, {
        reconstructionJobId: job.id,
        candidateAssetId: job.candidateAssetId,
        fidelityContractId: contract.id,
        contractKey: recomputedKey,
        classifierVerdict: outcome.classification,
        qualificationStatus: "normalized_pending_confirmation",
        derivedAssetId: uploaded.primary.id,
        originalCanvasWidthPx: outcome.originalCanvasWidthPx,
        originalCanvasHeightPx: outcome.originalCanvasHeightPx,
        contentBounds: outcome.contentBounds,
        normalizedWidthPx: outcome.normalizedWidthPx,
        normalizedHeightPx: outcome.normalizedHeightPx,
        contentAspectRatio: outcome.contentAspectRatio,
        detectedBackgroundColor: outcome.detectedBackgroundColor,
        normalizationMethod: GEOMETRY_QUALIFICATION_VERSION,
      });
    },

    async getQualificationByJob(reconstructionJobId) {
      return repo.getArtworkGeometryQualificationByJob(reconstructionJobId);
    },

    async getCurrentQualification(projectId) {
      return resolveCurrentQualification(projectId);
    },

    async confirmQualification(projectId, confirmedBy) {
      const qualification = await resolveCurrentQualification(projectId);
      if (!qualification) {
        throw new ArtworkGeometryQualificationStateError(
          "There is no artwork awaiting geometry confirmation for this project.",
        );
      }
      if (qualification.qualificationStatus !== "normalized_pending_confirmation") {
        throw new ArtworkGeometryQualificationStateError(
          "This artwork has already been reviewed.",
        );
      }
      const confirmedAt = new Date().toISOString();
      try {
        return await repo.updateArtworkGeometryQualification(
          qualification.id,
          { qualificationStatus: "confirmed", confirmedAt, confirmedBy },
          "normalized_pending_confirmation",
        );
      } catch (error) {
        if (error instanceof ArtworkGeometryQualificationConflictError) {
          throw new ArtworkGeometryQualificationStateError(
            "This artwork was already reviewed by another request.",
          );
        }
        throw error;
      }
    },

    async rejectQualification(projectId) {
      const qualification = await resolveCurrentQualification(projectId);
      if (!qualification) {
        throw new ArtworkGeometryQualificationStateError(
          "There is no artwork awaiting geometry confirmation for this project.",
        );
      }
      if (qualification.qualificationStatus !== "normalized_pending_confirmation") {
        throw new ArtworkGeometryQualificationStateError(
          "This artwork has already been reviewed.",
        );
      }
      try {
        return await repo.updateArtworkGeometryQualification(
          qualification.id,
          { qualificationStatus: "rejected" },
          "normalized_pending_confirmation",
        );
      } catch (error) {
        if (error instanceof ArtworkGeometryQualificationConflictError) {
          throw new ArtworkGeometryQualificationStateError(
            "This artwork was already reviewed by another request.",
          );
        }
        throw error;
      }
    },

    async getCurrentProductionQualifiedMaster(projectId) {
      const qualification = await resolveCurrentQualification(projectId);
      if (!qualification) return null;
      if (qualification.qualificationStatus !== "confirmed" || !qualification.derivedAssetId) {
        return null;
      }
      return qualification;
    },
  };
}
