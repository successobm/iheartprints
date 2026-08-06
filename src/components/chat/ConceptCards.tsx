"use client";

import { useEffect, useRef, useState } from "react";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";

interface ConceptCardsProps {
  concepts: CustomerArtworkVersion[];
  projectId: string;
  selectedId: string | null;
  selectable: boolean;
  busy: boolean;
  onSelect: (artworkVersionId: string) => void;
}

/**
 * Sprint 2K Phase 1: a concept with `hasImage: false` never gets an entry
 * here at all — it renders the fallback placeholder immediately, same as
 * every concept did before this sprint. A concept with `hasImage: true` and
 * no entry yet is implicitly "loading"; `"ready"` renders the real
 * generated image; `"unavailable"` falls back to the same placeholder.
 */
type ConceptImageState = { status: "ready"; url: string } | { status: "unavailable" };

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
}: ConceptCardsProps) {
  const [images, setImages] = useState<Record<string, ConceptImageState>>({});
  // Fetches already in flight — avoids re-triggering a request every render
  // while we're still waiting on the previous one for the same concept.
  const pendingRef = useRef<Set<string>>(new Set());
  // A signed URL can go stale (expiry, or a worker retry that replaced the
  // asset) — allow exactly one silent re-fetch per concept before settling
  // on the fallback placeholder, so refresh/renewal stays automatic without
  // ever retrying forever.
  const retriedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    for (const concept of concepts) {
      if (!concept.hasImage) continue;
      if (images[concept.id] || pendingRef.current.has(concept.id)) continue;

      pendingRef.current.add(concept.id);
      void fetchConceptImageUrl(projectId, concept.id).then((url) => {
        pendingRef.current.delete(concept.id);
        if (cancelled) return;
        setImages((prev) => ({
          ...prev,
          [concept.id]: url ? { status: "ready", url } : { status: "unavailable" },
        }));
      });
    }

    return () => {
      cancelled = true;
    };
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
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {concepts.map((concept) => {
        const isSelected = selectedId === concept.id || concept.isSelected;
        const canSelect = selectable && !busy && !selectedId;
        const image = concept.hasImage ? images[concept.id] : undefined;
        const isLoading = concept.hasImage && image === undefined;

        return (
          <button
            key={concept.id}
            type="button"
            disabled={!canSelect}
            onClick={() => onSelect(concept.id)}
            className={[
              "group relative overflow-hidden rounded-2xl border text-left transition",
              isSelected
                ? "border-ink bg-white shadow-sm"
                : "border-black/8 bg-white hover:border-black/20",
              canSelect ? "cursor-pointer" : "cursor-default",
            ].join(" ")}
          >
            <div className="relative h-36 overflow-hidden bg-black/5">
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
              <p className="text-xs leading-relaxed text-muted">{concept.summary}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
