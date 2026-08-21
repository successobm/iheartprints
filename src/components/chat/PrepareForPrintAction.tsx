"use client";

import type { GarmentSizeClass } from "@/lib/domain/types";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import {
  PRINT_READY_RETRY_ACTION_LABEL,
  PRINT_READY_RETRY_MESSAGE,
  PRINT_READY_RETRY_SUPPORTING_MESSAGE,
  PRINT_READY_WAITING_MESSAGE,
} from "@/capabilities/shared/waiting-copy";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";
import { PrintReadySizeCard } from "./PrintReadySizeCard";

interface PrepareForPrintActionProps {
  finalizationStatus: CustomerFinalizationStatus;
  /** A concept must be selected, and current, before this renders at all. */
  canRequest: boolean;
  busy: boolean;
  onPrepare: () => void;
  /**
   * Live Acceptance Cleanup (Issue 5): the physical size this artwork will
   * be prepared at, shown before the customer commits. `null` when there is
   * nothing honest to state (no print placement yet).
   */
  printReadySize?: PrintReadySizeView | null;
  onChoosePrintWidth?: (widthIn: number) => void;
  /** Print'em All Phase 1: "Use recommended size" — the one-click confirmation. */
  onUseRecommendedSize?: () => void;
  /** Print'em All Phase 1: the garment sizing context the recommendation is derived for. */
  onChooseGarmentSize?: (garmentSizeClass: GarmentSizeClass) => void;
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
  printReadySize = null,
  onChoosePrintWidth,
  onUseRecommendedSize,
  onChooseGarmentSize,
}: PrepareForPrintActionProps) {
  if (finalizationStatus === "preparing") {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-black/8 bg-white p-4 text-sm text-muted shadow-sm">
        <span className="inline-flex gap-1" aria-hidden="true">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse [animation-delay:150ms]">●</span>
          <span className="animate-pulse [animation-delay:300ms]">●</span>
        </span>
        {PRINT_READY_WAITING_MESSAGE}
      </div>
    );
  }

  if (finalizationStatus === "retryable_failure") {
    return (
      <div className="mt-3 space-y-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
        <p className="text-sm text-ink" role="alert">
          {PRINT_READY_RETRY_MESSAGE}
        </p>
        <p className="text-sm text-muted">{PRINT_READY_RETRY_SUPPORTING_MESSAGE}</p>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={onPrepare}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {PRINT_READY_RETRY_ACTION_LABEL}
        </button>
      </div>
    );
  }

  // print_ready is owned by FinalArtworkDeliveryCard — avoid a redundant
  // standalone success message here.
  if (finalizationStatus === "print_ready") {
    return null;
  }

  if (finalizationStatus === "needs_review") {
    return (
      <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
        We need to review your artwork before it can be finalized.
      </div>
    );
  }

  if (!canRequest) return null;

  // Print'em All Phase 1 (Goal 6): preparation is unavailable until a human
  // has confirmed the physical print size.
  //
  // The server refuses this independently — `requireConfirmedProductionSize`
  // throws before a job is created — so this changes no guarantee. What it
  // changes is honesty: offering a button we know will be refused reads as a
  // broken product, and the card directly above already says what to do about
  // it. Defaults to "not pending" when no size view is available at all, so
  // every caller that has not been wired up behaves exactly as before and the
  // server stays the only real gate.
  const sizeConfirmationPending = printReadySize
    ? !printReadySize.confirmed
    : false;

  return (
    <div className="mt-3 space-y-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      {/* Size comes FIRST: it is the last decision still open, and it stops
          being changeable the moment the button below is pressed. */}
      {printReadySize && onChoosePrintWidth ? (
        <PrintReadySizeCard
          size={printReadySize}
          busy={busy}
          onChooseWidth={onChoosePrintWidth}
          onUseRecommendedSize={onUseRecommendedSize}
          onChooseGarmentSize={onChooseGarmentSize}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink">
          This is the design you want? I can start preparing your print-ready
          artwork.
        </p>
        <button
          type="button"
          disabled={busy || sizeConfirmationPending}
          onClick={onPrepare}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Prepare Print-Ready Artwork
        </button>
      </div>
    </div>
  );
}
