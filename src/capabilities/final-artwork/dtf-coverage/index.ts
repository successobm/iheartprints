/**
 * DTF Coverage Intelligence — Phase 2A: public surface.
 *
 * Objective plate coverage measurement only — see `dtf-coverage-types.ts`'s
 * doc comment for the boundary against any claim of physical softness/hand,
 * and ARCHITECTURE.md's "DTF Coverage Intelligence Foundation" section for
 * the full design and its relationship to future raster/halftone/hybrid
 * treatment intelligence (none of which is implemented by this module).
 */

export { measureDtfCoverage, LARGE_CONTINUOUS_REGION_MIN_FRACTION_OF_PRINTED_AREA } from "./measure-dtf-coverage";
export type { MeasureDtfCoverageInput } from "./measure-dtf-coverage";

export {
  ALPHA_BAND_BOUNDARIES,
  DTF_COVERAGE_ALGORITHM_VERSION,
  DTF_COVERAGE_MAX_CONTINUOUS_REGIONS,
} from "./dtf-coverage-types";
export type {
  AlphaBandCoverage,
  AlphaBandName,
  ComponentBounds,
  ContinuousRegion,
  ContinuousRegionSummary,
  DtfCoverageMeasurement,
} from "./dtf-coverage-types";
