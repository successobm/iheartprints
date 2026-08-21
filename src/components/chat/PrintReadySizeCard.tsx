"use client";

import { useState } from "react";

import type { GarmentSizeClass } from "@/lib/domain/types";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";

interface PrintReadySizeCardProps {
  size: PrintReadySizeView;
  busy: boolean;
  onChooseWidth: (widthIn: number) => void;
  /**
   * Print'em All Phase 1: "Use recommended size". Optional so every existing
   * caller that has not been wired up yet renders exactly as before rather
   * than showing a button that does nothing.
   */
  onUseRecommendedSize?: () => void;
  /** Print'em All Phase 1: the garment sizing context the recommendation is derived for. */
  onChooseGarmentSize?: (garmentSizeClass: GarmentSizeClass) => void;
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
 *
 * Print'em All Phase 1: the card now says three separate things, because they
 * are three separate facts and collapsing them is what let a paid job run at
 * a size nobody picked:
 *
 *   what we RECOMMEND      — "Recommended area: 10.5" x 10.5""
 *   what the ARTWORK does  — "Your artwork will print at: 10.5" x 9.1""
 *   what a HUMAN APPROVED  — the confirm control, or "Print size confirmed"
 *
 * Until the third one exists, preparation is unavailable — see
 * `PrintReadySizeView.blockingMessage`, which is rendered here rather than
 * invented by the component.
 *
 * The garment picker above them changes only the FIRST: it moves the
 * suggestion, never the authority, and never reaches a provider.
 */
export function PrintReadySizeCard({
  size,
  busy,
  onChooseWidth,
  onUseRecommendedSize,
  onChooseGarmentSize,
}: PrintReadySizeCardProps) {
  const [changing, setChanging] = useState(false);

  return (
    <div className="rounded-xl bg-black/[0.03] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Print size
          </p>

          {size.recommendation ? (
            <>
              <p className="mt-1 text-xs text-muted">
                Recommended for: {size.recommendation.recommendedFor}
              </p>
              <p className="text-xs text-muted">
                Recommended area: {formatInches(size.recommendation.boxWidthIn)}
                &quot; × {formatInches(size.recommendation.boxHeightIn)}&quot;
              </p>
            </>
          ) : (
            // No authoritative recommendation for this garment. Asking is the
            // honest response; a suggested number we do not have would be
            // indistinguishable from one we do.
            <p className="mt-1 text-xs text-muted">
              Enter the print width you want.
            </p>
          )}

          <p className="mt-1 text-sm font-semibold text-ink">
            Your artwork will print at: {formatSizeLine(size)}
          </p>
          <p className="text-xs text-muted">
            {size.dpi} DPI
            {size.placementLabel ? ` · ${size.placementLabel}` : ""}
          </p>
          {size.note ? (
            <p className="mt-1 text-xs text-muted">{size.note}</p>
          ) : null}

          {size.confirmed ? (
            <p className="mt-2 text-xs font-medium text-emerald-700">
              ✓ Print size confirmed
            </p>
          ) : (
            <p className="mt-2 text-xs text-amber-800" role="status">
              {size.blockingMessage}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {/* Offered only when there is a real recommendation AND it is not
              already what was confirmed — a button that re-confirms what the
              project already says reads as an unfinished step. */}
          {size.recommendation &&
          !size.recommendation.isConfirmed &&
          onUseRecommendedSize ? (
            <button
              type="button"
              disabled={busy}
              onClick={onUseRecommendedSize}
              className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Use recommended size
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => setChanging((open) => !open)}
            aria-expanded={changing}
            className="rounded-full border border-black/15 bg-white px-3 py-1 text-xs font-medium text-ink transition enabled:hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {changing ? "Keep This Size" : "Adjust size"}
          </button>
        </div>
      </div>

      {/* The garment picker sits with the size controls, not in the design
          conversation: it is a production question, and it only ever moves
          the RECOMMENDATION. Choosing one confirms nothing. */}
      {onChooseGarmentSize ? (
        <fieldset className="mt-3" disabled={busy}>
          <legend className="text-xs text-muted">Printing on</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {size.garmentSizeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={option.isSelected}
                onClick={() => onChooseGarmentSize(option.value)}
                className={[
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  option.isSelected
                    ? "border-ink bg-ink text-white"
                    : "border-black/15 bg-white text-ink enabled:hover:bg-black/[0.03]",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                ].join(" ")}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {/* A garment with no recommendation cannot be sized by pressing a
          suggestion, so the width entry is offered without waiting for
          "Adjust size" — it is the only route forward. */}
      {changing || size.requiresExplicitWidth ? (
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
          <WidthEntry
            busy={busy}
            minWidthIn={size.minWidthIn}
            maxWidthIn={size.maxWidthIn}
            onSubmit={(widthIn) => {
              onChooseWidth(widthIn);
              setChanging(false);
            }}
          />
          {/* Natural language is the primary interaction everywhere else in
              this product, so it stays available here rather than forcing
              the customer into the preset choices. */}
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
 * Print'em All Phase 1 (Goal 7): typing an exact print width.
 *
 * The only route to a size for a garment this product has no recommendation
 * for, and the route to a deliberate oversize for one it does. Bounds come
 * from the server-derived view (`minWidthIn`/`maxWidthIn`), so this input
 * carries no inch figures of its own; the server refuses an out-of-band value
 * independently, and refuses rather than clamping — a clamp would record
 * consent for a size nobody typed.
 */
function WidthEntry({
  busy,
  minWidthIn,
  maxWidthIn,
  onSubmit,
}: {
  busy: boolean;
  minWidthIn: number;
  maxWidthIn: number;
  onSubmit: (widthIn: number) => void;
}) {
  const [value, setValue] = useState("");
  const parsed = Number.parseFloat(value);
  const valid =
    Number.isFinite(parsed) && parsed >= minWidthIn && parsed <= maxWidthIn;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit(parsed);
        setValue("");
      }}
    >
      <label className="text-xs text-muted" htmlFor="print-width-in">
        Print width
      </label>
      <input
        id="print-width-in"
        name="widthIn"
        type="number"
        inputMode="decimal"
        step="0.25"
        min={minWidthIn}
        max={maxWidthIn}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        placeholder={`${formatInches(minWidthIn)}–${formatInches(maxWidthIn)}`}
        className="w-24 rounded-full border border-black/15 bg-white px-3 py-1 text-xs text-ink disabled:cursor-not-allowed disabled:opacity-40"
      />
      <span className="text-xs text-muted">inches</span>
      <button
        type="submit"
        disabled={busy || !valid}
        className="rounded-full border border-black/15 bg-white px-3 py-1 text-xs font-medium text-ink transition enabled:hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Use this width
      </button>
    </form>
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
