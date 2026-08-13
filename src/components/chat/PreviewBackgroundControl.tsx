"use client";

import {
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_COPY,
  type PreviewBackground,
} from "./preview-background";

/**
 * Accessible White / Gray / Black inspection control.
 * Presentation only — never persists, never mutates artwork.
 */

export interface PreviewBackgroundControlProps {
  value: PreviewBackground;
  onChange: (next: PreviewBackground) => void;
  /** Optional id prefix so multiple controls on one page stay unique. */
  idPrefix?: string;
  disabled?: boolean;
  className?: string;
}

export function PreviewBackgroundControl({
  value,
  onChange,
  idPrefix = "preview-bg",
  disabled = false,
  className = "",
}: PreviewBackgroundControlProps) {
  const groupName = `${idPrefix}-group`;

  return (
    <div
      className={className || undefined}
      role="radiogroup"
      aria-label={PREVIEW_BACKGROUND_COPY.label}
      data-preview-background={value}
      data-preview-background-default={DEFAULT_PREVIEW_BACKGROUND}
    >
      <p className="text-xs font-medium text-ink">
        {PREVIEW_BACKGROUND_COPY.label}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
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
      </div>
    </div>
  );
}
