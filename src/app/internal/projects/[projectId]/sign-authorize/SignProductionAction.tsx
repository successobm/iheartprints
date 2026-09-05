"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";
import { resolveSignProductionCtaState } from "./sign-production-cta-state";

/**
 * LIVE PRODUCT BLOCKER #4B: "Prepare artwork" — deliberately separate from
 * `SignAuthorizeButton`'s "Authorize plan". This MAY create/enqueue a
 * `FinalArtworkJob` (through the existing, already-built
 * `requestSignFinalArtwork`); authorizing never does.
 *
 * No elaborate progress UX: while a job is in flight this shows one line
 * ("Preparing artwork…") and polls by re-running the page's own Server
 * Component (`router.refresh()`) every few seconds — the same
 * re-fetch-authoritative-state approach `SignAuthorizeButton` uses after a
 * click, just on a timer instead of once. The interval clears the moment
 * the server reports the job is no longer in flight.
 *
 * FIX AUTHORIZED SIGN PRODUCTION WORKSPACE CTA: the "what to show" decision
 * (print-ready / in-flight / prepare-vs-retry) is now `resolveSignProduction
 * CtaState` (`sign-production-cta-state.ts`) — a pure, byte-for-byte
 * behavior-preserving extraction, moved out purely so it can be tested
 * without a mounted `next/navigation` router. See that module's own doc
 * for the real investigation finding behind this task: the reported real
 * project was already showing the CORRECT "Try again" for a genuinely
 * failed job, not a misclassification.
 */
export function SignProductionAction({
  projectId,
  production,
}: {
  projectId: string;
  production: SignPlanOperatorProductionStatus;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!production.inFlight) return;
    const interval = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(interval);
  }, [production.inFlight, router]);

  async function handleClick() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/prepare`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setSubmitting(false);
        return;
      }
      // Re-fetch authoritative server state rather than assuming success.
      router.refresh();
      setSubmitting(false);
    } catch {
      setError("That didn't work. Please try again.");
      setSubmitting(false);
    }
  }

  const cta = resolveSignProductionCtaState(production);

  if (cta.kind === "print_ready") {
    return (
      <div className="flex flex-col gap-2" data-sign-production-ready>
        <p className="text-sm font-semibold text-ink">Print-ready</p>
        <a
          href={`/api/internal/projects/${projectId}/sign-artwork/download`}
          className="rounded-full bg-ink px-3.5 py-2 text-center text-sm font-medium text-white transition hover:bg-ink/90"
          data-testid="sign-download-link"
        >
          Download corrected artwork
        </a>
      </div>
    );
  }

  if (cta.kind === "in_flight") {
    return (
      <p className="text-sm text-muted" aria-busy="true" data-sign-production-processing>
        Preparing artwork…
      </p>
    );
  }

  if (cta.kind === "needs_qr_resolution") {
    // Fix QR Review UX Phase: deliberately no execution button here — the
    // QR resolution panel below already carries the correct next actions
    // ("Fix QR code"/"Print as supplied"/"Restore QR code"). No "Try
    // again": re-running the identical deterministic composition against
    // the identical immutable source would reproduce identical, still-
    // unresolved QR evidence every time.
    return (
      <p className="text-sm text-ink" data-sign-production-needs-attention>
        This artwork needs further review before it can be finalized.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {cta.needsAttentionNotice ? (
        <p className="text-sm text-ink" data-sign-production-needs-attention>
          This artwork needs further review before it can be finalized.
        </p>
      ) : null}
      <button
        type="button"
        onClick={handleClick}
        disabled={submitting}
        aria-busy={submitting}
        className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="sign-prepare-button"
      >
        {submitting ? "Preparing…" : cta.label === "try_again" ? "Try again" : "Prepare artwork"}
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-production-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
