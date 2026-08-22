"use client";

import { useState } from "react";

import type { ProductionTreatmentView } from "@/lib/services/conversation-service";

/**
 * Print'em All Phase 2 (Goals 13, 14): the INTERNAL OPERATOR's production
 * treatment surface.
 *
 * WHY IT IS OPINIONATED AND NOT PHOTOSHOP. Five controls, one recommended
 * default for each, and a reset. Every one of them is a decision that changes
 * physical output and that an operator can defend from a proof; anything that
 * does not clear that bar is engine identity, not a control (see
 * `halftone-screen.ts`'s constants).
 *
 * THE PANEL COMPUTES NOTHING. Bounds, options, defaults, the resolved garment
 * colour, and whether the treatment can be offered all arrive already decided
 * in `ProductionTreatmentView`, from the same domain module production uses.
 * A control here therefore cannot offer a value the pipeline would refuse,
 * and the printable band has exactly one definition.
 *
 * THIS COMPONENT IS NOT THE SECURITY BOUNDARY. It renders only when the
 * server chose to include `productionTreatment` in the snapshot, and every
 * action it takes is re-authorized server-side against the project's own
 * acquisition session. A client that rendered this panel by fabricating a
 * prop would gain a panel and no capability. Browser-side visibility is
 * presentation; the gate is on the write.
 *
 * PREVIEW IS PREVIEW. The garment view composites the plate over the garment
 * colour so an operator can judge it as a wearer would. It exists in one HTTP
 * response and nowhere else — never persisted, never an asset, and never part
 * of the deliverable, which stays transparent and garment-neutral.
 */

export type TreatmentPreviewMode = "prepared" | "halftone" | "garment";

export interface ProductionTreatmentPanelProps {
  view: ProductionTreatmentView;
  busy: boolean;
  /** Preview image URLs by mode, resolved by the parent. `null` while loading or unavailable. */
  previewUrls: Partial<Record<TreatmentPreviewMode, string | null>>;
  onSelectStandardRaster: () => void;
  onSelectHalftone: (settings: {
    lpi: number;
    angleDeg: number;
    dotShape: string;
    midtone: number;
    chokePx: number;
  }) => void;
}

