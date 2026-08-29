/**
 * DTF Physical Calibration Phase 2B — public surface.
 *
 * Developer-only calibration harness. Does NOT change production thresholds,
 * PrintValidation readiness, or treatment selection. See ARCHITECTURE.md §23m.
 */

export {
  CALIBRATION_ALGORITHM_VERSION,
  CALIBRATION_BUNDLE_VERSION,
  assertManifestIntegrity,
  generateCalibrationBundle,
} from "./generate";
export type { GeneratedCalibrationBundle, GeneratedCalibrationSheet } from "./generate";

export {
  CALIBRATION_PPI,
  MM_PER_INCH,
  inchesToPx,
  mmToExactPx,
  pxToMm,
  quantizePhysicalWidthMm,
} from "./units";

export {
  OBSERVATION_SCHEMA_VERSION,
  blankRunMetadata,
  blankSpecimenObservation,
  buildBlankObservationDocument,
  validateObservationDocument,
} from "./observation";

export { POSITIVE_WIDTHS_MM, DISTRESS_SEED, SHEET_A_WIDTH_IN, SHEET_A_HEIGHT_IN } from "./sheet-a";
export { ALPHA_LEVELS, SHEET_B_WIDTH_IN, SHEET_B_HEIGHT_IN } from "./sheet-b";
export { SHEET_C_WIDTH_IN, SHEET_C_HEIGHT_IN } from "./sheet-c";

export type {
  CalibrationBundleManifest,
  CalibrationObservationDocument,
  CalibrationRunMetadata,
  CalibrationSheetId,
  SheetManifest,
  SpecimenCategory,
  SpecimenManifestEntry,
  SpecimenObservation,
  SubjectiveHand,
  SurvivalOutcome,
} from "./types";
