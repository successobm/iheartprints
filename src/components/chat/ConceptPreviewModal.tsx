"use client";

import { useEffect, useRef, useState } from "react";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import type { ConceptImageState } from "./concept-image-fetch-controller";
import { ConceptPreviewBackgroundControl } from "./ConceptPreviewBackgroundControl";
import {
  conceptPreviewModeLabel,
  conceptPreviewSurfaceStyle,
  defaultConceptPreviewMode,
  type ConceptPreviewMode,
  type GarmentPreviewResolution,
} from "./concept-preview-surface";

interface ConceptPreviewModalProps {
  concept: CustomerArtworkVersion;
  image: ConceptImageState | undefined;
  isSelected: boolean;
  canSelect: boolean;
  busy: boolean;
  garmentPreview: GarmentPreviewResolution;
  onSelect: (artworkVersionId: string) => void;
  onClose: () => void;
}

/**
 * Live Acceptance Corrective Pass (Section 6) + Phase 2D garment preview:
 * full-size, read-only preview. Opening/closing never selects. Background
 * switching is local presentation state only — never mutates assets,
 * selection, evaluation, or paid generation.
 *
 * Remount via `key={concept.id}` from ConceptCards so each open starts on
 * the default garment/transparency surface without syncing mode in an effect.
 */
export function ConceptPreviewModal({
  concept,
  image,
  isSelected,
  canSelect,
  busy,
  garmentPreview,
  onSelect,
  onClose,
}: ConceptPreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [previewMode, setPreviewMode] = useState<ConceptPreviewMode>(() =>
    defaultConceptPreviewMode(garmentPreview),
  );

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

  const surfaceLabel = conceptPreviewModeLabel(previewMode, garmentPreview);

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

        {/* Presentation-only surface — garment color, inspection solids, or
            checkerboard. Artwork bytes and alpha are never rewritten.
            `object-contain`, never `cover` — whole design must be visible. */}
        <div
          className="flex min-h-[45vh] flex-1 items-center justify-center p-4 sm:p-8"
          style={conceptPreviewSurfaceStyle(previewMode, garmentPreview)}
          data-concept-preview-surface={previewMode}
          aria-label={surfaceLabel}
        >
          {image?.status === "ready" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image.url}
              alt={concept.title}
              className="max-h-[70vh] max-w-full object-contain"
              data-concept-preview-src={image.url}
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

        <div className="space-y-3 border-t border-black/8 p-4">
          <ConceptPreviewBackgroundControl
            value={previewMode}
            onChange={setPreviewMode}
            resolution={garmentPreview}
            idPrefix={`concept-preview-${concept.id}`}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{concept.title}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                {concept.summary}
              </p>
              <p className="mt-1 text-[11px] text-muted">{surfaceLabel}</p>
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
    </div>
  );
}
