/**
 * LIVE PRODUCT BLOCKER #4A: the read-only assembly behind the internal
 * operator sign-plan review page. Reads the SAME durable `SignPreparation`
 * row every other layer reads (`repo.getSignPreparation`) — never
 * diagnoses, never (re)plans, never mutates. Mirrors
 * `continue-as-internal-job.ts`'s `describeContinuationEligibility`: a
 * plain, framework-free function over `ProjectRepository`, safe to call
 * from a Server Component render.
 *
 * Deliberately NOT folded into `SignArtworkView`
 * (`conversation-service.ts`'s shared customer/operator snapshot type):
 * per-step review reasons and the authorization actor/timestamp are
 * operator-only. `SignArtworkView` is read by the ordinary customer
 * project snapshot too — extending it here would leak operator-only
 * detail into a customer-facing response the moment this module existed,
 * whether or not any customer UI currently renders the new fields. This
 * module is reachable only from `/internal/projects/[projectId]/sign-
 * authorize` and its API route, both already gated on a verified internal
 * session before this is ever called.
 */

import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import type { ProjectRepository } from "@/lib/db/repository";
import type { FinalArtworkJobStatus, SignPlanAuthorizationActor, SignPreparation } from "@/lib/domain/types";

import type { SignInspectionReport, SignRepairPlan } from "./contracts";
import { describeSignPlanForOperator, type SignPlanOperatorView } from "./sign-preparation-operator-copy";

/**
 * LIVE PRODUCT BLOCKER #4B: the minimum production-status facts the
 * operator page needs to decide what to show — "Prepare artwork", a
 * processing state, a download, or a needs-attention notice. Deliberately
 * READS the same durable `FinalArtworkJob`/`ProductionAssetValidation`
 * records `FinalArtworkCapability.resolveCurrentSignProductionDelivery`
 * treats as authoritative for the DOWNLOAD decision — but this is a
 * lighter, presentation-only peek (status booleans only, never an asset
 * id), not a second authority. Only the job bound to the preparation's
 * CURRENT `planKey` is ever considered; a stale/superseded plan's job is
 * invisible here, exactly like every other sign authority resolution.
 */
export interface SignPlanOperatorProductionStatus {
  jobStatus: FinalArtworkJobStatus | null;
  /** `queued` | `running` | `recoverable` — work is in flight right now. */
  inFlight: boolean;
  failed: boolean;
  /** `completed`, with an authoritative `"ready"` validation for its asset. */
  printReady: boolean;
  /** `completed`, but not print-ready — needs further review before it can be finalized. */
  needsAttention: boolean;
  /**
   * Blocked Production Candidate Inspection Phase: the exact asset id of a
   * NOT-print-ready production candidate the operator page may offer for
   * visual inspection — `null` whenever `needsAttention` is false, OR when
   * it's true but there is genuinely nothing to inspect (a
   * `completeWithoutAsset` determination produced no asset at all). Mirrors
   * `FinalArtworkCapability.resolveBlockedSignProductionCandidate`'s own
   * validation-bound (never positional) resolution — this is a lighter,
   * presentation-only peek at the SAME durable records that capability
   * treats as authoritative for the actual DOWNLOAD decision, exactly like
   * `printReady`/`needsAttention` above already are for the certified
   * download; never a second authority.
   */
  blockedCandidateAssetId: string | null;
  /** The blocked candidate's own validation id — `null` alongside `blockedCandidateAssetId`. Diagnostics only. */
  blockedValidationId: string | null;
  /** The blocked candidate's own validation status (e.g. `"finalization_required"`) — `null` alongside `blockedCandidateAssetId`. Never re-interpreted as an authorization signal. */
  blockedValidationStatus: string | null;
}

