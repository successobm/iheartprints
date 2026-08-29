/**
 * DTF Feature Integrity Phase 1: public surface of the measurement engine.
 *
 * Process-neutral: this module measures production-raster geometry in
 * physical units and has no opinion about DTF, DTG, or any other production
 * process. See `shared/dtf-feature-integrity-profile.ts` for the provisional
 * DTF-specific classification of these measurements, and ARCHITECTURE.md's
 * "DTF Feature Integrity" section for the full design.
 */

export { measureFeatureIntegrity } from "./measure-feature-integrity";
export type { MeasureFeatureIntegrityInput } from "./measure-feature-integrity";

export {
  FEATURE_INTEGRITY_ALGORITHM_VERSION,
  FEATURE_INTEGRITY_MAX_RECORDS_PER_CATEGORY,
} from "./feature-integrity-types";
export type {
  ComponentBounds,
  FeatureIntegrityMeasurement,
  IsolatedComponent,
  IsolatedComponentGeometry,
  NegativeSpaceChannel,
  NegativeSpaceGeometry,
  PartialAlphaComponent,
  PartialAlphaGeometry,
  PositiveFeatureComponent,
  PositiveFeatureGeometry,
} from "./feature-integrity-types";

export { buildAlphaMasks, DEFAULT_ALPHA_THRESHOLD, STRONG_INK_ALPHA_THRESHOLD } from "./alpha-masks";
export type { AlphaMasks } from "./alpha-masks";
