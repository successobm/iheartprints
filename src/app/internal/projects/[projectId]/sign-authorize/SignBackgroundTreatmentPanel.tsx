"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SignBackgroundTreatment } from "@/capabilities/sign-preparation";

/**
 * Constitution amendment 3.2 (§16A.2): the operator-facing Background
 * choice. Mirrors `SignCheckArtworkButton`'s pattern exactly — calls the
 * internal `background-treatment` route, then `router.refresh()` re-reads
 * durable state from scratch rather than assuming success. Deliberately
 * does NOT trigger re-planning itself: a treatment change is a durable
 * decision on its own, and the operator's next explicit "Check this
 * artwork" (or composition-plan action) is what actually consumes it —
 * this keeps "changing the treatment invalidates a stale candidate" true
 * by construction rather than by this component racing a re-plan call.
 *
 * Customer-facing vocabulary only — no "alpha"/"segmentation"/"flood
 * fill"/"reconstruction" anywhere in this file.
 */
export function SignBackgroundTreatmentPanel({
  projectId,
  backgroundTreatment,
  backgroundRemovalStatus,
}: {
  projectId: string;
  backgroundTreatment: SignBackgroundTreatment;
  backgroundRemovalStatus: "removed" | "already_transparent" | "no_visible_artwork" | "review_required" | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<SignBackgroundTreatment | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function select(treatment: SignBackgroundTreatment) {
    if (submitting || treatment === backgroundTreatment) return;
    setSubmitting(treatment);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/background-treatment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ treatment }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setSubmitting(null);
        return;
      }
      router.refresh();
      setSubmitting(null);
    } catch {
      setError("That didn't work. Please try again.");
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-ink/10 pt-3" data-sign-background-treatment-panel>
      <p className="text-xs font-medium text-ink/60">Background</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => select("keep")}
          disabled={submitting !== null}
          aria-pressed={backgroundTreatment === "keep"}
          className={`rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
            backgroundTreatment === "keep"
              ? "border-ink bg-ink text-white"
              : "border-ink/20 text-ink hover:border-ink/40"
          }`}
          data-testid="sign-background-treatment-keep"
        >
          {submitting === "keep" ? "Keeping…" : "Keep background"}
        </button>
        <button
          type="button"
          onClick={() => select("remove")}
          disabled={submitting !== null}
          aria-pressed={backgroundTreatment === "remove"}
          className={`rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
            backgroundTreatment === "remove"
              ? "border-ink bg-ink text-white"
              : "border-ink/20 text-ink hover:border-ink/40"
          }`}
          data-testid="sign-background-treatment-remove"
        >
          {submitting === "remove" ? "Removing…" : "Remove background"}
        </button>
      </div>
      <p className="text-xs text-ink/60">
        {backgroundTreatment === "keep"
          ? "Preserve the artwork exactly as supplied."
          : describeBackgroundRemovalStatusForOperator(backgroundRemovalStatus)}
      </p>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-background-treatment-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describeBackgroundRemovalStatusForOperator(
  status: "removed" | "already_transparent" | "no_visible_artwork" | "review_required" | null,
): string {
  switch (status) {
    case "removed":
      return "The background has been removed.";
    case "already_transparent":
      return "This artwork already has a transparent background — nothing further to remove.";
    case "no_visible_artwork":
      return "We couldn't find visible artwork to isolate from the background.";
    case "review_required":
      return "We can't remove this background automatically. A designer needs to look at it first.";
    case null:
      return "Remove the exterior background and make it transparent.";
  }
}
