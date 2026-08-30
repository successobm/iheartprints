export * from "./contracts";
export {
  RIGID_RECT_UP_TO_24X36_V1,
  RIGID_SIGN_RESOLUTION_POLICIES,
  SIGN_RECONSTRUCTION_HEADROOM,
  SIGN_RECONSTRUCTION_SCALE_CEILING,
  getSignResolutionPolicyById,
  resolveSignResolutionPolicy,
  type SignResolutionPolicy,
} from "./resolution-policy";
export { isValidOrderedDimensionIn, resolveSignProductionSpec } from "./sign-spec";
export {
  EDGE_BACKGROUND_TOLERANCE,
  edgeBandDepthPx,
  inspectAllSignEdges,
  inspectSignEdge,
} from "./edge-inspection";
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
  type SignPlanningOutcome,
  type SignPreparationCapability,
  type UploadSignArtworkInput,
} from "./sign-preparation-capability";
export {
  encodeSignPlate,
  executeSignRepairPlan,
  planContainsOnlyAdmittedSteps,
  type SignExecutionBounds,
  type SignExecutionRefusalReason,
  type SignExecutionResult,
} from "./sign-transform-executor";
