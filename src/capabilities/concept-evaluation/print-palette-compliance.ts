/**
 * Phase 2B — Deterministic print-palette / garment-contrast compliance.
 *
 * Inspects ACTUAL generated RGBA pixels against the Phase 2A print-palette
 * contract (`derivePrintPalette`). Provider-independent, pure, no network.
 *
 * This is a production heuristic gate, not color-managed print proof:
 *   - Luminance: Rec.601 Y = (0.299R + 0.587G + 0.114B) / 255
 *   - Visible pixels: alpha >= VISIBLE_ALPHA_THRESHOLD (8), weighted by a/255
 *   - Contrast: |meanVisibleY − garmentY| (luminance delta), not WCAG text contrast
 *
 * Authoritative for hard print-palette / garment-visibility compliance.
 * OpenAI Vision may still score semantic color_palette, but must not reverse
 * a deterministic hard FAIL (see `mergePrintPaletteCompliance`).
 *
 * Phase 2B only MAKES the verdict available — it does not reject concepts,
 * regenerate, or change lifecycle.
 */

import { isDarkColor } from "@/capabilities/shared/color-families";
import {
  derivePrintPalette,
  type DerivedPrintPalette,
} from "@/capabilities/prompt-translation/print-palette-constraint";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type {
  DesignBriefSnapshotContent,
  PrintPaletteEnforcement,
} from "@/lib/domain/types";

/** Matches alpha-trim / pixel-metrics: soft AA edges count as content. */
export const PRINT_PALETTE_VISIBLE_ALPHA_THRESHOLD = 8;

/** Rec.601 luminance thresholds (Y in 0–1). Stable, intentionally coarse. */
export const LUMINANCE_VERY_LIGHT = 0.9;
export const LUMINANCE_LIGHT = 0.7;
export const LUMINANCE_MID_LOW = 0.35;
export const LUMINANCE_NEAR_BLACK = 0.12;

/**
 * Hard-gate thresholds (fractions of alpha-weighted visible pixels).
 * Calibrated against live black-garment / white-palette outputs without
 * hardcoding concept ids: Soft (~65% dark) must FAIL; Minimal (~95% light)
 * must PASS; Bold (~11% dark) lands in WARN.
 */
export const HARD_FAIL_GARMENT_MATCHING = 0.35;
export const HARD_FAIL_LOW_COVERAGE = 0.4;
export const HARD_FAIL_LOW_COVERAGE_MATCHING = 0.2;
export const HARD_WARN_GARMENT_MATCHING = 0.08;
export const HARD_WARN_LOW_COVERAGE = 0.65;
/** Minimum mean |ΔY| vs garment for "sufficient contrast" when coverage is thin. */
export const HARD_WARN_LOW_CONTRAST_DELTA = 0.25;
export const MIN_VISIBLE_WEIGHTED_FRACTION = 0.002;

/** Named-color → RGB for known garment / palette words. Deliberately small. */
const NAMED_RGB: Record<string, readonly [number, number, number]> = {
  white: [255, 255, 255],
  ivory: [255, 255, 240],
  cream: [255, 253, 208],
  beige: [245, 245, 220],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  charcoal: [54, 69, 79],
  black: [0, 0, 0],
  navy: [0, 0, 128],
  "navy blue": [0, 0, 128],
  blue: [30, 90, 180],
  "royal blue": [65, 105, 225],
  red: [200, 16, 16],
  maroon: [128, 0, 0],
  burgundy: [128, 0, 32],
  green: [34, 139, 34],
  "forest green": [34, 139, 34],
  olive: [128, 128, 0],
  brown: [101, 67, 33],
  purple: [128, 0, 128],
  gold: [212, 175, 55],
  golden: [212, 175, 55],
  yellow: [240, 220, 40],
  orange: [240, 140, 20],
  pink: [255, 160, 180],
  teal: [0, 128, 128],
  cyan: [0, 200, 200],
  magenta: [200, 0, 200],
};

