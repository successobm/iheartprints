# iHeartPrints System Architecture

Version 1.0  
August 2026

## Document Position

This document is the second-highest architectural reference after
[`IHEARTPRINTS_CONSTITUTION.md`](./IHEARTPRINTS_CONSTITUTION.md).

| Document | Authority |
|---|---|
| `IHEARTPRINTS_CONSTITUTION.md` | Product direction and enduring principles |
| `ARCHITECTURE.md` (this file) | Current system design and domain boundaries |
| `AGENTS.md` | Agent behavior when modifying the repository |

Implementation must remain consistent with all three. Architecture may
evolve, but architectural changes must remain consistent with the
Constitution and should update this document in the same change.

This is not a roadmap, sprint report, or generic Next.js guide. It
documents the iHeartPrints system as implemented in this repository. The
code is the source of truth for behavior; this document explains how that
behavior is organized to uphold the Constitution.

---

## 1. Purpose

This document defines how iHeartPrints is currently built so that future
developers and agents know where new functionality belongs before modifying
the system.

It covers:

- domain boundaries
- capability responsibilities
- dependency direction
- persistence abstractions
- generation runtime
- asset storage
- background processing
- customer-facing workflow
- security boundaries
- extension points
- architectural constraints

Read this before changing capability wiring, domain ownership, generation
lifecycle, persistence contracts, or security boundaries.

---

## 2. Architectural Principles

Derived from the Constitution and enforced by the current implementation:

1. **The Design Brief is the source of truth.** Chat messages inform it;
   generated images illustrate it. Neither replaces it.
2. **Conversation is the primary customer experience.** Supporting surfaces
   (summaries, concept cards, recommendations) render capability-produced
   facts; they do not invent domain decisions.
3. **Capabilities own business logic.** Routes validate and translate;
   services/facades delegate; UI renders.
4. **UI and routes must not own domain decisions.** Approval readiness,
   concept staleness, generation eligibility, and interview next-act
   selection live in capabilities.
5. **Providers are replaceable implementation details.** Provider adapters
   receive provider-neutral DTOs and return raw bytes/data only.
6. **Generated images never mutate the Design Brief.** Concepts reference
   the approved brief version that authorized them.
7. **Evaluation, recommendations, interviewing, generation, and validation
   are separate concerns.** Brief Evaluation does not recommend; Design
   Intelligence does not ask; Interview Intelligence does not generate;
   Print Validation does not mutate briefs and does not transform artwork.
8. **Customer complexity stays hidden.** Model names, DPI, formats,
   provider keys, job ids, object keys, and storage modes are not
   customer-facing.
9. **Versions are preserved rather than destructively replaced.** Approved
   brief versions and prior concept batches remain available.
10. **Production concerns remain server-side.** Service-role keys, worker
    secrets, provider credentials, and generation work stay off the
    browser.
11. **Provider names, storage providers, job identifiers, and technical
    settings are not customer-facing.** Customer copy uses plain language
    ("Generating Concepts…", "Concepts Ready").
12. **Composition owns environment-driven selection.** Conversation and UI
    code never inspect provider or storage environment variables.
13. **Idempotency protects durable side effects.** Approval and generation
    enqueue must tolerate retries without duplicating versions or concepts —
    and, because they are separate writes with no shared transaction, a
    retry must also *complete* an approval that a prior attempt left
    half-applied. An approved brief version is never on its own proof that
    generation was requested.
14. **Browser closure must not strand generation.** Customer requests only
    enqueue work; an independent worker claims and completes it.
15. **Customer content is authoritative.** What the customer asked to see in
    the artwork outranks every downstream preference. Conversation
    Understanding may reword, tidy, and remove conversational filler, but it
    must preserve design-critical objects, categories, counts, positions and
    relationships. Concept directions control creative *treatment*, never
    required subject matter. Provider defaults (for example a centered
    composition) are the lowest priority in the system and must never
    contradict an explicit customer composition. See §13f.

---

## 3. System Context

### External systems currently used

| System | Role in iHeartPrints | Replaceability |
|---|---|---|
| Next.js application | HTTP API, UI, composition root host | Framework choice is infrastructure; domain lives under `src/capabilities` |
| Supabase database | Optional durable Postgres persistence | Swappable via `ProjectRepository` (`local` JSON when unset) |
| Supabase Storage | Optional private object storage for generated assets | Swappable via `AssetStorageProvider` |
| DigitalOcean App Platform | Documented deployment host for web + scheduled worker invocation | Hosting topology; does not own business logic |
| Generation providers | Produce concept image bytes (placeholder or OpenAI adapter) | Behind `ConceptGenerationProvider` |
| Browser client | Conversation UI, read-only status polling | Presentation only |
| Scheduled worker invocation | Cron/HTTP or standalone process calling the worker scheduler | Topology only; logic stays in `GenerationWorkerCapability` |

Domain architecture (capabilities, Design Brief, interview, approval,
generation jobs) is independent of which database, storage backend, host,
or image provider is configured.

### System-context diagram

```
Customer Browser
       |
       |  conversation / decisions / read-only status poll
       v
Next.js Application
       |
       +--> ConversationCapability (+ peer capabilities)
       |
       +--> ProjectRepository  ---->  Local JSON  |  Supabase Database
       |
       +--> AssetCapability ------->  AssetStorageProvider
       |                                  |
       |                                  +--> data_uri | filesystem
       |                                  +--> supabase_storage (private)
       |                                  +--> s3 (reserved, unimplemented)
       |
       +--> ConceptGenerationCapability
                    |
                    | enqueue GenerationJob (queued)
                    v
             Generation Job Queue (repository)
                    |
                    | independent of customer request lifecycle
                    v
             GenerationSchedulerCapability
                    |
                    | protected POST /api/worker/generation
                    | or npm run worker (standalone)
                    v
             GenerationWorkerCapability
                    |
                    +--> PromptTranslationCapability
                    +--> ConceptGenerationProvider
                    +--> AssetCapability
                    +--> ConceptEvaluationCapability
                    |         |
                    |         +--> ConceptEvaluationProvider
                    +--> ProjectRepository
```

---

## 4. End-to-End Customer Workflow

Currently implemented flow:

```
Conversation
  → Conversation Understanding (best-effort semantic interpretation, Sprint 2L Phase 1)
  → Intent Extraction (reconciles semantic + deterministic interpretation into one proposal)
  → Working Design Brief
  → Brief Evaluation
  → Design Intelligence
  → Interview Intelligence
  → Design Summary
  → Customer Approval
  → Approved Design Brief Version
  → Queued Generation Job
  → Independent Worker
  → Prompt Translation
  → Generation Provider
  → Asset Storage
  → Concept Evaluation (real vision-based scoring when configured, otherwise
    placeholder; persisted; still does not block presentation)
  → Concepts Ready
  → Customer Review
  → Revision Intelligence
  → Updated Working Brief / optional regeneration
```

Sprint 2L Phase 1 introduces `ConversationUnderstandingCapability`, a
provider-neutral semantic-interpretation layer that runs (when useful — see
§10a) ahead of Intent Extraction on every pre-approval and post-approval
revision turn. It never mutates the Design Brief and never decides what to
ask next; it only proposes a structured, bounded interpretation of the
customer's message. `IntentExtractionCapability` is still the sole producer
of `BriefPatchProposal` — it validates, normalizes, and merges the semantic
proposal with its own deterministic `extractAdaptive` pass per Design Brief
field, so exactly one interpretation of each field ever reaches the brief
per turn. See §10a for the full precedence contract, bounded-context
policy, and security boundary.

Sprint 2J Phase 3 activates Regeneration Intelligence on the customer's
**explicit** regeneration path only (`Generate Updated Concepts` →
`regenerateAfterRevision` → `GenerationJob.kind === "regeneration"`).

- `GenerationIntent` is the sole provider-neutral input to Prompt Translation.
- Initial generation builds a brief-only intent (no timeline, no plan) and
  produces byte-for-byte equivalent prompts to pre-Phase-3 behavior.
- Regeneration derives RevisionTimeline → RegenerationPlan →
  GenerationIntent → PromptTranslation → provider.

No automatic regeneration, no UI changes, no new messages. Timeline, plan,
and intent remain ephemeral. See §5 and §13a.

### Synchronous vs asynchronous

| Step | Timing |
|---|---|
| Message handling, conversation understanding, intent extraction, brief patch, evaluation, intelligence, interview act, summary presentation | Synchronous within the customer request (Conversation Understanding: at most one short-timeout provider call per turn — see §10a) |
| Design Brief approval (version snapshot + enqueue job) | Synchronous request; generation itself is not |
| Concept generation (provider call, asset upload, concept evaluation, artwork rows) | Asynchronous via independent worker |
| Generation status | Read-only browser polling; never claims or runs jobs |
| Finalization status | Read-only browser polling while `preparing`; never claims or runs jobs |
| Post-approval revisions | Synchronous brief update; regeneration is enqueue-only |

Real provider generation is guarded by configuration
(`CONCEPT_GENERATION_PROVIDER`, asset storage readiness, and
`CONCEPT_GENERATION_ENABLE_REAL`) and may remain disabled. The default safe
mode uses the placeholder provider.

Generated concepts are options for human review. They are **not**
print-ready production assets. Concept Evaluation (Phase 1 architecture;
Phase 2 first real evaluator) records whether each concept aligns with the
approved Design Brief but does **not** block customer presentation. Print
Validation is not implemented.

---

## 5. Capability Architecture

Capabilities live under `src/capabilities/`. Composition wires them in
`src/capabilities/composition.ts`. Shared contracts and pure policy modules
live in `src/capabilities/shared/`.

Status legend:

- **Active** — used by the live conversation / generation pipeline
- **Partial** — real implementation with intentional gaps
- **Reserved** — contract/stub only; not product behavior yet
- **New (architecture only)** — unused in this sprint (none currently)
- **Active (regeneration path)** — `RevisionTimelineCapability` and
  `RegenerationIntelligenceCapability` are composed into
  `GenerationWorkerCapability` for `kind === "regeneration"` jobs only
  (Sprint 2J Phase 3); initial generation does not use them

### ConversationCapability — Active

| | |
|---|---|
| **Responsibility** | Customer-facing orchestration facade |
| **Inputs** | User messages, brief decisions, concept selection, undo, regenerate |
| **Outputs** | Updated `ProjectSnapshot`, assistant messages, interview progression |
| **Dependencies** | IntentExtraction, ConversationUnderstanding, DesignBrief, BriefEvaluation, DesignIntelligence, InterviewIntelligence, RevisionIntelligence, DesignSummary, ConceptGeneration, ProjectRepository |
| **Owns** | Turn orchestration, conversation phase transitions, wiring revision/approval/enqueue flows, building the bounded Conversation Understanding request |
| **Must never own** | Direct brief field mutation, provider calls, storage uploads, job claiming |

### ConversationUnderstandingCapability — Active (Sprint 2L Phase 1)

| | |
|---|---|
| **Responsibility** | Provider-neutral semantic interpretation of one customer message in bounded conversational context |
| **Inputs** | Current message, plain-language known-brief facts (`DesignSummaryView`), unresolved section list, pending section, a capped recent-turn window |
| **Outputs** | `ConversationUnderstandingResult` (proposed field updates with `explicit`/`inferred`/`ambiguous` confidence, deferrals, ambiguities, customer intent, answered-pending-section) — ephemeral, never persisted raw |
| **Dependencies** | `ConversationUnderstandingProvider` interface only |
| **Owns** | Bounded-context request construction; the provider-call skip policy (single-token replies); defensive validation/clamping of whatever a provider returns; graceful degradation to an empty result on any failure |
| **Must never own** | Design Brief mutation; deciding what to ask next; persistence; producing a `BriefPatchProposal` (that is `reconcile-understanding.ts`, inside Intent Extraction) |

Never the sole interpreter of a message — `IntentExtractionCapability`'s
deterministic `extractAdaptive` pass always also runs and is the sole
source of truth whenever this capability's result is empty (provider
unconfigured, call skipped, or provider failure). See §10a.

### IntentExtractionCapability — Active

| | |
|---|---|
| **Responsibility** | Parse customer language into brief patch proposals and intents — the sole authority reconciling semantic and deterministic interpretation |
| **Inputs** | Message text, conversation/brief context, optional `ConversationUnderstandingResult` |
| **Outputs** | `IntentExtractionResult` (`proposals`, `intents`) |
| **Dependencies** | Brief data (read-only), `shared/interview-coverage-policy`, `ConversationUnderstandingResult` (type-only, via `reconcile-understanding.ts`) |
| **Owns** | Proposal shape; defer/correct/provide detection; per-field precedence between a validated semantic proposal and deterministic extraction (Sprint 2L Phase 1 — see §10a) |
| **Must never own** | Persisting the brief; asking; generating; calling a Conversation Understanding provider itself |

### DesignBriefCapability — Active

| | |
|---|---|
| **Responsibility** | Sole mutation path for the working brief and approved versions |
| **Inputs** | Patch proposals; approval requests |
| **Outputs** | Updated working brief; immutable `DesignBriefVersion` on approval |
| **Dependencies** | ProjectRepository only |
| **Owns** | Working brief state; approval snapshots; version numbering |
| **Must never own** | Interview questions, recommendations, provider logic |

### BriefEvaluationCapability — Active

| | |
|---|---|
| **Responsibility** | Objective, deterministic evaluation of what is known/missing/ambiguous/contradictory |
| **Inputs** | Working `TShirtDesignBrief` |
| **Outputs** | `BriefEvaluation` (sections, overall, summary/approval readiness) |
| **Dependencies** | Brief data + `shared/interview-coverage-policy` |
| **Owns** | Completeness/confidence math; contradiction detection |
| **Must never own** | Recommendations, questions, generation, UI |

`BriefEvaluation.overall` is the **Brief Completeness** view (all 14
sections); `summaryReadiness`/`approvalReadiness` is the **Generation
Readiness** view (gates only on `required` + `high_value` tier sections
per `interview-coverage-policy.ts`) — see §10b. Both come from the same
evaluation pass; there is no second capability or persisted status.

### DesignIntelligenceCapability — Active

| | |
|---|---|
| **Responsibility** | Translate evaluation + product findings into customer-facing recommendations |
| **Inputs** | Brief, `BriefEvaluation`, optional `RevisionImpact` |
| **Outputs** | `IntelligenceAssessment` |
| **Dependencies** | ProductIntelligence; BriefEvaluation (consumed, not recomputed); optional RevisionImpact; shared phrasing |
| **Owns** | Recommendation cards / advisory content |
| **Must never own** | Asking questions; recomputing objective evaluation; provider knowledge |

### InterviewIntelligenceCapability — Active

| | |
|---|---|
| **Responsibility** | Choose one next conversational act |
| **Inputs** | `BriefEvaluation`, `IntelligenceAssessment`, `InterviewContext`; revision variant also takes `RevisionImpact` |
| **Outputs** | `InterviewAct` (`ask` / `clarify` / `advise` / `summarize` / `await_customer`) |
| **Dependencies** | Evaluation + assessment contracts; coverage policy; question phrasing |
| **Owns** | Deterministic next-act priority; ask-count / pending-section awareness |
| **Must never own** | Brief mutation; inspecting brief fields for completeness; concept generation |

### ProductIntelligenceCapability — Active

| | |
|---|---|
| **Responsibility** | Deterministic print/placement rule packs |
| **Inputs** | Brief; optional affected rule-pack ids |
| **Outputs** | `ProductionFinding[]` (plain-language advisories) |
| **Dependencies** | Brief data; `shared/product-rule-packs` |
| **Owns** | Rule-pack execution |
| **Must never own** | Hard-blocking approval; Print Validation; brief mutation |

Current rule packs:

| Pack id | Trigger (summary) | Severity |
|---|---|---|
| `small_placement_long_wording` | sleeve/left_chest + wording > 8 words; sleeve > 15 → blocking severity | warning / blocking |
| `small_placement_dense_graphics` | small placement + busy/detail language in graphics | warning |
| `full_placement_wall_of_text` | full_front/full_back + wording > 25 words | info |

Findings advise; they do not replace future Print Validation and do not
refuse Design Brief approval by themselves.

### DesignSummaryCapability — Active

| | |
|---|---|
| **Responsibility** | Customer-facing Design Summary and deferred-decision views |
| **Inputs** | Brief + evaluation (for resolution only) |
| **Outputs** | `DesignSummaryView`, deferred decision labels, formatted copy |
| **Dependencies** | Brief data, BriefEvaluation |
| **Owns** | Summary presentation structure |
| **Must never own** | Approval persistence; generation |

### RevisionIntelligenceCapability — Active

| | |
|---|---|
| **Responsibility** | Compare previous vs updated brief; describe downstream impact |
| **Inputs** | Two brief snapshots |
| **Outputs** | `RevisionImpact` |
| **Dependencies** | `shared/product-rule-packs`, `shared/brief-diff`, `shared/concept-relevance` |
| **Owns** | Changed sections, affected rule packs, reevaluation/summary/concept flags |
| **Must never own** | Mutating the brief; deciding whether to ask or regenerate |

Distinct from **RevisionCapability** (reserved artwork-level lifecycle stub).

### RevisionCapability — Reserved

Stub only (`classifyRevisionRequest` → `unclassified`; `forkBriefFromApproved` → `null`; `listRevisions` → `[]`).
Post-approval conversational revisions today flow through Intent Extraction →
DesignBrief + RevisionIntelligence, not this capability.

### RevisionTimelineCapability — Active (regeneration path only, Sprint 2J Phase 3)

| | |
|---|---|
| **Responsibility** | Derive an ordered, ephemeral revision timeline from existing immutable records |
| **Inputs** | `DesignBriefVersion[]`, `GenerationJob[]`, `ArtworkVersion[]` (Concept Evaluations live on these rows), caller-supplied `TimedRevisionImpact[]` |
| **Outputs** | `RevisionTimeline` — chronological domain events with plain-language labels |
| **Dependencies** | `shared/question-phrasing` (section titles for labels only) |
| **Owns** | Deterministic timeline ordering; GenerationAttempt ordinal via `resolveGenerationAttemptNumber` |
| **Must never own** | Persistence; a `revision_history` table; mutable history; provider/prompt language; regeneration decisions |

Used by `GenerationWorkerCapability` only when `GenerationJob.kind === "regeneration"`.
Always recomputable, never stored. Distinct from the customer-facing chat
`buildRevisionTimeline` helper.

### RegenerationIntelligenceCapability — Active (regeneration path only, Sprint 2J Phase 3)

| | |
|---|---|
| **Responsibility** | Decide what should change in the *next* generation attempt — never generates, never evaluates |
| **Inputs** | Approved `DesignBriefSnapshotContent`; latest Concept Evaluation (or `null`); derived `RevisionTimeline`; GenerationAttempt from GenerationJob |
| **Outputs** | `RegenerationPlan` (ephemeral) |
| **Dependencies** | `shared/concept-relevance`; `lib/domain/required-wording`; RevisionTimeline data shape |
| **Owns** | Deterministic preserve/strengthen/remove/replace/avoid categorization; priority order |
| **Must never own** | Generating artwork; evaluating artwork; mutating the Design Brief; persistence; prompt dialect; a parallel attempt counter |

Composed into the worker for regeneration jobs only. See §13a.

### ConceptGenerationCapability — Active (enqueue-only)

| | |
|---|---|
| **Responsibility** | Approval-gated enqueue of generation jobs; concept status views |
| **Inputs** | Design id + approved brief version id |
| **Outputs** | Snapshot with project status `generating`; `ConceptStatusView` |
| **Dependencies** | ProjectRepository; concept-relevance policy (status) |
| **Owns** | Idempotent job creation; status classification of concept batches; additional exploration batches for an already-generated brief version (`exploreNewConceptBatch`) |
| **Must never own** | Calling providers; uploading assets; claiming jobs; mutating or re-approving the Design Brief |

Does not invoke providers. Workers do.

### PromptTranslationCapability — Active

| | |
|---|---|
| **Responsibility** | `GenerationIntent` → provider-neutral `GenerationPromptRequest` |
| **Inputs** | `GenerationIntent` (approved brief + optional `RegenerationPlan`) |
| **Outputs** | `GenerationPromptRequest` |
| **Dependencies** | GenerationIntent data only |
| **Owns** | Provider-neutral field mapping; plan merge priority when a plan is present |
| **Must never own** | Provider dialect; quality-boosting keywords; I/O; mutating the Design Brief |

`GenerationIntent` is immutable, never persisted, never customer-facing.
Without a `regenerationPlan`, output is byte-for-byte equivalent to the
historical brief-only translator (initial generation regression).

Sprint 2K Phase 3 adds two provider-neutral fields to `GenerationPromptRequest`
(both computed here, not by a provider adapter):

