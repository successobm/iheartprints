/**
 * LIVE PRODUCT BLOCKER #4A: the pure decision behind this operator page's
 * render branch — same extraction reasoning as `continue-page-state.ts`
 * (`resolveContinuePageState`): this repo's test tooling has no DOM and no
 * Next.js request context, so the actual branch logic lives here, with no
 * framework dependency at all.
 */
import type { SignPlanOperatorReview } from "@/capabilities/sign-preparation";

export type SignAuthorizePageState =
  | { kind: "unconfigured" }
  | { kind: "not_internal" }
  | { kind: "not_found" }
  | { kind: "no_preparation" }
  | { kind: "no_plan" }
  | { kind: "ready"; review: Extract<SignPlanOperatorReview, { status: "ready" }> };

export function resolveSignAuthorizePageState(input: {
  configured: boolean;
  isInternal: boolean;
  review: SignPlanOperatorReview | null;
}): SignAuthorizePageState {
  if (!input.configured) return { kind: "unconfigured" };
  if (!input.isInternal) return { kind: "not_internal" };
  const review = input.review;
  if (!review || review.status === "not_found") return { kind: "not_found" };
  if (review.status === "no_preparation") return { kind: "no_preparation" };
  if (review.status === "no_plan") return { kind: "no_plan" };
  return { kind: "ready", review };
}

/**
 * R6B repair (Cursor independent review, Required Repair #3): the pure
 * decision behind the "Approve & Continue" CTA — extracted for the exact
 * reason this module's own doc comment gives for every other branch here
 * (no DOM/Next.js context in this repo's test tooling), so a plan that is
 * internally well-formed (`plan.canAuthorize`) but no longer corresponds to
 * the CURRENT Signs effective source (`review.sourceCurrent === false`) is
 * never presented as ordinarily actionable. The actual refusal is
 * server-side (`authorizeSignRepairPlan`/`requestSignFinalArtwork`) — this
 * is the VIEW staying honest about that fact, never a second resolver.
 */
export type SignApprovalCtaState = "can_authorize" | "source_stale" | "blocked";

export function resolveSignApprovalCtaState(
  review: Extract<SignPlanOperatorReview, { status: "ready" }>,
): SignApprovalCtaState {
  if (!review.plan.canAuthorize) return "blocked";
  if (!review.sourceCurrent) return "source_stale";
  return "can_authorize";
}
