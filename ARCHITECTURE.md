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
   Print Validation (reserved) does not mutate briefs.
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
    enqueue must tolerate retries without duplicating versions or concepts.
14. **Browser closure must not strand generation.** Customer requests only
    enqueue work; an independent worker claims and completes it.

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
  → Intent Extraction
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
| Message handling, intent extraction, brief patch, evaluation, intelligence, interview act, summary presentation | Synchronous within the customer request |
| Design Brief approval (version snapshot + enqueue job) | Synchronous request; generation itself is not |
| Concept generation (provider call, asset upload, concept evaluation, artwork rows) | Asynchronous via independent worker |
| Generation status | Read-only browser polling; never claims or runs jobs |
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
| **Dependencies** | IntentExtraction, DesignBrief, BriefEvaluation, DesignIntelligence, InterviewIntelligence, RevisionIntelligence, DesignSummary, ConceptGeneration, ProjectRepository |
| **Owns** | Turn orchestration, conversation phase transitions, wiring revision/approval/enqueue flows |
| **Must never own** | Direct brief field mutation, provider calls, storage uploads, job claiming |

### IntentExtractionCapability — Active

| | |
|---|---|
| **Responsibility** | Parse customer language into brief patch proposals and intents |
| **Inputs** | Message text, conversation/brief context |
| **Outputs** | `IntentExtractionResult` (`proposals`, `intents`) |
| **Dependencies** | Brief data (read-only), `shared/interview-coverage-policy` |
| **Owns** | Proposal shape; defer/correct/provide detection |
| **Must never own** | Persisting the brief; asking; generating |

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
| **Owns** | Idempotent job creation; status classification of concept batches |
| **Must never own** | Calling providers; uploading assets; claiming jobs |

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

### GenerationWorkerCapability — Active

| | |
|---|---|
| **Responsibility** | Claim job → build GenerationIntent → translate → provider → assets → concept evaluation → artwork → assistant message |
| **Inputs** | Claimed `GenerationJob` |
| **Outputs** | Completed/failed job; artwork versions (with evaluation); assets; customer-safe messages |
| **Dependencies** | ProjectRepository, PromptTranslation, ConceptGenerationProvider, AssetCapability, ConceptEvaluationCapability, RevisionIntelligence (regeneration path), RevisionTimeline + RegenerationIntelligence (via `buildGenerationIntentForJob`) |
| **Owns** | Generation runtime business logic; initial vs regeneration intent assembly |
| **Must never own** | HTTP auth, cron scheduling, browser lifecycle; persisting timeline/plan/intent |

Evaluation failure never discards concepts and never changes customer-facing
copy in Phase 1.

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
| `OpenAIConceptGenerationProvider` | Real image bytes via OpenAI Images API |
| `UnavailableConceptGenerationProvider` | Fail closed with safe error codes |

Resolution: `resolveConceptGenerationProvider` in composition/config layer.

### PrintValidationCapability — Reserved

Stub: `validateArtwork` returns `{ checks: [], overall: "not_run" }`.
Must never mutate Design Briefs. Distinct from Concept Evaluation:

| Concern | Concept Evaluation | Print Validation |
|---|---|---|
| Brief alignment / exclusions / wording / style / palette | Yes | No |
| DPI / transparency / print size / embroidery / raster | No | Yes |
| Phase 1 status | Active architecture; results persisted; does not block UI | Stub only |

`ArtworkVersion.evaluationStatus` / `evaluation` hold Concept Evaluation.
`ArtworkVersion.printValidationStatus` remains reserved null.

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

---

## 6. Capability Dependency Diagram

