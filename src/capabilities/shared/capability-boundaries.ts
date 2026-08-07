/**
 * Documented dependency directions for the capability architecture.
 * These are conventions enforced by composition and code review (Sprint 2C,
 * refined Sprint 2E, adaptive interview Sprint 2F, adaptive revisions
 * Sprint 2G Part 2, real generation infrastructure Sprint 2H Part 1,
 * Concept Evaluation architecture Sprint 2I Phase 1, first real Concept
 * Evaluation provider Sprint 2I Phase 2, Regeneration Intelligence
 * architecture Sprint 2J Phase 1, pipeline integration Sprint 2J Phase 2,
 * live regeneration path Sprint 2J Phase 3, Conversation Understanding
 * Sprint 2L Phase 1).
 *
 * Pipeline (Sprint 2L Phase 1 — pre-approval turn):
 *   Conversation
 *        ↓ (per turn, best-effort — see ConversationUnderstanding below)
 *   ConversationUnderstanding.interpret(message, boundedContext)
 *        → ConversationUnderstandingResult (ephemeral; never persisted raw)
 *        ↓
 *   IntentExtraction.extract({ ..., understanding })
 *        → reconcile-understanding.ts validates/normalizes the semantic
 *          proposal into the SAME BriefFieldPatch shape extractAdaptive
 *          produces, then merges per-field (validated understanding wins;
 *          extractAdaptive fills every field understanding left
 *          unresolved, and is the sole source when understanding is
 *          null/absent) — exactly ONE authoritative BriefPatchProposal
 *          leaves IntentExtraction; ConversationUnderstanding never
 *          produces a BriefPatchProposal itself and never touches
 *          DesignBrief directly.
 *        ↓
 *   DesignBrief
 *        ↓
 *   RevisionIntelligence (old brief, new brief → impact)
 *        ↓
 *   BriefEvaluation → DesignIntelligence (scoped by impact)
 *        ↓
 *   InterviewIntelligence → best next act
 *        ↓
 *   DesignSummary → Approval → ConceptGeneration
 *     (± RevisionIntelligence-driven concept regeneration)
 *
 * ConversationUnderstanding is provider-neutral semantic interpretation
 * ONLY. It never mutates the Design Brief, never decides what to ask next,
 * never writes a repository, and is never the only interpreter of a
 * customer message — `extractAdaptive` (deterministic) always also runs
 * and is the sole source of truth whenever a provider is unconfigured,
 * skipped (single-token replies — see Goal 12 in the Sprint 2L report), or
 * fails for any reason. See ARCHITECTURE.md "Conversation Understanding"
 * section for the full precedence contract and bounded-context policy.
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
 *   Conversation → IntentExtraction, ConversationUnderstanding, DesignBrief,
 *                  BriefEvaluation, DesignIntelligence, InterviewIntelligence,
 *                  RevisionIntelligence, DesignSummary, ConceptGeneration
 *   ConversationUnderstanding → its own provider port only
 *                  (ConversationUnderstandingProvider). Receives a bounded,
 *                  already-sanitized request built by Conversation (current
 *                  message, plain-language known-brief facts, unresolved
 *                  section list, pending section, a capped recent-turn
 *                  window) — never a raw Design Brief, never persistence,
 *                  never other capabilities' internals.
 *   IntentExtraction → Design Brief data (read-only, for context) +
 *                  `shared/interview-coverage-policy` +
 *                  `ConversationUnderstandingResult` (type-only; consumed
 *                  exclusively via `reconcile-understanding.ts` — Intent
 *                  Extraction never depends on the ConversationUnderstanding
 *                  *capability instance*, only its provider-neutral output
 *                  shape, avoiding a capability→capability dependency cycle)
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
 *                  brief-only translation. Sprint 2K Phase 3: also splits
 *                  reference/inspiration language out of the free-text
 *                  description/style (`creative-reference-extraction.ts`)
 *                  into `GenerationPromptRequest.inspirationReferences` —
 *                  still provider-neutral, plain-language content, never
 *                  dialect.
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
 *   ConversationUnderstanding mutating the Design Brief, writing a
 *     repository, deciding what to ask next, or producing a
 *     BriefPatchProposal itself (reconcile-understanding.ts, inside
 *     IntentExtraction, is the sole place that happens)
 *   ConversationUnderstanding persisting raw provider responses, prompts,
 *     chain-of-thought/reasoning, or numeric confidence (its contract has
 *     no such fields at all — confidence is a 3-value enum, never a score)
 *   IntentExtraction and ConversationUnderstanding independently writing
 *     conflicting values for the same Design Brief field in the same turn
 *     — reconcile-understanding.ts's per-field precedence (validated
 *     understanding wins; deterministic extraction fills gaps) is the one
 *     and only merge point
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
 *   Provider adapters inventing their own concept-direction catalog instead
 *     of `lib/domain/concept-directions.ts` (the one shared, provider-
 *     neutral source of composition/typography/iconography/layout
 *     differentiation content — see Sprint 2K Phase 3 below)
 *
 * Sprint 2K Phase 3 additions (quality/generation-fidelity sprint; no new
 * capabilities, no architecture redesign):
 *   - `lib/domain/concept-directions.ts` — the single, provider-neutral
 *     catalog of the three concept creative directions (composition,
 *     typography emphasis, illustration density, iconography, layout,
 *     visual hierarchy) plus `describeConceptDirection` (the one place a
 *     customer-facing concept description is built). Both
 *     `PlaceholderConceptProvider` (via `lib/domain/concepts.ts`) and
 *     `OpenAIConceptGenerationProvider` consume it — no per-provider
 *     duplicate catalog. Provider dialect (keyword phrasing) still lives
 *     only inside each adapter's own prompt-building function.
 *   - `GenerationPromptRequest` gained two provider-neutral fields:
 *     `inspirationReferences: string[]` (style/era/pop-culture references
 *     split out of free text — never treated as literal content to depict)
 *     and `allowAdditionalText: boolean` (always `false` today — no
 *     invented wording beyond `requiredWording`).
 *   - `shared/field-normalization.ts` — deterministic product/color/print-
 *     location normalization applied at the point Intent Extraction writes
 *     a Design Brief field (not a presentation-only pass), so every
 *     downstream reader sees the canonical form. Required wording is never
 *     touched by this module.
 *   - Intent Extraction gained a general (non-bowling-specific) guard,
 *     `isDedicatedToADifferentPendingSection`, so a short single-clause
 *     reply answering one pending question is never opportunistically
 *     reinterpreted as an update to a different field just because it
 *     contains a generic word (e.g. "shirts" inside a purpose answer).
 *
 * Sprint 2L Phase 1 additions (Conversation Understanding; no persistence/
 * migration change):
 *   - New capability `ConversationUnderstandingCapability`
 *     (`src/capabilities/conversation-understanding/`) — provider-neutral
 *     semantic interpretation of one customer message in bounded context.
 *     Never mutates the brief; see the pipeline diagram above.
 *   - New `IntentExtractionInput.understanding` (optional) and
 *     `reconcile-understanding.ts` — the sole place a
 *     `ConversationUnderstandingResult` is validated, normalized (reusing
 *     `field-normalization.ts`, `appendNote`, `isDeferrable`, and the same
 *     PrintPlacement parsing extraction already used), and merged
 *     per-field against `extractAdaptive`'s deterministic output. Absent/
 *     null `understanding` reproduces pre-Sprint-2L behavior exactly.
 *   - Required wording grounding guard: a proposed `requiredWording`
 *     update is only ever accepted when its value is actually contained in
 *     its own `evidence` quote (normalized for case/punctuation only,
 *     never fuzzy) — the concrete defense against a paraphrased or
 *     hallucinated required wording reaching the brief.
 *   - `"ambiguous"`-confidence proposals are never applied to any field —
 *     Brief Evaluation / Interview Intelligence see the section as
 *     genuinely unresolved and ask about it, same as if nothing were said.
 *   - Provider resolution mirrors Concept Evaluation's asymmetry (never
 *     fail-closed): `resolveConversationUnderstandingProvider` /
 *     `getConversationUnderstandingConfig`
 *     (`CONVERSATION_UNDERSTANDING_PROVIDER=openai|none`, default `none`),
 *     independent of `CONCEPT_GENERATION_ENABLE_REAL`.
 *
 * Sprint 2L Phase 1A additions (live acceptance debugging; no capability
 * boundary changed, no new capability):
 *   - Grounding in `reconcile-understanding.ts` is field-specific, not one
 *     universal rule: `requiredWording` keeps exact evidence containment;
 *     `product` accepts exact containment OR a recognized product-noun
 *     synonym (`PRODUCT_NOUN_CANONICAL`, now exported from
 *     `field-normalization.ts`) that canonicalizes to the same value —
 *     letting "team t-shirts" ground a proposed "T-shirt" without
 *     requiring the literal word "T-shirt" in evidence, while still
 *     rejecting a value with no relationship to evidence at all. Every
 *     other field is unchanged (no additional grounding beyond
 *     "not ambiguous confidence"). See ARCHITECTURE.md §10a.
 *   - `openai-conversation-understanding-provider.ts`'s prompt gained
 *     explicit, general (not entity-specific) product-recognition guidance
 *     plus worked examples spanning multiple domains — the root cause of
 *     the live acceptance failure was prompt guidance, not a pipeline bug.
 *   - `acknowledgeResolvedFields` (`shared/question-phrasing.ts`) replaces
 *     a generic count-only acknowledgement ("I've made those changes")
 *     with one built only from fields that both changed this turn AND
 *     have a real value in the post-patch Design Summary — a field a
 *     provider proposed but reconciliation rejected can never appear in
 *     it, because it never changed the brief.
 *   - New dev-only tracing: `lib/debug/conversation-understanding-trace.ts`
 *     / `lib/config/conversation-understanding-debug.ts`
 *     (`CONVERSATION_UNDERSTANDING_DEBUG=true`, unset/false by default).
 *     The traced event union is itself the security allowlist — it has no
 *     field for secrets, prompts, raw provider responses, chain-of-
 *     thought, or unrelated history. See ARCHITECTURE.md §10a.
 *
 * Sprint 2L Phase 1B additions (goal-directed conversation orchestration;
 * no new capability, no capability signature changed, no persistence/
 * migration change — see ARCHITECTURE.md §10b):
 *   - `interview-coverage-policy.ts` re-scoped: `purpose`, `audience`,
 *     `style`, `colors` moved from `high_value` to `optional`.
 *     `printLocation` is now the only `high_value` (ask-worthy) section;
 *     `product`/`graphics`/`requiredWording`/`productColor` remain
 *     `required` (blocking), unchanged. `questionNecessity(section)` is a
 *     new, explicitly-named thin wrapper over `tierOf` — no new decision
 *     logic, just a self-documenting API for the same tiers.
 *   - `BriefEvaluationCapability` and `InterviewIntelligenceCapability`
 *     required ZERO code changes to stop proactively asking about the four
 *     re-tiered sections — both already only ever gated/walked
 *     `required`+`high_value` tiers, never `optional`. This is the
 *     concrete proof that Brief Completeness and Generation Readiness were
 *     already architecturally separable; only the *policy data* needed to
 *     change.
 *   - `extraction.ts` deferral precedence: an explicit section mention in
 *     the customer's message now wins over an ambient (but unrelated)
 *     pending section when both are present — needed once `colors` (etc.)
 *     stopped ever being the pending section itself, so a spontaneous
 *     "no preference on colors" said while a different question is
 *     pending still defers colors, not whatever happens to be pending.
 *   - `withResolvedAcknowledgement` (`conversation-capability.ts`) branches
 *     on turn size: a single low-salience field change gets
 *     `shortAcknowledgement` (`shared/question-phrasing.ts` — "Black
 *     works." / "Got it."), never the full per-field synthesis, which is
 *     now reserved for genuinely multi-field turns.
 *   - `naturalizeQuestion` (`conversation-capability.ts`) lightly rewrites
 *     the `productColor`/`graphics` questions using only already-confirmed
 *     brief values. `InterviewIntelligenceCapability` remains brief-unaware
 *     — this happens in Conversation orchestration only.
 *   - Design Summary synthesis quality (Goal 8) is a provider-prompt-only
 *     change (`openai-conversation-understanding-provider.ts`) — no new
 *     capability or synthesis step; deterministic extraction is unchanged
 *     and does not synthesize.
 *   - `DesignBriefDecisionAction` narrowed to `"approve" | "edit"` —
 *     "continue" removed (redundant with "edit"; both ran the identical
 *     adaptive pipeline). `continue_requested` remains a readable
 *     historical `ConversationPhase` value; no migration.
 *
 * Sprint 2L Phase 1C corrections (live-vs-test divergence investigation;
 * bug fixes restoring documented behavior, not new boundaries):
 *   - `naturalizeQuestion` (`conversation-capability.ts`) now reads the
 *     already-quality-gated `DesignSummaryView`, never the raw
 *     `TShirtDesignBrief` — the Phase 1B implementation read the raw
 *     brief, which could (and did, in a live acceptance test) leak a
 *     value `BriefEvaluation` had already rejected as malformed into a
 *     customer-facing question, bypassing the quality gate entirely.
 *   - `extraction.ts`'s `ENTITY_NAME_PATTERNS` capture is now bounded by a
 *     general clause-continuation marker set (`boundEntityCapture` /
 *     `CLAUSE_BOUNDARY_PATTERN`) so a punctuation-free run-on sentence
 *     cannot carry an unrelated trailing clause into a captured entity
 *     name — not a new capability, a correctness fix to an existing
 *     deterministic extractor already documented as the interpretation
 *     safety net (§10a).
 *   - `DesignSummaryCapability.formatForCustomer`'s closing line no longer
 *     describes a third "continue" action — it was never updated when
 *     Phase 1B removed the Continue button, so customer-facing prose and
 *     the actual UI had silently diverged.
 *   - New `"config"` debug trace stage (`resolveConversationUnderstandingProvider`)
 *     and a `willCallProvider` field on the `"request"` stage — both purely
 *     additive to the existing allowlisted trace event union from Phase 1A.
 */

export const CAPABILITY_BOUNDARY_VERSION = "2L1c" as const;
