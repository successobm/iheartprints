"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Signs QR Visual Revision Acceptance: the artwork's QR code was replaced
 * with a real, working one — a visible edit to the customer's artwork,
 * not merely a technical fix. This panel is the one explicit approval
 * step for that revision, separate from (and required in addition to)
 * every technical QR/print-size check already passing.
 *
 * Deliberately no technical vocabulary in the rendered copy (`asset id`,
 * `candidate`, `validate`, `machine_readable_content_preserved`) — mirrors
 * `SignQrPreservationPanel`'s own discipline. The large workspace canvas
 * above this panel already shows the EXACT candidate being approved (the
 * same `production-candidate` route `SignFitToProductionCorrectionTool`/
 * `SignCompareOriginal` already use once this candidate counts as
 * inspectable) — this panel only needs to explain WHY a review is needed
 * and offer the one approval action.
 */
export function SignVisualAcceptancePanel({
  projectId,
  visualAcceptanceSatisfied,
  visualAcceptanceAcceptedAt,
}: {
  projectId: string;
  visualAcceptanceSatisfied: boolean;
  visualAcceptanceAcceptedAt: string | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/visual-acceptance`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setSubmitting(false);
        return;
      }
      router.refresh();
      setSubmitting(false);
    } catch {
      setError("That didn't work. Please try again.");
      setSubmitting(false);
    }
  }

  if (visualAcceptanceSatisfied) {
    return (
      <section className="flex flex-col gap-1 rounded-lg border border-ink/10 p-3" data-sign-visual-acceptance-panel>
        <h3 className="text-sm font-semibold text-ink">Revised artwork</h3>
        <p className="text-sm text-ink" data-sign-visual-acceptance-status="accepted">
          Approved{visualAcceptanceAcceptedAt ? ` on ${new Date(visualAcceptanceAcceptedAt).toLocaleString()}` : ""}.
        </p>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
      data-sign-visual-acceptance-panel
    >
      <h3 className="text-sm font-semibold text-ink">Revised artwork needs approval</h3>
      <p className="text-sm text-ink">
        The QR code in this artwork was replaced with a working one. Review the revised artwork above before
        approving it for print.
      </p>
      <div>
        <button
          type="button"
          onClick={() => void handleApprove()}
          disabled={submitting}
          aria-busy={submitting}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-visual-acceptance-approve-button"
        >
          {submitting ? "Approving…" : "Approve revised artwork"}
        </button>
      </div>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-visual-acceptance-error>
          {error}
        </p>
      ) : null}
    </section>
  );
}
