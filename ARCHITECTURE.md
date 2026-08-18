# iHeartPrints System Architecture

Version 1.2
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

## Product Scope

iHeartPrints is an independent **apparel-design** product. The customer
uses or buys the **artwork**. iHeartPrints does not sell physical garments
and is not a Print'em All feature, print-shop operating system, or
physical-product retailer.

**Product scope is not current production capability** (Constitution
§7.13). The product serves the apparel-design market. V1 implements one
production profile within that market: **raster garment decoration**,
focused initially on **DTF** and **DTG** workflows, because those consume
exactly what this engine produces — a transparent RGB raster file at a
known physical size. Additional apparel production profiles may be added
deliberately later; the current profile is a capability boundary, not the
permanent product boundary. Non-apparel print categories are different:
they are excluded by scope and adding capability would not admit them.

The current product deliverable is the **iHeartPrints Production PNG** for
that supported raster profile: a validated transparent RGB PNG sized to the
selected apparel print dimensions and targeted at **300 PPI**, where pixel
geometry (`production pixels ÷ intended physical inches`) is authoritative.
Embedded PNG density metadata is a hint, never the readiness proof.

`print_ready` means that production validation passed on the production
asset for the current approved apparel production intent within the
supported raster profile, and the customer may download that PNG. It is
**not** a claim of readiness for every apparel-decoration method. It does
**not** mean embroidery digitization, screen-print separations,
sublimation-specific preparation, SVG/vector/PDF production, CMYK, ICC
profiles, a RIP preset, a specific decorator's press/ink/film/powder/
pretreatment settings, garment compatibility, signs/banners/large-format
readiness, promotional-product readiness, or universal print-method
compatibility.

What the system controls is the file: format, transparency, pixel
dimensions, intended physical dimensions, pixel-density target, and the
validation it performs itself. Everything downstream of the file belongs to
the decorator. Decoration-method vocabulary (including "DTF" and "DTG") is
internal — it is a production-profile fact, never customer-facing copy.

Reusable architectural seams (reserved `production_svg` /
`production_pdf` roles, `vectorAssetId`, Print Vault and Ownership stubs,
broader validation categories) may remain in the codebase. They are
**dormant hooks**, not unfinished iHeartPrints V1 requirements. Broader
architecture must not broaden the product.

Print'em All may separately use iHeartPrints technology. That relationship
does not define this product.

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
8. **Customer complexity stays hidden.** Model names, provider keys, job
   ids, object keys, and storage modes are not customer-facing. Apparel
   placement and physical print size **are** customer decisions. The
   production density contract is 300 PPI of the selected physical size,
   judged from pixel geometry, never from PNG density metadata alone.
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
16. **Design intent accumulates across turns; text intent is explicit.** A
    later customer turn ADDS to the design description, REFINES the part it
    contradicts, or REPLACES it only when the customer says so — it never
    silently overwrites what earlier turns established. And "no wording" is a
    positive instruction meaning *no lettering of any kind*, never the same
    thing as an unanswered wording question. See §13g.

---

## 3. System Context

### External systems currently used

| System | Role in iHeartPrints | Replaceability |
|---|---|---|
| Next.js application | HTTP API, UI, composition root host | Framework choice is infrastructure; domain lives under `src/capabilities` |
| Supabase database | Optional durable Postgres persistence | Swappable via `ProjectRepository` (`local` JSON when unset) |
| Supabase Storage | Optional private object storage for generated assets | Swappable via `AssetStorageProvider` |
| DigitalOcean App Platform | Verified production host for the web app; GitHub `main` auto-deploys. Procedure: [`DEPLOYMENT.md`](./DEPLOYMENT.md). Worker scheduling is separate | Hosting topology; does not own business logic |
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

There are **two** first-class workflows. They share the Design Brief, asset
storage, and print-sizing policy, and share nothing else — see §13h for why
they are genuinely different operations rather than two entry points to one
pipeline.

```
CREATE NEW ARTWORK       "design something for me"        (below)
UPLOAD EXISTING ARTWORK  "make MY artwork printable"      (§13h / §13i)
```

Which workflow a project is in is **derived**, not stored: a project with an
`ArtworkPreparation` row is an uploaded-artwork project. There is no workflow
enum column.

### Create New Artwork

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
  → Acquisition entitlement fence (Sprint A4, §23b — one free concept for an
    anonymous prospect; refused here, before any job exists, once spent)
  → Queued Generation Job
  → Independent Worker
  → Prompt Translation
  → Generation Provider
  → Asset Storage
  → Concept Evaluation (real vision-based scoring when configured, otherwise
    placeholder; persisted; still does not block presentation)
  → Concepts Ready
  → Email required to continue (Sprint A4, §23b — after the free concept has
    been delivered; not required of internal or legacy projects)
  → Customer Review / select concept
  → Revision Intelligence / targeted revision
  → Final direction confirmation
  → Apparel placement already on the brief; customer chooses production width
  → FinalArtworkJob
  → Reconstruction if required
  → Production PNG
  → Authoritative Print Validation
  → print_ready
  → Download
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
| Uploaded-artwork upload, analysis, background preparation, approval (§13h) | Synchronous within the customer request — local, deterministic pixel math with no provider call to wait on |

Real provider generation is guarded by configuration
(`CONCEPT_GENERATION_PROVIDER`, asset storage readiness, and
`CONCEPT_GENERATION_ENABLE_REAL`) and may remain disabled. The default safe
mode uses the placeholder provider.

Generated concepts are options for human review. They are **not**
print-ready production assets. Concept Evaluation records whether each
concept aligns with the approved Design Brief but does **not** block
customer presentation. Print Validation is implemented in two roles:
provisional (logged-only, against generated concepts) and authoritative
(against the production PNG; the only run that may set `print_ready`).
See §5 and §13c.

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

Phase 2A (Create New Artwork print-palette contract) adds two more
provider-neutral fields, also derived here from existing brief state — **no
migration**:

- `printPaletteEnforcement: "hard" | "soft" | "none"` — whether
  `preferredColors` is a required print/render palette (hard), a casual
  preference (soft), or absent. Hard is derived when preferred colors
  contrast with the garment **and** the design description still names
  subject/object colors that are not the print palette (including the
  live contrast-resolution pattern: black subject objects + white
  artwork on a black shirt).
- `subjectOnlyColors: string[]` — color words that appear in subject
  semantics but are not part of the print palette (empty unless
  enforcement is `"hard"`). Adapters must preserve subject identity while
  forbidding those colors as dominant ink.

Garment color (`productColor` / `shirtColor`), subject/object color in
`designDescription`, and rendered print palette are three distinct
concepts. Creative directions may vary composition and density; they must
not dilute a hard print palette, no-text, or exclusions.

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
| **Responsibility** | Claim job → build GenerationIntent → translate → resolve source artwork (targeted revision only) → per-intent paid dispatch → assets → concept evaluation → artwork → assistant message |
| **Inputs** | Claimed `GenerationJob` |
| **Outputs** | Completed/failed job; durable `PaidImageIntent` rows; artwork versions (with evaluation); assets; customer-safe messages |
| **Dependencies** | ProjectRepository, PromptTranslation, ConceptGenerationProvider, AssetCapability, ConceptEvaluationCapability, RevisionIntelligence (regeneration path), RevisionTimeline + RegenerationIntelligence (via `buildGenerationIntentForJob`) |
| **Owns** | Generation runtime business logic; initial vs regeneration intent assembly; resolving the source artwork bytes for a targeted revision; deciding whether a paid image is bought or reused |
| **Must never own** | HTTP auth, cron scheduling, browser lifecycle; persisting timeline/plan/intent; provider dialect |

Evaluation failure never discards concepts and never changes customer-facing
copy in Phase 1.

For a targeted revision against an edit-capable provider, the worker resolves
the selected concept's real image bytes through `AssetCapability` and passes
them as `ConceptGenerationRequest.sourceArtwork`. Failure to do so throws
`TargetedRevisionSourceError` and fails the job — there is deliberately no
text-to-image fallback. See "Initial generation vs targeted revision".

#### Paid image idempotency (Phase 2C0.5)

Generation-job ENQUEUE has always been idempotent. Paid EXECUTION was not:
initial generation dispatches three directions sequentially, so OpenAI could
bill Bold and Soft and then Minimal could fail. Nothing durable recorded that
Bold and Soft had already been bought, so a reclaim of that job regenerated —
and re-billed — all three.

The unit that fixes this is `PaidImageIntent`, one durable row per LOGICAL
paid image, in its own `paid_image_intents` table. No existing table could
carry it: `generation_jobs` is one row per job; `artwork_versions` are written
once, in a batch, only after every direction already succeeded (and making
them per-direction would expose a partially-completed concept set, which this
phase must not do); `assets` are written only after the paid call returns,
carry no direction identity, and have no uniqueness constraint. Making a paid
call at-most-once needs a real UNIQUE constraint, so it needs a migration.

**Identity** (`capabilities/shared/paid-image-intent.ts`) binds only durable,
deterministic facts:

```
paid-image:v1:<projectId>:<generationJobId>:<kind>:e<epoch>:<scope>
kind  = initial_concept | targeted_revision | replacement
scope = d=<direction>                       (initial concept)
        t=<targetArtworkVersionId>:d=<direction>  (targeted revision)
        d=<direction>:ri=<replacedPaidIntentKey>  (Phase 2C replacement)
        d=<direction>:r=<replacedArtworkVersionId> (replacement of a
                                                    persisted ArtworkVersion)
```

A Phase 2C replacement names the intent it supersedes (`ri=`) rather than an
`ArtworkVersion` id, because of *when* it happens: replacement is resolved
before any `ArtworkVersion` row exists for the batch, so the thing being
replaced has no customer-visible id yet. The initial intent's own key is the
durable identity it does have, and it is pure over the same durable facts —
so a reclaim rebuilds both keys byte-for-byte and reuses the image.

It never encodes an attempt number, timestamp, UUID, worker identity, or
provider request id — every one of those changes on a reclaim, and any of
them leaking in would make recovery re-buy artwork. Prompt text is
deliberately not hashed: a genuinely different prompt means a different
approved brief version, which means a different job, which is already a
different key. An intentional Explore/new batch owns its own `GenerationJob`
and so lands on different keys by construction.

**Execution ordering** (`generation-worker/paid-image-intent-executor.ts`),
which is where the whole guarantee lives:

1. RESERVE before paying — a durable row exists before any request leaves.
2. REUSE before paying — a succeeded intent short-circuits, no call made.
3. ADOPT before paying — an orphaned asset stamped with the intent key is
   recovered rather than re-bought.
4. AUTHORIZE before paying — `beginPaidImageIntentDispatch` is a conditional
   write; refused means the provider is never contacted.
5. PERSIST before claiming success — "succeeded" means bytes are durably
   stored, not merely returned.
6. FENCE the success write — a `claimToken` refuses a zombie worker's late
   write instead of letting it overwrite the live worker's result.

There is deliberately no fallback that regenerates everything.

**Budget.** Counting INTENTS rather than calls is what makes recovery free:
recovering a succeeded intent matches the same row, and a transport retry
bumps `dispatches` on the same row — only a genuinely new logical intent takes
a new `paid_intent_ordinal`. `unique (generation_job_id, paid_intent_ordinal)`
makes slot allocation atomic under concurrency, and a CHECK bounds it at 5:
three initial directions plus the two replacements Phase 2C spends.

**Customer-visible behavior.** `ArtworkVersion` rows are still created in one
batch after every intent resolves, so no partially-completed concept set is
ever exposed, and direction order is unchanged. Concept Evaluation is
non-billable and is always re-run fresh (never cached on the intent). It can
never cause an unbounded regeneration — the one thing it *can* cause is a
single bounded replacement, described next.

#### Failed paid-intent durability (Phase 2C.2C)

Phase 2C0.5 made the paid DECISION durable. It did not make the paid FAILURE
durable, and a live run showed what that costs. A Soft replacement (ordinal 4,
epoch 1) reached OpenAI, was issued a request id, and was billed. Local
persistence then failed, and the durable row ended `status = reserved`,
`provider_request_id = null`, `last_error = null`, `result = null` — attached
to a `completed` job, under a `concepts_ready` project, with the direction
withheld and the replacement log reporting `paidCallMade: false`. Money had
moved and nothing durable said so.

Three gaps, each fixed at its own layer. **No migration**: every field used
already exists on `paid_image_intents`.

**1. Evidence is written on every begun dispatch, not only at the ceiling.**
`completePaidImageIntent` could only write a TERMINAL status, so a failure
with retries remaining had nowhere to go. The new
`ProjectRepository.recordPaidImageIntentFailure` is its non-terminal
counterpart: same `claimToken` fencing, writes `last_error` and
`provider_request_id`, and touches `status` only when the caller asks for a
terminal write. It never modifies a `succeeded` intent (a durable success is
never downgraded by a late writer) and never clears a request id it already
knows.

The executor also captures the provider request id from the drafts the
provider RETURNED, before persistence runs. Previously it was read only from
successfully-persisted concepts, which made the one case where it matters most
— billed, then local failure — structurally incapable of recording it.

**2. Failures are classified by WHERE they happened**
(`capabilities/shared/paid-image-failure.ts`), not collapsed into an opaque
`local_failure`: `provider_not_dispatched`, `provider_ambiguous`,
`provider_billed_unusable`, `local_decode_failure`, `storage_upload_failure`,
`asset_persistence_failure`, `intent_completion_failure`, `fenced_out`,
`budget_blocked`, `unknown_local_failure`. `ProviderError` remains the sole
authority on provider-side failure and is read rather than replaced; the one
new error type, `PaidImagePersistenceError`, exists because from outside
`AssetCapability` "storage refused the bytes" and "the database refused the
row" are indistinguishable — and those are the two failures that most need
telling apart once money has moved. `describePaidImageFailure` is the single
sanitization choke point: no keys, headers, bytes, base64, or prompt text ever
reach `last_error` or a log line.

**3. `paidCallMade` reflects payment, not asset success.** The replacement
path inferred payment from whether the replacement ASSET completed. It now
reads durable state: the intent's `dispatches` counter moving, AND the
recorded failure class not proving the request never left the process (a DNS
failure increments the counter but bills nothing). An unclassified failure
defaults to "billed" — the expensive reading is the safe one.

**Terminalization is parent-completion hygiene, and only that.**
`recoverAbandonedJobs` only ever sweeps `running` jobs, so a paid intent left
`reserved` with `dispatches > 0` when its job intentionally completes is not
outstanding work — it is a permanently stranded row that reads like outstanding
work. `GenerationWorkerCapability.completeGenerationJob` (the one place a job
is marked completed) fails those intents while preserving `last_error`,
`provider_request_id` and `dispatches`. Each condition is load-bearing:

- only at INTENTIONAL completion — a job that fails or is reclaimed still
  intends recovery, and its intents stay retry-eligible within their existing
  dispatch budget;
- only `dispatches > 0` — failing a never-dispatched reservation would invent
  a spend record;
- fenced on the row's own `claimToken` — if a worker began a dispatch in
  between, the fenced write returns `null` and the live dispatch is left alone.

This changes no budget: 3 initial + at most 2 replacements, 5 logical intents
per job, 3 dispatches per intent, replacement epoch 1. It does not claim
exactly-once external billing — an ambiguous post-dispatch failure remains
re-dispatchable within the unchanged per-intent ceiling.

#### Automatic hard-fail concept replacement (Phase 2C / 2C.3A)

Phase 2B made a deterministic, pixel-level print-palette verdict available
but deliberately acted on nothing. Phase 2C originally treated inferred
`printPaletteEnforcement === "hard"` + deterministic `"fail"` as automatic
paid-replacement authority. **Phase 2C.3A corrects that authority:**

Inferred `"hard"` remains **prompt emphasis / contrast guidance** to the
image model. It is **not**, by itself, authority to purchase another image.

**Trigger** (`generation-worker/hard-palette-replacement-policy.ts`), both
conditions required:

```
deriveExplicitInkRestriction(brief) ≠ null   (high-precision customer language)
AND
deterministic FAIL with evidence that violates that restriction
```

Explicit restriction is derived from existing brief text
(`additionalInstructions`, `exclusions`, `designDescription`) — phrases such
as "white ink only", "one color white ink only", "no black ink", "do not use
black ink". Preferred colors, garment color, subject color words ("black
Harley", "use white so it shows"), and inferred hard enforcement alone are
**not** restrictions.

`warn`, `not_applicable`, soft enforcement, an absent verdict, advisory
garment-matching / imperfect palette-dominance FAILs without an explicit
restriction, and every subjective/vision judgement are explicitly NOT
triggers. Vision can neither cause a replacement nor reverse a hard FAIL
(Phase 2B precedence, unchanged). Phase 2B **measurements** are retained for
diagnostics; only their **spend authority** changed.

**Where it runs.** After every candidate in the batch has been evaluated and
*before* a single `ArtworkVersion` row is written. That position is the whole
design: a customer never sees an *explicit-restriction-violating* concept that
later disappears when it can be replaced. Advisory palette FAILs remain
customer-visible. The rejected original (when withheld after a failed
explicit-restriction replacement) stays fully intact internally — its
`PaidImageIntent` row, its stored bytes, and its evaluation are all preserved
for lineage; nothing is deleted or mutated.

**Bounds.** One replacement per failed direction (epoch fixed at `1` — there
is no epoch 2 and nothing computes one), at most two per job, at most five
logical paid images total. There is deliberately **no replacement counter in
application code**: a replacement is attempted by reserving a paid-intent
slot, and the durable budget refusing that reservation *is* the limit —
refused before the provider is contacted. That is what makes the bound
survive a crash, a reclaim, and two workers racing. Order is catalog
direction order (Bold & Direct, Soft & Illustrated, Minimal Badge), fixed and
independent of async timing, so when all three fail the same two directions
are replaced on every run.

**The replacement request** is the same request as the candidate it replaces
plus one provider-neutral flag, `GenerationPromptRequest.printPaletteCorrection`
(derived via `withPrintPaletteCorrection`, never assembled in the worker).
Same brief, same direction, same hard palette, same wording contract, same
exclusions, same model/quality/size/background — a replacement is that
concept corrected, not a different design, and no quality tier is bumped. The
adapter owns the corrective wording, which names no threshold, reason code,
or number.

**Transparency / outer-canvas contract (Phase 2C.2A + 2C.3A).** Outer canvas
must be real alpha — never an opaque plate, shirt photo, or mockup.
Phase 2C.3A softens the earlier universal ban on garment-matching subject
interiors: intentional dark / garment-matching printed artwork is allowed
unless the customer stated an **explicit ink restriction**. Stronger
prohibition wording is added only when `explicitInkRestriction` is present
on the prompt. Soft/none palettes do not invent the hard outer-canvas block.
The Phase 2C corrective block applies on replacements (now reserved for
explicit-restriction violations) — still without validator numbers or reason
codes. No worker budget, model/quality, or Phase 2B threshold changes.

**Outcome policy** for an evaluated replacement:

| Verdict | Result |
|---|---|
| `pass` | accepted, customer-visible |
| `warn` | accepted — WARN is customer-visible for an original, so applying a stricter bar to a replacement would be incoherent |
| `fail` that still violates the explicit ink restriction | rejected; **no second replacement**; the direction is withheld |
| advisory `fail` without explicit-restriction evidence | accepted (customer judges) |
| `not_applicable` | accepted but forced to `needs_review` — never claimed as verified-compliant |

**Degraded outcomes.** A direction that cannot be rescued after an
*explicit-restriction* replacement failure is withheld rather than shown, so
the customer may receive two concepts instead of three; the completion
message is phrased to match what they can actually see, and the message
metadata carries a `conceptsWithheld` count. **Phase 2D** renders that
count as lightweight customer-safe short-set copy on the concept grid
(never reason codes, evaluator verdicts, or thresholds). If
*no* direction can be delivered, the job fails with
`CONCEPT_SET_UNRESOLVABLE:` rather than completing with an empty set. A
failure while trying to *improve* the batch never destroys it: replacement
resolution cannot throw, and the healthy concepts are always delivered.
Advisory garment-matching alone never withholds and never buys a 4th image.

**No migration.** Phase 2C / 2C.3A adds no column and no table. Spend identity
lives in the existing `paid_image_intents`; verdicts live in the existing
`ArtworkVersion.evaluation` JSONB; explicit restriction is derived in-memory
from existing brief text. The degraded-set signal lives in existing
conversation-message metadata. Observability is
`[concept-generation] hard-palette-replacement` and
`[concept-generation] concept-set-outcome`
(`lib/config/concept-replacement-logging.ts`) — whitelisted fields only,
never prompt text, bytes, or credentials.

**Unit economics (GPT Image 1 medium ≈ $0.042).** Normal 3-concept success and
advisory palette/contrast issues stay at **3 paid intents ≈ $0.126**. One
explicit-restriction replacement ≈ **$0.168**. Two replacements hit the
ceiling at **5 intents ≈ $0.210**. Design-quality heuristics must not turn a
3-call generation into a 4th or 5th paid call.

**Transport policy.** `ProviderError` now carries a `dispatch` state —
`not_dispatched` / `dispatched_ambiguous` / `dispatched_billed` — separate
from its classification, because "why did it fail" and "could it already have
been billed" are different questions. Only provably pre-dispatch failures are
retried at the transport layer; ambiguous and billed-unusable failures
propagate to the paid-intent layer, which owns the durable, cross-worker
dispatch ceiling. Residual risk is bounded and explicit: an ambiguous
post-dispatch failure the provider actually billed can be paid for at most
`MAX_PAID_DISPATCHES_PER_INTENT` times for one image. No provider-side
idempotency key is claimed for this endpoint, because none is documented.

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

Does **not** answer: PPI, transparency, print size, or raster production
geometry — those belong exclusively to PrintValidationCapability.

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
| **Responsibility** | Persist asset metadata; upload concept, production, and customer-supplied images; signed URLs; cleanup |
| **Inputs** | Image bytes + metadata |
| **Outputs** | `AssetRecord` pairs (primary + optional thumbnail); single production or customer-artwork `AssetRecord` |
| **Dependencies** | ProjectRepository, AssetStorageProvider, ThumbnailGenerator |
| **Owns** | Asset lifecycle boundary |
| **Must never own** | Provider prompt dialect; brief mutation |

`uploadCustomerArtwork` (§13h) is deliberately its own method rather than a
reuse of `uploadConceptImage`: every provenance field on the latter
(`providerKey`, `generationJobId`) is wrong for artwork the customer
supplied, and no thumbnail companion is generated because a third asset with
ambiguous provenance would add nothing.

### ArtworkPreparationCapability — Active (Existing Artwork → Print Ready Phase 1)

| | |
|---|---|
| **Responsibility** | The Upload Existing Artwork workflow: ingest, analyze, classify, isolate background, clean edges, record approval |
| **Inputs** | Uploaded image bytes + declared content type + filename; production context (product, garment colour, print location) |
| **Outputs** | `ArtworkPreparation` lifecycle record; immutable `customer_upload` asset; derived transparent `png` asset; `prepared_upload` `ArtworkVersion` on approval; already-phrased customer view |
| **Dependencies** | ProjectRepository, AssetCapability, DesignBriefCapability |
| **Owns** | Upload ingress safety, deterministic analysis, repairability classification, edge-connected background isolation, enclosed-cavity classification, fringe decontamination, prepared-artwork approval |
| **Must never own** | Any provider port (it has none); GenerationJob/FinalArtworkJob creation; mutation of the uploaded original; creative reinterpretation of any kind; customer-facing phrasing of analysis internals |

See §13h. Every operation is local and deterministic — there is no provider
to configure, disable, or accidentally call.

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

### PrintValidationCapability — Active (provisional concept-stage intelligence and authoritative production-asset validation)

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
Customer selects a concept, then explicitly confirms final direction
        ↓
FinalArtworkCapability.requestFinalArtwork  (durable approval + job)
        ↓
FinalArtworkWorkerCapability  (raster apparel PNG only)
        ↓
Authoritative PrintValidationCapability.validateArtwork on the production asset
        ↓
PrintProject.status = print_ready  only if that report is "ready"
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
| PPI / transparency / print size / raster production geometry | No | Yes |
| Status | Active; results persisted on `ArtworkVersion`; does not block UI | Active; pure/recomputed. Provisional concept-stage runs are logged only and never persisted. Authoritative runs persist on `ProductionAssetValidation` and are the only path to `print_ready`. |

#### Production Requirements (`ProductionRequirements`)

`production-requirements.ts` classifies a `ProductionCategory`
(`apparel_raster` / `apparel_vector` / `out_of_scope_product` / `signage` /
`logo_vector` / `unknown`) from already-collected brief text by deterministic
keyword matching. **Current iHeartPrints V1 production is the apparel raster
PNG profile only** — the DTF/DTG-oriented workflows described under Product
Scope.

##### Decoration intent vs. production-output request (Sprint A2)

Three **orthogonal** questions, with sharply different sources. Answering all
three from the same prose was the defect Sprint A2 corrected, and the
separation of *sources* — not merely of concepts — is what makes it safe:

| Question | Field | Source | May change the category? |
| --- | --- | --- | --- |
| Is this apparel at all? | `category` | brief text | Yes — `out_of_scope_product` |
| Were we asked to PRODUCE an artifact we do not make? | `requestedUnsupportedOutput` | **structured state** | Yes — `apparel_vector` |
| What will the customer decorate with? | `printMethod` | brief text | **No** |

**Decoration context** is what the customer says their artwork is
eventually for: "this will be screen printed", "I'm taking this to an
embroidery shop", "the shop is using DTF". It is recorded on `printMethod`
because knowing the intended decoration method is useful downstream
intelligence — and it selects nothing. Before A2, any such phrase forced
`apparel_vector`, whose vector deliverable nothing produces, so the Final
Artwork worker refused the job: an ordinary garment design could not reach
the one production artifact this product actually makes because its owner
mentioned where they were taking it.

**A production-output request** is the customer asking iHeartPrints to
produce a specific artifact it does not make — screen-print colour
separations, embroidery digitization (DST/PES/EXP), a vector/SVG production
file, or sublimation-specific preparation. It is a **structured, persisted
domain value**, `TShirtDesignBrief.requestedProductionOutput`, never a
re-reading of brief prose at the finalization gate.

