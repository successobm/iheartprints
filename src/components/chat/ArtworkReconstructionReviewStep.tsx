"use client";

import { useState } from "react";

import type { ProtectedMarkType } from "@/lib/domain/types";
import type { ArtworkReconstructionView } from "@/lib/services/conversation-service";

/**
 * Phase R5 (Confirmed-Authority Raster Reconstruction v1): "Review your
 * rebuilt artwork" — the customer's POST-reconstruction compare/approve
 * surface. Deliberately a DIFFERENT confirmation from
 * `ArtworkFidelityConfirmationStep` ("Confirm what's in your artwork"):
 * that step establishes source TRUTH before reconstruction; this one asks
 * whether the REBUILT artwork faithfully represents it — never collapsed
 * into one confirmation (Section 17 of the R5 task).
 *
 * Hides implementation jargon (no "job", "provider", "contractKey", model
 * name, or geometry/aspect-ratio numbers) — mirrors
 * `ArtworkFidelityConfirmationStep`'s own "no implementation term appears
 * anywhere in rendered text" discipline. Styling classes are copied from
 * that same component's already-shipped controls (Production Acceptance
 * Defect precedent), never a new visual design.
 *
 * MARK CONFIRMATION: a machine `wordingVerified`/`geometryStatus` signal is
 * never sufficient on its own — when the confirmed contract named any
 * protected mark, approval is disabled until the customer explicitly
 * checks a box confirming they looked (Section R of the R5 task: R2/R3
 * proved automatic mark verification unreliable).
 */

export interface ArtworkReconstructionOfferBannerProps {
  busy?: boolean;
  /** "Rebuild my artwork" — the explicit customer request action (Section G/M: reconstruction is never auto-triggered). */
  onRequest: () => void;
  /** A lightweight "not now" — client-only, never a server call, mirrors `onSkip` on the fidelity step. */
  onDismiss: () => void;
}

/**
 * A small, secondary, non-step-changing prompt — rendered by
 * `UploadedArtworkPanel` ALONGSIDE whatever step is already showing (never
 * in place of it), only once fidelity is confirmed and no reconstruction
 * has been requested yet. Deliberately NOT part of the
 * `deriveUploadedArtworkStep` state machine: gating it on a durable/derived
 * step would re-offer reconstruction to every uploader and change the
 * existing, tested "confirmed fidelity falls straight through to the next
 * question" contract (see that function's own doc comment on this
 * check) — a banner that sits beside the current step, rather than
 * replacing it, avoids that entirely.
 */
export function ArtworkReconstructionOfferBanner(props: ArtworkReconstructionOfferBannerProps) {
  return (
    <section
      aria-label="Rebuild your artwork"
      className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      <p className="text-sm font-semibold text-ink">Rebuild your artwork</p>
      <p className="mt-1 text-sm text-muted">
        If your artwork looks low quality or pixelated, we can try to rebuild it before you
        continue.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={props.onRequest}
          disabled={props.busy}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="artwork-reconstruction-request-button"
        >
          Rebuild my artwork
        </button>
        <button
          type="button"
          onClick={props.onDismiss}
          disabled={props.busy}
          className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="artwork-reconstruction-dismiss-button"
        >
          Not now
        </button>
      </div>
    </section>
  );
}

export interface ArtworkReconstructionReviewStepProps {
  artworkReconstruction: ArtworkReconstructionView | null;
  /** The confirmed protected marks from the fidelity step — `null`/empty means no mark was confirmed present, so no explicit mark check is required here. */
  confirmedMarks: ProtectedMarkType[] | null;
  originalImageUrl: string | null;
  candidateImageUrl: string | null;
  busy?: boolean;
  /**
   * Phase R5-R (independent-review repair, Blocker 1): now takes the
   * customer's actual mark-confirmation state — the SERVER is what
   * enforces it (`RasterReconstructionCapability.approveCandidate` refuses
   * a missing/false attestation whenever the confirmed contract lists a
   * protected mark), but the button must actually transmit what the
   * customer attested to, not merely disable itself locally.
   */
  onApprove: (protectedMarksConfirmed: boolean) => void;
  onReject: () => void;
  onRetry: () => void;
  /** "Continue without rebuilding" — client-only, never a server call, mirrors `onSkip` on the fidelity step. */
  onDismiss: () => void;
}

const IN_PROGRESS_STATUSES = new Set(["queued", "running", "recoverable"]);

