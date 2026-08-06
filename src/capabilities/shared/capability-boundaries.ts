/**
 * Documented dependency directions for the capability architecture.
 * These are conventions enforced by composition and code review (Sprint 2C,
 * refined Sprint 2E, adaptive interview Sprint 2F, adaptive revisions
 * Sprint 2G Part 2, real generation infrastructure Sprint 2H Part 1,
 * Concept Evaluation architecture Sprint 2I Phase 1, first real Concept
 * Evaluation provider Sprint 2I Phase 2, Regeneration Intelligence
 * architecture Sprint 2J Phase 1).
 *
 * Pipeline (Sprint 2G Part 2):
 *   Conversation → IntentExtraction → DesignBrief
 *                → RevisionIntelligence (old brief, new brief → impact)
 *                → BriefEvaluation → DesignIntelligence (scoped by impact)
 *                → InterviewIntelligence → best next act
 *                → DesignSummary → Approval → ConceptGeneration
 *                  (± RevisionIntelligence-driven concept regeneration)
 *
 * Regeneration pipeline (Sprint 2J Phase 1 — architecture only, not yet
 * wired into the live worker):
 *   Approved Design Brief + Concept Evaluation + Revision History (a
 *   chronological sequence of RevisionImpact) → RegenerationIntelligence
 *   → provider-neutral RegenerationPlan → (future) PromptTranslation →
 *   (future) ConceptGenerationProvider. RegenerationIntelligence never
 *   generates artwork, never evaluates artwork, never re-scores concepts,
 *   and never mutates the Design Brief — it only decides what the *next*
 *   generation attempt should preserve, strengthen, remove, replace, or
 *   avoid. Its output is never persisted; it is cheap and pure enough to
 *   recompute on demand from an approved brief snapshot + the latest
 *   evaluation + revision history.
 *
 * Generation pipeline (Sprint 2H Part 1 + Sprint 2I Phase 1):
 *   ConceptGeneration → PromptTranslation (approved brief snapshot →
 *                  provider-neutral GenerationPromptRequest; pure, no
 *                  provider knowledge) → ConceptGenerationProvider
 *                  (interface; a provider adapter owns 100% of its own
 *                  prompt dialect and quality-boosting language internally
 *                  — never exported, never persisted) → AssetCapability
 *                  (persists any real image/asset a provider returned) →
 *                  ConceptEvaluationCapability (approved brief + concept
 *                  asset refs → provider-neutral ConceptEvaluationResult;
 *                  never blocks or discards concepts in Phase 1) →
 *                  durable GenerationJob record (queued → running →
 *                  completed/failed/cancelled, deterministic
 *                  idempotencyKey so a retried job never duplicates
 *                  concepts) → ArtworkVersion ("Concept") rows referencing
 *                  the job/assets/provider/evaluation internally. None of
 *                  job id / asset id / provider key / prompt language /
 *                  evaluation scores is ever placed in a customer-facing
 *                  message or `ProjectSnapshot` field the UI renders as such.
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
 *   ConceptGeneration → PromptTranslation, ConceptGenerationProvider
 *                  (interface), AssetCapability, persistence. Regeneration
 *                  after a revision still requires an approved Design
 *                  Brief version — never generates from an unapproved
 *                  working brief, revision or not.
 *   PromptTranslation → Design Brief snapshot data only. Pure and
 *                  deterministic: no I/O, no provider knowledge, no
 *                  quality-boosting/prompt-dialect language of any kind.
 *   ConceptEvaluation → approved Design Brief snapshot content + concept
 *                  presentation fields + opaque asset references only.
 *                  Provider-neutral: never knows OpenAI/GPT/Vision vendors.
 *                  Never writes repositories itself; never mutates briefs;
 *                  never produces customer-facing copy; never performs Print
 *                  Validation (DPI, transparency, print size, etc.).
 *                  Provider adapters receive ConceptEvaluationRequest only —
 *                  never customer ids, conversation ids, generation job ids,
 *                  provider secrets, or repository handles.
 *                  Sprint 2I Phase 2: `ConceptEvaluationAssetReference.sourceUrl`
 *                  — when present — is a short-lived, expiring URL that
 *                  `GenerationWorkerCapability` mints via
 *                  `AssetCapability.getSignedUrl` before calling
 *                  `ConceptEvaluationCapability.evaluate`. This is the same
 *                  customer-safe mechanism the browser uses for asset
 *                  access, not a raw storage key or repository handle — a
 *                  vision-capable provider adapter fetches it directly
 *                  (never through the capability layer). Still `null`-safe:
 *                  a missing/unmintable URL routes to an honest
 *                  "not assessed" result rather than a network call.
 *   AssetCapability → persistence only. Called by ConceptGeneration after a
 *                  provider has already returned its result — never by a
 *                  provider adapter directly.
 *   PrintValidation → brief/artwork data (read-only); never mutates briefs;
 *                  never confuses itself with Concept Evaluation
 *   Provider adapters → generation DTOs only (a `ConceptGenerationRequest`
 *                  carrying a provider-neutral `GenerationPromptRequest`,
 *                  never a raw Design Brief); never mutate domain objects,
 *                  never write to a repository, never touch a conversation.
 *                  A provider's own prompt dialect/quality keywords are
 *                  private to that provider's file.
 *   ConceptEvaluationProvider adapters → ConceptEvaluationRequest only;
 *                  return ConceptEvaluationResult; no repository writes.
 *   RegenerationIntelligence → approved Design Brief snapshot content, the
 *                  persisted Concept Evaluation for the current concept
 *                  batch (or `null` before one exists), a chronological
 *                  RevisionImpact history, and caller-supplied generation
 *                  attempt bookkeeping only. Reuses
 *                  `shared/concept-relevance` (the same policy Revision
 *                  Intelligence and Concept Generation already use) to
 *                  scope itself to sections that actually change generated
 *                  artwork. Pure and deterministic: no Conversation, no
 *                  persistence, no repository, no provider, no UI, no
 *                  clock reads. Never re-scores a concept (that is Concept
 *                  Evaluation's job, consumed only as input here), never
 *                  regenerates artwork itself, never mutates the Design
 *                  Brief, and never emits provider prompt dialect or
 *                  quality-boosting language — its `RegenerationPlan`
 *                  output is provider-neutral, exactly like
 *                  `GenerationPromptRequest`.
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
 *   Concept Evaluation performing Print Validation concerns (DPI,
 *     transparency, vector quality, embroidery limits, raster quality)
 *   Concept Evaluation blocking or discarding concepts in Phase 1
 *   Concept Evaluation provider adapters receiving customer/conversation/
 *     job ids, secrets, or repository handles
 *   Regeneration Intelligence generating artwork, calling a provider, or
 *     depending on ConceptGenerationProvider / ConceptEvaluationProvider
 *   Regeneration Intelligence re-scoring or re-running Concept Evaluation
 *     (it only ever consumes an already-produced evaluation result)
 *   Regeneration Intelligence mutating the Design Brief, or depending on
 *     Conversation, persistence, a repository, or UI
 *   Regeneration Intelligence persisting a RegenerationPlan — plans are
 *     always ephemeral and recomputed, never stored
 *   Regeneration Intelligence emitting provider prompt dialect or
 *     quality-boosting keywords ("masterpiece", "8k", etc.) — that
 *     vocabulary belongs exclusively to a provider adapter, several
 *     capabilities removed from this one
 *   Print Validation modifying Design Briefs
 *   Print Validation depending on Concept Evaluation internals (share
 *     ArtworkVersion fields only)
 *   Provider adapters mutating Design Briefs, writing directly to a
 *     repository, or receiving a raw Design Brief instead of a
 *     PromptTranslation-produced GenerationPromptRequest
 *   Design Brief storing prompt syntax / provider dialect
 *   Provider identity, generation job ids, asset ids, evaluation scores, or
 *     any provider error detail reaching a customer-facing message or
 *     ProjectSnapshot field the UI renders as such (Sprint 2H Part 1 /
 *     Sprint 2I Phase 1)
 */

export const CAPABILITY_BOUNDARY_VERSION = "2J1" as const;
