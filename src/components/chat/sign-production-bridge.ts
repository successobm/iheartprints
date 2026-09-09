/**
 * Production Workspace Bridge: the "You're all set" dead end fix.
 *
 * LIVE PRODUCT BLOCKER #4 wired the customer's own self-service
 * authorization (`authorizeSignPlan` in `ChatApp.tsx`) to the ALREADY-BUILT
 * `POST .../sign-artwork/authorize` route, but stopped there — the customer
 * landed on a genuinely terminal "you're all set" screen with no route back
 * into the existing production workspace
 * (`/internal/projects/[projectId]/sign-authorize`), even though Eric IS
 * both the person submitting and the production operator for the current
 * internal Print'em All operating model (`AGENTS.md`'s "current user model"
 * — this is deliberately NOT a customer-vs-staff role system).
 *
 * This module is the ONE pure decision both entry points share:
 *
 *   - `authorizeSignPlan()`, immediately after a successful authorization
 *     response, so a brand-new authorization navigates straight through.
 *   - `continueToSignProduction()`, from the already-authorized
 *     `sign_plan_authorized` step reached on reload — the exact real
 *     project's own case (authorized in an earlier session, dead-ended on
 *     "you're all set" until this fix).
 *
 * Deliberately pure and DOM-free (`renderToString`-only test tooling, no
 * click simulation — see `uploaded-artwork-flow.ts`'s own doc for why this
 * kind of decision lives outside the component). `ChatApp.tsx` is the only
 * caller that actually performs the navigation (`window.location.assign`,
 * a FULL page load — the internal workspace is a Server Component that
 * reads its own session cookie fresh on every request, and a full
 * navigation is what lets its own existing internal-access gate
 * (`isInternalAccessConfigured` / `ACQUISITION_SESSION_COOKIE`,
 * `sign-authorize/page.tsx`) run untouched and fail closed exactly as it
 * already does for a session with no internal access. This module never
 * weakens, bypasses, or duplicates that gate — it only decides the URL a
 * client MIGHT ask the browser to load.
 *
 * The gating signal is the SAME authoritative field
 * `deriveUploadedArtworkStep` already uses to reach the `sign_plan_authorized`
 * step in the first place — `signArtwork.authorization.matchesCurrentPlan`,
 * durably `authorizedPlanKey === planKey` on the persisted `SignPreparation`
 * row (`conversation-service.ts`). Never a transient client flag, never "the
 * request came back 200 so it must have worked": a response whose
 * authorization does not (yet) match the CURRENT plan — a stale
 * authorization bound to a superseded plan, or any other state this route
 * has not actually recorded as durably authorized — never navigates,
 * exactly like every other authorization check in this codebase.
 */
export interface SignProductionBridgeSnapshot {
  project: { id: string };
  signArtwork: { authorization: { matchesCurrentPlan: boolean } } | null;
}

/**
 * Signs Workflow Dead Ends fix (Defect 2): the other half of this same
 * bridge, for the OTHER genuinely terminal-looking screen — a plan whose
 * risk classification requires an operator's own review
 * (`isAuthorizationSufficientForRisk`, `sign-plan-authorization.ts`:
 * `review_required` accepts only `authorizedBy: "operator"`, never a
 * customer's own click). The customer chat surface correctly never offers
 * a self-service "approve" action for this risk class — but it was ALSO
 * never pointing anywhere an operator (Eric, under the current user model)
 * COULD go authorize it, even though the exact governed action already
 * exists and is already fully built: `SignAuthorizeButton` on
 * `/internal/projects/[projectId]/sign-authorize`
 * (`POST /api/internal/projects/[projectId]/sign-artwork/authorize`).
 *
 * This function decides the SAME URL `resolveSignProductionWorkspaceUrl`
 * does, but on a different, narrower gate: a plan exists AND needs review
 * AND has not already been authorized for the CURRENT plan. It grants
 * nothing on its own — the internal workspace's own existing internal-
 * access gate (`isInternalAccessConfigured` / `ACQUISITION_SESSION_COOKIE`)
 * still runs untouched on arrival, exactly as `resolveSignProductionWorkspaceUrl`'s
 * own doc already establishes for the authorized case. Never renders (or
 * is asked to compute) anything for `"ready"`/`"blocked"` plans — a
 * `"ready"` plan has its own sufficient customer self-service action
 * (`onAuthorizeSignPlan`); a `"blocked"` plan has no plan to review at all.
 */
export interface SignReviewWorkspaceSnapshot {
  project: { id: string };
  signArtwork: {
    plan: { reviewRequired: boolean } | null;
    authorization: { matchesCurrentPlan: boolean };
  } | null;
}

/**
 * The internal production workspace URL for a plan that needs an
 * operator's own review, or `null` when there is nothing (yet, or any
 * longer) for an operator to review there.
 *
 * `null` on:
 *   - no snapshot, or no `SignPreparation` for this project
 *   - no current plan, or a current plan that does not require review
 *     (`"ready"` or `"blocked"` — see this module's own doc)
 *   - a review-required plan that has ALREADY been authorized for the
 *     CURRENT plan (`matchesCurrentPlan === true`) — that customer is
 *     already on `sign_plan_authorized`, whose OWN "Continue to
 *     production" (`resolveSignProductionWorkspaceUrl`) is the right
 *     action, not a second link to the identical destination
 *   - a project id that is not a genuine non-empty identifier
 */
export function resolveSignReviewWorkspaceUrl(
  snapshot: SignReviewWorkspaceSnapshot | null,
): string | null {
  if (!snapshot) return null;
  if (!snapshot.signArtwork?.plan?.reviewRequired) return null;
  if (snapshot.signArtwork.authorization.matchesCurrentPlan) return null;
  const projectId = snapshot.project.id;
  if (typeof projectId !== "string" || projectId.trim() === "") return null;
  return `/internal/projects/${projectId}/sign-authorize`;
}

/**
 * The internal production workspace URL for this project's authorized plan,
 * or `null` when navigation is not (yet) authorized.
 *
 * `null` on:
 *   - no snapshot at all (nothing to navigate for yet)
 *   - no `SignPreparation` for this project (`signArtwork === null` — never
 *     a Sign in the first place)
 *   - the durable authorization does not match the CURRENT plan (not yet
 *     authorized, or a stale authorization bound to a superseded plan —
 *     `matchesCurrentPlan === false` covers both; see
 *     `SignArtworkView.authorization`'s own doc)
 *   - a project id that is not a genuine non-empty identifier (defensive —
 *     never construct a URL that could not resolve to a real project)
 */
export function resolveSignProductionWorkspaceUrl(
  snapshot: SignProductionBridgeSnapshot | null,
): string | null {
  if (!snapshot) return null;
  if (!snapshot.signArtwork?.authorization.matchesCurrentPlan) return null;
  const projectId = snapshot.project.id;
  if (typeof projectId !== "string" || projectId.trim() === "") return null;
  return `/internal/projects/${projectId}/sign-authorize`;
}
