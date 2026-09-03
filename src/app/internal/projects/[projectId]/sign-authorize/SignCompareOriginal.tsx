"use client";

import { useState } from "react";

/**
 * Production Workspace Phase (Section F/Q): the compact replacement for the
 * old permanently-stacked "original artwork" preview. Preservation still
 * matters — the operator can always see what the customer actually
 * uploaded — but it no longer costs a full-width image's worth of vertical
 * space on every render. A single toggleable side-by-side view is enough;
 * this is deliberately NOT a diff engine, just two `<img>` elements reusing
 * the SAME internal-session-gated routes the rest of the page already
 * trusts (`original-image`, `production-candidate`) — this component never
 * fetches, computes, or compares pixels itself.
 */
export function SignCompareOriginal({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div data-sign-compare-original>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-ink/20 px-3 py-1.5 text-sm font-medium text-ink transition hover:border-ink/40"
        data-testid="sign-compare-original-open"
      >
        Compare Original
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex flex-col gap-3 overflow-auto bg-ink/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Compare original artwork with current production candidate"
          data-testid="sign-compare-original-modal"
        >
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 rounded-lg bg-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Original vs. current production candidate</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-ink/20 px-3 py-1 text-sm text-ink"
                data-testid="sign-compare-original-close"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-ink/60">Original (as uploaded)</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool, not the customer image pipeline */}
                <img
                  src={`/api/internal/projects/${projectId}/sign-artwork/original-image`}
                  alt="Customer's originally uploaded sign artwork"
                  className="max-h-[75vh] w-full rounded border border-ink/10 object-contain"
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-ink/60">Current production candidate</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- internal operator tool, not the customer image pipeline */}
                <img
                  src={`/api/internal/projects/${projectId}/sign-artwork/production-candidate`}
                  alt="Current production candidate"
                  className="max-h-[75vh] w-full rounded border border-ink/10 object-contain"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
