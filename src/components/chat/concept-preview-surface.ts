import type { CSSProperties } from "react";

import { classifyProduction } from "@/capabilities/print-validation/production-requirements";

/**
 * Phase 2D — presentation-only concept preview surfaces.
 *
 * Transparent concept PNGs are composited over CSS backgrounds so customers
 * can judge artwork against the selected garment. This never rewrites image
 * bytes, alpha, assets, selection, evaluation, or paid generation.
 */

export const CONCEPT_PREVIEW_MODES = [
  "garment",
  "white",
  "gray",
  "black",
  "transparency",
] as const;

export type ConceptPreviewMode = (typeof CONCEPT_PREVIEW_MODES)[number];

/** Solid inspection aids shared with Existing Artwork QA (presentation only). */
export const CONCEPT_INSPECTION_COLORS = {
  white: "#FFFFFF",
  gray: "#C8C8C8",
  black: "#000000",
} as const;

/**
 * Small named-garment map for CSS preview. Intentionally presentation-sized —
 * not a color-management system. Prefer hex when the brief already stores one.
 */
const GARMENT_NAMED_HEX: Record<string, string> = {
  white: "#FFFFFF",
  ivory: "#FFFFF0",
  cream: "#FFFDD0",
  beige: "#F5F5DC",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
  "heather gray": "#9A9A9A",
  "heather grey": "#9A9A9A",
  charcoal: "#36454F",
  black: "#000000",
  navy: "#000080",
  "navy blue": "#000080",
  blue: "#1E5AB4",
  "royal blue": "#4169E1",
  red: "#C81010",
  maroon: "#800000",
  burgundy: "#800020",
  green: "#228B22",
  "forest green": "#228B22",
  olive: "#808000",
  brown: "#654321",
  purple: "#800080",
  gold: "#D4AF37",
  golden: "#D4AF37",
  yellow: "#F0DC28",
  orange: "#F08C14",
  pink: "#FFA0B4",
  teal: "#008080",
  cyan: "#00C8C8",
  magenta: "#C800C8",
};

/** Deterministic neutral when a named color is present but unmapped. */
export const UNKNOWN_GARMENT_NEUTRAL_HEX = "#C8C8C8";

export type GarmentColorResolvedFrom =
  | "hex"
  | "named"
  | "neutral_fallback"
  | "deferred"
  | "none";

export interface GarmentPreviewResolution {
  /** Customer-facing label from the brief; retained even on neutral fallback. */
  label: string | null;
  /** CSS color for the garment surface, or null when garment preview is off. */
  cssColor: string | null;
  resolvedFrom: GarmentColorResolvedFrom;
  /** Apparel (or apparel-like) product with a usable garment-color intent. */
  useGarmentPreview: boolean;
  isApparel: boolean;
}

export interface ConceptPreviewSurfaceInput {
  shirtColor?: string | null;
  deferredSections?: readonly string[] | null;
  productSummary?: string | null;
  designDescription?: string | null;
}

const HEX_COLOR =
  /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function parseHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) return null;
  if (trimmed.length === 4) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return trimmed.slice(0, 7).toUpperCase();
}

