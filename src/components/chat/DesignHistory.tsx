"use client";

import { useState } from "react";

import type { CustomerArtworkVersion } from "@/capabilities/shared/contracts";
import { ConceptCards } from "./ConceptCards";
import type { ConceptPreviewSurfaceInput } from "./concept-preview-surface";
import type { DesignHistoryEntry } from "./design-history";

interface DesignHistoryProps {
  entries: DesignHistoryEntry[];
  artworkVersions: CustomerArtworkVersion[];
  projectId: string;
  selectedId: string | null;
  selectable: boolean;
  busy: boolean;
  onSelect: (artworkVersionId: string) => void;
  garmentPreviewInput?: ConceptPreviewSurfaceInput | null;
}

/**
 * Live Acceptance Corrective Pass (Section 2): the single, consolidated
 * "Design History" surface — replaces the old `RevisionTimeline` card and
 * the separate "View design history" toggle panel, which used to render
 * side by side under two different headings with two different data
 * sources. The compact milestone chain is always visible once there's more
 * than one milestone; expanding it reveals the actual artwork for each
 * milestone, reusing the same `ConceptCards`/`ConceptPreviewModal` viewer
 * customers already know from the live concept grid — historical artwork
 * is never a special case.
 */
export function DesignHistory({
  entries,
  artworkVersions,
  projectId,
  selectedId,
  selectable,
  busy,
  onSelect,
  garmentPreviewInput = null,
}: DesignHistoryProps) {
  const [open, setOpen] = useState(false);

  // Nothing beyond the starting point yet — no history worth showing.
  if (entries.length <= 1) return null;

  const byId = new Map(artworkVersions.map((version) => [version.id, version]));

  return (
    <div
      className="mt-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
      aria-label="Design history"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Design History
        </p>
        <span className="shrink-0 text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
          {open ? "Hide details" : "View details"}
        </span>
      </button>

      <ol className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm text-ink">
        {entries.map((entry, index) => (
          <li key={entry.id} className="flex items-center gap-1.5">
            <span className="rounded-full bg-black/[0.04] px-2.5 py-1">
              {entry.label}
            </span>
            {index < entries.length - 1 ? (
              <span aria-hidden="true" className="text-muted">
                →
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {open ? (
        <div className="mt-4 space-y-4">
          {entries.map((entry) => {
            const concepts = entry.artworkVersionIds
              .map((id) => byId.get(id))
              .filter((version): version is CustomerArtworkVersion => version !== undefined);
            if (concepts.length === 0) return null;
            return (
              <div key={entry.id}>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                  {entry.label}
                </p>
                <ConceptCards
                  concepts={concepts}
                  projectId={projectId}
                  selectedId={selectedId}
                  selectable={selectable}
                  busy={busy}
                  onSelect={onSelect}
                  garmentPreviewInput={garmentPreviewInput}
                  showShortSetNote={false}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
