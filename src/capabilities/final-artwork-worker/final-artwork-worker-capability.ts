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

import { createHash } from "node:crypto";
import { PNG } from "pngjs";

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
  assembleUploadedPreserveProductionPrintValidationInput,
  createPrintValidationCapability,
  deriveProductionRequirements,
} from "@/capabilities/print-validation";
import type {
  PrintValidationInput,
  PrintValidationReport,
  ProductionNormalizationSummary,
  ResolutionProvenance,
  UploadedPreserveEvidence,
} from "@/capabilities/print-validation/contracts";
import { getWorkerHeartbeatIntervalMs } from "@/lib/config/worker-config";
import {
  resolveProductionWidth,
  type PlacementSizingPolicy,
} from "@/capabilities/shared/print-placement-dimensions";
import type { FinalArtworkProvider, FinalArtworkProviderResumeContext } from "@/capabilities/final-artwork/provider";
import type { ProductionNormalizationMetadata } from "@/capabilities/final-artwork/production-normalization";
import { computeAlphaBounds, DEFAULT_ALPHA_THRESHOLD } from "@/capabilities/final-artwork/alpha-trim";
import { decideEnhancement } from "@/capabilities/final-artwork/enhancement-decision";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
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

/**
 * Existing Artwork → Print Ready Phase 2: what the production transform did to
 * an uploaded artwork's own pixels, persisted alongside the plate so a
 * retried/recovered attempt re-validates against the same recorded evidence
 * rather than re-deriving it (and so lineage survives even if the preparation
 * row is later read through a different path).
 */
interface UploadedPreserveMeta extends UploadedPreserveEvidence {
  /** Internal-only note for job diagnostics — never customer-facing copy. */
  enhancementReason: string;
}

export function createFinalArtworkWorkerCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  provider: FinalArtworkProvider,
  printValidation: PrintValidationCapability = createPrintValidationCapability(),
  conceptEvaluation: ConceptEvaluationCapability = createConceptEvaluationCapability(
    resolveConceptEvaluationProvider(),
  ),
  /**
   * Existing Artwork → Print Ready Phase 2 (Goal 15): the NORMALIZATION-ONLY
   * provider — a local, deterministic alpha-trim/resample/encode with no
   * network call and no paid request.
   *
   * Injected rather than assumed, because "which provider runs" is the whole
   * substance of the cost decision: uploaded artwork that already carries
   * enough real pixels must never reach the paid reconstruction provider at
   * all (`decideEnhancement`), and a test proving that has to be able to see
   * which of the two was actually called. The default is the real local
   * provider, so composition and every existing caller need no change.
   *
   * Never used for the create_new path, whose provider selection is entirely
   * unchanged.
   */
  localNormalizationProvider: FinalArtworkProvider = new LocalRasterInterpolationProvider(),
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
    if (job.sourceKind === "prepared_upload") {
      if (!(await isPreparedUploadJobStillCurrent(job))) return;
      await repo.setProjectStatus(job.projectId, status);
      return;
    }
    const activeApproval = await repo.getActiveFinalDirectionApproval(job.projectId);
    if (!activeApproval || activeApproval.id !== job.finalDirectionApprovalId) return;
    await repo.setProjectStatus(job.projectId, status);
  }

  /**
   * The upload workflow's equivalent of "is this job's approval still the
   * project's active one?".
   *
   * Two ways a prepared-upload job can stop being current while it runs:
   * the preparation it was authorized by is gone or no longer approved, or
   * the customer changed the production print width mid-flight. In the second
   * case the plate this job produces is perfectly valid — for a size the
   * customer no longer wants — so it must never flip the project to
   * `print_ready`, which would put the old size in front of them as finished.
   * The newer size's own job owns the project status from that point on.
   */
  async function isPreparedUploadJobStillCurrent(
    job: FinalArtworkJob,
  ): Promise<boolean> {
    if (!job.artworkPreparationId || job.productionWidthIn === null) return false;

    const preparation = await repo.getArtworkPreparationById(job.artworkPreparationId);
    if (
      !preparation ||
      preparation.projectId !== job.projectId ||
      preparation.status !== "approved" ||
      preparation.preparedArtworkVersionId !== job.artworkVersionId
    ) {
      return false;
    }

    const snapshot = await repo.getProject(job.projectId);
    if (!snapshot) return false;

    const resolved = resolveProductionWidth(
      snapshot.brief.printPlacement,
      snapshot.brief.intendedPrintWidthIn,
    );
    if (!resolved) return false;
    return Math.abs(resolved.widthIn - job.productionWidthIn) < 1e-6;
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

  /**
   * The production transform, from "we know the exact source asset and the
   * exact production size" to "a persisted, immutable production asset with
   * its own measured provenance".
   *
   * Shared by both workflows deliberately: the paid-request resume contract,
   * the attempt ceiling, the persist-before-poll ordering, and the
   * never-duplicate-an-asset rule are subtle enough that a second copy of them
   * for uploaded artwork would drift, and drift here costs real money and
   * produces plates nobody can account for. What differs between the two
   * workflows is which authority resolved the source and which profile judges
   * the result — never this.
   *
   * Returns `{ status: "handled" }` when it has already written a terminal job
   * state (failed, or attempt ceiling exceeded); the caller simply returns.
   */
  async function produceProductionAsset(params: {
    job: FinalArtworkJob;
    sourceAsset: AssetRecord;
    sizing: PlacementSizingPolicy;
    /** The provider this job will actually call — for uploads, already chosen by `decideEnhancement`. */
    activeProvider: FinalArtworkProvider;
    /** Storage folder grouping for this job's deliverables. Never a filename convention, never customer-supplied. */
    storageGroupingId: string;
    missingSourceBytesReason: string;
    /** Workflow-specific provenance persisted alongside the plate (e.g. uploaded-preserve lineage). */
    extraAssetMetadata: Record<string, unknown>;
  }): Promise<
    | {
        status: "ready";
        productionAsset: AssetRecord;
        provenance: ProductionProvenanceMeta;
        providerLatencyMs: number | null;
      }
    | { status: "handled" }
  > {
    const { job, sourceAsset, sizing, activeProvider } = params;

    const existing = await resolveExistingProductionAsset(job);
    if (existing) {
      return {
        status: "ready",
        productionAsset: existing,
        provenance: provenanceFromExistingAsset(existing, sizing),
        providerLatencyMs: null,
      };
    }

    if (job.attempts > MAX_FINAL_ARTWORK_ATTEMPTS) {
      await failJob(
        job,
        `Exceeded maximum finalization attempts (${MAX_FINAL_ARTWORK_ATTEMPTS}) after repeated recovery.`,
      );
      return { status: "handled" };
    }

    const source = await assets.downloadAssetBytes(sourceAsset.id);
    if (!source) {
      await failJob(job, params.missingSourceBytesReason);
      return { status: "handled" };
    }

    // --- Sprint 2M Phase 2E (Goal 3): resume a prior paid request for
    // THIS exact job when one exists and belongs to THIS exact provider —
    // never resubmit while a paid reconstruction may still be in flight
    // or already complete server-side.
    const existingProviderRequest: FinalArtworkProviderResumeContext | null =
      job.providerKey === activeProvider.providerKey && job.providerRequestId
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
        activeProvider.produce({
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
              providerKey: activeProvider.providerKey,
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
      return { status: "handled" };
    }
    const providerLatencyMs = Date.now() - providerStartedAt;

    logFinalArtworkPaidCallDecision({
      projectId: job.projectId,
      finalArtworkJobId: job.id,
      providerKey: activeProvider.providerKey,
      submittedNewPaidRequest,
      providerRequestId: output.providerRequestId,
    });

    let productionAsset: AssetRecord;
    try {
      productionAsset = await assets.uploadProductionAsset(job.projectId, {
        // Groups this job's production deliverable(s) under one storage
        // folder — a stable internal id, never a filename convention and
        // never anything a customer supplied (Goal 10 / Goal 18).
        conceptId: params.storageGroupingId,
        bytes: output.bytes,
        contentType: output.contentType,
        widthPx: output.widthPx,
        heightPx: output.heightPx,
        hasTransparency: output.hasTransparency,
        finalArtworkJobId: job.id,
        productionRole: "production_png",
        metadata: {
          transformationMethod: output.transformationMethod,
          providerKey: activeProvider.providerKey,
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
          ...params.extraAssetMetadata,
        },
      });
    } catch (error) {
      await failJob(
        job,
        `Production asset could not be persisted: ${describeFinalArtworkError(error)}`,
      );
      return { status: "handled" };
    }

    // Explicit completion marker for the paid-request identity — never
    // load-bearing for correctness (the production asset's own existence
    // is what idempotency actually keys off), purely for internal
    // diagnostics (Goal 13/14).
    if (output.providerRequestId) {
      await repo.updateFinalArtworkJob(job.id, { providerStatus: "completed" });
    }

    return {
      status: "ready",
      productionAsset,
      provenance: {
        resolutionProvenance: output.resolutionProvenance,
        nativeWidthPx: output.nativeWidthPx,
        nativeHeightPx: output.nativeHeightPx,
        reconstructedWidthPx: output.reconstructedWidthPx,
        reconstructedHeightPx: output.reconstructedHeightPx,
        preservesApprovedContent: output.preservesApprovedContent,
        providerRequestId: output.providerRequestId,
        normalization: toNormalizationSummary(output.normalization, sizing),
      },
      providerLatencyMs,
    };
  }

  /**
   * Existing Artwork → Print Ready Phase 2: the two workflows converge here.
   * Which customer authority created this job decides how its exact source is
   * resolved and which validation profile judges the result; everything after
   * that — the production transform, the production asset, authoritative
   * Print Validation, the print_ready decision — is one shared path.
   */
  async function runClaimedJob(job: FinalArtworkJob): Promise<void> {
    if (job.sourceKind === "prepared_upload") {
      await runPreparedUploadJob(job);
      return;
    }
    await runGeneratedConceptJob(job);
  }

  async function runGeneratedConceptJob(job: FinalArtworkJob): Promise<void> {
    if (!job.finalDirectionApprovalId) {
      await failJob(job, "This finalization job records no final-direction approval.");
      return;
    }
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
    const produced = await produceProductionAsset({
      job,
      sourceAsset,
      sizing,
      activeProvider: provider,
      storageGroupingId: job.finalDirectionApprovalId,
      missingSourceBytesReason:
        "Source concept asset bytes could not be retrieved from storage.",
      extraAssetMetadata: {},
    });
    if (produced.status !== "ready") return;
    const { productionAsset, provenance, providerLatencyMs } = produced;

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

    await finishValidatedJob({
      job,
      artwork,
      sourceAsset,
      productionAsset,
      provenance,
      providerLatencyMs,
      providerKey: provider.providerKey,
      validationInput,
    });
  }

  /**
   * Existing Artwork → Print Ready Phase 2: production finalization for
   * artwork the CUSTOMER supplied and approved.
   *
   * The preservation contract, enforced structurally rather than by
   * convention:
   *
   *   - the source is the APPROVED PREPARED PNG, never the immutable original
   *     upload (Goal 6). Background isolation was already accepted by the
   *     customer; re-running it here would re-litigate a decision they made,
   *     and starting from the opaque original would discard it entirely.
   *   - no OpenAI, no creative edit path, no concept generation, no
   *     `GenerationJob`, no prompt of any kind. The only provider that can
   *     run is a raster `FinalArtworkProvider`, and only when the artwork
   *     genuinely lacks the pixels for the requested size.
   *   - nothing about the artwork's wording, colours, layout, or composition
   *     is examined, judged, or changed. The pixels are the specification.
   */
  async function runPreparedUploadJob(job: FinalArtworkJob): Promise<void> {
    // Guaranteed by the database CHECK constraint and the capability that
    // enqueues these; checked anyway because the alternative to an honest
    // failure here is a confident production run against nothing.
    if (!job.artworkPreparationId || job.productionWidthIn === null) {
      await failJob(
        job,
        "This uploaded-artwork finalization job records no preparation or no production size.",
      );
      return;
    }

    const preparation = await repo.getArtworkPreparationById(job.artworkPreparationId);
    // Goal 18: a preparation belonging to another project is rejected here
    // rather than followed — the ownership check is against the row itself,
    // never assumed from the fact that the job names an id.
    if (!preparation || preparation.projectId !== job.projectId) {
      await failJob(job, "Referenced artwork preparation no longer exists for this project.");
      return;
    }
    // The upload workflow's equivalent of a superseded approval: the customer's
    // approval of the prepared artwork is the authority, so production must not
    // proceed on its own once that approval no longer stands.
    if (preparation.status !== "approved") {
      await cancelJob(
        job,
        "The prepared artwork was no longer approved when production was attempted.",
      );
      return;
    }
    if (preparation.preparedArtworkVersionId !== job.artworkVersionId) {
      await cancelJob(
        job,
        "The prepared artwork this job was authorized for is no longer the project's approved prepared artwork.",
      );
      return;
    }
    if (!preparation.preparedAssetId) {
      await failJob(job, "The approved preparation has no prepared artwork to finalize.");
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
    // Goal 18: `snapshot.artworkVersions` is already project-scoped, so a
    // cross-project id can never appear in it.
    if (!artwork) {
      await failJob(job, "Prepared artwork no longer exists for this project.");
      return;
    }
    // Provenance is never inferred (Constitution §16): a finalization
    // authorized by a preparation must be finalizing uploaded artwork, not
    // something that drifted into a generated concept.
    if (artwork.kind !== "prepared_upload") {
      await failJob(
        job,
        "The artwork this uploaded-artwork job names is not customer-uploaded prepared artwork.",
      );
      return;
    }

    // --- Goal 6: THE source contract. The prepared, transparent PNG — never
    // `preparation.originalAssetId`, and never `snapshot`'s idea of a
    // "selected concept".
    const sourceAsset = await repo.getAssetById(preparation.preparedAssetId);
    if (!sourceAsset || sourceAsset.projectId !== job.projectId) {
      await failJob(job, "Prepared artwork asset could not be resolved for this project.");
      return;
    }
    if (sourceAsset.id === preparation.originalAssetId) {
      await failJob(
        job,
        "The preparation's prepared asset and immutable original are the same record; refusing to finalize from the unprepared upload.",
      );
      return;
    }
    if (artwork.primaryAssetId !== sourceAsset.id) {
      await failJob(
        job,
        "The approved prepared artwork and the preparation's prepared asset disagree; refusing to finalize an unverified source.",
      );
      return;
    }

    // Production requirements come from the production context the customer
    // stated in the upload flow. There is no `designDescription` — for
    // uploaded artwork the pixels ARE the design, and a written description of
    // them would be a second, competing source of truth.
    //
    // The width is the job's OWN frozen intent, not the live working brief: a
    // size change while this job is queued must produce a new job, never
    // silently re-target this one mid-flight.
    const intendedPrintWidthIn = job.productionWidthIn;
    const requirements = deriveProductionRequirements({
      printPlacement: snapshot.brief.printPlacement,
      productSummary: snapshot.brief.productSummary,
      designDescription: null,
      intendedPrintWidthIn,
    });

    if (requirements.category !== "apparel_raster") {
      await completeWithoutAsset(
        job,
        `Unsupported production method for automated raster finalization (category: ${requirements.category}); requires human production planning.`,
      );
      return;
    }
    if (!requirements.sizing) {
      await completeWithoutAsset(
        job,
        "Print location is not yet known; target production dimensions could not be determined.",
      );
      return;
    }
    const sizing = requirements.sizing;

    // --- Goals 4/5/15: the enhancement decision, made BEFORE any provider is
    // contacted, from the artwork's own visible pixels.
    const measured = await measurePreparedSource(job, sourceAsset.id);
    if (!measured) return;

    const enhancement = decideEnhancement({
      sourceVisibleWidthPx: measured.alphaBBoxWidthPx,
      targetWidthIn: sizing.targetWidthIn,
      targetPpi: sizing.targetPpi,
    });

    // The one place the paid provider is chosen — or not. Artwork that already
    // carries the target's worth of real pixels never reaches it (Goal 15: one
    // paid request per idempotency key, and none at all when the pixels are
    // already there).
    const activeProvider = enhancement.requiresReconstruction
      ? provider
      : localNormalizationProvider;

    const uploadedPreserveMeta: UploadedPreserveMeta = {
      preparedArtworkVersionId: artwork.id,
      preparedAssetId: sourceAsset.id,
      originalAssetId: preparation.originalAssetId,
      sourceBytesSha256: measured.sha256,
      sourceAlphaBBoxWidthPx: measured.alphaBBoxWidthPx,
      sourceAlphaBBoxHeightPx: measured.alphaBBoxHeightPx,
      enhancement: enhancement.method,
      enhancementReason: enhancement.reason,
    };

    const produced = await produceProductionAsset({
      job,
      sourceAsset,
      sizing,
      activeProvider,
      // The preparation id — stable, internal, and unique per job together
      // with the production width. Never the customer's filename (Goal 18).
      storageGroupingId: `prepared-upload-${job.artworkPreparationId}`,
      missingSourceBytesReason:
        "Prepared artwork bytes could not be retrieved from storage.",
      extraAssetMetadata: {
        uploadedPreserve: uploadedPreserveMeta as unknown as Record<string, unknown>,
        // The production size this plate was actually made for, alongside the
        // geometry — so a plate can be matched to an intent without a join.
        productionWidthIn: intendedPrintWidthIn,
      },
    });
    if (produced.status !== "ready") return;
    const { productionAsset, provenance, providerLatencyMs } = produced;

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

    // --- Goal 7: authoritative Print Validation under the UPLOADED-PRESERVE
    // profile. No Concept Evaluation runs and none is passed: there is no
    // brief describing this artwork to evaluate it against, and no typed
    // wording to verify it carries. Everything a print shop would reject a
    // file for still blocks, and three preservation checks are added.
    //
    // Note what is NOT here: no `verifyProductionArtwork` call. That exists to
    // re-check a reconstruction against the brief that specified it, which for
    // uploaded artwork would mean judging the customer's own design against a
    // specification nobody wrote.
    const validationInput = assembleUploadedPreserveProductionPrintValidationInput({
      artworkVersionId: artwork.id,
      printPlacement: snapshot.brief.printPlacement,
      productSummary: snapshot.brief.productSummary,
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
      normalization: provenance.normalization,
      uploadedPreserve: readUploadedPreserveEvidence(
        productionAsset,
        uploadedPreserveMeta,
      ),
    });

    await finishValidatedJob({
      job,
      artwork,
      sourceAsset,
      productionAsset,
      provenance,
      providerLatencyMs,
      providerKey: activeProvider.providerKey,
      validationInput,
    });
  }

  /**
   * Decodes the approved prepared PNG once, for the two facts the upload path
   * needs before it can decide anything: where the artwork actually is, and
   * exactly which bytes it is.
   *
   * The alpha bounds are measured with the SAME threshold production
   * normalization uses, so the "did the geometry survive?" check downstream
   * compares one measurement against another rather than two different
   * definitions of "visible".
   */
  async function measurePreparedSource(
    job: FinalArtworkJob,
    preparedAssetId: string,
  ): Promise<{
    alphaBBoxWidthPx: number;
    alphaBBoxHeightPx: number;
    sha256: string;
  } | null> {
    const downloaded = await assets.downloadAssetBytes(preparedAssetId);
    if (!downloaded) {
      await failJob(job, "Prepared artwork bytes could not be retrieved from storage.");
      return null;
    }

    let decoded: PNG;
    try {
      decoded = PNG.sync.read(downloaded.bytes);
    } catch (error) {
      await failJob(
        job,
        `Prepared artwork could not be decoded as a PNG: ${describeFinalArtworkError(error)}`,
      );
      return null;
    }

    const bounds = computeAlphaBounds(
      { width: decoded.width, height: decoded.height, data: decoded.data },
      DEFAULT_ALPHA_THRESHOLD,
    );
    if (!bounds) {
      // Fails safely and honestly rather than reconstructing an empty plate:
      // there is nothing printable here, which is a truthful verdict about the
      // artwork rather than an infrastructure failure to retry.
      await completeWithoutAsset(
        job,
        "The prepared artwork contains no visible pixels to produce print-ready artwork from.",
      );
      return null;
    }

    return {
      alphaBBoxWidthPx: bounds.width,
      alphaBBoxHeightPx: bounds.height,
      sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
    };
  }

  /**
   * The tail both workflows share: persist the authoritative validation run,
   * close the job, record observability, and make the ONE status decision that
   * may ever produce `print_ready`.
   */
  async function finishValidatedJob(params: {
    job: FinalArtworkJob;
    artwork: ArtworkVersion;
    sourceAsset: AssetRecord;
    productionAsset: AssetRecord;
    provenance: ProductionProvenanceMeta;
    providerLatencyMs: number | null;
    providerKey: string;
    validationInput: PrintValidationInput;
  }): Promise<void> {
    const { job, artwork, sourceAsset, productionAsset, provenance } = params;

    const report = printValidation.validateArtwork(params.validationInput);

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
      providerKey: params.providerKey,
      providerRequestId: provenance.providerRequestId,
      sourceWidthPx: provenance.nativeWidthPx ?? sourceAsset.widthPx ?? 0,
      sourceHeightPx: provenance.nativeHeightPx ?? sourceAsset.heightPx ?? 0,
      reconstructedWidthPx: provenance.reconstructedWidthPx,
      reconstructedHeightPx: provenance.reconstructedHeightPx,
      finalCanvasWidthPx: productionAsset.widthPx ?? 0,
      finalCanvasHeightPx: productionAsset.heightPx ?? 0,
      // Both resolve to "unknown" under the uploaded-preserve profile, which
      // does not emit them — honestly recorded as not-asked rather than
      // reported as if they had passed.
      requiredWordingVerification:
        report.checks.find((c) => c.check === "required_wording_verification")?.status ?? "unknown",
      conceptEvaluationAlignment:
        report.checks.find((c) => c.check === "concept_evaluation_alignment")?.status ?? "unknown",
      transparencyCheck: report.checks.find((c) => c.check === "transparency")?.status ?? "unknown",
      finalValidationStatus: report.status,
      providerLatencyMs: params.providerLatencyMs,
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

/**
 * Existing Artwork → Print Ready Phase 2: reads the preservation lineage back
 * off an already-persisted production asset, falling back to the lineage this
 * run just measured.
 *
 * The recorded copy wins when it is complete, for the same reason
 * `readNormalizationSummary` prefers the recorded geometry: on a retry or
 * recovery, the evidence that travelled WITH the file is the evidence that
 * describes it. An incomplete record falls back rather than being patched up
 * field-by-field — a half-recorded lineage stitched together from two sources
 * would be neither one's truth.
 */
function readUploadedPreserveEvidence(
  asset: AssetRecord,
  fallback: UploadedPreserveEvidence,
): UploadedPreserveEvidence {
  const recorded = (asset.metadata as Record<string, unknown>).uploadedPreserve;
  if (!recorded || typeof recorded !== "object") return fallback;
  const meta = recorded as Record<string, unknown>;

  const strings = [
    "preparedArtworkVersionId",
    "preparedAssetId",
    "originalAssetId",
    "sourceBytesSha256",
  ] as const;
  for (const key of strings) {
    if (typeof meta[key] !== "string" || !(meta[key] as string)) return fallback;
  }
  const numbers = ["sourceAlphaBBoxWidthPx", "sourceAlphaBBoxHeightPx"] as const;
  for (const key of numbers) {
    if (typeof meta[key] !== "number" || !Number.isFinite(meta[key] as number)) {
      return fallback;
    }
  }
  if (meta.enhancement !== "skipped" && meta.enhancement !== "reconstructed") {
    return fallback;
  }

  return {
    preparedArtworkVersionId: meta.preparedArtworkVersionId as string,
    preparedAssetId: meta.preparedAssetId as string,
    originalAssetId: meta.originalAssetId as string,
    sourceBytesSha256: meta.sourceBytesSha256 as string,
    sourceAlphaBBoxWidthPx: meta.sourceAlphaBBoxWidthPx as number,
    sourceAlphaBBoxHeightPx: meta.sourceAlphaBBoxHeightPx as number,
    enhancement: meta.enhancement,
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