###### Why structured state, and where it lives

An independent audit of A2's first implementation found that deriving this
from `productSummary`/`designDescription` with regex fails in both
directions, and cannot be repaired by adding more patterns:

- **False positives** — a valid raster job refused because its text merely
  *contains* an artifact word: "no separations are needed", "I already have
  the DST file", "use this SVG as a reference", a shirt whose printed wording
  is `COLOR SEPARATIONS`, a customer called Screen Print Separations LLC.
- **False negatives** — a real request typed in chat ("separate this into
  screens", "create a DST") never reaches those two brief fields, so the
  customer silently receives a PNG that does not answer what they asked.

The interpretation therefore happens **once, where the customer speaks**, and
is persisted:

```
customer message
  → ConversationUnderstanding  (primary; `production` section, closed
                                vocabulary, "explicit" confidence only)
  → shared/requested-production-output.ts  (deterministic backstop when the
                                semantic layer is offline/silent)
  → TShirtDesignBrief.requestedProductionOutput   ← THE AUTHORITY
  → deriveProductionRequirements / the worker gates  (read only)
```

The deterministic backstop is tuned for **precision, not recall**: a missed
detection degrades to the Production PNG (the status quo, still correctable
in conversation), while a false detection silently refuses paid work. It
disqualifies negation, possession ("I already have"), reference/supplied
files, quoted and ALL-CAPS artwork wording, business names, and statements
about the customer's own business.

**Owner: the mutable working brief**, deliberately *not* the immutable
`DesignBriefSnapshotContent` — mirroring `intendedPrintWidthIn`, whose
closest sibling this is. Both are production specifications rather than
creative content, and two consequences make the working brief the only
correct home:

- Asking for separations must not restyle artwork, supersede an approved
  brief version, or mark existing concepts stale. Nothing about the *design*
  changed.
- It must be **retractable**. "Actually, just give me the PNG" resolves to
  `production_png`, which behaves identically to `null`. Frozen into an
  approved version, one sentence would strand a project permanently.

**One field serves both workflows.** Existing Artwork uploads share the
project, brief, and conversation with Create New, so an upload customer's
"create separations from this" lands on the same field and is honored at the
same gate — no `ArtworkPreparation` column, and no fabricated
`DesignBriefVersion`.

`null` means *unspecified* — every historical project, and the default for
every new one — and resolves to the supported Production PNG path exactly as
before the field existed. An **unrecognized** stored value is a different
thing entirely and must never be merged with it: `null` is a fact ("never
asked"), while an unreadable string is an absence of knowledge ("asked for
something this build cannot interpret"). It resolves to
`UNRECOGNIZED_PRODUCTION_OUTPUT` and **fails closed** — no production, no
`print_ready`, no provider dispatch. An older app that cannot tell what a
customer requested must refuse rather than guess PNG on their behalf.

###### Job-bound intent and the stale-intent fences (A2 Correction 2)

The field above is deliberately mutable — customers change their minds, and a
request must be retractable. That makes it unusable *on its own* as job
authority: a job carried no record of what it was for, so it had to re-read a
moving value and hope. Three failures followed, all temporal:

1. A running PNG job could still set `print_ready` after the customer had
   asked for separations.
2. A completed unsupported job was returned as "already requested" after a
   retraction to PNG, so finalization never re-ran and the project stuck.
3. An existing `print_ready` PNG kept telling the customer their work was
   done after they had asked for something else.

`FinalArtworkJob.requestedProductionOutput` snapshots the project's current
intent **at enqueue** and is immutable after
(`UpdateFinalArtworkJobInput` cannot express a change to it). Every gate then
asks one question — *does this job still answer what is being asked?* —
via `productionIntentMatches`:

| Moment | Rule |
| --- | --- |
| Job creation | Snapshot the server's current persisted intent. A stale tab cannot smuggle an outdated one — nothing is read from the caller. |
| Queued, intent changed | Worker supersedes it. No provider work. |
| Before provider dispatch | **Fence.** Mismatch → `cancelled`, before any call, local or paid. |
| After provider submission | The work finishes and the plate is kept — but it does not become authoritative. Never a second submission. |
| Before `print_ready` | **Fence.** Mismatch → no status transition. The artifact survives; the claim is not made. |
| Completed | Historical evidence for the intent it was created for. Never satisfies a different one. |

Superseded jobs are `cancelled`, never `failed`: nothing failed, and `failed`
is the one status the customer view reads as a retryable infrastructure
problem. They are not deleted either — coming back to that intent **re-queues
the existing job**, which is what makes PNG → unsupported → PNG return the
already-produced (and for uploads, already-paid-for) plate instead of buying
it twice.

Intent is therefore part of **job identity**, alongside the approval (or
preparation + width). The unique indexes use
`coalesce(requested_production_output, 'production_png')` so a legacy NULL row
and an explicit `'production_png'` row remain one key — without that, an old
row would stop deduplicating and a double click could produce a second job,
and for uploads a second paid reconstruction. `normalizeProductionIntent`
mirrors that expression in the domain; the two must not drift.

Finally, the customer-facing state is derived from **current intent + the job
bound to it**, not from `project.status` alone. `project.status` durably
records what the pipeline last achieved — a fact about the past. A customer
holding a `print_ready` PNG who has since asked for separations has both a
valid artifact and an unmet request, and `toCustomerFinalizationView` reports
the unmet one. The artifact is never deleted; it simply stops being the
answer, and becomes the answer again on retraction.

###### The delivery/reconciliation boundary (A2 Correction 3)

One function answers *does an already-completed job currently satisfy this
project's Production PNG request?* — `resolveSatisfiedProductionDelivery` in
`FinalArtworkCapability`, serving both workflows. Five things must all hold:

1. The current request is one this product produces at all.
2. A job exists under the **current** authority — the active final-direction
   approval, or the approved preparation at the **current width**.
3. Its immutable bound intent matches the current request.
4. It completed and a production asset really exists for it.
5. Authoritative validation **for that exact asset** says `ready`.

(5) is why this returns evidence rather than a job status. `completed` only
means the worker reached a conclusion — `completeWithoutAsset` completes jobs
that produced nothing. Restoring `print_ready` from completion alone would
manufacture readiness the pipeline never asserted.

Everything that could disagree now shares this one source:

| Consumer | Previously | Now |
| --- | --- | --- |
| `getCurrentProductionAssetId` | oldest job for the approval, any intent | the satisfying job only |
| image / download routes | gated on `project.status === "print_ready"` | gated on the same evidence |
| `toCustomerFinalizationView` | project status ahead of everything | evidence ahead of project status |

Two defects closed by that unification. **Delivery ignored intent**: the old
path resolved through `getFinalArtworkJobByApprovalId`, which returns the
*oldest* job regardless of requested output, so a historical PNG could be
handed over as fulfillment of a separations request. **Reuse could not
restore state**: after PNG → unsupported → PNG the correct completed job was
found and reused, but `project.status` was left stale at
`finalization_required` by the unsupported job that ran in between, stranding
the customer on `needs_review` with a valid, already-paid-for plate on file.

`reconcileCompletedProductionState` fixes the second **without reviving the
job**. A completed job is never pushed back to `queued`/`running` merely to
restore state — that would risk repeating production work and rewrite history
that is still true. Status is reconciled from the job's own immutable
evidence, and only ever to `print_ready`, and only when the full chain above
holds.

`getFinalArtworkJobByApprovalId` now has exactly one caller: the `next dev`
stranded-job recovery, which only re-triggers an already-queued job and is
fenced by the worker whichever job it picks. A test pins that count.

An unsupported request classifies `apparel_vector` and fails the blocking
`production_output_supported` check, so the raster Production PNG can never
be presented as satisfying it. Both worker gates run **before** any provider
dispatch, local or paid, and complete the job (never fail it) — so the
customer reaches the terminal `needs_review` state rather than the retryable
`retryable_failure` one, polling stops, and nothing auto-retries.

**Out of product scope** (`out_of_scope_product`) is a non-apparel product —
yard sign, banner, mug, sticker, vehicle graphic. It fails the blocking
`product_scope` check *before* any production arithmetic runs, so a report
can never read `"ready"` for something iHeartPrints does not make. This is a
product-scope decision (Constitution §7.13) requiring an amendment, not a
production profile awaiting implementation. `signage` and `logo_vector`
remain reserved, dormant categories that no classification reaches today.

`print_ready` is unchanged by all of this. It means exactly what it always
has: the Production PNG passed authoritative Print Validation for the
supported raster profile. A design whose customer mentioned embroidery is a
validated raster design artifact — never a digitized, separated, or
otherwise method-ready file.

When the text does not support a confident method, `printMethodConfidence`
is honestly `"unknown"` and an apparel-raster profile is assumed as the
one production path this product actually generates artwork for today
(never marked `"confirmed"`). `printMethod` values (`dtf`, `dtg`,
`sublimation`, …) and `requestedUnsupportedOutput` values are internal
production facts and never customer-facing copy; V1 does not ask the
customer to choose a decoration method. Every unsupported outcome collapses
to the customer-safe `needs_review` state — the internal reason lives only
on `FinalArtworkJob.lastError`, which no customer surface reads.

Target physical print dimensions come from `shared/print-placement-dimensions.ts`,
keyed by `PrintPlacement` and overridden by the customer's own chosen
production width when they set one (`TShirtDesignBrief.intendedPrintWidthIn`,
threaded in as `deriveProductionRequirements({ intendedPrintWidthIn })`).
The placement table supplies the default and the printable band. Current
defaults are adult-apparel widths (`full_front`/`full_back`: 10.5in
default, 14in max height; `left_chest`: 4in; `sleeve`: 3in). Target
resolution is **300 PPI** for apparel raster production. Pixel geometry
is authoritative; PNG density metadata is not.

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
values. Print Validation describes them; it never executes them. Vector,
font-outline, SVG/PDF, embroidery, and CMYK transformation names that still
appear in that set are reserved vocabulary from the validation contract —
not iHeartPrints V1 production work. The live Final Artwork worker produces
a raster apparel PNG and re-runs this same capability authoritatively
against that asset.

#### Provisional Print Readiness vs. Final Print Validation (Sprint 2M Phase 2A)

Four distinct questions, answered at four distinct points in the lifecycle
— conflating any two of them is the specific mistake Phase 2A exists to
avoid:

| Stage | Question | Capability | Status today |
|---|---|---|---|
| **Concept Evaluation** | Is this generated concept an acceptable design — does it match the approved Design Brief? | `ConceptEvaluationCapability` | Active; persisted on `ArtworkVersion.evaluationStatus`/`evaluation` |
| **Provisional Print Readiness** | If we tried to produce *this generated concept* right now, what production work would be required? | `PrintValidationCapability`, run by `GenerationWorkerCapability` immediately after Concept Evaluation | Active (Phase 2A); computed and logged internally only; **never persisted, never authoritative** |
| **Final Artwork / Production Artwork** | The customer has confirmed a design direction (or approved prepared upload) — produce the actual production PNG | `FinalArtworkCapability` + `FinalArtworkWorkerCapability` | **Active.** Raster apparel PNG only. Reconstruction when source pixels are insufficient. See §13c / §13d / §13i. |
| **Final Print Validation** | Is the *resulting production asset* actually print-ready? | Same `PrintValidationCapability`, re-run against the production asset | **Active.** Only this run may set `PrintProject.status = "print_ready"`. |

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
- Phase 2A did not mark an `ArtworkVersion` as "final." Later sprints added
  `finalDirectionConfirmed` (Create New) and prepared-upload approval
  (Existing Artwork). Concept selection is still not print-ready.
- `requiredTransformations` is **never executed by Print Validation** —
  Phase 2A only computed and logged it. `FinalArtworkWorkerCapability` now
  performs the apparel-raster production transform and re-validates the
  production PNG.

#### Current concept behavior (Goal 10)

A real ~1024×1024px generated concept intended for a full-front or
full-back print (current default 10.5in wide at 300 PPI) computes an
effective resolution well under target — and correctly reports
`finalization_required` with
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

Unchanged by Sprint A3, deliberately. Ownership classification is **not**
trademark or copyright verification, and `IpSafetyCapability` is not a rights
record — see §23a.

### IpSafetyCapability — Active (Sprint A3)

Pure and synchronous (no repository, no provider, no I/O;
`createIpSafetyCapability()` takes zero arguments), mirroring
`BriefEvaluationCapability` / `PrintValidationCapability`. Decides whether a
customer request or a structured generation intent may reach the
concept-generation provider, and never persists anything.

A **product safety boundary**, never a legal-clearance system: it makes no
determination about legality, licensing, clearance, or ownership. Full design
in §23a.

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
| `PaidImageIntent` | Phase 2C0.5: durable at-most-once record of ONE paid image intent — the unit that makes recovery reuse an image instead of re-buying it (internal; not in snapshot) |
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
| `ArtworkPreparation` | §13h: the Upload Existing Artwork lifecycle for one customer file — immutable original, derived prepared asset, analysis/preparation diagnostics, explicit approval. Its existence IS the workflow identity |

### Key relationships

- Working brief may change freely before approval
- Approval freezes `DesignBriefSnapshotContent` into a new `DesignBriefVersion`
- Concepts (`ArtworkVersion`) reference `designBriefVersionId`
- Generation jobs reference `designBriefVersionId` and produce artwork/assets
- Generation jobs own zero or more `PaidImageIntent` rows — one per logical paid image, unique per `(project, intentKey)` and per `(job, budget slot)`
- Assets may reference `generationJobId`; artwork may reference primary/thumbnail asset ids
- Current vs previous concept batches are derived (not a separate table)
- Explicit deferrals live on `brief.deferredSections`
- Required wording is derived/normalized via `src/lib/domain/required-wording.ts`
- One-level undo: `interviewState.lastRevision` stores previous brief snapshot
- Conversation lifecycle: new projects use phase `interviewing`; legacy phases remain readable
- §13h: an `ArtworkPreparation` references its immutable `originalAssetId`,
  its derived `preparedAssetId`, and (once approved) a
  `prepared_upload` `ArtworkVersion`. Original → prepared lineage lives here
  rather than on `AssetRecord` (whose `vectorAssetId`/`printAssetId` both mean
  something narrower) or on `ArtworkVersion.sourceArtworkVersionId` (which
  means "a targeted revision of that artwork version"). A project with a
  preparation is an uploaded-artwork project; there is no workflow enum
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
   containment OR a recognized product-noun synonym; **artwork colors are
   grounded by PALETTE INTENT** (A4 Correction B — see "Subject color is
   not a palette preference" below); every other field has no additional
   grounding check beyond "not ambiguous confidence."
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
| `colors` | Palette intent, in the provider's `evidence` **or** the customer's message — unless the update answered a pending colors question (A4 Correction B) | Same authority the deterministic layer uses (`textExpressesPaletteIntent`). Understanding's fields win the merge, so without this a `colors: "Black"` read off "black 2010 jeep wrangler" would undo the deterministic fix one layer later. Narrow by construction: the update survives if ANY proposed color reads as palette intent anywhere, so only the pure false-inference case is refused — and refusing it falls back to deterministic extraction, not to nothing |
| Every other field | No additional check beyond "not ambiguous confidence" | Free-text fields with no fixed canonical vocabulary to check against; normalization (below) already keeps their shape consistent with a direct answer |

Implemented in `reconcile-understanding.ts` (`productIsGrounded` /
`requiredWordingIsGrounded` / `textExpressesPaletteIntent`) — never in the
provider adapter, which stays a thin, replaceable prompt/parsing layer.

### Subject color is not a palette preference (A4 Correction B)

**A color describing what the artwork DEPICTS is a creative fact about the
subject. It becomes `preferredColors` only when the customer expresses
palette intent.** One authority, `colorStatesAPalettePreference` in
`intent-extraction/extraction.ts`, decides that for every path — the
deterministic clause branches, the previously-exempt "undecided" clause,
and the semantic layer's `colors` proposal.

Live acceptance: "black 2010 jeep wrangler unlimited with full racks and a
inspired overland roof top tent" recorded Preferred Colors = Black. The
clause names no garment and no design element, so it reached the undecided
branch, which pushed its colors straight into the palette without ever
consulting the guard. The assistant then said "I have Black in the
artwork", and when the customer later chose a black shirt, Brief Evaluation
raised a **blocking** `color_clash` against a preference they had never
expressed and asked them to change their design.

A color in an undecided clause now reaches the palette only through:

| Signal | Example |
|---|---|
| `pendingSection === "colors"` — the customer was ASKED | "What colors?" → "forest green and cream" |
| A design element or palette cue near the color | "make the design black and gold", "black and silver color scheme" |
| A clause that is nothing but colors and connectors (`BARE_COLOR_LIST`) — no noun exists for the color to modify, so it is the customer naming colors | "…My 3 Sons, gold and white, bowling ball smashing pins" |

Nothing is lost when the guard says no: `extractGraphics` keeps the words
in the design description, which is what `PromptTranslationCapability`
turns into the generation request's `subject` — so a black Jeep is still
drawn black, without a global black palette reaching the image model.

Two matching fixes shipped with it. `DESIGN_ELEMENT_BEFORE_COLOR` gained a
trailing color-list run (the mirror of what `DESIGN_ELEMENT_AFTER_COLOR`
already did), because its one-word window reached only the first color of
"make the whole design black and gold" — Black was captured and Gold, the
same request one word later, was dropped. And whole-design referents
("everything") count as design elements, since the customer is only ever
describing artwork here.

**Brief Evaluation is unchanged.** `detectColorClash` was always correct;
it was being fed a palette the customer never stated. An explicitly
requested black artwork on a black shirt still raises the same blocking
conflict.

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

`object-contain` (never `cover`, so the whole design is always visible).
**Phase 2D:** for apparel with a known approved garment color
(`brief.shirtColor`), the primary surface is that garment color as a CSS
background behind the unchanged transparent PNG — presentation only; never
flattened into artwork bytes, never a new asset, never alpha rewrite.
The expanded modal adds a local Preview background control
(Garment / White / Gray / Black / Transparency) so customers can still
inspect opaque ink vs transparent space. Non-apparel / deferred garment
color keeps the historical checkerboard default. Switching backgrounds is
component-local UI state only — reload may return to garment color; it
never changes selection, evaluation, or paid generation.
Escape and backdrop-click both close it, and a `[Select this concept]`
action inside it calls the exact same `onSelect` handler the card itself
uses. Opening, viewing, or closing the modal never calls any capability
method or mutates any lifecycle state — it is pure client-side UI state
(`previewId` in `ConceptCards`).

Concept cards use the same garment-color surface by default (with a light
"On {Color}" hint). Short sets (Phase 2C `conceptsWithheld` count on the
`concepts_ready` message) render an honest customer-safe note and a
1-/2-column grid without empty placeholders — never internal reason codes.

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
| Criteria | wording, style, graphics, palette, composition, readability, exclusions, product compatibility, overall alignment | PPI (pixel geometry), transparency, apparel print size, raster production geometry |
| Status | Architecture, persistence, and a real evaluator; still no UI gating | Provisional concept-stage runs are logged only. Authoritative production-asset runs persist on `ProductionAssetValidation` and may set `print_ready`. See §5. |

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
validation," "production asset," "vectorize," "upscale," or
"execute final artwork job." Customer-facing size copy may state the 300
PPI guarantee in plain language; it is not a customer-operated control.

`conversation-service.ts` derives a customer-safe
`CustomerFinalizationStatus` (`"not_requested"` / `"preparing"` /
`"retryable_failure"` / `"needs_review"` / `"print_ready"`). Terminal
project states remain authoritative (`print_ready`,
`finalization_required` → `"needs_review"`). While the project is still
`finalizing`, the **current** FinalArtworkJob's status distinguishes
in-progress work (`"preparing"`) from a retryable infrastructure failure
(`"retryable_failure"`). The customer view never includes a job id,
`lastError`, provider name, or provider request id. `"retryable_failure"`
reuses the existing Prepare action — there is no second retry API, and
polling stops so the customer is not left on an infinite "Preparing"
spinner.

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
your artwork before it can be finalized"), derived from
`PrintProject.status === "finalization_required"` at the same
`conversation-service.ts` choke point as `"preparing"`/`"print_ready"`.
`"retryable_failure"` is a later, separate state: the project is still
`finalizing` and the current FinalArtworkJob failed for an infrastructure
reason — not a print-readiness verdict. No PPI, dimensions, provider,
storage, or validation rule ever reaches this view.

### Unsupported methods (Goal 17)

Current V1 production is the **raster apparel PNG profile only** (DTF/DTG
focus). Two different reasons put everything else outside it:

- **Outside product scope**: banner/sign production, large format,
  promotional products, general commercial printing, and universal
  vector-production. These stay out permanently.
- **Outside current production capability**: embroidery digitization,
  screen-print separations, sublimation-specific preparation, and
  SVG/PDF/CMYK production for apparel. These are apparel-decoration
  concerns the product may take on later as explicit production profiles
  (Constitution §16.6). They are not unfinished V1 deliverables and must
  not be described as supported today.

Sprint A2 sharpened when the second bullet actually applies: **only when the
customer explicitly asks iHeartPrints to produce one of those artifacts**,
as recorded in the structured `TShirtDesignBrief.requestedProductionOutput`.
Naming a decoration method as downstream context ("this will be screen
printed", "I might embroider it") never removes a garment design from the
raster path — it is intent about the customer's own printing, not an order
for a file this product does not sell. See "Decoration intent vs.
production-output request" above for the full rule, the authority chain, and
its two blocking checks (`product_scope`, `production_output_supported`).

Today the worker still completes without an asset when
`requirements.category !== "apparel_raster"` so it cannot falsely claim
`print_ready` for those categories. That fail-closed behavior is honesty
about the current classifier, not a roadmap to implement those outputs.

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

### pixel dimensions ≠ physical dimensions ≠ density metadata

Three different things, deliberately kept separate:

- **Pixel dimensions** — how many pixels the file contains
  (`AssetRecord.widthPx/heightPx`).
- **Physical dimensions** — how large the artwork is *intended to print*
  (`ProductionNormalizationSummary.intendedWidthIn/intendedHeightIn`).
- **Density metadata** — a tag inside the PNG (`pHYs`) telling graphics
  software what physical size to open the file at. This is not the 300 PPI
  contract.

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

## 13g. Multi-Turn Design Intent and Explicit No-Text (Phase 1.1)

Two independent live failures, both structural rather than heuristic.

### Multi-turn design intent

**The failure.** A customer opened with Discovery Bay, its lighthouse, its
waterways, and a request for the real area / an aerial idea of it. Their next
turn described the channel to the marina, the homes, and boats. The second
turn *replaced* `designDescription` outright, and the location, the
waterways, and the real-area intent were gone from the brief before anything
downstream ran.

**The cause.** `designDescription` had only ever had assignment semantics —
`fields.designDescription = <this turn's value>` — and nothing in the
pre-approval path asked what the new turn was *doing* to the design.

**The contract.** Compatible clarifications accumulate. Explicit refinements
replace only the detail they contradict. Explicit replacement language
supersedes prior content.

| Operation | Customer language | Result |
|---|---|---|
| ADD | "also add homes on the left", "and include a marina" | both turns' content is kept |
| REFINE | "move the lighthouse to the right", "make the marina smaller" | the contradicted detail is superseded; everything else survives |
| REPLACE | "forget the lighthouse", "start over with a marina scene" | prior content is deliberately superseded |

`intent-extraction/design-description-merge.ts` owns this, as a pure
function, and is applied on both the semantic (`reconcile-understanding.ts`)
and deterministic (`extraction.ts`) paths.

**How contradictions are resolved.** The merge works at STATEMENT level. An
existing statement is dropped only when a new statement shares a subject
**and** constrains the same attribute *dimension* (position / shape / size /
count / color) with a different value. That two-part test is what leaves
exactly one lighthouse requirement after "move the lighthouse to the right",
while "make the marina smaller" (size) leaves "marina on the right"
(position) untouched. ADD and REFINE therefore share one algorithm — with no
subject overlap nothing is dropped, which is exactly the ADD case — and the
distinction between them is descriptive, not a separate code path.

Deliberately **not** a scene graph and **not** a schema change: nothing here
is persisted, and `designDescription` remains a single coherent free-text
contract.

This is **not** the post-selection revision path. That path
(`revision-delta` / `revision-intent` / `buildEditPrompt`) assumes a selected
`ArtworkVersion` and produces an image-edit delta; this one runs pre-approval
where no artwork exists. The vocabulary is deliberately similar; the
machinery is not shared, and the revision path is untouched.

### Real-world / research requests

Preserve the desired real-world fidelity honestly. Never claim external
grounding unless a reference/research capability actually ran — and none
exists yet. The customer's request now survives because the merge no longer
discards earlier turns; the provider prompt continues to answer it with the
§13f honesty line (approximate from the customer's own description; no map or
aerial reference is available; invent no landmarks; imply no survey
accuracy).

### Explicit no-text

**The failure.** Asked "what exact text should appear? Say 'none' if there is
no text," the customer answered "No wording". The brief correctly stored
`exactText: ""` and `deriveRequiredWording` correctly derived `mode: "none"`
— and then `GenerationPromptRequest` flattened it back to
`requiredWording: null`, which is *also* what an unanswered question
produces. Downstream therefore read an explicit no-text request as merely
"no required string": the prompt kept typography-forward direction language,
told the model not to add text "beyond the exact wording specified above"
when no wording was specified above, listed typography under creative
freedom, and the artwork came back covered in invented lettering — which
evaluation then passed, because "no required wording" read as "nothing to
check". The concept card meanwhile claimed "No text lockup — graphic-led".

**The semantics.** Three genuinely distinct states, now first-class as
`RequiredWordingMode` on `GenerationPromptRequest.wordingMode`:

| Mode | Storage | Meaning |
|---|---|---|
| `unknown` | `exactText === null` | not answered yet. **Never** a no-text request |
| `provided` | non-empty `exactText` | this exact text must appear |
| `none` | `exactText === ""` | **no text of any kind** may appear |

`"none"` prohibits words, letters, numbers, typography, labels, captions,
signage, monograms, dates, slogans, decorative lettering, and invented brand
text — anywhere, including inside badges, banners, ribbons, borders, and on
objects depicted in the scene. Required wording and explicit no-text are
mutually exclusive customer intents; exactly one block ever appears in a
prompt, and an unresolved wording question produces neither.

Not sticky: a customer who said "none" can later add wording, and
`wordingMode` follows the brief back to `"provided"` with typography
available again.

**Text policy precedence** (extends §13f):

1. required wording / explicit no-text / exclusions
2. required content + composition
3. customer style and colors
4. concept-direction treatment
5. provider defaults

**Layer behavior under `"none"`:**

- *Prompt Translation* — `deriveRequiredWording` decides both
  `requiredWording` and `wordingMode`. A `RegenerationPlan` removal of
  required wording downgrades `"provided"` → `"unknown"`, never to `"none"`:
  only the customer's own explicit answer may impose no-text. An
  already-explicit `"none"` is never downgraded.
- *Concept directions* — a fourth override layer, `noTextTreatment`, applied
  **last** (above the scene and customer-composed overrides) because no-text
  is precedence tier 1. `ConceptDirectionTreatment.typographyEmphasis`
  becomes `string | null`, and `null` means consumers must omit typography
  guidance entirely rather than filter a string that still authorizes
  lettering. Only the fields that reference or authorize text are
  overridden, so the three directions stay genuinely distinct on shape
  language, density, framing, and hierarchy.
- *Provider prompt* — a hard `NO TEXT` block replaces `REQUIRED WORDING`; the
  typography line is dropped; typography is removed from `CREATIVE FREEDOM`;
  the dangling "beyond the exact wording specified above" is replaced by a
  sentence that is true of the actual wording state; and the closing line
  adds "no text or lettering of any kind".
- *Evaluation* — the existing `required_wording` criterion answers whichever
  wording contract is in force, so no new criterion key, contract change, or
  migration was needed. Under `"none"` the vision model reports a `noText`
  signal; readable text it actually transcribed is decisive in code even if
  it self-reports no violation, mirroring the required-wording cross-check.
  Deliberately no OCR — judgment by the existing vision provider, and
  conservative about incidental texture.
- *Concept card copy* — "Graphic-only — no text." under `"none"`, so the
  customer-facing summary matches the contract the provider was actually
  given.

---

## 13h. Existing Artwork → Print Ready (Phase 1)

### Why: two workflows, not two entry points

iHeartPrints was built around one job — *"design something for me"* — and the
whole architecture reflects it: interview, Design Brief, approval,
generation, concepts, revision. A large share of real customers arrive with a
different job entirely: *"I already have my artwork; make THAT printable."*

Those are not two ways into one pipeline. Everything downstream of
"understand what the customer wants" is different, and several steps are
actively harmful when applied to the second job — asking someone to describe
a design they are literally holding, offering them three creative directions
for artwork they already chose, or asking them to retype the wording that is
already in their file.

Phase 1 therefore adds a genuinely second first-class workflow:

```
CREATE NEW ARTWORK  (unchanged)
  conversation → Design Brief → approval → generation → concepts → revision

UPLOAD EXISTING ARTWORK  (new)
  upload → deterministic analysis → repairability classification
         → exterior background isolation → edge cleanup
         → Original vs Prepared → explicit customer approval
```

Phase 1 stops at approved prepared artwork. It does not enhance, upscale,
validate, finalize, or produce a print-ready deliverable — and never says it
does (Constitution §15).

### The preservation contract

Uploaded artwork is **pixel-authoritative**. The customer is not asking for a
redesign.

| Phase 1 may | Phase 1 must never |
|---|---|
| decode and normalize the source | change wording |
| measure edge statistics and bounds | redraw objects |
| identify an exterior background | shift colours globally |
| remove it, creating transparency | alter composition |
| clean the boundary it leaves behind | invent elements |
| classify repairability | regenerate artwork |
| preserve aspect ratio exactly | call an image model |
| | overwrite the uploaded original |

**The original upload is immutable.** Its `AssetRecord` (kind
`customer_upload`) is written once and never updated; every transformation
produces a new, separate asset. Asserted by hashing the stored bytes before
and after a full prepare-and-approve run.

### Workflow identity is derived, not stored

There is deliberately **no `PrintProject.workflowKind` column**. A project
with an `ArtworkPreparation` row *is* a `prepare_existing` project — a real
domain fact rather than a speculative enum added ahead of a second consumer.

The customer's choice *before* they upload anything is transient client state
(`components/chat/uploaded-artwork-flow.ts`), because nothing durable exists
to remember yet. A reload correctly returns them to the choice rather than
trapping them in a workflow they never committed to.

### Capability

`ArtworkPreparationCapability` (`src/capabilities/artwork-preparation/`)
depends on `ProjectRepository`, `AssetCapability`, and
`DesignBriefCapability` — and on **no provider port at all**. Not an
unconfigured one, not a stub. There is nothing in the module that could make
a network call, which is what turns "zero paid-provider calls" from a policy
into a structural property.

| Module | Responsibility |
|---|---|
| `upload-limits.ts` | Size/format/dimension/pixel bounds, magic-signature sniffing, filename sanitization. Pure. |
| `image-decode.ts` | The only place upload bytes become pixels. Header-bounds-check *before* decoding. |
| `image-analysis.ts` | Deterministic measurement. Measures; never decides. |
| `repairability.ts` | The conservative verdict. Reads analysis; touches no pixels. |
| `pixel-metrics.ts` | The background-membership test and colour distances, in one place so both removal passes agree on them. Pure. |
| `background-isolation.ts` | Edge-connected fill, fringe decontamination, RGB-only edge decontamination, residual edge islands, halo guard. Pure. |
| `background-cavities.ts` | Enclosed background a foreground structure sealed off from the border — letter counters, ring interiors. Extends the mask; removes nothing on its own. Pure. |
| `background-speckle.ts` | Isolated near-background flecks the fill tolerance just missed. Extends the mask. Pure. |
| `guided-removal.ts` | Resolves a customer's click to one preserved enclosed candidate, or refuses it. Extends the mask. Pure. |
| `preparation-copy.ts` | The one place analysis becomes customer language. |
| `artwork-preparation-capability.ts` | Orchestration, persistence, ownership checks. |

The three mask passes are deliberately **three modules and three test suites**,
because they are three different kinds of evidence — measured geometry,
measured isolation, and the customer's own judgement — and collapsing them
would make it impossible to say which one removed a given pixel.

### Background isolation: evidence, not similarity

> **THE SAFETY INVARIANT.** Background removal may remove pixels only when the
> system has **affirmative evidence that they belong to the detected
> background**. Colour similarity alone is insufficient. Enclosure alone is
> insufficient.

The audited reference case is a customer's bowling logo — 979x1024, fully
opaque, near-black exterior touching all four edges (edge mean ≈0.78, edge
sigma ≈0.53), with **thousands of near-black pixels that are intentional
interior line work**. "Remove every black pixel" would delete the customer's
artwork.

There are exactly **two** ways a region can earn that evidence, and they are
deliberately separate passes. The first is **reachability from the image
border**:

1. Estimate the background from the border ring's *dominant* colour (the
   mode's own mean, so one bright corner pixel cannot define it).
2. Derive tolerance adaptively from measured edge deviation — a genuinely
   flat export stays at the audited baseline of 12; noise widens it, up to a
   hard ceiling past which the artwork is classified `NEEDS_REVIEW` instead.
3. Multi-seed 4-connected flood fill from **every** matching border pixel.
   4-connectivity, not 8: diagonal connectivity lets a fill squeeze through a
   one-pixel anti-aliased gap in an outline and flood a design's interior,
   which is the classic way this kind of tool eats artwork.
4. Fringe decontamination, **only** within 2px of the removed region. For a
   pixel `C` that is foreground `F` composited over background `B`,
   `C = a·F + (1−a)·B`, so `a ≈ |C−B| / |F−B|` and the uncontaminated colour
   is `B + (C−B)/a`, with `F` taken from a nearby genuinely-solid pixel.
   **When no such reference exists, or the pixel is already essentially
   solid, it is preserved unchanged.** Artwork fidelity outranks cleanup.

   A composite also has to *be* one. `C = a·F + (1−a)·B` puts a blended pixel
   **on the line between `B` and `F`**; a pixel that is its own colour is not,
   and decontaminating it divides by a coverage that never existed. A 3px dark
   outline — (16,8,0) against (1,1,1), with the letter's white fill inside the
   2px reference window — resolves to a coverage of 0.038, and `B + (C−B)/a`
   blows its warm tint up to a saturated (255,183,0) at alpha 10: the outline
   is punched through from both sides. Pixels whose residual from the `B→F`
   line exceeds 25% of their own background distance are therefore preserved
   whole. Thick dark outlines were already safe by accident (no high-contrast
   reference within the search window, so the pass declines); only thin ones
   ever reached the broken path. The check changes **no** pixel count on the
   audited bowling fixtures — genuine anti-aliased blends sit on the line.
5. **RGB-only edge decontamination**, for the pixels step 4 just declined.
   See below.
6. **Residual edge islands** (Phase 1.6B), for the small dark components step 5
   could not reason about from a single direction. See below.
7. Halo guard: bleed retained RGB two pixels into the now-transparent
   exterior. Transparent pixels still carry colour, and every resample in
   this codebase interpolates RGB independently of alpha
   (`raster-transform.ts` is straight, not premultiplied) — leaving the old
   near-black behind a zero alpha is exactly how a dark halo reappears during
   a later upscale.

### RGB-only edge decontamination

**ALPHA IS TOPOLOGY. RGB IS EDGE COLOUR.**

The composite model above is the right tool when a fringe pixel really is
`a·F + (1−a)·B`. It is not the only way a dark background contaminates an edge.
Light artwork anti-aliased over near-black produces edge pixels whose channels
**clip on the way down**: the audited bowling swoosh runs (11,5,0) → (18,11,0)
→ (42,30,14) → (79,66,47) → gold across four pixels. The second of those is
Chebyshev 17 from the (1,1,1) background — outside the tolerance of 12, so the
fill correctly keeps it — and sits 9.9 off the `B→F` line against a background
distance of 19.75, so `liesOnComposite` correctly refuses it. The result is a
**fully opaque ring of the old background baked into the artwork**: invisible
on a black garment, dark stipple on a white one.

The post-delivery fidelity audit measured ~8,231 such pixels against ~6,324
pixels of legitimate dark ink in the same image, and established that every
**alpha**-based remedy destroys the second population to reach the first:
widening the tolerance costs 34–46% of the real ink, deleting near-black pixels
costs the bowling ball's finger holes, eroding the edge costs the small
tagline. What is wrong with these pixels is not that they are opaque. It is
their **colour**. So this pass corrects colour and nothing else.

It runs **only where the composite model declined**, and requires all of:

- **Visible**, and within the *same* 2px reach step 4 used. `FRINGE_RADIUS_PX`
  is not widened; the 1,571 dark pixels the audit found at distance 3 are a
  separate question and are left alone.
- **Adjacent to confirmed exterior transparency** — the removed mask, or a
  pixel the composite pass proved was pure background and feathered away.
  Topology, never darkness: "this pixel is dark and near the edge" is exactly
  the inference that deletes finger holes.
- **Thin.** Local dark thickness — the dark extent through the pixel along each
  axis, smaller of the two — must be ≤ 2. That minimum is stroke thickness
  regardless of which way the stroke runs, which a run measured along one
  chosen direction is not: a dark ring following a horizontal edge is 200px
  "long" measured sideways, and a directional test that looked sideways would
  protect the very contamination this exists to fix. A genuine 3px outline
  measures 3 whichever way it runs, and is preserved.
- **A strictly rising luminance ramp in the ORIGINAL**, from the background
  pixel outside it, through the candidate, to the artwork behind. That monotone
  climb is the actual evidence that this is light artwork composited over a
  dark background rather than dark artwork in its own right. The **original**
  is the authority: guided cleanup and the composite pass may both have altered
  neighbours by now, and only the upload still carries the ramp the customer's
  file actually had.
- **An inward reference that is materially lighter**, checked against the exact
  bytes about to be copied. An edge whose interior is equally dark is an edge
  of dark artwork.

Then it copies that reference's RGB and **writes no alpha at all**. The alpha
plane is compared byte-for-byte before and after in
`edge-rgb-decontamination.test.ts`; that invariant is not negotiable, because
this pass may be wrong about a colour but must never be able to change the
shape of the artwork.

**Ambiguity preserves.** The audit found ~557 edge pixels with neither a clean
rising ramp nor a clean plateau. They are counted
(`fringeRgbFallbackPreservedAmbiguous`) and left exactly as they are.

On the real bowling original, replaying only the legitimate guided removals,
this neutralises **77.5%** of the measured contamination (6,367 of 8,215) with
**zero** alpha bytes changed, zero loss of dark ink of thickness ≥ 3, and all
three finger holes byte-identical.

**Scope.** The forensics that justify this measured *dark* contamination over a
dark background. The pass does not fire on light-background artwork, and
inventing the inverse case without the same evidence is not something the
codebase does.

**Garment neutrality.** The algorithm receives no shirt colour, no preview
background, no garment colour, and there is no parameter through which one
could reach it. One prepared asset serves White, Grey and Black alike. The
Phase 1.5 QA preview backgrounds are a **presentation safety layer** — they
exist so a human can see a mistake like a lost finger hole before approving —
and are never an input to image processing.

### Residual edge islands (Phase 1.6B)

The pass above reads its evidence along **one inward normal**: the first
fixed-order direction with removed background behind it. That is the right
shape for a contaminated pixel on a straight silhouette. Where the silhouette
turns a corner, ends in a tip, or narrows to a one-pixel sliver, the chosen
normal points *along* the edge instead of across it, and the ramp test is being
asked a question the geometry cannot answer.

Forensic classification of what survived Phase 1.6 on the real bowling asset —
3,288 dark pixels still touching confirmed exterior transparency — attributed
them to:

| Rejected by | Pixels |
| --- | --- |
| dark run 3+ deep along that one normal | 1,071 |
| handled by the composite model, not this pass | 821 |
| local dark thickness over the limit (intentional stroke) | 529 |
| luminance profile not strictly rising (ambiguous by design) | 408 |
| the pixel inward along that normal is itself transparent | 305 |
| the pixel outward along that normal is not darker | 154 |

The last three describe a **chosen direction**, not the artwork. So Phase 1.6B
replaces the directional question with a topological one: it examines the whole
8-connected **dark component** in the output, and recolours it only when

- every pixel of it was **declined by the composite model** — which also bounds
  the whole component inside the same 2px fringe band, since that flag is only
  ever set there;
- the component **touches confirmed exterior transparency**;
- the component is **small** (≤ 8px);
- every pixel is dark in the original and passes the **same
  `localDarkThickness` guard** Phase 1.6 uses, unchanged;
- every pixel has its own **materially brighter opaque artwork neighbour** to
  take colour from.

Because the component is *maximal* among dark pixels, "brighter all around" is
structural rather than sampled — any dark neighbour would be in the component.
And because the whole component is bounded to the fringe band, recolouring it
cannot leave a dark remainder just outside the pass's reach: the **inverted
ring** that a merely-deeper ramp search would produce, and the reason the ramp
ceiling equals the fringe radius rather than being a tuning knob.

**Why it cannot reach the finger holes** — measured, not asserted. The three
holes are 439/716/437 dark pixels forming components of 503/822/480, none of
which touches exterior transparency at all: they are preserved cavities deep
inside the ball. The audited parameter sweep recoloured **0** hole pixels at
every island size from 1 to 128. **Why it cannot reach intentional outlines**:
against the 9,987 pixels the orientation-independent ink classifier calls
stroke, it changes **0**.

On the real bowling original this takes the residue from 3,288 to 1,882 and the
measured contamination from 1,926 to 1,094 — **88.1%** of the original
population now neutralised — with zero alpha bytes changed, identical bounding
box, and identical cavity, speckle, guided and feathering counts. After local
production normalization to 3150px, dark pixels on the alpha edge fall from
9,833 to 4,686 with the visible pixel count unchanged, so the fix survives
resampling without thinning outlines.

**What it deliberately does not solve.** Of the 3,288 residual pixels, 1,208
have a local dark thickness of 3 or more. Those are the artwork's own dark
outlines and shadows meeting the silhouette — broken into a dotted line by the
fill, and therefore reading as stipple on white — and the audit found no
evidence separating them from any other intentional dark stroke. They stay.
Preservation outranks cosmetic cleanliness, and the honest position is that
**this residue is artwork, not contamination**.

Observability: `fringeRgbResidualCandidates`, `fringeRgbResidualPixels`,
`fringeRgbResidualPreservedAmbiguous`. Diagnostic record metadata only — no
migration, exactly like the Phase 1.6 counters.

### Enclosed background cavities

A border-seeded fill is, by construction, blind to background that a
foreground shape has topologically **sealed off** from the border: the
counters inside letterforms, the open middle of a ring or badge, the area a
frame encloses. Visual acceptance of the bowling logo found exactly this — the
exterior went transparent while the counters in `SPLIT DISTURBERS` and, worst,
in the small `DISTURBING FROM DAY ONE` wording stayed black.

`background-cavities.ts` extends the exterior mask with those regions, and
with nothing else. It is a **mask extension, not a second removal pipeline**:
one fringe pass, one halo guard, one set of audited edge behaviour still runs
downstream, over a mask that now includes confirmed cavities.

The hard part is not finding them; it is the **negative control**. A bowling
ball's finger holes are enclosed, black, the same colour as the background,
and surrounded entirely by foreground — and they are the customer's artwork.
"Enclosed + background-coloured" describes a letter counter and a finger hole
equally well, so it can never be the test. Four kinds of evidence are required
of every region, all of them:

1. **A confirmed exterior background exists.** With no exterior fill there is
   no background model, and the pass does nothing at all.
2. **Colour**: every pixel satisfies the *same* membership test the exterior
   fill used — same estimated colour, same adaptive tolerance, from
   `pixel-metrics.ts`. True by construction, since regions are grown with that
   predicate.
3. **A real foreground wall**: ≥75% of the enclosing boundary is
   affirmatively **outside the background model** — the same
   `matchesBackgroundColor` contract, not a contrast threshold.

   This gate originally demanded ≥48 Euclidean RGB, borrowed from
   `SOLID_REFERENCE_MIN_DISTANCE`, and **on the real bowling artwork it
   rejected 129 of the file's counters**. Real typography is outlined in dark
   ink: measured (16,8,0) and (24,8,0) against a (1,1,1) background. Those are
   unambiguously foreground under the model (Chebyshev 15 and 23 against a
   tolerance of 12) while sitting only ~17 and ~25 Euclidean from it. 48
   answers "is there enough colour separation to divide by?" for fringe
   decontamination — a different question, and borrowing it silently required
   customer artwork to be high-contrast.

   > **FOREGROUND STRUCTURE DOES NOT NEED TO BE HIGH-CONTRAST. IT ONLY NEEDS
   > TO BE AFFIRMATIVELY OUTSIDE THE BACKGROUND MODEL.**
4. **Shallow enclosure**: the thinnest foreground wall between the region and
   the confirmed exterior is no thicker than the region itself —
   `wall ≤ 1.75 · inradius + 6`, both measured by 4-connected BFS.

   The base term moved from 4 to 6 on **measured real-file evidence**: two
   genuine tagline counters in the customer's artwork (the enclosed slots in
   the `R` and `B` of `DISTURBING FROM DAY ONE`) measure inradius 1 / wall 7,
   so the ratio term contributes under two pixels and the base decided the case
   alone — `1.75·1 + 4 = 5.75` refused them, `1.75·1 + 6 = 7.75` reaches them.
   Because the base is a *constant* it is swamped by the ratio term everywhere
   the cavity is not near-zero-sized, so the governing negative control barely
   moves: the real finger hole at inradius 9 / wall 26 goes from an allowance
   of 19.75 to 21.75 and stays preserved with 4px to spare.

Rule 4 does the real work, and it is a statement about **topology, not
typography**. Background shows through a hole in a *structure* — a stroke, a
ring, a border — so the wall around it is on the order of the hole. A dark
feature belonging to a solid object sits deep in that object's mass. On the
acceptance fixture:

| Region | Inradius | Wall | Outcome |
|---|---|---|---|
| display counter (plain stroke) | 30px | 11px | removed |
| small-wording counter | 6px | 5px | removed |
| dark-outlined tagline counter | 5px | 10px | removed |
| dark-outlined display counter | 11px | 31px | **refused — open case, see limitations** |
| ball outline crescent | 6px | 124px | preserved |
| drop shadow band | 10px | 71px | preserved |
| **finger hole** | 14px | 244–312px | **preserved** |

No letter is identified, no glyph matched, nothing OCR'd, and no colour
special-cased — a light background behind a dark logo runs the identical code
path. A final ceiling refuses the whole pass if exterior plus cavities would
consume >99.5% of the canvas, and a region no foreground path reaches (sealed
behind another dark region) is preserved rather than guessed at.

Every threshold is set so that **ambiguity preserves**. A missed cavity is a
blemish the customer can point at; a destroyed one is artwork we cannot
recreate.

### Isolated near-background speckle

The fill removes pixels *within* tolerance. A real export is not that tidy: on
the audited artwork, background (1,1,1) with a tolerance of 12 left a scatter of
pixels at Chebyshev 13–24 — invisible against the black they came from, and a
dotted black outline traced around the whole design the moment the background
went away. The prepared file carried **488 of them, 520 pixels**.

Widening the tolerance is the wrong fix and would be a serious one: the same
looser test would then apply to the customer's 34,392 dark foreground pixels
and let the flood fill march through them. The residue is distinguishable not by
its colour but by its **topology** — it is a fleck floating in space, attached
to nothing. `background-speckle.ts` gates on exactly that:

1. **Fully isolated.** Every neighbour outside the component is already-removed
   background, or the image border. Not "mostly"; every one. A pixel touching
   artwork *is* artwork and this pass cannot see it.
2. **Tiny.** ≤ 4 pixels. The measured population ran 1px (463), 2px (19), 3px
   (5), 4px (1) — and then **nothing at all until 21px**, where the artwork's
   own smallest retained component begins. The bound sits inside a genuine
   five-fold gap in the data rather than on a slope.
3. **Near-background.** Every pixel within `2 × tolerance` of the confirmed
   background colour — a multiple, not an absolute, so a noisy export gets
   proportionally more room and a clean one gets almost none. A deliberate 1px
   accent fails this by a mile.

Rule 1 is what makes it safe and is why the pass needs no notion of "near an
edge": an island enclosed by removed background is, by construction, adjacent to
it. **One pass, never iterated** — removing an island cannot isolate anything
that was not already isolated, and looping would creep outward from a boundary
that just moved, which is precisely the erosion this must not do.

### User-guided background cleanup

> **Automatic classification fails toward preservation. For pixels it cannot
> classify, the CUSTOMER is the authority.**

Some enclosed regions are not ambiguous by accident; they are ambiguous to every
measurement available. The full real-file audit settled this quantitatively.
Across the customer's bowling artwork the wall/inradius statistic — the one rule
4 gates on — measures:

| Population | wall / inradius |
|---|---|
| genuine letter counters (6 regions) | 2.11 – 5.29 |
| **bowling-ball finger holes (3 regions)** | **2.89 – 4.69** |

The finger holes sit **inside** the counter range. The populations are *nested*,
so no threshold on that statistic separates them, and no reparameterization of
it can: raising the ratio far enough to reach the counters deletes the ball
first. Several alternative statistics did separate on that one file (best:
75th-percentile ray crossing thickness over inradius, ~2× margin), but on three
negative controls from a single image — and a smaller ball icon with
proportionally larger holes collapses the separation. **That is not enough
evidence to spend a customer's artwork on.**

So the system stops guessing and asks. Phase 1.3 makes the ask
**preview-then-confirm**, not click-to-delete:

- The browser sends an **image-space coordinate** for preview — never a region
  id, a mask, an alpha value or an asset path. A made-up coordinate resolves to
  whatever is genuinely there, and if that is artwork the answer is "no" with
  no confirmation surface.
- An eligible preview returns a **signed candidate token** plus an
  **exact-region highlight** built from the same label map the mutation path
  uses. The UI paints that overlay; it never flood-fills client-side.
- **Clicking does not mutate.** Only an explicit "Remove This Area" redeems the
  token. Cancel discards the transient preview with zero persistence.
- Confirm revalidates server-side: project, preparation, prepared asset,
  removal count, and region eligibility must still match. Stale or forged
  tokens refuse without writing. Double-confirm is idempotent
  (`already_removed`).
- A click may resolve **only** to a region the automatic cavity pass already
  identified as an enclosed background-coloured candidate and then declined on
  geometry. Everything else in the image is inert — the customer's dark outline
  measures Chebyshev 15 against a tolerance of 12, so it was never a candidate
  and no click can reach it.
- A click on a **finger hole is eligible**, and that is not a bug. A finger hole
  is an enclosed background-coloured region preserved on ambiguity, exactly like
  a counter; the system genuinely cannot tell them apart. What protects it is
  the customer seeing the exact highlight and choosing Cancel. What the code
  guarantees is that nothing is removed until they confirm, and undo remains
  available before approval.

**Pipeline order.** The mask is built by four passes that only ever *grow* it —
exterior → cavities → guided → speckle — and not one of them reads or writes a
colour. Only then do erase, fringe decontamination, RGB-only edge
decontamination and the halo guard run. That
split keeps the audited edge behaviour singular: an exterior pixel, a cavity
pixel, a clicked pixel and a speckle pixel are indistinguishable by the time any
colour is computed, so there is **one** fringe pass rather than four variants,
and the composite guard that protects 10,449 opaque dark line-work pixels on the
real file cannot be bypassed by the new passes. Speckle runs last of the four
because "surrounded entirely by removed background" is not knowable until the
mask is final — removing a large counter can strand a fleck inside it.

**Persistence and lineage.** `artwork_preparations.guided_cleanup` stores the
customer's ordered **clicks**, not the resulting mask. The clicks are the only
thing the customer authored; replaying them through the deterministic pipeline
over the immutable original reproduces the prepared bytes exactly. That one
choice buys reload-safety, undo (drop the last point), idempotency (a repeat
click resolves to a region already in the list and changes nothing) and
auditability. A stored mask would give none of it and could silently disagree
with the original it claims to describe.

```
customer_upload (IMMUTABLE, never rewritten)
  └─ automatic preparation      → prepared asset #1
       └─ + confirmed removal   → prepared asset #2   (preparedAssetId repoints)
            └─ undo             → prepared asset #3   (≡ #1, byte-for-byte)
                 └─ APPROVED    → prepared_upload ArtworkVersion → Phase 2
```

Every cleanup derives a **new** asset; superseded ones are left in place, so
lineage stays readable and nothing is overwritten. Each persisted derivation
uses a **unique storage object identity** (`prepared-{preparationId}-{uuid}`
as the storage `conceptId` folder). Storage backends keep `upsert: false` —
paths are never reused as an idempotency mechanism; candidate tokens and the
`guided_cleanup` click list are. An orphan object from a failed DB write after
a successful upload must not block the next confirm: the next attempt mints a
fresh UUID. Once `status = 'approved'` the preparation is history:
`previewGuidedCleanup`, `confirmGuidedCleanup`, and `undoGuidedCleanup` all
refuse, so the artwork Phase 2 consumes can never change underneath it.

> **PREPARED ARTWORK MAY INCLUDE CUSTOMER-GUIDED CLEANUP BEFORE APPROVAL.** What
> the customer approves is the prepared file as they last saw it — automatic
> passes plus whatever they removed themselves. `guidedRegionsRemoved` on the
> preparation record is the honest, durable statement of how much of it went on
> their authority rather than on measured evidence.

**Magic Select (Phase 1.7 / 1.7B).** A second cleanup tool beside Select Area.
The customer clicks a colour they want gone and sets a Tolerance (Chebyshev RGB
distance only; default 8, range 0–40). There is no Connected/Similar toggle,
no lasso, and no editor expansion.

The server classifies the seed from generic raster properties (visible alpha,
distance to transparency, local thickness and 4-connected component size
inside a fixed seed-colour class that is independent of Tolerance; thickness
uses dark-ink runs when the seed itself is dark) — never bowling coordinates,
OCR, or product semantics:

- **Residue-like** (thin ≤ 2, touches exterior transparency, small component):
  magnetic global selection of the same structural class within colour
  tolerance (`selectionMode: "similar"`, `ruleVersion: "magic-select:v2"`).
- **Otherwise** (thick outlines, enclosed interiors, finger-hole fills): the
  original 4-connected wand (`selectionMode: "connected"`,
  `ruleVersion: "magic-select:v1"`).

Naive "select all similar RGB" is rejected: colour-only matching selects
legitimate outlines and enclosed dark artwork. Topology/thickness/size gates
do not loosen when Tolerance increases. Preview remains mutation-free; the
server owns the mask; confirm redeems a signed `v: 3` token that binds the
resolved mode, rule version, selection key, and tolerance. Replay uses the
**persisted** `selectionMode` and never re-infers it. Phase 1.7 connected ops
without those fields still replay as connected. `guided_cleanup` JSONB — no
migration. Highlight for Magic Select is a solid amber overlay so scattered
1px islands stay visible on White/Gray/Black QA.

### Repairability

Precedence, highest first, biased one way on purpose: when the deterministic
evidence is ambiguous, prefer review over acting.

| Verdict | Meaning |
|---|---|
| `NOT_REPAIRABLE` | No visible artwork at all. |
| `NEEDS_REVIEW` | Complex/photographic exterior, or a fill that would remove ~everything or ~nothing. |
| `REQUIRES_ENHANCEMENT` | Otherwise fine, but too few real pixels for the placement's production target. |
| `PRINT_READY_ALREADY` | Already usably transparent, and big enough. |
| `REPAIRABLE_AUTOMATICALLY` | Uniform, edge-connected exterior; sufficient resolution. |

`backgroundTreatment` is **independent of** resolution: background
preparation and enhancement are separate problems, so an artwork that needs
enhancement can still have its background prepared honestly today. Print-size
sufficiency reads `shared/print-placement-dimensions.ts` — artwork
preparation never restates a print-sizing rule — and is measured against the
**visible artwork's** width, never the padded canvas.

### Persistence

One new table, `artwork_preparations`, plus one new `artwork_kind` enum value
(`prepared_upload`). The schema-discipline audit — what must survive reload,
why existing tables cannot represent it honestly, and why this is the
smallest additive change — is written out in full in the migration header
(`20260810140000_uploaded_artwork_preparation.sql`) and in
`ArtworkPreparation`'s doc comment. In short:

- `AssetRecord` has no honest lineage slot (`vectorAssetId` means "an SVG
  companion"; `printAssetId` means "a print-ready production asset").
- The customer's prepared-artwork approval is not any existing flag.
  `finalDirectionConfirmed` means "no more creative changes" and is reset by
  concept selection; `selectedArtworkVersionId` means "the direction I'm
  working with".

### The prepared ArtworkVersion (the Phase 2 handoff)

On approval, one `ArtworkVersion` is created with `kind: "prepared_upload"` —
its own kind precisely so uploaded artwork can never be mislabelled as an
AI-generated concept (Constitution §16). Its provenance is honest by
omission: `generationJobId`, `providerKey`, and `designBriefVersionId` are
all `null`, because no job, no provider, and no approved brief version
authorized these pixels — the customer's own file did.
`sourceArtworkVersionId` is also `null`: it means "a targeted revision of
that artwork version", and the source here is an **asset**. Original →
prepared lineage lives on `artwork_preparations`, where it is true.

Phase 1 deliberately does **not** set `selectedArtworkVersionId` or
`finalDirectionConfirmed` — both belong to the generated-concept lifecycle.
Phase 2 adds exactly one lifecycle write here: approval moves
`PrintProject.status` from `"intake"` to `"approved"`, meaning "the customer's
creative decision is settled; production is the next step" — the same thing it
means when `submitDesignBriefDecision` sets it in the other workflow. It is
never `"finalizing"` (nothing has been requested) and never `"print_ready"`.

### No required-wording contract

Uploaded artwork never goes through Concept Evaluation's required-wording
checks, and Phase 1 performs no OCR. The pixels are authoritative for visual
content; the customer is never asked to retype text they already have, and
the text is never modified.

The architectural hook Phase 2 needs is exactly
`ArtworkVersion.kind === "prepared_upload"` — an unambiguous, non-inferred
signal for the uploaded-preserve print-validation applicability profile. Phase
2 implements that profile; see §13i.

### Formats

**PNG only, and it says so.** The repository's one image codec is `pngjs`
(`png-thumbnail-generator.ts`, `raster-transform.ts`, `production-png.ts`),
which is PNG-only. JPEG/WebP support would mean adding a new decoder
dependency and its entire security surface, which Phase 1 deliberately does
not do. JPEG, WebP, and GIF are *detected* so the customer gets an honest
"we can't take that yet" rather than a generic corruption error; SVG is
detected and rejected explicitly.

### Security boundary

Every rule runs before any uncontrolled allocation:

- **Scope.** Bound to `projectId` from the path; the capability re-verifies
  ownership of every row it touches, and image reads additionally confirm the
  asset belongs to the project. (This codebase has no user authentication
  layer — see §23/§24 — so "authenticated" here means project-scoped
  authorization, which is the strongest statement currently true.)
- **Bytes are authoritative.** Declared `Content-Type` and filename are
  untrusted claims. A declared type that disagrees with the signature is
  rejected rather than silently corrected.
- **Decompression bombs** are stopped at the PNG header: a 30000x30000 PNG is
  a few hundred bytes on the wire and ~3.6 GB decoded, so checking the
  decoded image would already be too late.
- **Filenames** are sanitized for display only and never used to build a
  storage path — object keys are always
  `projects/{projectId}/concepts/{groupingId}/{name}` with a name this code
  chooses.
- Every image-read miss returns the same generic 404, so the endpoint cannot
  be used to enumerate internal state.

### UI

`WorkflowChoiceCard` appears only at the very start of a project. Choosing
"Create New Artwork" is a pure client-side dismissal — the existing interview
is byte-for-byte unchanged for every customer who does not upload anything.

`UploadedArtworkPanel` owns the surface once an upload exists, and the
creative surfaces (concept grid, summary card, revision actions, composer)
are hidden rather than merely unreachable.

`ArtworkComparison` renders Original and Prepared side by side, both labelled.
The Prepared tile uses a presentation-only **Preview Background** control
(White / Gray / Black) so transparent regions and dark edge residue can be
inspected before approval. The Original tile stays a faithful upload display
and is not rewritten by that QA control. **Enlarging is not approving**:
`ArtworkPreviewModal` has no approval affordance in it at all — a stronger
version of the structural fix applied to `ConceptCards`, where the enlarge
control had to become a sibling of the select control. Approval is only ever
the explicit "Use Prepared Artwork" button.

Guided background cleanup (Phase 1.4) is opened from compare via **Clean Up
Background**, which mounts `GuidedCleanupWorkspace` — a large interactive
surface for preview → confirm → undo, with Fit / Zoom In / Zoom Out and pan so
small details stay clickable. Zoom grows the rendered image content box inside
a scrollable viewport (not CSS `scale`), so `mapClickToImagePoint` stays
authoritative — one coordinate mapper, and panning needs no term of its own
because scrolling moves the element's own rect.

Phase 1.6B makes the surface **selection-primary**. The workspace exists so a
customer can point at leftover background; zoom and pan are there to make that
pointing accurate, not to be the point. Phase 1.4 nonetheless swapped the
cursor to `grab` above Fit, which advertised dragging as the primary gesture
while a stationary click remained the only thing that did anything — the
affordance and the behaviour disagreed. So the cursor is now **crosshair at
every zoom level**, and panning must be asked for: hold **Space** (or press the
middle button) to drag, during which the cursor is `grab`/`grabbing` and no
cleanup can fire however still the pointer is. Touch has neither cursor nor
modifier, so the gesture carries the meaning: a tap selects, a drag pans, and a
drag can never select. No pinch zoom — the toolbar owns zoom. The rules live in
`guided-cleanup-interaction.ts` as pure functions, for the reason
`artwork-click-mapping.ts` states: with no DOM in the test runner, a gesture
rule inside an event handler could only ever be verified by clicking around. Enlarge stays a separate read-only
viewer; the small compare tiles are not the cleanup surface. Phase 1.5 adds
the same White / Gray / Black Preview Background control inside the workspace
(default White). Switching it never changes prepared bytes, `preparedRevision`,
candidate tokens, zoom, or cleanup lifecycle.

### Garment-neutral master (Phase 1.5)

**GARMENT-NEUTRAL MASTER.** Prepared and final PNG bytes are independent of
garment color. Garment / background color may affect preview, inspection, and
QA only — never alpha, RGB, cleanup algorithms, validation results, or the
stored prepared asset.

**QA BACKGROUND.** White (`#FFFFFF`) / Gray (`#C8C8C8`) / Black (`#000000`)
compositing is a presentation-only inspection aid (CSS under the transparent
PNG). It is not persisted, not sent to the server, and not a garment-color
product visualization. Actual garment color, when shown elsewhere, must not
replace these contrasting inspection controls.

**APPROVAL SAFETY.** Transparent artwork must be reviewed against a
contrasting background before final approval. This reduces the class of
misses where intentional dark holes and accidental transparent holes look
identical on black — it does not by itself guarantee fidelity.

The customer snapshot carries an opaque `preparedRevision` that changes on
every confirm/undo (new prepared derivation) and is unchanged by preview.
`ChatApp` reloads the prepared signed URL when that revision changes, so a
later cleanup preview cannot resurrect a superseded automatic/prepared image.

Every sentence the panel renders comes from the server
(`preparation-copy.ts`). No copy is derived client-side from analysis
numbers, because analysis numbers never reach the client at all.

### Testing

Fixture cases A–I (solid black exterior, internal outline, enclosed region,
near-black, white background, already transparent, edge-touching subject,
halo, photographic background) plus J (original immutability, verified by
hash), a full security suite at both the pure and route layers, and a bowling
acceptance regression against a **synthetic** fixture reproducing the audited
properties at real dimensions — the customer's own file is deliberately not
committed to the repository (privacy and ownership, Constitution §16).

`no-paid-provider.test.ts` traps `fetch`, `http.request`, `https.request`,
and `net.Socket.prototype.connect` for the duration of a full
upload → analyze → prepare → approve run, so a paid call would fail the suite
loudly instead of quietly spending money.

---

## 13i. Existing Artwork → Print Ready (Phase 2: production finalization)

Phase 1 ends at an approved, background-prepared transparent PNG. Phase 2
turns that into the file a printer can actually use, and it is the point where
the two workflows finally converge.

### Two authorities, one pipeline

**PREPARED ARTWORK != PRINT-READY ARTWORK.**
**PREPARED APPROVAL != `print_ready`.**

```
CREATE NEW ARTWORK                     UPLOAD EXISTING ARTWORK
  selected concept                       uploaded original
    ↓                                      ↓
  final direction approval               prepared artwork
  (FinalDirectionApproval)                 ↓
    ↓                                    prepared approval
    │                                    (ArtworkPreparation.status='approved')
    │                                      ↓
    └──────────────► FinalArtworkJob ◄─────┘
                          ↓
                 production requirements  (placement policy + chosen width)
                          ↓
                 enhancement decision     (visible pixels vs target pixels)
                          ↓
                 provider / normalization (trim → size → resample → pHYs)
                          ↓
                 production asset         (immutable, production_png)
                          ↓
                 AUTHORITATIVE Print Validation
                          ↓
                 print_ready  /  finalization_required
```

These are **parallel customer-authority boundaries**, not one gate with two
doors. A create_new customer's authority is "I am done revising the design you
made for me". An upload customer was never revising anything — their authority
is "this prepared file faithfully represents the artwork I gave you". Asking
the second customer the first question has no meaning.

### The authority model (why no synthetic approval)

`FinalArtworkJob` carries **either** a `final_direction_approval_id` **or** an
`artwork_preparation_id`, with a database CHECK enforcing exactly one. The
job's `sourceKind` is *derived* from which one is set, never stored, so there
is no third fact that could disagree with the two keys.

Three options were audited:

| Option | Verdict |
| --- | --- |
| Reuse `FinalDirectionApproval` with a source kind | **Rejected.** Its `design_brief_version_id` is `NOT NULL` and honest for every existing row; uploaded artwork has no approved brief version, so this means weakening a real constraint AND fabricating a brief-version reference for artwork no brief describes. |
| A generalized `ProductionApproval` abstraction | **Rejected.** A new table whose only content would be a foreign key to one of two records that already exist — indirection with no new fact in it. |
| **`ArtworkPreparation` approval IS the authority** | **Chosen.** The row already records exactly this decision (`status`, `approved_at`, `prepared_artwork_version_id`), durably and auditably. Creating a second record for the same decision would be the duplicate competing authority this design exists to avoid. |

`requestPreparedUploadFinalArtwork` therefore requires **none** of
`selectedArtworkVersionId`, `finalDirectionConfirmed`, an approved
`DesignBriefVersion`, or a `FinalDirectionApproval`. It requires the approved
preparation, its prepared asset, and its `prepared_upload` `ArtworkVersion`.

### Idempotency: approval + production size

The upload workflow's idempotency key is **(project, preparation, production
width)**, enforced by a partial unique index. Consequences, all intended:

- Double click, reload, second tab, retry → the same job, and therefore never
  a second paid reconstruction.
- A `"failed"` job (infrastructure) revives to `"queued"` on the customer's
  next press of the same button.
- A `"completed"` job is returned as-is — that is a real verdict about this
  artwork at this size, not a hiccup.
- **A different print width is a different deliverable**, and gets its own
  job. The older plate stays immutable and correct for the size it was made
  at; `getCurrentProductionAssetId` resolves only the job matching the
  CURRENT intent, so a mismatched plate is withheld rather than handed over
  with a size on it that is a lie.

`FinalArtworkJob.productionWidthIn` freezes each upload job's own target at
enqueue, so a size change mid-flight cannot retroactively re-target a running
job. (The create_new path is unchanged and still reads
`TShirtDesignBrief.intendedPrintWidthIn` at run time.)

### Source contract: the prepared PNG, never the original

The enhancement source is the **approved prepared transparent PNG**. The
customer already accepted that background isolation; starting from the opaque
original would discard their decision, and re-running isolation would
re-litigate it. The worker refuses to proceed if the preparation's prepared
asset and the approved `ArtworkVersion`'s primary asset disagree, or if the
prepared asset is the original.

### Enhancement decision (cost policy, `enhancement-decision.ts`)

Pure arithmetic on two numbers known before any provider is contacted:

```
visible artwork width (alpha bbox, in real source pixels)
  vs
targetWidthIn × targetPpi     e.g. 10.5in × 300 = 3150px
```

- `>= target` → **skipped**. No paid call at all; the local
  normalization-only provider runs.
- `< target` → **reconstructed**. The configured provider runs (Topaz
  Transparency Upscale in live configuration).

Visible width, never canvas width — transparent padding is not resolution.
This is the same rule `image-analysis.ts` already applies when telling the
customer whether enhancement will be needed, so what they were told before
approving and what production does cannot disagree.

There is **no retry ladder**. If a reconstruction still lands short of the
target, the plate is produced honestly and authoritative validation fails it
via `reconstruction_sufficiency` — never an escalating loop of paid calls.

### Uploaded-preserve validation profile

`PrintValidationInput.validationProfile` selects which checks *apply*. It is
an applicability profile, not a strictness dial.

Under `uploaded_preserve`, three checks are **not emitted** because they have
no meaning for customer-supplied artwork — not because they are inconvenient:

| Check | Why inapplicable |
| --- | --- |
| `brief_provenance` | No Design Brief version authorizes this artwork; the customer's file and their prepared-artwork approval do. |
| `concept_evaluation_alignment` | "Does this match the brief we were given?" has no answer when no brief describes it and nothing generated it. |
| `required_wording_verification` | The wording is already in the customer's pixels. They never typed it; asking them to, so we could check our own transform, would invent a requirement. Phase 2 performs no OCR. |

Everything a print shop would actually reject a file for still **blocks**,
unchanged: `content_type`, `raster_dimensions_known`, `transparency`,
`effective_resolution`, `minimum_raster_dimensions`,
`production_normalization`, `alpha_bound_artwork`, `transparent_dead_canvas`,
`physical_width_policy`, `aspect_ratio_preserved`.

Three preservation checks are **added** — so this profile is not weaker, it is
different and in places stricter:

- `source_lineage` — the plate provably derives from the approved prepared
  asset (never the original, never another project's), with a SHA-256 of the
  exact source bytes. Missing lineage **fails**; "we didn't write it down" is
  not a reason to certify.
- `preserved_source_geometry` — the plate's own alpha bbox keeps the approved
  artwork's proportions, so a crop, letterbox, or squash is caught.
- `reconstruction_sufficiency` — the plate was not enlarged beyond the raster
  it was built from.

Every report also carries a `validation_profile` info check and a `profile`
field, so **"not asked" is never indistinguishable from "passed"**.

### Preservation honesty boundary

Deterministic checks prove the pipeline used the artwork the customer
approved, and that its geometry survived. They **do not** prove it still looks
the same. A provider-hosted reconstruction is a genuine enhancement transform,
and visual fidelity after it remains provider-dependent and unproven by
arithmetic. This limitation is stated in
`print-validation/contracts.ts` rather than papered over.

### Project lifecycle

No new statuses and no new conversation phase. `PrintProject.status` is the
sole lifecycle authority for the upload workflow (the design-interview surface
is structurally absent for these projects — the uploaded-artwork panel owns
the screen and the composer is hidden):

```
intake → approved → finalizing → print_ready
                              ↘ finalization_required   ("needs attention")
```

A size change after delivery returns an upload project to `approved`, which is
truthful: an approved design, and no print-ready file *at the size now
intended*. The previously produced plate is untouched.

### Customer-facing surface

The approved step of the uploaded-artwork panel gains the size card (reused
from create_new) and one action, "Prepare Print-Ready Artwork". While
production runs it shows the shared `PRINT_READY_WAITING_MESSAGE`; on failure
it shows an honest needs-attention message that states both the original and
the prepared artwork are safe, plus a retry. On success the existing
`FinalArtworkDeliveryCard` renders — without "Make Another Change", which
reopens a creative loop an upload customer does not have. The size control
stays available, because it is their only route to a different size.

The download filename prefers the customer's own sanitized upload name
(`split-disturbers-print-ready.png`) over brief text, which for an upload
project only ever describes the garment.

### Migration

One additive, forward-only migration
(`20260810180000_prepared_upload_finalization.sql`): two nullable columns on
`final_artwork_jobs`, one dropped `NOT NULL`, one CHECK, one partial unique
index. No new table, no new enum. Every existing row satisfies the CHECK
unchanged, and the create_new path gains no new behavior.

---

## 13j. Clause Boundaries in Customer Text

**Invariant: numeric decimal points are lexical content, not sentence
boundaries.**

`src/lib/domain/clause-boundaries.ts` is the single definition of where one
clause or sentence ends and the next begins in customer free text. Every
module that splits customer text into clauses, or bounds a capture at a
clause boundary, resolves its punctuation rule from that file rather than
writing its own character class.

### The defect this exists to prevent

Live acceptance, A4 funnel. The customer wrote

> black 2010 jeep wrangler unlimited with full racks and an inspired overland
> roof top tent, large wheels with a 2.5" lift at the beach with the sun
> setting

and the Design Brief stored

> black 2010 jeep wrangler unlimited with full racks and an inspired overland
> roof top tent, large wheels with a 2

`extractGraphics` bounds its capture at a sentence boundary — the right rule,
and the thing that keeps an unrelated leading clause out of the design
description (§13f) — but its boundary set was the raw class `[.!?]`, so the
period inside `2.5` counted as punctuation. The lift, the beach and the
sunset were gone before any concept was generated, with nothing in the
conversation to show it had happened. Customer content is authoritative
(Principle 15); silently dropping half of it is the most direct possible
violation of that.

### The rule

A period is content when, and only when, it sits between two digits.
Deliberately **lexical**: it asks nothing about measurement nouns, units,
version keywords, or product names, so `2.5" lift`, `1.5 inch border`,
`0.25" stroke`, `12.75" wide graphic`, `Version 2.5`, `Model 3.5`,
`a 1.25 ratio`, `911.2` and `MK2.5` are all preserved by one rule instead of
a growing list of special cases — while `Model 3.5. No text.` still splits
into two sentences, because that second period is followed by a space, not a
digit.

Both halves of the check are load-bearing. "Not preceded by a digit" alone
would refuse the sentence-ending period of `3.5.`; "not followed by a digit"
alone would refuse a sentence that begins with a number.

The module exposes three things: `clauseBoundarySource(marks)` (one boundary
drawn from a punctuation set), `clauseBodySource(excluded)` (the
negated-class counterpart, for captures that bound themselves), and
`splitOnClauseBoundaries(text, marks)`.

### Consumers

All of these previously duplicated the same punctuation class and shared the
same defect:

- `intent-extraction/extraction.ts` — graphics, colors, product, audience,
  required wording and entity-name captures, removal corrections, the
  cross-field pending-section guard, and the multi-sentence heuristic
- `intent-extraction/preserve-design-detail.ts` — the design-detail backstop's
  clause units (§13f)
- `intent-extraction/design-description-merge.ts` — statement splitting for
  the multi-turn merge (§13g)
- `lib/domain/design-content-contract.ts` — composition-statement boundaries
- `prompt-translation/creative-reference-extraction.ts` — inspiration-phrase
  captures
- `shared/requested-production-output.ts` and `ip-safety/ip-safety-detection.ts`
  — clause scoping, so an operator and its referent cannot land on opposite
  sides of a boundary that is not really there
- `shared/revision-intent.ts` — whole-message question detection, where the
  defect read a hedged question ("Should the lift be 2.5 inches?") as a
  standing instruction and would have enqueued a paid regeneration

**Known limit.** One shape stays genuinely ambiguous: a sentence ending in a
digit, joined with no space to a sentence starting with a digit — `I want
3.2 of them are enough` meaning "I want 3." then "2 of them are enough". That
reads as the number `3.2`. Accepted deliberately: it requires a missing
space, whereas the behavior it replaces lost real customer content in the far
more common well-formed case.

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
  few seconds and refreshes the snapshot once it leaves `preparing`
  (`print_ready`, `needs_review`, `retryable_failure`, or `not_requested`).
  `retryable_failure` stops polling so the customer can click Retry
  Preparation (the existing Prepare/finalize action — never a second API
  and never an automatic retry). Polling never revives
  failed/running/cancelled/completed jobs and never calls a provider itself. Interactive `next dev` only may kick an
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
- §13h: customer-supplied artwork uses the same object hierarchy and the same
  orphan-cleanup guarantee, via `uploadCustomerArtwork`. The `customer_upload`
  original is written once and **never** updated, re-encoded in place, or
  deleted; the prepared transparent PNG is always a separate asset. The
  customer's filename is stored as display metadata only and never
  contributes to an object key

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
- §13h (customer-supplied binary ingress): encoded size bounded before and
  after buffering; format determined by magic signature, not by the declared
  `Content-Type` or filename, and a disagreement between them is a rejection
  rather than a silent correction; SVG explicitly rejected; decoded
  dimensions and total pixel count bounded against the image header before
  any bitmap allocation (decompression-bomb guard); malformed and truncated
  input rejected as a customer-facing 400, never an unhandled throw;
  filenames sanitized for display only; uploaded-artwork image reads scoped
  to the owning project with a uniform 404 on every miss

Do not document or commit actual secrets.

---

## 18. Persistence Architecture

Interface: `ProjectRepository` (`src/lib/db/repository.ts`)

| Implementation | When selected |
|---|---|
| `LocalProjectRepository` | Neither Supabase variable configured; `.data/sprint1-store.json` |
| `SupabaseProjectRepository` | `NEXT_PUBLIC_SUPABASE_URL` **and** a `SUPABASE_SERVICE_ROLE_KEY` whose JWT/`sb_*` authority is `service_role` |
| *(refuses to start)* | URL configured, `SUPABASE_SERVICE_ROLE_KEY` missing **or** present with anon/publishable/unrecognized authority |

Selection is three-way, not two-way. A Supabase URL with no service-role key,
or with a key whose JWT `role` is `anon`, is a **misconfiguration**, not a
request for local mode: it used to resolve to an anon-keyed client (which can
no longer read a single application row — see §23.1) or to the on-disk store,
meaning a deployment could believe it was persisting customer work to
Supabase while writing to a directory the next deploy discards — or, after
the name-only check, while querying Postgres as `anon` (`42501`).
`getProjectRepository()` now throws. Automated test runs are exempt and keep
the local store, so the suite can never reach real infrastructure.

Parity expectations: both implement the same repository contract including
atomic job claim/heartbeat/recovery, asset CRUD, Concept Evaluation
updates (`updateArtworkEvaluation`), and — Sprint A4 — the atomic
free-concept allocation (`allocateFreeConcept`) and one-way consumption
record (`recordFreeConceptConsumed`).

Parity is not decorative here. Supabase gets these guarantees from real
row-conditional UPDATEs and UNIQUE constraints; the local store gets them
from its per-method mutex plus the same uniqueness rules written by hand.
Sprint A4 found a live divergence and fixed it: the local store allowed two
`generation_jobs` rows with the same `(project_id, idempotency_key)`, which
the database has refused since 20260805130000. Because a job is the unit
that authorizes paid generation, that divergence meant the local store could
not be used to prove a spend property at all — two concurrent approvals
produced two paid attempts locally and one in production.

Correction 1 adds the second acquisition rule to both:
`generation_jobs.acquisition_session_id` is unique wherever it is non-null,
so the local store raises the same `FreeConceptAlreadyConsumedError` the
database's partial unique index produces. It is checked *after* the
idempotency-key match, deliberately: the same logical job coming back is a
RESUME and must succeed, while a different job for a session that already
has one is a SECOND FREE CONCEPT and must not. It is also deliberately not
scoped to a project — the bypass it closes is a second *project* in the same
session.

Correction 2 adds the third rule: the free-attempt claim is written in the
same locked `createGenerationJob` call that writes the job, which is the
local equivalent of the Postgres trigger firing inside the insert's
transaction. There is no window in which one exists without the other.

**Deletion semantics are not representable in the local store** (the
repository exposes no `deleteGenerationJob`, and the store has no foreign
keys). Those invariants — including the delete-then-reinsert rejection that
is the whole point of the claim — are proved directly against real PostgreSQL
by `scripts/verify-acquisition-authority-postgres.sql`, run against a
throwaway database with the complete migration history applied.

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
- §13h: one new table, `artwork_preparations`, plus one new `artwork_kind`
  enum value (`prepared_upload`) — see
  `supabase/migrations/20260810140000_uploaded_artwork_preparation.sql`, whose
  header carries the full schema-discipline audit (what must survive reload,
  why existing tables cannot represent it honestly, why this is the smallest
  additive change). Notably there is **no** workflow-kind column: the
  preparation row's existence is the workflow identity
- Correction A: the Create New side likewise adds **no** column and **no**
  migration. `ConversationCapability.beginCreateNewWorkflow` stamps
  `metadata.workflow = "create_new"` (`lib/domain/conversation.ts`) on the
  assistant turn it writes, and `isAtProjectStart` reads it back — the same
  way the `concepts_ready` anchor already carries a conversation-shaped fact
  the UI branches on. See "Create New is a workflow transition" in §19
- Derived values recomputed rather than stored as authority: concept
  status batches, brief evaluation, intelligence assessment, revision
  impact, summary views, customer-facing `finalization` status, uploaded-
  artwork repairability (reclassified from the stored analysis on every read,
  and the analysis itself re-measured whenever the print placement changes)

---

## 19. API and Service Boundaries

Service facade: `src/lib/services/conversation-service.ts` — thin
delegation to composed capabilities.

| Route | Responsibility |
|---|---|
| `POST /api/projects` | Start conversation/project. Sprint A4: also the one place an acquisition session is issued (httpOnly `ihp_as` cookie) and bound to the new project, in the same INSERT (§23b) |
| `GET /api/projects/[projectId]` | Load snapshot |
| `POST /api/projects/[projectId]/email` | Sprint A4: capture the email required to continue the design session. Not sign-up, not verification, not marketing consent; grants no entitlement. Idempotent (§23b) |
| `POST /api/internal/acquisition-access` | Sprint A4: grants the current session the internal entitlement against `IHEARTPRINTS_INTERNAL_ACCESS_KEY` (`x-iheartprints-internal-key`, constant-time). Unset by default with no dev fallback; uniform 401 on every refusal (§23b) |
| `POST /api/projects/[projectId]/messages` | Handle user message — the customer's OWN words, and nothing else |
| `POST /api/projects/[projectId]/workflow` | Correction A: the workflow choice, as control state. Closed action vocabulary (`create_new` only); idempotent; writes no user message and touches no brief field |
| `POST /api/projects/[projectId]/brief/decision` | Approve / edit on Design Summary (Sprint 2L Phase 1B: "continue" removed — see §10b) |
| `POST /api/projects/[projectId]/concepts/regenerate` | Explicit updated-concept enqueue |
| `GET /api/projects/[projectId]/concepts/[artworkVersionId]/image` | Mint short-lived concept image URL (Sprint 2K Phase 1) |
| `GET /api/projects/[projectId]/generation/status` | Read-only generation status |
| `GET /api/projects/[projectId]/finalization/status` | Read-only customer-safe finalization status (`not_requested` / `preparing` / `retryable_failure` / `needs_review` / `print_ready`) |
| `POST /api/projects/[projectId]/select` | Select concept |
| `POST /api/projects/[projectId]/finalize` | Sprint 2M Phase 2B: explicit final-direction approval + idempotent finalization request |
| `GET /api/projects/[projectId]/production-artwork/image` | Mint short-lived production-PNG URL + customer-safe metadata once print-ready (delivery preview) |
| `GET /api/projects/[projectId]/production-artwork/download` | Stream print-ready production PNG with customer filename (`Content-Disposition`) |
| `POST /api/projects/[projectId]/undo` | One-level undo |
| `POST /api/projects/[projectId]/artwork-upload` | §13h: project-scoped multipart ingress for customer-supplied artwork (PNG only; bytes authoritative over declared type and filename) |
| `POST /api/projects/[projectId]/artwork-preparation` | §13h: the uploaded-artwork actions — `context` (production details), `prepare` (deterministic background isolation), `cleanup_preview` / `cleanup_confirm` / `undo_cleanup` (customer-guided background removal with Phase 1.3 preview-then-confirm; preview carries a coordinate, confirm redeems a signed candidate, and neither grants authority beyond revalidated eligibility — see "User-guided background cleanup"), `approve` (explicit prepared-artwork approval), `print_ready` (Phase 2). All idempotent |
| `GET /api/projects/[projectId]/artwork-preparation/image/[role]` | §13h: mint short-lived URL for `original` or `prepared`. The browser names a role, never an asset id; uniform 404 on every miss |
| `GET /api/assets/[...objectKey]` | Serve filesystem signed assets |
| `POST /api/worker/generation` | Independent concept-generation worker batch (secret-protected) |
| `POST /api/worker/final-artwork` | Sprint 2M Phase 2C: independent final-artwork worker batch (secret-protected) |

### Create New is a workflow transition, not a message (Correction A)

**A workflow choice is control state. The customer's message channel
carries the customer's own words and nothing else.**

Clicking "Create New Artwork" briefly posted a synthetic sentence — "I'd
like you to design new artwork for me." — to `/messages`. It fixed an inert
button and broke three things at once: the transcript showed a customer
bubble nobody typed; `/messages` runs Intent Extraction, so the sentence
landed in the Design Brief's **Additional notes**; and from there it was
headed into the generation prompt as creative input.

`POST /api/projects/:id/workflow` →
`ConversationCapability.beginCreateNewWorkflow` instead:

- adds **no** user message and touches **no** brief field
- lets the interview engine speak for itself — the same
  `briefEvaluation` → `designIntelligence` → `interviewIntelligence`
  → `applyActToInterviewState` tail every other turn ends with, run against
  the unchanged brief, so the wording is the engine's rather than copy
  duplicated in `ChatApp`
- creates no `GenerationJob` and consumes no free-concept entitlement:
  choosing a workflow is not a paid-value action, and the A4 fence stays
  exactly where it was, at enqueue
- is idempotent for everything a browser can produce (double click, retry
  after a lost response, reload), guarded read-then-write plus a re-check
  immediately before the append — the pattern
  `announceGenerationRefusal` already uses

Durability without schema work: the assistant turn it writes carries
`metadata.workflow = "create_new"`, and `isAtProjectStart` reads it back so
the workflow card is not re-offered on reload. This matters *because* the
synthetic message is gone — a Create New project has no customer turn at all
until the product question is answered, so "no customer turn yet" alone
would re-offer the card forever. Still not a client enum: if the transition
failed, no marker exists and the choice is correctly offered again.

`WorkflowChoice` is now upload-only. The `"create_new"` value was removed:
that branch is server state, and a client enum for it would be a second,
weaker answer to a question the server already answers.

**Only the BUTTON is control.** A customer who types "create new" is making
an ordinary conversational turn and is handled as one — no phrase filtering
exists or should be added.

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

`ApiProjectSnapshot` also carries `artworkPreparation` — an already-phrased
uploaded-artwork view (§13h) containing no analysis numbers, asset ids, or
storage keys. It is `null` for every Create New Artwork project, and that
`null` is what the UI branches on.

Sprint A4 adds `acquisition` — a `CustomerAcquisitionView` (§23b) carrying a
customer-safe state, already-phrased copy, and a boolean. It deliberately
excludes:

- the captured **email address** (only `emailCaptured: boolean` is returned)
- the acquisition session id and session token
- the persisted `entitlement` value — `internal` never appears on a customer
  surface, and an internal or legacy project is indistinguishable from an
  ungated prospect (`"open"`)
- the free-concept allocation/consumption fields and the job that spent it

The email address is never returned by any route, and never reaches a URL,
an asset filename, a provider prompt, or a log line.

Rules:

- Routes validate/translate requests (often with zod)
- Services/facades call capabilities
- Routes must not implement product rules
- Binary ingress (`artwork-upload`) bounds `Content-Length` before buffering
  and re-checks the buffered size; the real format comes from the magic
  signature, never the declared type or filename; decode limits are enforced
  against the image header before any bitmap is allocated (§13h)
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
| `ConceptCards` | Concept selection grid: loading state, real signed image, or safe placeholder fallback (Sprint 2K Phase 1); Phase 2D garment-color CSS preview + honest short-set note; no customer-facing provider/settings |
| `ConceptPreviewBackgroundControl` | Phase 2D: Garment / White / Gray / Black / Transparency inspection radios (presentation only; local UI state) |
| `concept-preview-surface` | Phase 2D: resolve approved `shirtColor` → CSS surface; short-set copy helper; never mutates assets |
| `PrepareForPrintAction` | Sprint 2M Phase 2B: the one explicit "final direction approval" action + truthful "preparing"/"print ready" states; plain customer language only — never job/asset/validation terminology |
| `WorkflowChoiceCard` | §13h: Create New Artwork vs Upload Existing Artwork, at project start only. "Create New" is a pure client-side dismissal — the existing interview is unchanged |
| `UploadedArtworkPanel` | §13h: the Upload Existing Artwork surface (upload → production details → analysis → compare → approved). Renders only server-authored copy |
| `ArtworkComparison` | §13h: labelled Original vs Prepared tiles; Prepared QA Preview Background (White/Gray/Black); `Enlarge` is a separate control from approval |
| `ArtworkPreviewModal` | §13h: read-only full-size viewer with **no** approval or cleanup affordance — viewing can never approve or mutate; prepared enlarge may reuse QA Preview Background |
| `GuidedCleanupWorkspace` | §13h Phase 1.4/1.5: large interactive cleanup surface (preview → confirm → undo → Done) with Fit/Zoom/pan and presentation-only Preview Background; presentation only over the Phase 1.3 API |
| `PreviewBackgroundControl` | §13h Phase 1.5: accessible White/Gray/Black QA inspection control (presentation only) |
| `guided-cleanup-interaction.ts` | §13h Phase 1.6B: pure selection-primary pointer rules (crosshair everywhere; Space/middle drag or touch drag pans; a pan never selects) — testable without a DOM |
| `uploaded-artwork-flow.ts` | §13h: pure step derivation + "does the upload workflow own the surface?" — testable without a DOM, same reason as `chat-affordances.ts` |
| `Composer` | Message input |
| `chat-session.ts` | localStorage project id restore/create |
| `status-poll-controller.ts` | Shared read-only generation + finalization status poller |
| `use-is-client.ts` | Hydration gate |

When the uploaded-artwork workflow owns the surface (§13h), the creative
surfaces — concept grid, design summary, status banner, revision actions,
Use This Design, Prepare Print-Ready, design history, and the composer — are
hidden rather than merely unreachable. An uploaded-artwork customer already
has their design and must never be walked through a design description, three
concept directions, or a wording interview.

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
| `OPENAI_CONCEPT_IMAGE_QUALITY` | `low` / `medium` (default) / `high` — explicit concept-image quality; `auto` is refused. Also the quality the Sprint A4 free concept is generated at (§23b) |
| `IHEARTPRINTS_INTERNAL_ACCESS_KEY` | Sprint A4: the secret `POST /api/internal/acquisition-access` grants the internal entitlement against (§23b). **Unset by default, with no development fallback** — an unconfigured deployment cannot grant it in any environment. Minimum 24 characters |
| `MAX_GENERATION_JOBS_PER_RUN` | Default 5 |
| `WORKER_HEARTBEAT_INTERVAL` | Default 15000 ms |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server persistence/storage |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Present on some hosts; never used for server table/storage access. A copy of this value in `SUPABASE_SERVICE_ROLE_KEY` is rejected (JWT `role` must be `service_role`) |

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

### 23.1 Current Data Access Model (server-only)

```text
Browser  ->  iHeartPrints Next.js server  ->  Supabase service role  ->  Postgres
```

Every public-schema application table is reachable **only** through the
server. Every one carries:

- Row Level Security **enabled**
- **Zero** policies
- **No** table privileges for `anon` or `authenticated`

`print_projects`, `tshirt_design_briefs`, `design_conversations`,
`conversation_messages`, `artwork_versions`, `design_brief_versions`,
`generation_jobs`, `assets`, `final_direction_approvals`,
`final_artwork_jobs`, `production_asset_validations`, `artwork_preparations`,
`paid_image_intents`, and — Sprint A4 — `acquisition_sessions` and
`acquisition_free_concept_claims`.

`acquisition_sessions` matters more than most: its rows hold email addresses
and the bearer tokens that gate spend. It is locked down in the same
migration that creates it, with no policy, for exactly the reason the
lockdown migration states — possession of a token is not identity.

`acquisition_free_concept_claims` is locked down the same way. Its
`BEFORE INSERT` trigger on `generation_jobs` runs `SECURITY INVOKER`, so it
depends on the writer already being `service_role`; that is deliberate, and
`SECURITY DEFINER` must not be added to "make the trigger work" — if the
trigger cannot write the table, the caller had no business inserting the job.

| Role | Direct PostgREST access |
|---|---|
| `anon` (incl. the publishable key) | denied — no privilege, no policy |
| `authenticated` | denied — no privilege, no policy |
| `service_role` | full; `BYPASSRLS` is the server-only boundary |

**RLS with no policies is the design, not an unfinished state.** No policy
means no row qualifies for any non-bypassing role, which is exactly the
current contract. Nothing in the browser speaks to PostgREST, so there is no
legitimate direct-access path to preserve.

**Project UUID knowledge is NOT authorization.** A project id is not a
secret — it appears in URLs and client state. No RLS policy, route check, or
future ownership rule may treat possession of an id as identity.

Two independent controls (RLS *and* revoked grants) rather than one: a
permissive policy added by mistake later still cannot expose these tables,
because the browser-facing roles hold no privilege on the relation to
exercise.

Enforced by `supabase/migrations/20260811191500_server_only_rls_lockdown.sql`,
which asserts its own postconditions against `pg_class`, `pg_policies`, and
`information_schema.role_table_grants` and aborts if they do not hold.

**Convention for new tables.** Every new public application table must
`ENABLE ROW LEVEL SECURITY` and `REVOKE ALL PRIVILEGES ... FROM anon,
authenticated` in the same migration that creates it.
`src/lib/db/security-lockdown.migration.test.ts` fails `npm run verify` when
one does not — the incident below is not permitted to recur with table #13.

**Origin.** A read-only audit found all twelve tables with RLS disabled, no
policies, and full `anon`/`authenticated` privileges; anonymous PostgREST
SELECT returned real customer data on every one, via both the legacy `anon`
key and the newer publishable key.

**Queued follow-up (blocks customer accounts, payment, and customer
management).** Owner-scoped policies cannot be written today because no
identity model exists — no `owner_user_id`, `user_id`, `tenant_id`, or
`organization_id` on any table. Before launching customer accounts:
implement real customer identity; add explicit project ownership; decide
whether a tenant/org model is needed; enforce authenticated authorization at
the app routes; and only then decide whether any direct Supabase client
access is warranted at all. Until that phase lands, inventing an ownership
column or a `using (true)` policy to satisfy a security advisor is
prohibited.

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
- The privileged Supabase client never falls back to a browser-facing key:
  `getSupabaseServiceClient()` demands `SUPABASE_SERVICE_ROLE_KEY`, inspects
  JWT/`sb_*` authority, and throws if the named variable is missing *or*
  authenticates as `anon`/`publishable` (never a secret value) — see §18
  and §23.1
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

## 23a. IP / Trademark Safety Boundary (Sprint A3)

### What this is, and what it is not

`IpSafetyCapability` (`src/capabilities/ip-safety/`) is a **product safety
boundary**: iHeartPrints will not knowingly help a customer create artwork
that reproduces, or deliberately imitates, recognizable third-party protected
branding — and will not help a customer evade those protections.

**iHeartPrints does not provide legal clearance.** Nothing in this boundary
determines, asserts, or implies that artwork is legally safe, licensed,
trademark-cleared, copyright-cleared, or owned by anybody.

- An `allow` decision means only *"this request does not trip the product
  boundary"*. It is never a statement that anything is legal.
- A `block` decision means only *"iHeartPrints will not produce this"*. It is
  never a finding that the customer has infringed anything.

Generic themes, styles, colors, cities, sports, eras, and moods remain fully
allowed — they are the product. Protected-brand vocabulary alone is never
sufficient to refuse a design.

### Detection and enforcement are separate responsibilities

| | Question answered | Where |
|---|---|---|
| Detection | "What does the customer appear to be asking us to create?" | `ip-safety/ip-safety-detection.ts` (pure) |
| Enforcement | "May iHeartPrints send this request to the generation provider?" | `IpSafetyCapability` + the three fences below |

Keeping them apart is what stops provider behavior from silently becoming the
product's safety policy.

### Provider safety is independent and unchanged

The boundary is strictly **additive**, and sits in front of provider safety
so that a request iHeartPrints will not make is never paid for:

```
customer intent
  → iHeartPrints IP safety   (deterministic, ours)
  → allowed generation request
  → the provider's own safety systems  (independent, untouched)
  → result
```

A3 changed no provider-refusal handling. Existing provider failure semantics
stand, and nothing fabricates artwork when a provider refuses.

### The three fences

Blocked generation must happen **before paid provider work**, so the fence is
placed where "no paid call happens" is structural rather than policy.

1. **Conversational gate** — `ConversationCapability`, after the turn is
   semantically interpreted and **before** Intent Extraction's proposals are
   applied. A blocked request never becomes Design Brief content, never marks
   concepts stale, and never triggers an automatic revision.
2. **Enqueue fence** — `ConceptGenerationCapability`, **before any
   `GenerationJob` row exists**. No job means no worker claim, which means no
   paid call. Initial generation, three-direction alternatives, an additional
   exploration batch, and a targeted revision all funnel through its two
   enqueue functions, so one fence covers every generation path.
3. **Pre-provider fence** — `GenerationWorkerCapability.runClaimedJob`,
   before `planPaidImageUnits` and any dispatch. Unreachable in ordinary
   operation; it exists because a job could pre-date a brief change, be
   recovered, arrive from a future enqueue path, or be created directly.

Proved with counting provider fakes: a blocked request produces **zero**
provider dispatches while the allowed pipeline stays fully reachable
(`ip-safety/ip-safety-generation-fence.test.ts`).

### Structured authority — derived, never persisted

There is **no `ip_safety` column and no migration**. Both generation fences
evaluate the *structured generation intent*, composed into one canonical
subject by `ip-safety/safety-subject.ts`:

- the approved `DesignBriefVersion`'s generation-bearing design content
  (`designDescription`, `designStyle`, `additionalInstructions`,
  `exclusions`), and
- the job's own literal `revisionInstruction`.

They deliberately do **not** re-scan the conversation transcript at
provider-call time. That would resurrect requests the customer already
retracted, and would miss design content that arrived structurally.

#### One canonical subject (Correction 2)

Evaluating each field independently let an unsafe request escape by being
*split* — a protected referent in one field and the production instruction in
another, neither complete on its own, both present in the prompt that would
have been sent:

```
designDescription      = "Raiders"
additionalInstructions = "use the exact shield"
```

`buildGenerationIntentSubject` is the **single construction both fences use**,
so they cannot drift. Parts are joined with `", "` for two specific reasons
that fall straight out of how the detector scopes:

- a comma is **not** a clause boundary, so a referent in one field can still
  be associated with a binding in another; and
- a comma **is** an operator-scope terminator, so a negation or removal in one
  field cannot leak forward and silently neutralize a different field.

Order is load-bearing: the customer's **current instruction comes first**,
because operators scope forward and a corrective instruction has to be able to
govern the design context behind it.

```
revision = "remove the logo and make it original"
design   = "Raiders themed football design"
→ "remove the logo and make it original, Raiders themed football design"
  "remove" governs "the logo"; nothing binds the surviving "Raiders". ALLOWED.
```

**Audited field list.** Only generation-bearing free text that describes the
*artwork* is included. `exactText` (literal text to print — a shirt reading
"Raiders" is wording, not a logo request), `preferredColors`, `productSummary`,
`audience`, `purpose`, `shirtColor`, and `printPlacement` are excluded, so
"audience: Raiders fans" can never combine with an ordinary "logo" into a
false refusal.

#### Bounded multi-turn authority (Correction 3)

A request can be split across turns just as easily as across fields:

```
turn 1: "I want a Raiders design."   ← a theme; allowed on its own
turn 2: "Use their exact shield."    ← names no brand at all
```

The conversational gate therefore composes the current message with a
**bounded window of the customer's own recent turns**
(`RECENT_CUSTOMER_TURN_WINDOW`, currently 2). Nothing is persisted and no
schema changed — the window is derived from the conversation record the
project already has.

Two deliberate constraints keep it from becoming stale poisoning:

- **Refused turns are excluded.** A blocked message would otherwise keep
  re-blocking the rephrasings that follow it — the customer would be told to
  rephrase and then punished for it. Detected structurally: a user message
  whose next assistant message is the IP safety redirect.
- **The Design Brief is not folded into the gate.** A theme legitimately
  recorded there ("Raiders design") would combine with every later mention of
  the word "logo" for the life of the project. The brief is where the two
  *generation* fences work instead — which is the moment it actually matters,
  because that is what gets drawn.

Recomputation from current intent is what makes both required lifecycle
transitions free, with nothing to explicitly un-set:

```
unsafe → customer revises → safe → generation allowed
safe   → customer adds a protected-mark request → blocked
```

**A project is never permanently poisoned by one blocked request.** A block
writes nothing durable except the assistant's redirect message: no brief
change, no phase change, no status change, no `revisionPending`, no
supersession of an approval.

### The decision

Two outcomes: `allow` and `block`. A `review` outcome was considered and
**rejected** — iHeartPrints has no manual-review queue, reviewer role, review
surface, or project state to sit in while a human looks at something.
Introducing the value would have created a review workflow that does not
exist.

Internal reasons (`third_party_mark_reproduction`,
`recognizable_mark_imitation`, `protected_character_reproduction`,
`protection_evasion_request`) are **internal only**. They never reach a
customer-facing message, message metadata, or `ProjectSnapshot`.

### Customer experience

`ip-safety/customer-response.ts` is the single place a decision becomes
language. It emits **one** redirect for every reason — a reason-specific
message would let the internal classification be read straight off the prose.
The copy:

- makes no legal conclusion and accuses the customer of nothing;
- states no threshold, percentage, or amount of change that would be
  acceptable (the product must never teach evasion);
- exposes no policy internals; and
- redirects toward an original design rather than dead-ending.

### Economics — no new paid call (Goal 16)

A3 introduces **no additional paid model call**. The semantic layer rides on
the *one* Conversation Understanding interpretation each pre-approval /
revision turn already makes, as a new optional
`ConversationUnderstandingResult.ipSignal` (§10a).

That signal is a **hint only**: `CONVERSATION_UNDERSTANDING_PROVIDER` defaults
to `none`, the call is skipped for single-token replies, and it degrades to an
empty result on any failure. The deterministic detector is therefore the floor
and the sole input to both generation fences.

**Precedence (Correction P2).** The hint may *extend* deterministic recall —
it is the only way a mark nobody enumerated gets caught — but it may never
contradict safety the customer wrote plainly:

| Situation | Outcome |
|---|---|
| Deterministic block | Blocks. No signal can lift it. |
| Malformed / unknown-kind signal | Sanitized to `null`; changes nothing. |
| `"ambiguous"` signal | Never blocks. |
| `"explicit"` / `"inferred"`, no deterministic opinion | May block — this is the recall extension. |
| `"explicit"` / `"inferred"`, safe evidence covering **the same request** | Never blocks. |

"Safe evidence" means the customer wrote the safety down: a negation,
removal, or avoidance operator, or an ownership claim over branding nobody
recognizes. "Don't use the Raiders logo" must not be refused because a model
guessed at the sentence.

Controlled live acceptance established a production-critical invariant: the
semantic interpreter may conservatively emit a protected-mark signal for
customer-owned branding, so signal presence alone is not sufficient to refuse
a request. Ownership-scoped positional evidence suppression is part of the
decision boundary. A semantic finding may be suppressed only when its exact
evidence is fully covered by the ownership or safe scope that explains that
same request.

#### Suppression is scoped to the same request (Correction 3)

Two weaker rules were tried, and both leaked in the expensive direction:

| Rule | Leak |
|---|---|
| "there is safe structure somewhere in the subject" | any decoy negation immunized everything |
| "…and no surviving deterministic request structure" | ownership in one instruction immunized the next; a semantic-only entity was invisible to the check |

```
"Recreate our logo, then reproduce theirs."
 └── owned, explained ──┘  └─ someone else's, NOT explained ─┘

"Don't use the old logo, draw that famous cartoon mouse exactly."
 └───── neutralized ─────┘  └─ invisible to the lexicon entirely ─┘
```

The second is decisive. Nothing deterministic exists for "that famous cartoon
mouse", so no occurrence count, lexicon entry, or counter can represent it —
and representing it is the whole point, because covering entities nobody
enumerated is what the semantic layer is *for*.

The signal's own `evidence` quote — already required by the `IpSafetySignal`
contract — is the only handle on **where** its request lives. So the rule is
positional:

> `isCoveredBySafeEvidence(subject, quote)` — do the customer's quoted words
> sit inside a neutralizing operator's scope, or inside an
> **ownership-explained segment**?

A *segment* is the stretch between scope terminators: one instruction.
"Recreate our logo" and "then reproduce theirs" are two, which is exactly why
the possessive in the first cannot reach the second.

Unlocatable evidence (empty, or paraphrased past recognition) cannot establish
that the safe wording covers this request, so it does **not** suppress — the
conservative direction on a spend boundary, and the provider prompt requires a
real quote.

The lookup itself is hardened in two ways (Correction 4), both of which were
exploitable:

| Rule | Exploit it closes |
|---|---|
| **Every occurrence** of the quote is checked, not just the first | `"Don't use the X logo, then recreate the X logo."` — a safely covered copy immunized an identical uncovered one. Holds in either order. |
| **Full containment** (`start >= scope.start && end <= scope.end`), not "starts inside" | `"Don't use the old logo, recreate the Fictitious Rovers badge."` with the quote `"old logo, recreate the Fictitious Rovers badge"` — the quote began inside the negation and ran out the other side, carrying the unsafe half under cover of the safe half. |

Nothing tells us which occurrence the model was looking at, and the model sees
the recent-turn window too, so any uncovered occurrence is a request the safe
wording does not account for. Full containment is applied identically to
neutralizing scopes and ownership-explained segments, and every scope
terminator (`,` `;` `:` `and` `but` `then` `just` `while`) is covered by
regression tests.

This subsumes any per-kind rule. A character request is blocked in the decoy
sentence because it sits outside the negation's scope, not because it is a
character; "Don't use that famous cartoon mouse" is allowed for the same
positional reason. **No character or organization lexicon is involved in
either direction**, and the deterministic verdict is untouched — the locator
only ever decides what the semantic layer may do.

Malformed output is discarded at the enforcement boundary as well as by
`ConversationUnderstandingCapability` — an unrecognized `kind` or
`confidence` is dropped rather than coerced into a refusal, so "malformed
output cannot disable deterministic enforcement" is a property of the fence
itself and not of one upstream sanitizer.

#### Why the fences stay deterministic

A semantic-only entity is caught at the **conversation gate and nowhere
else** — the enqueue and worker fences read the structured brief and cannot
name it. That division is sound only because the gate refuses *before* Intent
Extraction applies anything, so nothing unsafe is ever retained. Both audited
bypasses are pinned end to end
(`ip-safety-semantic-scope-e2e.test.ts`): zero provider dispatches, no unsafe
brief mutation, and safe generation still reachable on the same project.
Adding a second model call at the fences to duplicate the gate was explicitly
rejected.

### Scoping is per-occurrence, never per-clause (Correction 1)

The first implementation cleared an **entire clause** the moment a
disqualifying word appeared anywhere in it. That was wrong in the worst
direction — an unrelated trailing instruction silently unblocked an explicit
reproduction request:

```
"Make me the Raiders logo, no text."          ← "no" governs "text"
"Make me a Raiders logo and don't add more."  ← "don't" governs "add"
"Use the Nike swoosh, no words."              ← "no" governs "words"
```

A neutralizing operator now has **scope**: it runs from where it appears to
the next scope terminator (`, ; : . ! ?` or a coordinating conjunction) and
neutralizes only the referent occurrences inside it. A finding requires a
*surviving* protected referent and a *surviving* binding — occurrences, not
clause-level booleans. Evasion phrases scope more strictly still, because
several embed their own operator word ("copy this logo **without** making it
obvious", "**remove** the trademark symbol"): only an operator sitting
*strictly before* the phrase takes it back, which is what distinguishes
"don't make a knockoff" from the idiom itself.

Contextual "safe words" — `themed`, `vibe`, `feel`, `inspired by`, `I like`,
`said`, watch-party vocabulary — no longer disqualify anything. They never
carried the allow-cases: "a pirate-themed football shirt" is allowed for the
far better reason that it contains no protected referent at all. Removing
them closed a whole family of trivially-worded requests ("Raiders themed,
including their shield", "Same vibe as the Raiders logo", "Raiders logo
inspired").

### Precision over recall

The two failure modes are not symmetric. A false negative leaves the
provider's own independent safety systems and a human in the loop. A false
positive refuses a paying customer's perfectly ordinary design with no way to
argue. Detection therefore says nothing unless a request is unmistakable, and
these all stay allowed because the operator genuinely governs the referent —
or because there is no referent at all:

| Why it is allowed | Example |
|---|---|
| Negation governs the referent | "Don't use the Raiders logo." |
| Avoidance governs the referent | "Make this NOT look like the Raiders." |
| Removal (result is unbranded) | "Remove the Nike logo from the reference." |
| Ownership claim over an unrecognized name | "Recreate our Rivera Plumbing logo." |
| Customer business name | "Raiders Plumbing LLC needs a new logo." |
| No protected referent | "Create a generic athletic motion mark." |
| Brand named, nothing bound to it | "My company is doing a watch party for the Raiders." |

The one exception: an ownership claim never rescues a *recognized*
third-party mark — "recreate our Raiders logo", "our Nike swoosh needs to be
bigger", and "we own this NFL logo; reproduce it" all stay blocked.

**Business-name collisions.** A recognized token immediately followed by a
trade or legal-entity noun ("Raiders Plumbing LLC", "Supreme Roofing",
"Mickey Mouse Plumbing") is a customer business *name*, and that
**occurrence** is not a protected referent. Occurrence-level, never
clause-level — "Raiders Plumbing wants the Raiders logo on their shirts"
still blocks — and narrow: "logo", "shield", and "crest" are not on the
continuation list. This is a reading of sentence structure, not an ownership
or rights determination.

The deterministic layer carries a small, **explicitly incomplete** backstop
lexicon of widely recognized organizations and characters. It is not the
policy, it is not a trademark register, and absence from it is never a
statement that something is safe — it exists so the boundary still holds with
the semantic layer offline. A lexicon hit is never sufficient on its own: a
surviving organization must sit alongside a surviving brand-identifier noun,
reproduction verb, or imitation cue. **Documented gap:** a bare possessive
over an unrecognized name ("recreate Rivera Plumbing's logo") is deliberately
not treated as a third-party mark, because it is structurally identical to the
most common legitimate business request.

### What a worker-fence refusal leaves behind

Refusing at the last fence is a product decision, not an infrastructure
failure, so it never borrows the "we ran into a problem, try again" failure
path. For every refused worker path — initial, targeted revision,
three-direction regeneration, exploration, and recovery/resume — the same
properties hold and are tested
(`ip-safety/ip-safety-worker-lifecycle.test.ts`):

- the provider was dispatched **zero** times;
- the `GenerationJob` reaches a terminal state, so nothing re-claims it
  forever (a recovery sweep re-refuses it without spending and without
  forking a second job);
- the project leaves `generating`, so browser polling terminates;
- the project lands somewhere the customer can act from — `edit_requested`
  for a refused initial generation, `ask_revisions` for a refused targeted
  revision, `concepts_ready` for a refused batch;
- `revisionPending` is **cleared** on the revision paths: a revision that
  will never happen must not leave a permanent bar on finalizing artwork the
  customer already has and still wants;
- the existing concept selection and every existing `ArtworkVersion` are
  untouched; and
- a later safe request is accepted and safe generation proceeds normally.

### Existing Artwork: technical preparation ≠ new protected-IP generation

`ArtworkPreparationCapability` is local, deterministic pixel work. It
generates nothing, calls no provider, and spends nothing, so **A3 adds no
gate to it**. Upload → prepare → approve → size → Production PNG →
validation → `print_ready` → download is unaffected.

Preparing supplied artwork is a **technical operation, not an
ownership determination**. iHeartPrints does not verify who owns an uploaded
file and must never claim to — no "you own this", no "this is licensed", no
"this is cleared". For V1, uploaded artwork may be prepared into the
Production PNG unless the customer explicitly asks iHeartPrints to reproduce,
imitate, alter, or evade recognizable third-party IP.

Asking iHeartPrints to *redesign* supplied artwork into recognizable
third-party branding is generation, and meets the same boundary as any other
generation request (`ip-safety/existing-artwork-ip-safety.test.ts`).

### Ownership architecture is separate and unchanged

`OwnershipCapability` remains reserved future provenance/licensing
architecture (Constitution §17) and was **not modified** by A3. The two must
never be merged:

- **Ownership classification is not trademark or copyright verification.**
  `customer_owned` remains the current default product classification and
  says nothing about third-party rights.
- **IP Safety is a generation/use-policy boundary**, evaluated per request,
  never stored, never a rights record.

Deriving one from the other, in either direction, would turn a deliberate
stub into a fake legal-rights verification system.

### Dependency direction

`IpSafetyCapability` is a **leaf**: pure, synchronous, zero dependencies,
`createIpSafetyCapability()` takes no arguments. Callers resolve brief content
and pass plain data — the same "caller does I/O, capability only decides"
shape as `PrintValidationCapability`. `ConversationUnderstanding` depends on
`ip-safety/contracts` **type-only**, for the `ipSignal` shape; it never
interprets, enforces, or persists it. See
`src/capabilities/shared/capability-boundaries.ts` for the full allowed /
forbidden list.

---

## 23b. Acquisition Entitlement Boundary (Sprint A4)

### What this is, and what it is not

`AcquisitionCapability` (`src/capabilities/acquisition/`) implements the
first controlled acquisition funnel:

```
anonymous visitor → design conversation → ONE free concept
                  → email required to continue → production unlock (§23c)
```

It is **spend control**, not identity. It is explicitly **not**
authentication, not an account system, not a customer identity model, not
marketing consent, and not an anti-fraud platform. It holds no password, no
verified identity, and no consent record, and no surface in the product may
describe it as an account having been created.

**There is still no payment provider, checkout, subscription, or pricing in
this codebase.** Sprint A5.1/A5.2 added the commercial entitlement
(`ProductionUnlock`, §23c) and wired it into the finalization gate; A5.3+
owns the provider that would let a customer obtain one. Every image-
generation action beyond the one free concept remains refused for an ordinary
prospect regardless of any unlock, and `acquisition_sessions.entitlement`
deliberately still has no `paid` value — the unlock lives on the project, not
on the session.

### The domain model

`AcquisitionSession` (`acquisition_sessions`) is an opaque, server-issued
anonymous session. `print_projects.acquisition_session_id` binds each
project to the session that created it.

| Concept | Meaning |
|---|---|
| `entitlement` | `prospect` (ordinary visitor) or `internal` (explicit server-side grant) |
| `freeConceptProjectId` | the free concept is **allocated** to this project |
| `freeConceptGenerationJobId` | the free concept is **consumed** by this job |
| `email` / `emailCapturedAt` | captured to continue the design session |
| `internalGrantedAt` | audit trail for an internal grant |

**Allocation vs consumption is the load-bearing distinction.** Conflating
them would either burn a customer's free concept for a failure that was
ours, or hand out a second one:

```
ALLOCATED   atomic claim (NULL -> project id), taken BEFORE any job exists.
            Two racing requests resolve to one allocation. Costs nothing —
            an enqueue that fails before a durable job exists leaves the
            free concept intact, and re-requesting on the same project
            resumes the same allocation.

CONSUMED    a durable GenerationJob exists, bound to the session by
            `generation_jobs.acquisition_session_id`. This is the moment the
            platform committed to a recoverable, idempotent, spend-bounded
            attempt. Irreversible: no second free generation is ever
            authorized for this session, including on the same project.
```

### The authority is a database constraint, not an application write

**Correction 1.** Consumption was originally recorded by a write
(`acquisition_sessions.free_concept_consumed_at`) that happened *after* the
job insert. Two separate writes with a crash window between them: if the job
insert succeeded and the marker write failed, an executable job remained
while the session still read as unspent — and could authorize a **second**
free job.

Ordering cannot close that window. The guarantee is now a constraint:

```sql
create unique index generation_jobs_acquisition_free_concept_idx
  on public.generation_jobs (acquisition_session_id)
  where acquisition_session_id is not null;
```

**At most one free-concept generation job per acquisition session, enforced
by PostgreSQL.** The insert *is* the authority.
`AcquisitionCapability.authorizeConceptGeneration` remains a pre-check that
avoids doing work destined to fail; it is not the guarantee. A refused
insert surfaces as `FreeConceptAlreadyConsumedError` and converts to a
customer-safe refusal — nothing was spent, because no job means nothing for
a worker to claim.

Consumption is therefore answered from **two** independent sources, either
sufficient:

| Source | Survives |
|---|---|
| `acquisition_sessions.free_concept_consumed_at` | job deletion, session-row cleanup |
| `generation_jobs.acquisition_session_id` | a lost or never-written marker |

`recordFreeConceptConsumed` is now a denormalized marker rather than the
authority, so its failure is logged and swallowed: the customer's job is
already durable and queued, and failing their request would not un-spend it.
`AcquisitionCapability` reconciles the missing marker from the job on the
next read.

### Deletion semantics

Every FK in the acquisition graph was originally `ON DELETE SET NULL`, and
each one could erase authority by removing a row:

| Relationship | Rule | Why |
|---|---|---|
| `print_projects.acquisition_session_id` → session | **RESTRICT** | `SET NULL` let a deleted session manufacture the `NULL` that means "legacy, grandfathered" — deleting one row would have granted unlimited free generation |
| `acquisition_sessions.free_concept_project_id` → project | **RESTRICT** | `SET NULL` let a deleted project clear an allocation, freeing the session to allocate again |
| `generation_jobs.acquisition_session_id` → session | **RESTRICT** | `SET NULL` would convert the free job into an ordinary one and free the unique slot |
| `acquisition_sessions.free_concept_generation_job_id` → job | **no FK** | Deliberately demoted to an immutable historical reference. `RESTRICT` would make an ordinary job undeletable forever to protect a field that is not the authority; the consumed timestamp beside it is, and nothing cascades to a timestamp |

Acquisition sessions are not deletable as routine cleanup, by design.

### Missing authority fails closed

`PrintProject.acquisitionSessionId` has **three** meanings, and only one is
permissive:

| State | Reading |
|---|---|
| `NULL` | **legacy** — genuinely predates A4. Grandfathered, deliberately |
| set, session loads | the real authority |
| set, session does **not** load | **fails closed** — never legacy, never internal |

Originally the third case returned the same `null` as the first, so a
deleted, corrupted, or unreadable session *granted* unrestricted generation
and finalization. Losing a row must never be the thing that hands out spend.
A repository error while resolving authority is treated the same way.

### Authority resolution — why the gate cannot be bypassed

Every paid-value decision resolves authority from the **project**, via
`PrintProject.acquisitionSessionId`, and never from anything the caller
supplied. A cleared cookie, a forged cookie, or no cookie at all changes
nothing, so a direct API call is no more powerful than the UI.

The cookie (`ihp_as`; httpOnly, `SameSite=Lax`, `Secure` in production)
decides only which session a **brand new** project is created under. It
carries one opaque token and nothing else — no project id, no email, no
entitlement state, no counter.

`acquisition_session_id = NULL` means **legacy** (created before A4) and is
grandfathered, never "unentitled". After A4 every project created through
the customer API is bound in the same INSERT that creates it, so no new
NULL can appear through a customer path.

### "One free concept" means one concept AND one paid image dispatch

Not one batch of three. `GenerationJob.conceptCount` already carries the
customer-visible meaning end to end (targeted revisions have used it since
the Live Acceptance Corrective Pass), so the free concept is expressed as
`conceptCount: 1` — the same worker, the same prompt translation, the same
paid-intent checkpointing, one direction instead of three. **No provider
contract, interface, or pipeline was changed.** Quality is the configured
default (`OPENAI_CONCEPT_IMAGE_QUALITY`, `medium`), deliberately not
downgraded: a concept too weak to judge cannot demonstrate the product.

**Correction 1: `conceptCount: 1` was never sufficient for the money.**
`paidIntentBudgetForJob` adds the Phase 2C replacement allowance *on top of*
the concept count, so a one-concept job carried a budget of `1 + 2 = 3` paid
images. The promise was true of what the customer saw and false of what was
spent.

The budget is now resolved from durable job authority by
`paidIntentBudgetForGenerationJob`, which returns **exactly 1** whenever
`acquisitionSessionId` is set. Production code must call that function;
`paidIntentBudgetForJob` remains the pure concept-count policy and cannot
see the fact that overrides it.

| Job | Paid-image budget |
|---|---|
| acquisition free concept | **1** |
| initial / alternatives batch (3) | 5 (3 + 2 replacements) |
| targeted revision (1) | 3 (1 + 2 replacements) |

**Phase 2C replacement is not offered for the free concept, and the concept
is not withheld either.** `GenerationWorkerCapability.maybeReplaceHardFailures`
returns early for an acquisition job, beside the existing targeted-revision
early return. Letting the budget merely *refuse* the reservation would take
the withholding path, which is right for a batch of three (two good
directions still reach the customer) and catastrophic for a batch of one:
the customer's single free concept would be suppressed, they would see
nothing, and their entitlement would already be spent — a quality defect
converted into delivering nothing.

So the free concept is delivered as generated. The deterministic palette
verdict is still computed and still recorded on the artwork version; only
the replacement *purchase* is withheld. The promise is one concept, not one
concept with unlimited quality retries. **Ordinary paid jobs are entirely
unaffected** — same budget, same replacement allowance, same withholding.

**Correction 2: one paid INTENT is not one physical SUBMISSION.** A single
logical intent may be dispatched `MAX_PAID_DISPATCHES_PER_INTENT` (3) times,
because an ambiguous post-dispatch failure cannot be proven un-billed and the
ordinary policy prefers retrying to stranding a paying customer. One free
concept could therefore still reach three physical submissions.

That trade is correct for paid work and wrong for a giveaway. For work
somebody paid for, refusing to retry risks taking their money and delivering
nothing, so the platform absorbs the duplicate-billing risk. For an
acquisition attempt there is no such obligation.

`maxPhysicalDispatchesForGenerationJob` returns **1** for an acquisition job
and `MAX_PAID_DISPATCHES_PER_INTENT` for every other. It is resolved once per
`executePaidImageUnit` and used at all four points that previously read the
module constant, so the free path cannot silently regain submissions.

**Correction 3: the claim must be taken after local preflight, not before.**
The durable dispatch counter has to mean *"we have crossed the point where an
external paid request may actually be sent"*, not *"we entered the code path
that might eventually try"*. It previously meant the latter: an adapter that
fails on local configuration — `UnavailableConceptGenerationProvider` is
exactly that — threw from inside `dispatch`, which runs **after** the claim.
A definite local failure therefore produced `dispatches = 1` with **zero**
external submissions, spending the customer's only free attempt on our own
misconfiguration.

`ConceptGenerationProvider.assertReadyToDispatch?()` (optional) is a **local**
readiness check run immediately before the claim. It confirms credentials,
enablement, and local configuration are good enough to *attempt* a request —
and it **must not make a network call**: a preflight that talked to the
provider would either cost money or turn a remote hiccup into a refusal to
attempt work the customer is waiting for.

| Provider | Preflight |
|---|---|
| `UnavailableConceptGenerationProvider` | throws the same error `generate` would — the failure simply moves to the correct side of the boundary |
| `OpenAIConceptGenerationProvider` | asserts API key and model, locally. Enablement, asset storage, and paid arming stay with `resolveConceptGenerationProvider`, which returns the unavailable stub when they fail — never duplicated in worker code |
| `PlaceholderConceptProvider`, test fakes | omitted; absence reads as ready, which is true of them |

Ordering is deliberate on both sides. Preflight runs **after** reuse and
orphan adoption, so recovering an image the platform already bought is never
blocked by a provider whose configuration has since broken (those paths
contact nothing). It runs **immediately before** the claim, with nothing
between them, so there is no window in which the claim is taken for a call
that never happens.

It does not weaken concurrency: two workers may both preflight, only one can
win `beginPaidImageIntentDispatch`, and the loser never reaches the provider.
The claim remains the sole concurrency authority.

It claims no billing certainty. Preflight speaks only about this process.

| Failure | Free job | Ordinary job |
|---|---|---|
| local config / missing credential / disabled provider (**pre-claim**) | retryable — dispatch count stays 0, entitlement intact, same job resumes after repair | retryable |
| provably `not_dispatched` (never reached provider) | retryable — nothing billed, entitlement intact | retryable |
| DNS, reset, timeout, 4xx, 5xx — anything after the claim | **terminal.** Counted as one dispatch; no second submission | retried within the ceiling |
| ambiguous / possibly billed | **terminal.** No second submission | retried within the ceiling |
| resume / orphan adoption | not a dispatch; reuses the same result | not a dispatch |

Once the external boundary is crossed the free dispatch is consumed, and no
attempt is made to infer whether a particular HTTP failure was billed.

An ambiguous free failure is terminal in one attempt: the intent is marked
`failed` at the ceiling, the job fails, the project reaches `failed`, and the
customer gets the standard customer-safe message rather than an unresolving
spinner. `ConceptGenerationCapability` additionally refuses to **re-queue** a
failed acquisition job once `paid_image_intents.dispatches > 0` — re-queuing
would burn two more job attempts being refused before any provider call, with
a spinner running each time. A job whose dispatch count is still `0` is
genuinely pre-dispatch and stays retryable.

Residual risk, stated rather than hidden: an ambiguous failure the provider
actually billed still costs one image. Unavoidable without provider-side
idempotency this endpoint does not document — but bounded at one, not three.

### The lifetime authority is a session-owned tombstone

**Correction 2.** The partial unique index above only constrains rows that
**exist**. Deleting the free `GenerationJob` freed the slot, so a direct
insert could hand the same session a second free concept — the application's
own consumed marker survived, but an application pre-check is not authority.

```sql
create table public.acquisition_free_concept_claims (
  acquisition_session_id uuid primary key
    references public.acquisition_sessions (id) on delete restrict,
  generation_job_id uuid null,        -- historical evidence, NOT a foreign key
  claimed_at timestamptz not null default now()
);
```

The primary key **is** the invariant: one claim per session, for the lifetime
of the session rather than the lifetime of a job. It holds no foreign key to
the job, so it keeps enforcing after that job is gone, and a dangling
`generation_job_id` is the correct record of what happened.

The claim is taken by a `BEFORE INSERT` trigger on `generation_jobs`, so
claim and job are created in **one statement and one transaction**. Two
application writes would reintroduce the crash window in mirror image —
claim-first burns the customer's free concept for our failure, job-first
leaves an executable job with no claim. There is no ordering to get wrong.

The trigger is `SECURITY INVOKER` with a pinned `search_path`, deliberately
**not** `SECURITY DEFINER`: only `service_role` writes `generation_jobs`, and
it holds `BYPASSRLS`, so no elevated execution path is needed or created.

Job deletion is therefore an operational choice with an operational
consequence (the job is unrecoverable) and never an entitlement one. The
alternative — `ON DELETE RESTRICT` making free jobs permanently undeletable —
would impose indefinite retention on an operational table to protect an
invariant a session-owned row already protects.

### Defence in depth

Three independent layers, none compensating for another:

| Layer | Guarantee | Enforced by |
|---|---|---|
| Lifetime authority | one free attempt per session, forever | `acquisition_free_concept_claims` primary key + BEFORE INSERT trigger |
| Live authority | exactly one authorized `GenerationJob` while it exists | partial unique index on `generation_jobs.acquisition_session_id` |
| Worker economics | one paid intent **and** one physical submission | `paidIntentBudgetForGenerationJob` + `maxPhysicalDispatchesForGenerationJob` + `paid_image_intents` |

`AcquisitionCapability.freeConceptSpent` reads the **claim first** — the thing
the insert is actually validated against — then the consumed marker, then the
job. Any read failure resolves to CONSUMED: a database that cannot be read
has not said yes.

### The three fences

Each sits where the durable record that authorizes spend is created, so a
refusal removes the spend structurally rather than by policy.

| Fence | Location | Refuses |
|---|---|---|
| Generation | `ConceptGenerationCapability` enqueue (with the A3 IP fence) | any new `GenerationJob` — initial, alternatives, exploration batch, targeted revision |
| Finalization | `FinalArtworkCapability.requestFinalArtwork` / `requestPreparedUploadFinalArtwork` | any new `FinalArtworkJob`, which is what the final-artwork worker claims before dispatching paid Topaz reconstruction |
| Email-to-continue | `ConversationCapability.handleUserMessage` | a further design turn once the free concept has been **delivered** and no address is on file |

The generation fence runs **only when a genuinely new job would be
created**. Resuming an existing job (reload, second tab, duplicate request,
retry after failure, worker reclaim) never requires a second entitlement and
never produces a second paid attempt — that job's spend is already bounded
by its own `paid_image_intents` budget and `MAX_GENERATION_ATTEMPTS`.

### Email capture

Captured to continue the design session. Trimmed, lowercased, length-bounded,
and checked against a deliberately permissive pattern
(`capabilities/acquisition/acquisition-email.ts`) — a false rejection means a
real customer cannot continue, which is worse than accepting an address
nothing in A4 sends mail to.

**Email is not marketing consent, and it is not an entitlement.** No
verification message, no OTP, no account, no password, no CRM integration,
no consent checkbox (there is no consent being collected). Capturing an
address does not restore a spent free concept, authorize generation, or
unlock finalization.

The address is **never returned in any customer-facing response** — the
snapshot carries only `acquisition.emailCaptured`. It never appears in a
URL, an asset filename, a provider prompt, or a log line.

### Customer-safe state

`ApiProjectSnapshot.acquisition` is a `CustomerAcquisitionView`, deliberately
not the persisted enum:

| State | Meaning |
|---|---|
| `open` | nothing is gated — a fresh prospect, an internal session, or a legacy project, indistinguishably |
| `free_concept_generating` | their concept is being made |
| `email_required` | their concept has been **delivered** (see below); an address unlocks continuing |
| `continue_locked` | further design work needs access not sold yet. **Correction 2:** also covers a spent free attempt that delivered nothing (a failed attempt, or a removed job) — that used to read `open`, which invited an action the gate would refuse. **Correction 3:** only when a physical dispatch actually happened — an attempt stopped by local configuration before any submission stays `open`, because that customer's free concept is intact and their next click will work |
| `unavailable` | **Correction 1.** The server cannot establish what this session may do. **Correction 2:** also disables the composer and every paid-value control (`deriveChatAffordances`), so the UI never invites an action the server is known to refuse |

Copy never mentions credits, quotas, spend, provider cost, entitlement rows,
or abuse prevention. `internal` never appears on a customer surface.

`unavailable` replaced a catch-to-`open` degradation in
`conversation-service.resolveAcquisitionView`. That degradation was
spend-safe — every real paid-value decision is made independently by the
capability that owns the spend, and those all fail closed — but
product-unsafe: `open` renders a UI offering actions the server is about to
refuse, so the page and the server that produced it openly disagreed. The
state is also derived through the same reconciliation the gates use, so
"what the customer is shown" and "what the server will do" cannot drift.

### What "delivered free concept" means (Correction C)

**Delivery is customer-ready generated concept evidence — never the mere
existence of an `ArtworkVersion` row, and never a prepared upload.**
`shared/concept-delivery.ts` (`hasDeliveredGeneratedConcept`) is the single
definition of what a customer-ready concept IS.

All three must hold:

| Fact | Why |
|---|---|
| `project.status !== "generating"` | the generation worker writes `ArtworkVersion` rows, then runs provisional validation, then completes the job, then sets `concepts_ready` — each a separate write. Rows genuinely exist while the project is still generating |
| at least one artwork of a **generated** kind (`concept`, `revision`) | `prepared_upload` is the Existing Artwork customer's own pixels, never a free Create New concept (provenance is never inferred — Constitution §6.11 / §16) |
| a `concepts_ready` anchor message exists | the message the concept grid is rendered against, and the **last** write of the completion sequence — requiring it closes the whole window rather than most of it |

These are the same three facts `ChatApp`'s `showConcepts` renders against,
so "delivered" cannot become true earlier than the customer can see
anything. Deliberately **not** `status === "concepts_ready"`: continuing to
work moves the project to `revision_requested`, `approved`, `finalizing`,
`print_ready`, and an already-seen concept must not un-deliver itself.

The rule this replaced was `artworkVersions.length > 0`, which produced the
live defect the correction is named for: the customer was shown "Approved —
generating concepts…" and "enter your email to keep working on your design"
at the same moment, asking for the address before the free concept was
visible. It also let technical upload preparation on the Existing Artwork
path trip the Create New gate. This is presentation/state derivation only —
no entitlement, spend, dispatch, or email-persistence behavior changes with
it.

### Delivery is a property of the SESSION (Correction C2)

**"The free concept was delivered" is an acquisition-SESSION fact, resolved
through the session's free-concept project and the shared customer-ready
concept rule above. Every customer-facing email-required decision consumes
that one authority.** It is `freeConceptDelivered(session)` inside
`AcquisitionCapability`, and nothing outside that capability computes or
supplies it.

Correction C wired `hasDeliveredGeneratedConcept` into one consumer — the
state view behind the email-gate card — from the project being read. Two
other consumers of the same decision were left on their own rules, and both
write into the TRANSCRIPT, which is what the customer actually reads:

| Consumer | Surface | Old rule | Now |
|---|---|---|---|
| `describeForCustomer` | the `EmailContinuationGate` card | caller-supplied, project-scoped | `freeConceptDelivered(session)` |
| `refuseSpentFreeConcept` (via `authorizeConceptGeneration`) | assistant message | `!session.email` alone — never asked about delivery | `!session.email && freeConceptDelivered(session)` |
| `authorizeSessionContinuation` | assistant message | caller-supplied `artworkVersions.length > 0` (the pre-Correction-C rule) | `freeConceptDelivered(session)`; the parameter is gone |

The entitlement belongs to the session, not to a project, so a project-scoped
answer is answering about the wrong thing. A prospect who starts a second
design in the same browser is refused on project B for something that
happened on project A, and project B's snapshot holds no evidence of it at
all. Live consequence: project B's card correctly read `continue_locked`
while its transcript said "Like where this is going? Enter your email to
keep working on your design." — on a project with no job, no artwork, and no
concept, and never any.

The session's free-concept project is resolved from
`AcquisitionSession.freeConceptProjectId` (the allocation), falling back to
the free-concept job's `projectId` (the same reconciliation source
`freeConceptSpent` uses when the allocation marker was lost).

**Fails closed for ASKING.** Every unreadable case — no project id, missing
project, repository error — answers "not delivered", which can only suppress
an email request. It never grants spend and never restores an entitlement:
`freeConceptSpent` remains the sole authority for whether the free concept
is gone, and it fails closed in the opposite direction, which is the correct
direction for money.

One customer-visible consequence beyond copy: once the session HAS been given
its concept, the continuation gate now applies to a second project's first
design turn rather than only to its approval. That is the intended funnel —
further design work is what the address unlocks — and it was previously
reachable only because the gate read the second project's own empty artwork
list instead of the session's entitlement.

### Internal entitlement

Granted by `POST /api/internal/acquisition-access` with the
`x-iheartprints-internal-key` header, compared in constant time against
`IHEARTPRINTS_INTERNAL_ACCESS_KEY`, and recorded with an audit timestamp on
the session. **Unset by default, with no development fallback** — an
unconfigured deployment cannot grant it in any environment.

Deliberately not used, and not to be added later: a hardcoded operator
email, a browser-local flag, a secret query string, or `NODE_ENV`. See
`src/lib/config/internal-access-config.ts` for why each of those is not a
control.

### Stated limitation — no cross-device abuse claim

Within a normal browser session the free entitlement does not reset on
reload, navigation, reopening the project URL, repeated clicks, stale tabs,
API retries, or starting a second project. Someone who clears cookies,
switches browsers, or uses another device gets a new session and another
free concept.

That is accepted and documented rather than defended: A4 is spend control,
not surveillance. **IP address is never treated as identity and the device
is never fingerprinted.**

### Dependency direction

`AcquisitionCapability` depends only on `ProjectRepository`. It is depended
on by `ConceptGenerationCapability`, `FinalArtworkCapability`,
`ConversationCapability`, and the service facade. It never calls a provider,
never interprets conversation, never mutates a Design Brief, and never makes
an ownership or rights determination (that remains `OwnershipCapability`'s
separate, dormant architecture). See
`src/capabilities/shared/capability-boundaries.ts`.

---

## 23c. Production Unlock — the commercial entitlement (Sprint A5.1 / A5.2)

### What this is

`ProductionUnlock` (`public.production_unlocks`) is the durable commercial
authority:

> **This design project may be prepared for production under one production
> profile.**

The funnel §23b left open now ends somewhere:

```
anonymous visitor → design conversation → ONE free concept
                  → email required to continue
                  → PRODUCTION UNLOCK → finalization → validated Production PNG
```

**It is not a payment record.** It carries no amount, no currency, no
provider id, and no transaction state. A5.1/A5.2 introduce no payment
provider, no checkout, no webhook, and no customer payment UI — an unlock can
currently only be created through a direct repository call (fixtures, tests,
internal tooling). Payment is A5.3+ and belongs in its own transaction and
event records. This separation is deliberate: an unlock says a project may be
produced and says nothing about how that permission was obtained, which is
what lets an operator grant one for support reasons without inventing a
fabricated charge.

### The key is the PROJECT

This is the load-bearing decision of the sprint, and the intuitive answer is
the wrong one.

Binding the entitlement to the `FinalDirectionApproval` the customer was
looking at when they paid reads as correct — that record *is* production
intent. But an approval is **designed to be cheap to supersede**, and is
superseded from four separate code paths:

| Site | Trigger |
|---|---|
| `FinalArtworkCapability.requestFinalArtwork` | a different artwork is approved |
| `ConversationCapability.triggerAutomaticRevision` (×2) | **a revision request is understood** |
| `GenerationWorkerCapability` (regeneration completion) | a new concept batch exists |

The second fires the moment a customer *says* they want a change. An
approval-bound entitlement would therefore be revoked by the customer's first
sentence after paying. Every other candidate fails for a related reason:

| Candidate | Why not |
|---|---|
| `ArtworkVersion` | replaced by every targeted revision |
| `FinalArtworkJob` | created *after* the gate that would authorize it — circular |
| `AssetRecord` / the PNG | an **output** of the paid work, not the permission |
| `requestedProductionOutput` | deliberately mutable; changing your mind must not void a purchase |
| the acquisition session | would make every project that browser ever creates paid |

`print_projects.id` is the only identifier here that survives revision,
approval supersession, regeneration, and a change of requested output. It is
also already the authority every acquisition gate resolves from
(`resolveAuthority`), so the commercial gate and the spend gate agree by
construction rather than by convention.

**Approval/artwork/job/asset ids are NOT entitlement keys.** No provenance
columns exist in this slice either: a nullable `unlocked_for_approval_id`
sitting beside an entitlement would be a standing invitation for a future
gate to read it, which is precisely the binding this design exists to
prevent. If provenance is added later it must be ignored by the gate.

### The production profile

`ProductionProfile` is the strict **grantable subset** of
`ProductionCategory` (§ Print Validation) — today exactly one value,
`apparel_raster`. It is a production **outcome**, never a file format:
"raster garment decoration", not "PNG". That V1's pipeline currently delivers
that outcome as a validated Production PNG is a fact about the pipeline, not
about what was purchased — which is what lets a later embroidery or vector
production profile reuse this commercial model unchanged.

`ProductionCategory` also carries values describing refusals and dormant
roles (`apparel_vector`, `out_of_scope_product`, `signage`, `logo_vector`,
`unknown`). None is a thing anyone can be sold, so the grantable subset is
enforced twice, independently:

- a `CHECK (production_profile in ('apparel_raster'))` constraint, so the
  database cannot authorize a future production path merely because a string
  reached the column; and
- `readStoredProductionProfile`, which narrows a persisted value **fail
  closed** to an unrecognized sentinel rather than coercing it.

`production-unlock-entitlement.test.ts` additionally asserts the subset
relation at compile time, so the two vocabularies cannot drift.

### Authorization enters through `authorizeFinalization(projectId)`

`AcquisitionCapability` gained no new method and no new parameter. The single
existing finalization fence now reads:

```
legacy   (acquisitionSessionId IS NULL) → allow   (grandfathered, no unlock needed)
internal (entitlement = 'internal')     → allow   (no unlock needed)
unavailable                             → refuse  (fail closed)
prospect + active apparel_raster unlock → ALLOW   ← Sprint A5.2
prospect without one                    → refuse
```

**The signature is part of the design.** Adding an `approvalId`, an
`artworkVersionId`, or a `requestedProductionOutput` parameter would
re-import into the money path exactly the identifiers that are superseded,
replaced, or mutated during ordinary design work.

Both finalization workflows already consumed this one call, so both are
unlocked by one project-level record and neither needed a change:

- `requestFinalArtwork` (Create New Artwork)
- `requestPreparedUploadFinalArtwork` (Upload Existing Artwork)

There is deliberately no "upload unlock" and no "create-new unlock".

Four things are checked before an unlock is treated as permission
(`hasActiveProductionUnlock`), and none is redundant: the repository filters
on `status = 'active'`; `productionUnlockAuthorizes` re-verifies status,
profile, and project against values *this build* understands; the unlock's
recorded acquisition session is cross-checked against the project's own
durable binding and a **mismatch fails closed**; and a repository read
failure refuses. A session id is never accepted from a cookie, a header, or a
request body.

### What an unlock does NOT do

- **It does not unlock generation.** `authorizeConceptGeneration` is
  untouched: regeneration, exploration, generative revision, and additional
  concept generation all remain refused for a prospect. A5.1/A5.2 unlock
  **finalization only**. This is deliberate — every spend budget in the
  codebase (`paid_image_intents`, `paidIntentBudgetForGenerationJob`,
  `maxPhysicalDispatchesForGenerationJob`, `MAX_GENERATION_ATTEMPTS`) is
  scoped to a single `GenerationJob`, and nothing counts jobs per project or
  per session. Unlocking generation without first adding that ceiling would
  create an unbounded-spend surface.
- **It does not manufacture technical capability.** A project may be
  commercially unlocked and still refused, or still produce no deliverable,
  because of a pending revision, an unconfirmed final direction, a stale
  concept, or a `requestedProductionOutput` V1 does not produce. Those gates
  are unchanged and run *after* the commercial one.
- **It does not change customer-facing state.** No `payment_required` /
  `payment_processing` / `production_unlocked` customer state exists yet, and
  `CustomerAcquisitionState` is unchanged. A5.1/A5.2 are backend-only.
- **It does not sit below existing idempotency.** The unlock is checked
  *above* `createJobToleratingRace`, the `(approval, requestedProductionOutput)`
  and `(preparation, width, output)` unique keys, and the Topaz
  `(providerKey, providerRequestId, providerStatus)` triple — all unchanged.
  A double or concurrent finalization request on an unlocked project still
  produces exactly one `FinalArtworkJob`.

### Lifecycle and revocation

`status` is `active | revoked` — deliberately no payment-lifecycle values
(`pending`, `paid`, `failed`), which describe a transaction rather than a
permission.

- **An active unlock survives revision and approval supersession.** That is
  the whole point of the key.
- **Revocation stops future finalization only.** The row is never deleted;
  prior `final_artwork_jobs`, production assets, and
  `production_asset_validations` are never touched. Artwork that was produced
  genuinely was produced. This is future refund-compatible behavior without
  implementing refunds.
- **A re-grant after revocation is a NEW row** with its own `granted_at`, not
  a resurrection — the partial unique index constrains only active rows, so
  the audit trail accumulates.
- **NULL and unknown are never active.** `readStoredProductionUnlockStatus`
  fails closed, so a status written by a newer deploy cannot be read as
  permission by an older one.

### Uniqueness, races, and persistence

```sql
create unique index production_unlocks_active_per_project_profile_idx
  on public.production_unlocks (project_id, production_profile)
  where status = 'active';
```

**At most one active unlock per project and profile, enforced by
PostgreSQL** — the same "the constraint is the guarantee" rule §23b
establishes for the free concept. Concurrent grants resolve to one `granted`
and N `existing`; the loser re-reads the winner rather than raising, because
the desired end state (this project is unlocked) holds either way and a
raised error would tempt a caller into a retry that creates a second
entitlement. The local store reproduces this through its process-wide lock;
both stores make the same decisions.

Scoped to `(project, profile)` rather than `(project)` so a future embroidery
or vector profile is a genuinely different purchase — never blocked by, and
never silently satisfied by, an apparel-raster unlock.

Both foreign keys are `ON DELETE RESTRICT`, matching every acquisition
foreign key: losing a row must never change what somebody is entitled to.

### Security posture

Identical to every other application table (§ Current Data Access Model):
RLS enabled, **zero policies**, `anon`/`authenticated` privileges revoked in
the same migration that creates the table, service-mediated writes only.
`service_role` is untouched. No ownership column is invented — there is still
no customer identity model.

`scripts/verify-production-unlock-postgres.sql` proves all of this against a
real PostgreSQL instance with the full migration chain applied: table shape,
RLS on, zero policies, no browser-role grants, `service_role` still able to
write, the active-uniqueness refusal, revoked-then-re-granted behavior,
project A not implying project B, every non-grantable profile and every
invented status rejected by CHECK, revocation-consistency, and
`ON DELETE RESTRICT` on both foreign keys.

### Dependency direction

Unchanged. `AcquisitionCapability` still depends only on
`ProjectRepository`. It **reads** an already-granted `ProductionUnlock`
through the repository; it never creates one, never learns what it cost, and
never learns that a payment provider exists. When A5.3+ introduces one, the
provider adapter belongs behind its own provider port in its own capability —
never inside `AcquisitionCapability`, and never as a capability the
acquisition boundary depends on.

---

## 23d. Checkout and Payment Attempts (Sprint A5.3)

### Two records, and the line between them

```
PaymentTransaction   ONE CHECKOUT / PAYMENT ATTEMPT.
                     "Somebody was sent to a payment page for this project,
                      and here is what happened next."

ProductionUnlock     THE ENTITLEMENT (§23c).
                     "This project may be prepared for production."
```

**A transaction never becomes an entitlement.** No status on it — not even the
`'paid'` this sprint does not write — is read as permission by any gate. There
is no foreign key between the tables, no trigger, and no shared column;
`scripts/verify-payment-transactions-postgres.sql` asserts all three against a
real database, alongside the blunt version: after checkout, the
`production_unlocks` count is zero.

That separation is what makes the browser structurally incapable of granting
anything. A5.4's verified webhook will *create an unlock row*, not
*reinterpret a transaction status*.

### `pending_provider` — the state this table exists for

A durable row must exist **before** the provider is called: its id is the
provider idempotency key and the metadata handle a later verified webhook
reconciles through, and there is nothing else stable to use. At that instant
no checkout session exists anywhere.

Calling that `'created'` would be a lie a crash then makes permanent — a row
claiming a checkout that was never created, holding the one outstanding slot
forever, indistinguishable afterwards from a real one. So the pre-provider
state is named honestly:

| Status | Meaning |
|---|---|
| `pending_provider` | durable intent; nothing at the provider yet, or the attempt ended ambiguously. **Resumable.** |
| `created` | a provider checkout session genuinely exists. **Not payment**; authorizes nothing. |
| `failed` | provably never created a provider session; frees the outstanding slot. |
| `paid` / `expired` / `refunded` | A5.4+ vocabulary. Written by nothing in A5.3. |

Two CHECK constraints keep the first two states genuinely distinct rather than
a flag somebody could forget to move: a `created` row must carry both a
session id and a URL, and a `pending_provider` row must carry neither.

### Stripe and PostgreSQL are not atomic, and this design does not pretend

Every outcome converges instead:

| What happens | Durable result |
|---|---|
| provider call succeeds | bound to `created` |
| fails **provably before dispatch** (401, 4xx, DNS) | `failed`; slot freed; a clean retry is possible |
| fails **ambiguously** (5xx, socket hang-up, unreadable 200) | stays `pending_provider` |
| crash after the provider answers, before we persist | stays `pending_provider` |

In both of the last two rows the next attempt **replays the same idempotency
key**, so the provider returns the *same* session rather than creating a
second one. Freeing the slot on an ambiguous failure is exactly how a customer
ends up looking at two payment pages for one purchase, so it is never done.

The dispatch classification reuses `ProviderError.dispatch` and
`isPossiblyBilledProviderError` — the same axis the paid-image and
final-artwork paths already use, never a second reading of the same question.

### At most one outstanding attempt per project and profile

```sql
create unique index payment_transactions_outstanding_per_project_profile_idx
  on public.payment_transactions (project_id, production_profile)
  where status in ('pending_provider', 'created');
```

Enforced by PostgreSQL, not by application code reading before it writes — the
same rule as `acquisition_free_concept_claims` and `production_unlocks`. Two
tabs, a double click, or a duplicated request converge on one payment page;
the loser of the race is handed the winner rather than an error, because an
error would tempt a retry that creates a second session. Terminal rows do not
occupy the slot, so history accumulates and a genuinely new attempt is always
possible.

`provider_checkout_session_id` and `provider_payment_intent_id` are UNIQUE, so
one provider session can never resolve to two attempts — a property A5.4's
webhook depends on.

### The server owns every commercial value

`PaymentCapability.createCheckout(projectId)` takes a project id and **nothing
else**. Who is buying, which production profile, how much, in what currency,
with which provider, to which email — all resolved from the project's own
durable state and from server configuration. There is no parameter a browser
could influence, which makes client-side price manipulation *structurally
impossible* rather than merely validated against.

The route enforces the same thing at the transport layer: the body schema is a
`.strict()` empty object, so `amountMinor`, `currency`, `providerPriceId`,
`productionProfile`, another `projectId`, an `approvalId`, or a session id is a
**400 — rejected, not silently stripped**. Stripping would charge the right
price anyway but leave the boundary invisible; loud rejection makes it
testable.

Price lives in exactly one place, `production-unlock-offer-config.ts`, and
**fails closed with no development fallback** — a default price would be a
published price that every unconfigured deployment quietly started charging.
The amount is validated as a raw digit string, not merely as a number: an
operator writing `49.00` meaning forty-nine dollars would otherwise have
configured forty-nine **cents**, and `Number.isInteger(Number("49.00"))` is
`true`.

Amount, currency, and profile are **frozen onto the row** at open time and
re-read from it on resume — never from configuration. A price change must not
retroactively rewrite what somebody was quoted, and a changed request body
would also break the idempotency replay.

### Redirects are navigation, never authority

Success and cancel URLs are built from `IHEARTPRINTS_PUBLIC_BASE_URL` — server
configuration, never a request's `Host`/`Origin` header, which an attacker
controls and which would make the redirect an open redirect with a payment
page in front of it.

Neither URL carries a payment claim. The parameter is `checkout=complete`,
meaning *"you came back from checkout"* — which is true — rather than
`paid=true`, which this side of the system cannot know. No `{CHECKOUT_SESSION_ID}`
interpolation. No UI reads it in this slice.

### What qualifies as something to buy

Both workflows reach checkout from their **own existing durable authority**;
no new approval concept was invented, and in particular a
`FinalDirectionApproval` is *not* required — that record is created **by**
finalization, which is the thing being purchased, so requiring it would make
checkout unreachable for everyone.

| Workflow | Requirement |
|---|---|
| Create New | a generated concept has been **delivered** (`hasDeliveredGeneratedConcept` — the same shared rule the concept grid and the email gate use) **and** one is selected |
| Existing Artwork | an `ArtworkPreparation` the customer has **approved** — exactly what `requestPreparedUploadFinalArtwork` already requires |

`finalDirectionConfirmed` is deliberately **not** required. It means "no more
changes, produce this", it is the *finalization* gate, and it resets on
re-selection — demanding it before payment would ask a customer to promise
they are done revising in order to buy, and would import a resettable flag
into the commerce path.

Checkout is also refused for: a missing project, unresolvable acquisition
authority, an **internal** session (already finalizes freely — charging would
take money for nothing), a **legacy** project (no buyer to record, and already
grandfathered), no captured email, an existing active unlock, a pending
revision, an unsupported `requestedProductionOutput`, and any unavailable
configuration. **Every one returns the same sentence** — distinguishable
refusals would let a caller enumerate which projects exist and which are
already paid for.

### Provider isolation

`PaymentProvider` is a three-string contract. `StripeCheckoutProvider` is the
only implementation, is reachable **only** through `resolvePaymentProvider`
(deliberately not exported from the capability barrel), and owns 100% of the
Stripe dialect: endpoint, form encoding, parameter names, the
`Idempotency-Key` header, status-code meanings, response field names.

**No SDK.** Both existing paid-provider adapters (`OpenAIConceptGenerationProvider`,
`TopazTransparencyUpscaleProvider`) use raw `fetch` with an injectable
`fetchImpl`, and this one matches them — zero new dependencies, testable with
a plain fake, and the exact request this process makes is readable in one
file.

The email reaches Stripe's own `customer_email` field and is **never**
duplicated into metadata, never returned to a browser, and never round-tripped
through a client. Metadata carries exactly one value: the opaque internal
transaction id. Duplicating authority values into metadata invites a future
reader to trust it — and metadata is caller-supplied data that happens to have
made a round trip through a provider.

### Dependency direction

```
PaymentCapability → ProjectRepository, PaymentProvider, offer config
```

and nothing else. It resolves the project's acquisition session from the
repository directly, exactly as `AcquisitionCapability` does.
`AcquisitionCapability` does **not** depend on it, does not know it exists, and
was not modified by this sprint.

### What A5.3 does not do

No webhook route, no webhook verification, no `payment_events` table, no
entitlement activation, and no customer payment UI. A5.4 (§23e) adds the first
four; customer payment UI remains unbuilt.

---

## 23e. Verified Webhook and Atomic Activation (Sprint A5.4)

### The one authority chain

```
PaymentTransaction 'created'                        (§23d)
        ↓
Stripe-Signature verified against the RAW body      stripe-webhook-signature.ts
        ↓
PaymentEvent recorded  (provider_event_id UNIQUE)   ─┐
        ↓                                            │ ONE PostgreSQL
PaymentTransaction → 'paid'                          │ transaction:
        ↓                                            │ apply_payment_event()
ProductionUnlock → 'active'                         ─┘
        ↓
AcquisitionCapability.authorizeFinalization(projectId) allows   (§23c)
```

**The browser redirect appears nowhere in it.** `?checkout=complete` is a
query parameter on a page; it reaches no code that writes to a payment or
entitlement table, and the webhook route deliberately has no project id, no
cookie, and no query parameter for it to arrive through. The regression test
lands on the real success URL, re-reads every customer surface, and asserts the
project is still locked — then delivers the webhook and asserts it is not.

### Atomicity is a database transaction, not an ordering

"Mark the transaction paid" and "create the unlock" are two statements against
two tables. Over the Supabase REST API they are two round trips that cannot
share a transaction, and a crash between them leaves exactly the two states
this product must never be in:

| Partial state | Consequence |
|---|---|
| paid, no unlock | the customer was charged and can produce nothing |
| unlock, not paid | production reconstruction was given away |

No ordering fixes that — the same lesson Sprint A4 Correction 1 learned about
the free-concept window. So the whole transition is one function,
`apply_payment_event`, and PostgreSQL's transaction is the guarantee.

`scripts/verify-payment-events-postgres.sql` proves it against a live database
rather than by inspection: a successful call is made inside a savepoint and
then rolled back, and **all three** writes must vanish together. If the
function committed anything independently, residue would survive.

### What the function may and may not be told

**May not:** `project_id`, `acquisition_session_id`, `production_profile`. They
are read from the transaction row inside the function. A webhook able to supply
them could unlock a different customer's project.

**May:** the event's identity and digest, which transaction it *claims* to be
about, and the provider's reported session / intent / amount / currency — every
one of which is only ever **compared** against stored state, never used to
establish it.

Reconciliation refuses, and mutates nothing, on any of: unknown transaction,
checkout-session mismatch, amount mismatch (no tolerance, no rounding, no
conversion), currency mismatch, a payment intent already bound to another
transaction, or a transaction in a state that may not be activated.

### Completion is not payment

`event.type === "checkout.session.completed"` is **not** evidence that money
arrived. Only `payment_status === "paid"` is. `"unpaid"` is the delayed-
settlement case a later `checkout.session.async_payment_succeeded` resolves,
and `"no_payment_required"` describes a fully-discounted session this product
never issues — treating either as paid would give away production
reconstruction.

### Supported events

| Event | Action |
|---|---|
| `checkout.session.completed` | activate — **only if** `payment_status` is `paid` |
| `checkout.session.async_payment_succeeded` | activate — the money for delayed payment methods |
| `checkout.session.expired` | expire the attempt, freeing the outstanding slot |
| everything else | recorded as `ignored`, acknowledged, acted on in no way |

**Out-of-order transitions are defined and tested.** A paid transaction is
never downgraded by a later `expired`. An expiry on an unpaid attempt frees the
slot, and a completion arriving afterwards still pays — the money is real; our
bookkeeping was merely early.

### Idempotency, twice over

`payment_events.provider_event_id` is UNIQUE and the insert is taken **first**,
inside the same transaction as the payment application. A concurrent
redelivery blocks on the index and then finds the conflict; it never reads,
sees nothing, and grants a second time. Duplicates return `duplicate` and are
answered 200 — a provider that never receives a 2xx retries forever.

Behind that sits an independent second fence: two *distinct* event ids for the
same payment (Stripe emits more than one per checkout) both reconcile, and the
partial unique index on `production_unlocks` makes the second reuse the
existing entitlement rather than duplicate it.

`payment_transactions.provider_payment_intent_id` is UNIQUE, so one provider
payment intent can never pay off two iHeartPrints transactions.

### Signature verification

Hand-written (`stripe-webhook-signature.ts`), not the Stripe SDK — the same
decision A5.3 made for the checkout adapter, and for the same reasons. The
algorithm is small and fully specified (HMAC-SHA256 over
`"{timestamp}.{rawBody}"`, constant-time compare against each `v1=` value,
timestamp tolerance), with no cryptographic subtlety; the four ways it actually
goes wrong are all externally testable and all covered; and `stripe` would be a
large dependency in the highest-trust path of a nine-package repository.

Properties enforced and tested: the **raw bytes** are verified (a merely
re-serialized body is refused, which is the failure a parse-then-verify
implementation would have), the timestamp is inside the MAC (restamping a
captured body does not revive it), tolerance is symmetric, several `v1` values
are all tried so secret rotation does not break delivery, `v0` is ignored
rather than used as a fallback, and comparison is constant-time on
shape-checked input.

Nothing is parsed before verification succeeds. The route reads the body
exactly once as text and never calls `JSON.parse`.

### Payment events store a digest, never the payload

A provider event body carries the customer's email and billing address, card
brand and last four, provider customer/account ids, and amounts. None of it is
needed after reconciliation, and storing it would create a durable copy of
payment PII that outlives the purchase and appears in every backup.
`payload_digest` is a SHA-256 of the exact verified bytes: enough to prove
afterwards which body was processed, useless for reconstructing it. A test
asserts the customer's email does not appear anywhere in the stored record.

### RPC security

`apply_payment_event` is **SECURITY INVOKER** — the default, and deliberately
not `DEFINER`. `service_role` already holds BYPASSRLS and full privileges on
all three tables, so `DEFINER` would buy nothing and would create a standing
privilege-escalation path through code that moves money. `search_path` is
pinned, every table is schema-qualified, there is no dynamic SQL, and `p_action`
is a closed enum validated on entry.

PostgreSQL grants EXECUTE on new functions to PUBLIC by default — through
PostgREST that would make the payment-activation authority callable by `anon`.
The migration revokes it explicitly, and the proof asserts the revoke took
effect (a negative control confirms the assertion fails when the grant is
restored).

### Refund automation is NOT implemented

Deliberately deferred. `charge.refunded` and dispute events are recorded as
`ignored` and change nothing; a refund must be actioned by an operator through
`revokeProductionUnlock`. The schema is future-safe — `payment_transactions`
already accepts `refunded`, `production_unlocks` already supports revocation,
and both are separately tested — but nothing drives them from an event, and a
half-implemented refund is worse than an honest manual one. A test pins this so
it is a fact the suite enforces rather than a claim in a document.

### Configuration coupling

`STRIPE_WEBHOOK_SECRET` is **required** whenever `PAYMENT_PROVIDER=stripe`.
This removes A5.3's documented hazard from the configuration space entirely:
you cannot turn on charging without also being able to hear that a charge
succeeded.

### Generation remains locked

Unchanged. A paid `ProductionUnlock` authorizes finalization only;
`authorizeConceptGeneration` is untouched, and exploration, regeneration, and
generative revision all remain refused for a prospect after payment.

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
- **Payment is disabled by default and in every environment.**
  `PAYMENT_PROVIDER` defaults to `none`, and `STRIPE_SECRET_KEY` /
  `STRIPE_WEBHOOK_SECRET` / `PRODUCTION_UNLOCK_AMOUNT_MINOR` /
  `PRODUCTION_UNLOCK_CURRENCY` / `IHEARTPRINTS_PUBLIC_BASE_URL` have no
  defaults and no development fallback. An unconfigured deployment refuses
  checkout cleanly rather than inventing a price, and the webhook secret is
  required whenever checkout is enabled (§23e) — so the A5.3 hazard of
  charging customers nothing could confirm is no longer configurable
- **There is no customer payment UI.** The checkout route exists and the
  webhook works end to end, but nothing in the interface offers a customer a
  way to pay, shows a price, or reflects a `payment_required` /
  `payment_processing` / `production_unlocked` state.
  `CustomerAcquisitionState` is unchanged. A5.5 owns that
- **Refund automation is not implemented (§23e).** Refund and dispute events
  are recorded as `ignored` and change nothing. A refund must be actioned by
  an operator through `revokeProductionUnlock`; the schema and the revocation
  path are future-safe and tested, but no event drives them
- **A configured Stripe Price object is not reconciled against the recorded
  amount.** When `PRODUCTION_UNLOCK_PROVIDER_PRICE_ID` is set, Stripe's Price
  decides what the customer is charged while `amount_minor`/`currency` remain
  what the durable transaction records; nothing can compare them without a
  network call. Leaving the variable unset (the default) keeps one source of
  truth and avoids the question entirely
- **The checkout route inherits the bearer-project-id weakness.** Like every
  other project route, it authorizes on knowledge of the project's UUID. A
  stranger holding one could cause a checkout session to be created for
  somebody else's project and could pay for it — but cannot redirect the
  resulting entitlement (the unlock lands on the project, and the buyer's
  email is read from the project's own session, not the caller's). So the
  exposure is "an attacker can spend their own money on a stranger's
  project", not "an attacker can obtain a stranger's design". Route-level
  project ownership remains a launch blocker for A5.7 / security hardening.
  The webhook route (§23e) is deliberately NOT affected: it takes no project
  id, no cookie, and no query parameter, and derives everything from the
  durable transaction row inside the database
- **A production unlock does not unlock generation.** After the one free
  concept, every further concept generation, exploration, and generative
  revision is still refused for an ordinary prospect, unlocked or not
  (§23c). Only an internally granted session (§23b) can perform them. This
  is deliberate: every spend budget in the codebase is scoped to a single
  `GenerationJob`, and nothing counts jobs per project or per session, so
  unlocking generation before adding that ceiling would create an unbounded
  paid-image surface
- **No customer-facing payment state exists.** `CustomerAcquisitionState` is
  unchanged by A5.1/A5.2; a prospect whose project holds an active unlock is
  still described by the same states as one who does not. The gate is
  server-authoritative either way, so nothing is bypassable — but the UI
  cannot yet distinguish "unlocked" from "locked" and will need to before
  payment ships
- **The acquisition entitlement makes no cross-device abuse claim.** It
  survives reload, navigation, reopening a project URL, repeated clicks,
  stale tabs, API retries, and starting a second project in the same
  session. It does not survive cleared cookies, a different browser, or a
  different device — deliberately: IP address is never identity and the
  device is never fingerprinted (§23b)
- **A refused revision leaves `revisionPending` set with no job behind it.**
  The pending-revision authority is written before the enqueue fence is
  reached, so a prospect whose revision is refused for lack of paid access
  keeps that flag. It bars finalization, which is independently barred for
  the same prospect anyway, and the refusal announcement is idempotent so
  reloads do not repeat it. It clears when a revision genuinely completes
- **A free concept allocated but never consumed pins the session to that
  project.** If the durable `GenerationJob` insert fails, the allocation
  stays on the project it was made for; the customer keeps their free
  concept there, but a *different* project in the same session cannot claim
  it. The original project remains fully usable
- **A free concept that hard-fails print-palette validation is delivered as
  generated.** Phase 2C replacement is not purchased for it (§23b), so a
  customer whose one free concept violates an explicit ink restriction sees
  that concept rather than a corrected one. Delivering it is the lesser
  harm: the alternative path withholds it, which would show them nothing at
  all with their entitlement already spent
- **Acquisition sessions and their bound projects are not deletable through
  ordinary cleanup.** `ON DELETE RESTRICT` on both directions is what stops
  a deleted row from manufacturing legacy/unrestricted access, and the cost
  is that data-retention work touching these tables needs a deliberate,
  ordered procedure rather than a cascade. Generation jobs themselves stay
  freely deletable (§23b) — the free-attempt claim outlives them
- **An ambiguous free-concept failure is terminal and costs the attempt.**
  If the single physical submission fails in a way that cannot be proven
  un-billed, the customer does not get another — by design (§23b). They see
  a customer-safe failure and the funnel ends there; A4 has no mechanism to
  grant a replacement attempt, and A5 payment is not implemented
- **Deleting a free generation job makes it unrecoverable.** The claim
  survives and keeps enforcing, so no second free image is granted, but the
  job, its concepts, and its paid-intent history are gone. Deletion is an
  operational/destructive action and is treated as one
- **IP safety (§23a) is a product boundary, not legal clearance.** It makes no
  determination about legality, licensing, ownership, or clearance, and must
  never be described as doing so
- **IP safety recall is deliberately bounded.** The deterministic layer tunes
  for precision: its backstop lexicon of recognized organizations and
  characters is explicitly incomplete, a bare possessive over an unrecognized
  name is not treated as a third-party mark, and a business-name continuation
  neutralizes a recognized token. Marks outside the lexicon rely on the
  optional semantic signal, which is absent whenever
  `CONVERSATION_UNDERSTANDING_PROVIDER` is unset (the default), the call is
  skipped, or it fails. Provider-side safety remains the independent next line
- **The conversational multi-turn window is short (2 turns) and drops refused
  turns.** That is what keeps a blocked request from following the customer
  around, and it is also why a referent mentioned several turns earlier and
  bound several turns later can slip past the gate. The generation fences,
  which read the structured brief rather than conversation text, are the
  backstop for exactly that case — and they are the ones guarding the spend
- **A referent recorded on the brief as a theme makes later mark-noun requests
  block at the generation fences.** "Raiders design" plus "the logo" is
  indistinguishable from a split reproduction request, so it is refused. The
  customer recovers by changing the design description; the brief is mutable
  and nothing about the refusal is persisted
- **A mark only the semantic layer can see is caught at the conversation gate
  and nowhere else.** The enqueue and worker fences are deterministic over the
  structured brief, so they cannot recognize an unenumerated mark. That
  division is sound only because the gate refuses *before* Intent Extraction
  applies anything, so nothing unsafe is ever retained — pinned by
  `ip-safety-semantic-scope-e2e.test.ts`. Adding a second model call at the
  fences to duplicate the gate was explicitly rejected
- **Semantic suppression depends on the signal's `evidence` quote being
  locatable in the customer's own words.** A provider that returns an unsafe
  signal with an empty or heavily paraphrased quote gets the conservative
  reading (no suppression), which can refuse a genuinely safe request. The
  provider prompt requires a real quote, and the alternative — trusting a
  hint whose request cannot be located — is what Correction 3 removed
- **Refused-turn exclusion identifies a refusal by comparing assistant message
  prose to `IP_SAFETY_REDIRECT_MESSAGE`, not by structured metadata.** Carried
  forward from Correction 1 and deliberately untouched here: message metadata
  is client-visible, so a truthful marker would itself be an internal-state
  leak. Revisit if the metadata sanitization boundary changes
- **Uploaded artwork (§13h) supports PNG only.** JPEG, WebP, and GIF are
  detected and honestly refused; SVG is explicitly rejected. Adding a format
  means adding a decoder dependency and its security surface
- **Uploaded artwork stops at approved prepared artwork.** No enhancement, no
  upscale, no 300 PPI production, no print validation, no download, no
  billing — all Phase 2. Nothing in the flow describes prepared artwork as
  print-ready
- **Complex/photographic backgrounds are refused, not solved.** They classify
  `NEEDS_REVIEW` with no automatic mask; AI segmentation is Phase 3 and would
  require a provider port this capability deliberately does not have
- A background-coloured stroke that genuinely touches the exterior background
  is indistinguishable from the background itself and will be removed with
  it. This is inherent to any reachability-based isolation; the mitigation is
  the conservative classifier, not a cleverer fill
- **Enclosed cavities are decided by wall thickness against cavity size, and
  the ambiguous cases resolve toward preserving artwork.** A counter ringed by
  an unusually heavy stroke (wall > 1.75x its inradius) is left black rather
  than guessed at, and conversely an intentional dark speck sitting within a
  few pixels of a shape's outer edge can be read as a cavity. Both directions
  are documented consequences of the same ratio, and it is deliberately tuned
  to fail toward the first
- **RESOLVED, by asking rather than by tuning: display-scale counters inside a
  compound stroke are never removed automatically.** The full real-file audit
  measured wall/inradius at 2.11–5.29 for genuine letter counters and 2.89–4.69
  for the bowling ball's finger holes — the finger holes sit *inside* the
  counter range, so the populations are **nested** and no threshold on that
  statistic can separate them. Alternative statistics did separate on that one
  file (best: 75th-percentile ray crossing thickness over inradius, ~2× margin),
  but on three negative controls from a single image, and a smaller ball icon
  with proportionally larger holes collapses the margin. These regions are
  therefore preserved and the customer removes them with a click (see
  "User-guided background cleanup"). `darkOutlinedDisplayArtwork` remains the
  characterization fixture; it now pins preservation as *correct*
- **Guided cleanup can preview a finger hole if the customer clicks one.** This
  is the unavoidable consequence of the finding above: the system cannot
  distinguish it, so it cannot refuse it on the customer's behalf. Mitigations
  are that nothing is ever removed automatically, the affected region is
  highlighted from the server's authoritative mask before any mutation, removal
  requires an explicit "Remove This Area" confirmation, and undo is always
  available before approval.
- **Speckle cleanup only reaches fully isolated flecks of ≤4px.** Residue still
  *attached* to artwork — a one-pixel-wide dark protrusion along an outline — is
  left alone, because it cannot be told apart from thin intentional detail. On
  the audited file that leaves the retained-pixel islands at zero but does not
  claim to remove every near-background pixel near an edge
- Since the boundary gate became membership-based, a dark fill behind a thin
  dark wall is no longer protected — its protection came entirely from the 48
  threshold, and that threshold provably rejects the real file's counters. The
  two requirements are mutually exclusive; the Original-vs-Prepared comparison
  is the customer's safeguard
- A cavity sealed behind another dark enclosed region (a dot inside a closed
  black ring) has no measurable wall and is always preserved, even when it is
  in fact background
- Uploaded artwork is never OCR'd, so Phase 1 knows nothing about text inside
  it. That is intentional (the pixels are authoritative), and Phase 2's
  uploaded-preserve validation profile must not assume otherwise
- PNG thumbnail resizing is basic (`PngThumbnailGenerator`)
- S3 adapter is reserved but not implemented
- Orphan asset cleanup cannot recover from a hard process crash after
  upload and before DB persist
- Concept Evaluation (Phase 1 + Phase 2) persists results — now from a real
  vision-based evaluator when configured — but still does not block, reject,
  rank, or hide concepts from customers; no UI scoring yet. Remains
  advisory-only until a future phase decides to act on it
- Print Validation is real, tested, and deterministic. **Provisional**
  runs happen inside `GenerationWorkerCapability` after Concept Evaluation
  (logged only; never persisted; never customer-facing).
  `ArtworkVersion.printValidationStatus` remains reserved `null` by design.
  **Authoritative** runs happen inside `FinalArtworkWorkerCapability`
  against the production PNG and persist on `ProductionAssetValidation`.
  Only those authoritative runs may set `PrintProject.status = "print_ready"`.
- Print Validation still infers a production category from free-text brief
  fields by keyword matching. That classifier still contains dormant
  `apparel_vector` / `signage` / `logo_vector` branches. They are reusable
  hooks, not iHeartPrints V1 output contracts. Current V1 production is
  apparel raster PNG. A later policy sprint may stop those branches from
  refusing a valid apparel PNG; this document does not treat them as
  unfinished V1 deliverables.
- `TShirtDesignBrief.intendedPrintWidthIn` **is** populated. The customer
  chooses production width via `PrintReadySizeCard` / Change Size (or a
  natural-language size request at the final-direction stage).
  `DesignBriefCapability.setIntendedPrintWidth` persists it. It is
  deliberately **not** part of `DesignBriefSnapshotContent`: physical size
  is a production specification, not creative content. Placement defaults
  apply when the customer never chooses a width.
- `PrintPlacement` models apparel placements only (full front, full back,
  left chest, sleeve). Non-apparel sizes are not an iHeartPrints V1
  product requirement.
- Final direction is distinct from concept selection.
  `PrintProject.finalDirectionConfirmed` is the Create New gate;
  prepared-upload approval is the Existing Artwork gate. `print_ready` is
  set only by `FinalArtworkWorkerCapability` after authoritative validation.
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
- Phase 1.1's multi-turn merge classifies ADD / REFINE / REPLACE from
  generic English structure (supersede cues, refinement cues, subject and
  attribute-dimension overlap) — not language understanding. A replacement
  phrased without any recognized supersede cue reads as an addition, and the
  superseded content stays in the brief; the Design Summary approval gate is
  the customer's opportunity to catch that. Merged output can also read a
  little seam-like ("Marina on the right. A smaller marina.") — preserving
  the customer's stated detail is deliberately preferred over prose polish
- Phase 1.1's no-text guarantee, like every other guarantee here, is about
  what iHeartPrints **sends**. Nothing proves an image model will produce
  lettering-free artwork; the `NO TEXT` block, the removal of every
  text-authorizing phrase, and the evaluation check are the three
  deterministic layers that make a violation detectable, not preventable
- The no-text evaluation check is a vision-model judgment, **not OCR**. Small,
  low-contrast, heavily stylized, or partially occluded lettering can be
  missed, and the check is deliberately conservative about marks that merely
  resemble letters. It reuses the `required_wording` criterion rather than
  adding a criterion key, so a persisted evaluation does not distinguish
  "wording missing" from "text present when none was allowed" by key alone —
  the criterion notes and `missingRequirements` ("no text") carry that
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
- Sprint 2L Phase 1 did not change Print Validation, Print Vault,
  Ownership, concept ranking, or automatic regeneration — none of that was
  in that sprint's scope. Download of a validated production PNG later
  shipped with final-artwork delivery and is current V1 behavior, not a
  purchasing/commerce product.
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
- Sprint 2M Phase 2B historically only enqueued `FinalArtworkJob` rows.
  **That gap is closed.** `FinalArtworkWorkerCapability` claims those jobs,
  produces the production PNG, runs authoritative Print Validation, and is
  the sole writer of `PrintProject.status = "print_ready"`.
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
- Physical print **width** is a customer decision persisted on
  `TShirtDesignBrief.intendedPrintWidthIn`. Unchosen width falls back to
  the placement default. Garment *body* size (S/M/L retail) is not asked
  and is not part of V1. Height is derived from the artwork's own aspect
  ratio. `intendedPrintWidthIn` remains excluded from
  `DesignBriefSnapshotContent` on purpose.
- iHeartPrints V1 does not implement vectorization, embroidery
  digitization, screen-print separations, banner/sign production, PDF/SVG
  production output, or CMYK conversion. Those are **out of product
  scope**, not unfinished V1 work. `FinalArtworkProvider` is replaceable;
  the live paid path is Topaz reconstruction for insufficient source
  pixels (`FINAL_ARTWORK_PROVIDER=topaz`), independent of concept
  generation. Reserved `production_svg` / `production_pdf` roles and
  `vectorAssetId` remain dormant architectural seams.
- Production PNG preview and download **are wired**.
  `GET /api/projects/[projectId]/production-artwork/image` and
  `.../download` are gated on `print_ready`. `FinalArtworkDeliveryCard`
  is the customer delivery surface. This is artwork download, not
  physical-product purchasing or checkout.
- `FinalArtworkCapability.getCurrentProductionAssetId` resolves only the
  *current* active approval's (or current prepared-upload job's) production
  asset — there is no customer-facing history of prior production attempts
  from a superseded approval.

Do not treat future work as completed architecture.

---

## 25. Current V1 vs reusable extension points

This section is **not** an iHeartPrints delivery plan for signs, vector,
embroidery, or physical-product commerce. It records (a) what is already
current V1 architecture and (b) dormant seams that may serve iHeartPrints
later or other systems later. Broader architecture is not permission to
broaden the product — and equally, a dormant seam is not evidence that the
capability exists.

### Current iHeartPrints V1 (implemented)

| Area | Status |
|---|---|
| Create New (conversation → brief → concepts → revision → final direction → size → FinalArtworkJob → reconstruction if required → production PNG → authoritative validation → `print_ready` → download) | Active |
| Existing Artwork (upload → immutable original → preparation → transparency → approval → size → same production pipeline) | Active |
| Print Validation, provisional and authoritative | Active. Authoritative status on `ProductionAssetValidation`, never `ArtworkVersion.printValidationStatus` |
| Topaz reconstruction when visible source pixels are insufficient | Active behind `FINAL_ARTWORK_PROVIDER=topaz` |
| Production PNG preview + download | Active. Artwork download, not physical-product checkout |
| Conversation Understanding | Architecture + first real provider done; provider remains opt-in |
| Concept Evaluation | Advisory; persisted; does not block presentation |

### iHeartPrints product later (not V1 requirements)

| Extension | Notes |
|---|---|
| Customer identity / project ownership | No `owner_user_id` today; UUID knowledge is not identity. Required before public accounts. |
| Project / design library | Not implemented. Print Vault is a stub and remains **future**. |
| Additional apparel production profiles | The V1 profile is DTF/DTG-oriented raster. Other apparel-decoration methods (embroidery digitization, screen-print separations, sublimation-specific preparation) would each arrive as an explicit new production profile with its own requirements, transforms, and validation. Recognized by the classifier today; produced by nothing. |
| Generation-cost metering and monetization | Spend *controls* exist; dollar accounting does not. |
| JPEG / WebP upload | PNG only today. |
| AI photographic background segmentation | Artwork preparation has no provider port; that absence is structural. |
| “Need a printer?” directory | Allowed by the Constitution as future; not current work. |

### Reusable / dormant architectural hooks (not iHeartPrints V1 unfinished work)

These may remain. Do not delete them to “narrow the product.” Do not
schedule them as iHeartPrints V1.

| Hook | Attach where |
|---|---|
| Reserved `production_svg` / `production_pdf` roles, `vectorAssetId` | Asset / production-role model |
| Broader `ProductionCategory` values (`apparel_vector`, `signage`, `logo_vector`) | Print Validation classifier — dormant for iHeartPrints V1 |
| Print Vault stub | `PrintVaultCapability`; ingest only with Ownership rules if ever built |
| Ownership stub | `OwnershipCapability`; default remains customer-owned |
| Additional generation, evaluation, or conversation-understanding providers | Existing provider ports |
| Additional product rule packs | `shared/product-rule-packs` + ProductIntelligence |
| Real queue/worker service | Scheduler topology only |
| Presentation mockups | Presentation layer consuming artwork + garment color; not a catalog |

`FinalArtworkCapability` / `FinalArtworkWorkerCapability` must never
generate or transform anything Print Validation itself decided. Print
Validation must remain pure validation. They must never treat vector,
embroidery, screen-print separations, or physical-product purchasing as
iHeartPrints V1 work, and must never let a non-`apparel_raster` brief reach
`print_ready` on the strength of the raster pipeline alone.

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
14. Does it keep iHeartPrints an independent apparel-design product (artwork, not physical goods; not signs/banners/large-format/general commercial printing at all; not embroidery digitization, screen-print separations, sublimation-specific preparation, or vector production in V1)?
15. If it touches a broader architectural hook, does it leave that hook dormant rather than turning it into an iHeartPrints V1 requirement?
16. Does any wording it introduces claim readiness beyond the supported apparel raster production profile?

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
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — verified production host, URL, and release procedure
- [`docs/deployment/generation-worker.md`](./docs/deployment/generation-worker.md)
- [`docs/deployment/final-artwork-worker.md`](./docs/deployment/final-artwork-worker.md)
- [`docs/database/MIGRATION_WORKFLOW.md`](./docs/database/MIGRATION_WORKFLOW.md)
- [`README.md`](./README.md)
- `.env.example`
