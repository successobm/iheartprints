export {
  buildRegenerationPlan,
  createRegenerationIntelligenceCapability,
  type RegenerationIntelligenceCapability,
} from "./regeneration-intelligence-capability";
export type {
  CurrentGenerationMetadata,
  RegenerationChange,
  RegenerationChangeSource,
  RegenerationConceptEvaluationInput,
  RegenerationIntelligenceInput,
  RegenerationPlan,
} from "./contracts";
// Re-export GenerationAttempt authority helper so callers need not import
// revision-timeline solely for attempt numbering.
export { resolveGenerationAttemptNumber } from "@/capabilities/revision-timeline";
export {
  EMPTY_REJECTED_CONCEPT_MEMORY,
  type RejectedConceptMemory,
  type RevisionTimeline,
} from "@/capabilities/revision-timeline";
