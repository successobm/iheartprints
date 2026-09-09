"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";
import {
  hasSignPreparationPollingTimedOut,
  resolveSignProductionCtaState,
  SIGN_PREPARATION_POLL_INTERVAL_MS,
} from "./sign-production-cta-state";

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
 * "Preparing Artwork" Never Spins Forever Phase (real production blocker):
 * that polling loop used to have no upper bound — a job that never gets
 * claimed by the independent worker layer (see `docs/deployment/final-
 * artwork-worker.md`; the web process is never itself the worker in
 * production) left the operator staring at "Preparing artwork…"
 * indefinitely, with no way to tell a genuinely-still-processing job apart
 * from one that will never move. Once `hasSignPreparationPollingTimedOut`
 * (`sign-production-cta-state.ts`) says enough time has passed with no
 * observed transition, polling stops and this renders an honest "taking
 * longer than expected" state with a manual "Check again" — never a false
 * "failed" claim (the job may still be legitimately queued/running), and
 * never a second POST to `/prepare` (that would only reconfirm the exact
 * SAME idempotently-reused job, never actually make it run any sooner).
 * "Check again" re-arms a fresh polling window rather than a one-shot
 * check, so a job that finishes shortly after is still picked up
 * automatically.
 *
 * FIX AUTHORIZED SIGN PRODUCTION WORKSPACE CTA: the "what to show" decision
 * (print-ready / in-flight / prepare-vs-retry) is now `resolveSignProduction
 * CtaState` (`sign-production-cta-state.ts`) — a pure, byte-for-byte
 * behavior-preserving extraction, moved out purely so it can be tested
 * without a mounted `next/navigation` router. See that module's own doc
 * for the real investigation finding behind this task: the reported real
 * project was already showing the CORRECT "Try again" for a genuinely
 * failed job, not a misclassification.
 *
 * Sign Production Review Print-Ready Authority Repair: this component no
 * longer renders anything for `cta.kind === "print_ready"` — the final
 * download is `SignPrintReadyDownload`, rendered by `page.tsx` at the very
 * BOTTOM of the workflow, after every validation/repair panel, never here
 * (Section G/H of that phase). Both components read the SAME
 * `resolveSignProductionCtaState(production)` — there is exactly one
 * authoritative "is this truly print ready" answer, never two independently
 * rendered opinions.
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
  const [pollingTimedOut, setPollingTimedOut] = useState(false);
  // Bumped by "Check again" to deliberately re-arm a fresh polling window
  // (fresh start time, fresh timeout) — the only reason this effect's own
  // dependency array includes a value nothing inside it reads directly.
  const [pollEpoch, setPollEpoch] = useState(0);

  useEffect(() => {
    // Deferred (not a direct synchronous call in the effect body) so a
    // fresh in-flight period — either a brand new attempt or "Check
    // again" re-arming this same one — never renders a stale "taking
    // longer than expected" left over from an earlier period.
    const resetTimer = setTimeout(() => setPollingTimedOut(false), 0);
    if (!production.inFlight) {
      return () => clearTimeout(resetTimer);
    }
    const inFlightStartedAtMs = Date.now();
    const interval = setInterval(() => {
      if (hasSignPreparationPollingTimedOut(inFlightStartedAtMs, Date.now())) {
        setPollingTimedOut(true);
        clearInterval(interval);
        return;
      }
      router.refresh();
    }, SIGN_PREPARATION_POLL_INTERVAL_MS);
    return () => {
      clearTimeout(resetTimer);
      clearInterval(interval);
    };
    // pollEpoch is a deliberate manual re-arm trigger ("Check again"), never read inside the effect itself.
  }, [production.inFlight, router, pollEpoch]);

  function checkAgain() {
    setPollingTimedOut(false);
    setPollEpoch((epoch) => epoch + 1);
    router.refresh();
  }

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
    // Sign Production Review Print-Ready Authority Repair: nothing renders
    // here — `SignPrintReadyDownload` (rendered by `page.tsx`, at the very
    // bottom of the workflow) owns the print-ready download presentation.
    return null;
  }

  if (cta.kind === "in_flight") {
    if (pollingTimedOut) {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink" data-sign-production-poll-timeout>
            This is taking longer than expected.
          </p>
          <button
            type="button"
            onClick={checkAgain}
            className="self-start rounded-full border border-ink/20 px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-ink/5"
            data-testid="sign-production-check-again-button"
          >
            Check again
          </button>
        </div>
      );
    }
    return (
      <p className="text-sm text-muted" aria-busy="true" data-sign-production-processing>
        Preparing artwork…
      </p>
    );
  }

  if (cta.kind === "needs_visual_acceptance") {
    // Signs QR Visual Revision Acceptance: deliberately no execution
    // button here — the visual acceptance panel below already carries the
    // one real next action ("Approve revised artwork"). No "Try again":
    // every technical check already passes; re-running the identical
    // deterministic composition would not change whether a human has
    // looked at the result.
    return (
      <p className="text-sm text-ink" data-sign-production-needs-attention>
        This artwork&apos;s QR code was replaced — review the revised artwork before it can be finalized.
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

  if (cta.kind === "needs_physical_resolution_repair") {
    // Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
    // Phase: deliberately no execution button here either — the physical-
    // resolution repair panel below carries the correct next action ("Fix
    // print size metadata"). No "Try again": re-running the identical
    // deterministic composition reproduces identical pixels whose embedded
    // print-size metadata already agrees — the density TAG is what needs
    // correcting, not the artwork.
    return (
      <p className="text-sm text-ink" data-sign-production-needs-attention>
        This artwork needs a print-size metadata correction before it can be finalized.
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
