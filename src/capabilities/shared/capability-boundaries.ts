/**
 * Documented dependency directions for the capability architecture.
 * These are conventions enforced by composition and code review (Sprint 2C,
 * refined Sprint 2E, adaptive interview Sprint 2F, adaptive revisions
 * Sprint 2G Part 2, real generation infrastructure Sprint 2H Part 1,
 * Concept Evaluation architecture Sprint 2I Phase 1, first real Concept
 * Evaluation provider Sprint 2I Phase 2, Regeneration Intelligence
 * architecture Sprint 2J Phase 1, pipeline integration Sprint 2J Phase 2,
 * live regeneration path Sprint 2J Phase 3).
 *
 * Pipeline (Sprint 2G Part 2):
 *   Conversation → IntentExtraction → DesignBrief
 *                → RevisionIntelligence (old brief, new brief → impact)
 *                → BriefEvaluation → DesignIntelligence (scoped by impact)
 *                → InterviewIntelligence → best next act
 *                → DesignSummary → Approval → ConceptGeneration
 *                  (± RevisionIntelligence-driven concept regeneration)
 *
 * Live regeneration pipeline (Sprint 2J Phase 3 — explicit customer path
 * only; `GenerationJob.kind === "regeneration"`):
 *   Customer "Generate Updated Concepts"
 *        ↓
 *   ConceptGenerationCapability.regenerateAfterRevision (enqueue)
 *        ↓
 *   GenerationWorkerCapability
 *        ↓
 *   RevisionIntelligence (consecutive DesignBriefVersions → impacts)
 *        ↓
 *   RevisionTimelineCapability.derive → ephemeral RevisionTimeline
 *        ↓
 *   RegenerationIntelligenceCapability.planNextGeneration
 *        → ephemeral RegenerationPlan
 *        ↓
 *   GenerationIntent(approvedBrief, regenerationPlan)  // immutable;
 *                                                      // never persisted
 *        ↓
 *   PromptTranslationCapability.translate(generationIntent)
 *        → GenerationPromptRequest
 *        ↓
 *   ConceptGenerationProvider → Asset → Concept Evaluation → Persist
 *
 * Initial generation (`kind === "initial"`) builds
 * `GenerationIntent(brief, plan=null)` only — no RevisionTimeline, no
 * RegenerationPlan. Prompt output is byte-for-byte equivalent to the
 * historical brief-only translator.
 *
 * RegenerationIntelligence never generates artwork, never evaluates
 * artwork, never re-scores concepts, and never mutates the Design Brief.
 * RevisionTimeline, RegenerationPlan, and GenerationIntent are always
 * ephemeral — there is no revision_history table and no stored plans.
 *
 * GenerationAttempt authority: `GenerationJob` completed-job ordinal
 * (`resolveGenerationAttemptNumber`) is the sole source for
 * `RegenerationPlan.generationAttempt`. Do not confuse with
 * `GenerationJob.attempts` (per-job claim/retry budget).
 *
 * Generation pipeline (Sprint 2H Part 1 + Sprint 2I Phase 1 + 2J Phase 3):
 *   ConceptGeneration → GenerationWorker → GenerationIntent →
 *                  PromptTranslation → ConceptGenerationProvider
 *                  (interface; a provider adapter owns 100% of its own
 *                  prompt dialect and quality-boosting language internally
 *                  — never exported, never persisted) → AssetCapability
 *                  → ConceptEvaluationCapability → durable GenerationJob
 *                  + ArtworkVersion rows. None of job id / asset id /
 *                  provider key / prompt language / evaluation scores /
 *                  GenerationIntent is ever placed in a customer-facing
 *                  message or `ProjectSnapshot` field the UI renders as such.
 *
 * Allowed (high level):
 *   Conversation → IntentExtraction, DesignBrief, BriefEvaluation,
 *                  DesignIntelligence, InterviewIntelligence,
 *                  RevisionIntelligence, DesignSummary, ConceptGeneration
 *   IntentExtraction → Design Brief data (read-only, for context) +
 *                  `shared/interview-coverage-policy`
 *   DesignBrief → persistence port only
 *   BriefEvaluation → Design Brief data only + interview-coverage-policy
 *   RevisionIntelligence → two Design Brief snapshots only +
 *                  `shared/product-rule-packs`
 *   RevisionTimeline → DesignBriefVersions, GenerationJobs, ArtworkVersions,
 *                  TimedRevisionImpact[] only. Never persists.
 *   DesignIntelligence → ProductIntelligence, BriefEvaluation, optional
 *                  RevisionImpact, `shared/question-phrasing`
 *   InterviewIntelligence → BriefEvaluation, IntelligenceAssessment,
 *                  optional RevisionImpact, shared phrasing/policy
 *   DesignSummary → Design Brief data, BriefEvaluation
 *   ConceptGeneration → enqueue only; never calls providers
 *   PromptTranslation → GenerationIntent only. Pure and deterministic.
 *                  Without regenerationPlan, identical to historical
 *                  brief-only translation.
 *   ConceptEvaluation → approved brief + concept presentation + asset refs
 *   AssetCapability → persistence only
 *   GenerationWorker → PromptTranslation, providers, assets, concept
 *                  evaluation, and (regeneration only) RevisionIntelligence
 *                  + RevisionTimeline + RegenerationIntelligence via
 *                  `buildGenerationIntentForJob`
 *   RegenerationIntelligence → approved brief, evaluation, RevisionTimeline,
 *                  GenerationAttempt from GenerationJob. Optional
 *                  RejectedConceptMemory — graceful when absent.
 *
 * Forbidden:
 *   Conversation directly patching Design Brief fields
 *   BriefEvaluation depending on Conversation, Interview, Generation,
 *     Providers, UI, or Print Vault
 *   RevisionIntelligence mutating the Design Brief
 *   RevisionTimeline / RegenerationPlan / GenerationIntent persistence
 *   Regeneration Intelligence generating artwork or re-scoring evaluation
 *   Regeneration Intelligence inventing a parallel generationAttempt counter
 *   PromptTranslation emitting provider dialect or quality-boosting keywords
 *   PromptTranslation mutating the approved Design Brief
 *   Automatic regeneration, ranking, evaluation gating, or concept
 *     suppression driven by Regeneration Intelligence
 *   Provider adapters receiving a raw Design Brief instead of a
 *     PromptTranslation-produced GenerationPromptRequest
 *   Design Brief storing prompt syntax / provider dialect
 *   GenerationIntent, job ids, asset ids, evaluation scores, or provider
 *     identity reaching customer-facing messages
 */

export const CAPABILITY_BOUNDARY_VERSION = "2J3" as const;