async function resolveSignProductionStatus(
  repo: ProjectRepository,
  projectId: string,
  preparation: SignPreparation,
): Promise<SignPlanOperatorProductionStatus> {
  const nothing: SignPlanOperatorProductionStatus = {
    jobStatus: null,
    inFlight: false,
    failed: false,
    printReady: false,
    needsAttention: false,
    blockedCandidateAssetId: null,
    blockedValidationId: null,
    blockedValidationStatus: null,
  };

  const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation.id);
  const job = jobs.find((candidate) => candidate.signPlanKey === preparation.planKey) ?? null;

  if (!job) return nothing;

  const inFlight = job.status === "queued" || job.status === "running" || job.status === "recoverable";
  const failed = job.status === "failed";

  let printReady = false;
  let blockedCandidateAssetId: string | null = null;
  let blockedValidationId: string | null = null;
  let blockedValidationStatus: string | null = null;
  if (job.status === "completed") {
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    printReady = validation?.status === "ready";
    if (validation && !printReady) {
      // Blocked Production Candidate Inspection Phase: the SAME
      // validation-bound (never positional) asset check
      // `resolveBlockedSignProductionCandidate` uses — reusing the
      // `validation` row already fetched above rather than a second query.
      const jobAssets = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
      const asset = jobAssets.find(
        (candidate) =>
          candidate.id === validation.assetId &&
          candidate.projectId === projectId &&
          candidate.finalArtworkJobId === job.id &&
          candidate.productionRole === "production_png" &&
          !isReconstructionIntermediateAsset(candidate),
      );
      if (asset) {
        blockedCandidateAssetId = asset.id;
        blockedValidationId = validation.id;
        blockedValidationStatus = validation.status;
      }
    }
  }
  const needsAttention = job.status === "completed" && !printReady;

  return {
    jobStatus: job.status,
    inFlight,
    failed,
    printReady,
    needsAttention,
    blockedCandidateAssetId,
    blockedValidationId,
    blockedValidationStatus,
  };
}

export type SignPlanOperatorReview =
  | { status: "not_found" }
  | { status: "no_preparation" }
  /**
   * Covers BOTH "planning has never been run" and "planning was attempted
   * and blocked" — `sign_preparations` has no schema state to tell them
   * apart (see `SignArtworkView.plan`'s doc in `conversation-service.ts`
   * for the identical, already-documented limitation on the customer
   * side). Honest either way: there is no plan to review right now.
   */
  | { status: "no_plan" }
  | {
      status: "ready";
      orderedWidthIn: number;
      orderedHeightIn: number;
      originalAssetId: string;
      plan: SignPlanOperatorView;
      /** Signs Phase 3A: whether operator-confirmed structural evidence is currently recorded for this preparation (regardless of whether the CURRENT plan happened to use it). */
      operatorStructuralOverridePresent: boolean;
      authorization: {
        authorizedBy: SignPlanAuthorizationActor | null;
        authorizedAt: string | null;
        /** False for a stale authorization left over from a since-replanned artwork. */
        matchesCurrentPlan: boolean;
      };
      production: SignPlanOperatorProductionStatus;
    };

/** Read-only. Never mutates. Safe to call from a Server Component render. */
export async function loadSignPlanOperatorReview(
  repo: ProjectRepository,
  projectId: string,
): Promise<SignPlanOperatorReview> {
  const project = await repo.getProject(projectId);
  if (!project) return { status: "not_found" };

  const preparation = await repo.getSignPreparation(projectId);
  if (!preparation || preparation.projectId !== projectId) {
    return { status: "no_preparation" };
  }

  if (preparation.status !== "planned" || !preparation.plan || !preparation.planKey || !preparation.inspection) {
    return { status: "no_plan" };
  }

  const plan = preparation.plan as unknown as SignRepairPlan;
  const inspection = preparation.inspection as unknown as SignInspectionReport;

  const orderedWidthIn = preparation.orderedWidthIn ?? plan.orderedWidthIn;
  const orderedHeightIn = preparation.orderedHeightIn ?? plan.orderedHeightIn;

  const operatorPlan = describeSignPlanForOperator({
    orderedWidthIn,
    orderedHeightIn,
    artworkWidthPx: inspection.source.widthPx,
    artworkHeightPx: inspection.source.heightPx,
    inspection,
    plan,
  });

  const production = await resolveSignProductionStatus(repo, projectId, preparation);

  return {
    status: "ready",
    orderedWidthIn,
    orderedHeightIn,
    originalAssetId: preparation.originalAssetId,
    plan: operatorPlan,
    operatorStructuralOverridePresent: preparation.operatorStructuralOverride !== null,
    authorization: {
      authorizedBy: preparation.authorizedBy,
      authorizedAt: preparation.authorizedAt,
      matchesCurrentPlan:
        preparation.authorizedPlanKey !== null && preparation.authorizedPlanKey === preparation.planKey,
    },
    production,
  };
}
