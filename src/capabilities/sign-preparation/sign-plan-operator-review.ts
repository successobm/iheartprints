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

import type { ProjectRepository } from "@/lib/db/repository";
import type { SignPlanAuthorizationActor } from "@/lib/domain/types";

import type { SignInspectionReport, SignRepairPlan } from "./contracts";
import { describeSignPlanForOperator, type SignPlanOperatorView } from "./sign-preparation-operator-copy";

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
      authorization: {
        authorizedBy: SignPlanAuthorizationActor | null;
        authorizedAt: string | null;
        /** False for a stale authorization left over from a since-replanned artwork. */
        matchesCurrentPlan: boolean;
      };
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

  return {
    status: "ready",
    orderedWidthIn,
    orderedHeightIn,
    originalAssetId: preparation.originalAssetId,
    plan: operatorPlan,
    authorization: {
      authorizedBy: preparation.authorizedBy,
      authorizedAt: preparation.authorizedAt,
      matchesCurrentPlan:
        preparation.authorizedPlanKey !== null && preparation.authorizedPlanKey === preparation.planKey,
    },
  };
}
