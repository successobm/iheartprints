/**
 * DTF Coverage Intelligence — Phase 2A: the measurement orchestrator.
 *
 * Pure — no I/O, no PNG codec (the caller decodes bytes into an `RgbaImage`
 * first, exactly like Feature Integrity). See `dtf-coverage-types.ts`'s doc
 * comment for the objective-plate-property boundary this module observes.
 *
 * REUSE, NOT SHARED STATE (Section 23 of this phase's plan): this module
 * calls `buildAlphaMasks` and `labelConnectedComponents` independently
 * rather than accepting a precomputed `FeatureIntegrityMeasurement`'s own
 * results. Both are O(n) passes over the plate — cheap relative to a
 * distance transform or ridge extraction, and paying that cost twice (once
 * here, once in Feature Integrity, when both run for the same standard-
 * raster job) keeps this module usable on its own for a halftone plate,
 * where Feature Integrity never runs at all (Section 18). True duplication
 * risk (an accidentally quadratic pass) is what Section 23 actually warns
 * against; two independent linear passes over a several-thousand-pixel
 * plate is not that.
 */

import type { RgbaImage } from "../raster-transform";
import { buildAlphaMasks, DEFAULT_ALPHA_THRESHOLD, STRONG_INK_ALPHA_THRESHOLD } from "../feature-integrity/alpha-masks";
import { labelConnectedComponents } from "../feature-integrity/connected-components";
import {
  ALPHA_BAND_BOUNDARIES,
  DTF_COVERAGE_ALGORITHM_VERSION,
  DTF_COVERAGE_MAX_CONTINUOUS_REGIONS,
  type AlphaBandCoverage,
  type AlphaBandName,
  type ContinuousRegion,
  type DtfCoverageMeasurement,
} from "./dtf-coverage-types";

const MM_PER_INCH = 25.4;
const ALPHA_BAND_NAMES: AlphaBandName[] = ["transparent", "low", "medium", "high", "opaque"];

/**
 * Provisional. DIAGNOSTIC categorization boundary only (Section 13) — a
 * strong-ink region at or above this fraction of ALL printed (strong-ink)
 * area counts toward `largeRegionCount`. Never a treatment threshold: no
 * check, no decision, and no future raster-vs-halftone recommendation may
 * read this number as authorization for anything. 5% is chosen so a handful
 * of genuinely large fills/backgrounds are counted without also counting
 * ordinary letterforms in typical apparel artwork.
 */
export const LARGE_CONTINUOUS_REGION_MIN_FRACTION_OF_PRINTED_AREA = 0.05;

export interface MeasureDtfCoverageInput {
  image: RgbaImage;
  confirmedWidthIn: number;
  confirmedHeightIn: number;
}

