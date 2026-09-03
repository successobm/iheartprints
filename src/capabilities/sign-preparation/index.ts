export * from "./contracts";
export {
  RIGID_RECT_UP_TO_24X36_V1,
  RIGID_SIGN_RESOLUTION_POLICIES,
  SIGN_MINIMUM_SAFE_INSET_IN,
  SIGN_RECONSTRUCTION_HEADROOM,
  SIGN_RECONSTRUCTION_SCALE_CEILING,
  getSignResolutionPolicyById,
  resolveSignResolutionPolicy,
  type SignResolutionPolicy,
} from "./resolution-policy";
export {
  buildSignProductionTemplate,
  signSafeInsetPx,
} from "./sign-production-template";
export { isValidOrderedDimensionIn, resolveSignProductionSpec } from "./sign-spec";
export {
  EDGE_BACKGROUND_TOLERANCE,
  edgeBandDepthPx,
  inspectAllSignEdges,
  inspectSignEdge,
} from "./edge-inspection";
export {
  EDGE_DEPENDENCE_MAX_OUTERMOST_COVERAGE,
  EDGE_DEPENDENCE_MIN_DOMINANT_COVERAGE,
  EDGE_DEPENDENCE_MIN_RUN_FRACTION,
  affectedEdgesForAxis,
  anyEdgeIsEdgeDependent,
  isEdgeDependentStructure,
} from "./edge-dependence";
export {
  SIGN_ASPECT_TOLERANCE,
  SIGN_PPI_TOLERANCE,
  containPlacement,
  inspectSignArtwork,
} from "./sign-inspection";
export { diagnoseInspection, diagnoseSpecResolution } from "./sign-diagnosis";
export { computeSignPlanKey, stableStringify } from "./sign-plan-identity";
export { planSignRepair as formulateSignRepairPlan, type SignPlanningInput } from "./sign-repair-planner";
export { deriveRigidSignProductionRequirements } from "./sign-production-requirements";
export {
  SignPreparationStateError,
  createSignPreparationCapability,
  type SignCompositionOperatorInput,
  type SignPlanningOutcome,
  type SignPreparationCapability,
  type UploadSignArtworkInput,
} from "./sign-preparation-capability";
export {
  adaptGeometryStepsToActualReconstruction,
  buildSignExecutionGeometryEvidence,
  encodeSignPlate,
  SIGN_EXECUTION_IMPLEMENTATION_VERSION,
  executeAdmittedSignSteps,
  executeSignRepairPlan,
  finalizeSignExecution,
  planContainsOnlyAdmittedSteps,
  planRequiresBoundedReconstruction,
  planRequiresSemanticPreservationVerification,
  splitPlanAroundReconstruction,
  type AdaptGeometryStepsOutcome,
  type SignExecutionBounds,
  type SignExecutionGeometryEvidence,
  type SignExecutionRefusalReason,
  type SignExecutionResult,
} from "./sign-transform-executor";
export {
  deriveUniformBackgroundExtension,
  type UniformBackgroundExtensionGeometry,
} from "./sign-geometry";
export {
  normalizeProviderAlphaOnVerifiedOpaqueSource,
  type ProviderAlphaNormalizationEvidence,
  type ProviderAlphaNormalizationOutcome,
} from "./sign-provider-alpha-normalization";
export {
  describeSignPlanForCustomer,
  type DescribeSignPlanInput,
  type SignPlanCustomerStatus,
  type SignPlanCustomerView,
} from "./sign-preparation-copy";
export { isAuthorizationSufficientForRisk } from "./sign-plan-authorization";
export {
  describeSignPlanForOperator,
  type DescribeSignPlanForOperatorInput,
  type SignPlanOperatorStepView,
  type SignPlanOperatorView,
} from "./sign-preparation-operator-copy";
export {
  loadSignPlanOperatorReview,
  type SignPlanOperatorReview,
  type SignPlanOperatorProductionStatus,
} from "./sign-plan-operator-review";
// Signs Phase 3B (Canvas-First Correction).
export {
  COMPOSITION_STEP_KINDS,
  applyFillRect,
  applyMoveRegion,
  decodeCropRegionParams,
  decodeFillRectParams,
  decodeFitArtworkToCanvasParams,
  decodeMoveRegionParams,
  deriveUniformFitDimensions,
  encodeCropRegionParams,
  encodeFillRectParams,
  encodeFitArtworkToCanvasParams,
  encodeMoveRegionParams,
  executeCompositionSteps,
  executeCropRegion,
  executeFitArtworkToCanvas,
  isCompositionStepKind,
  type CropRegionParams,
  type FillRectParams,
  type FitArtworkToCanvasParams,
  type MoveRegionParams,
} from "./sign-composition-steps";
export {
  buildSignCompositionPlan,
  type SignCompositionCropInput,
  type SignCompositionFillInput,
  type SignCompositionMoveInput,
  type SignCompositionPlanBuildResult,
  type SignCompositionPlanInput,
  type SignCompositionReconstructionInput,
} from "./sign-composition-plan-builder";
export {
  isSignCompositionPlan,
  verifySignCompositionExecution,
  type SignCompositionVerificationCheck,
  type SignCompositionVerificationResult,
} from "./sign-composition-verification";
