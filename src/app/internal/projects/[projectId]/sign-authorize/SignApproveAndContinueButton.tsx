"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Simplify Signs Production Review Phase: the ONE human decision that
 * replaces the old two-click "Authorize plan" then "Prepare artwork"
 * sequence. When Eric clicks this, he has already said "yes, this
 * adjustment is acceptable — make the print-ready artwork" — there is no
 * second human decision between authorization and execution, so this
 * performs both, in order, from one click.
 *
 * DOES NOT WEAKEN GOVERNANCE. This is orchestration, not a new
 * authority: it calls the SAME TWO existing, unmodified, independently
 * governed routes in sequence —
 *
 *   1. `POST /api/internal/projects/[projectId]/sign-artwork/authorize`
 *      (`authorizeSignArtwork` / `SignPreparationCapability.
 *      authorizeSignRepairPlan` — `isAuthorizationSufficientForRisk`
 *      still the one place a `review_required` plan requires an
 *      operator, never a customer)
 *   2. `POST /api/internal/projects/[projectId]/sign-artwork/prepare`
 *      (`prepareSignArtworkForProduction` / `FinalArtworkCapability.
 *      requestSignFinalArtwork` — which INDEPENDENTLY re-verifies the
 *      authorization is durably recorded for the CURRENT, freshly
 *      recomputed `planKey` before creating any job; a plan that changed
 *      between step 1 and step 2 fails closed here on its own, with no
 *      help from this component)
 *
 * Step 2 only ever runs after step 1's response is genuinely `ok` — never
 * optimistically, never in parallel. Both underlying capabilities remain
 * exactly as idempotent as before (`authorizeSignRepairPlan`: already-
 * authorized-for-this-plan is a no-op; `requestSignFinalArtwork`: an
 * existing queued/running/completed job for this plan is reused, never
 * duplicated), so a retry after either step's failure is always safe —
 * re-clicking simply re-runs both steps, and each one's own idempotency
 * absorbs whichever part, if any, already succeeded.
 *
 * Same internal-session gate as before: both routes independently verify
 * the REQUESTER'S OWN session is `entitlement === "internal"` — this
 * component grants nothing by existing, same as `SignAuthorizeButton` and
 * `SignProductionAction` before it (superseded here, not weakened).
 */
export function SignApproveAndContinueButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "approving" | "preparing">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (phase !== "idle") return;
    setError(null);
    setPhase("approving");
    try {
      const authorizeRes = await fetch(`/api/internal/projects/${projectId}/sign-artwork/authorize`, {
        method: "POST",
      });
      if (!authorizeRes.ok) {
        const body = (await authorizeRes.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setPhase("idle");
        return;
      }

      setPhase("preparing");
      const prepareRes = await fetch(`/api/internal/projects/${projectId}/sign-artwork/prepare`, {
        method: "POST",
      });
      if (!prepareRes.ok) {
        // Authorization DID succeed here — never silently re-authorize a
        // different plan on retry, and never claim the whole action
        // failed when only preparation did. The re-click above already
        // makes this a safe, idempotent retry of the SAME authorized
        // preparation, so the only thing this needs to do is say so.
        setError("We couldn't finish preparing the artwork. Try again.");
        setPhase("idle");
        return;
      }

      // Re-fetch authoritative server state rather than assuming success —
      // by the time this resolves, the job is durably queued/running (or
      // already completed), so the page's own `SignProductionAction`
      // naturally renders "Preparing artwork…" (or further) with no
      // second button required.
      router.refresh();
      setPhase("idle");
    } catch {
      setError("That didn't work. Please try again.");
      setPhase("idle");
    }
  }

  const label =
    phase === "approving" ? "Approving…" : phase === "preparing" ? "Preparing…" : "Approve & Continue";

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={phase !== "idle"}
        aria-busy={phase !== "idle"}
        className="self-start rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="sign-approve-and-continue-button"
      >
        {label}
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-approve-and-continue-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