export function measureDtfCoverage(input: MeasureDtfCoverageInput): DtfCoverageMeasurement {
  const { image, confirmedWidthIn, confirmedHeightIn } = input;
  const { width, height } = image;
  const limitations: string[] = [];
  const totalPixels = width * height;

  const pixelPitchXMm = (confirmedWidthIn * MM_PER_INCH) / width;
  const pixelPitchYMm = (confirmedHeightIn * MM_PER_INCH) / height;
  const areaMmPerPx = pixelPitchXMm * pixelPitchYMm;
  const plateAreaMm2 = totalPixels * areaMmPerPx;

  const masks = buildAlphaMasks(image);

  let visibleCount = 0;
  let strongInkCount = 0;
  let partialAlphaCount = 0;
  let alphaSum = 0;
  const bandCounts: Record<AlphaBandName, number> = {
    transparent: 0,
    low: 0,
    medium: 0,
    high: 0,
    opaque: 0,
  };

  for (let i = 0; i < totalPixels; i += 1) {
    const alpha = image.data[i * 4 + 3]!;
    alphaSum += alpha;
    if (masks.visibleArt[i]) visibleCount += 1;
    if (masks.strongInk[i]) strongInkCount += 1;
    if (masks.partialAlpha[i]) partialAlphaCount += 1;
    for (const name of ALPHA_BAND_NAMES) {
      const band = ALPHA_BAND_BOUNDARIES[name];
      if (alpha >= band.min && alpha < band.max) {
        bandCounts[name] += 1;
        break;
      }
    }
  }
  // alpha === 255 falls one past every band's exclusive max (`opaque`'s is
  // 256, deliberately, so this loop never needs a special case) — no
  // adjustment needed here; documented for the reader's benefit only.

  const alphaBands: AlphaBandCoverage[] = ALPHA_BAND_NAMES.map((band) => ({
    band,
    pixelCount: bandCounts[band],
    fractionOfPlate: totalPixels > 0 ? bandCounts[band] / totalPixels : 0,
  }));

  const alphaWeightedCoverageFraction = totalPixels > 0 ? alphaSum / 255 / totalPixels : 0;

  // ---------------------------------------------------------------------
  // Continuous strong-ink regions (Section 13)
  // ---------------------------------------------------------------------
  const inkLabelled = labelConnectedComponents(masks.strongInk, width, height);
  const continuousRegionsAll: ContinuousRegion[] = inkLabelled.components.map((c) => {
    const areaMm2 = c.pixelCount * areaMmPerPx;
    return {
      id: c.id,
      pixelArea: c.pixelCount,
      boundsPx: c.bounds,
      physicalAreaMm2: areaMm2,
      widthMm: c.bounds.width * pixelPitchXMm,
      heightMm: c.bounds.height * pixelPitchYMm,
      fractionOfPlateArea: totalPixels > 0 ? c.pixelCount / totalPixels : 0,
      fractionOfPrintedArea: strongInkCount > 0 ? c.pixelCount / strongInkCount : 0,
    };
  });
  continuousRegionsAll.sort((a, b) => b.pixelArea - a.pixelArea); // largest-first

  const largeRegionCount = continuousRegionsAll.filter(
    (r) => r.fractionOfPrintedArea >= LARGE_CONTINUOUS_REGION_MIN_FRACTION_OF_PRINTED_AREA,
  ).length;

  if (continuousRegionsAll.length > DTF_COVERAGE_MAX_CONTINUOUS_REGIONS) {
    limitations.push(
      `${continuousRegionsAll.length} continuous strong-ink regions were measured; only the ${DTF_COVERAGE_MAX_CONTINUOUS_REGIONS} largest are recorded here.`,
    );
  }

  return {
    algorithmVersion: DTF_COVERAGE_ALGORITHM_VERSION,
    plateWidthPx: width,
    plateHeightPx: height,
    confirmedWidthIn,
    confirmedHeightIn,
    pixelPitchXMm,
    pixelPitchYMm,
    plateAreaMm2,
    visibleCoverageFraction: totalPixels > 0 ? visibleCount / totalPixels : 0,
    strongInkCoverageFraction: totalPixels > 0 ? strongInkCount / totalPixels : 0,
    partialAlphaCoverageFraction: totalPixels > 0 ? partialAlphaCount / totalPixels : 0,
    alphaWeightedCoverageFraction,
    physicalVisibleAreaMm2: visibleCount * areaMmPerPx,
    physicalStrongInkAreaMm2: strongInkCount * areaMmPerPx,
    alphaWeightedEquivalentAreaMm2: alphaWeightedCoverageFraction * plateAreaMm2,
    alphaBands,
    continuousRegions: {
      components: continuousRegionsAll.slice(0, DTF_COVERAGE_MAX_CONTINUOUS_REGIONS),
      totalComponentCount: continuousRegionsAll.length,
      largestAreaMm2: continuousRegionsAll.length ? continuousRegionsAll[0]!.physicalAreaMm2 : null,
      largestFractionOfPlateArea: continuousRegionsAll.length ? continuousRegionsAll[0]!.fractionOfPlateArea : null,
      largestFractionOfPrintedArea: continuousRegionsAll.length ? continuousRegionsAll[0]!.fractionOfPrintedArea : null,
      largeRegionCount,
    },
    limitations,
  };
}

export { DEFAULT_ALPHA_THRESHOLD, STRONG_INK_ALPHA_THRESHOLD };
