"use client";

import { useState } from "react";

import {
  ArtworkPreviewModal,
  transparencySurfaceStyle,
} from "./ArtworkPreviewModal";
import { PreviewBackgroundControl } from "./PreviewBackgroundControl";
import {
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_BACKGROUND_COPY,
  previewBackgroundSurfaceStyle,
  type PreviewBackground,
} from "./preview-background";

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
 * Phase 1.5: the Prepared tile uses a White / Gray / Black QA Preview
 * Background (CSS under the transparent PNG). The Original tile stays a
 * faithful upload display and is not rewritten by the QA control. Switching
 * backgrounds never approves and never changes asset URLs.
 *
 * Phase 1.4: guided cleanup no longer lives on the small prepared tile.
 * Interactive cleanup opens in `GuidedCleanupWorkspace`. Enlarge remains a
 * separate read-only inspection path so viewing never silently becomes
 * editing.
 */

export interface ArtworkComparisonImage {
  url: string | null;
  loading: boolean;
}

interface ArtworkComparisonProps {
  original: ArtworkComparisonImage;
  prepared: ArtworkComparisonImage;
  /**
   * Intelligent Separation Phase 3: true when the server's preparation
   * review evidence (`preparedReview.reviewRequired`) recommends a closer
   * look. Adds ONE extra sentence encouraging the existing three-surface
   * check — never a new surface, never a default change, never a claim
   * about what checking will find.
   */
  reviewRequired?: boolean;
}

export function ArtworkComparison({
  original,
  prepared,
  reviewRequired = false,
}: ArtworkComparisonProps) {
  const [enlarged, setEnlarged] = useState<"original" | "prepared" | null>(null);
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>(
    DEFAULT_PREVIEW_BACKGROUND,
  );

  const enlargedUrl =
    enlarged === "original" ? original.url : enlarged === "prepared" ? prepared.url : null;

  return (
    <div>
      <div className="mb-2 space-y-1">
        <PreviewBackgroundControl
          idPrefix="compare-preview-bg"
          value={previewBackground}
          onChange={setPreviewBackground}
        />
        <p className="text-xs text-muted">{PREVIEW_BACKGROUND_COPY.helper}</p>
        {reviewRequired ? (
          <p className="text-xs text-muted">{PREVIEW_BACKGROUND_COPY.reviewEmphasis}</p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ComparisonTile
          label="Original"
          caption="The artwork you uploaded, untouched."
          image={original}
          surface="original"
          onEnlarge={() => setEnlarged("original")}
        />
        <ComparisonTile
          label="Prepared"
          // The Original tile's "untouched" claim is true and stays. This one
          // cannot make the same promise: removal takes background-coloured
          // pixels that reach the border, and a design element drawn in that
          // colour and touching the background goes with them.
          caption="Background removed. Check your design before continuing."
          image={prepared}
          surface="prepared"
          previewBackground={previewBackground}
          onEnlarge={() => setEnlarged("prepared")}
        />
      </div>

      {enlarged && enlargedUrl ? (
        <ArtworkPreviewModal
          title={enlarged === "original" ? "Original artwork" : "Prepared artwork"}
          url={enlargedUrl}
          showTransparencyCheckerboard={false}
          previewBackground={
            enlarged === "prepared" ? previewBackground : undefined
          }
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
  surface: "original" | "prepared";
  previewBackground?: PreviewBackground;
  onEnlarge: () => void;
}

function ComparisonTile({
  label,
  caption,
  image,
  surface,
  previewBackground,
  onEnlarge,
}: ComparisonTileProps) {
  const surfaceStyle =
    surface === "prepared" && previewBackground
      ? previewBackgroundSurfaceStyle(previewBackground)
      : transparencySurfaceStyle(false);

  return (
    <div className="overflow-hidden rounded-xl border border-black/8">
      <div
        className="flex h-48 items-center justify-center p-3"
        data-comparison-surface={surface}
        data-preview-background={
          surface === "prepared" ? previewBackground : undefined
        }
        style={surfaceStyle}
      >
        {image.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={`${label} artwork`}
            data-comparison-image={surface}
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
          {surface === "prepared" ? (
            <p className="mt-1 text-[11px] text-muted">
              Inspection background:{" "}
              {previewBackground
                ? PREVIEW_BACKGROUND_COPY.options[previewBackground]
                : PREVIEW_BACKGROUND_COPY.options.white}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-muted">
              Shown as uploaded
            </p>
          )}
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
