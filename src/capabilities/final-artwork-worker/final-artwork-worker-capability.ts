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
import { productionIntentMatches } from "@/lib/domain/types";
import type {
  ArtworkVersion,
  AssetRecord,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  FinalArtworkJob,
  SignPreservationVerification,
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
  DtfFeatureIntegritySummary,
  DtfFeatureRiskRegion,
  HalftoneProductionEvidence,
  PrintValidationInput,
  PrintValidationReport,
  ProductionNormalizationSummary,
  ProductionRequirements,
  ResolutionProvenance,
  UploadedPreserveEvidence,
} from "@/capabilities/print-validation/contracts";
import { measureFeatureIntegrity } from "@/capabilities/final-artwork/feature-integrity";
import type { FeatureIntegrityMeasurement } from "@/capabilities/final-artwork/feature-integrity";
import { measureDtfCoverage } from "@/capabilities/final-artwork/dtf-coverage";
import type { DtfCoverageMeasurement } from "@/capabilities/final-artwork/dtf-coverage";
import {
  DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
  DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
} from "@/capabilities/shared/dtf-feature-integrity-profile";
import { getWorkerHeartbeatIntervalMs } from "@/lib/config/worker-config";
import {
  confirmedSizeMatchesJobWidth,
  resolveProductionSizeConfirmation,
} from "@/capabilities/shared/confirmed-production-size";
import {
  resolveWidthConstrainedSizing,
  type PlacementSizingPolicy,
} from "@/capabilities/shared/print-placement-dimensions";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderIntermediateReconstruction,
  FinalArtworkProviderResumeContext,
} from "@/capabilities/final-artwork/provider";
import type { ProductionNormalizationMetadata } from "@/capabilities/final-artwork/production-normalization";
import { computeAlphaBounds, DEFAULT_ALPHA_THRESHOLD } from "@/capabilities/final-artwork/alpha-trim";
import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { decideEnhancement } from "@/capabilities/final-artwork/enhancement-decision";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import { HalftoneDtfProvider } from "@/capabilities/final-artwork/halftone-dtf-provider";
import type { HalftoneScreenMetadata } from "@/capabilities/final-artwork/halftone-screen";
import {
  isReconstructionIntermediateAsset,
  productionAssetMatchesEffectiveTarget,
  RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
  type EffectiveProductionTargetIn,
} from "@/capabilities/final-artwork/production-request-identity";
import {
  currentProductionTreatmentKey,
  resolveProductionTreatment,
  treatmentKeyMatchesJob,
} from "@/capabilities/shared/production-treatment";
import {
  createConceptEvaluationCapability,
  resolveConceptEvaluationProvider,
  type ConceptEvaluationCapability,
} from "@/capabilities/concept-evaluation";
import {
  createSignPreservationCapability,
  resolveSignPreservationSemanticProvider,
  type SignPreservationCapability,
  type SignPreservationSemanticEvidence,
} from "@/capabilities/sign-preservation";
import { ProviderError } from "@/capabilities/providers/provider-error";
import { attachAttentionCheckName } from "@/capabilities/shared/production-variant";

import { decodePngUpload } from "@/capabilities/artwork-preparation/image-decode";
import {
  pixelsPerMetreForPpi,
  withPhysicalPixelDensity,
} from "@/capabilities/final-artwork/production-png";
import type {
  RigidSignPlanEvidence,
  RigidSignSubstrateBoundaryEvidence,
} from "@/capabilities/print-validation/contracts";
import {
  adaptGeometryStepsToActualReconstruction,
  affectedEdgesForAxis,
  anyEdgeIsEdgeDependent,
  buildSignExecutionGeometryEvidence,
  computeSignPlanKey,
  deriveRigidSignProductionRequirements,
  encodeSignPlate,
  executeAdmittedSignSteps,
  executeSignRepairPlan,
  finalizeSignExecution,
  getSignResolutionPolicyById,
  normalizeProviderAlphaOnVerifiedOpaqueSource,
  planContainsOnlyAdmittedSteps,
  planRequiresBoundedReconstruction,
  planRequiresSemanticPreservationVerification,
  SIGN_RECONSTRUCTION_SCALE_CEILING,
  SIGN_REPAIR_PLAN_SCHEMA_VERSION,
  splitPlanAroundReconstruction,
  type ProviderAlphaNormalizationEvidence,
  type SignExecutionBounds,
  type SignExecutionGeometryEvidence,
  type SignInspectionReport,
  type SignRepairPlan,
  type SignRepairStep,
} from "@/capabilities/sign-preparation";
import {
  hasSignReconstructionCapability,
  type SignReconstructionProviderOutput,
} from "@/capabilities/final-artwork/sign-reconstruction-provider";
import {
  MAX_RECONSTRUCTION_DIM_PX,
  validateReconstructedGeometry,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";

import { checkSourceEligibleForFinalization } from "./source-eligibility";
import { verifyProductionArtwork } from "./production-verification";
import {
  logFinalArtworkEnhancementProviderGap,
  logFinalArtworkAttemptBudgetExhausted,
  logFinalArtworkPaidCallDecision,
  logFinalArtworkProviderFailure,
  logFinalArtworkReconstructionOutcome,
} from "./final-artwork-observability";

/** Mirrors `DEFAULT_STALE_JOB_MS` — a "running" job with no heartbeat for this long is presumed abandoned. */
export const DEFAULT_FINAL_ARTWORK_STALE_JOB_MS = 15 * 60 * 1000;
/**
 * "Separate Provider Recovery Attempt Budget": the FRESH-EXECUTION budget
 * only — a claim capable of issuing a brand-new paid provider submission.
 * Mirrors `MAX_GENERATION_ATTEMPTS` — caps attempts across customer retries
 * and worker-recovery reclaims combined. Unchanged from before this phase;
 * no longer the ONLY ceiling `produceProductionAsset` enforces — see
 * `MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS` for the other one.
 */
export const MAX_FINAL_ARTWORK_ATTEMPTS = 3;
/**
 * "Separate Provider Recovery Attempt Budget": the RESUME/RECOVERY budget —
 * how many separate claims may attempt to poll/download an EXISTING,
 * already-paid, still-matching provider request before this job gives up
 * on ever retrieving it. Deliberately a SEPARATE, more generous ceiling
 * than `MAX_FINAL_ARTWORK_ATTEMPTS`: resuming never risks a duplicate paid
 * submission (`submitOrResumePass` structurally cannot resubmit while
 * `existingProviderRequest` is set), so exhausting attempts here can only
 * ever mean "we could not read back a result Topaz may already have
 * finished and billed" — a case worth trying harder on before concluding
 * it is unrecoverable, but still a FINITE, bounded number of independent
 * external reclaim cycles, never an unlimited loop.
 *
 * 5, not an unbounded/very large number: each individual claim ALREADY
 * gets its own bounded local retry inside the provider itself (3
 * attempts per download call, `TopazTransparencyUpscaleProvider`'s
 * `downloadAttempts` — "Fix Topaz Resume/Download Failure"), so 5 separate
 * claims already means up to 15 total download attempts across
 * independent worker reclaims before this ceiling is reached — enough to
 * absorb several distinct infrastructure incidents without becoming an
 * unbounded retry loop.
 */
export const MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS = 5;

/**
 * "Separate Provider Recovery Attempt Budget": which of the two ceilings
 * above applies to a given claim, decided ONCE, from persisted provider
 * state and the CURRENTLY configured provider's identity — never from a
 * customer/UI assumption. `"fresh_execution"` means this claim could still
 * result in a brand-new paid submission; `"resume"` means a valid,
 * matching, already-paid provider request exists and this claim can only
 * ever poll/download it.
 */
export type FinalArtworkAttemptClassification = "fresh_execution" | "resume";

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
  /**
   * Print-Ready Lifecycle Phase: the supported way to correct a project
   * whose `PrintProject.status` says `"print_ready"` but whose current,
   * authoritative Signs production plan no longer matches the plan the
   * ready asset was actually built/validated from — see this function's
   * own implementation doc (`reconcileSignPrintReadyStatus`) for the exact
   * generalized supersession rule. A no-op, safe to call repeatedly/on any
   * schedule, whenever the project is not currently `print_ready` or its
   * ready asset's plan is still current — never creates a job, never
   * touches an asset or a validation record, never rewrites history: the
   * ONLY possible side effect is one `PrintProject.status` transition to
   * `"finalization_required"`, mirroring the SAME exclusive authority this
   * capability already has over setting `"print_ready"` in the first
   * place (see `maybeTransitionProjectStatus`) — this is that authority's
   * other direction, never a scattered/UI-level status write.
   */
  reconcileSignPrintReadyStatus(
    projectId: string,
  ): Promise<SignPrintReadyReconciliationResult>;
}

/**
 * Print-Ready Lifecycle Phase: the outcome of one
 * `reconcileSignPrintReadyStatus` call. `invalidated: false` covers every
 * "nothing to do" case (not print_ready, not a Signs project, or the ready
 * asset's plan is still genuinely current) as well as the couldn't-decide
 * case — `reason` always says which.
 */
