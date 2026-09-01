export {
  SIGN_PRESERVATION_ALGORITHM_VERSION,
  type SignPreservationCheckResult,
  type SignPreservationContentRegion,
  type SignPreservationDeterministicEvidence,
  type SignPreservationExtensionRegionEvidence,
  type SignPreservationLineageEvidence,
  type SignPreservationRegionMappingEvidence,
  type SignPreservationRgbIntegrityEvidence,
  type SignPreservationSimilarityEvidence,
  // Signs Phase S4.2A
  buildCombinedVerificationAlgorithmVersion,
  deriveSemanticVerdict,
  validateSemanticAnswers,
  SIGN_PRESERVATION_SEMANTIC_CATEGORIES,
  SIGN_PRESERVATION_PROMPT_VERSION,
  SIGN_PRESERVATION_SEMANTIC_SCHEMA_VERSION,
  SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION,
  SIGN_PRESERVATION_GRID_COLUMNS,
  SIGN_PRESERVATION_GRID_ROWS,
  SIGN_PRESERVATION_MAX_IMAGE_COUNT,
  type SignPreservationSemanticCategory,
  type SignPreservationSemanticAnswerValue,
  type SignPreservationSemanticAnswer,
  type SignPreservationSemanticVerdict,
  type SignPreservationSemanticEvidence,
} from "./contracts";
export {
  aggregateDeterministicEvidence,
  checkExtensionRegions,
  checkPerimeterTileExtensionRegions,
  checkLineage,
  checkReconstructionToFinalRgb,
  checkSourceSimilarity,
  deriveContentRegion,
  overallStatusFromDeterministicEvidence,
  type LineageCheckInputs,
  type PadStepGeometry,
  type RegionMappingInputs,
} from "./sign-preservation-deterministic-checks";
export {
  createSignPreservationCapability,
  SignPreservationStateError,
  type SignPreservationCapability,
  type SignPreservationCapabilityError,
} from "./sign-preservation-capability";
export {
  deriveSemanticComparisonImages,
  encodeImageAsDataUri,
  type SignPreservationSemanticImageSet,
} from "./sign-preservation-image-derivation";
export type {
  SignPreservationSemanticImageInput,
  SignPreservationSemanticProvider,
  SignPreservationSemanticProviderResult,
  SignPreservationSemanticRequest,
} from "./sign-preservation-semantic-provider";
export { OpenAISignPreservationSemanticProvider } from "./openai-sign-preservation-semantic-provider";
export { PlaceholderSignPreservationSemanticProvider } from "./placeholder-sign-preservation-semantic-provider";
export { resolveSignPreservationSemanticProvider } from "./resolve-sign-preservation-semantic-provider";
