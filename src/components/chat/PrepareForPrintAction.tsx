"use client";

import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";

interface PrepareForPrintActionProps {
  finalizationStatus: CustomerFinalizationStatus;
  /** A concept must be selected, and current, before this renders at all. */
  canRequest: boolean;
  busy: boolean;
  onPrepare: () => void;
}

/**
 * Sprint 2M Phase 2B: the one explicit customer action that turns "I've
 * selected/revised a concept" into "prepare my final artwork" — the
 * boundary the Constitution requires between concept selection (revisable)
 * and a durable production commitment. Deliberately a single, always-visible
 * action rather than a confirmation dialog (Goal 11 — "do not add
 * unnecessary confirmation screens"; the button's own label already states
 * the commitment plainly).
 *
 * Customer-safe language only — never "finalize raster", "print
 * validation", "production asset", "vectorize", "upscale", "300 DPI", or
 * "execute final artwork job" (Goal 11).
 */
export function PrepareForPrintAction({
  finalizationStatus,
  canRequest,
  busy,
  onPrepare,
}: PrepareForPrintActionProps) {
  if (finalizationStatus === "preparing") {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-black/8 bg-white p-4 text-sm text-muted shadow-sm">
        <span className="inline-flex gap-1" aria-hidden="true">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse [animation-delay:150ms]">●</span>
          <span className="animate-pulse [animation-delay:300ms]">●</span>
        </span>
        Preparing your print-ready artwork…
      </div>
    );
  }

  if (finalizationStatus === "print_ready") {
    return (
      <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 shadow-sm">
        Your print-ready artwork is ready.
      </div>
    );
  }

  if (!canRequest) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      <p className="text-sm text-ink">
        This is the design you want? I can start preparing your print-ready
        artwork.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onPrepare}
        className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Prepare Print-Ready Artwork
      </button>
    </div>
  );
}
