"use client";

import {
  DEFAULT_CUSTOM_PREVIEW_COLOR,
  DEFAULT_PREVIEW_BACKGROUND,
  garmentPresetChipLabel,
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_COPY,
  sameHexColor,
  type PreviewSurface,
  type ResolvedGarmentPreviewColor,
} from "./preview-background";

/**
 * Accessible White / Gray / Black / Custom Color inspection control.
 * Presentation only — never persists, never mutates artwork.
 *
 * DTF Custom Preview Background Phase: the three fixed presets are unchanged
 * (`role="radio"`, same styling, same click semantics). Custom Color is a
 * native `<input type="color">` — every browser gives that keyboard access,
 * a real accessible name, and a picker that never requires typing a hex code
 * — wrapped in a `<label>` so the visible swatch/text IS the click target.
 * Choosing a colour both sets the colour AND switches `value` to `"custom"`
 * in one action, matching how clicking a preset both is the choice.
 */

export interface PreviewBackgroundControlProps {
  value: PreviewSurface;
  onChange: (next: PreviewSurface) => void;
  /** The active custom colour, `#RRGGBB`. Only rendered/used once `value === "custom"`, but always controlled so the picker never starts blank. */
  customColor: string;
  onCustomColorChange: (hex: string) => void;
  /**
   * Optional convenience preset built from the customer's own already-
   * entered garment colour (see `resolveGarmentPreviewColor`). Omitted
   * (or `null`) when there is nothing to resolve — no chip renders, no
   * placeholder, no guess.
   */
  garmentPreset?: ResolvedGarmentPreviewColor | null;
  /** Optional id prefix so multiple controls on one page stay unique. */
  idPrefix?: string;
  disabled?: boolean;
  className?: string;
}

export function PreviewBackgroundControl({
  value,
  onChange,
  customColor,
  onCustomColorChange,
  garmentPreset = null,
  idPrefix = "preview-bg",
  disabled = false,
  className = "",
}: PreviewBackgroundControlProps) {
  const groupName = `${idPrefix}-group`;
  const customInputId = `${idPrefix}-custom-input`;
  const customSelected = value === "custom";
  const garmentSelected =
    customSelected && garmentPreset !== null && sameHexColor(customColor, garmentPreset.hex);

  return (
    <div
      className={className || undefined}
      role="radiogroup"
      aria-label={PREVIEW_BACKGROUND_COPY.label}
      data-preview-background={value}
      data-preview-background-default={DEFAULT_PREVIEW_BACKGROUND}
      data-preview-custom-color={customColor}
    >
      <p className="text-xs font-medium text-ink">
        {PREVIEW_BACKGROUND_COPY.label}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {PREVIEW_BACKGROUNDS.map((option) => {
          const selected = value === option;
          const optionId = `${idPrefix}-${option}`;
          return (
            <button
              key={option}
              id={optionId}
              type="button"
              role="radio"
              name={groupName}
              aria-checked={selected}
              aria-label={PREVIEW_BACKGROUND_COPY.options[option]}
              disabled={disabled}
              data-preview-background-option={option}
              data-selected={selected ? "true" : "false"}
              onClick={() => onChange(option)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                selected
                  ? "border-ink bg-ink text-white"
                  : "border-black/10 text-ink enabled:hover:border-ink/30"
              }`}
            >
              {PREVIEW_BACKGROUND_COPY.options[option]}
            </button>
          );
        })}

        <label
          htmlFor={customInputId}
          data-preview-background-option="custom"
          data-selected={customSelected ? "true" : "false"}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
            customSelected
              ? "border-ink bg-ink text-white"
              : "border-black/10 text-ink hover:border-ink/30"
          } ${disabled ? "pointer-events-none cursor-not-allowed opacity-40" : ""}`}
        >
          <span
            aria-hidden="true"
            data-custom-color-swatch
            className="h-3 w-3 shrink-0 rounded-full border border-black/20"
            style={{ backgroundColor: customColor || DEFAULT_CUSTOM_PREVIEW_COLOR }}
          />
          {customSelected
            ? `${PREVIEW_BACKGROUND_COPY.options.custom} · ${customColor.toUpperCase()}`
            : PREVIEW_BACKGROUND_COPY.options.custom}
          <input
            id={customInputId}
            type="color"
            aria-label={PREVIEW_BACKGROUND_COPY.customColorInputLabel}
            value={customColor || DEFAULT_CUSTOM_PREVIEW_COLOR}
            disabled={disabled}
            data-preview-custom-color-input
            onChange={(event) => {
              onCustomColorChange(event.target.value);
              onChange("custom");
            }}
            className="sr-only"
          />
        </label>

        {garmentPreset ? (
          <button
            type="button"
            aria-pressed={garmentSelected}
            disabled={disabled}
            data-preview-background-option="garment"
            data-selected={garmentSelected ? "true" : "false"}
            onClick={() => {
              onCustomColorChange(garmentPreset.hex);
              onChange("custom");
            }}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              garmentSelected
                ? "border-ink bg-ink text-white"
                : "border-black/10 text-ink enabled:hover:border-ink/30"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-full border border-black/20"
              style={{ backgroundColor: garmentPreset.hex }}
            />
            {garmentPresetChipLabel(garmentPreset.label)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
