"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Signs Phase 3A: the smallest governed mechanism letting an internal
 * production operator supply structural evidence for `reflow_structural_
 * layout` when deterministic segmentation cannot measure a banner
 * structure on its own. Deliberately NOT a general layout editor —
 * horizontal row-boundary spans only, no polygons, no freehand masks, no
 * drag interaction. The operator looks at the artwork preview already
 * rendered above this form and types in, top to bottom, where each
 * structural region starts and ends; for the first and last region only
 * (when it touches the artwork's own top/bottom edge) an additional pair
 * of fields marks where that region's own meaningful content begins and
 * ends within it — every colour is independently measured server-side,
 * never entered here.
 *
 * Calls `POST /api/internal/projects/[projectId]/sign-artwork/structural-
 * layout`, which independently re-validates every boundary against the
 * actual current source pixels before persisting anything, and immediately
 * re-plans. On success, `router.refresh()` re-reads authoritative server
 * state — this form never assumes its own submission was accepted.
 */

interface RegionRow {
  startYPx: string;
  endYPx: string;
  hasContent: boolean;
  contentStartYPx: string;
  contentEndYPx: string;
}

function emptyRow(): RegionRow {
  return { startYPx: "", endYPx: "", hasContent: false, contentStartYPx: "", contentEndYPx: "" };
}

export function SignStructuralLayoutForm({
  projectId,
  artworkWidthPx,
  artworkHeightPx,
  hasExistingOverride,
}: {
  projectId: string;
  artworkWidthPx: number;
  artworkHeightPx: number;
  hasExistingOverride: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RegionRow[]>([emptyRow(), emptyRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function updateRow(index: number, patch: Partial<RegionRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const regions = rows.map((row, i) => {
        const startYPx = Number(row.startYPx);
        const endYPx = Number(row.endYPx);
        if (!Number.isFinite(startYPx) || !Number.isFinite(endYPx)) {
          throw new Error(`Region ${i + 1}: start and end row are required.`);
        }
        const isFirst = i === 0;
        const isLast = i === rows.length - 1;
        const touchesEdge = (isFirst && startYPx === 0) || (isLast && endYPx === artworkHeightPx);
        if (touchesEdge) {
          const contentStartYPx = Number(row.contentStartYPx);
          const contentEndYPx = Number(row.contentEndYPx);
          if (!Number.isFinite(contentStartYPx) || !Number.isFinite(contentEndYPx)) {
            throw new Error(
              `Region ${i + 1} touches the artwork's own edge — its own meaningful content start/end rows are required.`,
            );
          }
          return { startYPx, endYPx, contentStartYPx, contentEndYPx };
        }
        return { startYPx, endYPx, contentStartYPx: null, contentEndYPx: null };
      });

      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/structural-layout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regions }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setSubmitting(false);
        return;
      }
      router.refresh();
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setSubmitting(false);
    }
  }

  async function handleClear() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/structural-layout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regions: null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setSubmitting(false);
        return;
      }
      router.refresh();
      setSubmitting(false);
    } catch {
      setError("That didn't work. Please try again.");
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-start rounded-full border border-ink/20 px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-ink/5"
          data-testid="sign-structural-layout-open"
        >
          {hasExistingOverride ? "Edit confirmed structural regions" : "Confirm structural regions manually"}
        </button>
        {hasExistingOverride ? (
          <p className="text-xs text-ink/60">Operator-confirmed structural evidence is currently recorded for this artwork.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3">
      <p className="text-sm text-ink/70">
        Artwork is {artworkWidthPx}×{artworkHeightPx}px. List each structural region, top to bottom (e.g. the top
        banner, each middle section, the bottom banner), by its own row range. For the first and last region only —
        when it touches row 0 or row {artworkHeightPx} — also mark where its meaningful content (wording/logo) starts
        and ends within it. Colours are always measured automatically from the actual artwork, never entered here.
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const isFirst = i === 0;
          const isLast = i === rows.length - 1;
          return (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-ink/10 p-2 text-sm">
              <span className="font-medium text-ink/60">
                Region {i + 1}
                {isFirst ? " (top)" : isLast ? " (bottom)" : ""}:
              </span>
              <label className="flex items-center gap-1">
                start
                <input
                  type="number"
                  value={row.startYPx}
                  onChange={(e) => updateRow(i, { startYPx: e.target.value })}
                  className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
                />
              </label>
              <label className="flex items-center gap-1">
                end
                <input
                  type="number"
                  value={row.endYPx}
                  onChange={(e) => updateRow(i, { endYPx: e.target.value })}
                  className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
                />
              </label>
              {isFirst || isLast ? (
                <>
                  <span className="text-ink/40">|</span>
                  <label className="flex items-center gap-1">
                    content start
                    <input
                      type="number"
                      value={row.contentStartYPx}
                      onChange={(e) => updateRow(i, { contentStartYPx: e.target.value })}
                      className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    content end
                    <input
                      type="number"
                      value={row.contentEndYPx}
                      onChange={(e) => updateRow(i, { contentEndYPx: e.target.value })}
                      className="w-20 rounded border border-ink/20 px-1.5 py-0.5"
                    />
                  </label>
                </>
              ) : null}
              {rows.length > 2 ? (
                <button type="button" onClick={() => removeRow(i)} className="text-xs text-red-600 underline">
                  remove
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={addRow} className="self-start text-sm text-ink/70 underline">
        + add region
      </button>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-structural-layout-submit"
        >
          {submitting ? "Confirming…" : "Confirm structural regions"}
        </button>
        {hasExistingOverride ? (
          <button
            type="button"
            onClick={handleClear}
            disabled={submitting}
            className="text-sm text-ink/60 underline disabled:opacity-40"
          >
            Clear confirmed regions
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink/60 underline">
          Cancel
        </button>
      </div>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-structural-layout-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
