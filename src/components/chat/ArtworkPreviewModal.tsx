"use client";

import { useEffect } from "react";

/**
 * Existing Artwork → Print Ready Phase 1: a full-size, READ-ONLY viewer for
 * one uploaded or prepared image.
 *
 * Deliberately has no action of any kind — no select, no approve, no
 * callbacks other than `onClose`. `ConceptCards` shipped a bug where opening
 * a preview implicitly selected a concept; the structural fix there was to
 * make the enlarge control a sibling of the select control rather than a
 * descendant. Here the property is stronger and cheaper: approval simply does
 * not exist inside this component, so viewing can never approve.
 */

interface ArtworkPreviewModalProps {
  title: string;
  url: string;
  /** Prepared artwork renders on a checkerboard so real transparency is visible, never faked by a flat colour. */
  showTransparencyCheckerboard: boolean;
  onClose: () => void;
}

export function ArtworkPreviewModal({
  title,
  url,
  showTransparencyCheckerboard,
  onClose,
}: ArtworkPreviewModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

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
          style={transparencySurfaceStyle(showTransparencyCheckerboard)}
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
        </div>
      </div>
    </div>
  );
}

/**
 * The same checkerboard `ConceptPreviewModal` uses, shared here as an
 * exported helper so the comparison tiles and the enlarged view can never
 * render transparency differently from each other.
 */
export function transparencySurfaceStyle(
  showCheckerboard: boolean,
): React.CSSProperties {
  if (!showCheckerboard) return { backgroundColor: "#f7f7f5" };
  return {
    backgroundImage:
      "linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)",
    backgroundSize: "20px 20px",
    backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
    backgroundColor: "#f7f7f5",
  };
}
