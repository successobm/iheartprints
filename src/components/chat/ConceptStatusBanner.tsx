"use client";

import type { ConceptStatusView } from "@/capabilities/shared/contracts";

interface ConceptStatusBannerProps {
  status: ConceptStatusView;
  busy: boolean;
  onRegenerate: () => void;
  onKeepCurrent: () => void;
}

/**
 * Sprint 2G Part 3: a persistent, non-interrupting action — never a one-shot
 * chat yes/no. Only rendered when concepts actually need updating; ignoring
 * it is always safe, and it never repeats itself as a chat message.
 */
export function ConceptStatusBanner({
  status,
  busy,
  onRegenerate,
  onKeepCurrent,
}: ConceptStatusBannerProps) {
  if (status.status !== "needs_update") return null;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <p className="text-sm text-amber-900">{status.message}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onRegenerate}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate Updated Concepts
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onKeepCurrent}
          className="rounded-full border border-black/10 bg-white px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Keep Current Concepts
        </button>
      </div>
    </div>
  );
}
