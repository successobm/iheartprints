/**
 * Sprint 2M Phase 2C: the first real production-artwork execution path.
 *
 * Independent worker for `FinalArtworkJob` — never runs inside a customer
 * API request (mirrors `GenerationWorkerCapability`'s architecture; see
 * ARCHITECTURE.md §14). Claims a job, resolves its exact approved input,
 * performs the chosen honest raster transformation, persists a production
 * `AssetRecord`, runs AUTHORITATIVE `PrintValidationCapability`, and is the
 * only code path that may ever set `PrintProject.status = "print_ready"`.
 *
 * Must never:
 *   - process "whatever concept is currently selected" — only the exact
 *     `ArtworkVersion` the job's `FinalDirectionApproval` names, and only
 *     while that approval is still `"active"` (Goal 3)
 *   - fabricate print-readiness — a transformation that cannot honestly
 *     satisfy production requirements must surface as
 *     `PrintProject.status = "finalization_required"`, never `"print_ready"`
 *   - execute a paid/network provider call (Phase 2C's only provider is a
 *     local, deterministic raster resample — Goal 20)
 *   - duplicate a production asset on retry/recovery (Goal 16)
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkVersion,
  AssetRecord,
  FinalArtworkJob,
} from "@/lib/domain/types";
import type { AssetCapability } from "@/capabilities/assets";
import type { PrintValidationCapability } from "@/capabilities/print-validation";
import {
  assembleAuthoritativeProductionPrintValidationInput,
  createPrintValidationCapability,
  deriveProductionRequirements,
} from "@/capabilities/print-validation";
import type { PrintValidationReport, ResolutionProvenance } from "@/capabilities/print-validation/contracts";
import { getWorkerHeartbeatIntervalMs } from "@/lib/config/worker-config";
import type { FinalArtworkProvider } from "@/capabilities/final-artwork/provider";

/** Mirrors `DEFAULT_STALE_JOB_MS` — a "running" job with no heartbeat for this long is presumed abandoned. */
export const DEFAULT_FINAL_ARTWORK_STALE_JOB_MS = 15 * 60 * 1000;
/** Mirrors `MAX_GENERATION_ATTEMPTS` — caps attempts across customer retries and worker-recovery reclaims combined. */
export const MAX_FINAL_ARTWORK_ATTEMPTS = 3;

export interface FinalArtworkWorkerCapability {
  /**
   * Claims and fully runs the single oldest due job (queued or
   * recoverable), if any exists. Safe to call repeatedly/concurrently —
   * the underlying claim is optimistic, so at most one caller ever
   * actually runs a given job.
   */
  processNextJob(): Promise<{ processedJobId: string | null }>;
  /** Sweeps jobs abandoned by a worker that died mid-attempt back to "recoverable". Cheap — safe on every status poll. */
  recoverAbandonedJobs(
    staleAfterMs?: number,
  ): Promise<{ recoveredCount: number }>;
}

interface ProductionProvenanceMeta {
  resolutionProvenance: ResolutionProvenance;
  nativeWidthPx: number | null;
  nativeHeightPx: number | null;
  preservesApprovedContent: boolean;
}

export function createFinalArtworkWorkerCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  provider: FinalArtworkProvider,
  printValidation: PrintValidationCapability = createPrintValidationCapability(),
): FinalArtworkWorkerCapability {
  async function withPeriodicHeartbeat<T>(
    jobId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const intervalMs = getWorkerHeartbeatIntervalMs();
    const timer = setInterval(() => {
      void repo.touchFinalArtworkJobHeartbeat(jobId).catch(() => {
        /* best-effort — mirrors GenerationWorkerCapability's identical helper */
      });
    }, intervalMs);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  async function failJob(job: FinalArtworkJob, lastError: string): Promise<void> {
    await repo.updateFinalArtworkJob(job.id, {
      status: "failed",
      lastError,
      completedAt: new Date().toISOString(),
    });
    // Deliberately does not touch PrintProject.status — it stays
    // "finalizing", which remains truthful (Goal 15: an infrastructure
    // failure here is retryable). `FinalArtworkCapability.requestFinalArtwork`
    // revives a "failed" job back to "queued" the next time the customer's
    // existing "Prepare Print-Ready Artwork" action runs (Goal 21 — no
    // separate retry endpoint needed).
  }

  /**
   * The job's authorizing approval was superseded (a new concept batch
   * replaced it) before this job ever ran. Not a pipeline failure — an
   * intentional, expected supersession (Goal C/D). Never touches
   * PrintProject.status: a newer approval's own job (if any) owns that.
   */
  async function cancelJob(job: FinalArtworkJob, reason: string): Promise<void> {
    await repo.updateFinalArtworkJob(job.id, {
      status: "cancelled",
      lastError: reason,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * The worker reached a definitive, honest conclusion without ever
   * producing a production asset — an unsupported production method (Goal
   * 17) or a genuinely unknown target physical size (Goal 4). This is a
   * successfully *completed* determination, not a failure: nothing crashed,
   * the truth is simply "this cannot be auto-finalized."
   */
  async function completeWithoutAsset(
    job: FinalArtworkJob,
    reason: string,
  ): Promise<void> {
    await repo.updateFinalArtworkJob(job.id, {
      status: "completed",
      lastError: reason,
      completedAt: new Date().toISOString(),
    });
    await maybeTransitionProjectStatus(job, "finalization_required");
  }

  /**
   * Only ever transitions `PrintProject.status` when this job's approval is
   * still the project's current active one. A stale job recovered long
   * after the customer moved on (revised, regenerated, approved a
   * different direction) must never stomp a newer direction's status with
   * a decision about an artwork that is no longer "the current direction".
   */
  async function maybeTransitionProjectStatus(
    job: FinalArtworkJob,
    status: "print_ready" | "finalization_required",
  ): Promise<void> {
    const activeApproval = await repo.getActiveFinalDirectionApproval(job.projectId);
    if (!activeApproval || activeApproval.id !== job.finalDirectionApprovalId) return;
    await repo.setProjectStatus(job.projectId, status);
  }

  async function resolveExistingProductionAsset(
    job: FinalArtworkJob,
  ): Promise<AssetRecord | null> {
    const existingAssets = await repo.listAssets(job.projectId);
    return (
      existingAssets.find(
        (asset) =>
          asset.finalArtworkJobId === job.id &&
          asset.productionRole === "production_png",
      ) ?? null
    );
  }

  function provenanceFromExistingAsset(asset: AssetRecord): ProductionProvenanceMeta {
    const meta = asset.metadata as Record<string, unknown>;
    const provenance =
      meta.resolutionProvenance === "native" || meta.resolutionProvenance === "interpolated_upscale"
        ? (meta.resolutionProvenance as ResolutionProvenance)
        : "unknown";
    return {
      resolutionProvenance: provenance,
      nativeWidthPx: typeof meta.nativeWidthPx === "number" ? meta.nativeWidthPx : null,
      nativeHeightPx: typeof meta.nativeHeightPx === "number" ? meta.nativeHeightPx : null,
      preservesApprovedContent: meta.preservesApprovedContent === true,
    };
  }

  async function runClaimedJob(job: FinalArtworkJob): Promise<void> {
    const approval = await repo.getFinalDirectionApprovalById(
      job.finalDirectionApprovalId,
    );
    if (!approval) {
      await failJob(job, "Referenced final-direction approval no longer exists.");
      return;
    }
    // Goal C/D: process only the exact active approval; a superseded one
    // (a new concept batch replaced it) is rejected, never processed as if
    // it were still current.
    if (approval.status !== "active") {
      await cancelJob(
        job,
        "The approved direction was superseded before production artwork could be prepared.",
      );
      return;
    }

    const snapshot = await repo.getProject(job.projectId);
    if (!snapshot) {
      await failJob(job, "Project no longer exists.");
      return;
    }

    const artwork: ArtworkVersion | undefined = snapshot.artworkVersions.find(
      (version) => version.id === job.artworkVersionId,
    );
    // Goal F: `snapshot.artworkVersions` is already scoped to this project
    // by the repository — a cross-project id can never appear in it, so
    // this also covers "belongs to another project" as "not found".
    if (!artwork) {
      await failJob(job, "Approved concept no longer exists for this project.");
      return;
    }

    const briefVersion = await repo.getDesignBriefVersionById(
      approval.designBriefVersionId,
    );
    if (!briefVersion) {
      await failJob(job, "Referenced Design Brief version no longer exists.");
      return;
    }

    // Goal E: a source concept asset is required — never fabricate one.
    if (!artwork.primaryAssetId) {
      await failJob(job, "The approved concept has no source image asset to finalize.");
      return;
    }
    const sourceAsset = await repo.getAssetById(artwork.primaryAssetId);
    if (!sourceAsset || sourceAsset.projectId !== job.projectId) {
      await failJob(job, "Source concept asset could not be resolved for this project.");
      return;
    }

    // Goal 4: the bounded apparel-placement policy already established by
    // `shared/print-placement-dimensions.ts` (full_front/full_back,
    // left_chest, sleeve) via `deriveProductionRequirements` — no new
    // universal assumption invented here.
    const requirements = deriveProductionRequirements({
      printPlacement: briefVersion.content.printPlacement,
      productSummary: briefVersion.content.productSummary,
      designDescription: briefVersion.content.designDescription,
    });

    // Goal 17: Phase 2C supports raster apparel production only. An
    // unsupported method must never be silently marked print-ready.
    if (requirements.category !== "apparel_raster") {
      await completeWithoutAsset(
        job,
        `Unsupported production method for automated raster finalization (category: ${requirements.category}); requires human production planning.`,
      );
      return;
    }
    // Goal 4: genuine customer input (print location) is required to
    // determine target dimensions — never guessed.
    if (!requirements.targetDimensions || !requirements.minRasterDimensionsPx) {
      await completeWithoutAsset(
        job,
        "Print location is not yet known; target production dimensions could not be determined.",
      );
      return;
    }

    // --- Goal 16: idempotent retry — reuse an already-created production
    // asset for this exact job rather than transforming/uploading again.
    let productionAsset = await resolveExistingProductionAsset(job);
    let provenance: ProductionProvenanceMeta;

    if (productionAsset) {
      provenance = provenanceFromExistingAsset(productionAsset);
    } else {
      if (job.attempts > MAX_FINAL_ARTWORK_ATTEMPTS) {
        await failJob(
          job,
          `Exceeded maximum finalization attempts (${MAX_FINAL_ARTWORK_ATTEMPTS}) after repeated recovery.`,
        );
        return;
      }

      const source = await assets.downloadAssetBytes(sourceAsset.id);
      if (!source) {
        await failJob(job, "Source concept asset bytes could not be retrieved from storage.");
        return;
      }

      let output;
      try {
        output = await withPeriodicHeartbeat(job.id, () =>
          provider.produce({
            sourceBytes: source.bytes,
            sourceContentType: sourceAsset.contentType ?? source.contentType,
            targetWidthPx: requirements.minRasterDimensionsPx!.widthPx,
            targetHeightPx: requirements.minRasterDimensionsPx!.heightPx,
            marginFraction: requirements.artworkBoundaryMarginPercent / 100,
          }),
        );
      } catch (error) {
        await failJob(job, describeFinalArtworkError(error));
        return;
      }

      try {
        productionAsset = await assets.uploadProductionAsset(job.projectId, {
          // Groups this job's production deliverable(s) under one storage
          // folder — the approval id, stable and unique per job (Goal 8's
          // 1:1 keying), never a filename convention (Goal 10).
          conceptId: job.finalDirectionApprovalId,
          bytes: output.bytes,
          contentType: output.contentType,
          widthPx: output.widthPx,
          heightPx: output.heightPx,
          hasTransparency: output.hasTransparency,
          finalArtworkJobId: job.id,
          productionRole: "production_png",
          metadata: {
            transformationMethod: output.transformationMethod,
            providerKey: provider.providerKey,
            resolutionProvenance: output.resolutionProvenance,
            nativeWidthPx: output.nativeWidthPx,
            nativeHeightPx: output.nativeHeightPx,
            preservesApprovedContent: output.preservesApprovedContent,
            sourceAssetId: sourceAsset.id,
          },
        });
      } catch (error) {
        await failJob(
          job,
          `Production asset could not be persisted: ${describeFinalArtworkError(error)}`,
        );
        return;
      }

      provenance = {
        resolutionProvenance: output.resolutionProvenance,
        nativeWidthPx: output.nativeWidthPx,
        nativeHeightPx: output.nativeHeightPx,
        preservesApprovedContent: output.preservesApprovedContent,
      };
    }

    // --- Goal 11: authoritative Print Validation against the real
    // production asset — the only run that may ever justify "print_ready".
    const currentApproved = await repo.getLatestDesignBriefVersion(job.projectId);
    const validationInput = assembleAuthoritativeProductionPrintValidationInput({
      artworkVersionId: artwork.id,
      designBriefVersionId: briefVersion.id,
      currentApprovedDesignBriefVersionId: currentApproved?.id ?? null,
      brief: briefVersion.content,
      asset: {
        contentType: productionAsset.contentType,
        widthPx: productionAsset.widthPx,
        heightPx: productionAsset.heightPx,
        hasTransparency: productionAsset.hasTransparency,
        resolutionProvenance: provenance.resolutionProvenance,
        nativeWidthPx: provenance.nativeWidthPx,
        nativeHeightPx: provenance.nativeHeightPx,
      },
      // Goal 8: Concept Evaluation's wording verdict transfers only when
      // the provider declared the transformation content-preserving.
      conceptEvaluationStatus: provenance.preservesApprovedContent
        ? artwork.evaluationStatus
        : null,
      conceptEvaluation: provenance.preservesApprovedContent ? artwork.evaluation : null,
    });

    const report = printValidation.validateArtwork(validationInput);

    // Goal 12: append-only — a retried/recovered attempt inserting one more
    // (deterministic, harmless) validation row is acceptable, mirroring how
    // a retried provisional-validation log line is tolerated elsewhere.
    await repo.createProductionAssetValidation(job.projectId, {
      finalArtworkJobId: job.id,
      assetId: productionAsset.id,
      status: report.status,
      report: report as unknown as Record<string, unknown>,
    });

    await repo.updateFinalArtworkJob(job.id, {
      status: "completed",
      lastError: report.status === "ready" ? null : summarizeReportForInternalLog(report),
      completedAt: new Date().toISOString(),
    });

    // Goal 11/Q: only a "ready" authoritative report may ever justify
    // print_ready; anything else stays honestly finalization_required.
    await maybeTransitionProjectStatus(
      job,
      report.status === "ready" ? "print_ready" : "finalization_required",
    );
  }

  return {
    async processNextJob() {
      const job = await repo.claimNextQueuedFinalArtworkJob();
      if (!job) return { processedJobId: null };
      await runClaimedJob(job);
      return { processedJobId: job.id };
    },

    async recoverAbandonedJobs(staleAfterMs = DEFAULT_FINAL_ARTWORK_STALE_JOB_MS) {
      const recovered = await repo.recoverAbandonedFinalArtworkJobs(staleAfterMs);
      return { recoveredCount: recovered.length };
    },
  };
}

/** Sanitized, non-secret description — safe to store as `FinalArtworkJob.lastError` (internal only). */
function describeFinalArtworkError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Final artwork production failed for an unknown reason.";
}

function summarizeReportForInternalLog(report: PrintValidationReport): string {
  return (
    report.blockingIssues.slice(0, 5).join("; ") ||
    "Authoritative validation did not return ready."
  );
}
