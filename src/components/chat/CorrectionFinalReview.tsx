"use client";

/**
 * Phase 27E — Final Review: the dedicated "is this actually ready to use"
 * state reached via Done Editing. Not another editing screen — no Magic
 * Wand controls here, only inspection + the two deliberate choices (Back to
 * Editing / Use This Artwork). Renders the SAME `.../correction/result`
 * endpoint the workspace canvas just showed, so the reviewed pixels are
 * provably the workspace's current pixels (see Phase 27E report §9/§21).
 */

import { useState } from "react";

const INSPECTION_SURFACES = [
  { key: "black", hex: "#000000", label: "Black" },
  { key: "white", hex: "#FFFFFF", label: "White" },
  { key: "gray", hex: "#C8C8C8", label: "Gray" },
  // Red kept available too (Phase 27E §6: cheap to reuse, not required) —
  // matching SeparationReviewPanel's existing GARMENT_INSPECTION_SURFACES.
  { key: "red", hex: "#B22234", label: "Red" },
] as const;

export interface CorrectionFinalReviewProps {
  projectId: string;
  onBackToEditing: () => void;
  onUsed: () => void;
}

export default function CorrectionFinalReview({ projectId, onBackToEditing, onUsed }: CorrectionFinalReviewProps) {
  const [surface, setSurface] = useState<(typeof INSPECTION_SURFACES)[number]["hex"]>(INSPECTION_SURFACES[0].hex);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultUrl = `/api/projects/${projectId}/artwork-preparation/correction/result`;

  async function useThisArtwork() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-preparation/correction/finalize`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not use this artwork. Please try again.");
        setBusy(false);
        return;
      }
      onUsed();
    } catch {
      setError("Could not use this artwork. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm" data-correction-final-review>
      <p className="text-sm font-semibold text-ink">Review your correction before using it.</p>
      <p className="mt-1 text-sm text-muted">Check the artwork below on a few backgrounds. This is exactly what will be used if you continue.</p>

      {error ? (
        <div className="mt-2 rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-900" data-review-error>
          {error}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Inspection background">
        {INSPECTION_SURFACES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSurface(s.hex)}
            aria-pressed={surface === s.hex}
            data-inspection-surface={s.key}
            className={
              surface === s.hex
                ? "rounded-full border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-white"
                : "rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink focus-visible:ring-2 focus-visible:ring-ink/40"
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-3 w-full" data-review-image-container>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resultUrl}
          alt="Your corrected artwork, ready to review"
          className="w-full rounded-xl border border-black/10 object-contain"
          style={{ backgroundColor: surface, minHeight: 320, maxHeight: "70vh" }}
          data-review-image
        />
      </div>

      <p className="mt-2 text-xs text-muted">Your original upload is saved and unchanged.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onBackToEditing}
          disabled={busy}
          className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
          data-action="back-to-editing"
        >
          Back to Editing
        </button>
        <button
          type="button"
          onClick={useThisArtwork}
          disabled={busy}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-action="use-this-artwork"
        >
          Use This Artwork
        </button>
      </div>
    </div>
  );
}
