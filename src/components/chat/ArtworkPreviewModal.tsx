"use client";

import { useEffect, type CSSProperties, type MouseEvent } from "react";

import { GUIDED_CLEANUP_COPY } from "@/capabilities/artwork-preparation";
import {
  DEFAULT_PREVIEW_BACKGROUND,
  previewBackgroundSurfaceStyle,
  type PreviewBackground,
} from "./preview-background";

/**
 * Existing Artwork → Print Ready Phase 1: a full-size, READ-ONLY viewer for
 * one uploaded or prepared image.
 *
 * Deliberately has no action of any kind — no select, no approve, no
 * cleanup, no callbacks other than `onClose`. Phase 1.4 keeps Enlarge as a
 * separate view-only path; interactive cleanup lives in
 * `GuidedCleanupWorkspace`. Viewing can never approve or mutate.
 *
 * Phase 1.5: prepared enlarge may reuse the compare QA Preview Background
 * (solid White / Gray / Black). That remains presentation-only.
 */

interface ArtworkPreviewModalProps {
  title: string;
  url: string;
  /**
   * Legacy checkerboard flag. Prefer `previewBackground` for prepared
   * inspection; when a QA background is provided it wins.
   */
  showTransparencyCheckerboard: boolean;
  /** Solid QA inspection surface for prepared artwork enlarge. */
  previewBackground?: PreviewBackground;
  onClose: () => void;
}

export function ArtworkPreviewModal({
  title,
  url,
  showTransparencyCheckerboard,
  previewBackground,
  onClose,
}: ArtworkPreviewModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  const surfaceStyle = previewBackground
    ? previewBackgroundSurfaceStyle(previewBackground)
    : transparencySurfaceStyle(showTransparencyCheckerboard);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 sm:p-8"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Full preview of ${title}`}
        className="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
        >
          ×
        </button>

        <div
          className="flex min-h-[45vh] flex-1 items-center justify-center p-4 sm:p-8"
          data-preview-background={previewBackground ?? undefined}
          style={surfaceStyle}
        >
          {/* `object-contain`, never `cover` — the customer is here to check
              that their whole artwork survived, so it must never be cropped. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={title}
            className="max-h-[70vh] max-w-full object-contain"
          />
        </div>

        <div className="border-t border-black/8 p-4">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {GUIDED_CLEANUP_COPY.viewOnlyHint}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The same checkerboard `ConceptPreviewModal` uses, shared here as an
 * exported helper so legacy surfaces that still need a checkerboard can
 * render transparency consistently. Phase 1.5 prepared inspection prefers
 * {@link previewBackgroundSurfaceStyle} (White / Gray / Black).
 */
export function transparencySurfaceStyle(
  showCheckerboard: boolean,
): CSSProperties {
  if (!showCheckerboard) return { backgroundColor: "#f7f7f5" };
  return {
    backgroundImage:
      "linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)",
    backgroundSize: "20px 20px",
    backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
    backgroundColor: "#f7f7f5",
  };
}

// Re-export so callers that already import from this module can find the
// Phase 1.5 default without a second import path.
export { DEFAULT_PREVIEW_BACKGROUND };