```
ConversationCapability
    |
    +--> IntentExtractionCapability
    +--> DesignBriefCapability ---------> ProjectRepository
    +--> BriefEvaluationCapability
    +--> DesignIntelligenceCapability
    |         |
    |         +--> ProductIntelligenceCapability
    +--> InterviewIntelligenceCapability
    +--> DesignSummaryCapability
    +--> RevisionIntelligenceCapability
    +--> ConceptGenerationCapability ---> ProjectRepository

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
              +--> ProjectRepository

Shared pure modules (not capabilities):
  interview-coverage-policy, product-rule-packs, concept-relevance,
  question-phrasing, brief-diff, generation-retry-policy
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
`cleanupTempWorkspace` (Windows-safe temp cleanup). Generation is no longer
an in-process fire-and-forget task; tests that need jobs to complete await
`processNextJob` / `runBatch` or the worker route explicitly.

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
| `ArtworkVersion` | Concept (or future revision/final) with brief/job/asset/evaluation provenance |
| `AssetRecord` | File metadata + opaque `storageKey` (internal; not in snapshot) |
| `ConceptEvaluation` | Provider-neutral brief-alignment evaluation payload on an artwork version |
| `RevisionImpact` | Capability contract describing brief-change consequences |
| `BriefEvaluation` | Objective evaluation of the working brief |
| `IntelligenceAssessment` | Recommendations + readiness derived for interview |
| `ProjectSnapshot` | Customer/API aggregate: project, brief, conversation, messages, artwork, brief versions |

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

`ProjectSnapshot` intentionally excludes generation jobs and assets so
customer responses do not carry storage/job internals.

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

---

## 10. Adaptive Interview Architecture

Policy: `src/capabilities/shared/interview-coverage-policy.ts`

| Tier | Sections | Deferrable? |
|---|---|---|
| Required | product, graphics, requiredWording, productColor | No |
| High-value | purpose, audience, style, colors, printLocation | Yes |
| Optional | references, exclusions, additionalNotes, production, layoutPreference | Yes; never asked proactively |

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
11. UI: RevisionTimeline, deferred decision cards, recommendation cards

Concept-relevance sections (`shared/concept-relevance.ts`) currently
include product, productColor, colors, graphics, requiredWording, style,
printLocation. Audience/purpose/exclusions/notes/references do not, by
themselves, mark concepts stale under today’s generation implementation.
These rules may expand once Concept Evaluation gating exists (Phase 2+).

`RevisionCapability` remains a future artwork-level lifecycle stub and is
not the live revision path.

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
10. Assistant message announces concepts ready (customer-safe)

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
| Phase 1/2 | Architecture, persistence, and a real evaluator; still no UI gating | Reserved stub |

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

## 14. Background Worker Architecture

Capabilities:

- `GenerationSchedulerCapability` — recover, then bounded claim loop
- `GenerationWorkerCapability` — business logic per job

Job states: `queued` → `running` → `completed` | `failed` | `cancelled`;
abandoned `running` → `recoverable` (claimable again).

Mechanics:

- Atomic claim (`claimNextQueuedJob`) — local mutex or Supabase conditional
  update
- Batch size: `MAX_GENERATION_JOBS_PER_RUN` (default 5)
- Heartbeats during provider work; stale threshold default 15 minutes
- Stale-job recovery → `recoverable`
- Shared retry budget
- Idempotent completion (`alreadyGenerated` short-circuit)
- Protected endpoint: `POST /api/worker/generation`
- Standalone script: `npm run worker` → `scripts/run-generation-worker.ts`
- Browser polling: `GET .../generation/status` is read-only

### Deployment topologies

1. **Protected scheduled worker endpoint** — external cron/Function hits
   `POST /api/worker/generation` with `WORKER_SECRET` (documented for
   DigitalOcean App Platform-style hosting)
2. **Standalone worker process** — `npm run worker`
3. **Future external queue** — only scheduler topology should need to
   change; worker business logic stays put

See `docs/deployment/generation-worker.md`.

Business logic remains inside `GenerationWorkerCapability` regardless of
topology.

---

## 15. Worker Security

Implemented in `src/capabilities/worker-scheduler/worker-auth.ts` and
`src/app/api/worker/generation/route.ts`.

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
- Customer access via signed URLs only
- Bounded expiration
- Canonical object-key validation and traversal protection
  (`filesystem-paths.ts`: reject `..`, absolutes, backslashes, null bytes,
  percent-encoded traversal)
- Filesystem root containment under `.data/assets`
- Encoded-path rejection (iterative decode)
- Filesystem signing via `ASSET_SIGNING_SECRET` (dev fallback when unset)
- Customer snapshots contain asset ids on artwork rows at most — not raw
  storage keys as UX

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
- Derived values recomputed rather than stored as authority: concept
  status batches, brief evaluation, intelligence assessment, revision
  impact, summary views

---

## 19. API and Service Boundaries

Service facade: `src/lib/services/conversation-service.ts` — thin
delegation to composed capabilities.

| Route | Responsibility |
|---|---|
| `POST /api/projects` | Start conversation/project |
| `GET /api/projects/[projectId]` | Load snapshot |
| `POST /api/projects/[projectId]/messages` | Handle user message |
| `POST /api/projects/[projectId]/brief/decision` | Approve / edit / continue on Design Summary |
| `POST /api/projects/[projectId]/concepts/regenerate` | Explicit updated-concept enqueue |
| `GET /api/projects/[projectId]/generation/status` | Read-only generation status |
| `POST /api/projects/[projectId]/select` | Select concept |
| `POST /api/projects/[projectId]/undo` | One-level undo |
| `GET /api/assets/[...objectKey]` | Serve filesystem signed assets |
| `POST /api/worker/generation` | Independent worker batch (secret-protected) |

Rules:

- Routes validate/translate requests (often with zod)
- Services/facades call capabilities
- Routes must not implement product rules
- Generation status polling is read-only and never dispatches work
- Worker invocation is independent of customer traffic
- Brief decision and regenerate routes enqueue only; they do not run the
  worker inline

---

## 20. UI Architecture

Primary surface: `src/components/chat/ChatApp.tsx` (rendered from
`src/app/page.tsx`).

| Component | Role |
|---|---|
| `ChatApp` | Session bootstrap, send, decisions, regenerate, undo, polling |
| `MessageBubble` | Transcript rendering |
| `DesignSummaryCard` | Approve / Edit / Continue |
| `ConceptStatusBanner` | Needs-update + regenerate / keep current |
| `RecommendationCard` | Advisory actions → normal chat replies |
| `DesignerDecisionCard` | Deferred “designer will determine” display |
| `RevisionTimeline` | Plain-language design history chips |
| `ConceptCards` | Concept selection grid (placeholder visuals today; no customer-facing provider/settings) |
| `Composer` | Message input |
| `chat-session.ts` | localStorage project id restore/create |
| `use-is-client.ts` | Hydration gate |

Polling: while `project.status === "generating"`, poll generation status
every few seconds; on exit from generating, refresh full snapshot.

The client renders capability-produced facts. It does not decide domain
readiness, approval validity, concept staleness, or generation
eligibility.

Customer-safe terminology only — never model names, job ids, or storage
modes.

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
- Configuration fails closed in production for misconfigured real generation
  and missing worker secret

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
- Print Validation is stub-only (`overall: "not_run"`)
- Generated concepts are not print-ready production assets
- Print Vault behavior is not implemented
- Ownership/licensing enforcement is not implemented
- Artwork-level `RevisionCapability` is not implemented (conversational
  revision intelligence is)
- Concept cards currently use placeholder visuals rather than rendering
  signed image URLs in the UI
- Optional interview sections `production` / `layoutPreference` are policy-
  reserved without full extraction/rule backing
- Sprint 2J Phase 3 activates Regeneration Intelligence on the explicit
  customer regeneration path only (`GenerationJob.kind === "regeneration"`).
  Initial generation remains brief-only via `GenerationIntent` with
  `regenerationPlan: null`. No automatic regeneration, ranking, retries,
  evaluation gating, or UI changes. Timeline / plan / intent are never
  persisted.

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
| PrintValidationCapability | Replace stub; validate artwork against approved brief; never mutate brief; never confuse with Concept Evaluation |
| Additional concept evaluation providers | New adapter behind `ConceptEvaluationProvider` (e.g. a dedicated OCR specialist, a different vision model); no domain change |
| Production file generation | New assets linked via `printAssetId` / dedicated kinds |
| Vector output | `vectorAssetId` / SVG asset kinds |
| Mockups | Presentation layer consuming artwork + product context |
| Print Vault | Replace `PrintVaultCapability` stub; ingest only with Ownership rules |
| Additional generation providers | New adapter + config branch; no domain change |
| Real queue/worker service | Replace scheduler topology only |
| Additional product rule packs | `shared/product-rule-packs` + ProductIntelligence |
| Ownership/licensing enforcement | Replace Ownership stub; gate vault/public surfaces |

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
- [`docs/database/MIGRATION_WORKFLOW.md`](./docs/database/MIGRATION_WORKFLOW.md)
- [`README.md`](./README.md)
- `.env.example`