export type PrintPaletteComplianceStatus =
  | "pass"
  | "warn"
  | "fail"
  | "not_applicable";

export type GarmentLuminanceClass = "light" | "mid" | "dark" | "unknown";

export type PrintPaletteComplianceReason =
  | "no_palette_gate"
  | "pixels_unavailable"
  | "low_visible_content"
  | "hard_palette_not_dominant"
  | "excessive_garment_matching_ink"
  | "insufficient_contrast"
  | "notable_non_palette_accents"
  | "soft_preference_only";

export interface PrintPaletteComplianceMetrics {
  visiblePixelWeight: number;
  visiblePixelFraction: number;
  veryLightPixelFraction: number;
  lightPixelFraction: number;
  midtonePixelFraction: number;
  darkPixelFraction: number;
  nearBlackPixelFraction: number;
  /** light+veryLight or dark+nearBlack depending on required palette family. */
  paletteCoverageFraction: number;
  /** Fraction of visible ink that matches the garment luminance family. */
  garmentMatchingFraction: number;
  meanVisibleLuminance: number;
  garmentLuminance: number | null;
  garmentClass: GarmentLuminanceClass;
  luminanceContrastDelta: number | null;
  requiredPaletteFamily: "light" | "dark" | "mid" | "unknown";
  enforcement: PrintPaletteEnforcement;
}

export interface PrintPaletteComplianceResult {
  status: PrintPaletteComplianceStatus;
  metrics: PrintPaletteComplianceMetrics;
  reasons: PrintPaletteComplianceReason[];
}

export interface EvaluatePrintPaletteComplianceInput {
  image: RgbaImage | null;
  brief: Pick<
    DesignBriefSnapshotContent,
    "shirtColor" | "preferredColors" | "designDescription" | "deferredSections"
  >;
  /**
   * Optional override for sensitivity tests. Defaults to the calibrated
   * production thresholds.
   */
  thresholds?: Partial<PrintPaletteThresholds>;
}

export interface PrintPaletteThresholds {
  failGarmentMatching: number;
  failLowCoverage: number;
  failLowCoverageMatching: number;
  warnGarmentMatching: number;
  warnLowCoverage: number;
  warnLowContrastDelta: number;
  minVisibleWeightedFraction: number;
  visibleAlpha: number;
}

export const DEFAULT_PRINT_PALETTE_THRESHOLDS: PrintPaletteThresholds = {
  failGarmentMatching: HARD_FAIL_GARMENT_MATCHING,
  failLowCoverage: HARD_FAIL_LOW_COVERAGE,
  failLowCoverageMatching: HARD_FAIL_LOW_COVERAGE_MATCHING,
  warnGarmentMatching: HARD_WARN_GARMENT_MATCHING,
  warnLowCoverage: HARD_WARN_LOW_COVERAGE,
  warnLowContrastDelta: HARD_WARN_LOW_CONTRAST_DELTA,
  minVisibleWeightedFraction: MIN_VISIBLE_WEIGHTED_FRACTION,
  visibleAlpha: PRINT_PALETTE_VISIBLE_ALPHA_THRESHOLD,
};

/**
 * Rec.601 relative luminance in 0–1. Preferring a stable linear-in-channel
 * formula over perceptual sophistication — thresholds are calibrated to it.
 */
export function pixelLuminance(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function resolveNamedRgb(
  name: string | null | undefined,
): readonly [number, number, number] | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return NAMED_RGB[key] ?? null;
}

export function classifyLuminance(y: number): GarmentLuminanceClass {
  if (y >= LUMINANCE_LIGHT) return "light";
  if (y >= LUMINANCE_MID_LOW) return "mid";
  return "dark";
}

