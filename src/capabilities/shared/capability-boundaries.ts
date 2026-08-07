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
 *
 * Sprint 2M Phase 1 additions (Print Validation & Production Readiness
 * Foundation; replaces the `PrintValidationCapability` stub — no other
 * capability boundary changed):
 *   Pipeline:
 *     Selected / customer-approved concept (ArtworkVersion)
 *          ↓
 *     Caller resolves: asset summary, approved-brief provenance, Concept
 *     Evaluation state — PrintValidation never fetches any of this itself
 *          ↓
 *     PrintValidationCapability.validateArtwork(PrintValidationInput)
 *          → deriveProductionRequirements (pure; reads
 *            `shared/print-placement-dimensions` for placement-driven
 *            target size — never invents a second placement→size table)
 *          → deterministic checks + `calculateEffectiveResolution`
 *            (pixel ÷ physical dimensions only — never PNG DPI metadata)
 *          ↓
 *     PrintValidationReport { status: ready | finalization_required | blocked,
 *                             requirements, checks, requiredTransformations,
 *                             blockingIssues, warnings }
 *          ↓
 *     (Reserved) Future FinalArtworkCapability — transforms/upscales/
 *     vectorizes/reconstructs based on `requiredTransformations`, then
 *     revalidates. Not implemented in Phase 1.
 *   - `PrintValidationCapability` is pure and synchronous, mirroring
 *     `BriefEvaluationCapability`: no repository, no provider, no I/O,
 *     `createPrintValidationCapability()` takes zero arguments. The caller
 *     (a route, a future Final Artwork orchestrator, or a test) resolves an
 *     `ArtworkVersion`'s primary asset, its `designBriefVersionId`
 *     provenance against the design's current approved version, and its
 *     already-persisted Concept Evaluation fields into a
 *     `PrintValidationInput` — the same "caller does I/O, capability only
 *     decides" shape as `ConceptEvaluationCapability.evaluate`.
 *   - New pure modules: `print-validation/production-requirements.ts`
 *     (deterministic keyword classification of product/production category
 *     from already-collected brief text — never a customer-facing question,
 *     Constitution §6.6), `print-validation/effective-resolution.ts`
 *     (pixel ÷ physical-dimension math only), and
 *     `shared/print-placement-dimensions.ts` (target physical dimensions
 *     per `PrintPlacement`, shared so a future `ProductIntelligence`
 *     placement-size rule would read the same table rather than a second
 *     copy).
 *   - `ArtworkVersion.printValidationStatus` remains reserved `null` in
 *     Phase 1 — deliberately not written by anything yet. Like
 *     `BriefEvaluation`/`ConceptStatusView`, a `PrintValidationReport` is
 *     designed to be cheaply recomputed on demand rather than stored as
 *     authority; persisting the top-level `status` onto the existing
 *     (already migration-free, unconstrained `text null`) column is
 *     deferred to whichever future phase actually needs to query/filter by
 *     it. See ARCHITECTURE.md's Print Validation section for the full
 *     audit.
 *   - Old reserved stub contracts `ValidationReport`/`ValidationCheck`/
 *     `ValidationSeverity` (`shared/contracts.ts`, Sprint 2C) are removed —
 *     replaced by the real `PrintValidationReport`/`PrintValidationCheck`
 *     contracts in `print-validation/contracts.ts`, matching how Concept
 *     Evaluation's contracts live in `concept-evaluation/contracts.ts`
 *     rather than the shared file.
 *   - `PrintValidationCapability` never mutates a Design Brief, never calls
 *     a generation/vision/OCR provider, and never transforms, upscales,
 *     vectorizes, or regenerates artwork — Phase 1 determines the truth
 *     about what is required; it does not act on it. Concept Evaluation and
 *     Print Validation continue to share only `ArtworkVersion` fields, never
 *     a capability dependency on each other (unchanged from Sprint 2I).
 *
 * Sprint 2M Phase 2A additions (Provisional Print Readiness Integration;
 * no new capability, no migration, `PrintValidationCapability` itself
 * unchanged from Phase 1):
 *   - `GenerationWorkerCapability` now calls `PrintValidationCapability`
 *     (`runProvisionalPrintValidation`) immediately after Concept
 *     Evaluation completes for each concept — on both the fresh-generation
 *     path and the idempotent `alreadyGenerated` evaluation-backfill path.
 *     `PrintValidationCapability` itself gained zero new dependencies: the
 *     worker resolves everything (asset metadata from the just-uploaded
 *     `GeneratedAssetPayload` or a fetched `AssetRecord`; brief provenance
 *     via a fresh `repo.getLatestDesignBriefVersion` call; Concept
 *     Evaluation state already computed in the same code path) and passes
 *     it through the new pure `assembleProvisionalPrintValidationInput`
 *     (`print-validation/assemble-input.ts`) before calling
 *     `validateArtwork`.
 *   - This is **provisional intelligence about a generated concept**, never
 *     authoritative validation of finished production artwork — see
 *     ARCHITECTURE.md §5 "Provisional Print Readiness vs. Final Print
 *     Validation". The result is logged only
 *     (`lib/config/print-validation-logging.ts`, whitelisted fields —
 *     status + counts, never check reasons, requirements, or asset detail)
 *     and otherwise discarded: never written to
 *     `ArtworkVersion.printValidationStatus` (re-audited, not merely
 *     carried over from the Phase 1 report — see ARCHITECTURE.md §5 for
 *     why persisting it there would be actively ambiguous, not just
 *     redundant), never changes `PrintProject.status`, never freezes or
 *     marks an `ArtworkVersion` as final, never executes
 *     `requiredTransformations`.
 *   - `runProvisionalPrintValidation` is deliberately swallow-on-error: any
 *     failure inside it (including its own `getLatestDesignBriefVersion`
 *     lookup) is caught and logged
 *     (`logProvisionalPrintValidationFailure`), never rethrown — it must
 *     never fail, retry, or alter a `GenerationJob`'s outcome. A
 *     `PrintValidationReport.status === "blocked"` result (e.g. the
 *     placeholder provider's concepts, which have no real image bytes) is
 *     equally swallowed-into-a-log-line — "blocked" describes the concept's
 *     print-readiness, not a concept-generation failure, and must never be
 *     conflated with one.
 *   - Idempotent under retry: `runProvisionalPrintValidation` only ever
 *     runs against already-persisted, immutable `ArtworkVersion`/asset
 *     data, so a retried/recovered job computes the same
 *     `PrintValidationReport` (barring `evaluatedAt`) and produces at most
 *     one additional harmless log line — never a duplicate artwork version,
 *     asset, evaluation record, or lifecycle-state change.
 *
 * Sprint 2M Phase 2B additions (Final Artwork Lifecycle & Production
 * Approval Boundary — the gap Phase 2A's report explicitly reserved):
 *   Pipeline:
 *     Customer selects a concept (ArtworkVersion.isSelected /
 *     PrintProject.selectedArtworkVersionId — unchanged, still just
 *     "I want to work with this direction")
 *          ↓
 *     Revision / regeneration [optional, repeatable — unchanged]
 *          ↓
 *     Customer's EXPLICIT "prepare print-ready artwork" action
 *          ↓
 *     ConversationCapability.approveFinalDirection(designId, artworkVersionId)
 *          ↓
 *     FinalArtworkCapability.requestFinalArtwork  (new capability)
 *          → validates artworkVersionId belongs to this project, is the
 *            current (latest-batch) concept, is the project's currently
 *            selected concept, and is not stale relative to the working
 *            brief — throws otherwise
 *          → idempotently persists a FinalDirectionApproval ("active";
 *            at most one per project; a differing prior approval is
 *            superseded first, never overwritten)
 *          → idempotently persists a FinalArtworkJob (status "queued",
 *            keyed 1:1 to the approval — a duplicate request finds the
 *            same row, never a second one)
 *          → sets PrintProject.status = "finalizing"
 *          ↓
 *     (Reserved, not implemented in Phase 2B) a future worker claims the
 *     FinalArtworkJob, performs production transformations per
 *     PrintValidationReport.requiredTransformations, produces production
 *     AssetRecord(s) (assets.final_artwork_job_id set — never a filename/
 *     bucket-path convention), and re-runs PrintValidationCapability
 *     against that real production asset — only THAT later, authoritative
 *     run may ever justify PrintProject.status = "print_ready".
 *   - `FinalDirectionApproval` is a new, durable, append-only record —
 *     never a mutable boolean on `ArtworkVersion` or `PrintProject`. Chosen
 *     over both alternatives (see the Phase 2B report's "IMPORTANT DESIGN
 *     QUESTION" analysis) for the same reasons `DesignBriefVersion` is its
 *     own table rather than a flag on the working brief: auditability,
 *     non-destructive supersession, and unambiguous idempotency via
 *     `status`, not a shared mutable field.
 *   - `FinalArtworkCapability` is the sole owner of `FinalDirectionApproval`
 *     writes and `FinalArtworkJob` writes — mirrors `DesignBriefCapability`
 *     ("sole mutation path for the working brief and approved versions").
 *     Depends on `ProjectRepository` and the same shared pure modules
 *     Concept Generation's staleness check uses
 *     (`shared/brief-diff`, `shared/concept-relevance`) — never on
 *     `ConceptGenerationCapability` itself, never on a provider, never on
 *     `PrintValidationCapability` (Phase 2B has no production asset to
 *     validate yet, so nothing calls it from this path).
 *   - `GenerationWorkerCapability`'s regeneration-completion path now also
 *     calls `repo.supersedeActiveFinalDirectionApproval` (alongside its
 *     existing `selectedArtworkVersionId: null` reset) — a new concept
 *     batch means any prior final-direction approval's artwork no longer
 *     exists as "the current direction"; it can never silently authorize
 *     production of what just replaced it. Safe/idempotent when nothing is
 *     currently active.
 *   - `AssetRecord.finalArtworkJobId` (new, reserved, always null in Phase
 *     2B) is the explicit, non-filename, non-bucket-path way to tell a
 *     concept-stage asset (`generationJobId` set) apart from a future
 *     production deliverable (`finalArtworkJobId` set) — see
 *     ARCHITECTURE.md.
 *   - `ArtworkVersion.printValidationStatus` is unchanged, still reserved
 *     `null` — Phase 2B re-confirms Phase 2A's audit with a sharper reason:
 *     even once authoritative validation exists, it will never belong on
 *     `ArtworkVersion` at all (one approved direction may yield multiple
 *     production assets — PNG, SVG, PDF — each with its own readiness), so
 *     its eventual home is a production-asset-scoped record, not this
 *     column.
 *   - No new customer-facing job/approval ids, internal statuses, or
 *     storage details are exposed. `conversation-service.ts` derives a
 *     customer-safe `CustomerFinalizationStatus` (`not_requested` /
 *     `preparing` / `print_ready`) purely from `PrintProject.status` —
 *     never from a raw `FinalDirectionApproval`/`FinalArtworkJob` row.
 *   - `FinalArtworkCapability` must never select concepts, interpret
 *     conversation, evaluate creative quality, decide customer intent
 *     (the caller already decided; this capability only validates and
 *     persists), duplicate Print Validation's rules, or mark anything
 *     print-ready without a real, authoritative validation run against a
 *     real production asset.
 *
 * Sprint 2M Phase 2C additions (First Real Production Artwork Pipeline —
 * Raster Apparel; the gap every prior 2M phase explicitly reserved):
 *   Pipeline:
 *     FinalDirectionApproval ("active")
 *          ↓
 *     FinalArtworkJob ("queued")
 *          ↓
 *     FinalArtworkWorkerCapability.processNextJob  (new — independent
 *     worker, never invoked from a customer request; atomic claim mirrors
 *     GenerationWorkerCapability exactly, own table/own claim methods)
 *          → resolves the exact active approval, its exact ArtworkVersion,
 *            approved DesignBriefVersion, source concept AssetRecord —
 *            rejects a superseded approval, a cross-project asset, or a
 *            missing source asset rather than guessing
 *          → deriveProductionRequirements (reused, unchanged, from
 *            PrintValidationCapability) resolves target physical size from
 *            the existing PrintPlacement policy table — an unsupported
 *            production method or unknown print location completes the job
 *            honestly without ever producing an asset (Goal 4/17)
 *          ↓
 *     FinalArtworkProvider.produce  (new provider-neutral boundary;
 *     Phase 2C's only implementation, LocalRasterInterpolationProvider, is
 *     a local, deterministic, pure-JS geometric resample — no network call,
 *     no paid provider, Goal 20)
 *          → always reports true native (pre-transform) source dimensions
 *            and honest `resolutionProvenance` ("native" vs
 *            "interpolated_upscale") and `preservesApprovedContent`
 *          ↓
 *     AssetCapability.uploadProductionAsset  (new — production-stage
 *     upload; `finalArtworkJobId` + explicit `productionRole` set; never a
 *     concept-stage asset)
 *          ↓
 *     PrintValidationCapability.validateArtwork  (same pure capability as
 *     Phase 1/2A — AUTHORITATIVE this time: input is the real production
 *     asset via `assembleAuthoritativeProductionPrintValidationInput`, new
 *     alongside the existing provisional assembler)
 *          ↓
 *     ProductionAssetValidation persisted  (new, append-only, per-asset —
 *     never a single status column on ArtworkVersion)
 *          ↓
 *     PrintProject.status = "print_ready" ONLY IF report.status === "ready"
 *     — otherwise "finalization_required" (new project status). No other
 *     code path may ever set "print_ready".
 *   - **Upscaling Truthfulness (the sprint's central design question):**
 *     `PrintValidationAssetSummary` gained `resolutionProvenance` /
 *     `nativeWidthPx` / `nativeHeightPx`. `effective_resolution` and
 *     `minimum_raster_dimensions` checks now judge sufficiency against the
 *     TRUE pre-upscale source dimensions whenever provenance is
 *     `"interpolated_upscale"` (or `"unknown"`) — never the enlarged file's
 *     literal pixel count. This is what stops "resize 1024px to 3600px"
 *     from ever reading as "production-quality artwork" merely because the
 *     file got bigger. A concept whose native resolution already meets a
 *     placement's target (e.g. a 1024x1024 concept against a 900x900
 *     sleeve target) can validate `"ready"` with zero fabricated detail —
 *     this is the one genuinely-achievable honest pass Phase 2C proves.
 *   - Required-wording verification (Goal 8) is never assumed to transfer
 *     from Concept Evaluation to a production asset. It transfers only when
 *     `FinalArtworkProviderOutput.preservesApprovedContent === true` — true
 *     for a pure geometric resample (same pixels, only resampled), and the
 *     explicit gate a future content-altering provider (reconstruction/
 *     regeneration) would have to declare `false`, which forces
 *     `required_wording_verification` to resolve `"unknown"` →
 *     `finalization_required` rather than silently inheriting a stale
 *     verdict.
 *   - `FinalArtworkWorkerCapability` must never: process an approval that
 *     is not currently `"active"` (a superseded one is `"cancelled"`, not
 *     processed); create a second production asset for the same job on
 *     retry (Goal 16 — idempotent via `finalArtworkJobId` +
 *     `productionRole` lookup); transition `PrintProject.status` for a job
 *     whose approval is no longer the project's current active one (a
 *     stale recovered job must never stomp a newer direction's status);
 *     call `PrintValidationCapability` with anything but the real
 *     production asset it just created/reused; duplicate
 *     `PrintValidationCapability`'s rules internally.
 *   - `FinalArtworkCapability.requestFinalArtwork` gained one behavior:
 *     retrying an already-`"failed"` job (an infrastructure problem, never
 *     a print-readiness verdict) revives it to `"queued"` rather than
 *     returning a permanent dead end — the customer's existing "Prepare
 *     Print-Ready Artwork" action is the retry path (Goal 21 — no
 *     PowerShell required). A `"completed"` job (even one that landed on
 *     `finalization_required`) is never revived — that is a real, honest
 *     verdict, not a hiccup.
 *   - `AssetStorageProvider` gained `download(objectKey): Promise<Buffer>` —
 *     distinct from `getSignedUrl` (a browser-facing URL); needed because a
 *     local raster transformation must decode real bytes in-process, unlike
 *     Concept Evaluation which only ever needed a URL. Only
 *     `AssetCapability.downloadAssetBytes` calls it.
 *   - New customer-safe finalization status `"needs_review"` (`conversation-service.ts`),
 *     derived purely from `PrintProject.status === "finalization_required"`
 *     — same sanitization choke point as `"preparing"`/`"print_ready"`, no
 *     new job/asset/validation detail added to the customer view.
 *   - New secure read boundary (Goal 14, not wired into any UI):
 *     `GET /api/projects/[projectId]/production-artwork/image` →
 *     `conversation-service.getProductionArtworkUrl` →
 *     `FinalArtworkCapability.getCurrentProductionAssetId` →
 *     `AssetCapability.getSignedUrl` — only ever returns a URL once
 *     `PrintProject.status === "print_ready"`.
 *
 * Sprint 2M Phase 2E — Topaz production reconstruction integration.
 * `FinalArtworkProvider` gains its first real, paid, network-backed
 * implementation (`TopazTransparencyUpscaleProvider`) alongside the
 * unchanged `LocalRasterInterpolationProvider`, resolved by
 * `resolveFinalArtworkProvider()` from `FINAL_ARTWORK_PROVIDER=local|topaz`
 * — its own independent provider boundary, never coupled to
 * `OPENAI_API_KEY`/`CONCEPT_GENERATION_*`/`CONVERSATION_UNDERSTANDING_PROVIDER`.
 * See ARCHITECTURE.md §13d for the full design. Boundary changes worth
 * repeating here:
 *   - `FinalArtworkWorkerCapability` gains a `ConceptEvaluationCapability`
 *     dependency, used ONLY to independently re-verify a PRODUCTION asset
 *     (never a source concept's own evaluation) when the resolved provider
 *     reports `preservesApprovedContent: false` — Topaz always does.
 *   - `ResolutionProvenance` gains `"reconstructed"`, trusted like
 *     `"native"` (genuine provider detail, not fabricated interpolation)
 *     but never collapsed into it.
 *   - `FinalArtworkJob` gains a durable `(providerKey, providerRequestId,
 *     providerStatus)` triple — paid-call idempotency across worker
 *     crashes/races/retries. Never customer-facing.
 *   - `checkSourceEligibleForFinalization` runs before ANY provider call
 *     (local or paid) and blocks spending on a source concept whose own
 *     Concept Evaluation already found required wording definitively
 *     missing/incorrect.
 *   - Topaz-specific request/response shape, model names, and process ids
 *     never leak past `TopazTransparencyUpscaleProvider` — domain code sees
 *     only the provider-neutral `FinalArtworkProvider` contract.
 *   - A paid provider's HTTP success is never treated as evidence of print
 *     readiness — only `PrintValidationCapability.validateArtwork`
 *     returning `"ready"` against the real production asset may.
 */

export const CAPABILITY_BOUNDARY_VERSION = "2M2e" as const;