function titleCaseLabel(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function isApparelBrief(input: {
  productSummary?: string | null;
  designDescription?: string | null;
}): boolean {
  const category = classifyProduction({
    productSummary: input.productSummary ?? null,
    designDescription: input.designDescription ?? null,
  }).category;
  return category === "apparel_raster" || category === "apparel_vector";
}

/**
 * Resolve the approved brief garment color into a CSS preview surface.
 * Never invents a garment color when deferred/unknown; never maps unknown
 * names to black.
 */
export function resolveGarmentPreviewColor(
  input: ConceptPreviewSurfaceInput,
): GarmentPreviewResolution {
  const isApparel = isApparelBrief(input);
  const deferred = (input.deferredSections ?? []).includes("productColor");
  const raw = input.shirtColor?.trim() || null;

  if (!isApparel) {
    return {
      label: raw ? titleCaseLabel(raw) : null,
      cssColor: null,
      resolvedFrom: "none",
      useGarmentPreview: false,
      isApparel: false,
    };
  }

  if (deferred || !raw) {
    return {
      label: raw ? titleCaseLabel(raw) : null,
      cssColor: null,
      resolvedFrom: "deferred",
      useGarmentPreview: false,
      isApparel: true,
    };
  }

  const label = titleCaseLabel(raw);
  const hex = parseHexColor(raw);
  if (hex) {
    return {
      label,
      cssColor: hex,
      resolvedFrom: "hex",
      useGarmentPreview: true,
      isApparel: true,
    };
  }

  const named = GARMENT_NAMED_HEX[raw.toLowerCase()];
  if (named) {
    return {
      label,
      cssColor: named,
      resolvedFrom: "named",
      useGarmentPreview: true,
      isApparel: true,
    };
  }

  return {
    label,
    cssColor: UNKNOWN_GARMENT_NEUTRAL_HEX,
    resolvedFrom: "neutral_fallback",
    useGarmentPreview: true,
    isApparel: true,
  };
}

export function defaultConceptPreviewMode(
  resolution: GarmentPreviewResolution,
): ConceptPreviewMode {
  return resolution.useGarmentPreview ? "garment" : "transparency";
}

export function isConceptPreviewMode(value: string): value is ConceptPreviewMode {
  return (CONCEPT_PREVIEW_MODES as readonly string[]).includes(value);
}

/** Checkerboard matching the historical ConceptPreviewModal pattern. */
export function transparencySurfaceStyle(): CSSProperties {
  return {
    backgroundImage:
      "linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)",
    backgroundSize: "20px 20px",
    backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
    backgroundColor: "#f7f7f5",
  };
}

/**
 * Presentation-only surface behind a transparent concept PNG.
 * Never mutates the image; garment fill is CSS only.
 */
export function conceptPreviewSurfaceStyle(
  mode: ConceptPreviewMode,
  resolution: GarmentPreviewResolution,
): CSSProperties {
  switch (mode) {
    case "garment":
      if (resolution.cssColor) {
        return { backgroundColor: resolution.cssColor };
      }
      return transparencySurfaceStyle();
    case "white":
      return { backgroundColor: CONCEPT_INSPECTION_COLORS.white };
    case "gray":
      return { backgroundColor: CONCEPT_INSPECTION_COLORS.gray };
    case "black":
      return { backgroundColor: CONCEPT_INSPECTION_COLORS.black };
    case "transparency":
      return transparencySurfaceStyle();
  }
}

export function conceptPreviewModeLabel(
  mode: ConceptPreviewMode,
  resolution: GarmentPreviewResolution,
): string {
  switch (mode) {
    case "garment":
      return resolution.label
        ? `Design preview on ${resolution.label}`
        : "Design preview on garment";
    case "white":
      return "Preview on White";
    case "gray":
      return "Preview on Gray";
    case "black":
      return "Preview on Black";
    case "transparency":
      return "Transparency check";
  }
}

export function conceptCardGarmentHint(
  resolution: GarmentPreviewResolution,
): string | null {
  if (!resolution.useGarmentPreview || !resolution.label) return null;
  return `On ${resolution.label}`;
}

/**
 * Responsive grid that does not leave empty third-column placeholders for
 * short concept sets.
 */
export function conceptCardsGridClassName(count: number): string {
  if (count <= 1) {
    return "mt-3 grid max-w-sm gap-3 grid-cols-1";
  }
  if (count === 2) {
    return "mt-3 grid gap-3 sm:grid-cols-2";
  }
  return "mt-3 grid gap-3 sm:grid-cols-3";
}

/**
 * Customer-safe short-set copy. Uses the Phase 2C `conceptsWithheld` count
 * only — never reason codes, evaluator verdicts, or internal thresholds.
 */
export function shortConceptSetNote(input: {
  visibleCount: number;
  conceptsWithheld?: number | null;
}): string | null {
  const visible = input.visibleCount;
  const withheld =
    typeof input.conceptsWithheld === "number" && input.conceptsWithheld > 0
      ? input.conceptsWithheld
      : 0;

  if (visible <= 0 || visible >= 3) return null;

  if (withheld > 0) {
    const shown =
      visible === 1
        ? "1 concept that matches your required print instructions"
        : `${visible} concepts that match your required print instructions`;
    const hidden =
      withheld === 1
        ? "One concept was not shown because it did not meet a required print instruction."
        : `${withheld} concepts were not shown because they did not meet a required print instruction.`;
    return `We created ${shown}. ${hidden}`;
  }

  if (visible === 1) {
    return "Only one concept is shown — iHeartPrints only shows concepts that satisfy required constraints and completed successfully.";
  }

  return "Fewer than three concepts are shown — iHeartPrints only shows concepts that satisfy required constraints and completed successfully.";
}

export function availableConceptPreviewModes(
  resolution: GarmentPreviewResolution,
): ConceptPreviewMode[] {
  if (resolution.useGarmentPreview) {
    return [...CONCEPT_PREVIEW_MODES];
  }
  return ["white", "gray", "black", "transparency"];
}

export const CONCEPT_PREVIEW_MODE_COPY = {
  label: "Preview background",
  helper: "Check how the design reads on your garment or against inspection backgrounds.",
  options: {
    garment: "Garment",
    white: "White",
    gray: "Gray",
    black: "Black",
    transparency: "Transparency",
  },
} as const;
