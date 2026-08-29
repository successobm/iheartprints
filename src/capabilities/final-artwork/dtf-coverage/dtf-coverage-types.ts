/**
 * DTF Coverage Intelligence — Phase 2A (Section 12 of this phase's plan):
 * the deterministic measurement model.
 *
 * OBJECTIVE PLATE PROPERTIES ONLY. This module answers "how much of this
 * plate is ink, and how is that ink arranged?" — it never answers "will
 * this print feel soft on a shirt?" Film, powder, ink chemistry, white
 * underbase, curing, printer/RIP settings, garment fabric, and press
 * conditions all affect actual DTF transfer hand, and none of them are
 * observable from a PNG's pixels. See this capability's own doc comment and
 * ARCHITECTURE.md's "DTF Coverage Intelligence Foundation" section for the
 * full boundary. Naming in this module is deliberately restrained —
 * "coverage," "continuous coverage," "plate density" — never "softness,"
 * "hand score," or any percentage-softer claim (Section 16).
 *
 * Distinct from Feature Integrity: Feature Integrity asks "will this
 * geometry survive production?" (a reproduction-integrity question).
 * Coverage asks "how much continuous ink does reproducing it actually
 * require?" (a transfer-efficiency question) — Axis 1 vs. Axis 2 of this
 * phase's long-term DTF objective. Coverage measurement applies to BOTH
 * `standard_raster` and `halftone_dtf` production treatments (Section 18) —
 * unlike Feature Integrity, which is standard-raster only.
 */

import type { ComponentBounds } from "../feature-integrity/connected-components";

export const DTF_COVERAGE_ALGORITHM_VERSION = "iheartprints_dtf_coverage_v1";

/** How many continuous-region records the engine keeps, largest-first. Mirrors Feature Integrity's own payload-size discipline. */
export const DTF_COVERAGE_MAX_CONTINUOUS_REGIONS = 20;

export type AlphaBandName = "transparent" | "low" | "medium" | "high" | "opaque";

/**
 * The five alpha bands' fixed boundaries, in raw 0-255 alpha units. `low`'s
 * floor and `opaque`'s floor deliberately reuse `DEFAULT_ALPHA_THRESHOLD`/
 * `STRONG_INK_ALPHA_THRESHOLD` (`../feature-integrity/alpha-masks`) so
 * "opaque" always means exactly the same thing as Feature Integrity's
 * `strongInk` mask — one definition of "solid ink," never two. `medium`'s
 * boundary bisects the remaining span evenly. Diagnostic bands only — see
 * this module's own doc comment; no production decision reads these
 * directly.
 */
export const ALPHA_BAND_BOUNDARIES: Record<AlphaBandName, { min: number; max: number }> = {
  transparent: { min: 0, max: 8 },
  low: { min: 8, max: 72 },
  medium: { min: 72, max: 136 },
  high: { min: 136, max: 200 },
  opaque: { min: 200, max: 256 },
};

export interface AlphaBandCoverage {
  band: AlphaBandName;
  pixelCount: number;
  /** Fraction of ALL plate pixels (not just visible ones) in this band. The five bands always sum to 1. */
  fractionOfPlate: number;
}

export type { ComponentBounds };

/** One measured continuous strong-ink region (Section 13). */
export interface ContinuousRegion {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  physicalAreaMm2: number;
  widthMm: number;
  heightMm: number;
  /** This region's area as a fraction of the WHOLE plate (transparent margin included). */
  fractionOfPlateArea: number;
  /** This region's area as a fraction of all strong-ink pixels on the plate — the more meaningful "how big relative to the design" figure. */
  fractionOfPrintedArea: number;
}

export interface ContinuousRegionSummary {
  /** Largest-first, capped at `DTF_COVERAGE_MAX_CONTINUOUS_REGIONS`. */
  components: ContinuousRegion[];
  totalComponentCount: number;
  largestAreaMm2: number | null;
  largestFractionOfPlateArea: number | null;
  largestFractionOfPrintedArea: number | null;
  /**
   * Count of strong-ink regions at or above
   * `LARGE_CONTINUOUS_REGION_MIN_FRACTION_OF_PRINTED_AREA` — a DIAGNOSTIC
   * categorization boundary (see that constant's own doc comment), never a
   * treatment threshold. Distinguishes "20% coverage as one big plate" from
   * "20% coverage as a thousand tiny marks" (Section 13).
   */
  largeRegionCount: number;
}

/**
 * The full deterministic DTF Coverage measurement for one FINAL production
 * raster at its confirmed physical size (standard raster or halftone —
 * Section 18). Always measured against the plate the customer would
 * actually download, exactly like Feature Integrity.
 */
export interface DtfCoverageMeasurement {
  algorithmVersion: string;
  plateWidthPx: number;
  plateHeightPx: number;
  confirmedWidthIn: number;
  confirmedHeightIn: number;
  pixelPitchXMm: number;
  pixelPitchYMm: number;
  plateAreaMm2: number;

  /** Fraction (0-1) of plate pixels with alpha >= `DEFAULT_ALPHA_THRESHOLD` — anything a customer would call "printed." */
  visibleCoverageFraction: number;
  /** Fraction of plate pixels with alpha >= `STRONG_INK_ALPHA_THRESHOLD` — solid, reliably-opaque ink. */
  strongInkCoverageFraction: number;
  /** Fraction of plate pixels that are visible but not strong ink (soft edges, glows, faint tone). */
  partialAlphaCoverageFraction: number;
  /**
   * `sum(alpha / 255) / totalPixels` — a CONTINUOUS coverage metric that
   * credits partial-alpha pixels proportionally to their own alpha, rather
   * than the binary in-or-out view the three fractions above give. Never
   * called "ink consumption" or similar — see this module's own doc comment
   * (Section 15): it is an objective property of the pixels, not a claim
   * about how much ink a RIP/printer will actually lay down.
   */
  alphaWeightedCoverageFraction: number;

  /** Physical area of the whole plate, in mm² — `confirmedWidthIn * confirmedHeightIn` converted. Always equals `plateAreaMm2` restated per-axis; kept alongside the fraction fields for convenient reporting. */
  physicalVisibleAreaMm2: number;
  physicalStrongInkAreaMm2: number;
  /** `alphaWeightedCoverageFraction * plateAreaMm2` — an "ink-equivalent area," explicitly NOT a claim about actual ink consumption (Section 15). */
  alphaWeightedEquivalentAreaMm2: number;

  alphaBands: AlphaBandCoverage[];

  continuousRegions: ContinuousRegionSummary;

  limitations: string[];
}
