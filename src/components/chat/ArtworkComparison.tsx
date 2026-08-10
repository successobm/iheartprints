"use client";

import { useState } from "react";

import {
  ArtworkPreviewModal,
  transparencySurfaceStyle,
} from "./ArtworkPreviewModal";

/**
 * Existing Artwork → Print Ready Phase 1: Original vs Prepared, side by side.
 *
 * Two properties this component exists to guarantee:
 *
 *   1. Both images are LABELLED. The customer must be able to tell at a
 *      glance which one is their upload and which one we produced — an
 *      unlabelled pair is how "we changed your artwork" becomes invisible.
 *   2. Enlarging is not approving. The enlarge control is a plain button that
 *      opens a read-only viewer with no approval action in it at all; the
 *      only way to approve is the explicit action the PARENT renders outside
 *      this component.
 *
 * The prepared tile renders on a transparency checkerboard so removed
 * background reads as genuinely removed, never as "we painted it white".
 */

export interface ArtworkComparisonImage {
  url: string | null;
  loading: boolean;
}

interface ArtworkComparisonProps {
  original: ArtworkComparisonImage;
  prepared: ArtworkComparisonImage;
}

export function ArtworkComparison({ original, prepared }: ArtworkComparisonProps) {
  const [enlarged, setEnlarged] = useState<"original" | "prepared" | null>(null);

  const enlargedUrl =
    enlarged === "original" ? original.url : enlarged === "prepared" ? prepared.url : null;

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ComparisonTile
          label="Original"
          caption="The artwork you uploaded, untouched."
          image={original}
          showCheckerboard={false}
          onEnlarge={() => setEnlarged("original")}
        />
        <ComparisonTile
          label="Prepared"
          caption="Background removed. The design itself is unchanged."
          image={prepared}
          showCheckerboard
          onEnlarge={() => setEnlarged("prepared")}
        />
      </div>

      {enlarged && enlargedUrl ? (
        <ArtworkPreviewModal
          title={enlarged === "original" ? "Original artwork" : "Prepared artwork"}
          url={enlargedUrl}
          showTransparencyCheckerboard={enlarged === "prepared"}
          onClose={() => setEnlarged(null)}
        />
      ) : null}
    </div>
  );
}

interface ComparisonTileProps {
  label: string;
  caption: string;
  image: ArtworkComparisonImage;
  showCheckerboard: boolean;
  onEnlarge: () => void;
}

function ComparisonTile({
  label,
  caption,
  image,
  showCheckerboard,
  onEnlarge,
}: ComparisonTileProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/8">
      <div
        className="flex h-48 items-center justify-center p-3"
        style={transparencySurfaceStyle(showCheckerboard)}
      >
        {image.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={`${label} artwork`}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-xs text-muted">
            {image.loading ? "Loading…" : "Preview unavailable"}
          </span>
        )}
      </div>
      <div className="flex items-start justify-between gap-3 border-t border-black/8 bg-white p-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink">
            {label}
          </p>
          <p className="mt-0.5 text-xs text-muted">{caption}</p>
        </div>
        {image.url ? (
          <button
            type="button"
            onClick={onEnlarge}
            aria-label={`Enlarge ${label.toLowerCase()} artwork`}
            className="shrink-0 rounded-full border border-black/10 px-2.5 py-1 text-xs text-muted transition hover:border-ink/30 hover:text-ink"
          >
            Enlarge
          </button>
        ) : null}
      </div>
    </div>
  );
}
