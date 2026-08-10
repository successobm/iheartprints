"use client";

import { useState } from "react";

import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";

interface PrintReadySizeCardProps {
  size: PrintReadySizeView;
  busy: boolean;
  onChooseWidth: (widthIn: number) => void;
}

/**
 * Live Acceptance Cleanup (Issue 5): tells the customer how large their
 * design will actually print, BEFORE finalization starts, and lets them
 * change it.
 *
 * Deliberately not an interview question (Constitution: prefer conversation
 * over forms, and never ask for production settings during the design
 * conversation). It lives at the "Use This Design → Prepare Print-Ready"
 * boundary, which is the only moment physical size is a real customer
 * decision and still changeable.
 *
 * Resolution is stated, never offered: the customer chooses inches and we
 * guarantee full production quality at whatever they choose. Every number
 * rendered here arrives pre-computed from the placement policy — this
 * component contains no inch figures of its own (AGENTS.md: "do not scatter
 * these numbers into UI components").
 */
export function PrintReadySizeCard({
  size,
  busy,
  onChooseWidth,
}: PrintReadySizeCardProps) {
  const [changing, setChanging] = useState(false);

  return (
    <div className="rounded-xl bg-black/[0.03] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Print-ready size
          </p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {formatSizeLine(size)}
          </p>
          <p className="text-xs text-muted">
            {size.dpi} DPI
            {size.placementLabel ? ` · ${size.placementLabel}` : ""}
          </p>
          {size.note ? (
            <p className="mt-1 text-xs text-muted">{size.note}</p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => setChanging((open) => !open)}
          aria-expanded={changing}
          className="shrink-0 rounded-full border border-black/15 bg-white px-3 py-1 text-xs font-medium text-ink transition enabled:hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {changing ? "Keep This Size" : "Change Size"}
        </button>
      </div>

      {changing ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            {size.widthOptions.map((option) => (
              <button
                key={option.widthIn}
                type="button"
                disabled={busy || option.isSelected}
                onClick={() => {
                  onChooseWidth(option.widthIn);
                  setChanging(false);
                }}
                className={[
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  option.isSelected
                    ? "border-ink bg-ink text-white"
                    : "border-black/15 bg-white text-ink enabled:hover:bg-black/[0.03]",
                  "disabled:cursor-default disabled:opacity-100",
                ].join(" ")}
              >
                {option.label}
              </button>
            ))}
          </div>
          {/* Natural language is the primary interaction everywhere else in
              this product, so it stays available here rather than forcing
              the customer into the three preset choices. */}
          <p className="text-xs text-muted">
            Or just tell me — for example, &ldquo;make the print 12 inches
            wide&rdquo;.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `10.5" × 11.2"`, or just `10.5" wide` when the artwork's proportions
 * aren't known yet — an invented height would be a promise about the
 * finished plate we cannot keep.
 */
export function formatSizeLine(size: PrintReadySizeView): string {
  const width = `${formatInches(size.widthIn)}"`;
  return size.heightIn === null
    ? `${width} wide`
    : `${width} × ${formatInches(size.heightIn)}"`;
}

function formatInches(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 100) / 100);
}
