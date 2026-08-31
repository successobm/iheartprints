"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * LIVE PRODUCT BLOCKER #4A: the one action this page exists for — an
 * operator's explicit production-risk authorization of THIS exact plan.
 * Calls the EXISTING authorization route
 * (`POST /api/internal/projects/[projectId]/sign-artwork/authorize`) —
 * never a second authorization mechanism. On success, `router.refresh()`
 * re-runs the Server Component, re-reading the durable project state from
 * scratch — this never optimistically assumes authorization succeeded, and
 * never enqueues or starts any execution on its own.
 *
 * Deliberately does NOT redirect anywhere: unlike `ContinueAsInternalJob
 * Button`, authorizing a plan doesn't create a new project to land on —
 * the operator stays on this exact review page and sees it flip to
 * "Authorized".
 */
export function SignAuthorizeButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/authorize`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(describeAuthorizeError(body?.error ?? null));
        setSubmitting(false);
        return;
      }
      // Re-fetch authoritative server state rather than assuming success —
      // this re-runs the page's own Server Component read.
      router.refresh();
      setSubmitting(false);
    } catch {
      setError("That didn't work. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        aria-busy={submitting}
        className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="sign-authorize-button"
      >
        {submitting ? "Authorizing…" : "Authorize plan"}
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-authorize-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `SignPreparationStateError`/`SignArtworkBridgeError` messages are already
 * safe, non-technical sentences (see that class's own doc comment) — this
 * only replaces the ONE case with dedicated operator copy: a stale plan
 * (the server's own `authorizeSignRepairPlan` recomputed-key check), which
 * must never be silently retried as if it authorized the new plan.
 */
function describeAuthorizeError(serverMessage: string | null): string {
  if (serverMessage && /could not be verified|re-plan/i.test(serverMessage)) {
    return "The artwork plan changed and needs to be reviewed again.";
  }
  return serverMessage ?? "That didn't work. Please try again.";
}
