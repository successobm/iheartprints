/**
 * Documented dependency directions for the capability architecture.
 * These are conventions enforced by composition and code review (Sprint 2C,
 * refined Sprint 2E).
 *
 * Pipeline (Sprint 2E):
 *   Conversation → IntentExtraction → DesignBrief → BriefEvaluation →
 *   DesignIntelligence → InterviewIntelligence → DesignSummary → Approval →
 *   ConceptGeneration
 *
 * Allowed (high level):
 *   Conversation → IntentExtraction, DesignBrief, BriefEvaluation,
 *                  DesignIntelligence, InterviewIntelligence, DesignSummary,
 *                  ConceptGeneration
 *   IntentExtraction → (pure; no brief writes)
 *   DesignBrief → persistence port only
 *   BriefEvaluation → Design Brief data only (TShirtDesignBrief). Pure and
 *                  deterministic: no Conversation, Interview Intelligence,
 *                  Generation, Providers, UI, or Print Vault. Never asks
 *                  questions, never recommends, never generates.
 *   DesignIntelligence → ProductIntelligence (interface), Design Brief data,
 *                  BriefEvaluation (consumes it — does not recreate it)
 *   InterviewIntelligence → BriefEvaluation, IntelligenceAssessment. Does not
 *                  inspect the Design Brief directly for completeness.
 *   DesignSummary → Design Brief data, BriefEvaluation (for section
 *                  known/missing only — rendered values still come from the
 *                  brief)
 *   ConceptGeneration → ConceptGenerationProvider (interface), persistence
 *   PrintValidation → brief/artwork data (read-only); never mutates briefs
 *   Provider adapters → generation DTOs only; never mutate domain objects
 *
 * Forbidden:
 *   Conversation directly patching Design Brief fields
 *   BriefEvaluation depending on Conversation, Interview Intelligence,
 *     Generation, Providers, UI, or Print Vault
 *   BriefEvaluation producing recommendations (that is Design Intelligence's job)
 *   Design Intelligence knowing providers, asking questions, or recomputing
 *     objective evaluation BriefEvaluation already produced
 *   Interview Intelligence inspecting the Design Brief directly for completeness
 *   Print Validation modifying Design Briefs
 *   Provider adapters mutating Design Briefs
 *   Design Brief storing prompt syntax / provider dialect
 */

export const CAPABILITY_BOUNDARY_VERSION = "2E" as const;