/**
 * Reached only once a reconstruction job actually exists (via
 * `ArtworkReconstructionOfferBanner`'s own "Rebuild my artwork" action) —
 * see `deriveUploadedArtworkStep`'s own `"review_reconstruction"` gating.
 * `artworkReconstruction === null` should not normally reach this
 * component at all; it renders nothing rather than an "offer" UI a
 * customer never asked for.
 */
export function ArtworkReconstructionReviewStep(props: ArtworkReconstructionReviewStepProps) {
  const { artworkReconstruction, confirmedMarks, busy } = props;
  const [markChecked, setMarkChecked] = useState(false);

  if (!artworkReconstruction) return null;

  const requiresMarkCheck = (confirmedMarks?.length ?? 0) > 0;
  const canApprove =
    !busy && artworkReconstruction.reviewStatus === "pending_review" && (!requiresMarkCheck || markChecked);

  if (IN_PROGRESS_STATUSES.has(artworkReconstruction.status)) {
    return (
      <section
        aria-label="Rebuilding your artwork"
        className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
      >
        <p className="text-sm font-semibold text-ink">Rebuilding your artwork</p>
        <p role="status" className="mt-1 text-sm text-muted">
          This can take a moment…
        </p>
        <div className="mt-4">
          <button
            type="button"
            onClick={props.onDismiss}
            className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            data-testid="artwork-reconstruction-dismiss-button"
          >
            Continue without rebuilding
          </button>
        </div>
      </section>
    );
  }

  if (artworkReconstruction.status === "failed") {
    return (
      <section
        aria-label="We couldn't rebuild your artwork"
        className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
      >
        <p className="text-sm font-semibold text-ink">We couldn&rsquo;t rebuild your artwork</p>
        <p
          role="alert"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Something went wrong while rebuilding your artwork. You can try again, or continue with
          your original.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={props.onRetry}
            disabled={busy}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="artwork-reconstruction-retry-button"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={props.onDismiss}
            className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            data-testid="artwork-reconstruction-dismiss-button"
          >
            Continue without rebuilding
          </button>
        </div>
      </section>
    );
  }

  // status === "completed" && reviewStatus === "pending_review"
  return (
    <section
      aria-label="Review your rebuilt artwork"
      className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      <p className="text-sm font-semibold text-ink">Review your rebuilt artwork</p>
      <p className="mt-1 text-sm text-muted">
        Compare your original artwork with the rebuilt version, then approve it or continue with
        your original.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-ink">Original</p>
          {props.originalImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={props.originalImageUrl}
              alt="Your original artwork"
              className="mt-1 w-full rounded-xl border border-black/10"
            />
          ) : (
            <p className="mt-1 text-xs text-muted">Loading…</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-ink">Rebuilt</p>
          {props.candidateImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={props.candidateImageUrl}
              alt="Your rebuilt artwork"
              className="mt-1 w-full rounded-xl border border-black/10"
            />
          ) : (
            <p className="mt-1 text-xs text-muted">Loading…</p>
          )}
        </div>
      </div>

      {artworkReconstruction.wordingVerified === false ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          We couldn&rsquo;t confirm that all the text in your rebuilt artwork matches your
          original exactly — please check it carefully before approving.
        </p>
      ) : artworkReconstruction.wordingVerified === null ? (
        <p className="mt-3 rounded-xl border border-black/10 bg-black/[0.03] p-3 text-sm text-muted">
          We couldn&rsquo;t automatically check the text in your rebuilt artwork — please check it
          carefully before approving.
        </p>
      ) : null}

      {artworkReconstruction.geometryStatus === "review_required" ? (
        <p className="mt-3 rounded-xl border border-black/10 bg-black/[0.03] p-3 text-sm text-muted">
          Please check that the proportions of your rebuilt artwork look correct before approving.
        </p>
      ) : null}

      {requiresMarkCheck ? (
        <label className="mt-3 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={markChecked}
            disabled={busy}
            onChange={(e) => setMarkChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-black/20 text-ink focus:ring-ink/40"
            data-testid="artwork-reconstruction-mark-check"
          />
          I&rsquo;ve checked that the {confirmedMarks?.join(", ")} symbol in the rebuilt artwork
          looks correct
        </label>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => props.onApprove(markChecked)}
          disabled={!canApprove}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="artwork-reconstruction-approve-button"
        >
          Use rebuilt artwork
        </button>
        <button
          type="button"
          onClick={props.onReject}
          disabled={busy}
          className="rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="artwork-reconstruction-reject-button"
        >
          Keep my original
        </button>
      </div>
    </section>
  );
}
