"use client";

import { useEffect, useRef } from "react";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import type { ConceptImageState } from "./concept-image-fetch-controller";

interface ConceptPreviewModalProps {
  concept: CustomerArtworkVersion;
  image: ConceptImageState | undefined;
  isSelected: boolean;
  canSelect: boolean;
  busy: boolean;
  onSelect: (artworkVersionId: string) => void;
  onClose: () => void;
}

/**
 * Live Acceptance Corrective Pass (Section 6): a full-size, read-only
 * preview of one concept — the concept cards themselves crop artwork with
 * `object-cover`, which never lets the customer inspect the whole design
 * before choosing it. This is purely a viewer: opening or closing it never
 * selects a concept or mutates any lifecycle state — selection only ever
 * happens through the explicit "Select this concept" action inside it
 * (identical to clicking the card), never merely from viewing.
 */
export function ConceptPreviewModal({
  concept,
  image,
  isSelected,
  canSelect,
  busy,
  onSelect,
  onClose,
}: ConceptPreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Full preview of ${concept.title}`}
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

        {/* Neutral checkerboard surface so transparency in the artwork
            stays visible (the artwork itself is print-ready-track PNG with
            a transparent background), never a solid color that could hide
            or fake a background. `object-contain`, never `cover` — the
            whole design must be visible, never cropped. */}
        <div
          className="flex min-h-[45vh] flex-1 items-center justify-center p-4 sm:p-8"
          style={{
            backgroundImage:
              "linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)",
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
            backgroundColor: "#f7f7f5",
          }}
        >
          {image?.status === "ready" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image.url}
              alt={concept.title}
              className="max-h-[70vh] max-w-full object-contain"
            />
          ) : (
            <div
              className="flex h-40 w-40 items-center justify-center rounded-full text-lg font-semibold text-white shadow-sm"
              style={{ backgroundColor: concept.accentColor }}
            >
              {concept.placeholderLabel.replace("Concept ", "")}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/8 p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{concept.title}</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{concept.summary}</p>
          </div>
          {isSelected ? (
            <span className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-white">
              Selected
            </span>
          ) : canSelect ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSelect(concept.id)}
              className="shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Select this concept
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