export function classifyNamedColorLuminance(
  name: string | null | undefined,
): GarmentLuminanceClass {
  const rgb = resolveNamedRgb(name);
  if (rgb) return classifyLuminance(pixelLuminance(rgb[0], rgb[1], rgb[2]));
  if (!name?.trim()) return "unknown";
  // Fallback when free-text is not in the map: reuse the coarse dark set.
  if (isDarkColor(name)) return "dark";
  const lower = name.trim().toLowerCase();
  if (
    lower === "white" ||
    lower.includes("white") ||
    lower.includes("cream") ||
    lower.includes("ivory") ||
    lower.includes("light")
  ) {
    return "light";
  }
  return "unknown";
}

function emptyMetrics(
  enforcement: PrintPaletteEnforcement,
  garmentClass: GarmentLuminanceClass,
  garmentLuminance: number | null,
  requiredPaletteFamily: PrintPaletteComplianceMetrics["requiredPaletteFamily"],
): PrintPaletteComplianceMetrics {
  return {
    visiblePixelWeight: 0,
    visiblePixelFraction: 0,
    veryLightPixelFraction: 0,
    lightPixelFraction: 0,
    midtonePixelFraction: 0,
    darkPixelFraction: 0,
    nearBlackPixelFraction: 0,
    paletteCoverageFraction: 0,
    garmentMatchingFraction: 0,
    meanVisibleLuminance: 0,
    garmentLuminance,
    garmentClass,
    luminanceContrastDelta: null,
    requiredPaletteFamily,
    enforcement,
  };
}

function requiredPaletteFamilyFromColors(
  colors: string[],
): PrintPaletteComplianceMetrics["requiredPaletteFamily"] {
  if (colors.length === 0) return "unknown";
  const classes = colors.map((c) => classifyNamedColorLuminance(c));
  const lights = classes.filter((c) => c === "light").length;
  const darks = classes.filter((c) => c === "dark").length;
  if (lights > 0 && darks === 0) return "light";
  if (darks > 0 && lights === 0) return "dark";
  if (lights === 0 && darks === 0) return "mid";
  // Mixed hard palettes: treat as mid — coverage uses distance-to-any later.
  return "mid";
}

/**
 * Pure deterministic validator. Never I/O, never mutates the image buffer.
 */