- `inspirationReferences: string[]` — stylistic/era/pop-culture reference
  language (`creative-reference-extraction.ts`, cue phrases like "inspired
  by", "spin off from", "like an old …") is split out of the free-text
  description/style so it is never handed to a provider as literal content.
  A provider adapter must treat these as visual-language guidance only —
  never as an instruction to depict real people, characters, or copyrighted
  material from the referenced work.
- `allowAdditionalText: boolean` — always `false` today; an explicit,
  provider-neutral instruction that generation must not invent wording
  beyond `requiredWording`, rather than an ad hoc prompt hack living inside
  one adapter.

### Initial generation vs targeted revision (True Source-Image Targeted Revision)

Generation has **two distinct modes**. They are different operations, not
two settings of one operation, and nothing in the pipeline may blur them.

```
INITIAL GENERATION  (and explicit "show me alternatives")
  approved brief
    → text-to-image
    → 3 concept directions

TARGETED REVISION  (the default post-selection revision)
  selected source artwork (real image bytes)
  + explicit revision delta
  + preservation contract
    → image edit
    → 1 revised concept
```

The revision contract is:

> **REVISED ARTWORK = SELECTED SOURCE ARTWORK + CUSTOMER'S REQUESTED DELTA**
>
> Preserve everything the customer did not ask to change.

**A targeted revision must never silently degrade to text-to-image.** That
degradation is the specific defect this architecture exists to prevent: it
returns an unrelated reinterpretation of the brief that *looks* like a
successful revision, which is strictly worse than a visible failure. Three
independent guards enforce it:

1. `GenerationWorkerCapability` resolves the source image before calling the
   provider and throws `TargetedRevisionSourceError` if it cannot — the job
   fails, `revisionPending` stays true, and the customer keeps the concept
   they already had.
2. `ConceptGenerationProvider.editsSourceArtwork` declares whether an
   adapter performs a real edit. Any adapter that calls an image model must
   declare `true`. Only the placeholder/unavailable stubs — which produce no
   image bytes at all and are unreachable in a configured production
   environment — declare `false`.
3. An edit-capable adapter independently refuses a targeted revision that
   arrives without source artwork (`ProviderError("invalid_request")`), so
   the guarantee never rests on the worker alone.

#### Where the delta comes from

The Design Brief records design **state** ("the design is a red badge"); it
can never express a **change** ("change it to a shield"). `RegenerationPlan`
knows only which brief *sections* were touched, and its descriptions are
canned section-level sentences. So the delta is carried explicitly:

```
customer message
  → GenerationJob.revisionInstruction   (durable, internal-only column)
  → GenerationIntent.revisionInstruction
  → PromptTranslation
  → GenerationPromptRequest.revision : RevisionDirective
  → image-edit adapter
```

`RevisionDirective` (`lib/domain/types.ts`) is provider-neutral plain
language: `requestedChanges[]` (the distinct changes, so "change the font to
retro and remove the sunset" arrives as **two**), `preserve[]`, `avoid[]`,
`lockedWording`, `wordingChangeRequested`. `RegenerationPlan` remains the
source of truth for preserve/avoid/wording and is the fallback for
`requestedChanges` when there is no literal instruction (the "Generate
Updated Concepts" button path). `shared/revision-delta.ts` owns the split
into discrete changes — generic sentence-shape heuristics only, never
product nouns.

**Required wording protection.** `lockedWording` carries the exact wording
forward unless the customer's own delta is about the wording itself. A
typography change ("change the font to retro") is deliberately *not* a
wording change. An explicit wording change ("change the text to MR2 TURBO")
lifts the lock and becomes part of the requested delta.

#### Where the source pixels come from

```
GenerationJob.targetArtworkVersionId
  → ArtworkVersion (the exact selected concept)
  → ArtworkVersion.primaryAssetId
  → AssetCapability.downloadAssetBytes
  → ConceptGenerationRequest.sourceArtwork : SourceArtworkImage
```

`SourceArtworkImage` is raw bytes + content type + provenance id — never an
`ArtworkVersion`, an `AssetRecord`, a storage key, or a signed URL. This
mirrors the OUTPUT side (`GeneratedAssetPayload`) exactly: resolving storage
is `AssetCapability`'s job, never a provider adapter's.

#### Lineage

A targeted revision produces exactly **one** new `ArtworkVersion`, retaining
`sourceArtworkVersionId` (the exact selected source) and
`conceptDirectionKey` (the same direction lineage). Prior concepts are never
replaced or deleted (Constitution §6.11).

#### Where the customer lands afterwards

The two modes also end in different conversation phases, because they ask
the customer for different things:

| Finished job | Conversation phase | Why |
|---|---|---|
| Initial generation, or explicit "show me alternatives" | `concepts_ready` | Three directions are waiting to be chosen between; chat is deliberately blocked in favour of choosing |
| Targeted revision (success **or** failure) | `ask_revisions` | There is nothing to choose between — the single revised concept is auto-selected — and the customer needs to either describe another change or confirm this one |

Leaving a finished targeted revision in `concepts_ready` is what produced
the live "chat looks stuck" failure: the assistant asked "how does this
version look?" while `CHAT_BLOCKED_PHASES` refused the answer server-side
and the Use This Design action (gated on the revision loop) never
appeared. The failure path needs `ask_revisions` for the same reason — its
message invites the customer to try the change again.

The completion **message** keeps `metadata.phase: "concepts_ready"` in
both cases: that marks the "here is artwork" anchor the concept grid
renders against, which is a property of the event rather than of the phase
the conversation moves into next.

Auto-selecting the revised concept never confirms it —
`finalDirectionConfirmed` stays `false`, so Prepare Print-Ready Artwork
remains unavailable until the customer explicitly says Use This Design.

### Concept-direction differentiation (Sprint 2K Phase 3)

`lib/domain/concept-directions.ts` is the single, provider-neutral catalog
for how the three concepts a customer sees differ from one another (Bold &
Direct / Soft & Illustrated / Minimal Badge) — composition, typography
emphasis, illustration density, iconography, layout, and visual hierarchy,
each described in plain language, never provider dialect. It also owns
`describeConceptDirection`, the one function that builds a concept's
customer-facing title/summary — truthful to the actual creative direction
sent to the provider (Constitution §13: "options for human review", never a
fabricated pixel-level claim).

Both `PlaceholderConceptProvider` (via `lib/domain/concepts.ts`) and
`OpenAIConceptGenerationProvider` consume this one catalog instead of each
maintaining its own copy. A provider adapter still owns 100% of its own
prompt dialect/keyword phrasing when turning a direction's plain-language
fields into an actual request — the catalog supplies content, never syntax.

Because the catalog is a pure function of `GenerationPromptRequest` only —
independent of the approved brief and of any `RegenerationPlan` — the three
directions are applied identically on every generation attempt. Concept
differentiation therefore survives regeneration automatically; no separate
regeneration-specific direction logic exists or is needed.

**Detailed-Description Fidelity (Phase 1) refinement.** A direction's fields
are now its treatment for a single simple required subject; `sceneTreatment`
and `customerComposedTreatment` state the same creative angle for content
that requires several elements or that the customer has already positioned.
`resolveDirectionTreatment(direction, contract)` is the one place they are
resolved, against `DesignContentContract` (§13f). A direction may change how
densely and how simply content is drawn; it may never remove required
subject matter or assert a placement the customer already decided.

### GenerationWorkerCapability — Active

| | |
|---|---|
| **Responsibility** | Claim job → build GenerationIntent → translate → resolve source artwork (targeted revision only) → provider → assets → concept evaluation → artwork → assistant message |
| **Inputs** | Claimed `GenerationJob` |
| **Outputs** | Completed/failed job; artwork versions (with evaluation); assets; customer-safe messages |
| **Dependencies** | ProjectRepository, PromptTranslation, ConceptGenerationProvider, AssetCapability, ConceptEvaluationCapability, RevisionIntelligence (regeneration path), RevisionTimeline + RegenerationIntelligence (via `buildGenerationIntentForJob`) |
| **Owns** | Generation runtime business logic; initial vs regeneration intent assembly; resolving the source artwork bytes for a targeted revision |
| **Must never own** | HTTP auth, cron scheduling, browser lifecycle; persisting timeline/plan/intent; provider dialect |

Evaluation failure never discards concepts and never changes customer-facing
copy in Phase 1.

For a targeted revision against an edit-capable provider, the worker resolves
the selected concept's real image bytes through `AssetCapability` and passes
them as `ConceptGenerationRequest.sourceArtwork`. Failure to do so throws
`TargetedRevisionSourceError` and fails the job — there is deliberately no
text-to-image fallback. See "Initial generation vs targeted revision".

### ConceptEvaluationCapability — Active (architecture only)

| | |
|---|---|
| **Responsibility** | Provider-neutral evaluation of whether a generated concept matches the approved Design Brief |
| **Inputs** | Approved `DesignBriefSnapshotContent`, concept presentation fields, opaque asset references |
| **Outputs** | `ConceptEvaluationResult` (scores, criteria, status, warnings) |
| **Dependencies** | `ConceptEvaluationProvider` interface only |
| **Owns** | Request construction, result normalization, failure fallback |
| **Must never own** | Repository writes; brief mutation; customer copy; Print Validation; vendor APIs |

Answers (product quality):

- Did the concept follow the Design Brief?
- Did it respect exclusions?
- Is required wording present?
- Does requested style / color palette / composition appear?
- Should the customer see this concept? *(Phase 1 always says yes — results are persisted only.)*

Does **not** answer: DPI, transparency, vector quality, print size, embroidery
limits, raster quality — those belong exclusively to PrintValidationCapability.

Provider model (mirrors generation):

```
ConceptEvaluationCapability
       ↓
ConceptEvaluationProvider
       ↓
Provider adapters (placeholder today; vision/OCR later)
```

Default adapter: `PlaceholderConceptEvaluationProvider` — deterministic
`needs_review` with every criterion marked `not_assessed`. No vision, OCR,
or color analysis.

Sprint 2I Phase 2 adds the first real adapter,
`OpenAIConceptEvaluationProvider` — a vision-capable chat model scores a
generated concept's image against the requirements actually present on the
approved brief snapshot. Composition resolves between the two via
`resolveConceptEvaluationProvider` / `getConceptEvaluationConfig`
(`CONCEPT_EVALUATION_PROVIDER=placeholder|openai`, default `placeholder`).
See §13 for the full evaluation contract and §21 for configuration.

### GenerationSchedulerCapability — Active

| | |
|---|---|
| **Responsibility** | Recover abandoned jobs; run a bounded batch of worker claims |
| **Inputs** | Config (`MAX_GENERATION_JOBS_PER_RUN`, heartbeat interval) |
| **Outputs** | Batch execution side effects via worker |
| **Dependencies** | GenerationWorkerCapability |
| **Owns** | When/how many times to call the worker |
| **Must never own** | Provider/storage details; customer routes |

### AssetCapability — Active

| | |
|---|---|
| **Responsibility** | Persist asset metadata; upload concept images; signed URLs; cleanup |
| **Inputs** | Image bytes + metadata |
| **Outputs** | `AssetRecord` pairs (primary + optional thumbnail) |
| **Dependencies** | ProjectRepository, AssetStorageProvider, ThumbnailGenerator |
| **Owns** | Asset lifecycle boundary |
| **Must never own** | Provider prompt dialect; brief mutation |

### AssetStorageProvider — Partial

Port + implementations:

| Mode | Implementation | Production-safe? |
|---|---|---|
| `data_uri` | `DataUriAssetStorageProvider` | No |
| `filesystem` | `FilesystemAssetStorageProvider` | No |
| `supabase_storage` | `SupabaseStorageAssetProvider` | Yes |
| `s3` | Reserved (`UnimplementedAssetStorageProvider` throws) | Marked safe in config only; adapter not implemented |

### Provider adapters — Active / gated

| Adapter | Role |
|---|---|
| `PlaceholderConceptProvider` | Deterministic placeholder concepts (no real images) |
| `OpenAIConceptGenerationProvider` | Real image bytes via OpenAI Images API — `/v1/images/generations` for initial generation, `/v1/images/edits` for a targeted revision |
| `UnavailableConceptGenerationProvider` | Fail closed with safe error codes |

Resolution: `resolveConceptGenerationProvider` in composition/config layer.

Every `ConceptGenerationProvider` declares `editsSourceArtwork`. `true` means
a targeted revision is performed as a real edit of the supplied source
artwork, and the worker must supply `sourceArtwork` for every targeted
revision (failing the job if it cannot). Any adapter that calls an image
model must declare `true` — see "Initial generation vs targeted revision".

### PrintValidationCapability — Active architecture, wired as provisional intelligence (Sprint 2M Phase 1 + Phase 2A)

Real, deterministic, provider-neutral. Answers "can this artwork be
produced correctly for the intended print application?" — never "did we
generate the design the customer requested?" (Concept Evaluation). A
concept can pass Concept Evaluation and fail Print Validation; this is
documented, expected behavior, not a bug (Constitution §15).

Sprint 2M Phase 2A wires it into `GenerationWorkerCapability`, run
immediately after Concept Evaluation completes for each concept — but only
as **provisional** intelligence about a generated concept, never as
authoritative validation of finished production artwork. See "Provisional
Print Readiness vs. Final Print Validation" below; that distinction is the
entire point of Phase 2A and must not be lost in any future change to this
capability.

```
Concept Generation (provider → asset)
        ↓
ConceptEvaluationCapability.evaluate  (per concept)
        ↓
runProvisionalPrintValidation          (GenerationWorkerCapability, Phase 2A)
        │  assembleProvisionalPrintValidationInput (pure mapping — no I/O)
        ↓
PrintValidationCapability.validateArtwork(PrintValidationInput)
        ↓
PrintValidationReport { ready | finalization_required | blocked }
        │  logged internally only (whitelisted fields; never persisted,
        │  never customer-facing) — see `print-validation-logging.ts`
        ↓
Customer selects / approves a concept direction  (unchanged — still just
concept selection, not "final artwork approval"; see the lifecycle audit)
        ↓
(Reserved, not implemented) Future FinalArtworkCapability /
ProductionArtworkCapability — transforms/upscales/vectorizes/reconstructs
per requiredTransformations, then produces authoritative production
artwork and re-runs Print Validation against *that* — only that later run
may ever justify `PrintProject.status = "print_ready"`
```

| | |
|---|---|
| **Responsibility** | Deterministic production-readiness validation of one concept/artwork |
| **Inputs** | `PrintValidationInput` — artwork/brief-provenance ids, print placement, product text, already-persisted Concept Evaluation state, and an opaque primary-asset summary — all resolved by the caller |
| **Outputs** | `PrintValidationReport` — `status` (`ready` / `finalization_required` / `blocked`), `requirements`, `checks[]`, `requiredTransformations[]`, `blockingIssues[]`, `warnings[]` |
| **Dependencies** | None (pure data in, pure data out) — `production-requirements.ts`, `effective-resolution.ts`, and `shared/print-placement-dimensions.ts` only |
| **Owns** | Deterministic production-category/method classification from already-collected brief text; effective-resolution math (pixel ÷ physical dimensions, never PNG DPI metadata); check/status aggregation |
| **Must never own** | Brief mutation; provider calls (generation, vision, OCR); artwork transformation, upscaling, vectorization, or regeneration; repository I/O |

`createPrintValidationCapability()` still takes zero arguments and
`validateArtwork` is still synchronous — mirrors `BriefEvaluationCapability`,
not `ConceptEvaluationCapability` (which is async only because it calls a
provider), and Phase 2A did not change this. The caller does all I/O
(mirrors `ConceptEvaluationCapability.evaluate`'s `ConceptEvaluationInput`
— "caller resolves data, capability only decides"). As of Phase 2A,
`GenerationWorkerCapability` is that caller — see
`runProvisionalPrintValidation` — but the capability itself remains exactly
as pure as Phase 1 left it: no repository, provider, or storage dependency
was added to `PrintValidationCapability`, `production-requirements.ts`, or
`effective-resolution.ts`. Only the orchestration layer changed.

| Concern | Concept Evaluation | Print Validation |
|---|---|---|
| Brief alignment / exclusions / wording / style / palette | Yes | No (reads Concept Evaluation's already-persisted `required_wording` criterion and `evaluationStatus`, but never re-scores brief alignment itself) |
| DPI / transparency / print size / embroidery / raster / vector | No | Yes |
| Status | Active architecture; results persisted on `ArtworkVersion`; does not block UI | Active architecture; pure/recomputed; run automatically after generation (Phase 2A) but never persisted, never blocks UI, never authoritative |

#### Production Requirements (`ProductionRequirements`)

`production-requirements.ts` deterministically classifies a
`ProductionCategory` (`apparel_raster` / `apparel_vector` / `signage` /
`logo_vector` / `unknown`) from `productSummary`/`designDescription` text
the customer already gave in ordinary conversation — keyword matching only
(apparel nouns reuse `field-normalization.ts`'s `PRODUCT_NOUN_CANONICAL`;
method keywords like "embroidered", "screen print", "banner" are matched
literally). This is never a customer-facing question (Constitution §6.6) —
when the text does not support a confident method, `printMethodConfidence`
is honestly `"unknown"` and a DTF-style raster profile is assumed as the
one production path this product actually generates artwork for today
(never marked `"confirmed"`).

Target physical print dimensions come from `shared/print-placement-dimensions.ts`,
keyed by `PrintPlacement` — and, since the Live Acceptance Cleanup,
overridden by the customer's own chosen production width when they set one
(`TShirtDesignBrief.intendedPrintWidthIn`, threaded in as
`deriveProductionRequirements({ intendedPrintWidthIn })`; see the resolved
audit finding below). The placement table supplies the default and the
printable band (`full_front`/`full_back`: 12×14in;
`left_chest`: 4×4in; `sleeve`: 3×3in — chosen so the sprint's own worked
example, a 1024×1024px concept at a 12×14in full-back target ≈ 85 PPI,
reproduces exactly). Banners/signs use a fixed generic placeholder size
(36×72in) since neither `PrintPlacement` nor the Design Brief currently
capture a customer-specified sign size (see the audit finding below).
Target resolution is 300 PPI for raster apparel methods (matching the
Constitution's own 3600×4200px full-back example exactly) and not
applicable (raster resolution is not the blocking factor) for any
vector-required category.

#### Effective resolution (Goal 7)

`effective-resolution.ts`'s `calculateEffectiveResolution` computes
`pixels ÷ physical target dimensions` only — PNG DPI metadata is never read
or trusted (changing embedded DPI does not add image information).
`minimumRasterDimensionsFor` derives the minimum acceptable pixel size from
a target physical size × target PPI.

#### Checks and status aggregation

Twelve deterministic checks (`PRINT_VALIDATION_CHECK_CODES`): asset
existence, content type, raster dimensions known, transparency, effective
resolution, minimum raster dimensions, vector-source presence, Design Brief
provenance, Concept Evaluation alignment, required-wording verification,
print-location known, production-method known. Two checks
(`asset_exists`, `brief_provenance`) are hard-block: their failure produces
`status: "blocked"` immediately (nothing to finalize) without running the
rest. Every other check is `"blocking"`, `"warning"`, or `"info"` severity;
`status: "ready"` requires every `"blocking"`-severity check to be
`"pass"` — an `"unknown"` check is never silently treated as a pass (Goal
6/10), so it produces `"finalization_required"` exactly like a `"fail"`.

`requiredTransformations` is a set of `FinalizationTransformation` string
values (`regenerate_at_production_dimensions`, `upscale_raster_artwork`,
`remove_background`, `create_vector_version`, `verify_or_recreate_text`,
`convert_fonts_to_outlines`, `resize_to_final_dimensions`,
`create_production_png`, `create_vector_or_pdf_asset`,
`require_human_review`) — described, never executed. No upscaling,
vectorization, SVG/PDF/PNG production, font outlining, embroidery
digitization, or CMYK conversion happens in Phase 1.

#### Provisional Print Readiness vs. Final Print Validation (Sprint 2M Phase 2A)

Four distinct questions, answered at four distinct points in the lifecycle
— conflating any two of them is the specific mistake Phase 2A exists to
avoid:

| Stage | Question | Capability | Status today |
|---|---|---|---|
| **Concept Evaluation** | Is this generated concept an acceptable design — does it match the approved Design Brief? | `ConceptEvaluationCapability` | Active; persisted on `ArtworkVersion.evaluationStatus`/`evaluation` |
| **Provisional Print Readiness** | If we tried to produce *this generated concept* right now, what production work would be required? | `PrintValidationCapability`, run by `GenerationWorkerCapability` immediately after Concept Evaluation | Active (Phase 2A); computed and logged internally only; **never persisted, never authoritative** |
| **Final Artwork / Production Artwork** *(not implemented)* | The customer has confirmed a design direction — produce the actual production-ready asset (upscale, vectorize, outline fonts, etc.) | Reserved `FinalArtworkCapability`/`ProductionArtworkCapability` | Not implemented — see §25 |
| **Final Print Validation** *(not implemented)* | Is the *resulting production asset* actually print-ready? | Same `PrintValidationCapability`, re-run against the production asset once one exists | Not implemented — only this later run may ever justify `PrintProject.status = "print_ready"` |

Provisional Print Readiness reuses the exact same `PrintValidationCapability`
and `PrintValidationReport` shape a future Final Print Validation run would
use — there is no second, parallel "provisional" contract. What makes a run
provisional vs. authoritative is entirely *what it validates* (an
as-generated ~1024×1024px concept vs. a would-be finished production
asset) and *what happens with the result* (logged only, vs. gating a real
lifecycle transition) — never a different code path. This is why Phase 2A
requires no new types: `PrintValidationReport.status` already means "what
would it take to make *this specific asset* print-ready," which is exactly
as true of a freshly generated concept as it will be of a future production
asset.

Concretely, in Phase 2A:

- A generated concept being `finalization_required` is **expected,
  routine, logged-and-ignored intelligence** — not a failure, not a
  customer-visible state, and not a reason to block concept selection,
  revision, or anything else in the existing flow.
- Nothing transitions `PrintProject.status` to `"finalizing"` or
  `"print_ready"` in Phase 2A. Those remain unused, reserved for whenever
  Final Artwork / Final Print Validation exist.
- Nothing marks an `ArtworkVersion` as "final" — `isSelected` /
  `selectedArtworkVersionId` (concept selection) are unchanged and remain
  the closest existing mechanism to "customer picked a direction," which
  is still not the same thing as "this is the confirmed final artwork" (see
  the Phase 1 lifecycle audit below, unchanged in Phase 2A).
- `requiredTransformations` is **never executed** — Phase 2A only computes
  and logs it as intelligence for a future Final Artwork capability to
  consume.

#### Current concept behavior (Goal 10)

A real ~1024×1024px generated concept intended for a full-back print
(12×14in target, 300 PPI) computes an effective resolution of ≈73–85 PPI —
well under target — and correctly reports `finalization_required` with
`regenerate_at_production_dimensions`/`upscale_raster_artwork` required,
even when Concept Evaluation reports `passed`/`needs_review` for the same
concept. Verified by test at two levels: `print-validation-capability.test.ts`
Scenario A (the pure capability) and
`generation-worker-print-validation.test.ts` (Sprint 2M Phase 2A — the same
scenario driven end-to-end through the real worker pipeline, confirming
`PrintProject.status` and the persisted `ArtworkVersion` are unaffected).

#### Artwork lifecycle audit (Goal 1)

- **Selected concept** (`ArtworkVersion.isSelected`,
  `PrintProject.selectedArtworkVersionId`, written by
  `ConversationCapability.selectConcept`) and **final customer-approved
  artwork direction** are **not currently distinct states**. Selecting a
  concept only transitions the conversation to `ask_revisions`; it does not
  change `PrintProject.status`, freeze the concept, or create any new
  version. `ProjectStatus` reserves `"finalizing"` and `"print_ready"` values
  that are defined but never assigned anywhere in the codebase today — the
  natural (but not yet built) home for a real "customer confirmed this as
  final" state, most likely produced by a future Final Artwork capability
  rather than by Print Validation itself. Per Goal 1, Phase 1 does **not**
  invent this new state — `PrintValidationCapability.validateArtwork`
  accepts any `artworkVersionId`, selected or not, and does not require or
  assume a "final approval" status that does not yet exist.
- `ArtworkVersion.printValidationStatus` (`text null`, no CHECK constraint,
  added in the Sprint 2H Part 1 migration) can represent the
  `PrintValidationReport.status` lifecycle cleanly as-is — no migration is
  needed if/when something starts writing it. **Phase 2A re-audited this
  decision (rather than assuming the Phase 1 report's own suggestion to
  wire persistence in next) and confirmed leaving it `null` is still
  correct, for a sharper reason than Phase 1 had:** the column has exactly
  one name and no documented distinction between "provisional concept-stage
  reading" and "authoritative production-asset reading." If Phase 2A wrote
  a provisional `finalization_required` into it, any future code (or
  operator) reading that column would have no way to tell a provisional
  reading from a future authoritative one without inventing a second
  column or an enum-prefix convention anyway — an ambiguity worth avoiding
  by simply not persisting the provisional signal at all, rather than
  papering over it with a naming convention. Recomputation is cheap here in
  a way it might not be for a genuine production-asset validation
  (`BriefEvaluation`/`ConceptStatusView`/`RevisionImpact` precedent, §18)
  since every input (`ArtworkVersion`, its asset, the approved brief
  snapshot, its Concept Evaluation) is already durably persisted —
  provisional readiness can always be recomputed later from those records
  with zero data loss. `evaluationStatus`/`evaluation` (Concept Evaluation)
  remain the only persisted per-concept fields this pipeline touches;
  `printValidationStatus` stays reserved `null`. If a future phase
  concludes persistence is genuinely required (e.g. to filter/query
  provisional readiness at scale), it should introduce a distinctly named
  column or an explicit `{ stage: "provisional" | "final", status }` shape
  — never silently overload this one.
- **Resolved — Live Acceptance Cleanup (Issue 5).**
  `TShirtDesignBrief.intendedPrintWidthIn` is now the authoritative,
  persisted owner of customer-chosen production print WIDTH. It is written
  only by `DesignBriefCapability.setIntendedPrintWidth`, driven by
  `ConversationCapability.setProductionPrintWidth` (the "Change Size"
  action, or a natural-language request at the final-direction stage), and
  read by `FinalArtworkWorkerCapability` at run time.

  It remains deliberately **excluded** from `DesignBriefSnapshotContent` and
  from `diffBriefSections`, and that exclusion is load-bearing rather than
  an oversight: physical size is a **production specification**, not creative
  content. Because it is not versioned brief content, choosing a size can
  never approve a new brief version, mark concepts stale, supersede a final
  direction, create an `ArtworkVersion`, or reach an image provider —
  exactly the separation the Constitution requires between "the approved
  design" and "how it is manufactured". Size is read from the *working*
  brief, not the frozen snapshot, for the same reason.

  Bounds, defaults, and clamping live in `shared/print-placement-dimensions.ts`
  (`defaultWidthIn` / `minWidthIn` / `maxWidthIn` per placement, resolved by
  `resolveProductionWidth`), so there is exactly one definition of what a
  placement can physically print. `sizingPolicyForPlacement(placement,
  requestedWidthIn)` applies the choice; every downstream consumer
  (`deriveProductionRequirements` → `ProductionRequirements.sizing` →
  `normalizeProductionRaster`) already flowed from that policy, so the
  300-PPI guarantee holds at any chosen width by construction (output pixels
  are `targetWidthIn x targetPpi`; 12in → 3600px).

  No size parameter exists anywhere on the finalize request path, so a stale
  or forged request cannot override the persisted intent, and nothing is ever
  inferred from whatever pixel dimensions a generator happened to produce.
- **Sprint 2M Phase 2A:** `GenerationWorkerCapability` now calls
  `PrintValidationCapability` — via `runProvisionalPrintValidation`,
  immediately after Concept Evaluation completes for each concept, on both
  the fresh-generation path and the idempotent `alreadyGenerated`
  evaluation-backfill path. No route or any other capability calls it. The
  call is wrapped so any failure inside it (including the internal
  `repo.getLatestDesignBriefVersion` provenance lookup) is caught and
  logged, never rethrown — a Print Validation problem can never fail, retry,
  or alter a concept-generation job (Goal 9). Still introduces zero
  customer-visible behavior change: the result is logged (whitelisted
  fields only — see `print-validation-logging.ts`) and otherwise discarded.

### FinalArtworkCapability — Active (approval + enqueue + retry revival; production execution lives in FinalArtworkWorkerCapability, Sprint 2M Phase 2C)

The lifecycle boundary Phase 2A's report explicitly reserved: the sole
owner of the customer's explicit, durable **Final Direction Approval** —
"yes, this is the artwork I want finalized for production" — and of the
resulting `FinalArtworkJob` request. Distinct from concept *selection*
(`ArtworkVersion.isSelected` / `PrintProject.selectedArtworkVersionId`,
still owned by `ConversationCapability.selectConcept`), which only ever
means "I want to work with this direction" and may still be revised freely.

```
Customer selects a concept (unchanged)
        ↓
Revision / regeneration [optional, repeatable — unchanged]
        ↓
Customer's EXPLICIT "Prepare Print-Ready Artwork" action
        ↓
ConversationCapability.approveFinalDirection(designId, artworkVersionId)
        ↓
FinalArtworkCapability.requestFinalArtwork
        │  validates artworkVersionId belongs to this project, is the
        │  current (latest-batch) concept, is the project's currently
        │  selected concept, and is not stale relative to the working brief
        ↓
FinalDirectionApproval (new, durable, append-only; "active")
        ↓
FinalArtworkJob (new, durable; "queued" — Phase 2B never claims/runs it)
        ↓
PrintProject.status = "finalizing"
        ↓
FinalArtworkWorkerCapability claims the job (Sprint 2M Phase 2C — see §13c
for the full pipeline), performs the chosen honest raster transformation,
produces a production AssetRecord, and re-runs PrintValidationCapability
against that real asset — only THAT later, authoritative run may ever
justify PrintProject.status = "print_ready"
```

| | |
|---|---|
| **Responsibility** | Persist the customer's explicit final-direction decision; idempotently enqueue the resulting production-finalization request; revive a failed job on retry |
| **Inputs** | `designId` + an exact `artworkVersionId`, already decided by the caller |
| **Outputs** | `FinalDirectionApproval`, `FinalArtworkJob`, `PrintProject.status = "finalizing"` |
| **Dependencies** | `ProjectRepository`; `shared/brief-diff` + `shared/concept-relevance` (the same staleness check `ConceptGenerationCapability.describeConceptStatus` uses, reused as pure data rather than a capability→capability dependency) |
| **Owns** | `FinalDirectionApproval` lifecycle (create/supersede/query); `FinalArtworkJob` idempotent enqueue + failed-job retry revival; cross-project/staleness/selection validation; resolving the current print-ready production asset id (`getCurrentProductionAssetId`, Goal 14) |
| **Must never own** | Selecting concepts; interpreting conversation; deciding customer intent (the caller already decided — this capability only validates and persists); evaluating creative quality; performing Print Validation internally by duplicating its rules; marking artwork print-ready without a real, authoritative validation run against a real production asset (that authority lives in `FinalArtworkWorkerCapability`) |

`requestFinalArtwork` still only ever produces/reuses a `FinalArtworkJob` —
it never performs production transformation itself. See §13b for the
approval-lifecycle design rationale and §13c for what now actually claims
and runs the job.

### FinalArtworkWorkerCapability — Active (Sprint 2M Phase 2C; Topaz reconstruction integrated Sprint 2M Phase 2E)

| | |
|---|---|
| **Responsibility** | Claim `FinalArtworkJob` → resolve exact approved input → source eligibility gate → raster transformation/reconstruction → production asset → independent production verification → authoritative Print Validation → print-ready transition |
| **Inputs** | Claimed `FinalArtworkJob` |
| **Outputs** | Production `AssetRecord`, `ProductionAssetValidation`, updated job status (incl. paid-call idempotency triple), `PrintProject.status` (`print_ready` / `finalization_required`) |
| **Dependencies** | `ProjectRepository`, `AssetCapability`, `FinalArtworkProvider`, `PrintValidationCapability`, `ConceptEvaluationCapability` (Sprint 2M Phase 2E — independent production wording/fidelity re-verification only; see §13d) |
| **Owns** | Final-artwork worker business logic; idempotent asset reuse; paid-call idempotency (Sprint 2M Phase 2E); stale-job recovery; the sole authority for `PrintProject.status = "print_ready"` |
| **Must never own** | HTTP auth, cron scheduling, browser lifecycle; selecting concepts; duplicating `PrintValidationCapability`'s rules; persisting timeline/plan/intent-style ephemeral state; re-scoring a source concept's own Concept Evaluation (only re-verifies the production asset, and only when the provider cannot declare `preservesApprovedContent: true`) |

See §13c for the Phase 2C pipeline and the "Upscaling Truthfulness" honesty
mechanism, and §13d for Sprint 2M Phase 2E's Topaz reconstruction
integration — provider resolution, paid-call idempotency, source
eligibility, independent production verification, and reconstruction
provenance.

### PrintVaultCapability — Reserved

Stub: `canIngest` → `false`; `listFamily` → `[]`.

### OwnershipCapability — Reserved

Stub: default `"customer_owned"`; `getOwnership` → `null`; lists ownership
classes from the Constitution. No licensing enforcement yet.

### Shared policy / contract modules — Active

Not capabilities; pure data/phrasing imported by multiple capabilities:

- `shared/contracts.ts` — cross-capability DTOs
- `shared/capability-boundaries.ts` — documented dependency rules
- `shared/interview-coverage-policy.ts`
- `shared/product-rule-packs.ts`
- `shared/concept-relevance.ts`
- `shared/brief-diff.ts`
- `shared/question-phrasing.ts`
- `shared/generation-retry-policy.ts`
- `shared/retry.ts`
- `shared/field-normalization.ts` (Sprint 2K Phase 3) — deterministic
  product/color/print-location display normalization applied where a
  Design Brief field is written; required wording is never touched by it
- `shared/chat-input-policy.ts` — the single rule for when free-text chat
  is the expected interaction (`CHAT_BLOCKED_PHASES`,
  `REVISION_LOOP_PHASES`). Imported by `ConversationCapability`, which
  refuses a message in a blocked phase, AND by the chat UI, which disables
  the composer in exactly the same phases. Deliberately shared: two copies
  drifted apart, and a drifted copy reads to a customer as a broken
  product (an input that throws on send, or a dead input the platform
  would have accepted)
- `lib/domain/concept-directions.ts` (Sprint 2K Phase 3) — provider-neutral
  concept-direction catalog + customer-facing description builder, shared
  by every `ConceptGenerationProvider` adapter (domain module, not
  `capabilities/shared`, matching the existing `lib/domain/concepts.ts`
  placement and dependency direction)

---

## 6. Capability Dependency Diagram

```
ConversationCapability
    |
    +--> ConversationUnderstandingCapability ---> ConversationUnderstandingProvider (interface)
    +--> IntentExtractionCapability (consumes ConversationUnderstandingResult, type-only)
    +--> DesignBriefCapability ---------> ProjectRepository
    +--> BriefEvaluationCapability
    +--> DesignIntelligenceCapability
    |         |
    |         +--> ProductIntelligenceCapability
    +--> InterviewIntelligenceCapability
    +--> DesignSummaryCapability
    +--> RevisionIntelligenceCapability
    +--> ConceptGenerationCapability ---> ProjectRepository
    +--> FinalArtworkCapability ---------> ProjectRepository (Sprint 2M
              |                            Phase 2B — approveFinalDirection)
              +--> shared/brief-diff
              +--> shared/concept-relevance

GenerationSchedulerCapability
    |
    +--> GenerationWorkerCapability
              |
              +--> buildGenerationIntentForJob
              |         |
              |         +--> RevisionIntelligence (regeneration only)
              |         +--> RevisionTimelineCapability (regeneration only)
              |         +--> RegenerationIntelligenceCapability (regeneration only)
              |         +--> GenerationIntent (ephemeral)
              +--> PromptTranslationCapability.translate(GenerationIntent)
              +--> ConceptGenerationProvider (interface)
              +--> AssetCapability
              |         |
              |         +--> AssetStorageProvider
              |         +--> ProjectRepository
              +--> ConceptEvaluationCapability
              |         |
              |         +--> ConceptEvaluationProvider (interface)
              +--> PrintValidationCapability (Sprint 2M Phase 2A —
              |         provisional only; see runProvisionalPrintValidation)
              |         |
              |         +--> assembleProvisionalPrintValidationInput (pure)
              +--> ProjectRepository
                        (Sprint 2M Phase 2B: on regeneration completion,
                        also calls repo.supersedeActiveFinalDirectionApproval
                        directly — never via FinalArtworkCapability, keeping
                        this a repository-only concern, not a new capability
                        dependency)

Shared pure modules (not capabilities):
  interview-coverage-policy, product-rule-packs, concept-relevance,
  question-phrasing, brief-diff, generation-retry-policy,
  print-placement-dimensions
```

### Prohibited reverse dependencies

Do not introduce:

- Conversation → direct brief field writes (must go through DesignBrief)
- BriefEvaluation → Conversation, Interview, Generation, Providers, UI, Print Vault
- BriefEvaluation → recommendations (Design Intelligence’s job)
- RevisionIntelligence → Conversation, persistence, providers, UI, or action decisions
- InterviewIntelligence → Design Brief completeness inspection
- InterviewIntelligence ↔ DesignIntelligence internals (share contracts/phrasing instead)
- Provider adapters → repositories, conversations, or raw Design Briefs
- ConceptEvaluationProvider → customer/conversation/job ids, secrets, repositories
- Concept Evaluation ↔ Print Validation capability dependency (share ArtworkVersion fields only)
- RegenerationIntelligence → generation providers, ConceptGenerationProvider, ConceptEvaluationProvider, persistence, Conversation, or UI
- RegenerationIntelligence re-running or re-scoring Concept Evaluation (consumes its output only)
- RegenerationPlan persistence — plans are always ephemeral and recomputed
- RevisionTimeline persistence / `revision_history` table / mutable RevisionHistory model
- Parallel generationAttempt counters — GenerationJob is authoritative
- Design Brief storage of provider prompt dialect
- Customer-facing exposure of provider keys, job ids, asset ids, evaluation scores, or storage modes
- ProductIntelligence ↔ RevisionIntelligence capability dependency (share `product-rule-packs`)
- PrintValidationCapability gaining a repository, provider, or storage
  dependency (Sprint 2M Phase 2A keeps it pure; `GenerationWorkerCapability`
  does all I/O and calls it, not the other way around)
- Treating a provisional Print Validation result (run against a generated
  concept) as authoritative production validation — persisting it,
  transitioning `PrintProject.status` to `"finalizing"`/`"print_ready"`,
  freezing/marking an `ArtworkVersion` as final, or executing
  `requiredTransformations` from it
- A provisional Print Validation failure/error blocking, retrying, or
  altering a `GenerationJob`'s outcome (must be caught and logged only)
- FinalArtworkCapability selecting concepts, interpreting conversation,
  evaluating creative quality, or deciding customer intent (Sprint 2M
  Phase 2B — the caller already decided; this capability only validates
  and persists an already-explicit decision)
- FinalArtworkCapability depending on ConceptGenerationCapability,
  PrintValidationCapability, a provider, or `AssetCapability` (Phase 2B has
  no production asset to validate or transform yet; it depends on
  `ProjectRepository` and the same shared pure staleness modules
  Concept Generation's own status check uses)
- A `FinalDirectionApproval` or `FinalArtworkJob` row (or its id) reaching
  a customer-facing response — `conversation-service.ts`'s `finalization`
  view carries only a derived `status` string
- Treating `PrintProject.status === "finalizing"` as `"print_ready"`, or
  any code path setting `"print_ready"` without a real, authoritative
  `PrintValidationCapability.validateArtwork` run against a real
  production asset (none can exist in Phase 2B)
- A prior `FinalDirectionApproval` silently continuing to authorize a
  *new* `ArtworkVersion` batch produced by regeneration — the
  regeneration-completion path must supersede it
- Sprint 2M Phase 2E: `FinalArtworkWorkerCapability`'s new
  `ConceptEvaluationCapability` dependency re-scoring or persisting a
  source concept's OWN Concept Evaluation — it is used exclusively to
  independently re-verify a PRODUCTION asset (never `artwork.evaluation`
  itself), and only when the resolved `FinalArtworkProvider` reports
  `preservesApprovedContent: false` (see §13d)
- Sprint 2M Phase 2E: Topaz-specific concepts (request/response shape,
  process ids, model names) leaking past `TopazTransparencyUpscaleProvider`
  into `FinalArtworkWorkerCapability` or any customer-facing surface —
  domain orchestration only ever sees the provider-neutral
  `FinalArtworkProvider` contract
- Sprint 2M Phase 2E: any code path treating a paid provider's HTTP 200 /
  "Completed" status as evidence of print readiness — provider success and
  `PrintValidationCapability.validateArtwork` returning `"ready"` remain
  two entirely separate facts

---

## 7. Composition Root and Dependency Injection

File: `src/capabilities/composition.ts`

- `createCapabilityGraph(repo?)` constructs the full `CapabilityGraph`
- `getCapabilityGraph()` returns a process singleton
- `resetCapabilityGraphForTests()` clears the singleton

Wiring highlights:

1. Repository from `getProjectRepository()` unless injected
2. Asset storage from `resolveAssetStorageProvider()`
3. Concept provider from `resolveConceptGenerationProvider()`
4. Concept evaluation provider (placeholder in Phase 1) wired into `ConceptEvaluationCapability`
5. Thumbnails via `PngThumbnailGenerator`
6. Conversation receives peer capabilities by interface, not by constructing them itself
7. Worker scheduler wraps generation worker; neither is invoked from customer message routes

Routes and `src/lib/services/conversation-service.ts` receive composed
capabilities. They must not construct domain logic or select providers.

Environment-driven selection belongs in:

- `src/lib/config/generation-provider-config.ts`
- `src/lib/config/asset-storage-config.ts`
- `src/lib/config/worker-config.ts`
- `src/capabilities/providers/resolve-concept-provider.ts`
- `src/capabilities/asset-storage/resolve-asset-storage-provider.ts`
- `src/lib/db/index.ts` (local vs Supabase repository)

Environment checks must not be scattered through conversation or UI code.

Test helpers: `resetCapabilityGraphForTests`,
`resetProjectRepositoryForTests`, `drainLocalStoreMutexForTests`, and
`cleanupTempWorkspace` (Windows-safe temp cleanup). Automated tests that
need jobs to complete await `processNextJob` / `runBatch` or the worker
route explicitly — they never auto-trigger. Interactive `next dev` may
kick `workerScheduler.runBatch()` / `finalArtworkScheduler.runBatch()`
in-process after durable enqueue (see `local-generation-trigger.ts` and
`local-final-artwork-trigger.ts`); production remains scheduler/worker
driven.

---

## 8. Domain Model

Primary types live in `src/lib/domain/types.ts`.

### Major entities

| Entity | Role |
|---|---|
| `PrintProject` | Project aggregate root (API often says “project”) |
| `DesignConversation` | Phase + `InterviewStateData` |
| `InterviewStateData` | Pending section, ask counts, dismissed advisories, one-level undo |
| `TShirtDesignBrief` | Mutable working Design Brief |
| `DesignBriefVersion` | Immutable approved snapshot (`content` + version metadata) |
| `GenerationJob` | Durable generation attempt (internal; not in customer snapshot) |
| `ArtworkVersion` | Concept (or future revision/final) with brief/job/asset/evaluation provenance (internal) |
| `CustomerArtworkVersion` | Customer-safe projection of `ArtworkVersion` (Sprint 2K Phase 1) |
| `AssetRecord` | File metadata + opaque `storageKey` (internal; not in snapshot) |
| `ConceptEvaluation` | Provider-neutral brief-alignment evaluation payload on an artwork version |
| `RevisionImpact` | Capability contract describing brief-change consequences |
| `BriefEvaluation` | Objective evaluation of the working brief |
| `IntelligenceAssessment` | Recommendations + readiness derived for interview |
| `ProjectSnapshot` | Internal aggregate: project, brief, conversation, messages, artwork, brief versions |
| `ApiProjectSnapshot` | Customer/API aggregate: same shape with sanitized `CustomerArtworkVersion[]` + a derived `finalization` view |
| `FinalDirectionApproval` | Sprint 2M Phase 2B: durable, append-only "this is my final direction" decision, targeting one exact `ArtworkVersion` (internal; not in snapshot) |
| `FinalArtworkJob` | Sprint 2M Phase 2B: idempotent production-finalization request keyed 1:1 to one approval (internal; not in snapshot; Phase 2B never claims/runs it) |

### Key relationships

- Working brief may change freely before approval
- Approval freezes `DesignBriefSnapshotContent` into a new `DesignBriefVersion`
- Concepts (`ArtworkVersion`) reference `designBriefVersionId`
- Generation jobs reference `designBriefVersionId` and produce artwork/assets
- Assets may reference `generationJobId`; artwork may reference primary/thumbnail asset ids
- Current vs previous concept batches are derived (not a separate table)
- Explicit deferrals live on `brief.deferredSections`
- Required wording is derived/normalized via `src/lib/domain/required-wording.ts`
- One-level undo: `interviewState.lastRevision` stores previous brief snapshot
- Conversation lifecycle: new projects use phase `interviewing`; legacy phases remain readable
- Sprint 2M Phase 2B: a `FinalDirectionApproval` references exactly one
  `artworkVersionId` + the `designBriefVersionId` it was generated against;
  at most one row per project is `"active"`. A `FinalArtworkJob` references
  exactly one `finalDirectionApprovalId` (unique) and denormalizes
  `artworkVersionId` for convenient querying. A future production
  `AssetRecord` will reference `finalArtworkJobId` (reserved, always `null`
  today) — distinct from a concept asset's `generationJobId`.

`ProjectSnapshot` intentionally excludes generation jobs and assets — and,
as of Phase 2B, `FinalDirectionApproval`/`FinalArtworkJob` — so internal
aggregates do not treat those as customer payload. Customer API responses
go further: `conversation-service` is the single sanitization choke point
that maps every `ArtworkVersion` to `CustomerArtworkVersion` and derives a
customer-safe `finalization` status purely from `PrintProject.status`
before leaving the server (see §19).

### Relationship diagram

```
PrintProject
   |
   +-- TShirtDesignBrief (working, mutable)
   +-- DesignBriefVersion* (approved snapshots, append-only)
   +-- DesignConversation
   |      +-- InterviewStateData (pendingSection, askCounts,
   |                             dismissedAdvisories, lastRevision)
   +-- ConversationMessage*
   +-- GenerationJob* (internal)
   |      +-- designBriefVersionId
   +-- ArtworkVersion* (concepts)
   |      +-- designBriefVersionId
   |      +-- generationJobId?
   |      +-- primaryAssetId? / thumbnailAssetId?
   |      +-- evaluationStatus? / evaluation? / evaluationEvaluatedAt?
   |      +-- evaluationProviderKey?
   +-- AssetRecord* (internal)
   |      +-- generationJobId?      (concept-stage asset)
   |      +-- finalArtworkJobId?    (Sprint 2M Phase 2B; reserved,
   |                                 production-stage asset)
   +-- FinalDirectionApproval*      (Sprint 2M Phase 2B; internal;
   |      +-- artworkVersionId       at most one "active" per project)
   |      +-- designBriefVersionId
   +-- FinalArtworkJob*             (Sprint 2M Phase 2B; internal;
          +-- finalDirectionApprovalId (unique)  "queued" only in Phase 2B)
```

### Concept Evaluation state transitions (ArtworkVersion)

Internal workflow states only — never customer-visible product language:

```
(null / pending)
       │
       ▼
  evaluate via ConceptEvaluationProvider
       │
       ├──► passed
       ├──► needs_review   (placeholder / inconclusive / provider failure fallback)
       └──► failed         (concept did not match brief — Phase 2+ gating)
```

Phase 1 always presents concepts to the customer regardless of status.
Evaluation failure falls back to `needs_review` and never discards artwork.

Internal database ids are implementation details. Customer UX must not
expose them as product language.

---

## 9. Design Brief Lifecycle

```
Working Brief
  → Evaluation
  → Design Summary
  → Customer Approval
  → Approved Version (immutable snapshot)
  → Concept Generation (queued job → worker)
  → Customer Review / Revision
  → Updated Working Brief
  → New Approval Version (when customer re-approves / regenerates path requires approval)
  → New Concept Batch (prior batches preserved)
```

Clarifications:

- The working brief may change before approval
- Approved versions are preserved; later approvals create new versions
- Concepts reference the approved version that produced them
- Revisions do not mutate prior approved versions
- Regeneration creates a new concept batch; prior concepts remain
- Explicit approval gate lives in ConceptGenerationCapability (approved
  version must exist and belong to the project)
- Approval and enqueue are idempotent: repeat approval/generate for the
  same version does not duplicate versions or concepts
- Approval and enqueue are also retry-*completing*, not just
  retry-tolerant: an approved version with no concepts and no
  `GenerationJob` means an earlier attempt failed between the two writes,
  so pressing Approve again enqueues exactly one job rather than returning
  a snapshot as if generation were already underway. The customer-facing
  "generating" acknowledgement is written only after the job is durable —
  never by the approval step itself
  (`conversation-capability.ts`'s `approveAndGenerate` /
  `submitDesignBriefDecision`; regression test
  `conversation/approval-enqueue-recovery.test.ts`)
- Loading a project repairs that state too, because the customer has no
  way to ask for it: once the phase moves past
  `awaiting_summary_confirmation` the Design Summary's Approve control is
  no longer rendered, and a project that never reached `generating` is
  polled by nothing.
  `ConversationCapability.recoverInterruptedGenerationRequest` (awaited by
  `getConversation`) is therefore the one read path permitted to write, and
  only in the provably-stranded shape: approved brief, zero concepts, and
  **zero generation jobs in any state**. Keying off "no job at all" rather
  than "no active job" is what stops a job that already failed and
  exhausted its retry budget from restarting generation on every page load.
  This is not system-initiated generation — the customer already approved;
  the platform is completing a request it dropped (see §Constitution
  alignment on speculative regeneration)
- The same repair covers the identical window one step later, on revision:
  `triggerAutomaticRevision` writes `PrintProject.revisionPending` (and
  supersedes any active final-direction approval) before the regeneration
  job exists, and only real revised artwork ever clears that flag — so a
  failure in between bars finalization permanently with nothing running to
  lift the bar. The revision arm requires a pending revision, a source
  concept, and an approved brief version with **neither artwork nor a
  generation job in any state**, then re-requests exactly that revision.
  `revisionPending` is never cleared by the repair; a failed regeneration
  keeps it true, because the customer's revision genuinely has not
  happened. Correspondingly, the revision acknowledgement no longer claims
  "I'm updating the concept now" on the enqueue path — that claim comes
  from the enqueue announcement, after the job is durable
  (regression test `conversation/revision-enqueue-recovery.test.ts`)

---

## 10. Adaptive Interview Architecture

Policy: `src/capabilities/shared/interview-coverage-policy.ts`

Sprint 2L Phase 1B re-scoped this table — see §10b "Brief Completeness vs.
Generation Readiness" for the full rationale (Goal-directed orchestration:
question necessity, not schema completeness):

| Tier | Sections | Deferrable? | Proactively asked? |
|---|---|---|---|
| Required (blocking) | product, graphics, requiredWording, productColor | No | Yes, until resolved |
| High-value (ask-worthy) | printLocation | Yes | Yes, until resolved or deferred |
| Optional (delegable) | purpose, audience, style, colors, references, exclusions, additionalNotes, production, layoutPreference | Yes | Never |

Notes:

- `production` and `layoutPreference` are reserved in policy (not fully
  backed by extraction/rules yet)
- Pending question lives in `interviewState.pendingSection`
- Intent extraction proposes patches and detects deferrals/corrections
- Ambiguities and contradictions come from Brief Evaluation; Interview
  Intelligence turns them into `clarify` acts
- One primary question/act at a time
- Deterministic next-act priority (contradictions → required → advisories →
  high-value → summarize)
- Ask counts and dismissed advisories prevent repeated questions/advice
- Transition to Design Summary via `summarize` act when ready
- Legacy fixed-phase ladder remains readable for historical rows; new
  projects use `interviewing`

Numeric confidence (0–100 and section confidence enums) is internal and
not shown to customers.

---

## 10a. Conversation Understanding (Sprint 2L Phase 1)

### Why

The pre-Sprint-2L interview understood customer language field-by-field
through pattern matching (`extraction.ts`'s `extractAdaptive`). That
engine had grown increasingly capable but remained fundamentally a
regex/heuristic system: a natural, run-on customer message ("I'm in a
bowling league and our team is called My 3 Sons help me create a design
for team t-shirts") could still be misread or only partially understood,
producing repeated or out-of-order questions about facts the customer had
already established. Sprint 2L introduces a provider-neutral semantic
interpretation layer ahead of Intent Extraction, while keeping the
deterministic engine as the safety net that makes the product work with
zero configuration and degrade safely under any provider failure.

### Pipeline placement

```
Customer message
      ↓
ConversationCapability builds a bounded, sanitized request
      ↓
ConversationUnderstandingCapability.interpret(request)
      │
      ├─ skip policy: single-token replies never call the provider
      │  (deterministic extraction already resolves these confidently
      │  and cheaply — see "Latency policy" below)
      ↓
ConversationUnderstandingProvider (none | openai)
      ↓
ConversationUnderstandingResult (defensively validated/clamped —
  unsupported sections, invalid confidence values, and oversized
  fields are dropped before this result is used for anything)
      ↓
IntentExtractionCapability.extract({ ..., understanding })
      │
      ├─ reconcile-understanding.ts validates + normalizes the semantic
      │  proposal into the SAME BriefFieldPatch shape extractAdaptive
      │  produces (reusing field-normalization.ts, appendNote,
      │  isDeferrable, PrintPlacement parsing — never a second,
      │  competing normalization path)
      ├─ extractAdaptive (deterministic, unchanged) always also runs
      ├─ merge, per Design Brief field: a validated understanding value
      │  wins when present; extractAdaptive fills every field
      │  understanding left unresolved; extractAdaptive alone is
      │  authoritative when `understanding` is null/absent
      ↓
Exactly one BriefPatchProposal
      ↓
DesignBriefCapability.applyProposal (unchanged)
      ↓
BriefEvaluation → DesignIntelligence → InterviewIntelligence → next act
```

Only one capability (`IntentExtractionCapability`) ever produces a
`BriefPatchProposal`. `ConversationUnderstandingCapability` never mutates
the brief and never calls `DesignBriefCapability` — see
`capability-boundaries.ts` for the full forbidden-dependency list. This
answers the sprint's design question directly: Conversation Understanding
does not compete with Intent Extraction or bolt on as a second brief-writer
— it is a structured *input* Intent Extraction reconciles, exactly like it
already reconciles corrections vs. provided values.

### Precedence (authoritative order)

1. Skip the provider entirely for a single-token reply (Goal 12) — the
   deterministic pending-section fallback and color/product vocabularies
   already resolve these.
2. Otherwise, call the provider once. Any failure (timeout, network,
   malformed JSON, non-2xx) is caught inside
   `ConversationUnderstandingCapability` and degrades to an empty result —
   the caller never sees a distinction between "skipped" and "failed."
3. Defensively validate/clamp the result: unsupported sections, invalid
   confidence enum values, non-string values, and oversized
   lists/strings are dropped before reconciliation ever sees them.
4. `reconcile-understanding.ts` rejects any `"ambiguous"`-confidence
   proposal outright — it is never applied to a field. This is the
   concrete mechanism behind "ask when uncertainty is real": the section
   stays "unknown" in Brief Evaluation and Interview Intelligence asks
   about it exactly as if nothing had been said.
5. Grounding is field-specific, not one universal rule (Sprint 2L Phase 1A
   — see "Field-specific grounding policy" below): required wording is
   grounded by exact evidence containment; product is grounded by exact
   containment OR a recognized product-noun synonym; every other field has
   no additional grounding check beyond "not ambiguous confidence."
6. Every accepted value is normalized exactly the way a direct customer
   answer would be — `normalizeProductAnswer`, `normalizeColorAnswer`,
   `appendNote`, `PrintPlacement` text parsing. Conversation Understanding
   never bypasses deterministic normalization.
7. Deferrals are only ever honored for a deferrable section
   (`isDeferrable`) — a provider proposing a deferral for a required
   section is silently rejected.
8. Per Design Brief field, in the final merge: a validated understanding
   value overrides the deterministic one; every field understanding did
   not resolve keeps its deterministic value; `deferredSections` is a
   *union* of both sources (never a per-key override) so a section
   deferred by either is never silently un-deferred by the other.
9. `BriefEvaluation` → `InterviewIntelligence` then run, unchanged, against
   the single merged brief — this is what makes "don't re-ask a resolved
   field" fall out of the existing architecture rather than requiring new
   interview logic.

### Field-specific grounding policy (Sprint 2L Phase 1A)

A live acceptance test found that a customer message embedding a product
mention inside a longer, run-on sentence ("...help me create a design for
team t-shirts") could still leave Product unresolved even though
Required Wording, Audience, and Purpose all resolved correctly from the
same message. Root cause: `openai-conversation-understanding-provider.ts`'s
prompt gave detailed, worked instructions for `requiredWording` but none
for `product`, so a conservative model under-proposed or omitted embedded
product mentions. Fixed at the prompt layer (general guidance + worked
examples covering multiple domains, not one entity) — see the provider
file's `buildMessages`.

While auditing that path, grounding itself turned out to need one rule per
field shape rather than one universal rule, since `product` and
`requiredWording` have fundamentally different correctness requirements:

| Field | Grounding rule | Why |
|---|---|---|
| `requiredWording` | Exact (normalized) containment of `value` in `evidence` only | The literal print text must never be paraphrased, re-spelled, or invented — Constitution §6.12 |
| `product` | Exact containment **OR** `evidence` contains a recognized product-noun synonym (`PRODUCT_NOUN_CANONICAL`, `shared/field-normalization.ts`) that canonicalizes to the same value | Product is a *canonicalized* field — "team t-shirts" must be able to ground a proposed "T-shirt" even though the word "T-shirt" never appears verbatim. A synonym match still requires the synonym's own canonical form to agree with the proposed value, so "team t-shirts" evidence can never ground a proposed "Hoodie" |
| Every other field | No additional check beyond "not ambiguous confidence" | Free-text fields with no fixed canonical vocabulary to check against; normalization (below) already keeps their shape consistent with a direct answer |

Implemented in `reconcile-understanding.ts` (`productIsGrounded` /
`requiredWordingIsGrounded`) — never in the provider adapter, which stays a
thin, replaceable prompt/parsing layer.

### Debugging / structured tracing (Sprint 2L Phase 1A)

`CONVERSATION_UNDERSTANDING_DEBUG=true` (development-only; unset/false in
every environment by default, including production) enables structured,
allowlisted console tracing of exactly where a field was gained or lost
across the pipeline:

```
Composition root construction
  → config              (Sprint 2L Phase 1C: configured provider env value,
                         resolved mode "openai"|"none", model, debugEnabled —
                         proves whether CONVERSATION_UNDERSTANDING_PROVIDER
                         is actually in effect for this server process)

Customer message
  → request            (pendingSection, unresolvedSections, message word
                         count, willCallProvider: false when the single-
                         token skip policy applies this turn)
  → provider_result    (proposed sections + confidence category, deferrals,
                         ambiguities, customerIntent, failed: boolean)
  → reconciled          (accepted section names; rejected section names +
                         a short rejection code, e.g. "product_not_grounded",
                         "ambiguous_confidence", "wording_not_grounded")
  → deterministic_extraction  (extractAdaptive's own field keys + intents)
  → merged_patch        (final BriefPatchProposal field keys)
  → brief_updated        (resolved section list per Brief Evaluation)
  → next_act             (chosen act type + section + pending section)
```

The `config` event fires from `resolveConversationUnderstandingProvider`,
which `getCapabilityGraph()`'s singleton typically calls once per server
process — so a debugging session that never sees it at all is itself
diagnostic (the composition root was already constructed, e.g. by an
earlier request, before `CONVERSATION_UNDERSTANDING_DEBUG` was set; a full
dev-server restart is required after changing either env var, since
Next.js loads `.env.local` at process startup and the singleton persists
across Fast Refresh).

Implemented in `lib/debug/conversation-understanding-trace.ts` /
`lib/config/conversation-understanding-debug.ts`. The event union itself
*is* the allowlist enforcement — it has no field for an API key, a full
prompt, a raw provider response, chain-of-thought, unrelated conversation
history, or a signed URL, so none of those can be passed through it
regardless of what a caller has in scope. Every value logged is a section
name, a coarse confidence/intent category, a short rejection code, an act
type, or a count — never customer free text.

### Explicit vs. inferred vs. unknown vs. deferred

Encoded directly in the contract rather than as a second, competing
provenance system:

| Customer language shape | Contract representation | Brief effect |
|---|---|---|
| Direct statement ("our team is called My 3 Sons") | `proposedUpdates[].confidence: "explicit"` | Applied |
| Strongly implied by context ("I'm in a bowling league" → audience) | `confidence: "inferred"` | Applied |
| Plausible but uncertain ("Make something cool for My 3 Sons") | `confidence: "ambiguous"`, or an `ambiguities[]` entry | Never applied — section stays genuinely unknown |
| "No preference, you choose" | `deferrals[]` | `brief.deferredSections` (existing mechanism, reused) |
| Nothing said | absent from `proposedUpdates`/`deferrals` | Unaffected — deterministic extraction (or nothing) decides |

No new persisted provenance column was added — `deferredSections` already
existed and is reused as-is; confidence and evidence are proposal-level
(ephemeral) only, never written to the Design Brief.

### Bounded-context strategy

`ConversationUnderstandingRequest` is deliberately small and customer-safe:

- `message` — the current customer message only, capped at 2000 chars.
- `knownBrief` — a `DesignSummaryView` (the same plain-language shape the
  customer sees in a Design Summary) of sections already resolved. No
  brief ids, no timestamps, no internal fields.
- `unresolvedSections` — the short list of still-unknown `BriefSectionKey`
  values.
- `pendingSection` — the one section, if any, the assistant most recently
  asked/clarified.
- `recentTurns` — at most the last 6 messages (~3 customer/assistant
  pairs), each truncated to 300 chars, role + text only — no message ids,
  metadata, or act/section/finding identifiers that live in message
  metadata.

Never sent: storage object keys, signed asset URLs, `GenerationJob`
internals, provider metadata, Concept Evaluation internals, secrets, or
any other project's data. `ConversationUnderstandingResult` itself carries
no numeric confidence, no chain-of-thought/reasoning, and no raw provider
response — the contract has no fields for any of those, so there is
nothing to accidentally leak or persist. `providerMetadata`-style
allowlisting (as Concept Evaluation does) was unnecessary here because the
contract was designed without a metadata field in the first place.

### Latency policy (Goal 12)

- At most one provider call per customer turn — never zero for a
  multi-word reply, never more than one.
- The call is skipped entirely for a single-token reply (deterministic
  extraction already covers these confidently).
- `OpenAIConversationUnderstandingProvider` uses a short (8s default)
  timeout — this happens synchronously inside a customer request, not on
  the ~2-minute image-generation worker path. A slow/unavailable provider
  degrades to the deterministic-only result quickly rather than stalling
  the conversation.
- Text-only chat completion — never an image model.

### Provider resolution

Mirrors `resolveConceptEvaluationProvider`'s asymmetry, not concept
generation's fail-closed behavior: Conversation Understanding is a
best-effort layer over an always-correct deterministic fallback, so a
misconfigured or unavailable `openai` request never fails closed — it
always resolves to `NoneConversationUnderstandingProvider` (an
always-empty-result provider), in every environment including production.
`CONVERSATION_UNDERSTANDING_PROVIDER` is independent of
`CONCEPT_GENERATION_ENABLE_REAL` and of `CONCEPT_GENERATION_PROVIDER` —
image generation and conversational understanding are unrelated
capabilities that happen to both support OpenAI. See §21.

### Deterministic safety net (IntentExtraction)

`extractAdaptive` (`src/capabilities/intent-extraction/extraction.ts`) was
not modified by Sprint 2L Phase 1/1A. It remains:

- the sole interpreter when no provider is configured (the default in
  every environment until intentionally turned on)
- the sole interpreter when a provider call is skipped or fails
- a genuine safety net even when a provider succeeds: any field
  understanding did not confidently resolve still gets whatever
  `extractAdaptive` itself finds

Sprint 2L Phase 1B made one small, general precedence fix inside it (not a
new regex, a reordering of two existing mechanisms): when a customer
message both (a) explicitly names a deferrable section ("colors") and (b)
reads as a generic deferral phrase while a *different* section happens to
be pending, the explicit section mention now wins. This was needed once
`colors`/`purpose`/`audience`/`style` stopped being proactively asked (see
§10b) — a customer volunteering "no preference, choose whatever colors
work best" mid-conversation, while some other question is pending, must
defer colors, not whatever was pending at that moment.

Sprint 2L Phase 1C found and fixed a real corruption in this safety net,
traced from a live acceptance test that (unlike every fixture-driven
regression test up to that point) actually exercised the deterministic-
only path for a punctuation-free run-on message. `ENTITY_NAME_PATTERNS`'
capture groups (`[^.,;!?\n]+`) have nothing to stop at when a sentence has
no internal punctuation, so "our team is called My 3 Sons help me create a
design for team t-shirts" captured everything after "called" —
`boundEntityCapture`/`CLAUSE_BOUNDARY_PATTERN` now terminate the capture
at the first clause-continuation marker ("help", "and I", "we're", "can
you", ...), a general rule (not entity-specific) verified against four
unrelated domains (Rivera Plumbing, Lincoln Elementary, Johnson Family
Reunion, a softball team) — see `intent-extraction-capability.test.ts`.
`BriefEvaluation`'s quality checks (`checkRequiredWordingQuality`,
`checkProductQuality`) already correctly rejected the corrupted raw value
for *readiness* purposes — this fix stops the corruption from being
produced at all, rather than only being caught downstream.

---

## 10b. Brief Completeness vs. Generation Readiness — Goal-Directed
     Orchestration (Sprint 2L Phase 1B)

### Why

A controlled browser acceptance test showed that even with Conversation
Understanding correctly extracting multiple fields per message (Phase
1/1A), the ORCHESTRATOR still behaved like a questionnaire: it walked
every high-value Design Brief section in turn — purpose, audience, style,
artwork colors, print location — asking about (or requiring an explicit
"you choose" deferral for) each one before ever presenting a Design
Summary, and acknowledged every single field mutation with a mechanical
"Got it — I have Black as the shirt color." This happened regardless of
whether the answer would have materially changed the generated artwork.

Root cause (Goal 1 audit): `interview-coverage-policy.ts`'s `"high_value"`
tier previously held five sections (`purpose`, `audience`, `style`,
`colors`, `printLocation`) and `BriefEvaluationCapability.summaryReadiness`
required *every* required-or-high-value section to be either `"provided"`
or explicitly `"deferred_to_designer"` before summary/approval could be
reached. `InterviewIntelligenceCapability.selectNextAct` then walked
`HIGH_VALUE_TIE_BREAK` in order, generating exactly the ask-one-at-a-time
pattern the acceptance test exposed. No single capability was "wrong" in
isolation — `ConversationUnderstandingCapability` correctly proposed
values, `IntentExtractionCapability` correctly reconciled them, `Brief
Evaluation` correctly computed resolution — but the *policy* those
capabilities were built to serve treated schema completeness as the goal,
not artwork-generation readiness.

### Brief Completeness vs. Generation Readiness

Two different, both legitimate questions about the same Design Brief:

| | Brief Completeness | Generation Readiness |
|---|---|---|
| Question | What do we know, section by section? | Do we know enough to generate useful concepts? |
| Computed by | `BriefEvaluation.overall` (`completeness`, `confidence`, `knownSectionCount`) — covers all 14 sections regardless of tier | `BriefEvaluation.summaryReadiness` / `approvalReadiness` — gates only on `required` + `high_value` tier sections |
| Empty optional field | Lowers completeness % | Never blocks |
| Used by | Informational only — no capability gates on it | `InterviewIntelligenceCapability` (whether to ask or summarize); `ConceptGenerationCapability`'s approval gate (via `approvalReadiness`) |

Both views are produced by the *same* `BriefEvaluationCapability` from the
same section list — Generation Readiness is not a new persisted status or
a second evaluation pass, just a different aggregation of the same
per-section data, scoped by `interview-coverage-policy.ts`'s tiers. A
brief can be Generation-Ready while still incomplete (most sections
`"unknown"`) — that is the intended, common case now, not an edge case to
special-case.

### Section categories (Goal 2) and the re-scoped tier policy

`interview-coverage-policy.ts` (`REQUIRED_SECTIONS` / `HIGH_VALUE_SECTIONS`
/ `OPTIONAL_SECTIONS`) re-scoped from three roughly-even tiers to two
sections in `required`, one in `high_value`, and everything else
`optional`:

| Tier | Sections | Rationale (Goal 2 category) |
|---|---|---|
| `required` (blocking) | `product`, `graphics`, `requiredWording`, `productColor` | (A) Generation would likely be wrong or unusable without any one of these — what's being printed, enough direction to know what to design, exact required wording (or explicit "none"), and the garment color the design must read against |
| `high_value` (ask-worthy) | `printLocation` | (B) Contextually important: a physical production fact a print shop cannot safely guess, not a creative preference |
| `optional` (delegable, never proactively asked) | `purpose`, `audience`, `style`, `colors`, plus the pre-existing `exclusions`/`additionalNotes`/`references`/`production`/`layoutPreference` | (C) `purpose`/`audience` are inferable/derivable from context most customers already give ("I'm in a bowling league and our team is called X" already establishes both); (D) `style`/`colors` are designer-delegatable once `graphics` establishes real creative direction |

`questionNecessity(section)` (new, `interview-coverage-policy.ts`) is a
thin, explicitly-named wrapper over `tierOf` — `"blocking"` /
`"askWorthy"` / `"delegable"` — giving call sites and tests a
self-documenting API for the same policy, per Goal 4. No capability
signature changed: `InterviewIntelligenceCapability.selectNextAct` already
only ever walked `REQUIRED_TIE_BREAK` then `HIGH_VALUE_TIE_BREAK` for
proactive `ask`/`clarify` acts and never touched `OPTIONAL_TIE_BREAK` — so
moving four sections into the optional tier was sufficient, on its own, to
stop them from ever being proactively asked, with zero changes to
`BriefEvaluationCapability` or `InterviewIntelligenceCapability`
themselves (see `capability-boundaries.ts`).

Un-asked does not mean un-tracked: `purpose`/`audience`/`style`/`colors`
remain in `ALL_SECTIONS_IN_POLICY_ORDER`, `BriefEvaluation` still reports
their resolution, and `DesignSummaryCapability` still shows them normally
whenever they do have a value — customer-volunteered, or resolved via
Conversation Understanding's contextual inference (§10a). When they
genuinely have no value, they are simply absent from the Design Summary —
exactly the way `exclusions`/`additionalNotes`/`references` have always
behaved. No `deferredSections` entry is fabricated on the customer's
behalf: that field's "Designer will determine" framing is reserved for a
decision the customer *actually* made (an explicit "you choose" — Goal
11), never a decision the system made unilaterally not to ask about
something.

### Required wording (Goal 6) — unchanged tier, richer resolution

`requiredWording` stays in the `required`/blocking tier — every Design
Brief still resolves it to either exact literal text or an explicit
"none" before summary. What changed is only how readily it gets
*resolved*: `OpenAIConversationUnderstandingProvider`'s prompt now
explicitly instructs the model that a name-for-an-entity ("our team is
called My 3 Sons") combined with design intent connected to that same
entity ("I want to create a team logo") is enough to propose the name as
required wording at `explicit`/`inferred` confidence, without a third,
redundant confirmation round-trip — while a name mentioned only as
passing context ("make something cool for My 3 Sons") still stays
`ambiguous` and unapplied (§10a's grounding/confidence rules, unchanged).
This is prompt guidance only; `reconcile-understanding.ts`'s exact-evidence
grounding requirement for `requiredWording` is untouched.

### Acknowledgement policy (Goal 7)

`withResolvedAcknowledgement` (`conversation-capability.ts`) now branches
on how much a turn actually resolved:

- **Single low-salience field** (a terse direct answer — "black", "full
  back") → `shortAcknowledgement` (`shared/question-phrasing.ts`): a short,
  natural confirmation ("Black works." / "Got it.") — never the
  per-field "Got it — I have Black as the shirt color." template, which
  reads as database-mutation reporting when it repeats every turn.
- **Multiple fields** (a rich message resolved several things at once) →
  the existing `acknowledgeResolvedFields` synthesis (Phase 1A) — earning
  its place by demonstrating real understanding of a complex message.
- **Nothing displayable changed** (e.g. a deferral-only turn) → falls back
  to the terser `acknowledgeRevision`, which stays truthful in that case.

### Contextual question phrasing (Goal 9)

`naturalizeQuestion` (`conversation-capability.ts`) lightly rewrites two
specific questions using only already-CONFIRMED brief values — never a
new LLM call, never an invented fact. **Sprint 2L Phase 1C correction:**
"already-confirmed" means the already-quality-gated `DesignSummaryView`
(the same projection `DesignSummaryCapability` builds — a field only
appears in it once `BriefEvaluation` has confirmed `resolution ===
"provided"`), never the raw `TShirtDesignBrief`. The original Phase 1B
implementation read the raw brief directly; a live acceptance test found
that a raw field can hold a value `BriefEvaluation` has already rejected
as malformed (e.g. a deterministic extractor's greedy over-capture),
correctly kept out of the Design Summary but never cleared from the raw
field — reading it here leaked the rejected value into a customer-facing
question. See §10a's "Deterministic safety net" for the companion
extraction-side fix.

- `productColor`'s question becomes "What color \{product\}s will these
  print on?" once `product` is known, instead of the generic "What color
  garment...".
- `graphics`'s question becomes "What direction do you want for the
  \{requiredWording or audience\} design?" once either is known, instead
  of the generic "Tell me about the design...".

`InterviewIntelligenceCapability` itself stays brief-unaware — this
naturalization happens in Conversation orchestration, which already has
full brief access for other reasons (building the understanding request,
the acknowledgement). Every other question keeps its existing, tested
phrasing untouched.

### Design Summary synthesis (Goal 8)

Handled entirely at the Conversation Understanding provider layer, not by
adding a synthesis step downstream: the OpenAI prompt now explicitly
instructs that, for every section except `requiredWording`, `value` must
be a clean, normalized, plain-language synthesis of what the customer
communicated — "that retro vibe" becomes `style: "Retro / mid-century"`,
never the raw sentence fragment. `requiredWording` remains the one
deliberate exception: exact literal text, never synthesized. Deterministic
extraction (the fallback when no provider is configured) is unchanged and
does not synthesize — this is a provider-only quality improvement,
consistent with Conversation Understanding always being a best-effort
layer over an always-correct deterministic base (§10a).

### Continue button (Goal 12) — removed

Audited `submitDesignBriefDecision`: "edit" and (the former) "continue"
both transitioned into the identical adaptive pipeline (Intent Extraction
→ Design Brief → Brief Evaluation → Interview Intelligence) — the *only*
difference was which opening question got asked
("What would you like to change...?" vs. "What else would you like the
designer to know?"). Neither the API schema, the capability, nor any
downstream behavior distinguished them beyond that string. "Continue" was
removed: `DesignBriefDecisionAction` is now `"approve" | "edit"` only, the
`briefDecisionBodySchema` enum dropped `"continue"`, and the Design
Summary card shows two actions. The `edit_requested` phase's question was
broadened to "What would you like to change or add?" to keep covering
both prior use cases. `continue_requested` remains a readable historical
`ConversationPhase` value (no migration; a project persisted mid-flow in
that phase before this change still renders sensibly) but is no longer
reachable from a fresh decision.

### Redundant pre-summary prose (Goal 13) — removed

Audited `ChatApp.tsx`: the same Design Summary turn rendered both the
prose `formatForCustomer` message content (`MessageBubble`) and the
structured, interactive `DesignSummaryCard` immediately below it — pure
duplication for the one turn it matters. Fixed at the presentation layer
only: the prose bubble is now suppressed exactly when the interactive
summary card is shown for that message (`showSummaryCard`); once the
conversation moves past that turn (the card stops rendering, since it
only ever shows for the *latest* message), the prose bubble renders
normally as the durable transcript record. No backend change — `content`
is still generated and persisted on every summary message exactly as
before, so conversation history and reload behavior are unaffected.

---

## 11. Brief Evaluation, Design Intelligence, and Product Intelligence

### Brief Evaluation

Answers:

- what is known
- what is missing
- what is ambiguous
- what is contradictory
- whether summary/approval is ready

Does not recommend, ask, or generate.

### Design Intelligence

Answers:

- what design/production advice should be surfaced
- how Product Intelligence findings become recommendations

Consumes Brief Evaluation; does not recreate it. May scope Product
Intelligence using `RevisionImpact.affectedRulePacks`.

### Product Intelligence

Owns deterministic print and placement rules (see §5). Advises the
customer in plain language. Does not replace Print Validation.

---

## 12. Revision Architecture

Current post-approval revision path:

1. Correction-aware intent extraction
2. DesignBrief applies patch to working brief
3. RevisionIntelligence compares previous vs updated → `RevisionImpact`
4. Scoped reevaluation / recommendations when needed
5. InterviewIntelligence `selectRevisionAct` (narrow; no interview restart)
6. Summary refresh when `needsSummaryRefresh`
7. Concept status via `describeConceptStatus` (`current` / `needs_update` /
   `superseded`)
8. Customer may regenerate → new approved path / new job / new batch
9. Prior batches preserved
10. Single-level undo via `lastRevision`
11. UI: DesignHistory (artwork-version-lineage milestones — see "Customer-
    facing Design History" below), deferred decision cards, recommendation
    cards

Concept-relevance sections (`shared/concept-relevance.ts`) currently
include product, productColor, colors, graphics, requiredWording, style,
printLocation, and — as of Sprint 2M Phase 2G — **exclusions**.
Audience/purpose/notes/references do not, by themselves, mark concepts
stale under today's generation implementation; a change to any of them
does not visibly change what a correct concept should contain. The rule
(Sprint 2M Phase 2G, Goal 12): a field is concept-relevant exactly when a
change to it changes what should or should not visibly appear in the
artwork — a positive instruction (add this) and a negative one (never show
this) are equally concept-relevant. `exclusions` was the one field this
rule already covered in spirit but the implementation missed; nothing else
changed by this sprint. These rules may expand further once Concept
Evaluation gating exists (Phase 2+).

`RevisionCapability` remains a future artwork-level lifecycle stub and is
not the live revision path.

### Concept batches, unselect, and "Show Me 3 New Concepts" (Live Acceptance Cleanup)

Live acceptance found the customer had only two options once concepts
existed: pick one, or Start Over. Both were wrong when the *Design Brief was
correct and only the creative directions were not*, and there was no way
back to "none selected" after a misclick.

**A batch is now (approved brief version, generation job), not just approved
brief version.** `shared/concept-batches.ts` is the single definition;
`describeConceptStatus` returns only the newest batch as `currentConcepts`
and moves earlier same-version batches into `previousBatches`. That was
previously a distinction without a difference — one version could only ever
have one batch — and `ConceptGenerationCapability.exploreNewConceptBatch`
is what makes it real: a second batch of three from the SAME approved
version, with no brief mutation, no re-approval, and no selection or final
approval inferred. Prior batches are never deleted and stay selectable
(Constitution §6.11).

Two consequences worth stating explicitly, because both were latent
assumptions rather than deliberate rules:

- **`GenerationWorkerCapability`'s idempotency guard is keyed on the JOB**
  (`artwork.generationJobId === job.id`), not on the approved brief version
  having any artwork. Keying on the version would silently no-op every
  additional batch. The job-level key is also the more precise statement of
  what the guard was always for: "a previous run of this exact job already
  succeeded and this claim lost the race."
- **`CustomerArtworkVersion.conceptBatchOrdinal`** carries batch identity to
  presentation surfaces. It is an opaque counter (1, 2, 3, …) assigned by
  `assignConceptBatchOrdinals`, never the `generationJobId` it derives from —
  the customer projection strips every internal id, but Design History and
  the concept grid still have to tell one batch from another.

**Unselect** (`ConversationCapability.unselectConcept` →
`ProjectRepository.clearArtworkSelection`) is the explicit inverse of
`selectConcept`. It is server-owned, never a client-side visual reset:
`selectedArtworkVersionId` and every `ArtworkVersion.isSelected` are cleared
together (the same reason `selectArtworkVersion` owns both writes), and
`finalDirectionConfirmed` goes with them — a confirmation can never outlive
the selection it was made about. Any active `FinalDirectionApproval` is
explicitly SUPERSEDED rather than orphaned, since
`FinalArtworkWorkerCapability` only ever acts on the active approval.

It **refuses** — rather than resolving quietly — while a revision is pending
or while `PrintProject.status` is `finalizing`/`print_ready`. Those states
own the selection right now, and invalidating them behind the customer's
back is precisely the "silently invalidate a production approval" failure
the lifecycle rules in §12a exist to prevent. Nothing is ever deleted:
concepts, batches, revisions, and history all survive untouched.

---

## 12a. Revision Lifecycle & Finalization Safety (Sprint 2M Phase 2G)

### Why

A live failure exposed that `PrintProject.status === "revision_requested"`
— written on every message in the post-selection revision loop, including
ones that changed nothing — was too weak a signal to gate finalization on,
and that an explicit customer correction could silently fall through to
`additionalInstructions` (invisible to concept-relevance) instead of
updating the Design Brief field it was actually correcting. The customer
said "the wording is the boat name shouldn't appear on the design... use
the word GLORIOUS" after selecting a concept generated from a
mis-extracted required-wording answer; the system replied "Got it — I've
updated the notes," left "Prepare Print-Ready Artwork" available, and
queued a `FinalArtworkJob` for artwork the customer had just rejected.

### The clarified rule — durable, not just this sprint's fix

The prior rule, "automatic regeneration is forbidden," is clarified (not
reversed) to distinguish WHO initiates it:

- **System-initiated speculative regeneration remains forbidden.** Nothing
  regenerates because Design/Revision/Regeneration Intelligence merely
  *thinks* a change might help.
- **Customer-requested conversational revision may enqueue regeneration
  automatically.** An explicit, unambiguous customer instruction is
  customer authority — no separate "Generate Updated Concepts" click is
  required for it, though that control remains available for anything this
  automatic path doesn't cover. See `shared/revision-intent.ts`'s
  `isExplicitRevisionIntent` — hedged language ("maybe", "I'm not sure") or
  a bare question ("Do you think this needs more color?") is never
  "explicit," and never auto-regenerates.

### The enforced lifecycle

```
Concepts Ready
  → customer selects one direction          (ArtworkVersion.isSelected)
  → customer requests a revision            (explicit, unambiguous instruction)
  → PrintProject.revisionPending = true     (durable — survives reload)
  → any active FinalDirectionApproval is immediately superseded
  → revision regeneration auto-enqueued     (no extra click required)
  → new ArtworkVersion batch completes      → revisionPending cleared
  → customer reviews / selects the revised direction
  → customer explicitly clicks Prepare Print-Ready Artwork
  → FinalDirectionApproval targets THAT exact revised ArtworkVersion
  → Final Artwork Worker / Print Validation → print_ready
```

`SELECTED != REVISION_REQUESTED != REVISION_COMPLETE != FINAL_APPROVED !=
PRINT_READY` — five distinct facts, never collapsed into one.

### `PrintProject.revisionPending` — the durable pending-revision authority

A new `boolean` column (`revision_pending`, migration
`20260808120000_revision_pending.sql`), not a new status enum value and
not a second table — the smallest durable authority that survives reload
and is independently checkable without recomputing a brief diff. Written
by `ConversationCapability`'s `triggerAutomaticRevision` the moment an
explicit revision is understood (see `conversation-capability.ts`); cleared
only by `GenerationWorkerCapability` when the regeneration job that
revision enqueued actually completes and produces a new `ArtworkVersion`
batch — never merely at enqueue time. `FinalArtworkCapability.requestFinalArtwork`
checks it first, before any other validation, and refuses to create a
`FinalDirectionApproval`/`FinalArtworkJob` while it is `true` — this is
the authoritative, server-side gate; `ChatApp.tsx`'s
`canRequestFinalArtwork` hiding the Prepare button is only the UI
reflection of it, never the enforcement itself.

### Revision during finalization (the race this sprint closes)

If a customer requests a revision while a `FinalArtworkJob` is still
running, `triggerAutomaticRevision` calls
`repo.supersedeActiveFinalDirectionApproval` immediately — at the moment
the revision is understood, not only later at regeneration completion (the
prior, insufficient behavior). `FinalArtworkWorkerCapability.maybeTransitionProjectStatus`
already re-reads the active approval immediately before writing
`print_ready`/`finalization_required` and refuses to write either unless
its own approval is still the active one (pre-existing safeguard, Sprint
2M Phase 2C/2E) — superseding the approval earlier, at revision-request
time rather than only at regeneration-completion time, is the entire fix:
a still-in-flight (possibly paid) production job may complete, but its
result can never win a race against newer customer intent and become
`print_ready`. Historical preservation, not deletion: the superseded
approval and any resulting production asset remain queryable internally —
a paid provider call already in flight is never wasted or hidden, only
never trusted as current.

### Repeat Prepare is idempotent and truthful (Goal 8)

`FinalArtworkCapability.requestFinalArtwork` only writes
`PrintProject.status = "finalizing"` when the resolved `FinalArtworkJob` is
actually claimable (`"queued"`/`"running"`/`"recoverable"`). A repeat
request against an already-`"completed"` job (double click, reload,
duplicate request) leaves `PrintProject.status` exactly as
`FinalArtworkWorkerCapability` already, truthfully, set it
(`print_ready` / `finalization_required`) rather than stomping it back to
`"finalizing"` with no claimable job left to advance it — the stranding
the Revision Lifecycle Audit found.

### Required-wording semantics (Goal 1) and correction/exclusion semantics (Goal 2)

`extraction.ts` distinguishes **contextual entity description** ("GLORIOUS
is the boat name") from **literal required wording** ("GLORIOUS")
structurally — `<entity> is the/our/my <descriptor> name/title`, in either
order, with a self-referential-subject guard ("the wording is the boat
name..." never names *itself* as the entity) — rather than a per-domain
noun blacklist; the same reduction applies to whatever a correction cue
("use the word X", "I meant X") captures, so "I meant GLORIOUS is the boat
name" also reduces to `GLORIOUS`. Explicit quoted text always wins first
and is never reduced (a genuine literal phrase that happens to contain "is
the ... name" stays exact) — unless the quote is itself the target of a
removal cue ("don't print 'is the boat name'"), in which case it is
excluded, not adopted. Removal/correction cues ("don't print X", "X
shouldn't appear", "remove X", "only use Y") update `requiredWording`
and/or `exclusions` directly instead of falling through to
`additionalInstructions` — the field that caused the original "Got it —
I've updated the notes" bug, because `additionalNotes` is not
concept-relevant and never gates staleness/regeneration. The same shape
recognition is mirrored (not duplicated) in the OpenAI Conversation
Understanding provider's prompt (`openai-conversation-understanding-provider.ts`)
so the two extraction paths agree; the deterministic path never depends on
the LLM path being configured.

### Concept-relevance rule generalized

See §12 above — `exclusions` is now concept-relevant, which is what lets a
correction that only *removes* something (no new positive content) still
mark concepts stale and participate in the auto-regeneration decision.

---

## 12b. Live Acceptance Corrective Pass — Final Direction Confirmation, Single-Concept Revision, Lineage

Live browser acceptance testing of §12a's implementation exposed that
"selected" and "final approved" were still conflated in practice (the
Prepare action could appear immediately after selection, before any
revision decision), that a normal post-selection revision regenerated
three unrelated directions instead of revising the one concept the
customer was looking at, and that revision history had no explicit
lineage. This section is the corrective architecture.

### Five distinct lifecycle facts, never collapsed

```
Concepts Ready
  → concept selected                    ArtworkVersion.isSelected /
  |                                      PrintProject.selectedArtworkVersionId
  → awaiting revision decision          (selected, revisionPending=false,
  |                                       finalDirectionConfirmed=false)
  → revision requested                  PrintProject.revisionPending = true
  → revision complete                   new ArtworkVersion, revisionPending
  |                                      cleared, finalDirectionConfirmed
  |                                      still false (never inherited)
  → final direction confirmed           PrintProject.finalDirectionConfirmed
  |                                      = true (customer explicit action only)
  → Prepare Print-Ready Artwork         FinalArtworkCapability.requestFinalArtwork
```

`SELECTED != REVISION_REQUESTED != REVISION_COMPLETE != FINAL_DIRECTION_CONFIRMED
!= PRINT_READY` — five facts, five independent transitions, never inferred
from one another.

### `PrintProject.finalDirectionConfirmed` — the confirmation gate

A new `boolean` column (migration `20260808180000_revision_lineage_and_final_direction.sql`),
independent of and strictly stronger than `revisionPending`. Selecting a
concept (`ConversationCapability.selectConcept`) — including re-selecting a
historical one — always sets it back to `false`; only the customer's
explicit confirmation sets it `true`:

- `ConversationCapability.confirmSelectedDirection(designId, artworkVersionId)` —
  the `[Use This Design]` UI action, and `POST /api/projects/[id]/confirm-direction`.
- A short, closed list of unambiguous whole-message chat phrases ("no
  changes", "use this design", "this is the one", ...) — `CONFIRM_FINAL_PATTERN`
  in `conversation-capability.ts`. Deliberately narrow: a customer casually
  saying "looks good" mid-conversation must never read as final approval
  (Constitution §15).

`FinalArtworkCapability.requestFinalArtwork` checks `finalDirectionConfirmed`
as its own, independent, final gate (after `revisionPending`, after
artwork-identity/staleness/selection validation) — the authoritative,
server-side enforcement. `ChatApp.tsx`'s `canRequestFinalArtwork` and the
`showUseThisDesignAction` derived state are only the UI's reflection of it.

### One targeted revision, never three unrelated directions

The default post-selection revision operation — automatic (`triggerAutomaticRevision`)
and manual (`regenerateConcepts()`, the "regenerate" chat pattern) alike —
now revises the ONE selected concept, producing exactly one new
`ArtworkVersion`, in that concept's own creative direction. The old
three-direction "explore" operation (`ConceptGenerationCapability.regenerateAfterRevision`)
still exists and still runs for: initial generation, and an EXPLICIT
"show me alternatives" request (`ALTERNATIVES_REQUEST_PATTERN` — "show me
a few different directions", "three different versions", "other options",
...), checked ahead of (and independent from) the default single-concept
path.

```
ConceptGenerationCapability
  .generatePlaceholders          → 3 directions, no source        (initial)
  .regenerateAfterRevision       → 3 directions, no source        (explicit "show me alternatives")
  .reviseSelectedConcept         → 1 concept, source = selected   (default post-selection revision)
```

Mechanism: `GenerationJob.targetArtworkVersionId` (new, nullable) — when
set, the job is a targeted single-concept revision:
`conceptCount = 1`, and the worker resolves the source `ArtworkVersion`'s
own `conceptDirectionKey` and threads it through `GenerationIntent.targetConceptDirectionKey`
→ `GenerationPromptRequest.targetConceptDirectionKey` (both provider-neutral,
`PromptTranslationCapability`-computed, same pattern as `allowAdditionalText`/
`inspirationReferences`) → the concept-directions catalog resolves to that
ONE direction (`resolveConceptDirection`) instead of iterating all three.
Both the placeholder and OpenAI provider adapters honor this identically —
neither invents its own three-vs-one logic. A resulting revision's
`ArtworkVersion.kind` is `"revision"` (the catalog value reserved since
Sprint 1, previously unused); an explore-batch concept's `kind` stays
`"concept"`.

On completion, a targeted revision auto-selects its one result (nothing
else to choose from) but leaves `finalDirectionConfirmed` false — the
customer still must explicitly confirm the revised artwork, never merely
because it's now selected.

### Revision lineage

`ArtworkVersion.sourceArtworkVersionId` (new, nullable, self-referencing) —
which artwork, if any, a given row is a targeted revision of. `null` for
every original/explore-batch concept. This is the entire lineage model —
no parallel history table: the original three concepts and every revision
remain ordinary rows in `artwork_versions`, chained by this one column and
by `designBriefVersionId` batch grouping (`ConceptGenerationCapability.describeConceptStatus`'s
existing `currentConcepts`/`previousBatches` split, unchanged). Nothing is
ever deleted (Constitution §6.11).

`ConversationCapability.selectConcept` is now reachable not only from
`concepts_ready` but also from the post-selection revision phases
(`ask_revisions`/`revision_received`) — the customer can explicitly
re-select ANY historical concept (the original, or an earlier revision),
restoring it as the current selection (and resetting `finalDirectionConfirmed`
to `false`, same as any new selection). `ChatApp.tsx` surfaces this via a
"View design history" panel listing `conceptStatus.previousBatches`
(already customer-safe), each batch rendered through the same `ConceptCards`
component and `onSelect` handler as the live concept grid.

### Canonical product / semantic wording extraction

Two related deterministic-extraction fixes, both in `extraction.ts`:

- **Canonical product**: `extractProduct` now tightens a reply down to the
  short descriptor+product-word phrase around the product word
  (`PRODUCT_PHRASE_PATTERN`) whenever the reply has more than one clause,
  OR the product word isn't the LAST word of its clause
  (`PRODUCT_WORD_AT_END_PATTERN`) — "lets create a t-shirt design" and "A
  T-shirt for the school fair" both tighten to "T-shirt"; "Camp shirts" and
  "black hoodies" (a genuine short direct answer, product word at the very
  end, nothing trailing it) are kept verbatim. Naturalized customer-facing
  questions (`naturalizeQuestion` in `conversation-capability.ts`) always
  read from this canonical value, never a raw sentence fragment.
- **Semantic wording generalization**: the entity-naming pattern set in
  `extraction.ts` (already generalized once in Sprint 2M Phase 2G's "GLORIOUS
  is the boat name") is generalized further to cover the reversed
  "name of the X" order, relative-clause/appositive connectors ("X, which
  is the Y name", "X — that's the Y name"), a generic (non-noun-gated)
  descriptor for the "name is X"/"is called/named X" shapes (`GENERIC_DESCRIPTOR`,
  with a closed-class function-word exclusion so "which is the name of the
  boat" can never itself parse as a descriptor), and a bare typographic
  imperative cue (`BARE_IMPERATIVE_ENTITY_PATTERN` — "Use GLORIOUS", "Put
  ACME on it": capitalization signals literal text). All still structural,
  none domain-specific — verified against boat/dog/company/person examples
  in the test suite. `openai-conversation-understanding-provider.ts`'s
  prompt documents the same shapes so the two extraction paths agree, but
  the deterministic path is authoritative and never depends on the LLM
  path being configured (§10a) — automated tests exercise only the
  deterministic path.

### Concept preview is read-only

`ConceptPreviewModal.tsx` — opened via a dedicated expand affordance on
each `ConceptCards` card, never by the card's own select-on-click. That
affordance is a **sibling** of the card's select button, never a
descendant of it, and this is load-bearing rather than cosmetic: nesting
one button inside another made "previewing does not select" depend on
event propagation surviving hydration, and made previewing impossible
outright once the card rendered `disabled` (browsers do not dispatch
clicks to descendants of a disabled control) — which is the state every
auto-selected revised concept is in. Any visible `ArtworkVersion` with a
renderable asset opens in this same viewer: original concept, revision,
current version, or historical version.

`object-contain` (never `cover`, so the whole design is always visible), a
neutral checkerboard surface behind the (possibly transparent) artwork,
Escape and backdrop-click both close it, and a `[Select this concept]`
action inside it calls the exact same `onSelect` handler the card itself
uses. Opening, viewing, or closing the modal never calls any capability
method or mutates any lifecycle state — it is pure client-side UI state
(`previewId` in `ConceptCards`).

---

## 13. Concept Generation Architecture

Pipeline:

1. Customer approves Design Summary → durable approved brief version
2. ConceptGenerationCapability enqueues `GenerationJob` (idempotent key:
   design + approved version)
3. Worker claims job
4. PromptTranslationCapability builds `GenerationPromptRequest`
5. Provider adapter receives request DTO only
6. Provider returns drafts + optional raw image bytes
7. AssetCapability stores bytes and metadata
8. ConceptEvaluationCapability evaluates each concept against the approved
   brief (provider-neutral; results persisted; never blocks Phase 1)
9. Artwork versions persist with brief/job/asset/evaluation provenance
10. **Sprint 2M Phase 2A:** `runProvisionalPrintValidation` runs
    `PrintValidationCapability.validateArtwork` per newly persisted
    `ArtworkVersion` — provisional intelligence only, logged internally,
    never persisted, never blocking; see §5's "Provisional Print Readiness
    vs. Final Print Validation"
11. Assistant message announces concepts ready (customer-safe) — unaffected
    by step 10; provisional print-readiness never changes this message

### Providers

| Provider | Behavior |
|---|---|
| Placeholder | Deterministic concept cards without real image bytes |
| OpenAI | Real PNG bytes; prompt dialect private to adapter |
| Unavailable | Fail closed with safe codes |

Configuration gates (composition/config, not UI):

- `CONCEPT_GENERATION_PROVIDER`
- `OPENAI_API_KEY` / `OPENAI_IMAGE_MODEL`
- production-safe `ASSET_STORAGE_MODE`
- `CONCEPT_GENERATION_ENABLE_REAL` (explicit kill switch; default false)

Retry budget: `MAX_GENERATION_ATTEMPTS = 3` (shared enqueue + recovery).
Customer-facing failure messages stay generic; internals stay server-side.

### Explicit provider constraints

Providers:

- never receive mutable domain objects / raw Design Briefs
- never write to repositories
- return raw generated bytes/data only
- never mutate conversations
- keep provider-specific prompt language inside the adapter — never in the
  Design Brief or `GenerationPromptRequest`

### Concept Evaluation architecture (Sprint 2I Phase 1 + Phase 2)

Mirrors Prompt Translation / generation: provider-neutral contracts,
replaceable evaluators, deterministic orchestration.

```
Generation Worker
  → AssetCapability (persist bytes; also mints a short-lived signed URL
                      per asset for the evaluation step below)
  → ConceptEvaluationCapability
        → ConceptEvaluationProvider
              (placeholder, deterministic — or —
               OpenAIConceptEvaluationProvider, vision-based)
  → Persist evaluation on ArtworkVersion
  → Conversation update (unchanged customer copy)
```

| | Concept Evaluation | Print Validation |
|---|---|---|
| Question | Does this concept match the approved Design Brief? | Is this artwork production-/print-ready? |
| Criteria | wording, style, graphics, palette, composition, readability, exclusions, product compatibility, overall alignment | DPI, transparency, vector/raster quality, print size, embroidery limits |
| Phase 1/2 | Architecture, persistence, and a real evaluator; still no UI gating | Sprint 2M Phase 1: real deterministic capability; pure/recomputed, not persisted, not wired into any pipeline yet — see §5 |

Persistence on `ArtworkVersion` (provider-neutral, unchanged since Phase 1):

- `evaluationStatus`: `pending` | `passed` | `needs_review` | `failed`
- `evaluation`: `ConceptEvaluation` JSON payload
- `evaluationEvaluatedAt`
- `evaluationProviderKey`

**Evaluation lifecycle / state transitions** (see also §8's `ArtworkVersion`
diagram — unchanged shape, now driven by a real evaluator when configured):

```
(concept generated, asset(s) persisted)
        │
        ▼
GenerationWorkerCapability mints a short-lived signed URL per asset
(AssetCapability.getSignedUrl) and calls ConceptEvaluationCapability.evaluate
        │
        ├─ provider succeeds ──► toPersistedEvaluation()
        │                             ├─► "passed"        (high alignment,
        │                             │                     high confidence,
        │                             │                     no violations)
        │                             ├─► "needs_review"   (low confidence,
        │                             │                     uncertain signal,
        │                             │                     or no fetchable
        │                             │                     image)
        │                             └─► "failed"         (confidently
        │                                                    missing required
        │                                                    wording, or a
        │                                                    confidently
        │                                                    violated
        │                                                    exclusion)
        │
        └─ provider throws / times out ──► evaluationFailureFallback()
                                                  └─► "needs_review"
        │
        ▼
Persisted on ArtworkVersion — concept always still presented to the
customer in Phase 1/2 regardless of status (advisory only; no gating,
hiding, ranking, or regeneration decisions are made from it yet).
```

Security: evaluation providers receive only approved brief snapshot content,
concept presentation fields, and opaque asset references — never customer
ids, conversation ids, generation job ids, secrets, or repository handles.
`ConceptEvaluationAssetReference.sourceUrl` (Phase 2) is the one exception
worth calling out explicitly: it is a short-lived, expiring URL from the
same `AssetCapability.getSignedUrl` mechanism the browser uses — not a raw
storage key, not a repository handle, and never a long-lived link. A
provider adapter that needs pixels (only `OpenAIConceptEvaluationProvider`
today) fetches it directly; the capability layer never reads image bytes on
the provider's behalf. `sourceUrl` is request-path only: it must never be
copied into persisted `ArtworkVersion.evaluation`, `providerMetadata`,
conversation messages, logs, or customer UI. `ConceptEvaluationCapability`
allowlists `providerMetadata` and redacts http(s) URLs from persisted
string fields as a defensive boundary.

Providers: `PlaceholderConceptEvaluationProvider` (default; deterministic
`needs_review`, criteria `not_assessed`; no vision, OCR, or color analysis)
and `OpenAIConceptEvaluationProvider` (Sprint 2I Phase 2 — a vision-capable
chat model). The real provider:

- verifies required wording via OCR-style reading of the image, returning a
  confidence alongside `found` rather than failing on small uncertainty
- verifies stated exclusions are not obviously violated
- uses broad semantic color/style/graphics matching (e.g. "forest green" /
  "olive" both satisfy a "green" request; "vintage" is judged as a broad
  direction, not ranked subjectively)
- never invents a requirement the brief did not state — any criterion
  without a corresponding brief field is forced to `not_assessed` in code,
  regardless of what the provider's raw response contains
- only reaches `failed` when a negative signal (missing wording, violated
  exclusion) carries high confidence; otherwise `needs_review`
- degrades to an honest `needs_review` (no network call) when no asset has
  a usable image URL, and to the shared `evaluationFailureFallback` on any
  network/timeout/rate-limit/malformed-response failure after its own
  bounded retries — the pipeline's failure handling (never discard
  concepts) is unchanged from Phase 1

Configuration (composition layer only — see §21): `CONCEPT_EVALUATION_PROVIDER`
(`placeholder` default, or `openai`), reusing `OPENAI_API_KEY`, plus optional
`OPENAI_EVALUATION_MODEL` (default `gpt-4o-mini`). Unlike concept
*generation*, a misconfigured `openai` evaluation request never fails
closed — it always falls back to the placeholder evaluator, in every
environment including production, because evaluation is advisory-only and
every failure path already degrades to `needs_review` without discarding or
misrepresenting anything to a customer.

---

## 13a. Regeneration Pipeline Architecture (Sprint 2J Phase 3)

Sprint 2J Phase 3 activates Regeneration Intelligence on the customer's
**explicit** regeneration path only. Initial concept generation is unchanged.
No automatic regeneration, no UI changes, no new messages, no evaluation
gating, no concept suppression.

### Live regeneration path

```
Customer: Generate Updated Concepts
       │
       ▼
ConceptGenerationCapability.regenerateAfterRevision (enqueue only)
       │  GenerationJob.kind = "regeneration"
       ▼
GenerationWorkerCapability
       │
       ├─ initial  → GenerationIntent(brief, plan=null) → translate → provider
       │
       └─ regeneration
              │
              ▼
         RevisionIntelligence (consecutive DesignBriefVersions → impacts)
              │
              ▼
         RevisionTimelineCapability.derive(...)
              │  ephemeral RevisionTimeline
              ▼
         RegenerationIntelligenceCapability.planNextGeneration(...)
              │  ephemeral RegenerationPlan
              ▼
         GenerationIntent(brief, plan)   ← immutable; never persisted
              │
              ▼
         PromptTranslationCapability.translate(generationIntent)
              │
              ▼
         ConceptGenerationProvider → Asset → Concept Evaluation → Persist
```

### GenerationIntent

`GenerationIntent` (`src/capabilities/prompt-translation/generation-intent.ts`)
is the single provider-neutral input into Prompt Translation.

```ts
interface GenerationIntent {
  readonly approvedBrief: DesignBriefSnapshotContent;
  readonly regenerationPlan: RegenerationPlan | null;
}
```

- Immutable (`Object.freeze`)
- Never persisted
- Never exposed to customers
- No prompt wording, AI terminology, or provider dialect
- Does not mutate the approved Design Brief — it is an instruction set for
  this generation attempt only

Lifecycle: constructed in the worker per claimed job → passed to
`translate` → discarded. Recomputed on every attempt.

### Initial vs regeneration

| Path | GenerationIntent | Timeline / Plan |
|---|---|---|
| `kind === "initial"` | `createInitialGenerationIntent(brief)` | **Not used** |
| `kind === "regeneration"` | `createRegenerationGenerationIntent(brief, plan)` | Derived every time |

Initial output is byte-for-byte equivalent to the historical brief-only
translator (`translateApprovedBrief`).

### Prompt Translation

```ts
translate(generationIntent: GenerationIntent): GenerationPromptRequest
```

Priority when a plan is present:

1. Explicit exclusions
2. Required wording
3. Latest customer revisions
4. Evaluation-driven improvements
5. Product Intelligence (reserved)
6. Design Intelligence (reserved)
7. Preserve satisfied requirements

### GenerationAttempt authority

| Concept | Source |
|---|---|
| `RegenerationPlan.generationAttempt` | `resolveGenerationAttemptNumber(jobs)` — completed jobs + 1 |
| `GenerationJob.attempts` | Per-job claim/retry budget — **not** the regeneration ordinal |

### Persistence

No schema changes. No migrations. `GenerationIntent`, `RevisionTimeline`,
and `RegenerationPlan` remain ephemeral.

### Rejected concepts (future)

`RejectedConceptMemory` remains the interface for future rejection support.
Phase 3 does not invent rejection persistence.

---

## 13b. Final Artwork Lifecycle & Production Approval Boundary (Sprint 2M Phase 2B)

### Why

Sprint 2M Phase 2A established Provisional Print Readiness — intelligence
about a freshly generated concept, logged only, never authoritative. Its
report explicitly left one gap open: iHeartPrints had concept selection and
revision behavior, but no action anywhere meant "the customer is done —
make my production artwork." Selecting a concept
(`ArtworkVersion.isSelected` / `PrintProject.selectedArtworkVersionId`)
only ever started the revision conversation; it never froze or "approved"
anything, and `ProjectStatus`'s `"finalizing"`/`"print_ready"` values were
defined but never assigned anywhere in the codebase.

Phase 2B closes that gap with the smallest architecture that stays
correct — see the three non-negotiable distinctions below — without
implementing any real production transformation.

### The authoritative lifecycle

```
Design Brief Approved
        ↓
Concept Generation
        ↓
Concept Evaluation
        ↓
Provisional Print Validation
        ↓
Concepts Ready
        ↓
Customer Selects Direction            ← ArtworkVersion.isSelected /
        ↓                               PrintProject.selectedArtworkVersionId
Revision / Regeneration [optional, repeatable]
        ↓
Customer Approves Final Direction     ← FinalDirectionApproval ("active")
        ↓
Final Artwork Request                 ← FinalArtworkJob ("queued")
        ↓
FinalArtworkCapability                ← reserved orchestration boundary;
        ↓                               no transformation runs in Phase 2B
Production Asset(s)                   ← not implemented; AssetRecord.
        ↓                               finalArtworkJobId is reserved
Authoritative Print Validation        ← not implemented; same
        ↓                               PrintValidationCapability, run
        ↓                               against a real production asset
Print Ready                           ← only this later run may ever
                                         justify PrintProject.status =
                                         "print_ready"
```

### Three distinct states — never collapsed into one

| State | Means | Persisted on |
|---|---|---|
| **Selected** | "This is the direction I want to work with." Still revisable. | `ArtworkVersion.isSelected` / `PrintProject.selectedArtworkVersionId` (unchanged) |
| **Final direction approved** | "Yes, this is the artwork direction I want finalized for production." Explicit, durable, targets one exact `ArtworkVersion`. | `FinalDirectionApproval` (new) |
| **Print ready** | The resulting *production* asset passed *authoritative* Print Validation. | Not implemented — see below |

`SELECTED != FINAL_APPROVED != PRINT_READY`, and (Goal 8) `CONCEPT ASSET !=
PRODUCTION ASSET`: a concept-stage `AssetRecord` has `generationJobId` set;
a future production `AssetRecord` will have `finalArtworkJobId` set — never
inferred from a filename or storage path.

### Where "final direction approval" lives — the design question

Evaluated against revisions, auditability, idempotency, multiple future
production outputs, operator workflows, and the ability to revoke/supersede
without ambiguous mutable state (see `final-artwork-capability.ts`'s doc
comment for the full per-criterion reasoning): a **new, separate,
append-only, immutable record** — `FinalDirectionApproval` — not a boolean
on `ArtworkVersion` and not a field on `PrintProject`. This mirrors why
`DesignBriefVersion` is its own table rather than a flag on the working
brief. At most one row per project may be `"active"` at a time (a real
Postgres unique partial index enforces this, not just application code); a
newer approval or a new concept batch (regeneration) supersedes the prior
one going forward — rows are never deleted or rewritten.

### Revision after approval (Goal 4)

If the customer regenerates concepts after approving a final direction, the
prior approval is automatically superseded
(`GenerationWorkerCapability`'s regeneration-completion path calls
`repo.supersedeActiveFinalDirectionApproval`, alongside its existing
`selectedArtworkVersionId: null` reset) — the artwork it authorized no
longer exists as "the current direction," so it can never silently
authorize production of what replaced it. A new `ArtworkVersion` always
requires its own new approval. An ordinary brief edit that does *not*
trigger regeneration — no new `ArtworkVersion` — does not retroactively
invalidate an existing approval; `FinalArtworkCapability.requestFinalArtwork`
itself still refuses to *create* a *new* approval for a concept that has
grown stale relative to the working brief (the same `needs_update` signal
`ConceptGenerationCapability.describeConceptStatus` already computes,
reused via `shared/brief-diff` + `shared/concept-relevance`).

### Finalization request / job model (Goal 6)

A dedicated `FinalArtworkJob` table — not a reuse of `GenerationJob`.
Different trigger (explicit approval, not brief approval), different
idempotency authority (`FinalDirectionApproval.id`, not
`(project, approvedBriefVersion)`), different output (production
`AssetRecord`s + an eventual authoritative `PrintValidationReport`, never
concept `ArtworkVersion`s). Keyed 1:1 to the approval that authorized it
(`unique (project_id, final_direction_approval_id)`) — this is what makes a
double-click or duplicate request naturally idempotent. Phase 2B never
claims or runs this job; every row starts and stays `"queued"` until a
future phase adds a real worker — a truthful, honestly-unfinished state
(Goal 12), not a fabricated success.

### Customer-facing state (Goals 11, 12, 16)

One explicit UI action — `PrepareForPrintAction`
(`src/components/chat/PrepareForPrintAction.tsx`) — reachable once a
selected, current concept exists: "This is the design you want? I can
start preparing your print-ready artwork." → **Prepare Print-Ready
Artwork**. No separate confirmation dialog (Goal 11): the button's own
label already states the commitment. Never says "finalize raster," "print
validation," "production asset," "vectorize," "upscale," "300 DPI," or
"execute final artwork job."

`conversation-service.ts` derives a customer-safe
`CustomerFinalizationStatus` (`"not_requested"` / `"preparing"` /
`"print_ready"`) purely from `PrintProject.status` — never from a raw
`FinalDirectionApproval`/`FinalArtworkJob` row, id, or internal status
string. `"preparing"` (not `"print_ready"`) is what Phase 2B ever shows,
because nothing may claim readiness it hasn't earned (Constitution §15) —
see `PrepareForPrintAction`'s "Preparing your print-ready artwork…" state,
which is not a permanent fake loading screen: it is the honest state of an
intentionally-not-yet-executable job, and it will become real once a future
phase adds the worker that claims `FinalArtworkJob` rows.

### `ArtworkVersion.printValidationStatus` — re-confirmed, sharper reason (Goal 10)

Still reserved `null`. Phase 2A left it unwritten because a provisional
concept-stage reading and a future authoritative production reading would
be ambiguous sharing one column. Phase 2B adds a second, independent reason
that holds even once a production asset can exist: one approved direction
may yield **multiple** production assets (PNG, SVG, PDF), each with its own
readiness (a PNG might pass DTF requirements while the SVG needed for
screen print does not) — so authoritative validation status can never
correctly live on `ArtworkVersion` at all. Its eventual home is a
production-asset-scoped record (or a `{ stage, status }` shape), never this
column.

### Security (Goal 15)

`FinalArtworkCapability.requestFinalArtwork` resolves `artworkVersionId`
only through `repo.getProject(projectId).artworkVersions`, which is already
scoped to that project — a foreign or forged id is indistinguishable from
"not found" (404), never a distinguishable error that would let a caller
probe for another project's concepts. No asset id, storage key, job
internal, or approval id ever reaches a customer response —
`conversation-service.ts`'s `finalization` view carries exactly one field,
`status`.

---

## 13c. Final Artwork Production Pipeline (Sprint 2M Phase 2C)

### Why

Phase 2B built the entire lifecycle up to a `FinalArtworkJob` sitting
`"queued"` forever. Phase 2C is the first sprint that actually claims and
runs it — proving, honestly, whether iHeartPrints can turn an approved
~1024x1024 concept into real raster apparel production artwork today.

### The upscaling-truthfulness question

Before writing any transformation code, this sprint had to answer: *if we
take a 1024x1024 concept and produce a 3600x3600 PNG via ordinary
interpolation, is that acceptable production artwork?* **No.** Simple
interpolation increases pixel count without restoring real detail. The
audit that follows is what shaped every downstream decision.

**Audit findings:**

- The only image-processing dependency in this codebase is `pngjs` (pure
  JS PNG codec) — no `sharp`, no native binary, no ML upscaler.
- `OPENAI_IMAGE_MODEL` (`gpt-image-1`) supports at most `1024x1024`,
  `1024x1536`, or `1536x1024` — there is no larger size to request. Even a
  best-case provider regeneration cannot reach the 3600x4200px a full-back
  print needs at 300 PPI, and cannot reach the 1200x1200px a left-chest
  print needs in both dimensions simultaneously (a 1536x1024 landscape
  image is short on its 1024 axis).
- A concept's native ~1024x1024px pixels, however, already exceed the
  900x900px minimum a **sleeve** placement (3x3in @ 300 PPI) requires —
  with zero transformation. This is the one placement where a real,
  unfabricated "ready" result is achievable today.

**Conclusion:** neither the existing local tooling nor the existing
provider can genuinely manufacture full-back/left-chest production detail
from a 1024x1024 source. Phase 2C therefore implements the full worker and
production-asset lifecycle (Goal 5's "smallest honest implementation"), but
teaches `PrintValidationCapability` to tell the difference between pixels
that carry real detail and pixels that were merely stretched to fill a
frame — see "Resolution provenance" below — rather than architecting
validation to pass merely because a file got bigger.

### Pipeline

```
FinalDirectionApproval ("active")
        ↓
FinalArtworkJob ("queued")
        ↓
FinalArtworkWorkerCapability.processNextJob   ← independent worker; never
        │                                       invoked from a customer
        │                                       request; atomic claim
        │                                       mirrors GenerationWorker
        ↓
Resolve exact input: active approval, exact ArtworkVersion, approved
DesignBriefVersion, source concept AssetRecord — reject a superseded
approval, a cross-project asset, or a missing source asset
        ↓
deriveProductionRequirements (reused, unchanged, from PrintValidationCapability)
        │  unsupported production method or unknown print location →
        │  job completes honestly WITHOUT producing an asset
        │  (PrintProject.status = "finalization_required")
        ↓
FinalArtworkProvider.produce           ← provider-neutral boundary
        │  (LocalRasterInterpolationProvider: local, deterministic,
        │   pure-JS "contain" resample + transparent padding — no
        │   network call, no paid provider)
        ↓
AssetCapability.uploadProductionAsset  ← finalArtworkJobId + explicit
        │                                productionRole set
        ↓
PrintValidationCapability.validateArtwork   ← AUTHORITATIVE this time —
        │   same pure capability as Phase 1/2A, given the real production
        │   asset via assembleAuthoritativeProductionPrintValidationInput
        ↓
ProductionAssetValidation persisted (append-only, per production asset)
        ↓
PrintProject.status = "print_ready"  ⟺  report.status === "ready"
                     = "finalization_required"  otherwise
```

### Target physical size policy (Goal 4)

No new sizing table was invented. `deriveProductionRequirements` (Sprint
2M Phase 1) already resolves target dimensions from
`shared/print-placement-dimensions.ts`, keyed by the existing
`PrintPlacement` enum.

> **Superseded by §13e (Print-Ready Normalization Phase 1).** Phase 2C
> treated each placement's figures as a fixed *canvas* (`full_front` /
> `full_back` = 12x14in → a 3600x4200px plate, artwork centred inside
> transparent padding). The production deliverable is now sized by physical
> print WIDTH with height derived from the artwork's own aspect ratio, and
> those per-placement figures are the printable *envelope*, not the plate.
> See §13e for the current contract and the current numbers.

When `printPlacement` is unknown, or the production category isn't
`apparel_raster`, the worker refuses to guess — it completes the job with
an honest internal reason and `PrintProject.status = "finalization_required"`,
never a fabricated size (Goal 4).

### Raster production strategy (Goal 5/6)

`LocalRasterInterpolationProvider` (`capabilities/final-artwork/local-raster-provider.ts`,
math in `raster-transform.ts`) resamples the source concept, preserving
aspect ratio and never cropping. It never redraws, regenerates, or
reinterprets content (Goal 7 — the approved design is preserved exactly,
just resampled), which is what lets required-wording verification honestly
transfer from Concept Evaluation (see below) rather than needing fresh OCR
infrastructure this sprint doesn't have.

> **Superseded by §13e.** Phase 2C fit the resampled artwork into a fixed
> canvas inset by `ProductionRequirements.artworkBoundaryMarginPercent` and
> padded the remainder with transparent pixels. Every provider now runs its
> raster through the one shared production transform in
> `final-artwork/production-normalization.ts` instead; the artwork defines the
> canvas.

`FinalArtworkProvider` (`capabilities/final-artwork/provider.ts`) is the
replaceable boundary: domain code (`FinalArtworkWorkerCapability`) depends
only on this interface, never on `pngjs` or any transformation detail. A
future provider-hosted reconstruction adapter would implement the same
interface behind its own explicit, default-off opt-in (mirrors
`CONCEPT_GENERATION_ENABLE_REAL` — Goal 20); `resolveFinalArtworkProvider()`
is the one composition-owned resolution point.

### Resolution provenance — the honesty mechanism (Goal 5/9, "Upscaling Truthfulness")

`PrintValidationAssetSummary` (`print-validation/contracts.ts`) gained:

- `resolutionProvenance: "native" | "interpolated_upscale" | "unknown"`
- `nativeWidthPx` / `nativeHeightPx` — the true, pre-transformation source
  pixel dimensions

`FinalArtworkProviderOutput` always reports these honestly:
`resolutionProvenance` is `"native"` only when the source content was
shrunk or kept at 1:1 to fit the frame (no pixel fabricated);
`"interpolated_upscale"` when the content had to be stretched beyond its
native pixel density to fill the target canvas.

`print-validation-capability.ts`'s `effective_resolution` and
`minimum_raster_dimensions` checks now judge sufficiency against
`nativeWidthPx`/`nativeHeightPx` whenever provenance is
`"interpolated_upscale"` (or `"unknown"`) — **never** the enlarged file's
literal pixel count. Since an upscale only ever happens because the native
source didn't already meet the target, this means an interpolated
production asset can never accidentally validate `"ready"` merely because
its file dimensions look big enough. A concept whose native resolution
already meets a placement's target (the sleeve case above) validates
`"ready"` with zero fabricated detail — the one genuinely-achievable honest
pass this sprint proves, and exactly what `PrintValidationCapability` was
built to be honest about.

A new `resolution_provenance` check (info severity — never itself
blocking) records which path was used, purely for internal/print-shop
diagnostics (Goal 13).

### Required-wording verification (Goal 8)

Never assumed to transfer automatically. `FinalArtworkProviderOutput`
carries `preservesApprovedContent: boolean`, declared by the provider
itself — `true` for a pure geometric resample (this sprint's only
provider), and the explicit gate a future content-altering
reconstruction/regeneration provider would have to declare `false`.
`FinalArtworkWorkerCapability` only passes the source concept's already-
persisted Concept Evaluation (and its `required_wording` criterion) into
authoritative Print Validation when `preservesApprovedContent === true`;
otherwise it passes `null`, which correctly resolves
`required_wording_verification` to `"unknown"` → `finalization_required`
rather than silently inheriting a verdict that may no longer be true.

### Transparency verification (Goal 9)

`hasAnyTransparentPixel` (`raster-transform.ts`) scans the actual encoded
output's alpha channel — never assumes transparency from provider intent
or from padding having been requested. An opaque result is reported as
such and flows into Print Validation's existing `transparency` check
exactly like any other asset.

### Production asset persistence & classification (Goal 10)

`AssetCapability.uploadProductionAsset` sets `finalArtworkJobId` (already
reserved since Phase 2B) and a new, explicit `AssetRecord.productionRole`
(`"production_png"` today; `"production_svg"`/`"production_pdf"` reserved)
— Goal 10's requirement that the FK alone not be the only signal once one
job can eventually own more than one production asset. No thumbnail is
generated for a production asset (never rendered directly to a customer).

### Authoritative validation persistence (Goal 12)

A new, append-only `production_asset_validations` table/`ProductionAssetValidation`
domain type — never a single status column on `ArtworkVersion` (Phase
2A/2B both audited and rejected that; unchanged reasoning, sharper now that
a real production asset exists: one job may eventually own multiple
production assets, each independently valid or not). A revalidation
inserts a new row; history stays queryable per job.

### Print-ready transition authority (Goal 11)

Only `FinalArtworkWorkerCapability`, after a real
`PrintValidationCapability.validateArtwork` call against a real production
asset, may ever set `PrintProject.status = "print_ready"`. It also guards
against a stale/recovered job stomping a newer direction's status: it only
transitions status when the job's authorizing approval is still the
project's current *active* one (`maybeTransitionProjectStatus`).

### Idempotency (Goal 16)

Deterministic key: `(finalArtworkJobId, productionRole)`. Before
transforming anything, the worker checks whether a production asset
already exists for this job with `productionRole === "production_png"`; if
so, it reuses that asset (never re-downloads, re-transforms, or
re-uploads) and proceeds straight to (re)validation. A retried/recovered
attempt may insert one additional harmless `ProductionAssetValidation` row
— acceptable, mirroring how a retried provisional-validation log line is
tolerated elsewhere.

### Job claim & recovery model (Goal 2)

`final_artwork_jobs` mirrors `generation_jobs`' worker-lifecycle shape
exactly: `queued → running → recoverable → completed | failed | cancelled`,
with `attempts`/`startedAt`/`completedAt`/`heartbeatAt` columns and the
same atomic-claim contract (`claimNextQueuedFinalArtworkJob`, optimistic
conditional update; `recoverAbandonedFinalArtworkJobs`, single atomic
conditional UPDATE, no select-then-write gap). `"cancelled"` means the
job's approval was superseded before it ran (not a pipeline error);
`"failed"` means an infrastructure problem (storage/transformation
failure) — `FinalArtworkCapability.requestFinalArtwork` revives a
`"failed"` job back to `"queued"` on retry, so the customer's existing
"Prepare Print-Ready Artwork" action is the retry path (Goal 21 — no
PowerShell required). A `"completed"` job that landed on
`finalization_required` is never revived — that is a real, honest verdict.

### Deployment (Goal 21)

A second, independent worker — its own protected endpoint
(`POST /api/worker/final-artwork`, same `WORKER_SECRET`) and its own
standalone process (`npm run worker:final-artwork`) — never folded into the
generation worker's endpoint/process. See
`docs/deployment/final-artwork-worker.md`.

### Download boundary (Goal 14) + customer delivery mode

`GET /api/projects/[projectId]/production-artwork/image` →
`conversation-service.getProductionArtworkUrl` →
`FinalArtworkCapability.getCurrentProductionAssetId` →
`AssetCapability.getSignedUrl`. Only ever returns a short-lived signed URL
plus customer-safe metadata (`filename`, dimensions, transparency,
placement/design labels) once `PrintProject.status === "print_ready"`;
every other case (not found, not ready yet) returns a uniform 404. Never
exposes asset/job/provider ids or storage paths.

`GET /api/projects/[projectId]/production-artwork/download` streams the
same authoritative production PNG with a sanitized
`Content-Disposition` filename (e.g. `1988-toyota-mr2-print-ready.png`) —
same authorization gates; never a raw bucket/path.

When `print_ready`, ChatApp enters **delivery mode**:
`FinalArtworkDeliveryCard` is the primary surface (production preview,
metadata, download, Make Another Change). The revision composer is hidden
until the customer explicitly chooses Make Another Change (client-only
reopen; supersession still occurs only when they submit a real revision).
Production output remains an `AssetRecord` and is **not** added to Design
History (creative `ArtworkVersion` lineage only).

### Customer-safe finalization states (Goal 13)

`CustomerFinalizationStatus` gained `"needs_review"` (→ "We need to review
your artwork before it can be finalized"), derived purely from
`PrintProject.status === "finalization_required"` at the same
`conversation-service.ts` choke point as `"preparing"`/`"print_ready"`. No
PPI, dimensions, provider, storage, or validation rule ever reaches this
view.

### Unsupported methods (Goal 17)

Phase 2C supports **raster apparel production PNG only**. SVG, PDF,
embroidery, screen-print separations, banner/sign production, CMYK, and
vector logos are all explicitly out of scope — `requirements.category !==
"apparel_raster"` completes the job honestly without an asset and without
ever reaching `"print_ready"`.

---

## 13d. Topaz Production Reconstruction (Sprint 2M Phase 2E)

### Why

Phase 2C proved the full production lifecycle but was honest that its only
provider (`LocalRasterInterpolationProvider`) cannot genuinely manufacture
full-back/left-chest production detail from a 1024x1024 concept — it only
resamples existing pixels. Phase 2D controlled-bake-off (see
`research/phase-2d-bakeoff/BAKEOFF_REPORT.md`) proved Topaz Labs'
"Transparency Upscale" model performs genuine 4x super-resolution
reconstruction while preserving approved wording/composition and PNG alpha
better than its "Text Refine" sibling. Phase 2E integrates that one proven
mode behind the existing `FinalArtworkProvider` boundary — provider-hosted
reconstruction is a new *implementation* of an existing interface, not a new
architectural layer.

### Provider-independent orchestration

`FinalArtworkWorkerCapability` still depends only on `FinalArtworkProvider`
— it has zero Topaz-specific knowledge. `resolveFinalArtworkProvider()`
(composition-owned, mirrors `resolveConceptGenerationProvider`) resolves
`FINAL_ARTWORK_PROVIDER=local | topaz` (`src/lib/config/final-artwork-provider-config.ts`)
to one of three implementations:

- `LocalRasterInterpolationProvider` — unchanged Phase 2C behavior, the
  default.
- `TopazTransparencyUpscaleProvider` — real Topaz Transparency Upscale
  adapter, selected only when `FINAL_ARTWORK_PROVIDER=topaz` AND
  `TOPAZ_API_KEY` is set.
- `UnavailableFinalArtworkProvider` — `FINAL_ARTWORK_PROVIDER=topaz` without
  `TOPAZ_API_KEY`; `produce()` always throws a typed, safe
  `FinalArtworkUnavailableError`. Never silently falls back to local
  interpolation (see "Local interpolation is never equivalent" below).

Deliberately **not** coupled to `OPENAI_API_KEY`, `CONCEPT_GENERATION_PROVIDER`,
`CONCEPT_GENERATION_ENABLE_REAL`, or `CONVERSATION_UNDERSTANDING_PROVIDER` —
final-artwork reconstruction is its own independent provider boundary with
its own credential and its own explicit opt-in.

### Source vs. reconstructed vs. final-canvas dimensions (Goal 4/5)

Three distinct, never-collapsed measurements flow through the pipeline for
a Topaz-produced asset:

| Measurement | Example | Where it lives |
|---|---|---|
| Source / native | 1024x1024 | `FinalArtworkProviderOutput.nativeWidthPx/HeightPx` — the true, pre-reconstruction concept pixels |
| Reconstructed | 4096x4096 | `FinalArtworkProviderOutput.reconstructedWidthPx/HeightPx` — Topaz's own genuine output, before production normalization; `null` for a provider with no distinct reconstruction stage (local) |
| Normalized production artwork | 3150x3375 | `widthPx`/`heightPx` — the trimmed, physical-size-aware plate (§13e); the artwork's own dimensions, never a fixed canvas |

`TopazTransparencyUpscaleProvider.produce()` performs reconstruction and
production normalization as two internal, sequential steps — it calls Topaz
once (a proportional 4x request derived from the source's own dimensions,
capped to sane bounds, `crop_to_fill=false`, PNG output — the exact Phase
2D-tested configuration) and then runs the SAME shared, deterministic
`normalizeProductionRaster` (`final-artwork/production-normalization.ts`)
`LocalRasterInterpolationProvider` runs, never a second paid Topaz call
merely to reach the production size. Normalizing from the RECONSTRUCTED
raster (the highest-quality raster available in the run) is what keeps the
deliverable from being a crop of an already-padded plate. Domain code
(`FinalArtworkWorkerCapability`) never sees this internal two-step shape —
it only ever calls `provider.produce()` once per attempt.

### Reconstruction provenance (Goal 4/9)

`ResolutionProvenance` (`print-validation/contracts.ts`) gained a third
value: `"reconstructed"`, alongside the existing `"native"` and
`"interpolated_upscale"`. It is never collapsed into either:

- Never `"native"` — a Topaz output is not the customer's untouched pixels.
- Never `"interpolated_upscale"` — Topaz performs genuine provider-side
  super-resolution, not local geometric resampling; treating it as
  fabricated interpolation would be equally dishonest in the other
  direction, and would incorrectly fail effective-resolution/minimum-
  dimensions checks a real reconstruction actually satisfies.

`PrintValidationCapability`'s `honestDimensionsFor()` trusts a
`"reconstructed"` asset's literal `widthPx`/`heightPx` directly — exactly
like `"native"` — because genuine provider-manufactured detail is real
detail, not stretched pixels. `nativeWidthPx`/`nativeHeightPx` are still
recorded (and stay the true pre-reconstruction source size) for audit/log
honesty even though they are not load-bearing for this provenance value.
`checkResolutionProvenance` reports an info-severity `"pass"` for
`"reconstructed"`, distinct from both other cases' wording.

### Source eligibility gate (Goal 6)

Phase 2D exposed a real defect class: an approved concept whose required
wording was not actually present in the source pixels, even though the
brief required it — reconstruction cannot repair an already-invalid
concept. `checkSourceEligibleForFinalization()`
(`final-artwork-worker/source-eligibility.ts`) runs before ANY provider call
(local or paid) and blocks — completing the job honestly without an asset,
`PrintProject.status = "finalization_required"` — only when the source
concept's own, already-persisted Concept Evaluation explicitly resolved
`required_wording.passed === false`. Every softer state (no evaluation yet,
`passed: null`, still `"pending"`) is treated as insufficient evidence to
block spending and lets the job proceed; independent production
verification (next section) remains the backstop. This is deliberately the
smallest gate that satisfies "don't spend money on Topaz reconstructing
artwork already known to be wrong" without inventing a second evaluation
pipeline.

### Independent production verification (Goal 7/9)

A reconstruction provider that cannot honestly declare
`preservesApprovedContent: true` (Topaz never does — a Phase 2D-proven
faithful reconstruction is still not a mathematically-verified one) must
never let the source concept's own Concept Evaluation stand in for
verification of the actual reconstructed OUTPUT. `verifyProductionArtwork()`
(`final-artwork-worker/production-verification.ts`) re-runs the *existing*
`ConceptEvaluationCapability`/`ConceptEvaluationProvider` infrastructure —
never a bespoke OCR implementation, never a new capability — against the
real production asset (via a short-lived signed URL, exactly like
`AssetCapability.getSignedUrl` already provides elsewhere), compared
against the exact approved Design Brief snapshot tied to the
`FinalDirectionApproval` (never a newer, possibly-mutated working brief).

One re-evaluation serves two goals deliberately, rather than inventing two
mechanisms:

- **Required-wording verification (Goal 7):** the resulting
  `required_wording` criterion flows into `PrintValidationCapability`'s
  existing `required_wording_verification` check unchanged.
- **Design-fidelity / review escape hatch (Goal 9):** the resulting overall
  alignment/style/graphics/exclusions criteria flow into the existing
  `concept_evaluation_alignment` check. A reconstruction that visibly
  redrew or lost content is caught the same way a misaligned generated
  concept always has been. `needs_review`/`failed` here is a real,
  persisted verdict — provider success (Topaz returning HTTP 200) is never
  confused with print readiness. A full, separate
  `ArtworkFidelityEvaluationCapability` was deliberately NOT built —
  Phase 2D's n=3 sample and lack of a mathematically-verified fidelity
  detector mean that would be premature; this reuse is the smallest honest
  mechanism available today, and the clean seam for a future dedicated
  capability if evidence ever justifies one.

Safe by construction: when `ConceptEvaluationProvider` resolves to the
deterministic placeholder (the default, no `OPENAI_API_KEY`), every
criterion — including `required_wording` — resolves `passed: null`, which
`checkRequiredWordingVerification` already treats as `"unknown"` → blocking
→ `finalization_required`. Nothing here can fabricate a pass.

`LocalRasterInterpolationProvider`'s path is completely unchanged: since it
always declares `preservesApprovedContent: true`, the worker still honestly
reuses the source concept's own already-persisted Concept Evaluation — no
new re-verification call, no new cost.

### Alpha verification (Goal 8)

Unchanged mechanism, extended honestly: `hasTransparency` on
`FinalArtworkProviderOutput` is always computed by scanning the FINAL,
canvas-fit bytes' actual alpha channel (`hasAnyTransparentPixel`) — never
assumed from provider intent or request parameters — for both providers.
`PrintValidationCapability`'s existing `transparency` check (already tied
to `ProductionRequirements.transparencyRequired`, never an unconditional
"every PNG must be transparent" rule) blocks `print_ready` on an opaque
result exactly as it already did for local interpolation.

### Paid-call idempotency (Goal 3)

`FinalArtworkJob` gained a durable triple (`providerKey`, `providerRequestId`,
`providerStatus` — migration `20260807150000_topaz_provider_idempotency.sql`),
populated via a new `FinalArtworkProviderInput.onProviderRequestSubmitted`
hook that a paid provider calls synchronously the INSTANT it submits a new
request — before any polling. `FinalArtworkWorkerCapability` persists this
immediately, so a worker crash, a lost race between two workers, or a
recovered/stale job retry never causes a second paid submission: on the
next attempt, if `job.providerKey` matches the resolved provider's own
`providerKey`, the worker passes the recorded request as
`existingProviderRequest`, and `TopazTransparencyUpscaleProvider` resumes
(polls/downloads) it instead of submitting again. A request from a
*different* provider (e.g. `FINAL_ARTWORK_PROVIDER` changed between
attempts) is never resumed — a fresh submission happens instead. Only a
`"provider_job_failed"` classification (the provider's own request reached
a terminal Failed/Cancelled state — provably dead) clears the persisted
triple, which is what allows a genuinely-necessary fresh paid submission on
the next retry; every other failure (network blip, timeout, download
hiccup) leaves it alone so a retry resumes rather than resubmits. The
production asset's own existence (`AssetRecord.finalArtworkJobId` +
`productionRole`) remains the primary, already-existing idempotency
boundary from Phase 2C for a job whose provider call already succeeded —
this triple only closes the earlier gap (submitted but not yet
downloaded/persisted).

### Failure/review semantics (Goal 12)

`ProviderError` (`capabilities/providers/provider-error.ts`) gained three
classifications for this sprint: `"auth"` (401/403 — non-retryable, never
logs the key), `"insufficient_credits"` (412 — non-retryable, fails closed,
no retry storm), and `"timeout"` (bounded polling exceeded its budget —
leaves the request resumable). Every provider/infrastructure failure
(auth, credits, timeout, malformed response, download failure, invalid
bytes, unexpected dimensions) fails the `FinalArtworkJob` exactly like a
Phase 2C storage/transformation failure always did — retryable via the
customer's existing "Prepare Print-Ready Artwork" action, never
`print_ready`. An artwork-verification failure (wording mismatch, alpha
failure, fidelity `needs_review`/`failed`) is explicitly **not** treated as
an infrastructure failure — it is a real, persisted `ProductionAssetValidation`
result and `PrintProject.status = "finalization_required"`, exactly like
Phase 2C's honest verdicts. `maybeTransitionProjectStatus`'s existing
active-approval re-check (unchanged from Phase 2C) is what keeps a stale
Topaz result that completes after the customer supersedes their approval
mid-flight from ever making the project appear `print_ready`.

### Local interpolation is never equivalent (Goal 16)

`LocalRasterInterpolationProvider` remains available for tests, development,
and deterministic non-network fallback — but `resolveFinalArtworkProvider()`
never silently substitutes it for a misconfigured/failed Topaz request. If
`FINAL_ARTWORK_PROVIDER=topaz` and Topaz is unavailable or fails, the job
fails honestly; nothing in this pipeline automatically re-runs local
interpolation and reports the same production quality.

### Cost control and observability (Goal 13/14)

At most one NEW paid submission per job attempt (idempotency above ensures
no hidden duplicate). `logFinalArtworkPaidCallDecision` logs, every attempt,
whether a new paid request was actually submitted this run — never inferred
after the fact. `logFinalArtworkReconstructionOutcome` logs the full
lifecycle (project/job/artwork ids, provider key + request id, source/
reconstructed/final-canvas dimensions, verification check statuses, final
validation status, provider latency) — server-side only. Neither function
ever logs `TOPAZ_API_KEY`, signed storage URLs, or raw provider response
bodies.

### Customer/provider privacy boundary (Goal 15/17)

Unchanged customer-facing contract from Phase 2C: **Preparing your
print-ready artwork…** / **Your print-ready artwork is ready** / **We need
to review your artwork before it can be finalized**. "Topaz" never appears
in any customer-facing string. `providerRequestId`, `providerKey`, and
`providerStatus` live only on the internal `FinalArtworkJob` row — never
`ProjectSnapshot`, never `conversation-service.ts`'s `finalization` view
(still exactly `{ status }`).

---

## 13e. Print-Ready Normalization (Phase 1)

### Why

The Print-Ready Production Output Audit measured the live production plate
and found the deliverable contract was wrong. The plate was 3600x4200px —
the fixed 12x14in canvas Phase 2C sized — while the visible artwork inside
it occupied only ~2662x2861px. Roughly half the printer's file was
transparent dead canvas, and because effective resolution was computed
against the canvas rather than the artwork, that padding also inflated every
readiness figure.

For apparel raster output **the production artwork itself defines the
canvas.** There is no fixed rectangle to centre artwork inside.

### Three distinct artworks — never conflated

| Artwork | What it is | Where it lives | Who may change it |
|---|---|---|---|
| **CREATIVE ARTWORK** | The approved design/revision the customer said yes to. The authoritative creative object. | The concept's own `AssetRecord` (`productionRole: null`), reached via `ArtworkVersion.primaryAssetId` | Concept generation / revision only. Production **never** modifies these bytes. |
| **RECONSTRUCTED ARTWORK** | A high-resolution intermediate produced during finalization (e.g. Topaz Transparency Upscale's 4x super-resolution). Same composition, more real detail. | In memory inside `FinalArtworkProvider.produce()`; its dimensions are reported as `reconstructedWidthPx/HeightPx`. **Not persisted in Phase 1** — reconstruction-master persistence is explicitly out of scope. | The provider, once per finalization attempt |
| **PRODUCTION ARTWORK** | The trimmed, normalized, physical-size-aware printer deliverable. | `AssetRecord` with `productionRole: "production_png"` + `finalArtworkJobId` | `FinalArtworkWorkerCapability` only |

Design History remains creative-only: it never shows or references
production artwork (§13c's download boundary is the only customer path to
the deliverable, and only once validation says it is ready).

### Transform order

```
CREATIVE ARTWORK (approved concept bytes — read-only)
        ↓  FinalArtworkProvider.produce()
RECONSTRUCTED ARTWORK (high-resolution raster; never the low-res concept)
        ↓  ─────── normalizeProductionRaster() ───────
        ↓  alpha trim            → the artwork's own bounds (alpha >= 8)
        ↓  safety margin         → max(8px, 0.5% of the bbox's longest side),
        ↓                          clamped to available source pixels
        ↓  target dimensions     → width = targetWidthIn x targetPpi;
        ↓                          height = width x artwork aspect ratio
        ↓  proportional resample → resampleExact (no padding, no distortion)
        ↓  PNG encode            → + pHYs density matching targetPpi
PRODUCTION ARTWORK
        ↓
AssetCapability.uploadProductionAsset (normalization metadata travels with it)
        ↓
AUTHORITATIVE PrintValidationCapability.validateArtwork
        ↓
PrintProject.status = "print_ready"  ⟺  report.status === "ready"
```

The trim happens **after** reconstruction, never before: trimming the
low-resolution concept first would throw away the very pixels the
reconstruction needs. Nothing in this pipeline alters colours, wording,
layout, composition, or any other creative content — it is strictly a
production transformation.

### Sizing contract: `width_constrained_preserve_aspect`

`shared/print-placement-dimensions.ts` owns one policy table, and
`ProductionRequirements.sizing` carries it through to the worker, so no
apparel dimension is ever re-derived inside a worker or provider:

| Placement | Target print width | Printable height bound | Target PPI | Plate width @300 PPI |
|---|---|---|---|---|
| `full_front` | 10.5in | 14in | 300 | 3150px |
| `full_back` | 10.5in | 14in | 300 | 3150px |
| `left_chest` | 4in | 4in | 300 | 1200px |
| `sleeve` | 3in | 3in | 300 | 900px |

Height is **always** derived from the trimmed artwork's aspect ratio.
Artwork whose trimmed proportions are 10.5 x 11.25in produces a 3150x3375px
plate — never 3150x4200, never stretched, never letterboxed.

`maxHeightIn` is a garment-printability bound, not a canvas: only an
unusually tall/narrow artwork reaches it, and when it does BOTH axes are
reduced proportionally (`constrainedBy: "max_height"`, honestly recorded and
honestly reported by validation) rather than the artwork being cropped or
squashed to fit.

The per-placement figures in §13c's table are now the printable
**envelope** — the largest area artwork may occupy. Provisional
(concept-stage) Print Validation still measures against the envelope, since
a generated concept has not been normalized for production at all.

### pixel dimensions ≠ physical dimensions ≠ DPI metadata

Three different things, deliberately kept separate:

- **Pixel dimensions** — how many pixels the file contains
  (`AssetRecord.widthPx/heightPx`).
- **Physical dimensions** — how large the artwork is *intended to print*
  (`ProductionNormalizationSummary.intendedWidthIn/intendedHeightIn`).
- **DPI/density metadata** — a tag inside the PNG (`pHYs`) telling graphics
  software what physical size to open the file at.

**Effective print resolution is calculated from pixels ÷ intended physical
inches.** It is never read from density metadata: rewriting a density tag
adds no image information. All three are made to agree by construction —
physical inches are *derived* from the pixels actually produced
(`widthPx / targetPpi`), and the density tag is written from the same
`targetPpi` — but only pixel geometry is ever authoritative.

`pHYs` is written by `final-artwork/production-png.ts`. `pngjs` (this
repository's only PNG codec) has no `pHYs` support in either direction, so
rather than swap the codec, that module appends the 9-byte ancillary chunk
to bytes `pngjs` already produced, immediately after IHDR (spec-compliant:
`pHYs` must precede IDAT). 300 PPI ≈ 11811 pixels per metre. The image data
is untouched, and every existing decode path keeps working because
conformant decoders — `pngjs` included — skip ancillary chunks they do not
understand.

### Validation: `print_ready` means the NORMALIZED artwork is ready

`PrintValidationInput.productionNormalization` carries the transform's own
measured geometry into authoritative validation, which **recomputes** rather
than trusting any claim in it. Present only for production plates; when
absent, every check behaves exactly as it did for provisional validation.

New blocking checks (all with explicit tolerances — never float equality):

| Check | Blocks when |
|---|---|
| `production_normalization` | The plate's recorded pixel dimensions disagree (>1px) with its recorded physical specification — i.e. something resized the file after normalization |
| `alpha_bound_artwork` | The alpha bounding box is under 16px on either axis — not meaningful printable artwork |
| `transparent_dead_canvas` | Artwork occupancy < 0.8 of the plate (the audited plate sat at ~0.50; a correctly normalized one sits above 0.97) |
| `physical_width_policy` | Intended print width deviates from the placement target by more than `widthToleranceIn` (0.05in). A `max_height`-constrained plate passes with an honest explanation. |
| `aspect_ratio_preserved` | Trimmed vs. produced aspect ratio differ by more than 1% — the artwork was distorted |

Plus `density_metadata` at **info** severity only: it records whether the
embedded density agrees with the intended PPI, and can confirm but never
establish readiness. A plate with a wrong density tag and correct pixel
geometry is still ready; a plate with a correct density tag and insufficient
pixels never is.

`effective_resolution` and `minimum_raster_dimensions` now measure a
production plate against its **intended physical size**, not the placement
envelope — so a legitimately wide plate is never failed for having fewer
pixels than an envelope-shaped one would. Phase 2C's resolution-provenance
honesty is unchanged and still applies first: an `interpolated_upscale`
plate is still judged against its true pre-upscale source dimensions.

### Safe/failure behavior

- **Fully transparent artwork** fails safely: `trimToAlphaBounds` returns
  `no_visible_artwork` (never a 0x0 image, never a crash), the provider
  surfaces it as a transformation failure, and the job can be retried.
- **Fully opaque artwork** is deterministic and documented: the alpha
  bounding box is the whole image, so nothing is cropped and no margin can
  be applied (the box already touches every edge); the artwork passes
  through geometrically unchanged with `sourceFullyOpaque: true`.
  Transparency remains a separately enforced production requirement — the
  transform never fabricates it by padding.
- **Soft glows / anti-aliased edges** survive: the alpha threshold is 8 (not
  128), and the safety margin extends beyond the bounding box, so
  outer pixels carrying very little alpha are preserved rather than cropped
  into a hard edge. Sub-threshold noise outside the artwork does not defeat
  trimming.

### Existing production assets

This phase applies to newly finalized output. No existing asset is
invalidated, deleted, rewritten, or regenerated. If a job whose production
asset predates this phase is ever re-run, the worker finds no recorded
production geometry, reuses the existing asset untouched, and completes
honestly as `finalization_required` (the plate genuinely is un-normalized)
rather than re-affirming print-readiness for a canvas nobody measured.

---

## 13f. Detailed-Description Fidelity (Phase 1)

### The invariant

**Customer content is authoritative** (Principle 15). Everything the customer
asked to see — named subjects, secondary objects, distinct object
categories, counts, positions, orientations, relationships, scene structure,
place context, and explicit include/exclude language — must survive every
deterministic layer between the chat message and the provider request.

Three layer-level rules follow from it:

1. **Conversation Understanding may synthesize language, never content.**
   Rewording, grammar cleanup, and filler removal are in scope. Dropping an
   object, collapsing distinct categories into one ("ski boats, cruiser
   boats and jet skis" → "boats"), losing a count, or discarding a stated
   position is not.
2. **Concept directions control creative treatment, not required subject
   matter.** A direction may simplify *how* something is drawn; it may never
   decide *what* is drawn.
3. **Provider defaults cannot contradict explicit customer composition.** A
   default such as "centered composition" applies only where the customer
   stated nothing.

### Why it exists

The Discovery Bay live acceptance audit established that fidelity was lost
*before* any image model was called. The customer described a lighthouse on
the left, T-shaped waterways, a marina and its position, homes and their
position, and three distinct boat types. Conversation Understanding —
correctly following an instruction to produce "a short phrase a designer
would actually write on a brief" — reduced this to roughly "A design
featuring the Discovery Bay California lighthouse, water shaped like a T,
ski boats, cruiser boats, and jet skis." Every position, the marina, and the
homes were gone. Concept directions then amplified the loss: "Minimal Badge"
instructed "a single small icon or mark, no scene" for a brief that required
a multi-element scene, and the provider prompt's trailing "centered
composition" default competed with "lighthouse on the left".

No provider or model change addresses any of that.

### Precedence (authoritative order)

Applied by `openai-concept-provider.ts`'s `buildPrompt`, stated explicitly
inside the prompt itself, and enforced structurally by
`resolveDirectionTreatment`:

1. Customer required wording and exclusions
2. Customer design description (required content) and stated composition
3. Customer style and color preferences
4. Concept-direction treatment
5. Provider defaults

A lower layer may never contradict a higher one.

### Mechanism

- `lib/domain/design-content-contract.ts` — the one pure reader of a design
  description. Answers `requiresScene`, `hasExplicitComposition`,
  `compositionStatements` (the customer's own clauses, selected, never
  synthesized), `requiredElementCount`, and `requestsRealWorldReference`.
  Deliberately **not** a schema: nothing here is persisted and nothing
  replaces `DesignBrief.designDescription`, which remains the authoritative
  content contract. There is no scene graph, no `requiredVisualElements[]`,
  and no `compositionConstraints[]` — the audit established the free-text
  description can carry the contract on its own.
- `intent-extraction/preserve-design-detail.ts` — the deterministic backstop
  for Conversation Understanding. A strengthened provider prompt is a
  request, not a guarantee, and cannot be regression-tested without a paid
  network call. This module compares the synthesized value against the
  customer's own message and restores only the design-critical clauses that
  genuinely did not survive. It never appends the raw message, and excludes
  garment-color, print-placement, required-wording, and palette-preference
  clauses by construction. Applied on both paths — semantic
  (`reconcile-understanding.ts`) and deterministic (`extraction.ts`) — so
  fidelity does not depend on whether a Conversation Understanding provider
  is configured.
- `lib/domain/concept-directions.ts` — each direction now carries its base
  treatment (correct for a single simple subject, where "one restrained
  icon" is genuinely the right instruction) plus `sceneTreatment` and
  `customerComposedTreatment` overrides. `resolveDirectionTreatment` is the
  one place they are resolved against the content contract. The three
  directions still differ sharply: fidelity is achieved by constraining what
  a direction may *remove*, never by making the three prompts converge
  (Constitution §13 still requires three genuinely useful options).
- `providers/openai-concept-provider.ts` — the initial-generation prompt is
  sectioned by priority (`REQUIRED DESIGN CONTENT`, `COMPOSITION`,
  `REQUIRED WORDING`, `STYLE / CREATIVE TREATMENT`, `DO NOT OMIT`,
  `PRIORITY`, `CREATIVE FREEDOM`) rather than one flat sentence in which
  "Subject:" carried no more weight than "Iconography:". The customer's
  additional instructions are now consumed on this path too, instead of
  only on the edit path.

### Real-world geography

Text-only generation **cannot** guarantee real-world geographic accuracy
without reference grounding. When a customer asks for a real place
("make it like the actual area", "look up an aerial view"), the request is
preserved rather than dropped, and the provider prompt answers it honestly:
approximate the arrangement from the customer's own description, no external
map or aerial reference is available, do not invent landmarks, do not imply
survey accuracy. Reference-image grounding is a later phase; nothing in
Phase 1 may claim map accuracy.

### What the automated tests do and do not prove

The regressions in
`intent-extraction/detailed-description-fidelity.test.ts` and
`providers/concept-prompt-fidelity.test.ts` prove what iHeartPrints
**sends** — that customer requirements survive every deterministic layer and
appear in all three provider prompts, and that no direction's styling
contradicts them. They make no network calls and prove nothing about image
model compliance. That remains a live-acceptance question. See §24.

---

## 14. Background Worker Architecture

Two independent job queues, two independent workers — deliberately never
merged into one "run everything" scheduler (Sprint 2M Phase 2C, Goal 21):

| | Concept generation | Final artwork production |
|---|---|---|
| Job table | `generation_jobs` | `final_artwork_jobs` |
| Scheduler | `GenerationSchedulerCapability` | `FinalArtworkSchedulerCapability` |
| Worker | `GenerationWorkerCapability` | `FinalArtworkWorkerCapability` |
| Claim method | `claimNextQueuedJob` | `claimNextQueuedFinalArtworkJob` |
| Endpoint | `POST /api/worker/generation` | `POST /api/worker/final-artwork` |
| Standalone script | `npm run worker` | `npm run worker:final-artwork` |

Job states (both queues, identical shape): `queued` → `running` →
`completed` | `failed` | `cancelled`; abandoned `running` → `recoverable`
(claimable again).

Mechanics (both queues, identical shape):

- Atomic claim — local mutex or Supabase conditional update
- Batch size: `MAX_GENERATION_JOBS_PER_RUN` (default 5; shared config knob
  — the two worker types are never mixed in the same batch)
- Heartbeats during work; stale threshold default 15 minutes
  (`DEFAULT_STALE_JOB_MS` / `DEFAULT_FINAL_ARTWORK_STALE_JOB_MS`)
- Stale-job recovery → `recoverable`
- Shared retry budget (`MAX_GENERATION_ATTEMPTS` / `MAX_FINAL_ARTWORK_ATTEMPTS`)
- Idempotent completion (`alreadyGenerated` short-circuit / existing
  production-asset short-circuit — see §13c)
- Browser polling (generation status and finalization status) is read-only
  in production. While customer-safe `finalization.status === "preparing"`,
  ChatApp polls `GET /api/projects/[projectId]/finalization/status` every
  few seconds and refreshes the snapshot once it leaves `preparing`.
  Polling never revives failed/running/cancelled/completed jobs and never
  calls a provider itself. Interactive `next dev` only may kick an
  in-process final-artwork batch when a job is still `queued` with
  `attempts=0` behind an active approval (missed trigger / stale HMR) —
  see `maybeRecoverStrandedLocalFinalArtworkJobs`. Generation has the
  parallel `maybeRecoverStrandedLocalGenerationJobs`.

### Deployment topologies

1. **Protected scheduled worker endpoint** — external cron/Function hits
   `POST /api/worker/generation` and/or `POST /api/worker/final-artwork`
   with `WORKER_SECRET` (documented for DigitalOcean App Platform-style
   hosting)
2. **Standalone worker process** — `npm run worker` and/or
   `npm run worker:final-artwork`, run as separate processes
3. **Interactive local `next dev` only** — after durable enqueue,
   `maybeTriggerLocalGenerationWorker` / `maybeTriggerLocalFinalArtworkWorker`
   may call the matching scheduler's `runBatch()` in-process so Approve/
   Create Concepts and Prepare Print-Ready progress without a manual
   worker POST. Shared suppression policy
   (`local-generation-trigger-policy.ts`): never in production, never when
   `IHEARTPRINTS_AUTOMATED_TEST=1`. The web process is **not** the
   production worker.
4. **Future external queue** — only scheduler topology should need to
   change; worker business logic stays put

See `docs/deployment/generation-worker.md` and
`docs/deployment/final-artwork-worker.md`.

Business logic remains inside `GenerationWorkerCapability` /
`FinalArtworkWorkerCapability` regardless of topology.

---

## 15. Worker Security

Implemented in `src/capabilities/worker-scheduler/worker-auth.ts`, shared
by both `src/app/api/worker/generation/route.ts` and (Sprint 2M Phase 2C)
`src/app/api/worker/final-artwork/route.ts` — one auth module, one shared
`WORKER_SECRET`, one shared in-memory rate limiter; the two endpoints
differ only in which scheduler they call.

- `WORKER_SECRET` via `Authorization: Bearer …` or `X-Worker-Secret`
- Constant-time comparison (SHA-256 digest + `timingSafeEqual`)
- Production fail-closed if secret unset
- Non-production fallback to a clearly labeled local-only secret
- In-memory auth failure rate limit (single-instance; not shared across
  horizontally scaled replicas)
- Success response is generic (`{ ok: true }`)
- No project ids, queue details, provider names, or stack traces returned

Deployment details: `docs/deployment/generation-worker.md`.

---

## 16. Asset Architecture

- `AssetCapability` orchestrates upload, metadata, signed URLs, delete
- `AssetStorageProvider` port isolates backends
- Object hierarchy: `projects/{projectId}/concepts/{conceptId}/{fileName}`
- Original + thumbnail assets (thumbnail failure is non-fatal)
- Metadata may store sanitized provider envelopes — never credentials or
  prompt text
- Signed URL defaults: 300s; hard max 900s
- Raw object keys remain internal
- Cleanup deletes storage bytes if DB persist fails after upload

### Customer-safe concept-image read path (Sprint 2K Phase 1)

The browser never receives asset ids, object keys, or persisted signed URLs.
It asks for a short-lived URL by `artworkVersionId` only:

```
Browser
  → GET /api/projects/{projectId}/concepts/{artworkVersionId}/image
  → conversation-service.getConceptImageUrl
  → AssetCapability.getSignedUrl(primaryAssetId)
  → short-lived { url }
```

- Signed URLs are minted on demand per request
- Signed URLs are never persisted (not in snapshots, artwork rows, messages,
  or client storage as authority)
- Raw object keys and asset ids remain internal; only `{ url }` leaves the
  image endpoint
- Cross-project artwork lookups are rejected (`artwork.projectId` must match
  the route `projectId`; missing project/concept/image all yield the same
  generic 404)
- After reload, the UI refetches a fresh signed URL via the same endpoint
  (`ConceptCards` — see §20)

Worker-side evaluation uses the same `AssetCapability.getSignedUrl` minting
path (§13); that URL is request-path only and must never be copied into
persisted evaluation payloads.

Orphan risk: if the process hard-crashes after bytes land in storage and
before the asset row is written, automatic cleanup cannot run. Soft
failures after upload are cleaned up in-process.

Modes: see §5. Development-oriented: `data_uri`, `filesystem`.
Production-oriented implemented: `supabase_storage`. Reserved:
`s3`.

---

## 17. Asset Security

- Private Supabase bucket `design-assets` (`public = false`); no public-read
  policies
- Service-role server boundary for storage access
- Customer access via signed URLs only (minted on demand; never persisted)
- Bounded expiration
- Canonical object-key validation and traversal protection
  (`filesystem-paths.ts`: reject `..`, absolutes, backslashes, null bytes,
  percent-encoded traversal)
- Filesystem root containment under `.data/assets`
- Encoded-path rejection (iterative decode)
- Filesystem signing via `ASSET_SIGNING_SECRET` (dev fallback when unset)
- Customer snapshots never expose raw storage keys, asset ids, or signed
  URLs — only `hasImage` plus public concept presentation fields (§19)

Do not document or commit actual secrets.

---

## 18. Persistence Architecture

Interface: `ProjectRepository` (`src/lib/db/repository.ts`)

| Implementation | When selected |
|---|---|
| `LocalProjectRepository` | Supabase env not configured; `.data/sprint1-store.json` |
| `SupabaseProjectRepository` | `NEXT_PUBLIC_SUPABASE_URL` + service-role or anon key |

Parity expectations: both implement the same repository contract including
atomic job claim/heartbeat/recovery, asset CRUD, and Concept Evaluation
updates (`updateArtworkEvaluation`).

Other notes:

- Forward-only SQL migrations under `supabase/migrations/` (see
  `docs/database/MIGRATION_WORKFLOW.md`)
- Local mutex serializes store access; Supabase uses conditional updates
- Interview state, approved versions, generation jobs, assets, and concept
  evaluation fields on artwork versions persist
- Sprint 2M Phase 2B: `final_direction_approvals` (unique partial index —
  at most one `"active"` row per project) and `final_artwork_jobs` (unique
  `(project_id, final_direction_approval_id)`) persist; `assets` gained a
  reserved, nullable `final_artwork_job_id` — see
  `supabase/migrations/20260806190000_final_artwork_lifecycle.sql`
- Sprint 2M Phase 2C: `final_artwork_jobs` gained `attempts`/`started_at`/
  `completed_at`/`heartbeat_at` and a `"recoverable"` status (mirrors
  `generation_jobs`' worker-lifecycle columns exactly); `assets` gained
  `production_role`; a new append-only `production_asset_validations`
  table persists authoritative Print Validation runs; `project_status`
  gained `"finalization_required"` — see
  `supabase/migrations/20260807140000_final_artwork_production_pipeline.sql`
- Derived values recomputed rather than stored as authority: concept
  status batches, brief evaluation, intelligence assessment, revision
  impact, summary views, customer-facing `finalization` status

---

## 19. API and Service Boundaries

Service facade: `src/lib/services/conversation-service.ts` — thin
delegation to composed capabilities.

| Route | Responsibility |
|---|---|
| `POST /api/projects` | Start conversation/project |
| `GET /api/projects/[projectId]` | Load snapshot |
| `POST /api/projects/[projectId]/messages` | Handle user message |
| `POST /api/projects/[projectId]/brief/decision` | Approve / edit on Design Summary (Sprint 2L Phase 1B: "continue" removed — see §10b) |
| `POST /api/projects/[projectId]/concepts/regenerate` | Explicit updated-concept enqueue |
| `GET /api/projects/[projectId]/concepts/[artworkVersionId]/image` | Mint short-lived concept image URL (Sprint 2K Phase 1) |
| `GET /api/projects/[projectId]/generation/status` | Read-only generation status |
| `GET /api/projects/[projectId]/finalization/status` | Read-only customer-safe finalization status (`not_requested` / `preparing` / `needs_review` / `print_ready`) |
| `POST /api/projects/[projectId]/select` | Select concept |
| `POST /api/projects/[projectId]/finalize` | Sprint 2M Phase 2B: explicit final-direction approval + idempotent finalization request |
| `GET /api/projects/[projectId]/production-artwork/image` | Mint short-lived production-PNG URL + customer-safe metadata once print-ready (delivery preview) |
| `GET /api/projects/[projectId]/production-artwork/download` | Stream print-ready production PNG with customer filename (`Content-Disposition`) |
| `POST /api/projects/[projectId]/undo` | One-level undo |
| `GET /api/assets/[...objectKey]` | Serve filesystem signed assets |
| `POST /api/worker/generation` | Independent concept-generation worker batch (secret-protected) |
| `POST /api/worker/final-artwork` | Sprint 2M Phase 2C: independent final-artwork worker batch (secret-protected) |

### Customer snapshot sanitization (Sprint 2K Phase 1)

`conversation-service` is the single choke point that shapes internal
`ArtworkVersion` into browser-safe `CustomerArtworkVersion` before any
snapshot leaves the server (`toCustomerArtworkVersion` /
`toCustomerConceptStatusView` in `shared/contracts.ts`).

Excluded from customer responses (redacted to `null`):

- generation provenance (`generationJobId`)
- asset references (`primaryAssetId`, `thumbnailAssetId`)
- provider identity (`providerKey`)
- Concept Evaluation fields (`evaluationStatus`, `evaluation`,
  `evaluationEvaluatedAt`, `evaluationProviderKey`)
- Print Validation fields (`printValidationStatus`)

The only added customer-facing image signal is `hasImage` (whether a
generated primary asset exists). The browser uses `artworkVersionId` +
`hasImage` to call the concept-image route; it never needs an asset id.

Image route rules: mint on demand via `getConceptImageUrl` →
`AssetCapability.getSignedUrl`; return `{ url }` only; never persist the
URL; reject cross-project lookups; uniform 404 on every miss.

Rules:

- Routes validate/translate requests (often with zod)
- Services/facades call capabilities
- Routes must not implement product rules
- Generation status polling is read-only in production / automated tests;
  interactive `next dev` may recover a stranded `queued`/`attempts=0` job
- Finalization status polling is read-only and never dispatches work
- Worker invocation is independent of customer traffic in production
  (scheduler, protected endpoint, or standalone process)
- Brief decision and regenerate routes never await generation; interactive
  `next dev` only may kick `workerScheduler.runBatch()` after enqueue
  (`local-generation-trigger.ts`). Finalize / finalization-status routes
  mirror that for FinalArtworkJob (`local-final-artwork-trigger.ts`).
  Automated tests stay isolated.
- Snapshot-returning routes must not bypass `conversation-service`
  sanitization

---

## 20. UI Architecture

Primary surface: `src/components/chat/ChatApp.tsx` (rendered from
`src/app/page.tsx`).

| Component | Role |
|---|---|
| `ChatApp` | Session bootstrap, send, decisions, regenerate, undo, polling |
| `MessageBubble` | Transcript rendering |
| `DesignSummaryCard` | Approve / Edit (Sprint 2L Phase 1B: "Continue" removed as redundant with Edit — §10b); the prose transcript message for this turn is suppressed while this card is the latest message (§10b) |
| `ConceptStatusBanner` | Needs-update + regenerate / keep current |
| `RecommendationCard` | Advisory actions → normal chat replies |
| `DesignerDecisionCard` | Deferred “designer will determine” display |
| `DesignHistory` | Single consolidated design-history surface — see below |
| `ConceptCards` | Concept selection grid: loading state, real signed image, or safe placeholder fallback (Sprint 2K Phase 1); no customer-facing provider/settings |
| `PrepareForPrintAction` | Sprint 2M Phase 2B: the one explicit "final direction approval" action + truthful "preparing"/"print ready" states; plain customer language only — never job/asset/validation terminology |
| `Composer` | Message input |
| `chat-session.ts` | localStorage project id restore/create |
| `status-poll-controller.ts` | Shared read-only generation + finalization status poller |
| `use-is-client.ts` | Hydration gate |

Polling: while `project.status === "generating"`, poll generation status
every few seconds; on exit from generating, refresh full snapshot. While
customer-safe `finalization.status === "preparing"`, poll finalization
status every few seconds; on a terminal customer state (`print_ready`,
`needs_review`, or `not_requested`), refresh full snapshot and stop. Both
pollers share `createStatusPollController` (cleanup on unmount / project
change, Strict Mode safe, bounded consecutive errors).

`ConceptCards` (Sprint 2K Phase 1) fetches signed image URLs only for
concepts with `hasImage: true`, via
`GET /api/projects/{projectId}/concepts/{artworkVersionId}/image`. It
renders:

- **loading** — `hasImage` true and URL not yet fetched
- **real signed image** — short-lived URL from the image endpoint
- **safe placeholder fallback** — `hasImage` false, fetch failure, or
  exhausted silent renew after a stale/expired URL

After reload, cards refetch a fresh signed URL; signed URLs are never
treated as durable client state.

**Customer-facing Design History** (Live Acceptance Corrective Pass,
Section 2): a single surface (`design-history.ts` → `buildDesignHistory`,
rendered by `DesignHistory.tsx`) replaced two UI surfaces that used to
render side by side under two different headings and two different data
sources — a message-metadata-keyed timeline that turned every brief-field
edit (including field-only edits like print location that never produced
new artwork) into a milestone, and a separate, differently-labeled
"previous batches" panel. `buildDesignHistory` derives milestones purely
from existing `ArtworkVersion` fields already on the snapshot — `kind`,
`sourceArtworkVersionId`, `designBriefVersionId`, `createdAt` — plus the
project's current `selectedArtworkVersionId`; it never reads brief content
or message metadata, so a brief-field-only edit that never produced a new
artwork version is structurally invisible to it, by construction. Model:
"Original Concepts → Selected Concept → Revision 1 → Revision 2 → Current
Version" (`kind !== "final"` only — finalized/production artwork belongs
to the separate finalization pipeline, not this narrative). No new
persistence; the full internal audit history (every `DesignBriefVersion`,
every field change) is untouched and still recorded exactly as before —
this is only a customer-facing projection. Historical artwork stays
viewable via the same `ConceptCards`/`ConceptPreviewModal` viewer used for
the live concept grid.

The client renders capability-produced facts. It does not decide domain
readiness, approval validity, concept staleness, or generation
eligibility.

Customer-safe terminology only — never model names, job ids, asset ids,
object keys, or storage modes.

---

## 21. Configuration and Production Safety

Relevant environment variables (names only; never commit secrets):

| Variable | Purpose |
|---|---|
| `CONCEPT_GENERATION_PROVIDER` | `placeholder` (default) or `openai` |
| `CONCEPT_GENERATION_ENABLE_REAL` | Kill switch; must be `true` to allow OpenAI adapter even when otherwise configured |
| `OPENAI_API_KEY` | Real provider credential (server-only); shared by concept generation and Concept Evaluation |
| `OPENAI_IMAGE_MODEL` | Defaults to `gpt-image-1` (concept generation) |
| `CONCEPT_EVALUATION_PROVIDER` | `placeholder` (default) or `openai` — Sprint 2I Phase 2, advisory-only (see §13) |
| `OPENAI_EVALUATION_MODEL` | Defaults to `gpt-4o-mini` (Concept Evaluation only; no kill switch — see §13) |
| `CONVERSATION_UNDERSTANDING_PROVIDER` | `none` (default) or `openai` — Sprint 2L Phase 1, best-effort semantic interpretation (see §10a); independent of `CONCEPT_GENERATION_ENABLE_REAL` |
| `CONVERSATION_UNDERSTANDING_MODEL` | Defaults to `gpt-4o-mini` (Conversation Understanding only; text-only chat model; no kill switch — see §10a) |
| `CONVERSATION_UNDERSTANDING_DEBUG` | `false`/unset (default) or `true` — development-only structured pipeline tracing, allowlisted event shapes only, never enabled by default (see §10a "Debugging / structured tracing") |
| `ASSET_STORAGE_MODE` | `data_uri` (default), `filesystem`, `supabase_storage`, `s3` |
| `ASSET_SIGNING_SECRET` | Filesystem signed-URL HMAC (dev fallback if unset) |
| `WORKER_SECRET` | Worker endpoint auth (required in production) |
| `MAX_GENERATION_JOBS_PER_RUN` | Default 5 |
| `WORKER_HEARTBEAT_INTERVAL` | Default 15000 ms |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server persistence/storage |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Allowed for repository selection fallback; insufficient for private storage |

### Readiness matrix (summary)

| Requested provider | Key | Env | Asset mode | `ENABLE_REAL` | Effective |
|---|---|---|---|---|---|
| non-openai | — | any | any | — | placeholder |
| openai | missing | non-prod | any | — | placeholder (dev fallback) |
| openai | missing | production | any | — | unavailable |
| openai | present | production | not supabase_storage/s3 | — | unavailable |
| openai | present | any | ok for env | false/unset | unavailable (`REAL_GENERATION_NOT_YET_ENABLED`) |
| openai | present | non-prod | data_uri ok | true | openai |
| openai | present | production | supabase_storage (or future s3) | true | openai |

**Current safe production mode:**

```
CONCEPT_GENERATION_PROVIDER=placeholder
ASSET_STORAGE_MODE=data_uri
CONCEPT_GENERATION_ENABLE_REAL=false
```

OpenAI is not treated as enabled unless configuration explicitly unlocks it.

Concept Evaluation's own resolution (`resolveConceptEvaluationProvider`) is
deliberately simpler and has no `unavailable`/kill-switch state: requesting
`openai` without `OPENAI_API_KEY` set falls back to the placeholder
evaluator in every environment, including production — see §13 for why that
asymmetry with concept generation is safe.

Conversation Understanding's resolution
(`resolveConversationUnderstandingProvider`) follows the same
never-fail-closed pattern as Concept Evaluation: requesting `openai`
without `OPENAI_API_KEY` set falls back to
`NoneConversationUnderstandingProvider` (always an empty result) in every
environment, including production — see §10a. Default is `none` in every
environment until intentionally turned on.

---

## 22. Testing Architecture

Layers covered by `npm test` / `npm run verify`:

- Unit capability tests
- Orchestration / conversation revision tests
- Repository / Supabase store job tests (fake clients where needed)
- API route tests (assets, generation status, worker)
- UI rendering / SSR tests for chat components
- Migration validation (`npm run validate:migrations`)
- Production build verification (`npm run build` inside `verify`)
- Deterministic provider injection via composition overrides / env in tests
- Conversation Understanding regression scenarios (Sprint 2L Phase 1) drive
  the real `ConversationCapability` with peer capabilities from
  `createCapabilityGraph` and a scripted `FakeConversationUnderstandingProvider`
  (`src/test-support/fake-conversation-understanding-provider.ts`) standing
  in for a real LLM — no network calls; the fixture plays the role of a
  provider's already-parsed JSON response
- Fake Supabase/PostgREST clients in storage and job tests
- `cleanupTempWorkspace` + mutex drain for Windows temp directories
- Worker tests await `runBatch` / `processNextJob` explicitly (no background
  drain helper on the conversation service)

Verification command:

```bash
npm run verify
```

(`lint` → `typecheck` → `typecheck:tests` → `validate:migrations` → `test` →
`build`)

Test counts change over time; do not treat any hardcoded count as
architecture.

---

## 23. Security Boundaries

Summarized:

- Service role stays server-side
- Worker secret stays server-side
- OpenAI key stays server-side
- Private storage + signed URLs
- Object-key canonicalization / traversal guards
- Constant-time worker secret comparison
- No provider information in customer responses
- No raw internal errors in public APIs
- No public job or queue details
- Customer snapshots sanitize artwork through `conversation-service` (no
  asset ids, evaluation, provider, or print-validation fields; `hasImage`
  only)
- Concept images served via on-demand signed URLs; never persisted; never
  cross-project
- Configuration fails closed in production for misconfigured real generation
  and missing worker secret
- Sprint 2M Phase 2B: `POST /api/projects/[projectId]/finalize` resolves
  `artworkVersionId` only through that project's own snapshot — a
  foreign/forged id is indistinguishable from "not found" (404); no
  `FinalDirectionApproval`/`FinalArtworkJob` id, status string, or storage
  detail ever reaches the response, only a derived `finalization.status`

### Current limitations (security-adjacent)

- Filesystem worker auth rate limiting is in-memory / single-instance
- `s3` mode is reserved but unimplemented
- Hard process crash after upload can leave storage orphans
- No live Supabase integration tests in CI (unit/fakes cover contracts)

---

## 24. Current Limitations

Verified against the implementation:

- Real provider generation remains disabled by default
  (`CONCEPT_GENERATION_ENABLE_REAL` defaults false; safe provider default is
  placeholder)
- Independent worker still requires deployment scheduling or a standalone
  process; it is not started by customer HTTP requests
- No live Supabase integration tests in CI
- Filesystem/worker rate limiting is in-memory/single-instance
- PNG thumbnail resizing is basic (`PngThumbnailGenerator`)
- S3 adapter is reserved but not implemented
- Orphan asset cleanup cannot recover from a hard process crash after
  upload and before DB persist
- Concept Evaluation (Phase 1 + Phase 2) persists results — now from a real
  vision-based evaluator when configured — but still does not block, reject,
  rank, or hide concepts from customers; no UI scoring yet. Remains
  advisory-only until a future phase decides to act on it
- Print Validation (Sprint 2M Phase 1) is real, tested, deterministic
  architecture. **Sprint 2M Phase 2A** wires it into
  `GenerationWorkerCapability`, run automatically after Concept Evaluation
  for every generated concept — but only as provisional, logged-only
  intelligence (see §5's "Provisional Print Readiness vs. Final Print
  Validation"). No route or UI calls it. Nothing persists
  `ArtworkVersion.printValidationStatus` — that decision was re-audited in
  Phase 2A, not merely carried over, and remains `null` by design (§5).
  There is still no Final Artwork / Production Artwork capability to act on
  `requiredTransformations`, and no authoritative (post-finalization) Print
  Validation run exists yet — see the Phase 2A report for what that would
  require
- Print Validation infers production category/method from free-text
  Design Brief fields via deterministic keyword matching — not a
  customer-collected production-method field (none exists; Constitution
  §6.6 says it shouldn't). A product description that never uses a
  recognized keyword (e.g. "embroider", "screen print", "banner") is
  correctly classified `"unknown"`/`printMethodConfidence: "unknown"` and
  assumed to be DTF-style raster (the one production path this product
  actually generates artwork for today) rather than left unclassifiable
  outright — this is a coarse heuristic, not language understanding
- `TShirtDesignBrief.intendedPrintWidthIn` exists but is never populated by
  any extraction/interview path and is not carried into
  `DesignBriefSnapshotContent` — Print Validation's target physical
  dimensions are derived from `PrintPlacement` only (a coarse internal size
  table, `shared/print-placement-dimensions.ts`), never a real
  customer-specified physical size
- Banner/sign target dimensions are a single fixed placeholder size
  (36×72in) — the Design Brief has no field for a customer-specified sign
  size, and `PrintPlacement` does not model non-apparel placements at all
- There is no distinct "customer confirmed this as final artwork
  direction" state — `ArtworkVersion.isSelected` /
  `PrintProject.selectedArtworkVersionId` (concept selection) is the
  closest existing mechanism, but selecting a concept only starts the
  revision conversation; it does not freeze or "approve" anything.
  `ProjectStatus`'s `"finalizing"`/`"print_ready"` values are defined but
  never assigned anywhere in the codebase. Print Validation Phase 1
  deliberately does not invent a replacement for this gap (see §5's audit)
- Detailed-Description Fidelity (Phase 1) guarantees only what iHeartPrints
  **sends**. Every regression proves that customer requirements survive the
  deterministic layers and reach all three provider prompts; none proves an
  image model obeys them. Model compliance is a live-acceptance question
- Detailed-Description Fidelity (Phase 1) has no reference grounding, so
  **text-only generation cannot guarantee real-world geographic accuracy**.
  A request to reproduce a real place is preserved and answered honestly in
  the provider prompt (approximate from the customer's description; no map
  or aerial reference available; invent no landmarks; imply no survey
  accuracy) — it is not fulfilled. Reference-image upload/generation is a
  later phase
- `preserve-design-detail.ts` restores lost detail by clause, using generic
  structure (position words, shape words, short-noun-phrase enumeration,
  conversational filler) — not language understanding. Two consequences:
  a multi-element description that states no position and no list (e.g. "a
  bowling ball smashing pins") does not register as `requiresScene`, so a
  direction's minimal treatment still applies to it (the prompt's
  `DO NOT OMIT` / `PRIORITY` sections remain the protection there); and a
  partially-lossy synthesis can be restored with some redundancy — the
  restored clause is appended in the customer's own words even when most of
  it was already present. Restating a detail is deliberately preferred over
  risking its loss
- Concept Evaluation now instructs the vision model that a named subject
  which is absent, a wrong stated count, or a contradicted stated
  relationship is a graphics *mismatch*. That is a prompt-level
  strengthening only — **the system still cannot reliably verify every
  spatial relation in generated output**, and no structural
  composition/spatial verifier exists. Evaluation remains advisory
- Generated concepts are not print-ready production assets
- Print Vault behavior is not implemented
- Ownership/licensing enforcement is not implemented
- Artwork-level `RevisionCapability` is not implemented (conversational
  revision intelligence is)
- Concept cards render real signed images when `hasImage` is true (Sprint
  2K Phase 1); placeholder fallback remains for concepts without images or
  when minting fails
- Optional interview sections `production` / `layoutPreference` are policy-
  reserved without full extraction/rule backing
- Sprint 2J Phase 3 activates Regeneration Intelligence on the explicit
  customer regeneration path only (`GenerationJob.kind === "regeneration"`).
  Initial generation remains brief-only via `GenerationIntent` with
  `regenerationPlan: null`. No automatic regeneration, ranking, retries,
  evaluation gating, or UI changes. Timeline / plan / intent are never
  persisted.
- Sprint 2K Phase 3: inspiration-vs-content detection
  (`creative-reference-extraction.ts`) is deterministic cue-phrase matching,
  not language understanding — it recognizes a fixed set of reference cues
  ("inspired by", "spin off from", "like an old …", "in the style of", …).
  A reference phrased without one of these cues stays in `subject` as
  ordinary content; the OpenAI adapter's blanket "do not depict real
  people/characters/logos" guardrail (independent of whether a phrase was
  actually captured as an inspiration reference) is the defense-in-depth
  backstop for that gap.
- Sprint 2K Phase 3: no per-phase generation latency instrumentation exists
  (provider call vs. asset upload vs. thumbnail vs. evaluation vs.
  persistence). `GenerationJob.createdAt`/`completedAt` and heartbeat
  timestamps allow only a coarse total-attempt duration, not a phase
  breakdown — see the Sprint 2K Phase 3 report for what was and wasn't
  determinable from existing instrumentation.
- Sprint 2L Phase 1: `CONVERSATION_UNDERSTANDING_PROVIDER` defaults to
  `none` in every environment, including production — real semantic
  interpretation is opt-in and has not been enabled; the deterministic
  engine alone drives every conversation until an operator turns it on.
- Sprint 2L Phase 1: `ConversationUnderstandingCapability`'s skip policy
  (single-token replies never call the provider) is a coarse heuristic,
  not exhaustive language understanding — a two-word reply that is
  actually trivial still costs one provider call.
- Sprint 2L Phase 1: no in-repo evaluation harness scores real semantic
  interpretation quality against a labeled dataset — regression coverage
  is deterministic-fixture-based (scripted provider responses), matching
  every other provider in this codebase; a live acceptance test (§ below)
  is the current way to judge real-provider quality end to end.
- Sprint 2L Phase 1 does not change Print Validation, Print Vault,
  Ownership, purchasing/download, concept ranking, or automatic
  regeneration — none of that was in scope.
- Sprint 2L Phase 1B: `naturalizeQuestion`'s contextual rephrasing covers
  only the `productColor` and `graphics` questions — every other question
  keeps its Sprint 2F-era generic phrasing. Broader contextual phrasing
  was deliberately out of scope to avoid a deep `InterviewIntelligence`
  boundary change for this sprint.
- Sprint 2L Phase 1B: `printLocation` is the only section still classified
  `high_value`/ask-worthy. Whether garment color and placement should
  ever become product-dependent (Goal 2 noted "whether these are blocking
  may depend on product/context") is not implemented — both remain
  unconditionally asked when unresolved, regardless of product type.
- Sprint 2L Phase 1B: Design Summary synthesis quality (Goal 8) depends
  entirely on the configured provider's prompt adherence — the
  deterministic fallback (no provider configured, or provider failure)
  does not synthesize and may still surface closer-to-verbatim values for
  `graphics`/`style`/`purpose`/`audience` when a customer volunteers them
  directly rather than through a rich, understood message.
- Sprint 2M Phase 2B: `FinalArtworkCapability.requestFinalArtwork` performs
  no production transformation. Every `FinalArtworkJob` it creates stays
  `"queued"` forever until a future phase adds a worker that claims it — no
  route, scheduler, or standalone process consumes this table yet (mirrors
  how Phase 2A's `PrintValidationCapability` had complete architecture
  before anything called it). `PrintProject.status` can now reach
  `"finalizing"` but nothing in the codebase ever sets `"print_ready"`.
- Sprint 2M Phase 2B: an ordinary post-approval brief revision that does
  *not* trigger regeneration does not retroactively invalidate an existing
  active `FinalDirectionApproval` — only a genuinely new concept batch
  (regeneration) does. `requestFinalArtwork` still refuses to *create* a
  new approval for an already-stale concept, but an approval made just
  before an unrelated, non-regenerating brief edit remains active. This is
  a deliberate scope boundary (Goal 4 talks about invalidating approval
  when "artwork changes," not any brief text edit), not an oversight.
- Without a provider-hosted reconstruction provider configured
  (`FINAL_ARTWORK_PROVIDER=local`), the only production transformation is
  local geometric resampling, and the current concept-generation provider
  (`gpt-image-1`, max `1536x1024`) cannot natively reach full-front/full-back
  (3150px wide) or left-chest (1200px wide) production resolution in its
  *visible artwork* regardless. A full-back or left-chest concept therefore
  honestly resolves `finalization_required`, not `print_ready`, on the local
  provider — this is the system correctly refusing to fabricate readiness, not
  a bug. Only a sleeve-placement concept whose visible artwork already exceeds
  900px can genuinely reach `print_ready` with no reconstruction. Note that
  since §13e this is judged on *trimmed artwork* pixels, not padded canvas
  pixels, so a concept with a wide transparent border needs correspondingly
  more source resolution than its file dimensions suggest.
- Print-Ready Normalization Phase 1 preserves the approved artwork's own
  proportions exactly and never crops or distorts, but it does not attempt
  any aspect-ratio-aware *composition* (e.g. re-flowing a square design into
  a wider layout for a full-back print). The customer approved these
  proportions; production honours them.
- Print-Ready Normalization Phase 1 deliberately does not persist the
  reconstruction master (§13e's RECONSTRUCTED ARTWORK is in-memory only), so
  a re-run at a different physical size re-reconstructs (and, for a paid
  provider, re-spends) rather than re-normalizing a stored intermediate.
- Physical print size still comes from the placement policy table, not from
  the customer: `TShirtDesignBrief.intendedPrintWidthIn` exists but is never
  populated by the interview and is not carried into
  `DesignBriefSnapshotContent`. Garment size is deliberately not asked in
  Conversation Understanding.
- Sprint 2M Phase 2C does not implement vectorization, embroidery
  digitization, screen-print separations, banner/sign production, PDF/SVG
  production output, CMYK conversion, or any paid/network provider call for
  final artwork (Goal 17/20) — `FinalArtworkProvider` is replaceable
  (`resolveFinalArtworkProvider`), but no second implementation exists yet.
- Sprint 2M Phase 2C's secure production-asset download boundary
  (`GET /api/projects/[projectId]/production-artwork/image`) exists and is
  tested but is not linked from any UI — no purchasing/download product
  exists yet (Goal 14's explicit scope limit).
- Sprint 2M Phase 2C's `FinalArtworkCapability.getCurrentProductionAssetId`
  resolves only the *current* active approval's job's production asset —
  there is no customer-facing history of prior production attempts from a
  superseded approval.

Do not treat future work as completed architecture.

---

## 25. Planned Extension Points

Describe attachment points only — not a delivery plan:

| Extension | Attach where |
|---|---|
| ConceptEvaluationCapability | **Phase 1 (architecture) + Phase 2 (first real evaluator) done.** Phase 3+: gating/ranking/regeneration decisions driven by evaluation results; never mutate brief |
| RegenerationIntelligenceCapability | **Phase 1–3 done — see §13a.** Live on explicit regeneration only. Future: richer evaluation-driven guidance / RejectedConceptMemory population; never auto-retry; never generate artwork itself; never mutate the brief |
| RevisionTimelineCapability | **Phase 2–3 done.** Derive ephemeral timelines on regeneration only; never persist |
| GenerationIntent | **Phase 3 done.** Sole PromptTranslation input; immutable; never persisted; never customer-facing |
| PrintValidationCapability | **Sprint 2M Phase 1 (architecture) + Phase 2A (provisional intelligence) + Phase 2C (authoritative, production-asset-scoped run) done — see §5/§13c.** Authoritative status now persists on `ProductionAssetValidation`, never `ArtworkVersion.printValidationStatus` (confirmed correct across three sprints of audit). Future: extend `resolutionProvenance` to a real provider-reconstruction path once one exists; never mutate brief; never confuse with Concept Evaluation |
| **FinalArtworkCapability** / **FinalArtworkWorkerCapability** | **Sprint 2M Phase 2B (approval + idempotent enqueue) + Phase 2C (real worker, raster production, authoritative validation, print-ready transition) done — see §13b/§13c.** Phase 2C supports raster apparel PNG only via one local, deterministic provider. Future: a provider-hosted reconstruction/regeneration `FinalArtworkProvider` (gated behind its own default-off env var, mirroring `CONCEPT_GENERATION_ENABLE_REAL`) that can genuinely exceed native source detail for full-back/left-chest placements; vector/PDF production (`"production_svg"`/`"production_pdf"` `ProductionAssetRole` values are reserved); embroidery digitization; a purchasing/download product built on the existing secure read boundary (§13c "Download boundary"). Must never generate/transform anything Print Validation itself decided; Print Validation must remain pure validation |
| Additional concept evaluation providers | New adapter behind `ConceptEvaluationProvider` (e.g. a dedicated OCR specialist, a different vision model); no domain change |
| Production file generation | New assets linked via `printAssetId` / dedicated kinds |
| Vector output | `vectorAssetId` / SVG asset kinds |
| Mockups | Presentation layer consuming artwork + product context |
| Print Vault | Replace `PrintVaultCapability` stub; ingest only with Ownership rules |
| Additional generation providers | New adapter + config branch; no domain change |
| Real queue/worker service | Replace scheduler topology only |
| Additional product rule packs | `shared/product-rule-packs` + ProductIntelligence |
| Ownership/licensing enforcement | Replace Ownership stub; gate vault/public surfaces |
| ConversationUnderstandingCapability | **Phase 1 (architecture + first real provider) done — see §10a.** Future: expand the supported-section allowlist as new brief sections gain backing fields; richer bounded-context selection; a labeled-dataset evaluation harness; never let it write a `BriefPatchProposal` directly |
| Additional conversation understanding providers | New adapter behind `ConversationUnderstandingProvider`; no domain change |

---

## 26. Architectural Decision Rules

Before implementing a change, check:

1. Does this logic belong in a capability rather than a route or component?
2. Does it mutate the working Design Brief only through DesignBriefCapability?
3. Does it preserve approved versions?
4. Is it provider-neutral at the domain boundary?
5. Does it expose technical complexity to customers?
6. Does it introduce a dependency cycle or prohibited reverse dependency?
7. Does it confuse concept correctness with print validation?
8. Does it preserve idempotency for approval/generation?
9. Does it work for both local and Supabase repositories?
10. Does it remain safe if the browser closes mid-generation?
11. Does environment selection stay in composition/config (not UI/conversation)?
12. Does it require updating this architecture document?
13. Does it remain consistent with the Constitution?

---

## 27. Architecture Change Policy

Significant changes to any of the following must update `ARCHITECTURE.md`
in the same change:

- capability boundaries
- domain ownership
- dependency direction
- persistence contracts
- generation lifecycle
- security boundaries
- approval/versioning rules

Minor implementation changes do not require rewriting this document unless
they alter documented behavior.

When architecture and Constitution appear to conflict, the Constitution
prevails until intentionally amended.

---

## Related documents

- [`IHEARTPRINTS_CONSTITUTION.md`](./IHEARTPRINTS_CONSTITUTION.md)
- [`AGENTS.md`](./AGENTS.md)
- [`docs/deployment/generation-worker.md`](./docs/deployment/generation-worker.md)
- [`docs/deployment/final-artwork-worker.md`](./docs/deployment/final-artwork-worker.md)
- [`docs/database/MIGRATION_WORKFLOW.md`](./docs/database/MIGRATION_WORKFLOW.md)
- [`README.md`](./README.md)
- `.env.example`
