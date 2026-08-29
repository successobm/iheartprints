"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { CHAT_PROJECT_STORAGE_KEY } from "@/components/chat/chat-session";

/**
 * Phase 28P: the one button this whole feature is for. On success, points
 * the SPA's own project-selection mechanism (`ChatApp.tsx` reads
 * `CHAT_PROJECT_STORAGE_KEY` from `localStorage` on load — there is no
 * `/projects/[id]` route to link to instead) at the new internal project
 * and navigates home, landing Eric directly on the continued artwork.
 */
export function ContinueAsInternalJobButton({ sourceProjectId }: { sourceProjectId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${sourceProjectId}/continue-as-internal-job`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as { newProjectId?: string; error?: string } | null;
      if (!res.ok || !body?.newProjectId) {
        setError(body?.error ?? "That didn't work. Please try again.");
        setSubmitting(false);
        return;
      }
      window.localStorage.setItem(CHAT_PROJECT_STORAGE_KEY, body.newProjectId);
      router.push("/");
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
        className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="continue-as-internal-job-button"
      >
        {submitting ? "Continuing…" : "Continue as Internal Job"}
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-continue-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
