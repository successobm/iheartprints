"use client";

import { useEffect, useRef, useState } from "react";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { ConceptPreviewModal } from "./ConceptPreviewModal";
import {
  createConceptImageFetchController,
  type ConceptImageState,
} from "./concept-image-fetch-controller";
import {
  conceptCardGarmentHint,
  conceptCardsGridClassName,
  conceptPreviewSurfaceStyle,
  resolveGarmentPreviewColor,
  shortConceptSetNote,
  type ConceptPreviewSurfaceInput,
  type GarmentPreviewResolution,
} from "./concept-preview-surface";

interface ConceptCardsProps {
  concepts: CustomerArtworkVersion[];
  projectId: string;
  selectedId: string | null;
  selectable: boolean;
  busy: boolean;
  onSelect: (artworkVersionId: string) => void;
  /** Approved brief garment / product context for presentation-only preview. */
  garmentPreviewInput?: ConceptPreviewSurfaceInput | null;
  /** Phase 2C withheld count from concepts_ready message metadata. */
  conceptsWithheld?: number | null;
  /** When false, skip short-set honesty note (e.g. design-history batches). */
  showShortSetNote?: boolean;
}

/**
 * Sprint 2K Phase 1: a concept with `hasImage: false` never gets an entry
 * here at all — it renders the fallback placeholder immediately, same as
 * every concept did before this sprint. A concept with `hasImage: true` and
 * no entry yet is implicitly "loading"; `"ready"` renders the real
 * generated image; `"unavailable"` falls back to the same placeholder.
 *
 * Phase 2D: apparel concepts preview on the selected garment color (CSS
 * only). Short sets explain withheld concepts without internal reason codes.
 */

