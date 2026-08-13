"use client";

import {
  availableConceptPreviewModes,
  CONCEPT_PREVIEW_MODE_COPY,
  conceptPreviewModeLabel,
  type ConceptPreviewMode,
  type GarmentPreviewResolution,
} from "./concept-preview-surface";

/**
 * Phase 2D: presentation-only concept preview background switcher.
 * Local UI state only — never persists, never mutates artwork or selection.
 */

export interface ConceptPreviewBackgroundControlProps {
  value: ConceptPreviewMode;
  onChange: (next: ConceptPreviewMode) => void;
  resolution: GarmentPreviewResolution;
  idPrefix?: string;
  disabled?: boolean;
  className?: string;
}

export function ConceptPreviewBackgroundControl({
  value,
  onChange,
  resolution,
  idPrefix = "concept-preview-bg",
  disabled = false,
  className = "",
}: ConceptPreviewBackgroundControlProps) {
  const modes = availableConceptPreviewModes(resolution);
  const groupName = `${idPrefix}-group`;

  return (
    <div
      className={className || undefined}
      role="radiogroup"
      aria-label={CONCEPT_PREVIEW_MODE_COPY.label}
      data-concept-preview-mode={value}
      data-concept-preview-garment={resolution.label ?? ""}
    >
      <p className="text-xs font-medium text-ink">
        {CONCEPT_PREVIEW_MODE_COPY.label}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted">
        {CONCEPT_PREVIEW_MODE_COPY.helper}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {modes.map((option) => {
          const selected = value === option;
          const optionId = `${idPrefix}-${option}`;
          const optionLabel =
            option === "garment" && resolution.label
              ? resolution.label
              : CONCEPT_PREVIEW_MODE_COPY.options[option];
          return (
            <button
              key={option}
              id={optionId}
              type="button"
              role="radio"
              name={groupName}
              aria-checked={selected}
              aria-label={conceptPreviewModeLabel(option, resolution)}
              disabled={disabled}
              data-concept-preview-option={option}
              data-selected={selected ? "true" : "false"}
              onClick={() => onChange(option)}
              className={`min-h-8 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                selected
                  ? "border-ink bg-ink text-white"
                  : "border-black/10 text-ink enabled:hover:border-ink/30"
              }`}
            >
              {optionLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}
