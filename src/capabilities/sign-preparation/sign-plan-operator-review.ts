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
  /**
   * Signs Phase 3B (Fit to Production, Section G): the operator page's own
   * read of the `protected_content_safe_inset` PrintValidation check —
   * read from the SAME latest validation record already fetched above for
   * `printReady`/`blockedCandidateAssetId`, never a second, independent
   * pixel analysis (the worker is the sole place that ever computes it).
   * `null` when no completed job/validation exists yet to read from.
   */
  fitToProduction: SignFitToProductionSummary | null;
}

/**
 * Presentation-only summary of the `protected_content_safe_inset`
 * PrintValidation check — `reason` is the SAME rich, per-edge-clearance
 * sentence `print-validation-capability.ts`'s own `describeFitToProduction
 * Result` already composed (e.g. "top 94px/0.607in, right 30px/0.194in,
 * bottom (fail, 5px/0.032in)…"), never re-derived or re-measured here.
 *
 * Operator Production Correction UX: `edges`, when present, is this
 * module's own narrow copy of `print-validation`'s `RigidSignFitToProduction
 * Evidence.edges` — read back from the report's `fitToProductionEvidence`
 * field (never re-measured; this module never imports `print-validation`,
 * the same dependency-direction discipline every other field here already
 * follows) — enough structured, per-edge data for an operator UI to draw a
 * SAFE-guide/violation overlay without duplicating the analysis.
 */
export interface SignFitToProductionSummary {
  status: string;
  reason: string;
  safeInsetIn: number | null;
  achievedPpiX: number | null;
  achievedPpiY: number | null;
  edges: SignFitToProductionEdgeSummary[];
}

export interface SignFitToProductionEdgeSummary {
  edge: "top" | "right" | "bottom" | "left";
  requiredSafeInsetIn: number;
  requiredSafeInsetPx: number;
  nearestNonBleedPx: number | null;
  nearestNonBleedIn: number | null;
  violatingPositionPx: number | null;
  result: "pass" | "fail" | "unknown";
  reason: string;
}

/**
 * Reads the `protected_content_safe_inset` check's own status/reason, plus
 * the report's own `fitToProductionEvidence` structured field, back out of
 * a persisted `PrintValidationReport`'s generic `Record<string, unknown>`
 * shape — this module never imports `print-validation` (the same
 * dependency-direction discipline `sign-preservation`'s own duplicated
 * readers already follow). `null` on any malformed/missing shape, never
 * guessed; `edges: []` (never fabricated) when the check exists but the
 * structured evidence does not (e.g. a report persisted before this field
 * existed).
 */
function readFitToProductionSummary(report: Record<string, unknown> | null | undefined): SignFitToProductionSummary | null {
  const checks = report?.checks;
  if (!Array.isArray(checks)) return null;
  const raw = (checks as Record<string, unknown>[]).find((c) => c.check === "protected_content_safe_inset");
  if (!raw || typeof raw.status !== "string" || typeof raw.reason !== "string") return null;

  const evidence = report?.fitToProductionEvidence as Record<string, unknown> | null | undefined;
  const rawEdges = evidence && Array.isArray(evidence.edges) ? (evidence.edges as Record<string, unknown>[]) : [];
  const edges: SignFitToProductionEdgeSummary[] = rawEdges
    .filter(
      (e) =>
        (e.edge === "top" || e.edge === "right" || e.edge === "bottom" || e.edge === "left") &&
        typeof e.requiredSafeInsetIn === "number" &&
        typeof e.requiredSafeInsetPx === "number" &&
        (e.result === "pass" || e.result === "fail" || e.result === "unknown") &&
        typeof e.reason === "string",
    )
    .map((e) => ({
      edge: e.edge as SignFitToProductionEdgeSummary["edge"],
      requiredSafeInsetIn: e.requiredSafeInsetIn as number,
      requiredSafeInsetPx: e.requiredSafeInsetPx as number,
      nearestNonBleedPx: typeof e.nearestNonBleedPx === "number" ? e.nearestNonBleedPx : null,
      nearestNonBleedIn: typeof e.nearestNonBleedIn === "number" ? e.nearestNonBleedIn : null,
      violatingPositionPx: typeof e.violatingPositionPx === "number" ? e.violatingPositionPx : null,
      result: e.result as SignFitToProductionEdgeSummary["result"],
      reason: e.reason as string,
    }));

  return {
    status: raw.status,
    reason: raw.reason,
    safeInsetIn: evidence && typeof evidence.safeInsetIn === "number" ? evidence.safeInsetIn : null,
    achievedPpiX: evidence && typeof evidence.achievedPpiX === "number" ? evidence.achievedPpiX : null,
    achievedPpiY: evidence && typeof evidence.achievedPpiY === "number" ? evidence.achievedPpiY : null,
    edges,
  };
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
    fitToProduction: null,
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
  let fitToProduction: SignFitToProductionSummary | null = null;
  if (job.status === "completed") {
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    printReady = validation?.status === "ready";
    fitToProduction = readFitToProductionSummary(validation?.report as Record<string, unknown> | null | undefined);
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
    fitToProduction,
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
