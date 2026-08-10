/**
 * Sprint 2M Phase 2C: the first real production-artwork execution path.
 * Sprint 2M Phase 2E: integrates Topaz Transparency Upscale as the first
 * real production reconstruction provider behind `FinalArtworkProvider`,
 * plus the honesty/verification machinery a genuine reconstruction provider
 * requires that a pure local resample never did — source eligibility,
 * independent production verification, paid-call idempotency, and
 * reconstruction-lifecycle observability.
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
 *   - spend a paid provider call on a concept already known to be wrong
 *     (Sprint 2M Phase 2E Goal 6 — the source eligibility gate)
 *   - inherit a paid reconstruction provider's production-wording or
 *     fidelity verdict from the source concept's own Concept Evaluation
 *     (Sprint 2M Phase 2E Goal 7/9 — independent production verification)
 *   - duplicate a production asset on retry/recovery (Goal 16)
 *   - duplicate a PAID provider request on retry/recovery/worker races
 *     (Sprint 2M Phase 2E Goal 3)
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkVersion,
  AssetRecord,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  FinalArtworkJob,
} from "@/lib/domain/types";
import type { AssetCapability } from "@/capabilities/assets";
import type { PrintValidationCapability } from "@/capabilities/print-validation";
import {
  assembleAuthoritativeProductionPrintValidationInput,
  createPrintValidationCapability,
  deriveProductionRequirements,
} from "@/capabilities/print-validation";
import type {
  PrintValidationReport,
  ProductionNormalizationSummary,
  ResolutionProvenance,
} from "@/capabilities/print-validation/contracts";
import { getWorkerHeartbeatIntervalMs } from "@/lib/config/worker-config";
import type { PlacementSizingPolicy } from "@/capabilities/shared/print-placement-dimensions";
import type { FinalArtworkProvider, FinalArtworkProviderResumeContext } from "@/capabilities/final-artwork/provider";
import type { ProductionNormalizationMetadata } from "@/capabilities/final-artwork/production-normalization";
import {
  createConceptEvaluationCapability,
  resolveConceptEvaluationProvider,
  type ConceptEvaluationCapability,
} from "@/capabilities/concept-evaluation";
import { ProviderError } from "@/capabilities/providers/provider-error";

import { checkSourceEligibleForFinalization } from "./source-eligibility";
import { verifyProductionArtwork } from "./production-verification";
import {
  logFinalArtworkPaidCallDecision,
  logFinalArtworkReconstructionOutcome,
} from "./final-artwork-observability";

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
  reconstructedWidthPx: number | null;
  reconstructedHeightPx: number | null;
  preservesApprovedContent: boolean;
  providerRequestId: string | null;
  /**
   * Print-Ready Normalization Phase 1: the production transform's own
   * measured geometry, as the provider-neutral summary authoritative Print
   * Validation consumes. `null` only for a production asset persisted before
   * this phase existed (see `provenanceFromExistingAsset`) — such an asset is
   * honestly re-validated without normalization evidence rather than being
   * credited with geometry nobody measured.
   */
  normalization: ProductionNormalizationSummary | null;
}

export function createFinalArtworkWorkerCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  provider: FinalArtworkProvider,
  printValidation: PrintValidationCapability = createPrintValidationCapability(),
  conceptEvaluation: ConceptEvaluationCapability = createConceptEvaluationCapability(
    resolveConceptEvaluationProvider(),
  ),
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
   * 17), a genuinely unknown target physical size (Goal 4), or (Sprint 2M
   * Phase 2E) a source concept that already failed its own required-wording
   * evaluation (Goal 6 — never worth spending a paid reconstruction call
   * on). This is a successfully *completed* determination, not a failure:
   * nothing crashed, the truth is simply "this cannot be auto-finalized."
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
   * This is also what keeps a Topaz reconstruction that finishes AFTER the
   * customer's approval was superseded mid-flight from ever making the
   * project honestly appear print_ready for a stale result (Sprint 2M
   * Phase 2E Goal 12/W).
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

  function provenanceFromExistingAsset(
    asset: AssetRecord,
    sizing: PlacementSizingPolicy,
  ): ProductionProvenanceMeta {
    const meta = asset.metadata as Record<string, unknown>;
    const normalization = readNormalizationSummary(meta.normalization, sizing);
    const provenance =
      meta.resolutionProvenance === "native" ||
      meta.resolutionProvenance === "interpolated_upscale" ||
      meta.resolutionProvenance === "reconstructed"
        ? (meta.resolutionProvenance as ResolutionProvenance)
        : "unknown";
    return {
      resolutionProvenance: provenance,
      nativeWidthPx: typeof meta.nativeWidthPx === "number" ? meta.nativeWidthPx : null,
      nativeHeightPx: typeof meta.nativeHeightPx === "number" ? meta.nativeHeightPx : null,
      reconstructedWidthPx:
        typeof meta.reconstructedWidthPx === "number" ? meta.reconstructedWidthPx : null,
      reconstructedHeightPx:
        typeof meta.reconstructedHeightPx === "number" ? meta.reconstructedHeightPx : null,
      preservesApprovedContent: meta.preservesApprovedContent === true,
      providerRequestId:
        typeof meta.providerRequestId === "string" ? meta.providerRequestId : null,
      normalization,
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

    // --- Sprint 2M Phase 2E (Goal 6): source eligibility gate. Runs before
    // ANY provider call — local or paid — so a concept already known to be
    // wrong is never treated as finalizable, and a paid reconstruction call
    // is never spent on it.
    const eligibility = checkSourceEligibleForFinalization(artwork.evaluation);
    if (!eligibility.eligible) {
      await completeWithoutAsset(job, eligibility.reason ?? "Source concept is not eligible for finalization.");
      return;
    }

    // Goal 4: the bounded apparel-placement policy already established by
    // `shared/print-placement-dimensions.ts` (full_front/full_back,
    // left_chest, sleeve) via `deriveProductionRequirements` — no new
    // universal assumption invented here.
    // Live Acceptance Cleanup (Issue 5): the customer's chosen production
    // WIDTH is authoritative production intent and is read from the working
    // brief (`intendedPrintWidthIn`), not from the frozen brief snapshot.
    // Physical size is a production specification, not creative content — it
    // is deliberately absent from `DesignBriefSnapshotContent`, so choosing
    // 12 inches never supersedes an approved brief version, never restyles
    // artwork, and never marks a concept stale. `null` (never chosen) falls
    // back to the placement default, exactly as before this pass.
    //
    // Nothing about the size comes from the request that enqueued this job,
    // so a stale or forged finalize call cannot smuggle a different one in;
    // and nothing infers it from the pixels a generator happened to produce.
    const intendedPrintWidthIn = snapshot.brief.intendedPrintWidthIn;
    const requirements = deriveProductionRequirements({
      printPlacement: briefVersion.content.printPlacement,
      productSummary: briefVersion.content.productSummary,
      designDescription: briefVersion.content.designDescription,
      intendedPrintWidthIn,
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
    // determine target dimensions — never guessed. Print-Ready Normalization
    // Phase 1: what the provider needs is the placement's SIZING POLICY
    // (target physical width + PPI); output pixels are resolved from the
    // trimmed artwork's own aspect ratio inside the production transform.
    if (!requirements.sizing) {
      await completeWithoutAsset(
        job,
        "Print location is not yet known; target production dimensions could not be determined.",
      );
      return;
    }
    const sizing = requirements.sizing;

    // --- Goal 16: idempotent retry — reuse an already-created production
    // asset for this exact job rather than transforming/uploading again.
    let productionAsset = await resolveExistingProductionAsset(job);
    let provenance: ProductionProvenanceMeta;
    let providerLatencyMs: number | null = null;

    if (productionAsset) {
      provenance = provenanceFromExistingAsset(productionAsset, sizing);
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

      // --- Sprint 2M Phase 2E (Goal 3): resume a prior paid request for
      // THIS exact job when one exists and belongs to THIS exact provider —
      // never resubmit while a paid reconstruction may still be in flight
      // or already complete server-side.
      const existingProviderRequest: FinalArtworkProviderResumeContext | null =
        job.providerKey === provider.providerKey && job.providerRequestId
          ? {
              providerKey: job.providerKey,
              providerRequestId: job.providerRequestId,
              providerStatus: job.providerStatus,
            }
          : null;

      let submittedNewPaidRequest = false;
      const providerStartedAt = Date.now();
      let output;
      try {
        output = await withPeriodicHeartbeat(job.id, () =>
          provider.produce({
            sourceBytes: source.bytes,
            sourceContentType: sourceAsset.contentType ?? source.contentType,
            sizing,
            existingProviderRequest,
            onProviderRequestSubmitted: async (providerRequestId) => {
              submittedNewPaidRequest = true;
              // Persisted BEFORE the provider polls/downloads anything
              // further — the entire point of this hook (Goal 3): a crash
              // any time after this write is resumable without a second
              // paid submission.
              await repo.updateFinalArtworkJob(job.id, {
                providerKey: provider.providerKey,
                providerRequestId,
                providerStatus: "submitted",
              });
            },
          }),
        );
      } catch (error) {
        // Sprint 2M Phase 2E (Goal 3/12): a request that reached a terminal
        // failure state AT THE PROVIDER (not merely a local/network hiccup)
        // is provably dead — clearing the persisted request identity here
        // is what allows a future retry to submit a fresh paid request
        // instead of resuming a request that can never succeed.
        // Every other failure classification intentionally leaves the
        // persisted request identity alone, so a retry resumes (never
        // resubmits) whatever may still be in flight or already complete.
        if (error instanceof ProviderError && error.classification === "provider_job_failed") {
          await repo.updateFinalArtworkJob(job.id, {
            providerKey: null,
            providerRequestId: null,
            providerStatus: null,
          });
        }
        await failJob(job, describeFinalArtworkError(error));
        return;
      }
      providerLatencyMs = Date.now() - providerStartedAt;

      logFinalArtworkPaidCallDecision({
        projectId: job.projectId,
        finalArtworkJobId: job.id,
        providerKey: provider.providerKey,
        submittedNewPaidRequest,
        providerRequestId: output.providerRequestId,
      });

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
            reconstructedWidthPx: output.reconstructedWidthPx,
            reconstructedHeightPx: output.reconstructedHeightPx,
            preservesApprovedContent: output.preservesApprovedContent,
            providerRequestId: output.providerRequestId,
            sourceAssetId: sourceAsset.id,
            // Print-Ready Normalization Phase 1: the production transform's
            // full measured geometry travels WITH the plate, so a recovered
            // or retried attempt re-validates the same deliverable against
            // the same evidence instead of re-deriving it.
            normalization: output.normalization as unknown as Record<string, unknown>,
          },
        });
      } catch (error) {
        await failJob(
          job,
          `Production asset could not be persisted: ${describeFinalArtworkError(error)}`,
        );
        return;
      }

      // Explicit completion marker for the paid-request identity — never
      // load-bearing for correctness (the production asset's own existence
      // is what idempotency actually keys off), purely for internal
      // diagnostics (Goal 13/14).
      if (output.providerRequestId) {
        await repo.updateFinalArtworkJob(job.id, { providerStatus: "completed" });
      }

      provenance = {
        resolutionProvenance: output.resolutionProvenance,
        nativeWidthPx: output.nativeWidthPx,
        nativeHeightPx: output.nativeHeightPx,
        reconstructedWidthPx: output.reconstructedWidthPx,
        reconstructedHeightPx: output.reconstructedHeightPx,
        preservesApprovedContent: output.preservesApprovedContent,
        providerRequestId: output.providerRequestId,
        normalization: toNormalizationSummary(output.normalization, sizing),
      };
    }

    // Print-Ready Normalization Phase 1: `print_ready` means the NORMALIZED
    // artwork itself is production-ready, which cannot be decided without the
    // plate's own measured production geometry. A production asset persisted
    // before this phase carries none, so it is honestly reported as needing
    // finalization rather than re-credited as ready on the strength of a
    // canvas nobody measured. Existing assets are never deleted, rewritten,
    // or regenerated here.
    if (!provenance.normalization) {
      await repo.updateFinalArtworkJob(job.id, {
        status: "completed",
        lastError:
          "This production artwork predates print-ready normalization and carries no recorded production geometry; it must be re-prepared before it can be confirmed print-ready.",
        completedAt: new Date().toISOString(),
      });
      await maybeTransitionProjectStatus(job, "finalization_required");
      return;
    }

    // --- Sprint 2M Phase 2E (Goal 7/9): independent production
    // verification. A provider that cannot honestly declare
    // `preservesApprovedContent: true` (Topaz never does — see
    // `provider.ts`) must never let the source concept's own Concept
    // Evaluation stand in for verification of the actual reconstructed
    // OUTPUT — required wording and design fidelity are both re-checked
    // against the real production asset, against the exact approved brief
    // snapshot this job was built from (never a newer working brief).
    let conceptEvaluationStatusForValidation: ConceptEvaluationStatus | null;
    let conceptEvaluationForValidation: ConceptEvaluation | null;

    if (provenance.preservesApprovedContent) {
      // Unchanged Phase 2C behavior — a pure geometric resample (local
      // interpolation) never redraws content, so the source concept's own
      // already-persisted evaluation honestly still applies.
      conceptEvaluationStatusForValidation = artwork.evaluationStatus;
      conceptEvaluationForValidation = artwork.evaluation;
    } else {
      const signedUrl = await assets.getSignedUrl(productionAsset.id);
      const verification = await verifyProductionArtwork(conceptEvaluation, {
        brief: briefVersion.content,
        concept: {
          title: artwork.title,
          summary: artwork.summary,
          placeholderLabel: artwork.placeholderLabel,
        },
        productionAsset: {
          assetId: productionAsset.id,
          contentType: productionAsset.contentType,
          widthPx: productionAsset.widthPx,
          heightPx: productionAsset.heightPx,
          sourceUrl: signedUrl,
        },
        idempotencyKey: `production-verification:${job.id}:${productionAsset.id}`,
      });
      conceptEvaluationStatusForValidation = verification.evaluationStatus;
      conceptEvaluationForValidation = verification.evaluation;
    }

    // --- Goal 11: authoritative Print Validation against the real
    // production asset — the only run that may ever justify "print_ready".
    const currentApproved = await repo.getLatestDesignBriefVersion(job.projectId);
    const validationInput = assembleAuthoritativeProductionPrintValidationInput({
      artworkVersionId: artwork.id,
      designBriefVersionId: briefVersion.id,
      currentApprovedDesignBriefVersionId: currentApproved?.id ?? null,
      brief: briefVersion.content,
      // The exact width this plate was sized from — validation judges it
      // against the intended size, never the placement default (Issue 5).
      intendedPrintWidthIn,
      asset: {
        contentType: productionAsset.contentType,
        widthPx: productionAsset.widthPx,
        heightPx: productionAsset.heightPx,
        hasTransparency: productionAsset.hasTransparency,
        resolutionProvenance: provenance.resolutionProvenance,
        nativeWidthPx: provenance.nativeWidthPx,
        nativeHeightPx: provenance.nativeHeightPx,
      },
      conceptEvaluationStatus: conceptEvaluationStatusForValidation,
      conceptEvaluation: conceptEvaluationForValidation,
      normalization: provenance.normalization,
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

    logFinalArtworkReconstructionOutcome({
      projectId: job.projectId,
      finalArtworkJobId: job.id,
      artworkVersionId: artwork.id,
      providerKey: provider.providerKey,
      providerRequestId: provenance.providerRequestId,
      sourceWidthPx: provenance.nativeWidthPx ?? sourceAsset.widthPx ?? 0,
      sourceHeightPx: provenance.nativeHeightPx ?? sourceAsset.heightPx ?? 0,
      reconstructedWidthPx: provenance.reconstructedWidthPx,
      reconstructedHeightPx: provenance.reconstructedHeightPx,
      finalCanvasWidthPx: productionAsset.widthPx ?? 0,
      finalCanvasHeightPx: productionAsset.heightPx ?? 0,
      requiredWordingVerification:
        report.checks.find((c) => c.check === "required_wording_verification")?.status ?? "unknown",
      conceptEvaluationAlignment:
        report.checks.find((c) => c.check === "concept_evaluation_alignment")?.status ?? "unknown",
      transparencyCheck: report.checks.find((c) => c.check === "transparency")?.status ?? "unknown",
      finalValidationStatus: report.status,
      providerLatencyMs,
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

/**
 * Print-Ready Normalization Phase 1: maps the Final Artwork provider's own
 * normalization metadata onto the provider-neutral summary Print Validation
 * consumes. Print Validation must never depend on the Final Artwork
 * capability's types (ARCHITECTURE.md dependency direction), so this worker —
 * which legitimately knows both — is the one place the two shapes meet.
 *
 * `widthToleranceIn` comes from the placement policy rather than the provider:
 * how closely a plate must match its target width is a production-policy
 * decision, never a provider's to declare.
 */
function toNormalizationSummary(
  normalization: ProductionNormalizationMetadata,
  sizing: PlacementSizingPolicy,
): ProductionNormalizationSummary {
  return {
    strategy: normalization.strategy,
    alphaBBoxWidthPx: normalization.alphaBBoxWidthPx,
    alphaBBoxHeightPx: normalization.alphaBBoxHeightPx,
    trimmedWidthPx: normalization.trimmedWidthPx,
    trimmedHeightPx: normalization.trimmedHeightPx,
    artworkOccupancy: normalization.artworkOccupancy,
    targetWidthIn: normalization.targetWidthIn,
    widthToleranceIn: sizing.widthToleranceIn,
    targetPpi: normalization.targetPpi,
    intendedWidthIn: normalization.intendedWidthIn,
    intendedHeightIn: normalization.intendedHeightIn,
    constrainedBy: normalization.constrainedBy,
    densityPixelsPerMetre: normalization.densityPixelsPerMetre,
  };
}

/**
 * Reads a normalization summary back off an already-persisted production
 * asset (the Goal 16 idempotent-retry path). Returns `null` for anything that
 * is not a complete, numerically valid record — a partially-recorded plate is
 * treated exactly like one from before this phase, never patched up with
 * defaults that would amount to inventing geometry.
 *
 * `widthToleranceIn` comes from the current placement policy rather than the
 * stored record, for the same reason it does on a fresh run: how closely a
 * plate must match its target width is a production-policy decision, not a
 * property of the file.
 */
function readNormalizationSummary(
  value: unknown,
  sizing: PlacementSizingPolicy,
): ProductionNormalizationSummary | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Record<string, unknown>;

  const numbers = [
    "alphaBBoxWidthPx",
    "alphaBBoxHeightPx",
    "trimmedWidthPx",
    "trimmedHeightPx",
    "artworkOccupancy",
    "targetWidthIn",
    "targetPpi",
    "intendedWidthIn",
    "intendedHeightIn",
  ] as const;
  for (const key of numbers) {
    if (typeof meta[key] !== "number" || !Number.isFinite(meta[key] as number)) return null;
  }
  if (meta.strategy !== "width_constrained_preserve_aspect") return null;
  if (meta.constrainedBy !== "width" && meta.constrainedBy !== "max_height") return null;

  return {
    strategy: "width_constrained_preserve_aspect",
    alphaBBoxWidthPx: meta.alphaBBoxWidthPx as number,
    alphaBBoxHeightPx: meta.alphaBBoxHeightPx as number,
    trimmedWidthPx: meta.trimmedWidthPx as number,
    trimmedHeightPx: meta.trimmedHeightPx as number,
    artworkOccupancy: meta.artworkOccupancy as number,
    targetWidthIn: meta.targetWidthIn as number,
    widthToleranceIn: sizing.widthToleranceIn,
    targetPpi: meta.targetPpi as number,
    intendedWidthIn: meta.intendedWidthIn as number,
    intendedHeightIn: meta.intendedHeightIn as number,
    constrainedBy: meta.constrainedBy,
    densityPixelsPerMetre:
      typeof meta.densityPixelsPerMetre === "number" ? meta.densityPixelsPerMetre : null,
  };
}

function summarizeReportForInternalLog(report: PrintValidationReport): string {
  return (
    report.blockingIssues.slice(0, 5).join("; ") ||
    "Authoritative validation did not return ready."
  );
}
