"use client";

import type { TimelineEntry } from "./revision-timeline";

interface RevisionTimelineProps {
  entries: TimelineEntry[];
}

export function RevisionTimeline({ entries }: RevisionTimelineProps) {
  // Nothing beyond the starting point yet — no history worth showing.
  if (entries.length <= 1) return null;

  return (
    <div
      className="mt-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
      aria-label="Design history"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Design History
      </p>
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
    </div>
  );
}
