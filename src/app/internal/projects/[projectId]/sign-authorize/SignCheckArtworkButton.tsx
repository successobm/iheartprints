"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Internal Replan Action Phase: the operator's own way to invoke planning
 * for a project that is not reachable through the original customer's own
 * browser session — see `/api/internal/projects/[projectId]/sign-artwork
 * /plan`'s own doc comment for why this route exists. Calls that EXISTING
 * route — never a second planning mechanism — which itself calls the
 * identical `planSignArtwork` service function the customer's own "Check my
 * artwork" button calls.
 *
 * Mirrors `SignAuthorizeButton` exactly: on success, `router.refresh()`
 * re-runs the Server Component, re-reading durable project state from
 * scratch rather than optimistically assuming a plan now exists. Never
 * redirects — the operator stays on this exact page and sees it flip from
 * the no-plan state to the normal plan-review UI once a plan exists (or, for
 * a genuinely blocked artwork, the same no-plan state with nothing changed —
 * re-clicking is safe and deterministic either way, exactly like the
 * customer-facing action it mirrors).
 */
export function SignCheckArtworkButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/plan`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
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
        data-testid="sign-check-artwork-button"
      >
        {submitting ? "Checking…" : "Check this artwork"}
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-check-artwork-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
