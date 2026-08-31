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
} from "./contracts";
export {
  aggregateDeterministicEvidence,
  checkExtensionRegions,
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
