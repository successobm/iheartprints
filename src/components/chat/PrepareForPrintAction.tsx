"use client";

import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import { PRINT_READY_WAITING_MESSAGE } from "@/capabilities/shared/waiting-copy";
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

  return (
    <div className="mt-3 space-y-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      {/* Size comes FIRST: it is the last decision still open, and it stops
          being changeable the moment the button below is pressed. */}
      {printReadySize && onChoosePrintWidth ? (
        <PrintReadySizeCard
          size={printReadySize}
          busy={busy}
          onChooseWidth={onChoosePrintWidth}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
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
    </div>
  );
}