export function evaluatePrintPaletteCompliance(
  input: EvaluatePrintPaletteComplianceInput,
): PrintPaletteComplianceResult {
  const palette: DerivedPrintPalette = derivePrintPalette(input.brief);
  const thresholds: PrintPaletteThresholds = {
    ...DEFAULT_PRINT_PALETTE_THRESHOLDS,
    ...input.thresholds,
  };

  const garmentRgb = resolveNamedRgb(palette.garmentColor);
  const garmentLuminance = garmentRgb
    ? pixelLuminance(garmentRgb[0], garmentRgb[1], garmentRgb[2])
    : null;
  const garmentClass =
    garmentLuminance !== null
      ? classifyLuminance(garmentLuminance)
      : classifyNamedColorLuminance(palette.garmentColor);
  const requiredPaletteFamily = requiredPaletteFamilyFromColors(palette.colors);

  if (palette.enforcement === "none") {
    return {
      status: "not_applicable",
      metrics: emptyMetrics(
        "none",
        garmentClass,
        garmentLuminance,
        requiredPaletteFamily,
      ),
      reasons: ["no_palette_gate"],
    };
  }

  if (!input.image || input.image.width <= 0 || input.image.height <= 0) {
    return {
      status: "not_applicable",
      metrics: emptyMetrics(
        palette.enforcement,
        garmentClass,
        garmentLuminance,
        requiredPaletteFamily,
      ),
      reasons: ["pixels_unavailable"],
    };
  }

  const measured = measureVisiblePixels(input.image, thresholds.visibleAlpha);
  const canvas = input.image.width * input.image.height;
  const visiblePixelFraction =
    canvas === 0 ? 0 : measured.visibleWeight / canvas;

  const lightish =
    measured.veryLightWeight + measured.lightWeight;
  const darkish = measured.darkWeight + measured.nearBlackWeight;
  const denom = measured.visibleWeight || 1;

  const veryLightPixelFraction = measured.veryLightWeight / denom;
  const lightPixelFraction = measured.lightWeight / denom;
  const midtonePixelFraction = measured.midWeight / denom;
  const darkPixelFraction = measured.darkWeight / denom;
  const nearBlackPixelFraction = measured.nearBlackWeight / denom;

  let paletteCoverageFraction: number;
  let garmentMatchingFraction: number;
  if (requiredPaletteFamily === "light") {
    paletteCoverageFraction = lightish / denom;
    garmentMatchingFraction =
      garmentClass === "dark" || garmentClass === "unknown"
        ? darkish / denom
        : lightish / denom;
  } else if (requiredPaletteFamily === "dark") {
    paletteCoverageFraction = darkish / denom;
    garmentMatchingFraction =
      garmentClass === "light" || garmentClass === "unknown"
        ? lightish / denom
        : darkish / denom;
  } else {
    // Mid / mixed: coverage via RGB distance to the nearest mapped palette color.
    paletteCoverageFraction =
      measurePaletteProximityCoverage(
        input.image,
        palette.colors,
        thresholds.visibleAlpha,
      ) / denom;
    garmentMatchingFraction =
      garmentClass === "dark"
        ? darkish / denom
        : garmentClass === "light"
          ? lightish / denom
          : midtonePixelFraction;
  }

  // When garment class is mid, "matching" uses midtones — still useful.
  if (garmentClass === "mid" && requiredPaletteFamily !== "mid") {
    garmentMatchingFraction = midtonePixelFraction;
  }

  const meanVisibleLuminance =
    measured.visibleWeight === 0
      ? 0
      : measured.luminanceWeightSum / measured.visibleWeight;
  const luminanceContrastDelta =
    garmentLuminance === null
      ? null
      : Math.abs(meanVisibleLuminance - garmentLuminance);

  const metrics: PrintPaletteComplianceMetrics = {
    visiblePixelWeight: round4(measured.visibleWeight),
    visiblePixelFraction: round4(visiblePixelFraction),
    veryLightPixelFraction: round4(veryLightPixelFraction),
    lightPixelFraction: round4(lightPixelFraction),
    midtonePixelFraction: round4(midtonePixelFraction),
    darkPixelFraction: round4(darkPixelFraction),
    nearBlackPixelFraction: round4(nearBlackPixelFraction),
    paletteCoverageFraction: round4(paletteCoverageFraction),
    garmentMatchingFraction: round4(garmentMatchingFraction),
    meanVisibleLuminance: round4(meanVisibleLuminance),
    garmentLuminance:
      garmentLuminance === null ? null : round4(garmentLuminance),
    garmentClass,
    luminanceContrastDelta:
      luminanceContrastDelta === null ? null : round4(luminanceContrastDelta),
    requiredPaletteFamily,
    enforcement: palette.enforcement,
  };

  if (visiblePixelFraction < thresholds.minVisibleWeightedFraction) {
    return {
      status: palette.enforcement === "hard" ? "fail" : "warn",
      metrics,
      reasons: ["low_visible_content"],
    };
  }

  const hardSignals = collectHardSignals(metrics, thresholds);

  if (palette.enforcement === "soft") {
    // Soft preferences never hard-fail. Material problems become WARN.
    if (hardSignals.failReasons.length > 0 || hardSignals.warnReasons.length > 0) {
      return {
        status: "warn",
        metrics,
        reasons: [
          "soft_preference_only",
          ...hardSignals.failReasons,
          ...hardSignals.warnReasons,
        ],
      };
    }
    return {
      status: "pass",
      metrics,
      reasons: ["soft_preference_only"],
    };
  }

  // hard enforcement
  if (hardSignals.failReasons.length > 0) {
    return {
      status: "fail",
      metrics,
      reasons: hardSignals.failReasons,
    };
  }
  if (hardSignals.warnReasons.length > 0) {
    return {
      status: "warn",
      metrics,
      reasons: hardSignals.warnReasons,
    };
  }
  return { status: "pass", metrics, reasons: [] };
}