async function fetchConceptImageUrl(
  projectId: string,
  artworkVersionId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/projects/${projectId}/concepts/${artworkVersionId}/image`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { url?: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}

export function ConceptCards({
  concepts,
  projectId,
  selectedId,
  selectable,
  busy,
  onSelect,
  garmentPreviewInput = null,
  conceptsWithheld = null,
  showShortSetNote = true,
}: ConceptCardsProps) {
  const [images, setImages] = useState<Record<string, ConceptImageState>>({});
  // Persists across Strict Mode's mount → cleanup → mount double-invoke in
  // development (and across ordinary re-renders) — see
  // concept-image-fetch-controller.ts for why this can't just be `useRef`
  // of a plain `Set` managed inline in the effect anymore (Workstream D).
  const controllerRef = useRef(createConceptImageFetchController());
  // A signed URL can go stale (expiry, or a worker retry that replaced the
  // asset) — allow exactly one silent re-fetch per concept before settling
  // on the fallback placeholder, so refresh/renewal stays automatic without
  // ever retrying forever.
  const retriedRef = useRef<Set<string>>(new Set());
  // Live Acceptance Corrective Pass (Section 6): purely local viewer
  // state — which concept, if any, is being previewed full-size. Never
  // read/written anywhere else; opening or closing it never calls
  // `onSelect` or touches any server state.
  const [previewId, setPreviewId] = useState<string | null>(null);

  const garmentPreview: GarmentPreviewResolution = resolveGarmentPreviewColor(
    garmentPreviewInput ?? {},
  );
  const garmentHint = conceptCardGarmentHint(garmentPreview);
  const cardSurfaceStyle = conceptPreviewSurfaceStyle(
    garmentPreview.useGarmentPreview ? "garment" : "transparency",
    garmentPreview,
  );
  const shortSetNote =
    showShortSetNote
      ? shortConceptSetNote({
          visibleCount: concepts.length,
          conceptsWithheld,
        })
      : null;

  useEffect(() => {
    return controllerRef.current.start(
      concepts,
      (id) => images[id],
      (id, state) => setImages((prev) => ({ ...prev, [id]: state })),
      (id) => fetchConceptImageUrl(projectId, id),
    );
    // Re-run only when the actual set of concepts (and their image
    // readiness) changes — not on every unrelated snapshot/selection update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, concepts.map((concept) => `${concept.id}:${concept.hasImage}`).join(",")]);

  function handleImageError(conceptId: string) {
    if (retriedRef.current.has(conceptId)) {
      setImages((prev) => ({ ...prev, [conceptId]: { status: "unavailable" } }));
      return;
    }
    retriedRef.current.add(conceptId);
    setImages((prev) => {
      const next = { ...prev };
      delete next[conceptId];
      return next;
    });
    void fetchConceptImageUrl(projectId, conceptId).then((url) => {
      setImages((prev) => ({
        ...prev,
        [conceptId]: url ? { status: "ready", url } : { status: "unavailable" },
      }));
    });
  }

  if (concepts.length === 0) return null;

  return (
    <div>
      {shortSetNote ? (
        <p
          className="mt-3 text-xs leading-relaxed text-muted"
          data-concept-short-set-note="true"
          role="status"
        >
          {shortSetNote}
        </p>
      ) : null}
      <div
        className={conceptCardsGridClassName(concepts.length)}
        data-concept-card-count={concepts.length}
      >
        {concepts.map((concept) => {
          const isSelected = selectedId === concept.id || concept.isSelected;
          const canSelect = selectable && !busy && !isSelected;
          const image = concept.hasImage ? images[concept.id] : undefined;
          const isLoading = concept.hasImage && image === undefined;

          return (
            <div key={concept.id} className="relative">
              <button
                type="button"
                disabled={!canSelect}
                onClick={() => onSelect(concept.id)}
                className={[
                  "group relative block w-full overflow-hidden rounded-2xl border text-left transition",
                  isSelected
                    ? "border-ink bg-white shadow-sm"
                    : "border-black/8 bg-white hover:border-black/20",
                  canSelect ? "cursor-pointer" : "cursor-default",
                ].join(" ")}
              >
                <div
                  className="relative h-36 overflow-hidden"
                  style={
                    image?.status === "ready"
                      ? cardSurfaceStyle
                      : { backgroundColor: "rgba(0,0,0,0.05)" }
                  }
                  data-concept-card-surface={
                    garmentPreview.useGarmentPreview ? "garment" : "transparency"
                  }
                >
                  {image?.status === "ready" ? (
                    // Signed, short-lived, per-request URL from AssetCapability —
                    // never a static path, so next/image's remote-pattern
                    // allowlisting doesn't apply here.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={image.url}
                      alt={concept.title}
                      className="h-full w-full object-cover"
                      onError={() => handleImageError(concept.id)}
                    />
                  ) : (
                    <div
                      className="flex h-full items-center justify-center"
                      style={{
                        background: `linear-gradient(145deg, ${concept.accentColor}22, ${concept.accentColor}55)`,
                      }}
                    >
                      {isLoading ? (
                        <span className="text-xs font-medium text-white/90">
                          Loading…
                        </span>
                      ) : (
                        <div
                          className="flex h-20 w-20 items-center justify-center rounded-full text-sm font-semibold text-white shadow-sm"
                          style={{ backgroundColor: concept.accentColor }}
                        >
                          {concept.placeholderLabel.replace("Concept ", "")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{concept.title}</p>
                    {isSelected ? (
                      <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                        Selected
                      </span>
                    ) : null}
                  </div>
                  {garmentHint ? (
                    <p className="text-[11px] text-muted">{garmentHint}</p>
                  ) : null}
                  <p className="text-xs leading-relaxed text-muted">{concept.summary}</p>
                </div>
              </button>
              {/* Live Acceptance Corrective Pass (Section 6): viewing the whole
                  design must never select it. This is a SIBLING of the card
                  button, never a child of it — nesting one button inside
                  another is invalid interactive content, and both ways it bit
                  us live are why this structure is load-bearing: the card's
                  own click handler could still fire from a click on a
                  expand control, and once the card was `disabled` (anything
                  already selected) the browser stopped dispatching clicks to
                  everything inside it, leaving the revised concept impossible
                  to enlarge. As a sibling, expanding is independent of
                  whether selection is currently allowed. */}
              <button
                type="button"
                onClick={() => setPreviewId(concept.id)}
                aria-label={`View ${concept.title} full size`}
                // Always visible (not hover-only) so it's discoverable on
                // touch devices, not just desktop hover.
                className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-xs text-white transition hover:bg-black/70"
              >
                ⤢
              </button>
            </div>
          );
        })}
      </div>

      {previewId
        ? (() => {
            const previewConcept = concepts.find((c) => c.id === previewId);
            if (!previewConcept) return null;
            const isSelected =
              selectedId === previewId || previewConcept.isSelected;
            const canSelect = selectable && !busy && !isSelected;
            return (
              <ConceptPreviewModal
                key={previewConcept.id}
                concept={previewConcept}
                image={
                  previewConcept.hasImage
                    ? images[previewConcept.id]
                    : undefined
                }
                isSelected={isSelected}
                canSelect={canSelect}
                busy={busy}
                garmentPreview={garmentPreview}
                onSelect={(id) => {
                  onSelect(id);
                  setPreviewId(null);
                }}
                onClose={() => setPreviewId(null)}
              />
            );
          })()
        : null}
    </div>
  );
}
