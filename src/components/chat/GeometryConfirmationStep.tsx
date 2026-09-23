"use client";

/**
 * Phase R6A (Geometry-Qualified Clean Master v1): "Check the cleaned
 * artwork" — the customer's lightweight, POST-geometry-normalization
 * confirmation. Deliberately NOT `ArtworkFidelityConfirmationStep` ("Confirm
 * what's in your artwork") and NOT another
 * `ArtworkReconstructionReviewStep` ("Review your rebuilt artwork"): those
 * establish source truth and approve the rebuilt artwork's APPEARANCE,
 * both already resolved by the time this step is ever reached
 * (`deriveUploadedArtworkStep` only returns `"review_geometry"` once
 * reconstruction review has resolved). This step confirms only that
 * deterministic background/canvas normalization did not remove or crop
 * artwork incorrectly — a genuinely narrower, different question.
 *
 * Hides all implementation jargon (no "geometry", "qualification",
 * "classifier", "candidate", "asset", "provider", "content bounds",
 * "alpha") — mirrors `ArtworkReconstructionReviewStep`'s own "no
 * implementation term appears anywhere in rendered text" discipline.
 * Styling classes are copied from that same component's already-shipped
 * controls, never a new visual design.
 */

import type { ReactNode } from "react";

export const GEOMETRY_CONFIRMATION_HEADLINE = "Check the cleaned artwork";
export const GEOMETRY_CONFIRMATION_DETAIL =
  "We removed the outside background and prepared the artwork boundaries. Make sure the full design is still visible.";

function GeometryConfirmationProcessing(props: { children?: ReactNode }) {
  return (
    <section
      aria-label="Preparing your artwork"
      aria-busy="true"
      className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
      data-geometry-confirmation-processing
    >
      <div className="flex items-start gap-3" role="status">
        <span
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-black/20 border-t-ink"
        />
        <div>
          <p className="text-sm font-semibold text-ink">Preparing your artwork…</p>
          <p className="mt-1 text-sm text-muted">This will only take a moment.</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

export interface GeometryConfirmationStepProps {
  /** `null` until the normalized derivative image resolves — never blocks rendering, mirrors `ArtworkReconstructionReviewStep`'s own "Loading…" placeholder. */
  candidateImageUrl: string | null;
  /** True while the derivative itself is still being computed (backfill/first-load) — a spinner, mirrors `ArtworkReconstructionProcessing`. */
  preparing?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onReject: () => void;
}

/**
 * Reached only once a geometry qualification exists and is
 * `"normalized_pending_confirmation"` — see `deriveUploadedArtworkStep`'s
 * own `"review_geometry"` gating. Deliberately no "Continue without
 * checking" escape hatch: unlike reconstruction (which is customer-
 * initiated and optional), this step only ever appears after the customer
 * already chose to rebuild their artwork, so it is a short, mandatory,
 * one-question stop — never a dead end (the secondary action always
 * proceeds to a safe stopped state, never traps the customer).
 */
export function GeometryConfirmationStep(props: GeometryConfirmationStepProps) {
  const { busy } = props;

  if (props.preparing) {
    return <GeometryConfirmationProcessing />;
  }

  return (
    <section
      aria-label="Check the cleaned artwork"
      className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      <p className="text-sm font-semibold text-ink">{GEOMETRY_CONFIRMATION_HEADLINE}</p>
      <p className="mt-1 text-sm text-muted">{GEOMETRY_CONFIRMATION_DETAIL}</p>

      <div className="mt-3">
        {props.candidateImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={props.candidateImageUrl}
            alt="Your cleaned artwork"
            className="mt-1 w-full rounded-xl border border-black/10"
          />
        ) : (
          <p className="mt-1 text-xs text-muted">Loading…</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={busy}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="geometry-confirmation-confirm-button"
        >
          Looks good — continue
        </button>
        <button
          type="button"
          onClick={props.onReject}
          disabled={busy}
          className="rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="geometry-confirmation-reject-button"
        >
          Something is missing
        </button>
      </div>
    </section>
  );
}