export function ProductionTreatmentPanel({
  view,
  busy,
  previewUrls,
  onSelectStandardRaster,
  onSelectHalftone,
}: ProductionTreatmentPanelProps) {
  const [mode, setMode] = useState<TreatmentPreviewMode>("halftone");
  const [sideBySide, setSideBySide] = useState(true);

  const halftoneActive = view.treatment === "halftone_dtf";
  // The DURABLE settings, or the recommended starting point when none are
  // recorded. Never component state that outlives a render: an operator's
  // production authority lives on the server (Goal 16), so the controls read
  // from the snapshot and every change is a round trip.
  const current = view.halftone ?? view.recommended;

  /**
   * Sends the WHOLE settings object every time, not a partial.
   *
   * Settings are only ever meaningful together (see `halftone_settings`'s
   * column comment), so a partial write could persist a plate specification
   * that is half old and half new. Fields are typed loosely here on purpose:
   * the server refuses anything outside the supported band rather than
   * clamping it, so an out-of-range slider becomes a visible error instead of
   * a silently different plate.
   */
  function apply(changes: Partial<Record<string, number | string>>) {
    if (!current) return;
    onSelectHalftone({
      lpi: Number(changes.lpi ?? current.lpi),
      angleDeg: Number(changes.angleDeg ?? current.angleDeg),
      dotShape: String(changes.dotShape ?? current.dotShape),
      midtone: Number(changes.midtone ?? current.midtone),
      chokePx: Number(changes.chokePx ?? current.chokePx),
    });
  }

  return (
    <section
      aria-label="Production treatment"
      className="mt-4 rounded-2xl border border-amber-300/60 bg-amber-50/40 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Production treatment</p>
        <span className="text-[11px] font-medium uppercase tracking-wide text-amber-700">
          Internal
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Which production representation this plate is made as. Physical print
        testing is still required — these settings have not been proven on a
        press.
      </p>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Treatment">
        <button
          type="button"
          disabled={busy}
          aria-pressed={!halftoneActive}
          onClick={onSelectStandardRaster}
          className={treatmentButtonClass(!halftoneActive)}
        >
          Standard Raster
        </button>
        <button
          type="button"
          disabled={busy || !view.offerable || !current}
          aria-pressed={halftoneActive}
          onClick={() => apply({})}
          className={treatmentButtonClass(halftoneActive)}
        >
          DTF Halftone
        </button>
      </div>

      {!view.offerable && view.offerBlockedReason ? (
        <p className="mt-2 text-xs text-amber-800">{view.offerBlockedReason}</p>
      ) : null}

      {halftoneActive && current ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div className="col-span-2">
              <dt className="font-medium text-ink">Garment colour</dt>
              <dd className="mt-1 flex items-center gap-2 text-muted">
                <span
                  aria-hidden
                  className="inline-block h-4 w-4 rounded border border-black/20"
                  style={{ backgroundColor: current.garment.hex }}
                />
                {current.garment.label} ({current.garment.hex})
              </dd>
              {/* Named, not chosen here. The garment colour is the project's
                  existing product-colour authority; a second control for it
                  would be a second source of truth. */}
              <p className="mt-1 text-[11px] text-muted">
                From this project&apos;s product colour. The screen references
                it tonally; it is never printed into the file.
              </p>
            </div>

            <label className="col-span-2 block">
              <span className="font-medium text-ink">
                Line frequency — {current.lpi} LPI
              </span>
              <input
                type="range"
                className="mt-1 w-full"
                min={view.controls.lpi.min}
                max={view.controls.lpi.max}
                step={1}
                value={current.lpi}
                disabled={busy}
                onChange={(event) =>
                  apply({ lpi: Number(event.target.value) })
                }
              />
              <span className="text-[11px] text-muted">
                {view.controls.lpi.min}–{view.controls.lpi.max} LPI. Starting
                point: {view.controls.lpi.recommended}.
              </span>
            </label>

            <div>
              <dt className="font-medium text-ink">Screen angle</dt>
              <dd className="mt-1 flex gap-2">
                {view.controls.angles.map((angle) => (
                  <button
                    key={angle}
                    type="button"
                    disabled={busy}
                    aria-pressed={current.angleDeg === angle}
                    onClick={() => apply({ angleDeg: angle })}
                    className={optionButtonClass(current.angleDeg === angle)}
                  >
                    {angle}°
                  </button>
                ))}
              </dd>
            </div>

            <div>
              <dt className="font-medium text-ink">Dot shape</dt>
              <dd className="mt-1 flex gap-2">
                {view.controls.dotShapes.map((shape) => (
                  <button
                    key={shape}
                    type="button"
                    disabled={busy}
                    aria-pressed={current.dotShape === shape}
                    onClick={() => apply({ dotShape: shape })}
                    className={optionButtonClass(current.dotShape === shape)}
                  >
                    {shape === "round" ? "Round" : "Ellipse"}
                  </button>
                ))}
              </dd>
            </div>

            <label className="col-span-2 block">
              <span className="font-medium text-ink">
                Tone — {current.midtone.toFixed(2)}
              </span>
              <input
                type="range"
                className="mt-1 w-full"
                min={view.controls.midtone.min}
                max={view.controls.midtone.max}
                step={0.05}
                value={current.midtone}
                disabled={busy}
                onChange={(event) =>
                  apply({ midtone: Number(event.target.value) })
                }
              />
              <span className="text-[11px] text-muted">
                Below {view.controls.midtone.recommended} takes ink out of the
                midtones; above it puts more in. Solid and bare-garment ends do
                not move.
              </span>
            </label>

            <label className="col-span-2 block">
              <span className="font-medium text-ink">
                Edge cleanup — {current.chokePx}px
              </span>
              <input
                type="range"
                className="mt-1 w-full"
                min={view.controls.chokePx.min}
                max={view.controls.chokePx.max}
                step={1}
                value={current.chokePx}
                disabled={busy}
                onChange={(event) =>
                  apply({ chokePx: Number(event.target.value) })
                }
              />
              <span className="text-[11px] text-muted">
                Pulls the artwork edge in. Off by default — it removes real
                pixels.
              </span>
            </label>
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !view.recommended}
              onClick={() => {
                const r = view.recommended;
                if (!r) return;
                onSelectHalftone({
                  lpi: r.lpi,
                  angleDeg: r.angleDeg,
                  dotShape: r.dotShape,
                  midtone: r.midtone,
                  chokePx: r.chokePx,
                });
              }}
              className="rounded-full border border-black/15 px-3 py-1 text-xs font-medium text-ink disabled:opacity-50"
            >
              Reset to recommended defaults
            </button>
            {view.selectedAt ? (
              <span className="text-[11px] text-muted">
                Chosen {new Date(view.selectedAt).toLocaleString()}
              </span>
            ) : null}
          </div>

          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-ink">Preview</span>
              {(["prepared", "halftone", "garment"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  onClick={() => setMode(option)}
                  className={optionButtonClass(mode === option)}
                >
                  {option === "prepared"
                    ? "Original Prepared"
                    : option === "halftone"
                      ? "Halftone"
                      : "Garment"}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={sideBySide}
                onClick={() => setSideBySide((value) => !value)}
                className={optionButtonClass(sideBySide)}
              >
                Side by side
              </button>
            </div>

            <div
              className={`mt-2 grid gap-2 ${sideBySide ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {sideBySide ? (
                <PreviewTile
                  label="Original Prepared"
                  url={previewUrls.prepared ?? null}
                  garmentHex={current.garment.hex}
                />
              ) : null}
              <PreviewTile
                label={mode === "garment" ? "On garment" : "Halftone"}
                url={
                  (mode === "prepared" && !sideBySide
                    ? previewUrls.prepared
                    : mode === "garment"
                      ? previewUrls.garment
                      : previewUrls.halftone) ?? null
                }
                garmentHex={current.garment.hex}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Previews are generated at the confirmed final production size, so
              the dot density you see is the dot density that prints. The
              garment view is preview only — the exported file stays
              transparent.
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}

function PreviewTile({
  label,
  url,
  garmentHex,
}: {
  label: string;
  url: string | null;
  garmentHex: string;
}) {
  return (
    <figure className="m-0">
      <div
        className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-black/10"
        // The tile's own backdrop is the garment colour, so a transparent
        // plate is judged against fabric rather than against white.
        style={{ backgroundColor: garmentHex }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={label}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-[11px] text-white/70">Rendering…</span>
        )}
      </div>
      <figcaption className="mt-1 text-[11px] text-muted">{label}</figcaption>
    </figure>
  );
}

function treatmentButtonClass(active: boolean): string {
  return [
    "rounded-full px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50",
    active
      ? "bg-ink text-white"
      : "border border-black/15 bg-white text-ink hover:bg-black/5",
  ].join(" ");
}

function optionButtonClass(active: boolean): string {
  return [
    "rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50",
    active
      ? "bg-ink text-white"
      : "border border-black/15 bg-white text-ink hover:bg-black/5",
  ].join(" ");
}
