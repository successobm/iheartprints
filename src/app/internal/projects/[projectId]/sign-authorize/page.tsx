import Link from "next/link";
import { cookies } from "next/headers";

import { loadSignPlanOperatorReview } from "@/capabilities/sign-preparation";
import { isInternalAccessConfigured } from "@/lib/config/internal-access-config";
import { ACQUISITION_SESSION_COOKIE } from "@/lib/http/acquisition-session-cookie";
import { getProjectRepository } from "@/lib/db";

import { SignAuthorizeButton } from "./SignAuthorizeButton";
import { SignCheckArtworkButton } from "./SignCheckArtworkButton";
import { SignProductionAction } from "./SignProductionAction";
import { resolveSignAuthorizePageState, type SignAuthorizePageState } from "./sign-authorize-page-state";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #4A: the smallest real internal product surface
 * where an operator can review a `review_required` rigid-sign repair plan
 * and durably authorize it for production. Mirrors `/internal/projects
 * /[projectId]/continue` exactly: a Server Component that reads the
 * session cookie once, decides a small enum of render states server-side,
 * and never renders the authorize action to a session that isn't
 * genuinely internal.
 *
 * There is deliberately no project browser here, same reasoning as the
 * "Continue as Internal Job" page's own doc comment — an operator who
 * knows which customer project they're reviewing navigates here directly
 * by id.
 *
 * Server-rendered from the durably persisted `SignPreparation` row
 * (`loadSignPlanOperatorReview`), translated into operator language — this
 * component itself never plans, replans, or executes anything on its own.
 * Two explicit operator-initiated mutations exist, both behind their own
 * internal-session-gated routes, never triggered automatically on render:
 * "Authorize plan" (an existing `review_required`/`auto_safe` plan), and —
 * Internal Replan Action Phase — "Check this artwork" in the `no_plan`
 * state, for a project not reachable through the original customer's own
 * browser session (see `SignCheckArtworkButton`'s own doc comment).
 */
export default async function SignAuthorizePage({ params }: PageProps) {
  const { projectId } = await params;
  const configured = isInternalAccessConfigured();

  let isInternal = false;
  if (configured) {
    const cookieStore = await cookies();
    const token = cookieStore.get(ACQUISITION_SESSION_COOKIE)?.value ?? null;
    if (token) {
      const repo = getProjectRepository();
      const session = await repo.getAcquisitionSessionByToken(token).catch(() => null);
      isInternal = session?.entitlement === "internal";
    }
  }

  const review =
    configured && isInternal ? await loadSignPlanOperatorReview(getProjectRepository(), projectId) : null;

  const pageState = resolveSignAuthorizePageState({ configured, isInternal, review });

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-lg font-semibold text-ink">Sign Production Review</h1>
        <p className="mt-1 text-sm text-muted">
          Review this customer&apos;s sign artwork and authorize its production plan.
        </p>
      </div>

      {pageState.kind === "unconfigured" ? (
        <p className="text-sm text-muted" data-sign-authorize-unconfigured>
          Internal access isn&apos;t configured for this deployment.
        </p>
      ) : pageState.kind === "not_internal" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink" data-sign-authorize-not-internal>
            This browser doesn&apos;t have internal production access.
          </p>
          <Link
            href="/internal/access"
            className="rounded-full bg-ink px-3.5 py-2 text-center text-sm font-medium text-white transition hover:bg-ink/90"
          >
            Get internal access
          </Link>
        </div>
      ) : pageState.kind === "not_found" ? (
        <p className="text-sm text-ink" data-sign-authorize-not-found>
          No project with that id was found.
        </p>
      ) : pageState.kind === "no_preparation" ? (
        <p className="text-sm text-ink" data-sign-authorize-no-preparation>
          This project has no sign artwork uploaded yet.
        </p>
      ) : pageState.kind === "no_plan" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink" data-sign-authorize-no-plan>
            This artwork doesn&apos;t currently have a production plan. Either it hasn&apos;t been planned yet, or the
            planner wasn&apos;t able to formulate an automatic repair for it.
          </p>
          <SignCheckArtworkButton projectId={projectId} />
        </div>
      ) : (
        <SignPlanReview projectId={projectId} review={pageState.review} />
      )}
    </div>
  );
}

function SignPlanReview({
  projectId,
  review,
}: {
  projectId: string;
  review: Extract<SignAuthorizePageState, { kind: "ready" }>["review"];
}) {
  const { plan, authorization } = review;
  const isAuthorized = authorization.matchesCurrentPlan && authorization.authorizedBy !== null;
  const canAuthorize = plan.canAuthorize;

  return (
    <div className="flex flex-col gap-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool, not the customer image pipeline */}
      <img
        src={`/api/internal/projects/${projectId}/sign-artwork/original-image`}
        alt="Customer's uploaded sign artwork"
        className="w-full rounded-lg border border-ink/10"
      />

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-ink">Ordered output</h2>
        <p className="text-sm text-ink">
          Sign size
          <br />
          {review.orderedWidthIn}&quot; × {review.orderedHeightIn}&quot;
        </p>
        <p className="text-sm text-ink">
          Artwork
          <br />
          {plan.artworkWidthPx} × {plan.artworkHeightPx} pixels
        </p>
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-ink">Status</h2>
        <p className="text-sm text-ink" data-sign-authorize-risk-label>
          {plan.riskLabel}
        </p>
      </section>

      {plan.findings.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-ink">Production findings</h2>
          <ul className="list-disc pl-5 text-sm text-ink">
            {plan.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.steps.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink">Proposed preparation</h2>
          {plan.steps.map((step, index) => (
            // Steps carry no stable id; plan order is itself the identity.
            <div key={index} className="flex flex-col gap-1 rounded-lg border border-ink/10 p-3">
              <p className="text-sm text-ink">{step.summary}</p>
              {step.detail ? <p className="text-sm text-muted">{step.detail}</p> : null}
              {step.needsReview ? (
                <p className="text-sm text-amber-700" data-sign-authorize-step-review-reason>
                  Why review is required: {step.reviewReason}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3 border-t border-ink/10 pt-4">
        {isAuthorized ? (
          <div data-sign-authorize-authorized>
            <p className="text-sm font-semibold text-ink">Authorized</p>
            <p className="text-sm text-muted">
              This production plan has been reviewed and authorized{authorization.authorizedBy === "customer" ? " by the customer" : " by an operator"}
              {authorization.authorizedAt ? ` on ${new Date(authorization.authorizedAt).toLocaleString()}` : ""}.
            </p>
          </div>
        ) : canAuthorize ? (
          <SignAuthorizeButton projectId={projectId} />
        ) : (
          <p className="text-sm text-ink" data-sign-authorize-blocked>
            The planner couldn&apos;t formulate an automatic preparation for this artwork. There is nothing to
            authorize.
          </p>
        )}
      </section>

      {isAuthorized ? (
        <section className="flex flex-col gap-3 border-t border-ink/10 pt-4">
          <SignProductionAction projectId={projectId} production={review.production} />
        </section>
      ) : null}
    </div>
  );
}