export interface SignPrintReadyReconciliationResult {
  invalidated: boolean;
  reason: string;
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
  /**
   * Print'em All Phase 2: the halftone screen's own measured geometry, when
   * one was applied. `null` for every continuous-tone plate — and for a
   * halftone plate persisted by an older build, which is then honestly
   * re-validated without screen evidence (and correctly refused by
   * `halftone_treatment`) rather than being credited with a screen nobody
   * recorded.
   */
  halftone: HalftoneProductionEvidence | null;
  /**
   * DTF Feature Integrity Phase 1: the production plate's measured feature
   * geometry, when it was measured. `null` for a halftone plate (Section 14
   * of this phase's plan — a dot lattice is not continuous-tone stroke/gap
   * geometry), for a plate whose bytes could not be decoded/measured, or for
   * a production asset persisted before this phase existed.
   */
  dtfFeatureIntegrity: DtfFeatureIntegritySummary | null;
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
  /**
   * Signs Phase S4.2A.1: the deterministic + semantic preservation-
   * verification boundary. Defaults to a real capability wired to
   * `resolveSignPreservationSemanticProvider()` — which
   * `isAutomatedTestEnvironment()` unconditionally forces to the safe,
   * network-free `PlaceholderSignPreservationSemanticProvider` regardless
   * of ambient configuration, exactly like every other resolver in this
   * codebase. Injected (not merely constructed inline where it's used) so
   * a test can supply a `FakeSignPreservationSemanticProvider`-backed
   * capability and observe its dispatch count. Deliberately the LAST
   * parameter — every existing positional caller (up to and including
   * `localNormalizationProvider`) keeps its exact same argument meaning;
   * only a caller that already passed a 7th argument would collide, and
   * none does.
   */
  signPreservation: SignPreservationCapability = createSignPreservationCapability(
    repo,
    assets,
    resolveSignPreservationSemanticProvider(undefined, repo),
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
   * Sprint A2 Correction 2 (Goal 6) — THE STALE-INTENT FENCE.
   *
   * Does this job's immutable bound intent still match what the project is
   * currently asking for? Called immediately before any provider dispatch
   * and again immediately before any project status transition, because
   * those are the two moments where a job stops being a computation and
   * starts costing money or making a claim to the customer.
   *
   * Returns `true` when the job is still answering the current question.
   *
   * ---------------------------------------------------------------------
   * Print'em All Phase 1 (Goal 12): PHYSICAL SIZE IS PART OF THE QUESTION.
   *
   * This fence previously compared requested OUTPUT only. That left the
   * larger of the two ways a job goes stale wide open: a job enqueued for a
   * 10.5in plate would sail straight through it after the operator confirmed
   * 12in, dispatch to a paid provider, and produce a perfectly good file at a
   * size nobody wanted. The reverse (12in queued, 10.5in confirmed) was just
   * as unguarded.
   *
   * Two conditions now have to hold, and both are checked against the
   * project's CONFIRMED authority rather than its working intent:
   *
   *   1. the project still has a confirmed production size at all — a
   *      withdrawn confirmation makes every queued job stale, so a job can
   *      never outlive the consent that authorized it; and
   *   2. that confirmed size is the size this job was bound to at enqueue.
   *
   * An unconfirmed project therefore matches NOTHING, which is the correct
   * fail-closed direction for a fence whose entire job is to stand in front
   * of a paid provider call.
   */
  async function jobIntentIsCurrent(job: FinalArtworkJob): Promise<boolean> {
    // Signs Phase S2: a sign job's intent is entirely captured by its
    // (sign preparation, plan key) binding — none of the apparel checks
    // below (requested output, production width, treatment) have any
    // meaning for it, and every field they read is null on a sign job.
    if (job.sourceKind === "sign_preparation") {
      return isSignPreparationJobStillCurrent(job);
    }
    const snapshot = await repo.getProject(job.projectId);
    if (!snapshot) return false;
    if (
      !productionIntentMatches(
        job.requestedProductionOutput,
        snapshot.brief.requestedProductionOutput,
      )
    ) {
      return false;
    }

    // A legacy job carries no bound width (it predates width binding), so
    // there is no size to disagree about and this check abstains rather than
    // failing it. Such a job cannot be dispatched to a provider by this build
    // anyway — every enqueue path now binds a confirmed width — so abstaining
    // affects only the status-transition call site, where it is what keeps an
    // already-completed historical plate resolvable (Goal 21).
    if (job.productionWidthIn === null) return true;

    // Print'em All Phase 2: the production TREATMENT is the third bound
    // intent, and it changes far more often than the other two — an operator
    // adjusting LPI or angle while a job is queued is ordinary work, not an
    // edge case. Without this the queued job would run and produce a plate
    // under settings nobody currently wants, and (because the plate is
    // otherwise perfectly valid) announce it as print-ready.
    if (
      !treatmentKeyMatchesJob(
        currentProductionTreatmentKey(snapshot.brief),
        job.productionTreatmentKey,
      )
    ) {
      return false;
    }

    return confirmedSizeMatchesJobWidth(
      resolveProductionSizeConfirmation(snapshot.brief),
      job.productionWidthIn,
    );
  }

  /**
   * Sprint A2 Correction 2 (Goal 6): retires a job whose bound intent no
   * longer matches the project's current request.
   *
   * `"cancelled"`, deliberately, and never `"failed"`: nothing failed. The
   * customer changed their mind, which is allowed, and `"failed"` is the
   * one status the customer-facing view reads as a retryable infrastructure
   * problem — surfacing "something went wrong, try again" for a job the
   * system itself set aside would be a lie about our own behavior.
   *
   * The job is not deleted. It remains historical evidence for the intent it
   * was created for, and if the customer comes back to that intent it is
   * re-queued rather than redone (see `createJobToleratingRace`) — which is
   * what keeps an already-paid-for reconstruction from being paid for twice.
   */
  async function supersedeStaleJob(job: FinalArtworkJob): Promise<void> {
    await repo.updateFinalArtworkJob(job.id, {
      status: "cancelled",
      lastError:
        "Superseded: the project's confirmed production size, requested production output, or production treatment changed after this job was enqueued. No provider work was performed for the superseded intent.",
      completedAt: new Date().toISOString(),
    });
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
   *
   * Sprint A2 Correction 2 (Goal 7): the same reasoning now covers a change
   * of REQUESTED OUTPUT, not just of approved direction. A PNG job that
   * finishes after the customer asked for separations produced a perfectly
   * good plate — for a question nobody is asking any more — and must not
   * announce `print_ready` for it. The plate is kept; the claim is not made.
   */
  async function maybeTransitionProjectStatus(
    job: FinalArtworkJob,
    status: "print_ready" | "finalization_required",
  ): Promise<void> {
    if (!(await jobIntentIsCurrent(job))) return;
    if (job.sourceKind === "sign_preparation") {
      await repo.setProjectStatus(job.projectId, status);
      return;
    }
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

    // Print'em All Phase 1: the width comparison moved into
    // `jobIntentIsCurrent`, which every caller of this function has already
    // passed, and now reads the CONFIRMED authority rather than the working
    // brief's resolved default. Keeping a second, differently-sourced copy
    // here is how the two would eventually disagree.
    return true;
  }

  /**
   * Signs Phase S2: the sign workflow's equivalent of
   * `isPreparedUploadJobStillCurrent`. A sign job stops being current when
   * its preparation is gone, or — the sign-specific case — when it was
   * RE-PLANNED: `SignPreparation.planKey` no longer equals the plan key
   * this job was enqueued for. A re-plan is a different deliverable, and
   * the newer plan's own job (if any) owns the project status from that
   * point on; this job's already-produced plate, if any, remains valid
   * evidence for the plan it was actually made under.
   */
  async function isSignPreparationJobStillCurrent(
    job: FinalArtworkJob,
  ): Promise<boolean> {
    if (!job.signPreparationId || !job.signPlanKey) return false;
    const preparation = await repo.getSignPreparationById(job.signPreparationId);
    return (
      !!preparation &&
      preparation.projectId === job.projectId &&
      preparation.status === "planned" &&
      preparation.planKey === job.signPlanKey
    );
  }

  /**
   * Phase 28T: this idempotency guard predates Phase 28T — its whole
   * purpose is "a worker crash/retry after the asset was already produced
   * must never reprocess" — but "an asset already exists for this job" and
   * "that asset still answers the CURRENT effective request" are different
   * facts. Without `targetIn`, reusing a job whose confirmed envelope
   * changed (Phase 28S's own fix, or a future size picker) would silently
   * re-serve the STALE plate forever, since this function runs BEFORE the
   * provider is ever consulted — `resolvePreparedUploadJob`'s revival
   * (`final-artwork-capability.ts`) would correctly set the job back to
   * `queued`, only for THIS guard to immediately short-circuit it back to
   * "ready" with the old asset, undoing the revival's entire intent.
   *
   * `targetIn === null` (the create_new path, which does not yet compute
   * one — seePhase 28T's own report) preserves EXACTLY the pre-Phase-28T
   * behavior: the first matching asset, trusted unconditionally.
   */
  async function resolveExistingProductionAsset(
    job: FinalArtworkJob,
    targetIn: EffectiveProductionTargetIn | null,
  ): Promise<AssetRecord | null> {
    const existingAssets = await repo.listAssets(job.projectId);
    const candidates = existingAssets.filter(
      (asset) =>
        asset.finalArtworkJobId === job.id &&
        asset.productionRole === "production_png" &&
        // Phase 28V: a two-pass reconstruction's PASS 1 output is an
        // internal reconstruction-stage artifact, never a candidate
        // final deliverable — see `resolveExistingIntermediateReconstruction`.
        !isReconstructionIntermediateAsset(asset),
    );
    if (candidates.length === 0) return null;
    if (!targetIn) return candidates[0]!;
    return candidates.find((asset) => productionAssetMatchesEffectiveTarget(asset, targetIn)) ?? null;
  }

  /**
   * Phase 28V (Section 7/8) — the durable proof that a two-pass
   * reconstruction's PASS 1 already completed for this exact job, if any.
   * Reused across attempts so pass 1 is NEVER resubmitted once its output
   * is durably stored: `produceProductionAsset` passes this to the active
   * provider as `existingIntermediateReconstruction`, and a provider that
   * recognizes it treats pass 1 as already done.
   */
  async function resolveExistingIntermediateReconstruction(
    job: FinalArtworkJob,
  ): Promise<{ asset: AssetRecord; providerRequestId: string } | null> {
    const existingAssets = await repo.listAssets(job.projectId);
    const candidate = existingAssets.find(
      (asset) =>
        asset.finalArtworkJobId === job.id &&
        asset.productionRole === "production_png" &&
        isReconstructionIntermediateAsset(asset),
    );
    if (!candidate) return null;
    const meta = candidate.metadata as Record<string, unknown> | null | undefined;
    const providerRequestId = typeof meta?.providerRequestId === "string" ? meta.providerRequestId : null;
    // Defensive: a malformed/legacy row with the marker but no recorded
    // request id carries no audit value and cannot be trusted as proof of
    // a specific paid submission — treated as though it does not exist
    // (never as license to resubmit pass 1 blindly; see the caller).
    if (!providerRequestId) return null;
    return { asset: candidate, providerRequestId };
  }

  /**
   * Phase 28V (Section 8/9) — durably stores a validated PASS 1
   * reconstruction as an internal, non-customer-facing asset, then retires
   * pass 1's identity from the job's single outstanding-request slot so it
   * is unambiguously free for pass 2's own fresh submission.
   *
   * Idempotent: re-running this for a pass whose intermediate was already
   * persisted (a crash landed between the upload below and the column
   * clear below) never uploads a second copy — it just (re-)clears the
   * columns, which is itself a no-op once already cleared.
   */
  async function persistIntermediateReconstruction(
    job: FinalArtworkJob,
    activeProvider: FinalArtworkProvider,
    storageGroupingId: string,
    result: FinalArtworkProviderIntermediateReconstruction,
  ): Promise<void> {
    const existing = await resolveExistingIntermediateReconstruction(job);
    if (!existing || existing.providerRequestId !== result.providerRequestId) {
      await assets.uploadProductionAsset(job.projectId, {
        conceptId: storageGroupingId,
        bytes: result.bytes,
        contentType: "image/png",
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        // Best-effort only — this is never the validated customer
        // deliverable and never runs through print validation.
        hasTransparency: true,
        finalArtworkJobId: job.id,
        productionRole: "production_png",
        metadata: {
          reconstructionStage: RECONSTRUCTION_INTERMEDIATE_STAGE_MARKER,
          providerKey: activeProvider.providerKey,
          providerRequestId: result.providerRequestId,
        },
      });
    }
    // Section 8: pass 1's identity now lives durably on the intermediate
    // asset's own metadata for audit — free the job's single
    // outstanding-request slot for pass 2's fresh submission.
    await repo.updateFinalArtworkJob(job.id, {
      providerKey: null,
      providerRequestId: null,
      providerStatus: null,
    });
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
      meta.resolutionProvenance === "reconstructed" ||
      meta.resolutionProvenance === "halftone_generated"
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
      halftone: readHalftoneEvidence(meta.halftone),
      dtfFeatureIntegrity: readDtfFeatureIntegritySummary(meta.featureIntegrity),
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
    /**
     * Phase 28T: the artwork's CURRENT effective resolved size, when known
     * — see `resolveExistingProductionAsset`'s doc comment. `null` for
     * callers that do not yet compute one (preserves exactly the
     * pre-Phase-28T "trust the first existing asset" behavior).
     */
    targetIn: EffectiveProductionTargetIn | null;
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

    const existing = await resolveExistingProductionAsset(job, params.targetIn);
    if (existing) {
      return {
        status: "ready",
        productionAsset: existing,
        provenance: provenanceFromExistingAsset(existing, sizing),
        providerLatencyMs: null,
      };
    }

    // --- Phase 28V (Section 7/8): does a two-pass reconstruction's PASS 1
    // already durably exist for this job? If so, it must never be
    // resubmitted, and the job's single outstanding-request slot — if it
    // still (harmlessly) points at pass 1's now-retired identity because a
    // crash landed between persisting the intermediate and clearing this
    // slot — is self-healed here, BEFORE it could be mistaken for an
    // in-flight pass 2 request.
    //
    // "Separate Provider Recovery Attempt Budget": moved above the
    // attempt-budget check below (and above the source-bytes download) —
    // classifying this claim requires knowing the CURRENT provider-request
    // identity, and that classification must happen before either budget
    // is charged. Neither this call nor the self-heal it may perform reads
    // `source`, so nothing here changes what a fresh-execution-exhausted
    // claim costs: it still fails before any asset bytes are read.
    const existingIntermediate = await resolveExistingIntermediateReconstruction(job);
    let effectiveJob = job;
    if (
      existingIntermediate &&
      effectiveJob.providerRequestId !== null &&
      effectiveJob.providerRequestId === existingIntermediate.providerRequestId
    ) {
      await repo.updateFinalArtworkJob(job.id, {
        providerKey: null,
        providerRequestId: null,
        providerStatus: null,
        // A cleared identity has no recovery history of its own — the next
        // real provider request (pass 2's fresh submission) starts its own
        // recovery budget at zero, exactly like a brand-new job would.
        providerRecoveryAttempts: 0,
      });
      effectiveJob = {
        ...effectiveJob,
        providerKey: null,
        providerRequestId: null,
        providerStatus: null,
        providerRecoveryAttempts: 0,
      };
    }

    // --- "Separate Provider Recovery Attempt Budget" (Phase 2/3): classify
    // THIS claim before enforcing either ceiling. Reuses EXACTLY the
    // identity check `submitOrResumePass` itself performs
    // (`providerKey` match + a non-null `providerRequestId`) — never a
    // second, possibly-disagreeing determination of "is this resumable."
    // `providerRequestId` is a column on THIS job row, never shared across
    // jobs/operations, so it can only ever refer to either this job's
    // single-pass request or (after the self-heal above clears a retired
    // pass 1 identity) its pass 2 request — never a stale request for a
    // different operation. A configured-provider change between attempts
    // (`effectiveJob.providerKey !== activeProvider.providerKey`) is
    // therefore ALSO correctly classified as "fresh": resuming against a
    // provider no longer configured would not be a safe recovery.
    const existingProviderRequest: FinalArtworkProviderResumeContext | null =
      effectiveJob.providerKey === activeProvider.providerKey && effectiveJob.providerRequestId
        ? {
            providerKey: effectiveJob.providerKey,
            providerRequestId: effectiveJob.providerRequestId,
            providerStatus: effectiveJob.providerStatus,
          }
        : null;
    const attemptClassification: FinalArtworkAttemptClassification = existingProviderRequest
      ? "resume"
      : "fresh_execution";

    if (attemptClassification === "fresh_execution") {
      // UNCHANGED from before this phase: a claim that could still result
      // in a brand-new paid submission stays bound by the original,
      // finite fresh-execution budget.
      if (job.attempts > MAX_FINAL_ARTWORK_ATTEMPTS) {
        logFinalArtworkAttemptBudgetExhausted({
          projectId: job.projectId,
          finalArtworkJobId: job.id,
          attempts: job.attempts,
          classification: attemptClassification,
          providerKey: activeProvider.providerKey,
          hasProviderRequestId: false,
          freshExecutionBudget: { used: job.attempts, max: MAX_FINAL_ARTWORK_ATTEMPTS },
          recoveryBudget: null,
        });
        await failJob(
          job,
          `Exceeded maximum finalization attempts (${MAX_FINAL_ARTWORK_ATTEMPTS}) after repeated recovery.`,
        );
        return { status: "handled" };
      }
    } else {
      // A valid, matching paid provider request already exists — this
      // claim can only poll/download it, never submit a new one (enforced
      // structurally by `submitOrResumePass`, unmodified). Bounded by its
      // OWN, separate, finite ceiling so infrastructure/readback failures
      // against already-paid work never exhaust — and are never blocked
      // by — the fresh-execution budget above, while still never becoming
      // an unbounded retry loop.
      if (effectiveJob.providerRecoveryAttempts >= MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS) {
        logFinalArtworkAttemptBudgetExhausted({
          projectId: job.projectId,
          finalArtworkJobId: job.id,
          attempts: job.attempts,
          classification: attemptClassification,
          providerKey: activeProvider.providerKey,
          hasProviderRequestId: true,
          freshExecutionBudget: null,
          recoveryBudget: {
            used: effectiveJob.providerRecoveryAttempts,
            max: MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS,
          },
        });
        await failJob(
          job,
          `This reconstruction's existing paid provider request could not be recovered after ${MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS} attempts. ` +
            "It was never resubmitted -- the paid request itself may need manual attention.",
        );
        return { status: "handled" };
      }
      // Charged BEFORE the resume is actually attempted — mirrors
      // `claimNextQueuedFinalArtworkJob`'s own "spend the budget unit at
      // the moment of committing to try" discipline, so a crash mid-resume
      // still counts against this ceiling on the next reclaim rather than
      // granting an extra free attempt.
      const nextRecoveryAttempts = effectiveJob.providerRecoveryAttempts + 1;
      await repo.updateFinalArtworkJob(job.id, { providerRecoveryAttempts: nextRecoveryAttempts });
      effectiveJob = { ...effectiveJob, providerRecoveryAttempts: nextRecoveryAttempts };
    }

    const source = await assets.downloadAssetBytes(sourceAsset.id);
    if (!source) {
      await failJob(job, params.missingSourceBytesReason);
      return { status: "handled" };
    }

    let existingIntermediateReconstruction: FinalArtworkProviderIntermediateReconstruction | null = null;
    if (existingIntermediate) {
      const intermediateBytes = await assets.downloadAssetBytes(existingIntermediate.asset.id);
      if (
        !intermediateBytes ||
        existingIntermediate.asset.widthPx === null ||
        existingIntermediate.asset.heightPx === null
      ) {
        // Section 8: proof that pass 1 was paid for and completed exists,
        // but its bytes cannot currently be read back — never silently
        // resubmit pass 1 to paper over that (would duplicate a paid
        // call). An honest infrastructure failure, retryable once storage
        // is healthy again.
        await failJob(
          job,
          "A previously completed first-pass reconstruction could not be read back from storage.",
        );
        return { status: "handled" };
      }
      existingIntermediateReconstruction = {
        bytes: intermediateBytes.bytes,
        widthPx: existingIntermediate.asset.widthPx,
        heightPx: existingIntermediate.asset.heightPx,
        providerRequestId: existingIntermediate.providerRequestId,
      };
    }

    let submittedNewPaidRequest = false;
    // "Fix Topaz Resume/Download Failure" Phase 4: tracked purely for
    // observability on the failure path below — the job's OWN persisted
    // `providerRequestId` is already updated durably by
    // `onProviderRequestSubmitted` itself; this local mirror just avoids a
    // redundant re-read of the job row solely to log what this attempt
    // already knows.
    let currentProviderRequestId = existingProviderRequest?.providerRequestId ?? null;
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
            currentProviderRequestId = providerRequestId;
            // Persisted BEFORE the provider polls/downloads anything
            // further — the entire point of this hook (Goal 3): a crash
            // any time after this write is resumable without a second
            // paid submission.
            await repo.updateFinalArtworkJob(job.id, {
              providerKey: activeProvider.providerKey,
              providerRequestId,
              providerStatus: "submitted",
              // "Separate Provider Recovery Attempt Budget": a genuinely
              // NEW paid request has no recovery history against it yet.
              // Belt-and-suspenders — every path that sets a NEW
              // `providerRequestId` here should already have reset this to
              // `0` when the OLD one was last cleared, but this claim is
              // the one place that actually SPENDS the new request's
              // future recovery budget, so it is asserted explicitly here
              // too.
              providerRecoveryAttempts: 0,
            });
          },
          existingIntermediateReconstruction,
          onIntermediateReconstructionProduced: (result) =>
            persistIntermediateReconstruction(job, activeProvider, params.storageGroupingId, result),
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
          // A provably dead request carries no recovery budget forward —
          // whatever fresh request a future attempt submits starts its own
          // recovery accounting at zero.
          providerRecoveryAttempts: 0,
        });
      }

      // Phase 27M: `TopazTransparencyUpscaleProvider.produce()` raises
      // exactly this shape (`invalid_request` + `not_dispatched`) for a
      // request it can honestly never fulfil — the source lacks enough real
      // pixels for the confirmed physical size, or has no visible artwork at
      // all (`resolveReconstructionRequest`'s `insufficient_reconstruction` /
      // `no_visible_artwork`). Nothing left this process and nothing was
      // billed, but the more important fact is durable, not transient: THIS
      // source cannot satisfy THIS confirmed size, and it never will on an
      // unchanged retry. `failJob` (the fallback below) leaves
      // `PrintProject.status` at `"finalizing"`, which `toCustomerFinalizationView`
      // reads as `retryable_failure` — a false promise that clicking "Retry
      // Preparation" again could succeed. `completeWithoutAsset` is the
      // existing, correct verdict for exactly this shape of conclusion
      // ("nothing crashed, the truth is simply this cannot be auto-finalized")
      // and is what every other genuine print-readiness verdict in this file
      // already uses — this was the one dispatch failure that fell through to
      // the generic infrastructure-failure path instead.
      if (
        error instanceof ProviderError &&
        error.classification === "invalid_request" &&
        error.dispatch === "not_dispatched"
      ) {
        // Phase 28T.1: this is the ONE throw site in the codebase for this
        // exact classification+dispatch shape — reached only when
        // `resolveReconstructionRequest` refuses (`insufficient_reconstruction`
        // / `no_visible_artwork`), i.e. exactly the case
        // `describeVariantAttentionReason`/`classifyVariantAttentionKind`
        // already call "deterministic_enhancement". Tagging the persisted
        // message lets the read side (`resolveOneProductionVariant`) surface
        // that existing, already-safe explanation instead of `null` — see
        // `attachAttentionCheckName` in `production-variant.ts`.
        await completeWithoutAsset(
          job,
          attachAttentionCheckName(error.message, "reconstruction_sufficiency"),
        );
        return { status: "handled" };
      }

      // "Fix Topaz Resume/Download Failure" Phase 4: the live incident this
      // fix exists for was "nearly invisible" — persisted as `failed` while
      // the terminal showed an unrelated batch progressing. Logged BEFORE
      // `failJob` so the failure is visible the instant it happens, using
      // only whitelisted, non-secret fields (see
      // `logFinalArtworkProviderFailure`'s own doc comment).
      logFinalArtworkProviderFailure({
        projectId: job.projectId,
        finalArtworkJobId: job.id,
        providerKey: activeProvider.providerKey,
        providerRequestId: currentProviderRequestId,
        stage: error instanceof ProviderError ? (error.stage ?? null) : null,
        sanitizedError: describeFinalArtworkError(error),
        submittedNewPaidRequest,
        attemptedResume: existingProviderRequest !== null,
      });
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

    // --- DTF Feature Integrity Phase 1 --------------------------------------
    // Measured against the FINAL production raster — `output.bytes` is the
    // exact PNG the customer will download, already post-reconstruction and
    // post-normalization (Section 15 of this phase's plan: source pixels are
    // never authoritative here, only the produced plate is). Skipped for a
    // halftone plate (`output.halftone` present): its dot lattice is not
    // continuous-tone stroke/gap geometry, and applying this analysis to it
    // would misclassify every legitimate halftone dot as a defect (Section
    // 14). A measurement failure is diagnostic-only and must never fail an
    // otherwise-successful production job — it simply leaves the four
    // `dtf_*` Print Validation checks unemitted for this asset, exactly as
    // they are for any plate produced before this phase existed.
    const dtfFeatureIntegrity = output.halftone
      ? null
      : measureDtfFeatureIntegrity(output.bytes, output.normalization);

    // --- DTF Coverage Intelligence (Phase 2A) -------------------------------
    // Unlike Feature Integrity, coverage measurement applies to BOTH
    // standard-raster and halftone plates (Section 18 of this phase's
    // plan) — it asks an orthogonal question ("how much continuous ink does
    // reproducing this actually require?") that is equally meaningful for
    // either representation, never a claim about the halftone dot lattice's
    // geometric validity (that remains `halftone_screen_geometry`'s job).
    // Diagnostic-only in this phase: no check, no decision, and no
    // raster-vs-halftone recommendation consumes this yet (Section 19/25) —
    // it is persisted purely as a foundation for a later phase.
    const dtfCoverage = measureDtfCoverageForPlate(output.bytes, output.normalization);

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
          // Print'em All Phase 2: the screen travels WITH the plate for the
          // same reason the normalization geometry does — a recovered or
          // retried attempt must re-validate the same deliverable against the
          // same recorded evidence, and a physical print six months from now
          // must be explainable from the asset alone.
          halftone: (output.halftone ?? null) as unknown as Record<string, unknown> | null,
          // DTF Feature Integrity Phase 1: the summary (never the full,
          // per-pixel measurement), so a recovered/retried attempt
          // re-validates against the same recorded evidence rather than
          // re-decoding and re-measuring the plate — same rationale as
          // `normalization`/`halftone` above.
          featureIntegrity: dtfFeatureIntegrity as unknown as Record<string, unknown> | null,
          // DTF Coverage Intelligence (Phase 2A): same rationale as
          // `featureIntegrity` above — persisted so a recovered/retried
          // attempt never re-decodes and re-measures the plate. `null` only
          // on a decode/measurement failure, which (like feature integrity)
          // is diagnostic-only and never fails the job.
          dtfCoverage: dtfCoverage as unknown as Record<string, unknown> | null,
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
        halftone: toHalftoneEvidence(output.halftone ?? null),
        dtfFeatureIntegrity,
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
    // Signs Phase S2/S3A: an entirely separate run path, reusing only the
    // generic worker infrastructure (claim/heartbeat/recovery,
    // `AssetCapability`, `PrintValidationCapability`) and — for a plan
    // requiring bounded reconstruction (S3A) — the injected provider's own
    // `produceSignReconstruction` — never `produceProductionAsset`/
    // `decideEnhancement`/`FinalArtworkProvider.produce()`, which are shaped
    // around alpha-trim, `PlacementSizingPolicy`, and DTF-specific concerns
    // a rigid sign does not have.
    if (job.sourceKind === "sign_preparation") {
      await runSignPreparationJob(job);
      return;
    }
    if (job.sourceKind === "prepared_upload") {
      await runPreparedUploadJob(job);
      return;
    }
    await runGeneratedConceptJob(job);
  }

  function requireStepPixelParam(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
      ? value
      : null;
  }

  /**
   * Signs Phase S3A: dispatches the persisted `reconstruct_resolution` step
   * against the CONFIGURED provider, then replays the plan's remaining
   * deterministic steps against the provider's output.
   *
   * Reuses the EXACT apparel paid-call idempotency machinery — the same
   * `resolveExistingIntermediateReconstruction`/`persistIntermediateReconstruction`
   * pair Phase 28V's two-pass apparel reconstruction uses (both already
   * job-generic, never apparel-specific), and the same
   * `MAX_FINAL_ARTWORK_ATTEMPTS`/`MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS`
   * fresh-execution/resume attempt classification `produceProductionAsset`
   * enforces for apparel. A sign job has no two-pass concept — the provider
   * call here is a single bounded pass, full stop — so once its output is
   * durably persisted as an intermediate asset, nothing further ever calls
   * the provider again for this job; the "free the outstanding-request
   * slot" step still runs (via `persistIntermediateReconstruction`) purely
   * for consistency with the apparel pattern this mirrors.
   *
   * Returns `{ outcome: "handled" }` once it has already written a terminal
   * job state (a zero-cost pre-dispatch refusal, an attempt-budget
   * exhaustion, or an infrastructure failure) — the caller simply returns.
   */
  async function runSignReconstructionAndContinue(
    job: FinalArtworkJob,
    plan: SignRepairPlan,
    split: { before: SignRepairStep[]; reconstruct: SignRepairStep; after: SignRepairStep[] },
    sourceImage: RgbaImage,
  ): Promise<
    | { outcome: "handled" }
    | {
        outcome: "executed";
        image: RgbaImage;
        contentBounds: SignExecutionBounds;
        resolutionProvenance: "reconstructed";
        providerKey: string;
        providerRequestId: string;
        nativeWidthPx: number;
        nativeHeightPx: number;
        reconstructedWidthPx: number;
        reconstructedHeightPx: number;
        /**
         * Signs Phase S3C: true when the admitted reconstruction diverged
         * from the plan's own `requestedWidthPx`/`requestedHeightPx` and the
         * geometry-stage step's pixel amounts (never its axis/colour) were
         * re-derived from the ACTUAL reconstruction to still exactly reach
         * the ordered aspect ratio — see `adaptGeometryStepsToActualReconstruction`.
         */
        geometryAdapted: boolean;
        /**
         * Signs Phase S3C review follow-up: the explicit, self-contained
         * audit record of what actually executed when `geometryAdapted` is
         * true — `null` otherwise (the approved plan's own recorded step
         * already is the complete, truthful record in that case). Never
         * authorizes anything; see `SignExecutionGeometryEvidence`'s own doc.
         */
        executionGeometry: SignExecutionGeometryEvidence | null;
        /**
         * Signs Phase S3D: the explicit, self-contained audit record of a
         * bounded alpha-only canonicalization applied to the reconstructed
         * raster BEFORE any geometry adaptation or opacity check ran —
         * `null` unless the admission conditions were met AND at least one
         * pixel actually needed correcting (`normalizeProviderAlphaOnVerifiedOpaqueSource`).
         * Never authorizes anything a plan didn't already require (an
         * opaque rigid-sign deliverable) — it only restores the source's
         * own proven invariant after the reconstruction provider broke it.
         */
        providerAlphaNormalization: ProviderAlphaNormalizationEvidence | null;
      }
  > {
    // --- Verify the persisted step's own parameters before anything else
    // touches a pixel or a network call (S3A: "Before dispatch verify...
    // reconstruct step parameters, requested scale, expected reconstruction
    // geometry"). A malformed/missing param can only mean tampering or a
    // planner/schema mismatch this build does not recognize — refused,
    // zero provider calls, exactly like every other plan-identity mismatch
    // this job already fails closed on above.
    const requestedScale = split.reconstruct.params.requestedScale;
    const requestedWidthPx = requireStepPixelParam(split.reconstruct.params.requestedWidthPx);
    const requestedHeightPx = requireStepPixelParam(split.reconstruct.params.requestedHeightPx);
    if (
      typeof requestedScale !== "number" ||
      !Number.isFinite(requestedScale) ||
      requestedScale < 1 ||
      requestedWidthPx === null ||
      requestedHeightPx === null
    ) {
      await completeWithoutAsset(
        job,
        "The recorded reconstruction step's parameters are missing or malformed — refused before any provider dispatch.",
      );
      return { outcome: "handled" };
    }
    if (requestedWidthPx > MAX_RECONSTRUCTION_DIM_PX || requestedHeightPx > MAX_RECONSTRUCTION_DIM_PX) {
      await completeWithoutAsset(
        job,
        `The recorded reconstruction step requests ${requestedWidthPx}x${requestedHeightPx}px, beyond the ` +
          `${MAX_RECONSTRUCTION_DIM_PX}px defensive dimension bound — refused before any provider dispatch.`,
      );
      return { outcome: "handled" };
    }

    // --- Local steps preceding reconstruction (e.g. a review-gated
    // `rotate_90`) run FIRST, on the untouched source — the provider must
    // see exactly the geometry the planner's own srcW/srcH assumed.
    const preReconstruct = executeAdmittedSignSteps(
      sourceImage,
      { x: 0, y: 0, width: sourceImage.width, height: sourceImage.height },
      split.before,
    );
    if (preReconstruct.status === "refused") {
      await completeWithoutAsset(job, preReconstruct.detail);
      return { outcome: "handled" };
    }
    const preImage = preReconstruct.image;

    // --- Pre-dispatch provider-ceiling re-check, before the provider is
    // ever consulted (S3A: "requestedScale <= provider maximum ... A
    // rejected reconstruction MUST cost zero provider calls"). Mirrors
    // `assertWithinProviderScaleCeiling`'s own formula exactly — the
    // provider re-asserts this too, but this layer refuses without ever
    // constructing a provider request at all.
    const maxWidth = preImage.width * SIGN_RECONSTRUCTION_SCALE_CEILING;
    const maxHeight = preImage.height * SIGN_RECONSTRUCTION_SCALE_CEILING;
    if (requestedWidthPx > maxWidth + 1 || requestedHeightPx > maxHeight + 1) {
      await completeWithoutAsset(
        job,
        `The recorded reconstruction step requests ${requestedWidthPx}x${requestedHeightPx}px, beyond the ` +
          `${SIGN_RECONSTRUCTION_SCALE_CEILING}x maximum this reconstruction provider can deliver for a ` +
          `${preImage.width}x${preImage.height}px source — refused before any provider dispatch.`,
      );
      return { outcome: "handled" };
    }

    if (!hasSignReconstructionCapability(provider)) {
      await failJob(job, "The configured final-artwork provider does not support sign reconstruction.");
      return { outcome: "handled" };
    }
    const signProvider = provider;

    // --- Self-heal: a two-pass-style intermediate already durably exists
    // from a prior attempt at THIS exact job (a crash landed between
    // persisting it and clearing the job's outstanding-request slot) —
    // mirrors `produceProductionAsset`'s own Section 7/8 self-heal exactly.
    const existingIntermediate = await resolveExistingIntermediateReconstruction(job);
    let effectiveJob = job;
    if (
      existingIntermediate &&
      effectiveJob.providerRequestId !== null &&
      effectiveJob.providerRequestId === existingIntermediate.providerRequestId
    ) {
      await repo.updateFinalArtworkJob(job.id, {
        providerKey: null,
        providerRequestId: null,
        providerStatus: null,
        providerRecoveryAttempts: 0,
      });
      effectiveJob = {
        ...effectiveJob,
        providerKey: null,
        providerRequestId: null,
        providerStatus: null,
        providerRecoveryAttempts: 0,
      };
    }

    let reconstructedBytes: Buffer;
    let reconstructedWidthPx: number;
    let reconstructedHeightPx: number;
    let providerRequestId: string;

    if (existingIntermediate) {
      // Durable proof this exact job's single reconstruction pass already
      // completed and was paid for — never resubmitted.
      const bytesRead = await assets.downloadAssetBytes(existingIntermediate.asset.id);
      if (
        !bytesRead ||
        existingIntermediate.asset.widthPx === null ||
        existingIntermediate.asset.heightPx === null
      ) {
        await failJob(
          job,
          "A previously completed sign reconstruction could not be read back from storage.",
        );
        return { outcome: "handled" };
      }
      reconstructedBytes = bytesRead.bytes;
      reconstructedWidthPx = existingIntermediate.asset.widthPx;
      reconstructedHeightPx = existingIntermediate.asset.heightPx;
      providerRequestId = existingIntermediate.providerRequestId;
    } else {
      // "Separate Provider Recovery Attempt Budget" — classify THIS claim
      // exactly as `produceProductionAsset` does for apparel, reusing the
      // identical two ceilings so a sign reconstruction can never become an
      // unbounded retry loop, paid or unpaid.
      const existingProviderRequest: FinalArtworkProviderResumeContext | null =
        effectiveJob.providerKey === signProvider.providerKey && effectiveJob.providerRequestId
          ? {
              providerKey: effectiveJob.providerKey,
              providerRequestId: effectiveJob.providerRequestId,
              providerStatus: effectiveJob.providerStatus,
            }
          : null;
      const attemptClassification: FinalArtworkAttemptClassification = existingProviderRequest
        ? "resume"
        : "fresh_execution";

      if (attemptClassification === "fresh_execution") {
        if (job.attempts > MAX_FINAL_ARTWORK_ATTEMPTS) {
          await failJob(
            job,
            `Exceeded maximum finalization attempts (${MAX_FINAL_ARTWORK_ATTEMPTS}) after repeated recovery.`,
          );
          return { outcome: "handled" };
        }
      } else {
        if (effectiveJob.providerRecoveryAttempts >= MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS) {
          await failJob(
            job,
            `This reconstruction's existing paid provider request could not be recovered after ${MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS} attempts. ` +
              "It was never resubmitted -- the paid request itself may need manual attention.",
          );
          return { outcome: "handled" };
        }
        const nextRecoveryAttempts = effectiveJob.providerRecoveryAttempts + 1;
        await repo.updateFinalArtworkJob(job.id, { providerRecoveryAttempts: nextRecoveryAttempts });
        effectiveJob = { ...effectiveJob, providerRecoveryAttempts: nextRecoveryAttempts };
      }

      let output: SignReconstructionProviderOutput;
      try {
        output = await signProvider.produceSignReconstruction({
          sourceBytes: encodeSignPlate(preImage),
          sourceContentType: "image/png",
          requestedWidthPx,
          requestedHeightPx,
          existingProviderRequest,
          onProviderRequestSubmitted: async (submittedProviderRequestId) => {
            // Persisted BEFORE polling begins — a crash any time after this
            // write is resumable without a second paid submission.
            await repo.updateFinalArtworkJob(job.id, {
              providerKey: signProvider.providerKey,
              providerRequestId: submittedProviderRequestId,
              providerStatus: "submitted",
              providerRecoveryAttempts: 0,
            });
          },
        });
      } catch (error) {
        if (error instanceof ProviderError && error.classification === "provider_job_failed") {
          await repo.updateFinalArtworkJob(job.id, {
            providerKey: null,
            providerRequestId: null,
            providerStatus: null,
            providerRecoveryAttempts: 0,
          });
        }
        if (
          error instanceof ProviderError &&
          error.classification === "invalid_request" &&
          error.dispatch === "not_dispatched"
        ) {
          await completeWithoutAsset(job, error.message);
          return { outcome: "handled" };
        }
        await failJob(job, describeFinalArtworkError(error));
        return { outcome: "handled" };
      }

      // --- RESULT DIMENSION VALIDATION (S3A): the provider's paid output is
      // never blindly trusted. Decoded and geometry-checked BEFORE it is
      // persisted as an intermediate or replayed further — an invalid
      // response must never be written down as though it were a good
      // reconstruction (a future recovery attempt trusts a persisted
      // intermediate unconditionally, so poisoning it here would be
      // permanent). Reuses `validateReconstructedGeometry` UNCHANGED — the
      // exact sufficiency + proportional-aspect contract (Phase 28R) the
      // apparel path already relies on, never a second, possibly-disagreeing
      // tolerance.
      let decodedOutput: PNG;
      try {
        decodedOutput = PNG.sync.read(output.bytes);
      } catch (error) {
        await failJob(
          job,
          `The production reconstruction provider returned bytes that could not be decoded as a PNG: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { outcome: "handled" };
      }
      const geometryCheck = validateReconstructedGeometry({
        sourceWidthPx: preImage.width,
        sourceHeightPx: preImage.height,
        targetWidthPx: requestedWidthPx,
        targetHeightPx: requestedHeightPx,
        actualWidthPx: decodedOutput.width,
        actualHeightPx: decodedOutput.height,
      });
      if (!geometryCheck.valid) {
        await failJob(job, geometryCheck.reason);
        return { outcome: "handled" };
      }

      reconstructedBytes = output.bytes;
      // The DECODED raster's own dimensions, never a provider-claimed
      // `widthPx`/`heightPx` that might disagree with the bytes actually
      // returned — mirrors the geometry check just above, which validates
      // the same decoded dimensions.
      reconstructedWidthPx = decodedOutput.width;
      reconstructedHeightPx = decodedOutput.height;
      providerRequestId = output.providerRequestId;

      // Persisted BEFORE deterministic continuation — mirrors
      // `onIntermediateReconstructionProduced`'s own "persist before
      // continuing" ordering: a crash any time after this write never
      // re-spends this paid credit.
      await persistIntermediateReconstruction(job, signProvider, `sign-${job.id}`, {
        bytes: reconstructedBytes,
        widthPx: reconstructedWidthPx,
        heightPx: reconstructedHeightPx,
        providerRequestId,
      });
    }

    let reconstructedPng: PNG;
    try {
      reconstructedPng = PNG.sync.read(reconstructedBytes);
    } catch (error) {
      await failJob(
        job,
        `The reconstructed sign raster could not be decoded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { outcome: "handled" };
    }
    let reconstructedImage: RgbaImage = {
      width: reconstructedPng.width,
      height: reconstructedPng.height,
      data: reconstructedPng.data,
    };

    // --- S3D: a real Topaz reconstruction can come back with an alpha
    // channel that is not uniformly 255 even when the exact bytes fed to
    // it (`preImage`) were just proven fully opaque — the real S3B Ruth
    // acceptance run's forensic audit found this is a genuine provider
    // encode/edge-padding artifact (RGB intact, alpha off), never a sign of
    // missing/garbage colour data. Bounded, alpha-only, dimension-preserving
    // canonicalization — restores the SOURCE's own proven invariant, never
    // customer-approved creative geometry, so it runs before geometry
    // adaptation and needs no repair-plan involvement at all. A source that
    // itself carries transparency is never touched here — see the module's
    // own admission-condition doc.
    const alphaNormalization = normalizeProviderAlphaOnVerifiedOpaqueSource(preImage, reconstructedImage);
    reconstructedImage = alphaNormalization.image;

    // --- S3C: the plan's OWN geometry-stage step(s) assumed the
    // reconstruction would return exactly `requestedWidthPx`x`requestedHeightPx`
    // — the real S3B Ruth acceptance run proved a real provider can honestly
    // return more than requested (Topaz's own proven 4x ceiling,
    // proportionally). Re-derive the approved step's pixel amounts from the
    // ACTUAL reconstruction when it diverges; axis/colour/every other
    // approved parameter is carried over unchanged, and a plan requiring an
    // axis change or an unapproved extension refuses rather than adapting.
    const adaptation = adaptGeometryStepsToActualReconstruction(
      split.after,
      reconstructedImage.width,
      reconstructedImage.height,
      requestedWidthPx,
      requestedHeightPx,
      plan.orderedWidthIn,
      plan.orderedHeightIn,
      plan.expectedOutputWidthPx,
      plan.expectedOutputHeightPx,
    );
    if (adaptation.status === "refused") {
      await completeWithoutAsset(job, adaptation.detail);
      return { outcome: "handled" };
    }

    const continued = executeAdmittedSignSteps(
      reconstructedImage,
      { x: 0, y: 0, width: reconstructedImage.width, height: reconstructedImage.height },
      adaptation.steps,
    );
    if (continued.status === "refused") {
      await completeWithoutAsset(job, continued.detail);
      return { outcome: "handled" };
    }
    const finalized = finalizeSignExecution(
      continued.image,
      continued.contentBounds,
      adaptation.expectedOutputWidthPx,
      adaptation.expectedOutputHeightPx,
    );
    if (finalized.status === "refused") {
      await completeWithoutAsset(job, finalized.detail);
      return { outcome: "handled" };
    }

    return {
      outcome: "executed",
      image: finalized.image,
      contentBounds: finalized.contentBounds,
      resolutionProvenance: "reconstructed",
      providerKey: signProvider.providerKey,
      providerRequestId,
      nativeWidthPx: preImage.width,
      nativeHeightPx: preImage.height,
      reconstructedWidthPx,
      reconstructedHeightPx,
      geometryAdapted: adaptation.status === "adapted",
      executionGeometry: buildSignExecutionGeometryEvidence(
        adaptation,
        requestedWidthPx,
        requestedHeightPx,
        reconstructedImage.width,
        reconstructedImage.height,
      ),
      providerAlphaNormalization: alphaNormalization.evidence,
    };
  }

  /**
   * Signs Phase S2: claims and runs one `sign_preparation` job. Entirely
   * self-contained — reuses only the generic worker infrastructure the
   * function signature already closes over (`repo`, `assets`,
   * `printValidation`, `withPeriodicHeartbeat`, `failJob`,
   * `completeWithoutAsset`, `maybeTransitionProjectStatus`).
   *
   * PLAN REPLAY DISCIPLINE, in order, every one fail-closed:
   *   1. the preparation exists, is project-scoped, and is `"planned"`
   *   2. the stale-intent fence: the preparation's CURRENT plan key still
   *      equals this job's bound plan key (else superseded — cancelled,
   *      never failed)
   *   3. the plan's canonical key is RECOMPUTED from the currently
   *      persisted plan fields and matches both the preparation's own
   *      `planKey` and the job's bound `signPlanKey`
   *   4. the original asset's downloaded bytes hash to `plan.sourceSha256`
   *      and decode to `plan.sourceWidthPx`/`plan.sourceHeightPx`
   *   5. `plan.orderedWidthIn`/`orderedHeightIn`/`policyId` match the
   *      preparation's own current confirmed spec
   *   6. the plan's schema version is one this build supports
   *
   * Any mismatch anywhere above completes the job honestly, with no asset,
   * `finalization_required` — never a fabricated result and never a crash.
   *
   * S2 executes only S2-admitted deterministic steps
   * (`sign-preparation/sign-transform-executor.ts`). A plan containing
   * `approved_crop` remains refused before any pixel is touched —
   * `approved_crop` stays approval-gated, with no approval mechanism yet
   * (Constitution §16A.3). Signs Phase S3A: a plan whose ONLY non-admitted
   * step is exactly one `reconstruct_resolution` is no longer refused —
   * `runSignReconstructionAndContinue` dispatches it against the bounded
   * production provider (reusing the apparel paid-call idempotency
   * machinery unmodified) and replays the plan's remaining S2-admitted
   * steps against the provider's output. The resulting asset's
   * `resolutionProvenance` is honestly `"reconstructed"`, which
   * `validateRigidSign`'s print_ready gate independently and unconditionally
   * refuses — no reconstructed sign becomes `print_ready` until a future
   * phase (S4) adds preservation verification to justify it.
   */
  async function runSignPreparationJob(job: FinalArtworkJob): Promise<void> {
    if (!job.signPreparationId || !job.signPlanKey) {
      await failJob(job, "This sign finalization job records no sign preparation.");
      return;
    }
    const preparation = await repo.getSignPreparationById(job.signPreparationId);
    if (!preparation || preparation.projectId !== job.projectId) {
      await failJob(job, "Referenced sign preparation no longer exists.");
      return;
    }
    if (preparation.status !== "planned" || !preparation.plan || !preparation.planKey) {
      await failJob(job, "Referenced sign preparation has no persisted plan.");
      return;
    }

    // Stale-intent fence, before anything else: the preparation may have
    // been re-planned since this job was enqueued.
    if (preparation.planKey !== job.signPlanKey) {
      await supersedeStaleJob(job);
      return;
    }

    const plan = preparation.plan as unknown as SignRepairPlan;
    if (plan.schemaVersion !== SIGN_REPAIR_PLAN_SCHEMA_VERSION) {
      await completeWithoutAsset(
        job,
        `Recorded plan schema "${plan.schemaVersion}" is not supported by this build.`,
      );
      return;
    }

    // RECOMPUTE the canonical plan key from the currently persisted plan
    // fields — never trust the stored `plan.planKey` string alone. This is
    // the authoritative check; `requestSignFinalArtwork`'s own recompute is
    // the earlier, non-authoritative belt.
    const recomputedPlanKey = computeSignPlanKey(plan);
    const planKeyVerified =
      recomputedPlanKey === preparation.planKey &&
      recomputedPlanKey === job.signPlanKey &&
      recomputedPlanKey === plan.planKey;
    if (!planKeyVerified) {
      await completeWithoutAsset(
        job,
        "The recorded repair plan failed identity verification and was not executed.",
      );
      return;
    }

    if (
      plan.orderedWidthIn !== preparation.orderedWidthIn ||
      plan.orderedHeightIn !== preparation.orderedHeightIn ||
      plan.policyId !== preparation.resolutionPolicyId
    ) {
      await completeWithoutAsset(
        job,
        "The recorded plan's ordered size or policy no longer matches the preparation's confirmed spec.",
      );
      return;
    }

    const containsOnlyAdmittedSteps = planContainsOnlyAdmittedSteps(plan);
    const needsReconstruction = planRequiresBoundedReconstruction(plan);
    const reconstructionSplit = needsReconstruction ? splitPlanAroundReconstruction(plan) : null;
    // Semantic Worker Wiring Phase: the GENERALIZED question — see
    // `planRequiresSemanticPreservationVerification`'s own doc. Distinct
    // from `needsReconstruction`: every `needsReconstruction` plan also
    // needs semantic verification, but `reconstruct_perimeter_structure`
    // needs it WITHOUT needing `needsReconstruction` (no Topaz dispatch).
    const needsSemanticVerification = planRequiresSemanticPreservationVerification(plan);

    // Idempotent asset reuse — mirrors the apparel paths' own idempotency
    // guarantee (Goal 16): a worker crash/retry after the asset was already
    // produced must never reprocess. Reuses the shared, generic resolver
    // (Signs Phase S3A) so a sign job's own reconstruction-stage
    // intermediate asset (see `resolveExistingIntermediateReconstruction`)
    // is never mistaken for the final deliverable — exactly the same
    // exclusion the apparel two-pass path already depends on.
    let productionAsset: AssetRecord | null = await resolveExistingProductionAsset(job, null);

    let sourceSha256 = "";
    let contentBoundsWithinOutput = false;
    let contentBoundsReason = "";
    let resolutionProvenance: "native" | "reconstructed" = "native";
    let signProviderKey: string | null = null;
    let signProviderRequestId: string | null = null;
    let signNativeWidthPx: number | null = null;
    let signNativeHeightPx: number | null = null;
    let signReconstructedWidthPx: number | null = null;
    let signReconstructedHeightPx: number | null = null;
    let signGeometryAdapted = false;
    let signExecutionGeometry: SignExecutionGeometryEvidence | null = null;
    let signProviderAlphaNormalization: ProviderAlphaNormalizationEvidence | null = null;

    if (!productionAsset) {
      if (!needsReconstruction && !containsOnlyAdmittedSteps) {
        // A genuinely unsupported plan shape (e.g. `approved_crop`, which
        // remains approval-gated with no approval mechanism yet) — refused
        // before any pixel is touched, before the source is even
        // downloaded, and before any provider could be dispatched.
        const forbidden = plan.steps.find(
          (step) => step.kind === "reconstruct_resolution" || step.kind === "approved_crop",
        );
        await completeWithoutAsset(
          job,
          forbidden
            ? "Plan requires an approved crop. approved_crop remains approval-gated and is not part of automatic execution."
            : "Plan contains a step kind outside the admitted execution vocabulary.",
        );
        return;
      }

      const result = await withPeriodicHeartbeat(job.id, async () => {
        const downloaded = await assets.downloadAssetBytes(preparation.originalAssetId);
        if (!downloaded) {
          return { outcome: "no_source" as const };
        }
        let decoded: ReturnType<typeof decodePngUpload>;
        try {
          decoded = decodePngUpload(downloaded.bytes);
        } catch {
          return { outcome: "undecodable" as const };
        }
        const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");

        // Source lineage: the exact bytes this plan was formulated against,
        // never assumed.
        if (
          sha256 !== plan.sourceSha256 ||
          decoded.image.width !== plan.sourceWidthPx ||
          decoded.image.height !== plan.sourceHeightPx
        ) {
          return { outcome: "source_mismatch" as const };
        }

        if (needsReconstruction && reconstructionSplit) {
          const reconstruction = await runSignReconstructionAndContinue(
            job,
            plan,
            reconstructionSplit,
            decoded.image,
          );
          if (reconstruction.outcome === "handled") {
            return { outcome: "handled" as const };
          }
          return {
            outcome: "executed" as const,
            sha256,
            image: reconstruction.image,
            contentBounds: reconstruction.contentBounds,
            resolutionProvenance: reconstruction.resolutionProvenance,
            providerKey: reconstruction.providerKey,
            providerRequestId: reconstruction.providerRequestId,
            nativeWidthPx: reconstruction.nativeWidthPx,
            nativeHeightPx: reconstruction.nativeHeightPx,
            reconstructedWidthPx: reconstruction.reconstructedWidthPx,
            reconstructedHeightPx: reconstruction.reconstructedHeightPx,
            geometryAdapted: reconstruction.geometryAdapted,
            executionGeometry: reconstruction.executionGeometry,
            providerAlphaNormalization: reconstruction.providerAlphaNormalization,
          };
        }

        const execution = executeSignRepairPlan(decoded.image, plan);
        if (execution.status === "refused") {
          return { outcome: "refused" as const, detail: execution.detail };
        }

        return {
          outcome: "executed" as const,
          sha256,
          image: execution.image,
          contentBounds: execution.contentBounds,
          resolutionProvenance: "native" as const,
          providerKey: null,
          providerRequestId: null,
          nativeWidthPx: null,
          nativeHeightPx: null,
          reconstructedWidthPx: null,
          reconstructedHeightPx: null,
          geometryAdapted: false,
          executionGeometry: null,
          providerAlphaNormalization: null,
        };
      });

      if (result.outcome === "handled") {
        // `runSignReconstructionAndContinue` already wrote a terminal job
        // state (a zero-cost pre-dispatch refusal, an attempt-budget
        // exhaustion, or an infrastructure failure) — nothing left to do.
        return;
      }

      if (result.outcome !== "executed") {
        const reason =
          result.outcome === "no_source"
            ? "The original artwork file could not be loaded."
            : result.outcome === "undecodable"
              ? "The original artwork file could not be decoded."
              : result.outcome === "source_mismatch"
                ? "The original artwork no longer matches the bytes this plan was formulated against."
                : result.detail;
        await completeWithoutAsset(job, reason);
        return;
      }

      sourceSha256 = result.sha256;
      const image = result.image;
      const bounds = result.contentBounds;
      contentBoundsWithinOutput =
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= image.width &&
        bounds.y + bounds.height <= image.height;
      contentBoundsReason = contentBoundsWithinOutput
        ? `Original content occupies [${bounds.x},${bounds.y},${bounds.width}x${bounds.height}] within a ${image.width}x${image.height}px plate — fully inside bounds, with every added region outside it.`
        : `Original content bounds [${bounds.x},${bounds.y},${bounds.width}x${bounds.height}] do not lie fully within the ${image.width}x${image.height}px plate.`;
      resolutionProvenance = result.resolutionProvenance;
      signProviderKey = result.providerKey;
      signProviderRequestId = result.providerRequestId;
      signNativeWidthPx = result.nativeWidthPx;
      signNativeHeightPx = result.nativeHeightPx;
      signReconstructedWidthPx = result.reconstructedWidthPx;
      signReconstructedHeightPx = result.reconstructedHeightPx;
      signGeometryAdapted = result.geometryAdapted;
      signExecutionGeometry = result.executionGeometry;
      signProviderAlphaNormalization = result.providerAlphaNormalization;

      const achievedPpi = image.width / plan.orderedWidthIn;
      const pngBytes = withPhysicalPixelDensity(
        encodeSignPlate(image),
        pixelsPerMetreForPpi(achievedPpi),
      );

      productionAsset = await assets.uploadProductionAsset(job.projectId, {
        conceptId: `sign-${job.id}`,
        bytes: pngBytes,
        contentType: "image/png",
        widthPx: image.width,
        heightPx: image.height,
        hasTransparency: hasAnyTransparentPixel(image),
        finalArtworkJobId: job.id,
        productionRole: "production_png",
        metadata: {
          rigidSign: {
            sourceAssetId: preparation.originalAssetId,
            sourceSha256,
            planKey: plan.planKey,
            planSchemaVersion: plan.schemaVersion,
            policyId: plan.policyId,
            planOverallRisk: plan.overallRisk,
            containsOnlyAdmittedSteps,
            orderedWidthIn: plan.orderedWidthIn,
            orderedHeightIn: plan.orderedHeightIn,
            contentBoundsWithinOutput,
            contentBoundsReason,
            // Signs Phase S3A: truthful reconstruction lineage — `"native"`/
            // `null` for every plan S2 alone can satisfy, unchanged from
            // before this phase.
            resolutionProvenance,
            providerKey: signProviderKey,
            providerRequestId: signProviderRequestId,
            nativeWidthPx: signNativeWidthPx,
            nativeHeightPx: signNativeHeightPx,
            reconstructedWidthPx: signReconstructedWidthPx,
            reconstructedHeightPx: signReconstructedHeightPx,
            // Signs Phase S3C: true only when the admitted reconstruction
            // diverged from the plan's own requested reconstruction size
            // and the geometry-stage step's pixel amounts were re-derived
            // (axis/colour unchanged) to still exactly reach the ordered
            // aspect — auditable without cross-referencing the plan's own
            // `reconstruct_resolution` params against these dimensions by
            // hand.
            geometryAdapted: signGeometryAdapted,
            // Signs Phase S3C review follow-up: the explicit, self-contained
            // DERIVED EXECUTION GEOMETRY record — the approved plan (fetched
            // via `planKey`, never mutated, still recording 153px/153px for
            // the real Ruth case) remains the sole approval/audit authority
            // for what was semantically permitted; this is separate
            // PRODUCTION PROVENANCE recording what actually executed when
            // the two diverge. `null` whenever `geometryAdapted` is false —
            // the plan's own recorded step already is the complete record
            // in that case.
            executionGeometry: signExecutionGeometry,
            // Signs Phase S3D: PRODUCTION PROVENANCE for a bounded,
            // alpha-only canonicalization applied to the reconstructed
            // raster when a real provider (Topaz) returned alpha bytes
            // that were not uniformly 255 despite a verified-fully-opaque
            // source — `null` whenever nothing needed correcting or the
            // source itself was never proven opaque. RGB is never
            // recorded as modified because it never is; this never
            // authorizes anything the plan's own opaque-output
            // requirement did not already require.
            providerAlphaNormalization: signProviderAlphaNormalization,
          },
        },
      });
    } else {
      // Recovered/retried job with an asset already on file — recompute
      // the same evidence from the recorded metadata rather than
      // re-executing (Goal 16's idempotency guarantee).
      const recorded = (productionAsset.metadata as Record<string, unknown> | null)
        ?.rigidSign as Record<string, unknown> | undefined;
      sourceSha256 = typeof recorded?.sourceSha256 === "string" ? recorded.sourceSha256 : plan.sourceSha256;
      contentBoundsWithinOutput = recorded?.contentBoundsWithinOutput === true;
      contentBoundsReason =
        typeof recorded?.contentBoundsReason === "string"
          ? recorded.contentBoundsReason
          : "Recovered from a prior attempt's recorded evidence.";
      resolutionProvenance = recorded?.resolutionProvenance === "reconstructed" ? "reconstructed" : "native";
      signProviderKey = typeof recorded?.providerKey === "string" ? recorded.providerKey : null;
      signProviderRequestId = typeof recorded?.providerRequestId === "string" ? recorded.providerRequestId : null;
      signNativeWidthPx = typeof recorded?.nativeWidthPx === "number" ? recorded.nativeWidthPx : null;
      signNativeHeightPx = typeof recorded?.nativeHeightPx === "number" ? recorded.nativeHeightPx : null;
      signReconstructedWidthPx =
        typeof recorded?.reconstructedWidthPx === "number" ? recorded.reconstructedWidthPx : null;
      signReconstructedHeightPx =
        typeof recorded?.reconstructedHeightPx === "number" ? recorded.reconstructedHeightPx : null;
      signGeometryAdapted = recorded?.geometryAdapted === true;
      signExecutionGeometry =
        recorded?.executionGeometry && typeof recorded.executionGeometry === "object"
          ? (recorded.executionGeometry as SignExecutionGeometryEvidence)
          : null;
      signProviderAlphaNormalization =
        recorded?.providerAlphaNormalization && typeof recorded.providerAlphaNormalization === "object"
          ? (recorded.providerAlphaNormalization as ProviderAlphaNormalizationEvidence)
          : null;
    }

    // --- Signs Phase S4.2A.1 / Semantic Worker Wiring Phase: deterministic
    // + semantic preservation verification — gated on `needsSemanticVerification`
    // (`planRequiresSemanticPreservationVerification`), NOT on
    // `resolutionProvenance === "reconstructed"`. That used to be the same
    // condition by coincidence (the only plan shape needing verification
    // was also the only one a provider ever touched) — `reconstruct_
    // perimeter_structure` breaks that coincidence: it needs the identical
    // preservation question asked (did the reconstructed pixels' relationship
    // to the finished edge survive?) despite never involving a provider and
    // never setting `resolutionProvenance` to `"reconstructed"`.
    // `productionAsset` is stable and persisted by this point in BOTH
    // branches above (freshly uploaded or recovered from an existing
    // attempt), so its id is a valid, immutable binding target. Runs under
    // its own heartbeat (mirrors the reconstruction pass's own
    // `withPeriodicHeartbeat` above — a second, sequential use of the SAME
    // mechanism, never a second job system) because the deterministic
    // checks alone decode/compare full-resolution rasters and can take
    // several seconds at real sign scale.
    //
    // `verifyPreservation` is internally idempotent (Signs Phase S4.2A) —
    // a completed record already on file for this exact
    // (finalAssetId, combined verification identity) is reused, never
    // re-dispatched, so calling this unconditionally on every retry/
    // recovery of this job is always safe and cheap.
    //
    // A THROWN error means an INCOMPLETE provider attempt (timeout,
    // network, rate limit, malformed/schema-invalid response) or an
    // unresolvable identity — never silently swallowed, and never turned
    // into a fabricated "completed" verification. `failJob` is the correct
    // existing primitive (not `completeWithoutAsset`): this is a retryable
    // infrastructure failure, not a deterministic-forever refusal —
    // `FinalArtworkCapability`'s own existing revive-a-failed-job-to-queued
    // path lets a later invocation safely retry, and because nothing was
    // persisted under this identity, that retry may dispatch a fresh
    // semantic request. PrintValidation is never reached this attempt —
    // it must not certify readiness for an asset preservation verification
    // never actually completed.
    //
    // Whatever the COMPLETED preservation status is (`preserved`,
    // `changed`, or `unknown`) execution simply continues to
    // PrintValidation below, unconditionally — this worker never decides
    // readiness itself. LIVE PRODUCT BLOCKER #3B: PrintValidation IS now
    // taught to read this evidence (`validateRigidSign`'s
    // `preservationAuthorized` check) — the verification record and the
    // independently-resolved "current" algorithm identity are threaded
    // into `rigidSign` below so that check can bind them to this exact
    // asset/source/plan identity, never trusting a bare boolean.
    let signPreservationVerification: SignPreservationVerification | null = null;
    let expectedPreservationAlgorithmVersion = "";
    if (needsSemanticVerification) {
      try {
        // Resolved BEFORE the (possibly reused) verification call so this
        // value is always independent of whichever record comes back —
        // reading it off the record itself would make the identity check
        // in PrintValidation trivially circular.
        expectedPreservationAlgorithmVersion =
          signPreservation.resolveCurrentVerificationAlgorithmVersion();
        signPreservationVerification = await withPeriodicHeartbeat(job.id, () =>
          signPreservation.verifyPreservation(productionAsset.id),
        );
      } catch (error) {
        await failJob(
          job,
          `Preservation verification could not complete: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }

    const policy = getSignResolutionPolicyById(plan.policyId);
    if (!policy) {
      await completeWithoutAsset(
        job,
        `Resolution policy "${plan.policyId}" is not supported by this build.`,
      );
      return;
    }

    const requirements = deriveRigidSignProductionRequirements(
      {
        category: "rigid_sign_raster",
        orderedWidthIn: plan.orderedWidthIn,
        orderedHeightIn: plan.orderedHeightIn,
        confirmedAt: preparation.specConfirmedAt ?? new Date(0).toISOString(),
        resolutionPolicyId: plan.policyId,
      },
      policy,
    );

    // LIVE PRODUCT BLOCKER #4D: the raw facts behind a Signs Phase S3C
    // adaptive-geometry execution, for PrintValidation's OWN independent
    // re-verification — never a trusted "the adaptation was valid" claim.
    // Non-null ONLY when `signGeometryAdapted` is true (the ONE reason
    // `executedStepsMatchPlan` is allowed to be false and still admit a
    // second, evidence-based path to plan integrity).
    //
    // Production-Aware Perimeter Reconstruction Phase: `reconstruct_
    // perimeter_structure` is included here too — NOT for S3C adaptation
    // (that step never currently coexists with `reconstruct_resolution`,
    // so `signGeometryAdapted` is always false for it; see `sign-repair-
    // planner.ts`'s own scope-limiting guard), but because `substrateBoundary`
    // below reads THIS SAME variable's `axis` to know which edges were
    // extended. Omitting it here would silently make `edgeDependentStructure
    // OnAffectedEdge` read `false` for a plan that used the new step — the
    // one case the `substrate_boundary_semantics` backstop most needs to see.
    //
    // Parametric Frame Reconstruction Phase: `reconstruct_parametric_frame`
    // is included here for the SAME `substrateBoundary`/axis reason — AND,
    // unlike `reconstruct_perimeter_structure`, this step CAN genuinely
    // coexist with `reconstruct_resolution`, so `signGeometryAdapted` may
    // legitimately be true for it; `colorR/G/B/color` stay `null` for this
    // step (it has no single flat fill colour), the same null shape
    // `reconstruct_perimeter_structure` already produces here.
    const plannedGeometryStep = plan.steps.find(
      (step) =>
        step.kind === "extend_uniform_background" ||
        step.kind === "pad_uniform_background" ||
        step.kind === "reconstruct_perimeter_structure" ||
        step.kind === "reconstruct_parametric_frame",
    );
    const executedGeometryAdaptation: RigidSignPlanEvidence["executedGeometryAdaptation"] =
      signGeometryAdapted && signExecutionGeometry
        ? {
            reconstructionRequestedWidthPx: signExecutionGeometry.reconstructionRequestedWidthPx,
            reconstructionRequestedHeightPx: signExecutionGeometry.reconstructionRequestedHeightPx,
            reconstructionActualWidthPx: signExecutionGeometry.reconstructionActualWidthPx,
            reconstructionActualHeightPx: signExecutionGeometry.reconstructionActualHeightPx,
            plannedStep: plannedGeometryStep
              ? {
                  kind: plannedGeometryStep.kind,
                  axis: typeof plannedGeometryStep.params.axis === "string" ? plannedGeometryStep.params.axis : null,
                  colorR:
                    typeof plannedGeometryStep.params.colorR === "number" ? plannedGeometryStep.params.colorR : null,
                  colorG:
                    typeof plannedGeometryStep.params.colorG === "number" ? plannedGeometryStep.params.colorG : null,
                  colorB:
                    typeof plannedGeometryStep.params.colorB === "number" ? plannedGeometryStep.params.colorB : null,
                  color: typeof plannedGeometryStep.params.color === "string" ? plannedGeometryStep.params.color : null,
                }
              : null,
            executedStep: signExecutionGeometry.executedStep
              ? {
                  kind: signExecutionGeometry.executedStep.kind,
                  axis: signExecutionGeometry.executedStep.axis,
                  colorR: signExecutionGeometry.executedStep.colorR,
                  colorG: signExecutionGeometry.executedStep.colorG,
                  colorB: signExecutionGeometry.executedStep.colorB,
                  color: signExecutionGeometry.executedStep.color,
                }
              : null,
          }
        : null;

    // Signs Perimeter Safety Phase: re-derived independently from the
    // plate's own persisted evidence — NEVER trusted from the plan's own
    // defect list (planning may have a future bug; this is the backstop).
    // `plannedGeometryStep`'s axis is authoritative even under an S3C
    // adaptation — `axis` is one of the fields `RigidSignExecutedGeometry
    // AdaptationEvidence` already asserts must be IDENTICAL between the
    // planned and executed step.
    const persistedInspection = preparation.inspection as unknown as SignInspectionReport | null;
    const extendedEdges = affectedEdgesForAxis(
      typeof plannedGeometryStep?.params.axis === "string" ? plannedGeometryStep.params.axis : null,
    );
    const edgeDependentStructureOnAffectedEdge =
      extendedEdges !== null && persistedInspection !== null
        ? anyEdgeIsEdgeDependent(persistedInspection.edges, extendedEdges)
        : false;
    const semanticEvidence =
      signPreservationVerification?.semanticEvidence as SignPreservationSemanticEvidence | null | undefined;
    const perimeterAlignmentAnswer =
      semanticEvidence?.answers.find((answer) => answer.category === "perimeter_edge_alignment")?.answer ?? null;
    const substrateBoundary: RigidSignSubstrateBoundaryEvidence = {
      edgeDependentStructureOnAffectedEdge,
      perimeterAlignmentAnswer,
    };

    const rigidSign: RigidSignPlanEvidence = {
      sourceAssetId: preparation.originalAssetId,
      sourceSha256,
      planKey: plan.planKey,
      planSchemaVersion: plan.schemaVersion,
      policyId: plan.policyId,
      planKeyVerified,
      // Signs Phase S3C review follow-up: truthful, not hardcoded — when
      // `signGeometryAdapted` is true, the geometry-stage step actually
      // executed with different pixel amounts than the recorded plan's own
      // step (see `rigidSign.executionGeometry` on the asset metadata for
      // the explicit record). This value's own meaning is unchanged by
      // LIVE PRODUCT BLOCKER #4D — a genuine adaptation still makes it
      // `false`; `executedGeometryAdaptation` (below) is the SEPARATE,
      // independently-verified path that may still admit plan integrity
      // for exactly that case.
      executedStepsMatchPlan: !signGeometryAdapted,
      executedGeometryAdaptation,
      planOverallRisk: plan.overallRisk,
      containsOnlyAdmittedSteps,
      // LIVE PRODUCT BLOCKER #4B: the SAME `needsReconstruction` this
      // function already computed above to decide whether to dispatch
      // bounded reconstruction at all — never recomputed, never
      // independently re-derived by PrintValidation.
      planRequiresBoundedReconstruction: needsReconstruction,
      orderedWidthIn: plan.orderedWidthIn,
      orderedHeightIn: plan.orderedHeightIn,
      targetPpi: policy.targetPpi,
      minPpi: policy.minPpi,
      contentBoundsWithinOutput,
      contentBoundsReason,
      // LIVE PRODUCT BLOCKER #3B: threaded through so PrintValidation can
      // bind the preservation verification to THIS exact asset, never a
      // different one.
      finalAssetId: productionAsset.id,
      preservationVerification: signPreservationVerification
        ? {
            finalAssetId: signPreservationVerification.finalAssetId,
            sourceAssetId: signPreservationVerification.sourceAssetId,
            sourceSha256: signPreservationVerification.sourceSha256,
            planKey: signPreservationVerification.planKey,
            verificationAlgorithmVersion: signPreservationVerification.verificationAlgorithmVersion,
            status: signPreservationVerification.status,
          }
        : null,
      // Semantic Worker Wiring Phase: the SAME `needsSemanticVerification`
      // this function already computed above to decide whether to dispatch
      // preservation verification at all — never recomputed, never
      // independently re-derived by PrintValidation (mirrors
      // `planRequiresBoundedReconstruction` immediately above).
      planRequiresSemanticPreservationVerification: needsSemanticVerification,
      expectedPreservationAlgorithmVersion,
      // LIVE PRODUCT BLOCKER #4: the durable authorization for THIS
      // preparation, exactly as `requestSignFinalArtwork` already required
      // to exist (and bind to this exact plan) before it would ever
      // enqueue the job being executed right now — re-asserted here so
      // PrintValidation independently reaches the identical conclusion
      // rather than trusting that the enqueue gate was never bypassed.
      authorization:
        preparation.authorizedPlanKey && preparation.authorizedBy
          ? { planKey: preparation.authorizedPlanKey, authorizedBy: preparation.authorizedBy }
          : null,
      substrateBoundary,
    };

    const validationInput: PrintValidationInput = {
      artworkVersionId: preparation.id,
      validationProfile: "rigid_sign_raster",
      designBriefVersionId: null,
      currentApprovedDesignBriefVersionId: null,
      printPlacement: null,
      productSummary: null,
      designDescription: null,
      conceptEvaluationStatus: null,
      conceptEvaluation: null,
      primaryAsset: {
        contentType: productionAsset.contentType,
        widthPx: productionAsset.widthPx,
        heightPx: productionAsset.heightPx,
        hasTransparency: productionAsset.hasTransparency,
        vectorAssetId: null,
        // Signs Phase S3A: truthful per Constitution §16A.3 — `"reconstructed"`
        // only when this exact asset's pixels genuinely came from a bounded
        // provider reconstruction; the rigid-sign print_ready gate
        // (`validateRigidSign`) independently refuses readiness whenever this
        // is `"reconstructed"`, unchanged and unweakened by this phase.
        resolutionProvenance,
        nativeWidthPx: signNativeWidthPx,
        nativeHeightPx: signNativeHeightPx,
      },
      rigidSignRequirements: requirements,
      rigidSign,
    };

    const report = printValidation.validateArtwork(validationInput);
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

    await maybeTransitionProjectStatus(
      job,
      report.status === "ready" ? "print_ready" : "finalization_required",
    );
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

    // Sprint A2 Correction 2 (Goal 6): the stale-intent fence, placed here
    // for the same reason the eligibility gate above is — BEFORE any
    // provider call, local or paid. A job whose bound intent no longer
    // matches the project's current request must not spend a cent, and must
    // not produce a plate that would then be looking for a claim to make.
    if (!(await jobIntentIsCurrent(job))) {
      await supersedeStaleJob(job);
      return;
    }

    // Goal 4: the bounded apparel-placement policy already established by
    // `shared/print-placement-dimensions.ts` (full_front/full_back,
    // left_chest, sleeve) via `deriveProductionRequirements` — no new
    // universal assumption invented here.
    //
    // Print'em All Phase 1: the production WIDTH is the job's OWN bound
    // width, snapshotted at enqueue from the project's confirmed authority —
    // no longer the live working brief.
    //
    // Both halves of that matter. Reading the LIVE brief let a queued job
    // silently re-aim itself when the size changed underneath it, which is
    // the create_new twin of the bug the upload path was already immune to.
    // Reading a CONFIRMED value rather than a resolved one is what keeps a
    // placement default from ever reaching a provider: the fence above has
    // already established that a confirmation exists and that it names this
    // job's width, so from here the job acts only on what a human approved.
    //
    // Physical size remains a production specification, not creative content
    // — deliberately absent from `DesignBriefSnapshotContent`, so choosing 12
    // inches never supersedes an approved brief version, never restyles
    // artwork, and never marks a concept stale.
    //
    // Nothing about the size comes from the request that enqueued this job,
    // so a stale or forged finalize call cannot smuggle a different one in;
    // and nothing infers it from the pixels a generator happened to produce.
    const intendedPrintWidthIn = job.productionWidthIn;
    // Sprint A2 Correction 2: the JOB'S OWN bound intent, snapshotted at
    // enqueue — not the live working brief, which can move underneath a
    // running job. The fence above has already established that the two
    // agree; from here the job acts only on what it was created to satisfy.
    //
    // (Both A2 passes matter here. The first replaced regex-over-prose with
    // structured state; this one made that state job-bound, so a change
    // landing mid-flight supersedes the job instead of silently re-aiming it.)
    const requestedProductionOutput = job.requestedProductionOutput;
    const requirements = deriveProductionRequirements({
      printPlacement: briefVersion.content.printPlacement,
      productSummary: briefVersion.content.productSummary,
      designDescription: briefVersion.content.designDescription,
      intendedPrintWidthIn,
      requestedProductionOutput,
    });

    // Goal 17: Phase 2C supports raster apparel production only. An
    // unsupported method must never be silently marked print-ready.
    if (requirements.category !== "apparel_raster") {
      await completeWithoutAsset(job, unsupportedFinalizationReason(requirements));
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
      // Phase 28T: the create_new path does not yet compute an effective
      // target (its own artwork-bounds source is a separate, out-of-scope
      // concern this phase — see the Phase 28T report) — `null` preserves
      // this path's exact pre-Phase-28T behavior.
      targetIn: null,
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
      // Sprint A2: the same structured authority the category gate above
      // already applied. Threaded through so the persisted validation report
      // is self-describing and can never read `"ready"` for an artifact
      // nobody asked us to produce — defense in depth behind the gate, not
      // a second interpretation of it.
      requestedProductionOutput,
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
      dtfFeatureIntegrity: provenance.dtfFeatureIntegrity,
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
    // Sprint A2 Correction 2 (Goal 6 / Goal 17): the stale-intent fence, before
    // `measurePreparedSource` and `decideEnhancement` — i.e. before the upload
    // path's one genuinely expensive step. This is where a superseded upload
    // job would otherwise buy a Topaz reconstruction nobody wants.
    if (!(await jobIntentIsCurrent(job))) {
      await supersedeStaleJob(job);
      return;
    }

    const intendedPrintWidthIn = job.productionWidthIn;
    // Phase 28C: the confirmed BOX's height bound, read from the LIVE brief —
    // safe only because the stale-intent fence just above already proved
    // `snapshot.brief`'s current confirmed WIDTH agrees with this job's own
    // frozen `productionWidthIn`. `productionSizeConfirmedWidthIn` and
    // `productionSizeConfirmedMaxHeightIn` are always written together, in
    // one `confirmProductionSize` call (`confirmed-production-size.ts`), so a
    // width match is sufficient proof the height bound is the SAME
    // confirmation this job was created to satisfy — never a value from some
    // later, different confirmation. `null` (never confirmed, or a bare width
    // with no box) preserves exactly today's behavior in
    // `deriveProductionRequirements`.
    const sizeConfirmation = resolveProductionSizeConfirmation(snapshot.brief);
    const confirmedMaxHeightIn = sizeConfirmation.confirmed
      ? sizeConfirmation.size.boxMaxHeightIn
      : null;
    // Sprint A2 Correction 2: the job's OWN bound intent, exactly like the
    // width above — not the live working brief. The fence just above proved
    // the two agree; using the bound value from here on means nothing this
    // job does can be re-targeted by a change that lands mid-flight.
    const requirements = deriveProductionRequirements({
      printPlacement: snapshot.brief.printPlacement,
      productSummary: snapshot.brief.productSummary,
      designDescription: null,
      intendedPrintWidthIn,
      requestedProductionOutput: job.requestedProductionOutput,
      confirmedMaxHeightIn,
    });

    if (requirements.category !== "apparel_raster") {
      await completeWithoutAsset(job, unsupportedFinalizationReason(requirements));
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

    // --- Print'em All Phase 2 (Goal 25): THE TREATMENT DECISION, and its
    // position in this function is the economically important part.
    //
    // It is made HERE — before `decideEnhancement` chooses a provider and
    // therefore before any paid dispatch can occur. The artwork this treatment
    // exists to serve is precisely the artwork the reconstruction provider's
    // 4x ceiling refuses, so calling Topaz first and screening afterwards
    // would spend a credit manufacturing continuous-tone detail the screen
    // then discards. On this path the paid provider is not reached at all.
    //
    // The treatment comes from the JOB's frozen key, never the live brief: the
    // stale-intent fence above already proved the two agree, and reading the
    // brief again here would let settings that changed mid-flight reach a
    // plate the job was not authorized for.
    const treatment = resolveProductionTreatment(snapshot.brief);
    const halftone = treatment.treatment === "halftone_dtf" ? treatment.halftone : null;

    // Continuous-tone apparel raster requires real transparent pixels in the
    // prepared source. Trust the asset's measured `hasTransparency` (set from
    // actual pixels at preparation/finalize time). Without this fence, an
    // opaque prepared asset that still needs more pixels would reach paid
    // reconstruction before authoritative PrintValidation rejected the plate
    // for missing transparency. Halftone is a different representation that
    // generates its own transparent lattice, so it is not gated here.
    //
    // `null` is left to PrintValidation (legacy/unknown metadata) rather than
    // inventing a second readiness system at this boundary.
    if (
      !halftone &&
      requirements.transparencyRequired &&
      sourceAsset.hasTransparency === false
    ) {
      await completeWithoutAsset(
        job,
        "The prepared artwork has no transparent pixels. Apparel production needs a transparent background before a print-ready file can be created.",
      );
      return;
    }

    // Phase 28C: the artwork's OWN proportionally-contained target width —
    // never `sizing.targetWidthIn` (the box's raw nominal width) directly.
    // For a tall design whose HEIGHT controls (`resolveWidthConstrainedSizing`
    // narrows both axes together once the naive width-first height would
    // exceed the box), the artwork will actually print narrower than the
    // box's own width — e.g. 7.35in inside a 10.5x10.5 Standard Adult box —
    // so requiring `sourceVisibleWidthPx` to cover the FULL 10.5in
    // (3150px) overstates how many real pixels this artwork needs by the
    // same amount the plate itself is later corrected. Source and target
    // share one aspect ratio by construction, so checking the contained
    // WIDTH alone is equivalent to checking both axes.
    const contained = resolveWidthConstrainedSizing(
      sizing,
      measured.alphaBBoxWidthPx,
      measured.alphaBBoxHeightPx,
    );

    // Recorded either way, because the two questions are independent and only
    // one of them is about spend. `decideEnhancement` answers "would this
    // artwork have needed a paid reconstruction?" — worth knowing, and worth
    // logging, even on a path that will not buy one.
    const enhancement = decideEnhancement({
      sourceVisibleWidthPx: measured.alphaBBoxWidthPx,
      targetWidthIn: contained.widthIn,
      targetPpi: sizing.targetPpi,
    });

    // The one place the paid provider is chosen — or not.
    //
    // A halftone job never reaches it, whatever `decideEnhancement` concluded
    // (Goal 25). Otherwise, artwork that already carries the target's worth of
    // real pixels never reaches it either (Goal 15: one paid request per
    // idempotency key, and none at all when the pixels are already there).
    //
    // The halftone provider is constructed PER JOB from that job's own
    // settings rather than injected once, so a plate's screen can never come
    // from ambient process state — two concurrent jobs with different settings
    // are two providers, not one shared one being reconfigured.
    const activeProvider: FinalArtworkProvider = halftone
      ? new HalftoneDtfProvider(halftone)
      : enhancement.requiresReconstruction
        ? provider
        : localNormalizationProvider;

    // Phase 28I Section 9(I)/10: purely diagnostic — see
    // `logFinalArtworkEnhancementProviderGap`'s own doc comment. Fires only
    // when reconstruction is genuinely required AND the environment has no
    // real enhancement provider configured (or it was refused in test/dev
    // safety) — never when local normalization is the CORRECT choice
    // (`!enhancement.requiresReconstruction`).
    if (enhancement.requiresReconstruction && activeProvider.providerKey === "local_raster_interpolation") {
      logFinalArtworkEnhancementProviderGap({
        projectId: job.projectId,
        finalArtworkJobId: job.id,
        configuredProviderKey: activeProvider.providerKey,
        requiredScale: enhancement.coverageRatio > 0 ? 1 / enhancement.coverageRatio : Infinity,
      });
    }

    const uploadedPreserveMeta: UploadedPreserveMeta = {
      preparedArtworkVersionId: artwork.id,
      preparedAssetId: sourceAsset.id,
      originalAssetId: preparation.originalAssetId,
      sourceBytesSha256: measured.sha256,
      sourceAlphaBBoxWidthPx: measured.alphaBBoxWidthPx,
      sourceAlphaBBoxHeightPx: measured.alphaBBoxHeightPx,
      // Its own value, never folded into `"skipped"`. A screened plate did
      // not skip reconstruction because it did not need it — it took a
      // different representation entirely, and a record that cannot tell those
      // apart cannot explain why no credit was spent.
      enhancement: halftone ? "halftone_screened" : enhancement.method,
      enhancementReason: halftone
        ? `DTF halftone treatment: dot geometry generated at final production size, so no reconstruction was required. (Continuous-tone assessment, for reference: ${enhancement.reason})`
        : enhancement.reason,
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
      // Phase 28T: `contained` above is already this exact request's
      // effective resolved size, freshly measured from the REAL current
      // source bytes (even more precise than `final-artwork-capability.ts`'s
      // own cached-analysis-bounds version of the same computation) — reused
      // here rather than re-derived, so the crash-recovery short-circuit
      // above can tell a genuinely-current existing asset apart from a
      // stale one left over from before the confirmed envelope changed.
      targetIn: { widthIn: contained.widthIn, heightIn: contained.heightIn, targetPpi: sizing.targetPpi },
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
      // Sprint A2: see the Create New assembly above — same authority, same
      // defense-in-depth reasoning, same field.
      requestedProductionOutput: snapshot.brief.requestedProductionOutput,
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
      // Print'em All Phase 2: which representation this plate is, and the
      // screen's own account of itself. Both come from the PERSISTED plate
      // (via `provenance`), not from the settings this run happened to hold,
      // so a recovered attempt validates the deliverable that actually exists
      // rather than the one it was about to make.
      productionTreatment: treatment.treatment,
      halftone: provenance.halftone,
      dtfFeatureIntegrity: provenance.dtfFeatureIntegrity,
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
      // Phase 28V.1: neither check is EMITTED at all under the
      // uploaded_preserve profile ("the customer's own approved artwork is
      // the specification" — see `assembleUploadedPreserveProductionPrintValidationInput`'s
      // doc comment) — a deliberate, already-correct design, not a gap.
      // Logging that absence as "unknown" reads as an unresolved question
      // mark and is exactly what led a real investigation (project
      // 7bcc3e19-5617-4712-99ab-65f1667b5eda) to suspect these checks were
      // blocking finalization when the real, unrelated cause was
      // `checkMinimumRasterDimensions`'s own rounding bug (see that
      // function's own Phase 28V.1 fix). `not_applicable` for this profile
      // is honest instead: the question was never relevant, not merely
      // unanswered. `generated_concept` still logs a genuine `"unknown"`
      // when these checks are unexpectedly absent there — that WOULD be a
      // real anomaly worth investigating for that profile.
      requiredWordingVerification:
        report.checks.find((c) => c.check === "required_wording_verification")?.status ??
        (report.profile === "uploaded_preserve" ? "not_applicable" : "unknown"),
      conceptEvaluationAlignment:
        report.checks.find((c) => c.check === "concept_evaluation_alignment")?.status ??
        (report.profile === "uploaded_preserve" ? "not_applicable" : "unknown"),
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

  const capability: FinalArtworkWorkerCapability = {
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

    async reconcileSignPrintReadyStatus(projectId) {
      return reconcileSignPrintReadyStatus(projectId);
    },
  };

  /**
   * Print-Ready Lifecycle Phase: the supported mechanism for correcting a
   * project whose `PrintProject.status` says `"print_ready"` but whose
   * ready asset's own PLAN is no longer the preparation's current one —
   * the exact shape of the real false-positive incident this phase closes
   * (a plan superseded by re-planning, or re-planning that landed on
   * `"blocked"`, while the OLD ready asset/status were left untouched).
   *
   * THE GENERALIZED RULE: a `print_ready` project stays authoritative only
   * as long as its ready asset's own frozen plan identity
   * (`FinalArtworkJob.signPlanKey` — frozen at enqueue, exactly like
   * `productionTreatmentKey`) still equals the preparation's CURRENT
   * `planKey`. Any real reason the task's own scope names — a superseding
   * re-plan, planning landing on `"blocked"` (`planKey: null`), a changed
   * production spec, or a changed source — changes `planKey` by
   * construction (`computeSignPlanKey` is derived from exactly source +
   * spec + policy), so this ONE comparison is the generalized invariant
   * that subsumes all of them; nothing here special-cases any one reason.
   * ("Validation requirements change" — e.g. a future preservation-
   * prompt/model/schema revision — is a real, independent supersession
   * ground this function deliberately does NOT check: `ProductionAsset
   * Validation.report` does not currently echo back enough evidence to
   * decide it without either a broader report-shape change or a schema
   * addition, either a separate, deliberate decision outside this
   * phase's minimal-mechanism mandate.)
   *
   * NEVER rewrites history: the ready job, its production asset, its
   * `ProductionAssetValidation` row, its `SignPreservationVerification`
   * row (if any), and its authorization all remain exactly as they were —
   * a real, historical record of what WAS produced and WAS validated
   * under the plan that was current at the time. Only `PrintProject.status`
   * moves, and only in the direction print_ready → finalization_required
   * (this function never sets print_ready itself — that remains
   * exclusively `maybeTransitionProjectStatus`'s job, driven by a fresh,
   * successful validation run).
   *
   * IDEMPOTENT: the very first check (`project.status !== "print_ready"`)
   * makes every repeated call after the first a pure no-op — no job,
   * asset, or validation is ever created, read state is only ever
   * compared, and `repo.setProjectStatus` is called at most once per
   * actual transition.
   */
  async function reconcileSignPrintReadyStatus(
    projectId: string,
  ): Promise<SignPrintReadyReconciliationResult> {
    const snapshot = await repo.getProject(projectId);
    if (!snapshot) {
      return { invalidated: false, reason: "Project does not exist." };
    }
    if (snapshot.project.status !== "print_ready") {
      return {
        invalidated: false,
        reason: `Project is not currently print_ready (status: "${snapshot.project.status}") — nothing to reconcile.`,
      };
    }

    const preparation = await repo.getSignPreparation(projectId);
    if (!preparation) {
      // Not a Signs project at all — this operation only ever governs the
      // rigid-sign lifecycle; every other profile's print_ready lifecycle
      // is unaffected and untouched by this function.
      return { invalidated: false, reason: "No sign preparation exists for this project." };
    }

    const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation.id);
    const completedJobs = jobs
      .filter((job) => job.status === "completed" && job.completedAt !== null)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());

    // Find the most recently completed job whose OWN validation run
    // actually certified "ready" — never assumed from mere job completion.
    let readyJob: FinalArtworkJob | null = null;
    let readyValidation: Awaited<ReturnType<typeof repo.getLatestProductionAssetValidationForJob>> = null;
    for (const job of completedJobs) {
      const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
      if (validation && validation.status === "ready") {
        readyJob = job;
        readyValidation = validation;
        break;
      }
    }

    if (!readyJob || !readyValidation) {
      // The project claims print_ready, but no completed job's own
      // validation actually backs that up — fail closed exactly like
      // every other missing-evidence case in this codebase, rather than
      // trusting the bare status.
      await repo.setProjectStatus(projectId, "finalization_required");
      return {
        invalidated: true,
        reason: "print_ready is not backed by any completed job's own ready validation — invalidated.",
      };
    }

    if (readyJob.signPlanKey !== preparation.planKey) {
      await repo.setProjectStatus(projectId, "finalization_required");
      return {
        invalidated: true,
        reason:
          preparation.planKey === null
            ? `The ready asset's plan ("${readyJob.signPlanKey}") has been superseded — the preparation currently has no plan at all (status: "${preparation.status}").`
            : `The ready asset's plan ("${readyJob.signPlanKey}") has been superseded by the preparation's current plan ("${preparation.planKey}").`,
      };
    }

    // The task's third named reason ("validation requirements change" —
    // e.g. a future preservation-prompt/model/schema revision) is a real,
    // independent supersession ground, deliberately NOT implemented here:
    // `PrintValidationReport` (what `ProductionAssetValidation.report`
    // persists) does not currently echo back the `rigidSign` evidence it
    // was given, so there is no already-persisted, already-authoritative
    // signal this function could read without either a broader report-
    // shape change (affecting every profile, not just rigid_sign_raster)
    // or a new schema column — either is a real, separately-reviewable
    // decision, not an incidental add-on to this phase's minimal
    // mechanism. The planKey comparison above already covers every
    // concretely-required reason (a superseding re-plan, a corrected
    // re-plan landing on "blocked", a changed spec, a changed source —
    // `computeSignPlanKey` is derived from exactly those three, so each
    // one changes `planKey` by construction).
    return {
      invalidated: false,
      reason: "The ready asset's plan is still the preparation's current plan — nothing to reconcile.",
    };
  }

  return capability;
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
  if (
    meta.enhancement !== "skipped" &&
    meta.enhancement !== "reconstructed" &&
    meta.enhancement !== "halftone_screened"
  ) {
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

/**
 * Sprint A2: why this job produced no production asset, in internal
 * diagnostic language. Three genuinely different truths that were previously
 * one message — and the first of them used to swallow ordinary garment
 * designs whose customer merely mentioned screen printing or embroidery.
 * Those now classify as `apparel_raster` and never reach here at all.
 *
 * Internal only: stored as `FinalArtworkJob.lastError`, never returned to a
 * customer. The customer-facing surface stays the plain-language
 * `needs_review` state (`toCustomerFinalizationView`) — no production
 * category, method enum, or requested-output identifier crosses that line.
 */
function unsupportedFinalizationReason(
  requirements: ProductionRequirements,
): string {
  if (requirements.category === "out_of_scope_product") {
    return "Product is outside the iHeartPrints product scope (apparel artwork); no production artifact is produced for it.";
  }
  if (requirements.requestedUnsupportedOutput) {
    return `Customer explicitly requested a production artifact iHeartPrints does not produce (${requirements.requestedUnsupportedOutput}); the raster Production PNG must not be presented as satisfying it.`;
  }
  return `No supported production profile for automated raster finalization (category: ${requirements.category}); requires human production planning.`;
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
/**
 * Print'em All Phase 2: the provider's screen metadata, as the provider-
 * neutral evidence Print Validation consumes.
 *
 * A projection rather than a pass-through, mirroring `toNormalizationSummary`.
 * The engine's metadata carries working figures validation has no business
 * seeing (cell area, mean requested coverage); the evidence carries exactly
 * the facts a check recomputes from.
 */
function toHalftoneEvidence(
  metadata: HalftoneScreenMetadata | null,
): HalftoneProductionEvidence | null {
  if (!metadata) return null;
  return {
    algorithmVersion: metadata.algorithmVersion,
    lpi: metadata.lpi,
    angleDeg: metadata.angleDeg,
    dotShape: metadata.dotShape,
    midtone: metadata.midtone,
    chokePx: metadata.chokePx,
    garmentHex: metadata.garmentHex,
    targetPpi: metadata.targetPpi,
    cellPx: metadata.cellPx,
    achievedLpi: metadata.achievedLpi,
    minDotRadiusPx: metadata.minDotRadiusPx,
    screenWidthPx: metadata.screenWidthPx,
    screenHeightPx: metadata.screenHeightPx,
    visiblePixelCount: metadata.visiblePixelCount,
    inkedPixelFraction: metadata.inkedPixelFraction,
  };
}

/**
 * Reads screen evidence back off a persisted plate.
 *
 * Returns `null` on anything incomplete rather than filling gaps, exactly
 * like `readNormalizationSummary`. A plate whose recorded screen is partial
 * cannot be verified, and `halftone_treatment` refusing it is the correct
 * outcome — far better than a check passing against numbers this function
 * invented.
 */
function readHalftoneEvidence(value: unknown): HalftoneProductionEvidence | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Record<string, unknown>;

  const numbers = [
    "lpi",
    "angleDeg",
    "midtone",
    "chokePx",
    "targetPpi",
    "cellPx",
    "achievedLpi",
    "minDotRadiusPx",
    "screenWidthPx",
    "screenHeightPx",
    "visiblePixelCount",
    "inkedPixelFraction",
  ] as const;
  for (const key of numbers) {
    if (typeof meta[key] !== "number" || !Number.isFinite(meta[key] as number)) {
      return null;
    }
  }
  if (typeof meta.algorithmVersion !== "string" || !meta.algorithmVersion) return null;
  if (typeof meta.dotShape !== "string" || !meta.dotShape) return null;
  if (typeof meta.garmentHex !== "string" || !meta.garmentHex) return null;

  return {
    algorithmVersion: meta.algorithmVersion,
    lpi: meta.lpi as number,
    angleDeg: meta.angleDeg as number,
    dotShape: meta.dotShape,
    midtone: meta.midtone as number,
    chokePx: meta.chokePx as number,
    garmentHex: meta.garmentHex,
    targetPpi: meta.targetPpi as number,
    cellPx: meta.cellPx as number,
    achievedLpi: meta.achievedLpi as number,
    minDotRadiusPx: meta.minDotRadiusPx as number,
    screenWidthPx: meta.screenWidthPx as number,
    screenHeightPx: meta.screenHeightPx as number,
    visiblePixelCount: meta.visiblePixelCount as number,
    inkedPixelFraction: meta.inkedPixelFraction as number,
  };
}

/** Capped, worst-first, across all four categories — see `DtfFeatureIntegritySummary.riskRegions`'s own doc comment. */
const DTF_RISK_REGION_REPORT_CAP = 30;

/**
 * DTF Feature Integrity Phase 1: decodes the final production PNG bytes and
 * runs the measurement engine against them at the plate's own recorded
 * intended physical size. Never throws — a decode or measurement failure is
 * diagnostic-only (see the call site's comment) and simply means the four
 * `dtf_*` Print Validation checks are not emitted for this asset.
 */
function measureDtfFeatureIntegrity(
  bytes: Buffer,
  normalization: ProductionNormalizationMetadata,
): DtfFeatureIntegritySummary | null {
  try {
    const decoded = PNG.sync.read(bytes);
    const measurement = measureFeatureIntegrity({
      image: { width: decoded.width, height: decoded.height, data: decoded.data },
      confirmedWidthIn: normalization.intendedWidthIn,
      confirmedHeightIn: normalization.intendedHeightIn,
      // Phase 2A: these are plain numeric parameters as far as the engine is
      // concerned (see `measureFeatureIntegrity`'s doc comment) — the
      // profile file remains the sole owner of what these numbers actually
      // ARE. Passing them through here lets the engine compute each
      // component's own fraction-below-floor without this worker (or
      // PrintValidation) ever needing the raw per-pixel ridge samples.
      positiveFeatureThresholds: {
        blockingFloorMm: DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
        warningFloorMm: DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
      },
      negativeSpaceThresholds: {
        blockingFloorMm: DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
        warningFloorMm: DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
      },
    });
    return toDtfFeatureIntegritySummary(measurement);
  } catch {
    return null;
  }
}

/**
 * DTF Coverage Intelligence (Phase 2A): decodes the final production PNG
 * bytes and runs the coverage engine against them at the plate's own
 * recorded intended physical size. Unlike
 * `measureDtfFeatureIntegrity`, this runs for EVERY production treatment,
 * including halftone (Section 18). Never throws — a decode/measurement
 * failure here is diagnostic-only and never fails an otherwise-successful
 * production job.
 */
function measureDtfCoverageForPlate(
  bytes: Buffer,
  normalization: ProductionNormalizationMetadata,
): DtfCoverageMeasurement | null {
  try {
    const decoded = PNG.sync.read(bytes);
    return measureDtfCoverage({
      image: { width: decoded.width, height: decoded.height, data: decoded.data },
      confirmedWidthIn: normalization.intendedWidthIn,
      confirmedHeightIn: normalization.intendedHeightIn,
    });
  } catch {
    return null;
  }
}

/**
 * Reduces the engine's full `FeatureIntegrityMeasurement` onto the smaller,
 * independent shape Print Validation and asset-metadata persistence both
 * consume — mirrors `toNormalizationSummary`/`toHalftoneEvidence`. Only the
 * aggregate fields and a capped, worst-first `riskRegions` list survive;
 * per-component detail beyond that cap is intentionally not persisted
 * (Section 17 of this phase's plan: keep payload sizes reasonable, and never
 * silently imply a capped list is complete — hence the `limitations` note
 * below when capping actually drops something).
 */
function toDtfFeatureIntegritySummary(
  measurement: FeatureIntegrityMeasurement,
): DtfFeatureIntegritySummary {
  const regions: DtfFeatureRiskRegion[] = [
    ...measurement.positive.components.map((c) => ({
      kind: "positive_feature_thin" as const,
      boundingBoxPx: { ...c.boundsPx },
      measuredWidthMm: c.minStrokeWidthMm,
      measuredDiameterMm: null,
      physicalAreaMm2: c.physicalAreaMm2,
      medianWidthMm: c.medianStrokeWidthMm,
      fractionBelowBlockingFloor: c.structuralFractions?.fractionBelowBlockingFloor ?? null,
      fractionBelowWarningFloor: c.structuralFractions?.fractionBelowWarningFloor ?? null,
      pixelArea: c.pixelArea,
    })),
    ...measurement.negative.components.map((c) => ({
      kind: "negative_space_narrow" as const,
      boundingBoxPx: { ...c.boundsPx },
      measuredWidthMm: c.minGapWidthMm,
      measuredDiameterMm: null,
      physicalAreaMm2: c.physicalAreaMm2,
      medianWidthMm: c.medianGapWidthMm,
      fractionBelowBlockingFloor: c.structuralFractions?.fractionBelowBlockingFloor ?? null,
      fractionBelowWarningFloor: c.structuralFractions?.fractionBelowWarningFloor ?? null,
      pixelArea: c.pixelArea,
    })),
    ...measurement.isolated.components.map((c) => ({
      kind: "isolated_component_small" as const,
      boundingBoxPx: { ...c.boundsPx },
      measuredWidthMm: null,
      measuredDiameterMm: c.equivalentDiameterMm,
      physicalAreaMm2: c.physicalAreaMm2,
      medianWidthMm: null,
      fractionBelowBlockingFloor: null,
      fractionBelowWarningFloor: null,
      pixelArea: c.pixelArea,
    })),
    ...measurement.partialAlpha.components.map((c) => ({
      kind: "partial_alpha_fragile" as const,
      boundingBoxPx: { ...c.boundsPx },
      measuredWidthMm: null,
      measuredDiameterMm: c.equivalentDiameterMm,
      physicalAreaMm2: null,
      medianWidthMm: null,
      fractionBelowBlockingFloor: null,
      fractionBelowWarningFloor: null,
      pixelArea: c.pixelArea,
    })),
  ];
  regions.sort((a, b) => (a.measuredWidthMm ?? a.measuredDiameterMm ?? Infinity) - (b.measuredWidthMm ?? b.measuredDiameterMm ?? Infinity));

  const limitations = [...measurement.limitations];
  if (regions.length > DTF_RISK_REGION_REPORT_CAP) {
    limitations.push(
      `${regions.length} diagnostic risk regions were measured across all categories; only the ${DTF_RISK_REGION_REPORT_CAP} most at-risk are recorded here.`,
    );
  }

  return {
    algorithmVersion: measurement.algorithmVersion,
    pixelPitchXMm: measurement.pixelPitchXMm,
    pixelPitchYMm: measurement.pixelPitchYMm,
    positive: {
      measuredComponentCount: measurement.positive.totalComponentCount,
      globalMinStrokeWidthMm: measurement.positive.globalMinStrokeWidthMm,
      percentile5StrokeWidthMm: measurement.positive.percentile5StrokeWidthMm,
      worstStructuralComponent: measurement.positive.worstStructuralComponent,
    },
    negative: {
      measuredChannelCount: measurement.negative.totalComponentCount,
      globalMinGapWidthMm: measurement.negative.globalMinGapWidthMm,
      percentile5GapWidthMm: measurement.negative.percentile5GapWidthMm,
      worstStructuralComponent: measurement.negative.worstStructuralComponent,
    },
    isolated: {
      totalComponentCount: measurement.isolated.totalComponentCount,
      smallestEquivalentDiameterMm: measurement.isolated.smallestEquivalentDiameterMm,
      microComponents: {
        microComponentCount: measurement.isolated.microComponents.microComponentCount,
        totalMicroComponentPhysicalAreaMm2:
          measurement.isolated.microComponents.totalMicroComponentPhysicalAreaMm2,
        fractionOfPrintedArea: measurement.isolated.microComponents.fractionOfPrintedArea,
        meanPartialAlphaFraction: measurement.isolated.microComponents.meanPartialAlphaFraction,
      },
    },
    partialAlpha: {
      partialAlphaFractionOfVisible: measurement.partialAlpha.partialAlphaFractionOfVisible,
      smallestEquivalentDiameterMm: measurement.partialAlpha.smallestEquivalentDiameterMm,
    },
    riskRegions: regions.slice(0, DTF_RISK_REGION_REPORT_CAP),
    limitations,
  };
}

/**
 * Reads a DTF Feature Integrity summary back off an already-persisted
 * production asset (the idempotent-retry/reuse path) — mirrors
 * `readNormalizationSummary`/`readHalftoneEvidence`. Returns `null` for
 * anything incomplete rather than filling gaps: a plate whose recorded
 * measurement is partial is treated exactly like one produced before this
 * phase existed, never patched up with invented numbers.
 */
function readDtfFeatureIntegritySummary(value: unknown): DtfFeatureIntegritySummary | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Record<string, unknown>;
  if (typeof meta.algorithmVersion !== "string" || !meta.algorithmVersion) return null;
  if (typeof meta.pixelPitchXMm !== "number" || typeof meta.pixelPitchYMm !== "number") return null;

  const positive = meta.positive as Record<string, unknown> | undefined;
  const negative = meta.negative as Record<string, unknown> | undefined;
  const isolated = meta.isolated as Record<string, unknown> | undefined;
  const partialAlpha = meta.partialAlpha as Record<string, unknown> | undefined;
  if (
    !positive || typeof positive.measuredComponentCount !== "number" ||
    !negative || typeof negative.measuredChannelCount !== "number" ||
    !isolated || typeof isolated.totalComponentCount !== "number" ||
    !partialAlpha || typeof partialAlpha.partialAlphaFractionOfVisible !== "number"
  ) {
    return null;
  }
  if (!Array.isArray(meta.riskRegions) || !Array.isArray(meta.limitations)) return null;

  const optionalNumber = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const readWorstStructuralPositive = (
    value: unknown,
  ): { minStrokeWidthMm: number | null; fractionBelowBlockingFloor: number; fractionBelowWarningFloor: number } | null => {
    if (!value || typeof value !== "object") return null;
    const w = value as Record<string, unknown>;
    if (typeof w.fractionBelowBlockingFloor !== "number" || typeof w.fractionBelowWarningFloor !== "number") {
      return null;
    }
    return {
      minStrokeWidthMm: optionalNumber(w.minStrokeWidthMm),
      fractionBelowBlockingFloor: w.fractionBelowBlockingFloor,
      fractionBelowWarningFloor: w.fractionBelowWarningFloor,
    };
  };
  const readWorstStructuralNegative = (
    value: unknown,
  ): { minGapWidthMm: number | null; fractionBelowBlockingFloor: number; fractionBelowWarningFloor: number } | null => {
    if (!value || typeof value !== "object") return null;
    const w = value as Record<string, unknown>;
    if (typeof w.fractionBelowBlockingFloor !== "number" || typeof w.fractionBelowWarningFloor !== "number") {
      return null;
    }
    return {
      minGapWidthMm: optionalNumber(w.minGapWidthMm),
      fractionBelowBlockingFloor: w.fractionBelowBlockingFloor,
      fractionBelowWarningFloor: w.fractionBelowWarningFloor,
    };
  };

  const microComponentsRaw = isolated.microComponents as Record<string, unknown> | undefined;
  const microComponents =
    microComponentsRaw &&
    typeof microComponentsRaw.microComponentCount === "number" &&
    typeof microComponentsRaw.totalMicroComponentPhysicalAreaMm2 === "number" &&
    typeof microComponentsRaw.fractionOfPrintedArea === "number" &&
    typeof microComponentsRaw.meanPartialAlphaFraction === "number"
      ? {
          microComponentCount: microComponentsRaw.microComponentCount,
          totalMicroComponentPhysicalAreaMm2: microComponentsRaw.totalMicroComponentPhysicalAreaMm2,
          fractionOfPrintedArea: microComponentsRaw.fractionOfPrintedArea,
          meanPartialAlphaFraction: microComponentsRaw.meanPartialAlphaFraction,
        }
      : { microComponentCount: 0, totalMicroComponentPhysicalAreaMm2: 0, fractionOfPrintedArea: 0, meanPartialAlphaFraction: 0 };

  return {
    algorithmVersion: meta.algorithmVersion,
    pixelPitchXMm: meta.pixelPitchXMm,
    pixelPitchYMm: meta.pixelPitchYMm,
    positive: {
      measuredComponentCount: positive.measuredComponentCount as number,
      globalMinStrokeWidthMm: optionalNumber(positive.globalMinStrokeWidthMm),
      percentile5StrokeWidthMm: optionalNumber(positive.percentile5StrokeWidthMm),
      worstStructuralComponent: readWorstStructuralPositive(positive.worstStructuralComponent),
    },
    negative: {
      measuredChannelCount: negative.measuredChannelCount as number,
      globalMinGapWidthMm: optionalNumber(negative.globalMinGapWidthMm),
      percentile5GapWidthMm: optionalNumber(negative.percentile5GapWidthMm),
      worstStructuralComponent: readWorstStructuralNegative(negative.worstStructuralComponent),
    },
    isolated: {
      totalComponentCount: isolated.totalComponentCount as number,
      smallestEquivalentDiameterMm: optionalNumber(isolated.smallestEquivalentDiameterMm),
      microComponents,
    },
    partialAlpha: {
      partialAlphaFractionOfVisible: partialAlpha.partialAlphaFractionOfVisible as number,
      smallestEquivalentDiameterMm: optionalNumber(partialAlpha.smallestEquivalentDiameterMm),
    },
    riskRegions: meta.riskRegions as DtfFeatureRiskRegion[],
    limitations: meta.limitations as string[],
  };
}

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
