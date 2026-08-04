"use client";

import type { ArtworkVersion } from "@/lib/domain/types";

interface ConceptCardsProps {
  concepts: ArtworkVersion[];
  selectedId: string | null;
  selectable: boolean;
  busy: boolean;
  onSelect: (artworkVersionId: string) => void;
}

export function ConceptCards({
  concepts,
  selectedId,
  selectable,
  busy,
  onSelect,
}: ConceptCardsProps) {
  if (concepts.length === 0) return null;

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {concepts.map((concept) => {
        const isSelected = selectedId === concept.id || concept.isSelected;
        const canSelect = selectable && !busy && !selectedId;

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
            <div
              className="flex h-36 items-center justify-center"
              style={{
                background: `linear-gradient(145deg, ${concept.accentColor}22, ${concept.accentColor}55)`,
              }}
            >
              <div
                className="flex h-20 w-20 items-center justify-center rounded-full text-sm font-semibold text-white shadow-sm"
                style={{ backgroundColor: concept.accentColor }}
              >
                {concept.placeholderLabel.replace("Concept ", "")}
              </div>
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
