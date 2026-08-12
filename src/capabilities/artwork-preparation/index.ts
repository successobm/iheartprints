export {
  createArtworkPreparationCapability,
  ArtworkPreparationStateError,
  ArtworkUploadRejectedError,
  type ArtworkPreparationCapability,
  type ArtworkPreparationView,
  type GuidedCleanupPreviewInput,
  type GuidedCleanupPreviewResult,
  type GuidedCleanupResult,
  type GuidedCleanupStateView,
  type GuidedCleanupTool,
  type UploadArtworkInput,
  type UploadedArtworkContextInput,
} from "./artwork-preparation-capability";
export {
  isStalePreparedImageResponse,
  opaquePreparedRevision,
} from "./prepared-revision";
export type { GuidedCleanupHighlight } from "./guided-cleanup-candidate";
export type {
  GuidedRemovalOutcome,
  GuidedRemovalPoint,
  GuidedRemovalRecord,
  GuidedRemovalRegion,
  GuidedRemovalResolution,
} from "./guided-removal";
export type {
  GuidedCleanupOperation,
  GuidedMagicColorCleanupOperation,
  GuidedRegionCleanupOperation,
} from "./guided-cleanup-operations";
export {
  MAGIC_SELECT_DEFAULT_TOLERANCE,
  MAGIC_SELECT_RESIDUE_MAX_COMPONENT,
  MAGIC_SELECT_RESIDUE_MAX_THICKNESS,
  MAGIC_SELECT_STRUCTURAL_COLOR_GATE,
  MAGIC_SELECT_RULE_V1,
  MAGIC_SELECT_RULE_V2,
  MAGIC_SELECT_TOLERANCE_MAX,
  MAGIC_SELECT_TOLERANCE_MIN,
  MAGIC_SELECT_TOLERANCE_STEP,
  clampMagicSelectTolerance,
  selectConnectedMagicColor,
  selectMagicColor,
  selectMagicColorByMode,
  selectSimilarMagicColor,
} from "./magic-color-selection";
export type { MagicSelectionMode } from "./magic-color-selection";
export type {
  ArtworkAnalysis,
  ArtworkBounds,
  BackgroundPreparationRecord,
  BackgroundTreatment,
  EdgeStatistics,
  PixelSufficiency,
  RepairabilityAssessment,
  RepairabilityClassification,
  RgbColor,
} from "./contracts";
export {
  describeArtworkForCustomer,
  describeApprovedPreparation,
  describeGuidedCleanupOutcome,
  describePrintReadyPreparation,
  GUIDED_CLEANUP_COPY,
  PRINT_READY_NEEDS_ATTENTION_MESSAGE,
  type ApprovedPreparationCopy,
  type ArtworkPreparationCustomerView,
  type GuidedCleanupOutcomeCode,
  type PrintReadyPreparationCopy,
} from "./preparation-copy";
export {
  MAX_IMAGE_DIMENSION_PX,
  MAX_TOTAL_PIXELS,
  MAX_UPLOAD_BYTES,
  SUPPORTED_UPLOAD_CONTENT_TYPES,
  type UploadRejectionCode,
} from "./upload-limits";
