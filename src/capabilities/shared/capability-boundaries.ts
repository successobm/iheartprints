/**
 * Documented dependency directions for the capability architecture.
 * These are conventions enforced by composition and code review (Sprint 2C,
 * refined Sprint 2E, adaptive interview Sprint 2F, adaptive revisions
 * Sprint 2G Part 2).
 *
 * Pipeline (Sprint 2G Part 2):
 *   Conversation → IntentExtraction → DesignBrief
 *                → RevisionIntelligence (old brief, new brief → impact)
 *                → BriefEvaluation → DesignIntelligence (scoped by impact)
 *                → InterviewIntelligence → best next act
 *                → DesignSummary → Approval → ConceptGeneration
 *                  (± RevisionIntelligence-driven concept regeneration)
 *
 * Allowed (high level):
 *   Conversation → IntentExtraction, DesignBrief, BriefEvaluation,
 *                  DesignIntelligence, InterviewIntelligence,
 *                  RevisionIntelligence, DesignSummary, ConceptGeneration
 *   IntentExtraction → Design Brief data (read-only, for context) +
 *                  `shared/interview-coverage-policy` (pure policy data —
 *                  which sections may be deferred). Proposes patches only;
 *                  never writes the brief itself.
 *   DesignBrief → persistence port only
 *   BriefEvaluation → Design Brief data only (TShirtDesignBrief) +
 *                  `shared/interview-coverage-policy`. Pure and
 *                  deterministic: no Conversation, Interview Intelligence,
 *                  Generation, Providers, UI, or Print Vault. Never asks
 *                  questions, never recommends, never generates.
 *   RevisionIntelligence → two Design Brief snapshots only (old, new) +
 *                  `shared/product-rule-packs` (pure dependency table, to
 *                  name affected rule packs). Pure and deterministic: no
 *                  Conversation, no persistence, no providers, no UI. Never
 *                  mutates the brief and never decides what to do about a
 *                  change — only what it means downstream (see
 *                  `RevisionImpact`).
 *   DesignIntelligence → ProductIntelligence (interface), Design Brief data,
 *                  BriefEvaluation (consumes it — does not recreate it),
 *                  optionally a RevisionImpact (to scope which
 *                  ProductIntelligence rule packs run — "do not recompute
 *                  everything"), `shared/question-phrasing` (contradiction
 *                  copy shared with Interview Intelligence's "clarify" act)
 *   InterviewIntelligence → BriefEvaluation, IntelligenceAssessment,
 *                  optionally a RevisionImpact (`selectRevisionAct` — a
 *                  narrower selector for post-approval revisions that only
 *                  reacts to what changed), `shared/interview-coverage-policy`
 *                  (tie-break order), `shared/question-phrasing`
 *                  (ask/clarify/contradiction copy). Does not inspect the
 *                  Design Brief directly for completeness.
 *   DesignSummary → Design Brief data, BriefEvaluation (for section
 *                  resolution only — rendered values still come from the
 *                  brief)
 *   ConceptGeneration → ConceptGenerationProvider (interface), persistence.
 *                  Regeneration after a revision still requires an
 *                  approved Design Brief version — never generates from an
 *                  unapproved working brief, revision or not.
 *   PrintValidation → brief/artwork data (read-only); never mutates briefs
 *   Provider adapters → generation DTOs only; never mutate domain objects
 *
 * `shared/interview-coverage-policy`, `shared/question-phrasing`, and
 * `shared/product-rule-packs` are pure, side-effect-free data/phrasing
 * modules (no capability instance, no DI) — peers of `shared/contracts`,
 * not capabilities themselves. Multiple capabilities importing them
 * directly is not a capability-boundary violation; it is how, for example,
 * ProductIntelligence and RevisionIntelligence agree on which rule packs
 * depend on which Design Brief sections without either depending on the
 * other (RevisionIntelligence names *which* packs are affected; only
 * ProductIntelligence actually runs them).
 *
 * Forbidden:
 *   Conversation directly patching Design Brief fields
 *   BriefEvaluation depending on Conversation, Interview Intelligence,
 *     Generation, Providers, UI, or Print Vault
 *   BriefEvaluation producing recommendations (that is Design Intelligence's job)
 *   RevisionIntelligence mutating the Design Brief, or depending on
 *     Conversation, persistence, providers, or UI
 *   RevisionIntelligence deciding *what* to do about a change (asking a
 *     question, regenerating concepts) — only Conversation, orchestrating
 *     Interview Intelligence and Concept Generation, may act on its output
 *   Design Intelligence knowing providers, asking questions, or recomputing
 *     objective evaluation BriefEvaluation already produced
 *   Interview Intelligence inspecting the Design Brief directly for completeness
 *   Interview Intelligence depending on Design Intelligence's internals
 *     beyond IntelligenceAssessment, or vice versa (both depend on the
 *     shared phrasing/policy modules instead of on each other)
 *   Print Validation modifying Design Briefs
 *   Provider adapters mutating Design Briefs
 *   Design Brief storing prompt syntax / provider dialect
 */

export const CAPABILITY_BOUNDARY_VERSION = "2G2" as const;
