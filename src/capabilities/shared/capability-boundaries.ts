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
 *   A concept direction, a provider default, or any other downstream
 *     preference removing, replacing, or contradicting design content the
 *     customer asked for — see "Detailed-Description Fidelity" below
 *
 * Detailed-Description Fidelity (Phase 1) — customer content is
 * authoritative (ARCHITECTURE.md Principle 15 / §13f). Precedence, highest
 * first, and no lower layer may contradict a higher one:
 *
 *     1. customer required wording and exclusions
 *     2. customer design description (required content) and composition
 *     3. customer style and color preferences
 *     4. concept-direction treatment
 *     5. provider defaults (e.g. centered composition)
 *
 *   - `lib/domain/design-content-contract.ts` — the single pure reader of a
 *     design description (`requiresScene`, `hasExplicitComposition`,
 *     `compositionStatements`, `requiredElementCount`,
 *     `requestsRealWorldReference`). Derived, never persisted; it does NOT
 *     introduce structured required-element schema, and
 *     `DesignBrief.designDescription` remains the authoritative content
 *     contract.
 *   - `intent-extraction/preserve-design-detail.ts` — the deterministic
 *     backstop that restores design-critical detail a Conversation
 *     Understanding synthesis dropped. Applied on BOTH the semantic
 *     (`reconcile-understanding.ts`) and deterministic (`extraction.ts`)
 *     paths, so fidelity never depends on whether a Conversation
 *     Understanding provider is configured. It must never append the raw
 *     customer message, and never fold garment color, print placement,
 *     required wording, or palette preference into the design description.
 *   - `resolveDirectionTreatment` (`lib/domain/concept-directions.ts`) — the
 *     one place a direction is resolved against the content contract.
 *     Directions vary creative treatment only; the three concepts must stay
 *     genuinely distinct (Constitution §13), so fidelity is never achieved
 *     by making the three provider prompts converge.
 *
 * Phase 1.1 — multi-turn design intent and explicit no-text
 * (ARCHITECTURE.md Principle 16 / §13g):
 *
 *   - `intent-extraction/design-description-merge.ts` — the ONE authority on
 *     what a later customer turn does to `designDescription`: ADD (compatible
 *     clarifications accumulate), REFINE (only the contradicted detail is
 *     superseded), REPLACE (explicit supersede language wins). Pure, not
 *     persisted, no scene graph. Applied on BOTH the semantic
 *     (`reconcile-understanding.ts`) and deterministic (`extraction.ts`)
 *     paths — `designDescription` must never again be assigned over.
 *     Deliberately NOT the post-selection revision path
 *     (`shared/revision-delta.ts` / `shared/revision-intent.ts`), which
 *     assumes a selected ArtworkVersion and produces an image-edit delta.
 *     Similar vocabulary, separate machinery, no shared code.
 *   - `GenerationPromptRequest.wordingMode` (`RequiredWordingMode`) — the
 *     three text states are first-class and must never be re-derived by
 *     guessing from `requiredWording === null`, which is produced both by
 *     "unanswered" and by "explicitly no text". Only `"none"` — sourced
 *     solely from the customer's own `exactText === ""` — imposes the hard
 *     no-text constraint; a RegenerationPlan removal never may.
 *     `lib/domain/required-wording.ts` remains the single place the
 *     `exactText` storage representation is interpreted.
 *   - Explicit no-text sits in precedence tier 1, above required content,
 *     style preference, concept-direction treatment, and provider defaults.
 *     A direction's `noTextTreatment` is therefore applied LAST in
 *     `resolveDirectionTreatment`, and `typographyEmphasis: null` means a
 *     consumer must omit typography guidance entirely rather than emit a
 *     softened string that still authorizes lettering.
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
 *   - Phase 2A (Create New Artwork print-palette contract):
 *     `GenerationPromptRequest.printPaletteEnforcement` (`"hard"` |
 *     `"soft"` | `"none"`) and `subjectOnlyColors` — derived by Prompt
 *     Translation from existing brief fields (no migration). Distinguishes
 *     garment color, subject/object color semantics, and rendered print
 *     palette so a hard customer contrast resolution is never phrased as
 *     optional "Preferred colors" and never collapses into literal subject
 *     ink. Creative directions may change composition/density, never hard
 *     palette / no-text / exclusions.
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
 *            Sprint A2 (corrected): this decides PRODUCT SCOPE from brief
 *            text, and CONSUMES the already-resolved requested-production-
 *            output authority — it does not interpret prose to find one.
 *            A decoration method the customer merely names ("screen
 *            printed", "embroidered") is recorded on `printMethod` and
 *            changes no requirement; only `TShirtDesignBrief
 *            .requestedProductionOutput` naming an artifact V1 does not
 *            produce, or a non-apparel product, leaves the raster profile.
 *
 *            The authority chain runs the other way and ends here:
 *              customer message
 *                → ConversationUnderstanding (`production` section)
 *                  / shared/requested-production-output.ts (deterministic
 *                    backstop)
 *                → TShirtDesignBrief.requestedProductionOutput (persisted)
 *                → this function, read-only.
 *            Interpreting the sentence again at this gate is what the A2
 *            correction removed: prose here both refused valid jobs whose
 *            text merely contained an artifact word and never saw requests
 *            typed in chat. See ARCHITECTURE.md, "Decoration intent vs.
 *            production-output request".
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
 *     `preparing` / `retryable_failure` / `needs_review` / `print_ready`)
 *     from `PrintProject.status` plus, while still `finalizing`, the
 *     current FinalArtworkJob's status enum only — never a job id,
 *     `lastError`, provider name, or provider request id.
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
 *     derived from `PrintProject.status === "finalization_required"`
 *     — same sanitization choke point as `"preparing"`/`"print_ready"`, no
 *     new job/asset/validation detail added to the customer view.
 *     `"retryable_failure"` is not `"needs_review"`: it means the current
 *     FinalArtworkJob failed while the project is still `finalizing`, and
 *     the existing Prepare action may be invoked again. Polling stops;
 *     nothing auto-retries.
 *   - Read-only `GET /api/projects/[projectId]/finalization/status` →
 *     `conversation-service.getFinalizationStatus` returns that same
 *     customer-safe view. Browser polling never claims, recovers, or
 *     revives FinalArtworkJobs and never calls a provider.
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
 *
 * Sprint 2M Phase 2G — Revision lifecycle, exact wording semantics &
 * finalization safety. See ARCHITECTURE.md §12a for the full design.
 * Boundary changes worth repeating here:
 *   - Rule clarified, not reversed: "automatic regeneration is forbidden"
 *     means SYSTEM-initiated speculative regeneration — never a
 *     CUSTOMER-requested conversational revision, which is customer
 *     authority to enqueue regeneration automatically.
 *     `ConversationCapability.triggerAutomaticRevision` is the one new
 *     call site that enqueues generation from inside message handling
 *     (previously only `regenerateConcepts`/the "regenerate" chat pattern
 *     did) — gated by `shared/revision-intent.ts`'s
 *     `isExplicitRevisionIntent`, never by Design/Revision/Regeneration
 *     Intelligence's own judgment of what might help.
 *   - `PrintProject.revisionPending` (new column) is the durable authority
 *     for "a customer-requested change is not yet represented by the
 *     artwork" — `status === "revision_requested"` remains too weak a
 *     signal to gate finalization on (written on every revision-loop
 *     message, not just ones with real concept-relevant impact).
 *     Written by `ConversationCapability`, read authoritatively by
 *     `FinalArtworkCapability.requestFinalArtwork` (refuses to create an
 *     approval/job while `true`), cleared only by
 *     `GenerationWorkerCapability` on regeneration completion.
 *   - `ConversationCapability.triggerAutomaticRevision` now also calls
 *     `repo.supersedeActiveFinalDirectionApproval` at the moment a
 *     revision is understood (not only later, at regeneration completion,
 *     as before this sprint) — closes the race where a still-running
 *     `FinalArtworkJob` could complete after a newer revision and still
 *     win, because `FinalArtworkWorkerCapability.maybeTransitionProjectStatus`
 *     already refuses to write `print_ready`/`finalization_required`
 *     unless its own approval is still active (pre-existing safeguard).
 *   - `FinalArtworkCapability.requestFinalArtwork` gains one more refusal,
 *     checked first: an active `revisionPending` rejects the request
 *     safely (no approval, no job, customer-safe message) before any other
 *     validation runs.
 *   - `FinalArtworkCapability.requestFinalArtwork` no longer unconditionally
 *     writes `PrintProject.status = "finalizing"` — only when the resolved
 *     `FinalArtworkJob` is actually claimable
 *     (`"queued"`/`"running"`/`"recoverable"`). A repeat request against an
 *     already-`"completed"` job now returns the worker's own truthful
 *     terminal status instead of stranding the project in `"finalizing"`
 *     with no claimable job.
 *   - `shared/concept-relevance.ts`'s `CONCEPT_RELEVANT_SECTIONS` gains
 *     `exclusions` — a negative instruction ("this must not appear") is
 *     exactly as concept-relevant as a positive one, and previously never
 *     marked concepts stale or participated in the finalization staleness
 *     check.
 *   - `extraction.ts` (Intent Extraction) gains structural (not per-domain
 *     keyword) recognition of the reversed entity-naming shape (`<entity>
 *     is the/our/my <descriptor> name/title`) and of removal/correction
 *     cues ("don't print X", "X shouldn't appear", "remove X", "use the
 *     word Y", "I meant Y") updating `requiredWording`/`exclusions`
 *     directly — never silently falling through to
 *     `additionalInstructions`, which is not concept-relevant and
 *     therefore invisible to staleness/regeneration/finalization gating.
 *   - `ChatApp.tsx`'s `canRequestFinalArtwork` reflects `revisionPending`
 *     for UI purposes only — `FinalArtworkCapability` remains the sole
 *     authority; UI gating alone was never sufficient (this sprint's root
 *     cause).
 *
 * Live Acceptance Corrective Pass — final direction confirmation,
 * single-concept revision, lineage. See ARCHITECTURE.md §12b for the full
 * design. Boundary changes worth repeating here:
 *   - `PrintProject.finalDirectionConfirmed` (new) is independent of, and
 *     strictly stronger than, `revisionPending`. Concept SELECTION
 *     (`selectConcept`) is never, by itself, final APPROVAL — only
 *     `ConversationCapability.confirmSelectedDirection` (or the narrow
 *     `CONFIRM_FINAL_PATTERN` chat phrase set) may set it `true`;
 *     `selectConcept` always resets it to `false`, including when
 *     re-selecting a historical concept. `FinalArtworkCapability.requestFinalArtwork`
 *     checks it as an independent, final gate — never inferred from
 *     `revisionPending` being `false`.
 *   - `ConversationCapability.selectConcept` is reachable from the
 *     post-selection revision phases (`ask_revisions`/`revision_received`)
 *     as well as `concepts_ready` — the customer may explicitly restore any
 *     historical concept (original or a prior revision). `artworkVersions`
 *     is never filtered to "current batch only" for this check.
 *   - The default post-selection revision (`ConversationCapability.triggerAutomaticRevision`,
 *     the manual "regenerate" chat pattern, and `regenerateConcepts()`) now
 *     targets the ONE selected concept via the new
 *     `ConceptGenerationCapability.reviseSelectedConcept` — never the
 *     three-direction `regenerateAfterRevision`, which is now reserved for
 *     initial exploration and an EXPLICIT "show me alternatives" request
 *     (`ALTERNATIVES_REQUEST_PATTERN`, checked ahead of and independent
 *     from the default single-concept path).
 *   - `GenerationJob.targetArtworkVersionId` (new, nullable): when set,
 *     `conceptCount` is forced to 1 and the resulting single `ArtworkVersion`
 *     is tagged `sourceArtworkVersionId` = this value — the entire revision
 *     lineage model, no parallel history table. `ArtworkVersion.conceptDirectionKey`
 *     (new) records which catalog direction a concept used, so a later
 *     targeted revision regenerates in the SAME direction, resolved via
 *     `GenerationIntent.targetConceptDirectionKey` →
 *     `GenerationPromptRequest.targetConceptDirectionKey` (provider-neutral,
 *     `PromptTranslationCapability`-computed, same pattern as
 *     `allowAdditionalText`) → `resolveConceptDirection`. Both provider
 *     adapters (placeholder and OpenAI) honor this identically.
 *   - `extraction.ts`'s `extractProduct` and entity-naming pattern set are
 *     both generalized further (canonical product value regardless of
 *     sentence shape; reversed "name of X" order, relative-clause
 *     connectors, a generic non-noun-gated descriptor, and a bare
 *     typographic imperative cue for required wording) — still structural,
 *     never a per-phrase or per-domain patch.
 *   - `ConceptPreviewModal.tsx` (new) is a pure, read-only client-side
 *     viewer — no capability method or API route exists for "preview" at
 *     all; the only server mutation path remains the pre-existing
 *     `selectConcept`, called identically whether triggered from a card or
 *     from inside the modal.
 *
 * ## True Source-Image Targeted Revision
 *
 * Generation has TWO modes, and they are different operations:
 *
 *   INITIAL GENERATION (and explicit "show me alternatives")
 *     approved brief → text-to-image → 3 concept directions
 *
 *   TARGETED REVISION (the default post-selection revision)
 *     selected source artwork + explicit delta + preservation contract
 *       → image edit → 1 revised concept
 *
 * A targeted revision MUST NEVER silently degrade to text-to-image. That
 * degradation returns an unrelated reinterpretation of the brief that looks
 * like a successful revision, which is strictly worse than a visible
 * failure. Boundary rules that enforce it:
 *
 *   - `ConceptGenerationRequest.sourceArtwork: SourceArtworkImage | null`
 *     (new) carries the selected concept's REAL image bytes across the
 *     provider boundary. Provider-neutral by construction — raw bytes,
 *     content type, and a provenance id, never an `ArtworkVersion`, an
 *     `AssetRecord`, a storage key, or a signed URL. Exactly mirrors the
 *     OUTPUT side (`GeneratedAssetPayload`): resolving storage stays
 *     `AssetCapability`'s job, never a provider adapter's.
 *   - `GenerationWorkerCapability` owns that resolution
 *     (`targetArtworkVersionId` → `ArtworkVersion.primaryAssetId` →
 *     `AssetCapability.downloadAssetBytes`) and throws
 *     `TargetedRevisionSourceError` when any link fails. The job fails;
 *     `revisionPending` is deliberately NOT cleared (the requested revision
 *     genuinely has not happened) and the customer keeps the concept they
 *     already had.
 *   - `ConceptGenerationProvider.editsSourceArtwork` (new) declares whether
 *     an adapter performs a real edit. Any adapter that calls an image
 *     model MUST declare `true` and MUST independently refuse a targeted
 *     revision with no source artwork
 *     (`ProviderError("invalid_request")`) — the guarantee never rests on
 *     the worker alone. `false` is reserved for stubs that produce no image
 *     bytes at all (placeholder/unavailable), which are unreachable in a
 *     configured production environment.
 *
 * The requested DELTA is carried explicitly, because nothing else can carry
 * it: the Design Brief records design STATE and `RegenerationPlan` knows
 * only which brief SECTIONS were touched (its descriptions are canned
 * section-level sentences).
 *
 *   customer message
 *     → `GenerationJob.revisionInstruction` (new durable column, internal
 *       only — never in `ProjectSnapshot`, never customer-facing)
 *     → `GenerationIntent.revisionInstruction`
 *     → `PromptTranslationCapability`
 *     → `GenerationPromptRequest.revision: RevisionDirective`
 *     → image-edit adapter
 *
 *   - `RevisionDirective` is plain customer language, never prompt syntax:
 *     `requestedChanges[]` (discrete — "change the font to retro and remove
 *     the sunset" arrives as TWO), `preserve[]`, `avoid[]`, `lockedWording`,
 *     `wordingChangeRequested`. `RegenerationPlan` remains the source of
 *     truth for preserve/avoid/wording and is the fallback for
 *     `requestedChanges` when there is no literal instruction (the
 *     "Generate Updated Concepts" button path).
 *   - `shared/revision-delta.ts` owns the split into discrete changes and is
 *     shared with the revision acknowledgement, so the customer is told back
 *     the change they asked for rather than the brief fields extraction
 *     happened to touch. Generic sentence-shape heuristics only — no
 *     product/domain nouns, same rule as `shared/revision-intent.ts`.
 *   - `lockedWording` protects the exact required wording unless the
 *     customer's own delta is about the wording. A typography change is
 *     deliberately NOT a wording change.
 *   - An edit adapter owns 100% of the edit-prompt dialect internally, the
 *     same way it always has for the text-to-image dialect. The edit prompt
 *     is a genuinely different instruction ("edit this") and must not reuse
 *     the three-direction concept prompt.
 *
 * ## Chat-input policy and post-generation phase
 *
 * "When may the customer type?" is ONE rule, in
 * `shared/chat-input-policy.ts`, imported by both `ConversationCapability`
 * (which refuses the message) and the chat UI (which greys out the
 * composer). It was previously duplicated, and a drifted copy is
 * indistinguishable to a customer from a broken product: either an input
 * that throws on send, or a dead input the platform would have accepted.
 *
 * `concepts_ready` is one of those blocked phases, because it means "pick
 * one of these three". A TARGETED REVISION has nothing to pick between —
 * its single revised concept is auto-selected — so
 * `GenerationWorkerCapability` returns a finished targeted revision to
 * `ask_revisions` (success AND failure alike), where another change and
 * an explicit confirmation are both reachable. Only initial generation
 * and an explicit three-direction regeneration land in `concepts_ready`.
 * The completion MESSAGE keeps `metadata.phase: "concepts_ready"`
 * regardless: that marks the "here is artwork" anchor the concept grid
 * renders against, which is a property of the event, not of the phase the
 * conversation moves into next.
 *
 * ## Viewing artwork is never mutating it
 *
 * Any visible `ArtworkVersion` with a renderable asset opens in the same
 * read-only `ConceptPreviewModal` — original, revision, or historical.
 * The enlarge control is a SIBLING of the card's select button, never a
 * descendant: nesting it made "preview does not select" depend on event
 * propagation, and made previewing impossible entirely once the card was
 * `disabled` (browsers do not dispatch clicks inside a disabled control),
 * which is exactly the state every revised concept is in. Selection stays
 * an explicit action — the card, or the modal's own "Select this concept"
 * — and both call the same pre-existing `selectConcept`.
 *
 * ## Production normalization ownership (Print-Ready Normalization Phase 1)
 *
 * Dependency direction is unchanged; what changed is where production
 * geometry is decided, and it is decided in exactly one place per concern:
 *
 *   - `shared/print-placement-dimensions.ts` owns the SIZING POLICY (target
 *     physical print width, printable-height bound, target PPI, width
 *     tolerance) and the pure resolver that turns an artwork's aspect ratio
 *     into production pixels. Apparel dimensions are never re-derived in a
 *     worker or a provider — `ProductionRequirements.sizing` carries the
 *     policy through.
 *   - `final-artwork/production-normalization.ts` owns the TRANSFORM (alpha
 *     trim → safety margin → physical-width sizing → proportional resample →
 *     PNG encode). Every `FinalArtworkProvider` runs its reconstructed raster
 *     through this same module, so the printer's deliverable is one auditable
 *     transform rather than per-provider geometry. A provider owns
 *     reconstruction only.
 *   - `PrintValidationCapability` owns the VERDICT and still depends on
 *     nothing from `final-artwork` — it receives a provider-neutral
 *     `ProductionNormalizationSummary` (declared in its own contracts) and
 *     recomputes from it rather than trusting it.
 *     `FinalArtworkWorkerCapability`, which legitimately knows both sides, is
 *     the single place the provider's metadata is mapped onto that summary.
 *
 * ## Existing Artwork → Print Ready Phase 1 — the SECOND workflow
 *
 * iHeartPrints now has two first-class ways to reach print-ready artwork, and
 * they are genuinely different operations rather than two entry points to one
 * pipeline. See ARCHITECTURE.md §13h for the full design.
 *
 *     CREATE NEW ARTWORK      (unchanged)
 *       conversation → Design Brief → approval → generation → concepts
 *
 *     UPLOAD EXISTING ARTWORK (new)
 *       upload → deterministic analysis → repairability classification
 *              → background isolation → edge cleanup → prepared PNG
 *              → explicit customer approval
 *
 * New capability `ArtworkPreparationCapability`
 * (`src/capabilities/artwork-preparation/`):
 *   - Depends on `ProjectRepository`, `AssetCapability`, and
 *     `DesignBriefCapability` only. It has NO provider port at all — not an
 *     unconfigured one, not a stubbed one. Every operation is local,
 *     deterministic pixel math (`upload-limits.ts`, `image-decode.ts`,
 *     `image-analysis.ts`, `repairability.ts`, `pixel-metrics.ts`,
 *     `background-isolation.ts`, `background-cavities.ts`),
 *     which is what makes "zero OpenAI/Topaz/network calls" a structural
 *     property rather than a policy (proved by `no-paid-provider.test.ts`).
 *   - Never enqueues a `GenerationJob`, never calls a
 *     `ConceptGenerationProvider`, and never produces an `ArtworkVersion` of
 *     kind `"concept"`. Uploaded artwork is never labelled AI-generated.
 *   - Never mutates the uploaded original. `AssetRecord`s of kind
 *     `"customer_upload"` are written once; every transformation produces a
 *     new asset (`AssetCapability.uploadCustomerArtwork`, new — deliberately
 *     not a reuse of `uploadConceptImage`, whose `providerKey`/
 *     `generationJobId` provenance fields are all wrong here).
 *   - Never changes wording, redraws objects, shifts colour globally, alters
 *     composition, invents elements, regenerates, or reframes. Geometry
 *     preservation is asserted, not assumed.
 *
 * WORKFLOW IDENTITY is derived, not stored: a project with an
 * `ArtworkPreparation` row IS a `prepare_existing` project. There is
 * deliberately no `PrintProject.workflowKind` column — the audit for it is in
 * the migration header and in `ArtworkPreparation`'s doc comment. The
 * customer's pre-upload choice is transient client state
 * (`components/chat/uploaded-artwork-flow.ts`), because nothing durable
 * exists to remember until they actually upload something.
 *
 * `DesignBriefCapability` gains `setUploadedArtworkContext` — a sibling of
 * `setIntendedPrintWidth`, and for the same reason: it records a production
 * fact the customer stated directly, so routing it through `applyProposal`
 * (`source: "intent_extraction"`) would make the provenance a lie. It writes
 * ONLY `productSummary` / `shirtColor` / `printPlacement`; for uploaded
 * artwork the pixels ARE the design, so nothing ever writes
 * `designDescription`, `exactText`, or `designStyle` from this path — a
 * written description of uploaded pixels would be a second, competing source
 * of truth.
 *
 * NO REQUIRED-WORDING CONTRACT. Uploaded artwork never goes through Concept
 * Evaluation's required-wording checks, and Phase 1 performs no OCR: the
 * uploaded pixels are authoritative for visual content, and the customer is
 * never asked to retype text they already have. The architectural hook Phase 2
 * needs is `ArtworkVersion.kind === "prepared_upload"` — the unambiguous,
 * non-inferred signal a future uploaded-preserve print-validation
 * applicability profile branches on. Phase 2 owns that profile; Phase 1 only
 * guarantees the signal exists and is honest.
 *
 * Forbidden (additions):
 *   ArtworkPreparation calling any image model, segmentation service, or
 *     other network provider
 *   ArtworkPreparation creating a GenerationJob, a FinalDirectionApproval, or
 *     a FinalArtworkJob
 *   Overwriting, re-encoding in place, or deleting a `customer_upload` asset
 *   Removing background-coloured pixels that no border-connected path reaches
 *   Recording original → prepared lineage on `AssetRecord.vectorAssetId` /
 *     `printAssetId` (both mean something narrower) or on
 *     `ArtworkVersion.sourceArtworkVersionId` (which means "a targeted
 *     revision of that artwork version", and the source here is an ASSET)
 *   Describing prepared artwork as print-ready, enhanced, upscaled, or
 *     validated — Phase 1 does none of those (Constitution §15)
 *   Surfacing flood fill, tolerance, sigma, masks, alpha, or pixel counts to
 *     a customer — `preparation-copy.ts` is the one place analysis becomes
 *     language, and it speaks only in inches
 *
 * ## Existing Artwork → Print Ready Phase 2 — production finalization
 *
 * The two workflows converge. See ARCHITECTURE.md §13i for the full design;
 * the boundary rules are:
 *
 *     PREPARED ARTWORK  != PRINT-READY ARTWORK
 *     PREPARED APPROVAL != print_ready
 *
 * PARALLEL AUTHORITIES, one pipeline. `FinalArtworkJob` carries EITHER a
 * `finalDirectionApprovalId` (Create New Artwork) OR an
 * `artworkPreparationId` (Upload Existing Artwork) — never both, never
 * neither, enforced by a database CHECK. `FinalArtworkJob.sourceKind` is
 * DERIVED from which is set, never a stored column, so no third fact can
 * disagree with the two keys.
 *
 *   create_new       selected concept → final-direction approval → finalize
 *   prepare_existing uploaded original → prepared artwork
 *                                      → prepared approval → finalize
 *
 * `FinalArtworkCapability.requestPreparedUploadFinalArtwork` deliberately
 * requires NONE of `selectedArtworkVersionId`, `finalDirectionConfirmed`, an
 * approved `DesignBriefVersion`, or a `FinalDirectionApproval`. Every one of
 * those means "I am done revising the design you generated for me" — a
 * question never asked of someone who arrived with finished artwork.
 * Fabricating them would be a synthetic paper trail asserting a decision the
 * customer never made, and a SECOND production-approval authority for a
 * decision `ArtworkPreparation` already records.
 *
 * `FinalArtworkWorkerCapability` gains a second source-resolution path and
 * ONE new dependency shape: a `localNormalizationProvider` alongside the
 * configured provider. Which of the two runs is the entire substance of the
 * cost decision (`final-artwork/enhancement-decision.ts`), so it is injected
 * rather than assumed. Everything after source resolution — the production
 * transform, the production asset, authoritative Print Validation, the
 * `print_ready` decision — is one shared path, never duplicated per workflow.
 *
 * `PrintValidationCapability` gains an APPLICABILITY PROFILE
 * (`"generated_concept"` | `"uploaded_preserve"`), not a strictness dial. It
 * remains pure: no repository, no provider, no I/O. Under
 * `uploaded_preserve` it does not emit `brief_provenance`,
 * `concept_evaluation_alignment`, or `required_wording_verification` —
 * inapplicable, not relaxed — and DOES emit `source_lineage`,
 * `preserved_source_geometry`, and `reconstruction_sufficiency`. Every report
 * records which profile ran, so "not asked" is never indistinguishable from
 * "passed".
 *
 * Forbidden (additions):
 *   Creating a `FinalDirectionApproval` (or any synthetic approval/brief
 *     version) to make uploaded artwork fit the create_new gate
 *   A `FinalArtworkJob` carrying both authorities, or neither
 *   Finalizing uploaded artwork from the immutable ORIGINAL upload rather
 *     than the approved prepared PNG
 *   Re-running background removal, concept generation, prompt translation,
 *     Concept Evaluation, production verification, or ANY image-model call
 *     during upload finalization
 *   Spending a paid reconstruction call on artwork that already carries the
 *     target's worth of real pixels
 *   Retrying reconstruction at a larger scale when the first one lands short
 *     — the plate is produced honestly and validation fails it
 *   Serving a production asset produced at a print width the customer has
 *     since changed
 *   Mutating, re-encoding, or deleting the original upload, the prepared
 *     asset, or an already-produced production asset
 *   Asking an uploaded-artwork customer to type, confirm, or verify wording
 *     that is already in their own pixels (and no OCR)
 *   Treating a `uploaded_preserve` report's absent checks as passes
 *
 * ## Sprint A3 — IP / trademark safety (`IpSafetyCapability`)
 *
 * A PRODUCT SAFETY BOUNDARY, never a legal-clearance system. iHeartPrints
 * will not knowingly help a customer create artwork that reproduces or
 * deliberately imitates recognizable third-party protected branding, and
 * will not help them evade those protections. It never determines, asserts,
 * or implies that anything is legal, licensed, cleared, or owned. See
 * ARCHITECTURE.md §17 and Constitution §17.
 *
 * DETECTION AND ENFORCEMENT ARE SEPARATE, deliberately:
 *
 *   detection  (`ip-safety/ip-safety-detection.ts`, pure)
 *     "What does the customer appear to be asking us to create?"
 *   enforcement (`IpSafetyCapability`, pure + the fences that consume it)
 *     "May iHeartPrints send this request to the generation provider?"
 *
 * Flow — the boundary is strictly ADDITIVE in front of provider safety, and
 * provider safety is unchanged:
 *
 *     customer intent
 *       → iHeartPrints IP safety (deterministic, ours)
 *       → allowed generation request
 *       → the provider's own safety systems (independent, untouched)
 *       → result
 *
 * THREE FENCES, one shared pure capability instance:
 *
 *   1. Conversational gate — `ConversationCapability`, after the turn is
 *      semantically interpreted and BEFORE Intent Extraction's proposals are
 *      applied. A blocked request never becomes Design Brief content.
 *   2. Enqueue fence — `ConceptGenerationCapability`, before any
 *      `GenerationJob` row exists. No job means no worker claim means no
 *      paid call, structurally rather than by policy. Covers initial,
 *      three-direction alternatives, additional exploration batch, and
 *      targeted revision, because all four funnel through its two enqueue
 *      functions.
 *   3. Pre-provider fence — `GenerationWorkerCapability.runClaimedJob`,
 *      before `planPaidImageUnits` and any dispatch. Unreachable in ordinary
 *      operation; it exists because "no paid call happens" has to be a
 *      property of the code that makes the call.
 *
 * AUTHORITY IS DERIVED, NOT PERSISTED. There is no `ip_safety` column and no
 * migration. Both generation fences evaluate the STRUCTURED generation
 * intent — the approved `DesignBriefVersion`'s generation-bearing design
 * content plus the job's own `revisionInstruction` — never the conversation
 * transcript. Re-scanning old turns at provider-call time would resurrect
 * requests the customer already retracted; a stored verdict would have to be
 * explicitly un-set. Recomputation is what makes both required transitions
 * free:
 *
 *     unsafe → customer revises → safe → generation allowed
 *     safe   → customer adds a protected-mark request → blocked
 *
 * ONE CANONICAL SUBJECT (Correction 2). `ip-safety/safety-subject.ts` is the
 * single construction both generation fences use, so a request SPLIT across
 * structured fields is seen the way `translateApprovedBrief` will see it —
 * as one thing:
 *
 *     designDescription      = "Raiders"
 *     additionalInstructions = "use the exact shield"
 *
 * Parts are joined with ", " deliberately: a comma is not a clause boundary
 * (so cross-field association works) but IS an operator-scope terminator (so
 * a negation in one field cannot leak into another). The customer's current
 * instruction is composed FIRST, because operators scope forward and a
 * corrective instruction ("remove the logo") must be able to govern the
 * design context behind it. The module documents which brief fields are in
 * the subject and — just as importantly — which are excluded (`exactText`,
 * `preferredColors`, `productSummary`, `audience`, `purpose`) and why.
 *
 * SCOPING IS PER-OCCURRENCE, NEVER PER-CLAUSE (Correction 1). A neutralizing
 * operator (negation, removal, avoidance) runs from where it appears to the
 * next scope terminator and neutralizes only the referent occurrences inside
 * it. A finding requires a SURVIVING referent and a SURVIVING binding. The
 * original clause-wide rule let an unrelated trailing instruction unblock an
 * explicit request ("Make me the Raiders logo, no text."), which is the
 * worst possible direction to be wrong in. Contextual "safe words"
 * (`themed`, `vibe`, `feel`, `inspired by`, `I like`, `said`, watch-party
 * vocabulary) no longer disqualify anything at all — they never carried the
 * allow-cases, which hold for the far better reason that they contain no
 * protected referent.
 *
 * BOUNDED MULTI-TURN AUTHORITY (Correction 3). The conversational gate
 * composes the current message with a bounded window of the customer's own
 * recent turns, because a request can be split across turns ("I want a
 * Raiders design." → "Use their exact shield."). The window is small, is
 * derived from the conversation record rather than persisted, and EXCLUDES
 * turns that were themselves refused — otherwise a blocked message would
 * keep re-blocking the rephrasings that follow it. The gate deliberately
 * does NOT fold in the Design Brief: a theme legitimately recorded there
 * would combine with every later mention of "logo" for the life of the
 * project. The brief is where the two GENERATION fences work instead, which
 * is the moment it actually matters.
 *
 * ECONOMICS (Goal 16): A3 introduces NO new paid model call. The semantic
 * layer rides on the ONE Conversation Understanding interpretation each
 * pre-approval/revision turn already makes, as a new optional
 * `ConversationUnderstandingResult.ipSignal`. That signal is a HINT only —
 * it is absent whenever the provider is unconfigured (the default), the call
 * is skipped, or it fails — so the deterministic detector is the floor and
 * the sole input to both generation fences.
 *
 * SEMANTIC PRECEDENCE (Correction P2). The hint may EXTEND deterministic
 * recall — it is the only way a mark nobody enumerated is caught — but it
 * may never contradict safety the customer wrote plainly:
 *
 *   - a deterministic block always blocks; no signal can lift it;
 *   - a malformed/unknown signal is sanitized to null and changes nothing;
 *   - `"ambiguous"` never blocks;
 *   - neither `"explicit"` nor `"inferred"` may block when deterministic
 *     safe evidence explains THE SAME REQUEST the signal is about. "Don't
 *     use the Raiders logo" must not be refused because a model guessed at
 *     the sentence.
 *
 * SUPPRESSION IS SCOPED TO THE SAME REQUEST (Correction 3). Two weaker
 * rules were tried and both leaked, in the expensive direction:
 *
 *     "there is safe structure somewhere in the subject"   (Correction 1)
 *     "…and no surviving deterministic request structure"  (Correction 2)
 *
 *     "Recreate our logo, then reproduce theirs."
 *      |-- owned, explained --|  |- someone else's, NOT explained -|
 *
 *     "Don't use the old logo, draw that famous cartoon mouse exactly."
 *      |----- neutralized -----|  |- invisible to the lexicon entirely -|
 *
 * The second example is decisive: nothing deterministic exists for "that
 * famous cartoon mouse", so no occurrence count, lexicon entry, or counter
 * can represent it. The semantic signal's own `evidence` quote — already
 * required by the `IpSafetySignal` contract — is the only handle on WHERE
 * its request lives, so the rule is positional:
 * `isCoveredBySafeEvidence(subject, quote)` asks whether the customer's
 * quoted words sit inside a neutralizing operator's scope or inside an
 * ownership-explained SEGMENT (the stretch between scope terminators — one
 * instruction). Unlocatable evidence cannot establish safety and therefore
 * does not suppress: the conservative direction on a spend boundary.
 *
 * Correction 4 hardened that lookup in two ways, both of which were
 * exploitable and both of which are spend defects:
 *   - EVERY occurrence of the quote is checked, not just the first. A safely
 *     covered copy must not immunize an identical uncovered one later
 *     ("Don't use the X logo, then recreate the X logo") — in either order.
 *   - Coverage requires FULL containment (`start >= scope.start && end <=
 *     scope.end`), not merely starting inside. Start-only matching let a
 *     quote begin inside a negation and run straight out the other side of
 *     it, carrying the unsafe half under cover of the safe half. Applied
 *     identically to neutralizing scopes and ownership-explained segments.
 *
 * This subsumes any per-kind rule. A character request is blocked in the
 * decoy sentence because it sits outside the negation's scope, not because
 * it is a character; "Don't use that famous cartoon mouse" is allowed for
 * the same positional reason, with no character lexicon involved in either.
 * The DETERMINISTIC verdict is untouched by all of this — the locator only
 * ever decides what the SEMANTIC layer may do.
 *
 * BUSINESS-NAME COLLISIONS. A recognized token immediately followed by a
 * trade or legal-entity noun ("Raiders Plumbing LLC", "Supreme Roofing") is
 * a customer business NAME, and that OCCURRENCE is not a protected referent.
 * Occurrence-level, never clause-level, and narrow: "logo", "shield", and
 * "crest" are not on the continuation list, so "the Raiders logo" is
 * untouched. This is a reading of sentence structure, not an ownership or
 * rights determination.
 *
 * NEVER CONFLATED WITH OWNERSHIP. `OwnershipCapability` remains reserved
 * future provenance/licensing architecture and is UNCHANGED by A3. Ownership
 * classification is not trademark or copyright verification; IP Safety is a
 * generation/use-policy gate. Preparing uploaded artwork is a technical
 * operation on bytes the customer supplied — never a determination that they
 * own it.
 *
 * Allowed:
 *   IpSafety → nothing. It is a leaf: pure, synchronous, zero dependencies,
 *              `createIpSafetyCapability()` takes no arguments. Callers
 *              resolve brief content and pass plain data, exactly like
 *              `PrintValidationCapability`.
 *   ConversationUnderstanding → `ip-safety/contracts` TYPE-ONLY, for the
 *              `ipSignal` shape. It never interprets, enforces, or persists
 *              it.
 *   Conversation / ConceptGeneration / GenerationWorker → IpSafety
 *
 * Forbidden:
 *   An internal `IpSafetyReason`, finding, evidence span, or confidence
 *     reaching a customer-facing message, message metadata, or
 *     `ProjectSnapshot` — `ip-safety/customer-response.ts` is the one place
 *     a decision becomes language, and it deliberately emits the SAME
 *     redirect for every reason so the classification cannot be read off
 *     the prose either
 *   Any customer-facing text stating or implying that artwork is legal,
 *     licensed, trademark-cleared, copyright-cleared, or owned — or that
 *     the customer has infringed anything
 *   Stating a threshold, percentage, or amount of change that would make a
 *     request acceptable
 *   Persisting an IP safety decision, or gating generation on a stored one
 *   Re-scanning the conversation transcript at provider-call time instead of
 *     evaluating the structured generation intent
 *   Making the boundary depend on a semantic/provider layer that may be
 *     unconfigured, skipped, or failed
 *   Weakening, bypassing, or substituting for a provider's own safety
 *     systems, or fabricating artwork when a provider refuses
 *   Turning `OwnershipCapability` into a rights-verification system, or
 *     deriving ownership from an IP safety decision (in either direction)
 *   Adding an IP safety gate to pure technical preparation of uploaded
 *     artwork, which generates nothing and spends nothing
 *   A `"review"` outcome, or any other decision value the product has no
 *     real workflow behind
 *   Clearing an entire clause because a disqualifying word appears somewhere
 *     in it — scoping is per-occurrence (Correction 1)
 *   Either generation fence building its own subject instead of calling
 *     `safety-subject.ts` (Correction 2)
 *   A semantic hint refusing a request whose safety the deterministic layer
 *     established structurally (Correction P2)
 *   Suppressing a semantic signal on safe evidence that does not cover that
 *     signal's own request — including an ownership claim in a different
 *     instruction of the same clause (Correction 3)
 *   Locating a semantic signal's evidence by first match only, or treating a
 *     quote that merely STARTS inside a safe scope as explained by it
 *     (Correction 4)
 */

/**
 * Sprint A4 — AcquisitionCapability (`capabilities/acquisition/`).
 *
 * The acquisition entitlement boundary: one free concept, an email required
 * to continue, and paid access still to come (Sprint A5). It is SPEND
 * CONTROL over an anonymous session — not authentication, not an account
 * system, not a customer identity model, not marketing consent, and not a
 * fraud platform. See ARCHITECTURE.md §23b.
 *
 * DEPENDS ON
 *   ProjectRepository — and nothing else.
 *
 * DEPENDED ON BY
 *   ConceptGenerationCapability   the generation fence (enqueue)
 *   FinalArtworkCapability        the finalization fence (Topaz spend)
 *   ConversationCapability        the email-to-continue gate
 *   conversation-service          the customer-safe state view
 *
 * THE AUTHORITY RULE, which every one of those callers obeys:
 *
 *   Authority is resolved from the PROJECT
 *   (`PrintProject.acquisitionSessionId`), never from anything the caller
 *   supplied. That is the single choice that makes a direct API call no
 *   more powerful than the UI: a cleared, forged, or absent cookie changes
 *   nothing about what a project's session is allowed to do.
 *
 * FENCE PLACEMENT, which is not negotiable:
 *
 *   Each fence sits where the DURABLE RECORD THAT AUTHORIZES SPEND is
 *   created — a `GenerationJob` for images, a `FinalArtworkJob` for
 *   production reconstruction. Refusing there removes the spend
 *   structurally (no job, no worker claim, no paid call) rather than
 *   relying on a downstream component to remember a policy.
 *
 * ALLOWED
 *   Issuing and resolving anonymous sessions
 *   Allocating, consuming, and refusing the one free concept
 *   Capturing and normalizing an email address
 *   Granting the internal entitlement (after the ROUTE has verified a
 *     server-side secret — this capability performs no authorization of
 *     its own)
 *   Describing all of the above in customer-safe language
 *
 * FORBIDDEN
 *   Calling any provider, or knowing that providers exist
 *   Interpreting conversation, mutating a Design Brief, or deciding intent
 *   Making an ownership, licensing, or rights determination — that is
 *     `OwnershipCapability`'s separate, dormant architecture, and deriving
 *     one from an entitlement would fabricate rights verification
 *   Treating a captured email as consent, identity, verification, or an
 *     account
 *   Treating an IP address as identity, or fingerprinting a device
 *   Returning the email address, the session token, or the persisted
 *     entitlement value on any customer-facing surface
 *   Inventing a payment/paid entitlement tier before Sprint A5 implements
 *     one — a value nothing can legitimately write is a capability that
 *     only looks implemented
 *   Any bypass that is not the explicit server-side internal grant: a
 *     hardcoded operator email, a browser-local flag, a secret query
 *     string, or `NODE_ENV`
 *   Re-authorizing an EXISTING generation job. Resuming one (reload, second
 *     tab, duplicate request, retry, worker reclaim) must never require a
 *     second entitlement — its spend is already bounded by its own
 *     `paid_image_intents` budget and `MAX_GENERATION_ATTEMPTS`
 *   Consuming the entitlement before a durable job exists, or leaving it
 *     allocated after one does (see ALLOCATION vs CONSUMPTION in §23b)
 *
 * SPRINT A4 CORRECTION 1 — the rules an audit had to add.
 *
 * All four defects it found were the same mistake: the entitlement was
 * APPLICATION state the database had no opinion about, so every guarantee
 * depended on a write actually happening rather than on a constraint that
 * cannot be circumvented. The rules below exist so that mistake cannot be
 * made again in a different place.
 *
 *   THE AUTHORITY IS A CONSTRAINT, NOT A WRITE.
 *     `generation_jobs.acquisition_session_id` carries a partial unique
 *     index: at most one free-concept job per session, enforced by
 *     PostgreSQL. `authorizeConceptGeneration` is a PRE-CHECK that avoids
 *     doing work destined to fail — never the guarantee. Any future gate
 *     whose correctness rests on "we wrote a marker afterwards" is wrong for
 *     the same reason this one was.
 *
 *   FORBIDDEN: treating `recordFreeConceptConsumed` as authoritative. It is
 *     a denormalized marker. Consumption is answered from EITHER the marker
 *     OR the free-concept job, and a failure to read the job reconciliation
 *     resolves to CONSUMED — the safe direction for an entitlement question
 *     is always the one that does not spend money.
 *
 *   FORBIDDEN: `paidIntentBudgetForJob` in production code. It derives the
 *     budget from `conceptCount` alone and adds the Phase 2C replacement
 *     allowance on top, so it answers 3 for a one-concept free job. Call
 *     `paidIntentBudgetForGenerationJob`, which reads the durable job
 *     marker. ONE FREE CONCEPT MEANS ONE PAID IMAGE DISPATCH — the customer
 *     -visible count and the money are two claims, and `conceptCount: 1`
 *     only ever made the first one true.
 *
 *   FORBIDDEN: offering Phase 2C replacement for an acquisition free job,
 *     and equally forbidden: letting the budget refuse it instead. The
 *     refusal path WITHHOLDS the candidate, which on a batch of one delivers
 *     nothing to a customer whose entitlement is already spent. The worker
 *     returns early instead, and the concept ships as generated.
 *
 *   FORBIDDEN: reading a missing bound session as legacy. `NULL` means
 *     legacy and is grandfathered; a non-null id whose session cannot be
 *     loaded FAILS CLOSED. Losing a row must never be the thing that grants
 *     spend — which is also why every acquisition foreign key is RESTRICT
 *     rather than SET NULL, and why the historical job reference is not a
 *     foreign key at all.
 *
 *   FORBIDDEN: degrading a failed authority resolution to a permissive
 *     customer state. `unavailable` exists so the UI cannot offer an action
 *     the server is about to refuse.
 *
 *   Ordinary paid jobs are untouched by all of the above. A correction that
 *     changed normal generation economics to make the free path safe would
 *     be a different, worse bug.
 */

/**
 * SPRINT A4 CORRECTION 2 — two rules Correction 1 was still missing.
 *
 *   ONE FREE CONCEPT MEANS ONE PHYSICAL SUBMISSION, not one logical intent.
 *     A single `paid_image_intent` may be dispatched
 *     `MAX_PAID_DISPATCHES_PER_INTENT` times, because an ambiguous
 *     post-dispatch failure cannot be proven un-billed — correct for paid
 *     work, wrong for a giveaway. FORBIDDEN: passing
 *     `MAX_PAID_DISPATCHES_PER_INTENT` to `beginPaidImageIntentDispatch`.
 *     Call `maxPhysicalDispatchesForGenerationJob`, and resolve it ONCE per
 *     execution — four call sites each reaching for the constant is four
 *     chances for the free path to regain two submissions.
 *
 *     Keyed on `acquisitionSessionId`, never on `conceptCount`. A targeted
 *     revision is also a one-concept job and MUST keep the ordinary retry
 *     policy: it is paid work on a design the customer already chose.
 *
 *   THE LIFETIME AUTHORITY IS A SESSION-OWNED TOMBSTONE, not a constraint on
 *     a deletable row. `acquisition_free_concept_claims` has the session as
 *     its PRIMARY KEY and holds no foreign key to the job, so it keeps
 *     refusing after that job is deleted — which the partial unique index on
 *     `generation_jobs` cannot. FORBIDDEN: reintroducing an authority that
 *     evaporates when a child row is removed, and equally forbidden:
 *     `ON DELETE RESTRICT` on the job to prop one up, which would impose
 *     permanent retention on an operational table.
 *
 *     The claim is taken by a BEFORE INSERT trigger so claim and job are ONE
 *     statement. FORBIDDEN: splitting them into two application writes —
 *     claim-first burns the customer's entitlement for our failure,
 *     job-first leaves an executable job with no claim.
 *
 *     The trigger is SECURITY INVOKER with a pinned search_path. FORBIDDEN:
 *     promoting it to SECURITY DEFINER. Only `service_role` writes
 *     `generation_jobs`; if the trigger cannot write the claim, the caller
 *     had no business inserting the job.
 *
 *   `freeConceptSpent` reads the CLAIM FIRST — the thing the insert is
 *     actually validated against — so application state and database
 *     enforcement cannot disagree. Every read failure resolves to CONSUMED.
 *
 *   FORBIDDEN: a customer state that invites an action the server will
 *     refuse. A spent-but-undelivered attempt is `continue_locked`, not
 *     `open`, and `unavailable` disables the controls rather than merely
 *     printing a sentence above them.
 */

/**
 * SPRINT A4 CORRECTION 3 — the paid boundary is where the request leaves the
 * process, not where the code path begins.
 *
 *   THE DURABLE DISPATCH COUNTER MEANS "an external request may actually
 *     have been sent". FORBIDDEN: claiming it before local provider
 *     preflight has passed. A definite pre-provider failure (missing
 *     credential, disabled provider, invalid local config) must leave the
 *     count at 0 and the attempt retryable — for the acquisition free
 *     concept, claiming first spent the customer's only attempt on our own
 *     misconfiguration, with zero external submissions.
 *
 *   `assertReadyToDispatch` IS LOCAL ONLY. FORBIDDEN: making any network
 *     call in it — no probe, no test generation, no health check. It states
 *     that THIS PROCESS is configured to attempt a request, and nothing
 *     about remote availability, success, or billing.
 *
 *   FORBIDDEN: duplicating provider configuration logic in the worker.
 *     Enablement, storage, and arming decisions belong to
 *     `resolveConceptGenerationProvider`, which already returns the
 *     unavailable stub when they fail.
 *
 *   ORDERING IS THE CONTRACT: preflight runs AFTER reuse/adoption (so a
 *     broken config never blocks recovering an image already bought) and
 *     IMMEDIATELY BEFORE the claim (so no window exists in which the claim
 *     is taken for a call that never happens). Nothing may be inserted
 *     between preflight and the claim.
 *
 *   Preflight is ADVISORY, never the concurrency authority.
 *     `beginPaidImageIntentDispatch` remains the only thing that decides who
 *     may call the provider; two workers may both preflight and only one may
 *     win.
 *
 *   AFTER the claim, every failure is possibly-billed. FORBIDDEN: inferring
 *     that a particular HTTP status was not charged in order to justify a
 *     second free submission.
 *
 *   Customer state follows the same boundary: an attempt stopped before any
 *     dispatch reads `open` (their concept is intact and the next click
 *     works), not `continue_locked`.
 */

/**
 * SPRINT A5.1 + A5.2 — the PRODUCTION UNLOCK (commercial entitlement).
 *
 * `ProductionUnlock` (`production_unlocks`) is the durable answer to one
 * question: *may this design project be prepared for production under this
 * production profile?* See ARCHITECTURE.md §23c.
 *
 * NO NEW CAPABILITY. `AcquisitionCapability` gained no method, no
 * constructor argument, and no dependency — it still depends only on
 * `ProjectRepository`, and it READS an already-granted unlock through it.
 * A5.3+'s payment provider belongs behind its own provider port in its own
 * capability; FORBIDDEN: putting a provider adapter inside the acquisition
 * boundary, or making the acquisition boundary depend on a payment
 * capability. The entitlement read is a repository read, by design.
 *
 * THE KEY IS THE PROJECT, and this is not a preference.
 *
 *   FORBIDDEN: binding commercial entitlement to `FinalDirectionApproval`,
 *     `ArtworkVersion`, `FinalArtworkJob`, `AssetRecord`, a PNG, a filename,
 *     a provider, or `requestedProductionOutput`.
 *
 *     The approval case is the instructive one, because it is the intuitive
 *     answer. An approval is DESIGNED to be cheap to supersede, and this file
 *     already documents four sites that supersede it — including
 *     `ConversationCapability.triggerAutomaticRevision`, which fires the
 *     moment a revision request is understood. An approval-bound entitlement
 *     would be revoked by the customer's FIRST SENTENCE after paying. The
 *     others fail similarly: artwork is replaced by every targeted revision,
 *     a `FinalArtworkJob` is created AFTER the gate that authorizes it
 *     (circular), an asset is the OUTPUT of the paid work rather than the
 *     permission for it, and `requestedProductionOutput` is deliberately
 *     mutable so a customer may change their mind.
 *
 *     `PrintProject.id` is the only identifier in this domain that survives
 *     revision, approval supersession, regeneration, and a change of
 *     requested output — and it is already what `resolveAuthority` reads, so
 *     the commercial gate and the spend gate agree by construction.
 *
 *   FORBIDDEN: keying on the acquisition SESSION. One purchase must not make
 *     every project that browser ever creates paid.
 *
 *   FORBIDDEN: adding `approvalId` / `artworkVersionId` /
 *     `requestedProductionOutput` parameters to
 *     `authorizeFinalization(projectId)`. The signature is the guarantee: a
 *     parameter is how a superseded identifier gets back into the money path.
 *
 *   Provenance columns are deliberately absent. If one is ever added it must
 *     be IGNORED by the gate — a nullable approval id beside an entitlement
 *     is a standing invitation for a future reader to bind to it.
 *
 * ONE RECORD, BOTH WORKFLOWS. `requestFinalArtwork` (Create New) and
 * `requestPreparedUploadFinalArtwork` (Upload Existing Artwork) already
 * consumed the same `authorizeFinalization(projectId)` call, so both are
 * unlocked by one project-level record and neither changed. FORBIDDEN: a
 * workflow-specific unlock, an "upload entitlement", or a second gate.
 *
 * A5.1/A5.2 UNLOCK FINALIZATION ONLY.
 *
 *   FORBIDDEN: wiring `ProductionUnlock` into `authorizeConceptGeneration`.
 *     Every spend budget in this codebase is scoped to a single
 *     `GenerationJob` (`paid_image_intents`,
 *     `paidIntentBudgetForGenerationJob`,
 *     `maxPhysicalDispatchesForGenerationJob`, `MAX_GENERATION_ATTEMPTS`),
 *     and NOTHING counts jobs per project or per session. Every new Explore
 *     batch and every brief re-approval mints a job with a fresh full budget.
 *     The blanket refusal of prospects is currently the only thing bounding
 *     that, so unlocking generation before a per-project ceiling exists
 *     converts a bounded giveaway into an unbounded paid-image surface. The
 *     ceiling's home is the unlock row itself, decremented conditionally
 *     (`... where remaining > 0`) so the DATABASE is the limit — same rule as
 *     `beginPaidImageIntentDispatch`.
 *
 * COMMERCIAL PERMISSION IS NOT TECHNICAL CAPABILITY. An unlocked project is
 * still refused, or still produces no deliverable, for a pending revision, an
 * unconfirmed final direction, a stale concept, or a `requestedProductionOutput`
 * V1 does not produce. FORBIDDEN: merging `ProductionUnlock` with
 * `requestedProductionOutput`, or letting an unlock satisfy any gate that
 * exists to state what the pipeline can honestly deliver.
 *
 * THE UNLOCK SITS ABOVE EXISTING IDEMPOTENCY, never inside it.
 * `createJobToleratingRace`, the `(approval, requestedProductionOutput)` and
 * `(preparation, width, output)` unique keys, and the Topaz
 * `(providerKey, providerRequestId, providerStatus)` triple are all
 * unchanged. FORBIDDEN: relaxing any of them because an unlock is present.
 *
 * FAIL CLOSED, IN FOUR PLACES, none of them redundant:
 *   the query filters `status = 'active'`, so a revoked unlock cannot reach a
 *     gate that forgot to check;
 *   `productionUnlockAuthorizes` re-verifies status, profile, and project
 *     against values THIS BUILD understands — `readStoredProductionProfile`
 *     and `readStoredProductionUnlockStatus` narrow persisted columns to an
 *     unrecognized sentinel rather than coercing them. FORBIDDEN: reading
 *     NULL or an unknown status as `"active"`, and equally forbidden:
 *     coercing an unknown profile to `apparel_raster`;
 *   the unlock's recorded acquisition session is cross-checked against the
 *     PROJECT's durable binding, and a mismatch refuses. FORBIDDEN: accepting
 *     a session id from a cookie, a header, or a request body;
 *   a repository read failure refuses — a database that cannot be read is not
 *     a database that has said yes.
 *
 * THE PROFILE IS A PRODUCTION OUTCOME, NEVER A FILE FORMAT.
 * `ProductionProfile` is the strict GRANTABLE subset of `ProductionCategory`
 * — that union also carries refusal and dormant-role values
 * (`apparel_vector`, `out_of_scope_product`, `signage`, `logo_vector`,
 * `unknown`), none of which anyone can be sold. Enforced twice and
 * independently: a `CHECK` constraint in the database, and fail-closed
 * narrowing in the application. FORBIDDEN: inventing a parallel
 * "productionTarget" vocabulary, and equally forbidden: widening the CHECK to
 * "make a test pass" — a string in a column must never be what authorizes a
 * production path.
 *
 * REVOCATION IS NOT DELETION. `revoked` stops FUTURE finalization; the row
 * survives as the audit trail a refund depends on, and prior
 * `FinalArtworkJob`s, production assets, and validations are never touched —
 * that work genuinely happened. A re-grant is a NEW row with its own
 * `grantedAt`, never a resurrection. FORBIDDEN: deleting an unlock, moving
 * `revokedAt` on an already-revoked row, or a status value that describes a
 * PAYMENT rather than a permission (`pending`, `paid`, `failed`) — those
 * belong to a transaction record A5.3+ owns.
 *
 * LEGACY AND INTERNAL NEED NO UNLOCK. Both are outside the acquisition funnel
 * entirely. FORBIDDEN: creating a synthetic unlock for them — a fabricated
 * commercial record asserts a purchase that never happened and is
 * indistinguishable afterwards from a real one.
 */

/**
 * SPRINT A5.3 — PaymentCapability (`capabilities/payment/`).
 *
 * The checkout boundary: creating and resuming ONE payment attempt for a
 * project's production unlock. See ARCHITECTURE.md §23d.
 *
 * DEPENDS ON
 *   ProjectRepository, PaymentProvider (its own port), the offer config.
 *
 * DEPENDED ON BY
 *   the checkout route, and nothing else.
 *
 * FORBIDDEN: `AcquisitionCapability` depending on this capability. The spend
 *   boundary stays a leaf on the repository and must not learn that commerce
 *   exists. This capability resolves the project's acquisition session from
 *   the repository itself, exactly as `AcquisitionCapability` does — which is
 *   why no dependency is needed in either direction.
 *
 * A PAYMENT ATTEMPT IS NOT AN ENTITLEMENT.
 *
 *   FORBIDDEN: creating, activating, or touching a `ProductionUnlock` from
 *     any checkout path. FORBIDDEN: any gate reading a `PaymentTransaction`
 *     status as permission — including the `"paid"` A5.4 will write. There is
 *     no foreign key between the two tables, no trigger, and no shared
 *     column, and the Postgres proof asserts all three.
 *
 *   FORBIDDEN: treating a browser redirect as authority. Success/cancel URLs
 *     carry `checkout=complete` ("you came back"), never `paid=true`, never
 *     an interpolated provider session id. A5.4's VERIFIED WEBHOOK is the
 *     only thing that may ever grant an unlock.
 *
 * `pending_provider` IS A REAL STATE, NOT A PLACEHOLDER.
 *
 *   The durable row must exist BEFORE the provider call — its id is the
 *   idempotency key and the webhook's reconciliation handle. FORBIDDEN:
 *   writing `"created"` at that moment. A crash would make the lie permanent:
 *   a row claiming a session that never existed, holding the one outstanding
 *   slot forever, indistinguishable afterwards from a real one.
 *
 *   FORBIDDEN: freeing the outstanding slot on an AMBIGUOUS provider failure.
 *     A session may really exist; starting a second attempt beside it is how
 *     a customer ends up with two payment pages for one purchase. Only a
 *     provably-not-dispatched failure may mark an attempt `"failed"`, and the
 *     dispatch axis is `ProviderError.dispatch` — the same one the paid-image
 *     and final-artwork paths already use, never a second reading of it.
 *
 *   FORBIDDEN: omitting the provider idempotency key, or deriving it from
 *     anything but the durable transaction id. It is what makes the
 *     Stripe-and-Postgres-are-not-atomic window survivable: the retry gets
 *     the SAME session instead of buying a second one.
 *
 * THE SERVER OWNS EVERY COMMERCIAL VALUE.
 *
 *   `createCheckout(projectId)` takes a project id and nothing else.
 *   FORBIDDEN: accepting an amount, currency, price id, production profile,
 *   project id, acquisition session id, approval id, artwork version id, or
 *   email from a request body — at any layer. The route's body schema is a
 *   `.strict()` empty object, so such a field is REJECTED rather than
 *   stripped: stripping charges the right price but leaves the boundary
 *   invisible, and an invisible boundary is an untested one.
 *
 *   FORBIDDEN: a second price. `production-unlock-offer-config.ts` is the
 *   only place an amount exists, it fails closed with NO development
 *   fallback, and it validates the RAW STRING — `Number.isInteger(Number("49.00"))`
 *   is true, so an operator meaning forty-nine dollars would otherwise have
 *   configured forty-nine cents.
 *
 *   Amount, currency, and profile are FROZEN onto the row at open time and
 *   re-read from it on resume. FORBIDDEN: re-reading config mid-attempt — it
 *   would re-price a customer mid-tab and would change the request body under
 *   a replayed idempotency key.
 *
 *   FORBIDDEN: building redirect URLs from a request's `Host`/`Origin`
 *   header. Server configuration only; an attacker-controlled header there is
 *   an open redirect with a payment page in front of it.
 *
 * PROVIDER ISOLATION, same rule as every other provider boundary.
 *
 *   FORBIDDEN: a Stripe type, session object, event shape, or raw error
 *   reaching anything above `PaymentProvider`. The adapter is exported only
 *   through `resolvePaymentProvider`, never from the capability barrel.
 *
 *   FORBIDDEN: duplicating authority values into provider metadata. It
 *   carries exactly one opaque internal transaction id — a HANDLE the
 *   webhook uses to find the durable row, after which every fact comes from
 *   that row. Metadata is caller-supplied data that made a round trip; it is
 *   not evidence.
 *
 *   FORBIDDEN: putting the customer's email in metadata (Stripe has
 *   `customer_email`), returning it to a browser, or round-tripping it
 *   through a client.
 *
 * COMMERCIAL PERMISSION IS STILL NOT TECHNICAL CAPABILITY, and checkout is
 *   refused rather than sold when the product could not deliver: an
 *   unsupported `requestedProductionOutput`, a pending revision, or nothing
 *   designed yet. FORBIDDEN: taking money first and refusing afterwards.
 *
 * BOTH WORKFLOWS REACH CHECKOUT FROM THEIR OWN EXISTING AUTHORITY —
 *   a delivered-and-selected concept, or an approved `ArtworkPreparation`.
 *   FORBIDDEN: requiring a `FinalDirectionApproval` (it is created BY the
 *   thing being purchased, so requiring it makes checkout unreachable), and
 *   forbidden: requiring `finalDirectionConfirmed`, which is the finalization
 *   gate, resets on re-selection, and would import a resettable flag into the
 *   commerce path.
 *
 * ONE REFUSAL SENTENCE for every internal reason. FORBIDDEN: distinguishable
 *   refusals or status codes — they let a caller enumerate which projects
 *   exist, which are already paid for, and which are internal. The real
 *   reason is logged server-side.
 *
 * A5.3 UNLOCKS NOTHING. Generation authorization is untouched, finalization
 *   authorization is untouched, and `AcquisitionCapability` was not modified.
 *
 * ---------------------------------------------------------------------------
 * PRINT'EM ALL PHASE 1 — GARMENT-AWARE PRODUCTION SIZE AUTHORITY
 * ---------------------------------------------------------------------------
 *
 * THREE CONCEPTS, THREE MODULES, ONE DIRECTION OF DEPENDENCY.
 *   `shared/garment-production-sizing.ts`   the RECOMMENDATION (a suggestion)
 *   `shared/confirmed-production-size.ts`   the AUTHORITY (what a human approved)
 *   `shared/print-placement-dimensions.ts`  the TECHNICAL LIMIT (what fits)
 *
 *   All three are pure: no repository, no capability, no provider, no clock.
 *   Recommendation and confirmation both depend on the technical limit;
 *   nothing depends on the recommendation in order to spend money.
 *
 *   FORBIDDEN: a fourth copy of any inch figure. UI components, routes, and
 *   workers read derived values only — the rule that already keeps `10.5`
 *   out of the finalization worker.
 *
 * A RECOMMENDATION IS NEVER SPEND AUTHORITY.
 *   `ProductionBoxRecommendation.requiresExplicitConfirmation` is typed as
 *   the literal `true`, so nothing can derive `false` from anything.
 *
 *   FORBIDDEN: authorizing a paid provider call from a recommendation, from
 *   `defaultWidthIn`, or from `intendedPrintWidthIn`. A number cannot carry
 *   consent — once a default fills in, "10.5 because they said so" and "10.5
 *   because nobody said anything" are the same value. Only
 *   `productionSizeConfirmedAt` + `productionSizeConfirmedWidthIn` may
 *   authorize spend, and only `DesignBriefCapability.confirmProductionSize`
 *   may write them.
 *
 * THE RECOMMENDATION TABLE IS OPERATOR PRODUCT AUTHORITY, AND EVOLVES.
 *   `PRODUCTION_BOX_RECOMMENDATIONS` holds the operator's initial Print'em
 *   All figures (8.5 / 9 / 10.5 / 12in front-back boxes) and is expected to
 *   change as real production evidence accumulates. Revising it is a data
 *   change to that one table.
 *
 *   FORBIDDEN: adding a figure this product has not actually decided. A
 *   shipped guess becomes indistinguishable from a real production decision
 *   the moment an operator confirms it — which is why `custom` stays `null`
 *   permanently and asks for a width instead.
 *
 *   FORBIDDEN: scaling left chest or sleeve with the garment class. Those are
 *   sized by the PRINT, not the shirt; a 12in "left chest" is a full front.
 *
 * CHANGING THE GARMENT CLASS WITHDRAWS THE CONFIRMATION.
 *   Consent was given to a physical size ON A KIND OF GARMENT, and the class
 *   is the second half of that sentence.
 *
 *   FORBIDDEN: carrying an old confirmation across a class change, and
 *   equally forbidden: auto-confirming the new class's recommendation, which
 *   would infer consent from a suggestion.
 *
 * GARMENT SIZE CLASS IS PRODUCT TERMINOLOGY, NEVER A PERSON.
 *   FORBIDDEN: inferring gender or body size from it, growing it into a SKU
 *   catalogue / apparel inventory / manufacturer sizing database, or selling
 *   garments. iHeartPrints sells artwork.
 *
 * CONTAIN, NEVER DISTORT — AND NEVER A SECOND GEOMETRY ENGINE.
 *   `sizingPolicyForProductionBox` points `resolveWidthConstrainedSizing` at
 *   a box; that function already contains proportionally.
 *
 *   FORBIDDEN: stretching, cropping to fill, letterboxing, forcing a portrait
 *   to the box width, any independent X/Y scale in an operator surface, or a
 *   second implementation of containment arithmetic.
 *
 * RECOMMENDATION != MAXIMUM.
 *   FORBIDDEN: clamping an explicit oversize request back to the
 *   recommendation. The technical band bounds it; a request outside the band
 *   is REFUSED, not clamped, because a clamp would record consent for a size
 *   nobody chose.
 *
 * PRODUCTION WIDTH IS PART OF JOB IDENTITY, FOR BOTH WORKFLOWS.
 *   FORBIDDEN: re-aiming a queued job at a newly confirmed size, reusing a
 *   submitted provider request as authority for a different size, or mutating
 *   a submitted job. A new confirmed size gets a new job; the old one stays
 *   immutable evidence.
 *
 * COMMERCIAL ENTITLEMENT AND PRODUCTION SAFETY ARE INDEPENDENT DIMENSIONS.
 *   FORBIDDEN: an internal entitlement, a production unlock, or a legacy
 *   project skipping size confirmation. Internal means commercially
 *   unrestricted, never production-unsafe.
 *
 * NO RETROACTIVE CONSENT, AND NO RETROACTIVE INVALIDATION.
 *   FORBIDDEN: backfilling `production_size_confirmed_at`, and equally
 *   forbidden: withholding an already-produced, already-validated
 *   `print_ready` plate from the customer who already has it.
 */

/**
 * ---------------------------------------------------------------------------
 * PRINT'EM ALL PHASE 2 — PRODUCTION TREATMENTS (DTF HALFTONE)
 * ---------------------------------------------------------------------------
 *
 * A SECOND PRODUCTION REPRESENTATION, NOT A SECOND PIPELINE.
 *
 * V1 now produces apparel raster artwork by one of two methods. They are not a
 * quality dial and not a fallback chain — they make different claims and are
 * proven by different checks:
 *
 *   standard_raster  genuine/reconstructed CONTINUOUS TONE at 300 PPI,
 *                    reconstruction bounded by the provider's proven 4x
 *                    ceiling, judged by `reconstruction_sufficiency`.
 *   halftone_dtf     a DOT LATTICE generated AT the final production
 *                    dimensions. No provider, no paid call. Judged by
 *                    `halftone_final_size_generation`,
 *                    `halftone_screen_geometry`, and
 *                    `halftone_tonal_sufficiency`.
 *
 * WHERE THE SEAM IS, AND WHERE IT IS NOT.
 *
 * Phase 1 reserved `final-artwork/enhancement-decision.ts` and proposed a
 * third `EnhancementMethod` member. THAT DESIGN WAS REJECTED AND MUST NOT BE
 * REVIVED. `decideEnhancement` is pure arithmetic on (visible source width,
 * target width x PPI); a treatment is not derivable from those numbers because
 * it is not a fact about the artwork, it is A DECISION A HUMAN MADE. Putting
 * the branch there constructs exactly the chain this phase exists to make
 * impossible:
 *
 *     standard raster was refused  ->  therefore halftone
 *
 * The seam is one line higher, at PROVIDER SELECTION in
 * `final-artwork-worker`'s `runPreparedUploadJob`, and it sits BEFORE any
 * provider dispatch (Goal 25 — the artwork this treatment serves is exactly
 * the artwork the 4x ceiling refuses, so reaching for Topaz first would buy
 * detail the screen then discards). `decideEnhancement` is unchanged, still
 * runs, and its verdict is still recorded.
 *
 * DEPENDENCY DIRECTION.
 *   lib/domain/types.ts            persisted vocabulary + fail-closed readers
 *                                  (`lib/db` reads these and never depends on
 *                                  `capabilities`)
 *     <- shared/production-treatment.ts   policy: defaults, bounds,
 *                                  normalization, canonical key, eligibility
 *       <- final-artwork/halftone-screen.ts        the engine
 *       <- print-validation/                       the checks
 *
 * `print-validation` MUST NOT import the engine. Both sides read
 * `MIN_PRINTABLE_DOT_RADIUS_PX` from `shared`, because a validator that
 * imported the thing it validates would be depending on its own subject.
 *
 * AUTHORITY, AND WHAT MAY BE BUILT ON IT.
 *
 * The durable decision is `production_treatment` + `halftone_settings` +
 * `production_treatment_selected_at`, written ONLY by
 * `DesignBriefCapability.selectProductionTreatment`. It is exactly the shape
 * of Phase 1's size confirmation and for the same reason: a value that could
 * be arrived at by default cannot be distinguished, afterwards, from one a
 * human chose.
 *
 * `resolveProductionTreatment` FAILS TO STANDARD RASTER on any incomplete
 * record. Nothing anywhere may make the reverse move.
 *
 * FORBIDDEN, permanently:
 *   - deriving a treatment from a validation outcome, a failed
 *     reconstruction, an artwork measurement, or any other inference;
 *   - automatic treatment selection for public customers (Phase 2 is internal
 *     operator selection only, and any future automatic recommendation needs
 *     real print tests behind it);
 *   - relaxing `reconstruction_sufficiency`, the 4x ceiling, or any standard
 *     raster rule to accommodate the halftone path;
 *   - emitting `reconstruction_sufficiency` as a PASS for a halftone plate
 *     (it is inapplicable, and is not emitted at all);
 *   - collapsing `"halftone_generated"` provenance into `"reconstructed"`,
 *     or describing a halftone plate as reconstructed source detail;
 *   - baking a garment colour into an exported deliverable;
 *   - re-running background removal as part of halftoning, or treating the
 *     immutable prepared source as anything but immutable;
 *   - gating the treatment on a browser-side condition. The gate is
 *     `AcquisitionCapability.isInternalProject`, on the WRITE.
 *
 * TREATMENT IS PART OF JOB IDENTITY, alongside production width and requested
 * output. A settings change supersedes a queued job; it never re-aims one.
 */

/**
 * ============================================================================
 * SIGNS PHASE S1 — RIGID SIGN INSPECTION / DIAGNOSIS / PLANNING (§16A)
 * ============================================================================
 *
 * `sign-preparation` is the admitted rigid_sign_raster profile's
 * UNDERSTANDING stage: it measures, diagnoses, and PLANS. It never executes
 * a repair, never changes a pixel, and can never claim `print_ready`.
 *
 * ALLOWED dependencies:
 *   - ProjectRepository + AssetCapability (persistence and the immutable
 *     original's bytes) — NO provider port of any kind exists in the module;
 *   - artwork-preparation's PURE ingress modules (`upload-limits.ts`,
 *     `image-decode.ts`) — the single audited byte→pixel path is reused,
 *     never duplicated;
 *   - print-validation's pure vocabulary (`contracts.ts`,
 *     `effective-resolution.ts`) — same direction final-artwork already uses;
 *   - the provider reconstruction bounds (`PROVIDER_MAX_RECONSTRUCTION_SCALE`,
 *     `RECONSTRUCTION_HEADROOM`) imported as CONSTANTS from the topaz module
 *     so the planner and the executor can never quietly disagree. Importing
 *     the constants is not permission to call the provider: nothing in
 *     sign-preparation may dispatch, poll, or download anything.
 *
 * FORBIDDEN:
 *   - executing any repair step (upscale, extend, pad, crop, resample,
 *     rotate, flatten, generate) — S2+ territory, each phase separately
 *     approved;
 *   - deriving an ordered dimension from anything but explicit human
 *     confirmation (never artwork pixels, aspect, filename, prose, keywords,
 *     or the dormant `signage` placeholder — §16A.2);
 *   - routing sign orders through brief-text classification (Sprint A2:
 *     prose keywords still resolve sign nouns to `out_of_scope_product`;
 *     `deriveProductionRequirements`'s `rigid_sign_raster` arm fails closed);
 *   - adopting the dormant `signage` arm's placeholder figures as policy;
 *   - reusing apparel placement sizing (`PrintPlacement`,
 *     `intendedPrintWidthIn`) for sign dimensions;
 *   - downgrading an unproven edge to `uniform_background`, or any
 *     uncertainty to `auto_safe` — unknown never becomes safe;
 *   - duplicating Print Validation's rules or FinalArtwork orchestration;
 *   - exposing any HTTP route in S1 (operator/internal only; §23.2 — no new
 *     bearer-UUID surface).
 *
 * PLAN IDENTITY (`planKey`) covers production-significant inputs only
 * (schema version, policy id, source bytes' sha256 + dimensions, ordered
 * size, ordered steps' kind+params, expected output) with canonical
 * serialization — never rationale text or risk classes, and never sensitive
 * to cosmetic JSON ordering. It is the future FinalArtworkJob binding key,
 * mirroring `production_treatment_key`.
 */

export const CAPABILITY_BOUNDARY_VERSION = "PEA2" as const;