function collectHardSignals(
  metrics: PrintPaletteComplianceMetrics,
  thresholds: PrintPaletteThresholds,
): {
  failReasons: PrintPaletteComplianceReason[];
  warnReasons: PrintPaletteComplianceReason[];
} {
  const failReasons: PrintPaletteComplianceReason[] = [];
  const warnReasons: PrintPaletteComplianceReason[] = [];

  if (metrics.garmentMatchingFraction >= thresholds.failGarmentMatching) {
    failReasons.push("excessive_garment_matching_ink");
  }
  if (
    metrics.paletteCoverageFraction < thresholds.failLowCoverage &&
    metrics.garmentMatchingFraction >= thresholds.failLowCoverageMatching
  ) {
    failReasons.push("hard_palette_not_dominant");
  }
  if (
    metrics.luminanceContrastDelta !== null &&
    metrics.luminanceContrastDelta < thresholds.warnLowContrastDelta &&
    metrics.garmentMatchingFraction >= thresholds.warnGarmentMatching
  ) {
    // Only escalate to FAIL when matching ink is already at fail level.
    if (metrics.garmentMatchingFraction >= thresholds.failGarmentMatching) {
      failReasons.push("insufficient_contrast");
    } else {
      warnReasons.push("insufficient_contrast");
    }
  }

  if (failReasons.length > 0) {
    return { failReasons: unique(failReasons), warnReasons: [] };
  }

  if (metrics.garmentMatchingFraction >= thresholds.warnGarmentMatching) {
    warnReasons.push("notable_non_palette_accents");
  }
  if (metrics.paletteCoverageFraction < thresholds.warnLowCoverage) {
    warnReasons.push("hard_palette_not_dominant");
  }

  return { failReasons: [], warnReasons: unique(warnReasons) };
}

function measureVisiblePixels(image: RgbaImage, visibleAlpha: number) {
  const { data } = image;
  let visibleWeight = 0;
  let veryLightWeight = 0;
  let lightWeight = 0;
  let midWeight = 0;
  let darkWeight = 0;
  let nearBlackWeight = 0;
  let luminanceWeightSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < visibleAlpha) continue;
    const w = a / 255;
    const y = pixelLuminance(data[i]!, data[i + 1]!, data[i + 2]!);
    visibleWeight += w;
    luminanceWeightSum += y * w;
    if (y >= LUMINANCE_VERY_LIGHT) veryLightWeight += w;
    else if (y >= LUMINANCE_LIGHT) lightWeight += w;
    else if (y >= LUMINANCE_MID_LOW) midWeight += w;
    else if (y >= LUMINANCE_NEAR_BLACK) darkWeight += w;
    else nearBlackWeight += w;
  }

  return {
    visibleWeight,
    veryLightWeight,
    lightWeight,
    midWeight,
    darkWeight,
    nearBlackWeight,
    luminanceWeightSum,
  };
}

/** Alpha-weighted count of visible pixels near any mapped required palette RGB. */
function measurePaletteProximityCoverage(
  image: RgbaImage,
  colors: string[],
  visibleAlpha: number,
): number {
  const targets = colors
    .map((c) => resolveNamedRgb(c))
    .filter((rgb): rgb is readonly [number, number, number] => rgb !== null);
  if (targets.length === 0) return 0;

  const { data } = image;
  let coverage = 0;
  const maxDist = 90; // Euclidean RGB — allows light-gray for "white", charcoal for "black"
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < visibleAlpha) continue;
    const w = a / 255;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    let nearest = Infinity;
    for (const t of targets) {
      const dr = r - t[0];
      const dg = g - t[1];
      const db = b - t[2];
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < nearest) nearest = d;
    }
    if (nearest <= maxDist) coverage += w;
  }
  return coverage;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
