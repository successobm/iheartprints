export const PROJECT_STATUSES = [
  "intake",
  "ready_to_generate",
  "generating",
  "concepts_ready",
  "revision_requested",
  "approved",
  "finalizing",
  /**
   * Sprint 2M Phase 2C: a `FinalArtworkJob` ran to completion — a real
   * production asset was created — but authoritative Print Validation did
   * not return `"ready"` (blocked, or genuinely needs review). Distinct
   * from `"finalizing"` (still in progress) and `"failed"` (the pipeline
   * itself errored, e.g. storage/transformation failure): this status means
   * the pipeline succeeded at producing *something*, and that something
   * honestly isn't print-ready yet. Never set without a real, authoritative
   * `PrintValidationCapability.validateArtwork` run against a real
   * production asset (Constitution §15 — no fabricated readiness).
   */
  "finalization_required",
  "print_ready",
  "failed",
  "archived",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const CONVERSATION_PHASES = [
  // Legacy Sprint 1 scripted ladder. No longer used by new projects
  // (Sprint 2F), but preserved so historical rows remain readable/resumable.
  "ask_product",
  "ask_design",
  "ask_shirt_color",
  "ask_text",
  "skip_references",
  "generating",
  "concepts_ready",
  "ask_revisions",
  "revision_received",
  // Sprint 2D: Design Summary approval gate (additive).
  "awaiting_summary_confirmation",
  "brief_approved",
  "edit_requested",
  "continue_requested",
  // Sprint 2F: single adaptive interview lifecycle phase. Replaces the
  // ask_* ladder as the source of truth for new projects — the specific
  // pending question lives in `interviewState`, not in a dedicated phase
  // value per field.
  "interviewing",
] as const;

export type ConversationPhase = (typeof CONVERSATION_PHASES)[number];

export type MessageRole = "user" | "assistant" | "system";

/**
 * Existing Artwork → Print Ready Phase 1: `"prepared_upload"` is artwork the
 * CUSTOMER supplied, background-prepared deterministically and approved by
 * them — never AI-generated, never a concept, never a revision of one. It
 * exists as its own kind precisely so uploaded artwork can never be
 * mislabelled as a generated concept anywhere downstream (Constitution §6.11
 * / §16 — provenance is never inferred).
 */
export type ArtworkKind = "concept" | "revision" | "final" | "prepared_upload";

/**
 * Sprint 2G Live Acceptance Corrective Pass: the stable identity of one of
 * the three catalog creative directions (`lib/domain/concept-directions.ts`
 * — "Bold & Direct" / "Soft & Illustrated" / "Minimal Badge"). Defined here
 * rather than in `concept-directions.ts` to avoid a circular import
 * (`concept-directions.ts` already imports `GenerationPromptRequest` from
 * this file); `concept-directions.ts` re-exports it for callers that only
 * need the catalog. Persisted on `ArtworkVersion.conceptDirectionKey` so a
 * later single-concept revision of that exact artwork can regenerate in the
 * SAME direction rather than defaulting to a different one.
 */
export type ConceptDirectionKey = "bold_direct" | "soft_illustrated" | "minimal_badge";

/**
 * Phase 1.1: the three genuinely different states of "what text goes on this
 * design", as a first-class provider-neutral vocabulary.
 *
 *   "unknown"  — the customer has not answered yet. NOT a no-text request.
 *   "provided" — exact wording is required, character for character.
 *   "none"     — the customer explicitly said there is no wording. This is a
 *                HARD no-text constraint on the artwork, not merely the
 *                absence of a required string.
 *
 * Defined here rather than in `required-wording.ts` to avoid a circular
 * import (`required-wording.ts` already imports `TShirtDesignBrief` from this
 * file, and `GenerationPromptRequest` below needs the type);
 * `required-wording.ts` re-exports it and remains the one place the
 * `exactText` storage representation is interpreted.
 *
 * The live audit that motivated this: `exactText === ""` already derived
 * `mode: "none"` correctly, but `GenerationPromptRequest` flattened it back
 * to `requiredWording: null` — indistinguishable from "unresolved". Every
 * downstream layer therefore read an explicit no-text request as merely "no
 * required string", kept typography-forward direction language, and produced
 * artwork covered in invented lettering.
 */
export type RequiredWordingMode = "unknown" | "provided" | "none";

export type PrintPlacement =
  | "full_front"
  | "full_back"
  | "left_chest"
  | "sleeve";

export interface PrintProject {
  id: string;
  name: string;
  status: ProjectStatus;
  selectedArtworkVersionId: string | null;
  /**
   * Sprint 2M Phase 2G (Goal 3): the durable authority that "the customer
   * requested a change that is not yet represented by the artwork." Kept
   * as its own boolean rather than overloading `status` — the Revision
   * Lifecycle Audit found `status === "revision_requested"` is written on
   * every message in the revision loop (including ones that changed
   * nothing) and is therefore too weak a signal to gate finalization on.
   * `true` from the moment an explicit revision request is understood
   * until a new `ArtworkVersion` batch produced by that revision exists
   * (cleared on regeneration completion, never merely on enqueue). While
   * `true`, `FinalArtworkCapability.requestFinalArtwork` refuses to create
   * a `FinalDirectionApproval`/`FinalArtworkJob` for this project, and any
   * previously-active approval is superseded immediately rather than left
   * to be raced by a still-running finalization job.
   */
  revisionPending: boolean;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: the explicit "this is my
   * final direction, no more changes" confirmation — distinct from, and
   * strictly stronger than, `selectedArtworkVersionId` (which only ever
   * means "I want to work with this direction" and is immediately
   * revisable). `false` from the moment a concept is selected (or a
   * revision changes the current artwork) until the customer explicitly
   * confirms via `ConversationCapability.confirmSelectedDirection` (or the
   * equivalent "no changes" chat phrase). `FinalArtworkCapability.requestFinalArtwork`
   * refuses to finalize while this is `false`, independent of
   * `revisionPending` — a customer who has never been asked "does this
   * look right?" must never be able to finalize just because nothing is
   * currently pending.
   */
  finalDirectionConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TShirtDesignBrief {
  id: string;
  projectId: string;
  customerName: string | null;
  projectName: string | null;
  productSummary: string | null;
  designDescription: string | null;
  exactText: string | null;
  shirtColor: string | null;
  /**
   * Sprint 2F: nullable. `null` means the customer has never confirmed a
   * print location — it is no longer defaulted to "full_front" at creation,
   * since that default was previously indistinguishable from a real answer.
   */
  printPlacement: PrintPlacement | null;
  intendedPrintWidthIn: number | null;
  preferredColors: string[];
  designStyle: string | null;
  additionalInstructions: string | null;
  /** Sprint 2F additions — additive, nullable, no historical backfill needed. */
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  /**
   * Section keys (loosely typed as `string` here to avoid a domain →
   * capabilities import cycle; narrowed to `BriefSectionKey` at the
   * capability boundary) the customer explicitly deferred to the designer's
   * judgment, e.g. "you choose" in reply to a style question.
   */
  deferredSections: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 2F: per-conversation adaptive interview bookkeeping. Never used as
 * Design Brief content — purely interview UX state (which section is
 * pending, how many times it has been asked, which advisories have already
 * been surfaced) so a reload can resume the adaptive loop without repeating
 * itself. `pendingSection` is loosely typed as `string` for the same reason
 * as `TShirtDesignBrief.deferredSections`.
 */
/**
 * Sprint 2G Part 3: one level of undo. The revisable-field snapshot of the
 * brief immediately before the most recently accepted change, plus enough
 * to describe it in plain language. Overwritten (not stacked) by the next
 * accepted change, and cleared after an undo — "undo most recent accepted
 * revision", not arbitrary history editing.
 */
export interface LastRevisionSnapshot {
  previousBrief: DesignBriefSnapshotContent;
  changedSections: string[];
}

export interface InterviewStateData {
  pendingSection: string | null;
  askCounts: Record<string, number>;
  dismissedAdvisories: string[];
  /** Sprint 2G Part 3: see `LastRevisionSnapshot`. `null` when there is nothing to undo. */
  lastRevision: LastRevisionSnapshot | null;
}

export function emptyInterviewState(): InterviewStateData {
  return {
    pendingSection: null,
    askCounts: {},
    dismissedAdvisories: [],
    lastRevision: null,
  };
}

export interface DesignConversation {
  id: string;
  projectId: string;
  phase: ConversationPhase;
  interviewState: InterviewStateData;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  projectId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Sprint 2H Part 1: provider-neutral, plain-language description of what to
 * generate — the only thing a `ConceptGenerationProvider` ever receives.
 * Produced by `PromptTranslationCapability` from an approved Design Brief
 * snapshot. Contains no provider prompt syntax or quality-boosting keywords
 * ("highly detailed", "8k", "masterpiece", "photorealistic", etc.) — those
 * belong exclusively inside each provider adapter's own internal prompt
 * translation, never here and never on the Design Brief itself.
 */
/**
 * Phase 2A: how `GenerationPromptRequest.colors` must be treated by a
 * generation provider. Derived by Prompt Translation from the approved
 * brief — never persisted on the brief itself.
 *
 * - `"hard"` — required print/render palette; overrides literal subject-
 *   object color where the two conflict (e.g. black Harley subject + white
 *   ink on a black shirt after an explicit contrast resolution).
 * - `"soft"` — casual preferred-color preference; not a hard ink override.
 * - `"none"` — no artwork palette preference (or colors deferred).
 */
export type PrintPaletteEnforcement = "hard" | "soft" | "none";

export interface GenerationPromptRequest {
  product: string;
  subject: string;
  style: string | null;
  colors: string[];
  /**
   * Phase 2A: hard/soft/none treatment for `colors`. Providers must not
   * phrase a `"hard"` palette as optional "preferred colors".
   */
  printPaletteEnforcement: PrintPaletteEnforcement;
  /**
   * Phase 2A: color words that appear in subject semantics but are NOT part
   * of the print palette. Empty unless `printPaletteEnforcement` is
   * `"hard"`. Lets adapters warn against dominant ink in those colors
   * without erasing subject identity.
   */
  subjectOnlyColors: string[];
  productColor: string | null;
  /** The exact text to print — non-null ONLY when `wordingMode` is `"provided"`. */
  requiredWording: string | null;
  /**
   * Phase 1.1: which of the three text states this generation is under.
   * `requiredWording: null` alone is ambiguous — it is produced both by "the
   * customer hasn't answered yet" and by "the customer explicitly wants no
   * text at all", and those demand opposite provider behavior. Every
   * consumer must branch on this field, never guess from `requiredWording`.
   *
   * `"none"` is a HARD constraint: no words, letters, numbers, typography,
   * labels, captions, signage, decorative lettering, or invented brand text
   * anywhere in the artwork. It outranks concept-direction treatment, style
   * preferences, and every provider default.
   */
  wordingMode: RequiredWordingMode;
  printLocation: PrintPlacement | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  notes: string | null;
  /**
   * Sprint 2K Phase 3 (Goal 4): stylistic/reference touchpoints the customer
   * mentioned — era, mood, pop-culture cues such as "inspired by a 1960s
   * sitcom" or "like an old travel poster" — pulled out of `subject`/`style`
   * by `PromptTranslationCapability` so they never read as literal content.
   * These inform visual language only (typography, composition, era,
   * graphic language, palette) and must never be translated into an
   * instruction to depict real people, characters, logos, or copyrighted
   * material from the referenced work. Empty when the customer gave no such
   * reference.
   */
  inspirationReferences: string[];
  /**
   * Sprint 2K Phase 3 (Goal 7): whether the generated artwork may include
   * text beyond `requiredWording`. Always `false` today — generation must
   * not invent slogans, dates, or other wording the brief never asked for.
   * Represented here (provider-neutral) rather than left to each adapter's
   * own prompt phrasing.
   */
  allowAdditionalText: boolean;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: when set, generation must
   * produce exactly ONE concept in this specific catalog direction — a
   * targeted revision of a customer-selected concept, never a fresh
   * three-direction exploration. `null` for initial exploration and for an
   * explicit "show me alternatives" request, both of which still produce
   * all three directions.
   */
  targetConceptDirectionKey?: ConceptDirectionKey | null;
  /**
   * True Source-Image Targeted Revision: present ONLY for a targeted
   * revision of a customer-selected concept. When set, the generation
   * contract changes shape entirely — the provider must EDIT the supplied
   * source artwork rather than interpret the brief afresh:
   *
   *     REVISED ARTWORK = SELECTED SOURCE ARTWORK + REQUESTED DELTA
   *
   * `null` for initial generation and for a three-direction "show me
   * alternatives" regeneration, both of which remain pure text-to-image.
   */
  revision?: RevisionDirective | null;
}

/**
 * True Source-Image Targeted Revision: the provider-neutral delta for one
 * targeted revision. Plain customer-facing language only — never prompt
 * syntax, never a provider dialect, never a Design Brief entity.
 *
 * Built by `PromptTranslationCapability` from the customer's literal
 * instruction plus the `RegenerationPlan`; consumed by an image-edit
 * provider adapter, which owns 100% of the wording that expresses it.
 */
export interface RevisionDirective {
  /**
   * The distinct changes the customer actually asked for, in the order
   * they asked for them. "change the font to retro and remove the sunset"
   * arrives here as TWO entries — never as one blurred restatement of the
   * whole design, and never collapsed into `notes`.
   */
  requestedChanges: string[];
  /**
   * Elements confirmed to be working that must survive the edit unchanged.
   * The DEFAULT contract is "preserve everything not listed in
   * `requestedChanges`"; this only adds specifics worth naming explicitly.
   */
  preserve: string[];
  /** Elements that must not appear — exclusions and rejected directions. */
  avoid: string[];
  /**
   * Exact wording that must come through the edit character-for-character.
   * `null` when the design has no required wording, or when the customer's
   * own requested delta is a wording change (in which case changing it is
   * the point — see `wordingChangeRequested`).
   */
  lockedWording: string | null;
  /**
   * True when the customer explicitly asked to change the wording. Keeps
   * "protect the exact wording" from silently overriding "change the
   * wording to MR2 TURBO".
   *
   * Live Acceptance Cleanup: naming a text element while asking for an
   * APPEARANCE change ("make the 3 SONS text the same color as the ball")
   * is emphatically NOT this — see `shared/revision-delta.ts` and Prompt
   * Translation's `requestsWordingChange`. Misclassifying it lifted the
   * exact-wording lock and let an unrelated word be re-rendered.
   */
  wordingChangeRequested: boolean;
  /**
   * Live Acceptance Cleanup: the customer explicitly said "everything else
   * stays the same" (or "don't change anything else" / "leave the rest
   * alone"). The default contract is already "preserve everything not in
   * `requestedChanges`"; this records that the customer stated it, so the
   * adapter can express it as its own hard constraint rather than leaving
   * it buried inside a change description. `false` when they simply didn't
   * say it — never inferred, and never a weaker contract when absent.
   */
  preserveEverythingElse: boolean;
}

/**
 * Sprint 2H Part 1: customer-never-sees-this lifecycle for a single
 * generation attempt. Modeled as its own durable record (rather than inline
 * fields on `ArtworkVersion`) so a job can be looked up, resumed, and
 * retried by its deterministic `idempotencyKey` without depending on
 * whether it ever produced any concepts.
 */
export type GenerationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  /**
   * Sprint 2H Part 2A: a "running" job whose worker went silent (no
   * heartbeat) for too long — the process that claimed it likely died
   * mid-attempt. Distinct from "failed": nothing about generation itself
   * failed, so a job in this state is eligible to be claimed and retried
   * again, same as "queued".
   */
  | "recoverable";

/**
 * Sprint 2H Part 2A: which customer-facing flow this job belongs to. The
 * worker is otherwise fully self-sufficient (it never talks to
 * ConversationCapability) — this is what lets it choose the right
 * completion/failure message and post-success side effect (clearing the
 * concept selection only applies to a regeneration) purely from the job
 * record, without the caller staying involved after enqueueing.
 */
export type GenerationJobKind = "initial" | "regeneration";

export interface GenerationJob {
  id: string;
  projectId: string;
  designBriefVersionId: string;
  status: GenerationJobStatus;
  kind: GenerationJobKind;
  conceptCount: number;
  /** Internal only — never surfaced to conversation/customer. */
  providerKey: string;
  /**
   * Deterministic identity — the same (project, approved brief version)
   * pair always maps to the same job, so retrying never creates duplicate
   * concepts (Sprint 2H Part 1 idempotency strategy).
   */
  idempotencyKey: string;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: when set, this job is a
   * targeted revision of ONE customer-selected `ArtworkVersion` — the
   * worker produces exactly one new concept, tagged
   * `sourceArtworkVersionId` = this value, in that source's own
   * `conceptDirectionKey`. `null` for initial exploration and for an
   * explicit "show me alternatives" regeneration, both of which still
   * produce three independent directions with no source.
   */
  targetArtworkVersionId?: string | null;
  /**
   * True Source-Image Targeted Revision: the customer's literal revision
   * instruction for this job ("make the border red and change it to a
   * shield"), captured at enqueue time.
   *
   * A targeted revision is SOURCE ARTWORK + REQUESTED DELTA, and the delta
   * only exists in the customer's own words: the Design Brief records
   * design *state*, and `RegenerationPlan` only knows which brief sections
   * were touched. Without this column the worker has no durable way to tell
   * an image-edit provider what to change, which is exactly how a "targeted
   * revision" degenerated into a fresh text-to-image generation.
   *
   * Internal only — never surfaced through `ProjectSnapshot`, never shown to
   * the customer, never mistaken for prompt text (Prompt Translation, not
   * this field, decides how it reaches a provider). `null` for initial
   * generation, for a three-direction "show me alternatives" regeneration,
   * and for jobs created before this column existed.
   */
  revisionInstruction?: string | null;
  attempts: number;
  /** Sanitized, non-secret description of the most recent failure, if any. */
  lastError: string | null;
  /** Sprint 2H Part 2A: set each time a worker claims this job. */
  startedAt: string | null;
  /** Sprint 2H Part 2A: set once, when the job reaches "completed". */
  completedAt: string | null;
  /**
   * Sprint 2H Part 2A: bumped periodically while a worker is actively
   * running this job. `recoverAbandonedJobs` uses staleness here — not
   * `updatedAt` — to decide a job's worker has gone silent, so an
   * intentional status/attempts update doesn't reset the abandonment clock.
   */
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Phase 2C0.5: the lifecycle of ONE logical paid image intent.
 *
 *   "reserved"  — a worker has durably claimed this intent and is about to
 *                 dispatch (or has dispatched) a paid provider request for
 *                 it. Reserved BEFORE the call, never after, so a crash
 *                 mid-flight leaves evidence that money may already have
 *                 been spent.
 *   "succeeded" — the provider returned a usable image AND its bytes are
 *                 durably persisted as an `AssetRecord`. This is the only
 *                 status that authorizes REUSE without paying again.
 *   "failed"    — this intent exhausted `MAX_PAID_DISPATCHES_PER_INTENT`
 *                 without ever producing a durable image. Terminal: the
 *                 job fails rather than paying a third time.
 */
export type PaidImageIntentStatus = "reserved" | "succeeded" | "failed";

/**
 * Phase 2C0.5: the durable, at-most-once record of one paid image intent.
 *
 * This is the smallest unit that can answer "has this exact paid image
 * already been bought?" — see `capabilities/shared/paid-image-intent.ts`
 * for the identity contract and why no existing table could carry it.
 *
 * Internal only: never surfaced through `ProjectSnapshot`, never shown to a
 * customer, and `result` is a SANITIZED concept envelope (titles, direction,
 * asset ids, asset dimensions) — never prompt text, never image bytes,
 * never credentials.
 */
export interface PaidImageIntent {
  id: string;
  projectId: string;
  generationJobId: string;
  /** Deterministic identity — see `buildPaidImageIntentKey`. */
  intentKey: string;
  /** `"initial_concept" | "targeted_revision" | "replacement"`. */
  intentKind: string;
  /** Catalog direction, or `"batch"` for a provider with no per-direction path. */
  directionKey: string;
  /**
   * 1-based slot within this job's paid-intent budget. Unique per job, so
   * two racing workers can never both take the same slot, and bounded by a
   * database CHECK so a sixth intent is impossible even if code is wrong.
   */
  paidIntentOrdinal: number;
  status: PaidImageIntentStatus;
  /**
   * How many times this intent has been DISPATCHED to the provider, across
   * every worker and every reclaim. Bounded by
   * `MAX_PAID_DISPATCHES_PER_INTENT`.
   */
  dispatches: number;
  /**
   * Fencing token for the current reservation. Only the worker holding the
   * live token may mark this intent succeeded — a zombie worker that wakes
   * up after its job was reclaimed holds a stale token and its write is
   * refused, so it can never overwrite the newer worker's result.
   */
  claimToken: string | null;
  providerKey: string | null;
  /** Present when the provider exposed one — never a credential. */
  providerRequestId: string | null;
  /** Sanitized concept envelope; `null` until the intent succeeds. */
  result: Record<string, unknown> | null;
  /** Sanitized, non-secret description of the most recent failure. */
  lastError: string | null;
  succeededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 2H Part 1: a generated or uploaded file and its metadata. Storage
 * itself stays abstracted behind `storageKey` (an opaque reference — a data
 * URI today, a real object-store key in a future sprint) so swapping
 * storage backends never touches the domain model.
 */
export type AssetKind =
  | "customer_upload"
  | "logo"
  | "reference_image"
  | "generated_artwork"
  | "svg"
  | "png"
  | "pdf";

export interface AssetRecord {
  id: string;
  projectId: string;
  kind: AssetKind;
  /** Opaque reference to where the bytes live. Never a customer-facing detail. */
  storageKey: string | null;
  contentType: string | null;
  /** True when this record is a thumbnail companion to another asset. */
  isThumbnail: boolean;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  /** Internal provenance only — never surfaced to the customer. */
  providerKey: string | null;
  generationJobId: string | null;
  /** Sanitized provider response envelope. Must never contain prompt text or credentials. */
  metadata: Record<string, unknown>;
  /** Reserved for a future vector (SVG) companion asset. */
  vectorAssetId: string | null;
  /** Reserved for a future print-ready production asset. */
  printAssetId: string | null;
  /**
   * Sprint 2M Phase 2B: set only on a production asset a
   * `FinalArtworkCapability`/`FinalArtworkWorkerCapability` transformation
   * produces for a given `FinalArtworkJob` — never set on a concept-stage
   * asset. This is the unambiguous, non-filename, non-path way to tell a
   * concept source image apart from a production deliverable (Goal 8):
   * `generationJobId !== null` means "concept asset"; `finalArtworkJobId
   * !== null` means "production asset". One `FinalArtworkJob` may
   * eventually own multiple production assets (PNG + SVG + PDF), since
   * this is a foreign key, not a 1:1 slot. Always `null` until Sprint 2M
   * Phase 2C's worker runs.
   */
  finalArtworkJobId: string | null;
  /**
   * Sprint 2M Phase 2C: explicit production-deliverable classification —
   * Goal 10 requires this because the `finalArtworkJobId` foreign key alone
   * cannot distinguish a future PNG from an SVG from a PDF once one job
   * owns more than one production asset. `null` for every concept-stage
   * asset (`generationJobId !== null`). Never inferred from `contentType`
   * or a filename — always set explicitly by whichever capability creates
   * the row.
   */
  productionRole: ProductionAssetRole | null;
  createdAt: string;
}

/**
 * Sprint 2M Phase 2C (Goal 10): explicit production-asset kind. Phase 2C
 * only ever produces `"production_png"` (Goal 17 — raster apparel PNG is
 * the only supported production output); `"production_svg"`/
 * `"production_pdf"` are reserved for a future vector/PDF production
 * pipeline, not implemented here.
 */
export type ProductionAssetRole =
  | "production_png"
  | "production_svg"
  | "production_pdf";

/**
 * Sprint 2I Phase 1: internal ArtworkVersion workflow state for Concept
 * Evaluation. Never invents customer-visible wording — UI must not render
 * these labels as product language.
 */
export type ConceptEvaluationStatus =
  | "pending"
  | "passed"
  | "needs_review"
  | "failed";

export type ConceptEvaluationCriterionKey =
  | "required_wording"
  | "style"
  | "graphics"
  | "color_palette"
  | "product_compatibility"
  | "composition"
  | "readability"
  | "exclusions"
  | "overall_alignment";

export interface ConceptEvaluationCriterionScore {
  key: ConceptEvaluationCriterionKey;
  /** 0–100, or null when the criterion was not assessed. */
  score: number | null;
  /** null when the provider could not determine pass/fail. */
  passed: boolean | null;
  /** 0–100 confidence for this criterion alone. */
  confidence: number;
  /** Internal notes — never customer-facing copy. */
  notes: string | null;
}

/**
 * Phase 2B: deterministic print-palette / garment-contrast gate statuses.
 * Authoritative for hard palette compliance; OpenAI Vision must not reverse
 * a hard `fail`. Lifecycle rejection is deferred to Phase 2C.
 */
export type PrintPaletteComplianceStatus =
  | "pass"
  | "warn"
  | "fail"
  | "not_applicable";

/**
 * Compact diagnostics persisted on `ConceptEvaluation` (JSONB — no migration).
 * Metrics are fractions / counts only; never raw pixels.
 */
export interface PrintPaletteCompliance {
  status: PrintPaletteComplianceStatus;
  metrics: {
    visiblePixelWeight: number;
    visiblePixelFraction: number;
    veryLightPixelFraction: number;
    lightPixelFraction: number;
    midtonePixelFraction: number;
    darkPixelFraction: number;
    nearBlackPixelFraction: number;
    paletteCoverageFraction: number;
    garmentMatchingFraction: number;
    meanVisibleLuminance: number;
    garmentLuminance: number | null;
    garmentClass: "light" | "mid" | "dark" | "unknown";
    luminanceContrastDelta: number | null;
    requiredPaletteFamily: "light" | "dark" | "mid" | "unknown";
    enforcement: PrintPaletteEnforcement;
  };
  reasons: string[];
}

/**
 * Provider-neutral Concept Evaluation payload persisted on ArtworkVersion.
 * Distinct from Print Validation (DPI, transparency, print size, etc.).
 */
export interface ConceptEvaluation {
  overallScore: number | null;
  passed: boolean | null;
  confidence: number;
  criteria: ConceptEvaluationCriterionScore[];
  warnings: string[];
  recommendations: string[];
  missingRequirements: string[];
  matchedRequirements: string[];
  /** Internal provider envelope — never customer-facing. */
  providerMetadata: Record<string, unknown>;
  /**
   * Phase 2B: deterministic print-palette / garment-contrast compliance.
   * Optional for records written before Phase 2B; JSONB — no migration.
   */
  printPaletteCompliance?: PrintPaletteCompliance | null;
}

export interface ArtworkVersion {
  id: string;
  projectId: string;
  versionNumber: number;
  kind: ArtworkKind;
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
  isSelected: boolean;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: the artwork this one is a
   * targeted revision of, if any. `null` for an original (initial
   * exploration or explicit "show me alternatives") concept. Never
   * destructive — the source artwork remains a separate, historical row.
   * The durable lineage authority: a chain of `sourceArtworkVersionId`
   * links, not a parallel history table.
   */
  sourceArtworkVersionId?: string | null;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: which of the three catalog
   * creative directions (`lib/domain/concept-directions.ts`) this concept
   * used, when known. Lets a later single-concept revision of this exact
   * artwork regenerate in the SAME direction instead of defaulting to a
   * different one. `null` for historical rows generated before this field
   * existed.
   */
  conceptDirectionKey?: ConceptDirectionKey | null;
  /** Sprint 2D: the approved Design Brief version that authorized this concept. */
  designBriefVersionId: string | null;
  /**
   * Sprint 2H Part 1: internal generation provenance. `null` for
   * placeholder-generated concepts (no real generation job exists for
   * them). Never surfaced to the customer.
   */
  generationJobId: string | null;
  /** Internal reference to the primary generated image asset, if any. */
  primaryAssetId: string | null;
  /** Internal reference to the thumbnail asset, if any. */
  thumbnailAssetId: string | null;
  /** Internal provenance only — which provider produced this concept. Never rendered to the customer. */
  providerKey: string | null;
  /** Reserved for a future customer rating feature. Always null until implemented. */
  customerRating: number | null;
  /**
   * Sprint 2I Phase 1: Concept Evaluation workflow state. Internal only —
   * never blocks customer presentation in this phase.
   */
  evaluationStatus: ConceptEvaluationStatus | null;
  /** Sprint 2I Phase 1: provider-neutral evaluation payload, if any. */
  evaluation: ConceptEvaluation | null;
  /** Sprint 2I Phase 1: when evaluation was last written. */
  evaluationEvaluatedAt: string | null;
  /** Sprint 2I Phase 1: which evaluation provider produced `evaluation`. */
  evaluationProviderKey: string | null;
  /** Reserved for future print validation. Always null until implemented. */
  printValidationStatus: string | null;
  createdAt: string;
}

/**
 * Sprint 2D: frozen, provider-neutral copy of the working brief fields at
 * the moment of customer approval. Intentionally excludes ids/timestamps —
 * those live on the version row itself.
 */
export interface DesignBriefSnapshotContent {
  productSummary: string | null;
  designDescription: string | null;
  exactText: string | null;
  shirtColor: string | null;
  printPlacement: PrintPlacement | null;
  preferredColors: string[];
  designStyle: string | null;
  additionalInstructions: string | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  deferredSections: string[];
}

export type DesignBriefVersionStatus = "draft" | "approved" | "superseded";

/** Durable, immutable approval record. Never overwritten after creation. */
export interface DesignBriefVersion {
  id: string;
  projectId: string;
  briefId: string;
  versionNumber: number;
  status: DesignBriefVersionStatus;
  content: DesignBriefSnapshotContent;
  approvedAt: string;
  createdAt: string;
}

export interface ProjectSnapshot {
  project: PrintProject;
  brief: TShirtDesignBrief;
  conversation: DesignConversation;
  messages: ConversationMessage[];
  artworkVersions: ArtworkVersion[];
  /** Sprint 2D: append-only approved brief versions, most recent last. */
  designBriefVersions: DesignBriefVersion[];
}

/**
 * Sprint 2M Phase 2B: the customer's explicit, durable "this is my final
 * direction — prepare it for production" decision. Distinct from concept
 * *selection* (`ArtworkVersion.isSelected` /
 * `PrintProject.selectedArtworkVersionId`), which only means "I want to work
 * with this direction" and may still be revised freely.
 *
 * Modeled as its own append-only, immutable record (never as a mutable
 * boolean on `ArtworkVersion` or `PrintProject`) for the same reasons
 * `DesignBriefVersion` is its own table rather than a flag on the working
 * brief: auditability (who approved what, when), the ability to supersede
 * without destroying history (Constitution §6.11 — Version Everything), and
 * unambiguous idempotency (`status`, not a shared mutable field, decides
 * what is currently authoritative). Internal only — never included in
 * `ProjectSnapshot`, mirroring `GenerationJob`/`AssetRecord`; a customer-safe
 * derived status is computed separately (see `conversation-service.ts`).
 */
export type FinalDirectionApprovalStatus = "active" | "superseded";

export interface FinalDirectionApproval {
  id: string;
  projectId: string;
  /** The exact, immutable concept this approval authorizes — never "whatever is currently selected". */
  artworkVersionId: string;
  /** The approved Design Brief version this artwork was generated against, at the moment of approval. */
  designBriefVersionId: string;
  /**
   * At most one row per project may be "active" at a time. A newer approval
   * (a different `artworkVersionId`) or a new concept batch produced by
   * regeneration after this approval both supersede it — see
   * `FinalArtworkCapability` and `GenerationWorkerCapability`'s
   * regeneration-completion path. Superseding never deletes or rewrites this
   * row; it only flips `status`/`supersededAt` going forward.
   */
  status: FinalDirectionApprovalStatus;
  approvedAt: string;
  supersededAt: string | null;
  createdAt: string;
}

/**
 * Sprint 2M Phase 2B: customer-never-sees-this lifecycle for a single
 * production-finalization attempt, keyed 1:1 to the `FinalDirectionApproval`
 * that authorized it (never to a `PrintProject` or `ArtworkVersion` directly
 * — that keying is what makes "double-click"/"duplicate request" naturally
 * idempotent without a separate dedupe key). Deliberately its own table
 * rather than a reuse of `GenerationJob`: different trigger (explicit
 * approval, not brief approval), different idempotency authority (the
 * approval id, not `(project, approvedBriefVersion)`), different output
 * (production `AssetRecord`s + an eventual authoritative
 * `PrintValidationReport`, not concept `ArtworkVersion`s).
 *
 * Sprint 2M Phase 2C: `FinalArtworkWorkerCapability` now claims and runs
 * this job — `"recoverable"` and the claim/heartbeat fields below mirror
 * `GenerationJob`'s own worker lifecycle exactly (same atomic-claim,
 * stale-recovery shape, different table).
 */
export type FinalArtworkJobStatus =
  | "queued"
  | "running"
  | "recoverable"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Existing Artwork → Print Ready Phase 2: which customer authority a
 * `FinalArtworkJob` was created under. DERIVED, never a stored column — it is
 * `"prepared_upload"` exactly when `artworkPreparationId` is set, and
 * `"generated_concept"` exactly when `finalDirectionApprovalId` is
 * (the persistence layer enforces "exactly one"). Modelling it as a derived
 * discriminant rather than an enum column keeps the schema from carrying a
 * third fact that could disagree with the two foreign keys.
 *
 *   "generated_concept" — Create New Artwork. The authority is the customer's
 *     `FinalDirectionApproval` ("this concept is my final direction").
 *   "prepared_upload"   — Upload Existing Artwork. The authority is the
 *     customer's approval of their own PREPARED artwork
 *     (`ArtworkPreparation.status === "approved"`). There is deliberately no
 *     `FinalDirectionApproval` on this path — see `ArtworkPreparation`'s doc
 *     and ARCHITECTURE.md §13i for why fabricating one would be a second,
 *     competing production-approval authority.
 */
export type FinalArtworkSourceKind = "generated_concept" | "prepared_upload";

export interface FinalArtworkJob {
  id: string;
  projectId: string;
  /** See `FinalArtworkSourceKind` — derived from which authority id is set, never persisted separately. */
  sourceKind: FinalArtworkSourceKind;
  /** The Create New Artwork authority. `null` for a `"prepared_upload"` job. */
  finalDirectionApprovalId: string | null;
  /**
   * Existing Artwork → Print Ready Phase 2: the Upload Existing Artwork
   * authority — the `ArtworkPreparation` whose customer approval authorized
   * this finalization. `null` for a `"generated_concept"` job.
   */
  artworkPreparationId: string | null;
  /**
   * Existing Artwork → Print Ready Phase 2: the production print WIDTH, in
   * inches, this job was enqueued for — frozen at enqueue rather than re-read
   * from the working brief while the job runs.
   *
   * Only set for `"prepared_upload"`, where it is half of the idempotency key
   * (Goal 14: exactly one active finalization per preparation approval +
   * production-size intent, and a size change after a completed plate demands
   * a NEW job rather than silently reusing a mismatched deliverable).
   * `"generated_concept"` keeps its existing behavior — the worker reads
   * `TShirtDesignBrief.intendedPrintWidthIn` at run time — so nothing about
   * that path changes.
   */
  productionWidthIn: number | null;
  /** Denormalized for convenient querying — always the same artwork the authorizing record references. */
  artworkVersionId: string;
  status: FinalArtworkJobStatus;
  /**
   * Sprint 2M Phase 2C: mirrors `GenerationJob.attempts` — bumped on every
   * claim, backing the same shared-retry-budget shape
   * (`MAX_GENERATION_ATTEMPTS`-style ceiling) so a job whose worker keeps
   * dying mid-attempt eventually fails permanently instead of recovering
   * forever.
   */
  attempts: number;
  lastError: string | null;
  /** Sprint 2M Phase 2C: set each time a worker claims this job. */
  startedAt: string | null;
  /** Sprint 2M Phase 2C: set once, when the job reaches a terminal status. */
  completedAt: string | null;
  /** Sprint 2M Phase 2C: bumped periodically while a worker is actively running this job — same stale-recovery signal as `GenerationJob.heartbeatAt`. */
  heartbeatAt: string | null;
  /**
   * Sprint 2M Phase 2E (Goal 3): durable paid-provider request identity for
   * this job, so a worker crash/race between submitting a paid
   * reconstruction request (e.g. Topaz) and persisting its resulting
   * production asset never causes a second paid request on retry/recovery.
   * `providerKey` records which provider the in-flight/completed request
   * belongs to (a job whose provider changed between attempts is never
   * resumed against a stale request from a different provider).
   * `providerRequestId` is the provider's own request/job id — internal
   * only, never customer-facing. `providerStatus` is the last known raw
   * provider status string, for internal diagnostics only. All three are
   * `null` until a provider that performs a real paid submission actually
   * submits one, and stay `null` forever for a provider with no paid
   * request concept (e.g. local raster interpolation).
   */
  providerKey: string | null;
  providerRequestId: string | null;
  providerStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Existing Artwork → Print Ready Phase 1: the lifecycle of ONE piece of
 * customer-uploaded artwork on its way to becoming print-ready.
 *
 *   "analyzed" — the immutable original is stored and deterministic analysis
 *                has run. Nothing derived exists yet.
 *   "prepared" — a derived, transparent PNG exists (background isolated,
 *                edges cleaned). The customer has NOT approved it.
 *   "approved" — the customer explicitly confirmed the prepared artwork
 *                faithfully represents what they uploaded. This is NOT a
 *                claim that production ran, that enhancement happened, or
 *                that print validation passed (Constitution §15).
 *
 * There is deliberately no "rejected"/"failed" status: a preparation the
 * analyzer refuses to auto-repair simply stays `"analyzed"` and carries an
 * honest classification, which is a truthful description of reality rather
 * than a terminal state that would have to be un-stuck later.
 */
export type ArtworkPreparationStatus = "analyzed" | "prepared" | "approved";

/**
 * Existing Artwork → Print Ready Phase 1: the durable record of the second
 * first-class iHeartPrints workflow — "I already have artwork; make THAT
 * print-ready."
 *
 * WHY this is its own record rather than fields squeezed onto existing rows
 * (the schema-discipline audit for Phase 1):
 *
 *   1. It is the WORKFLOW IDENTITY. "Is this project `create_new` or
 *      `prepare_existing`?" is answered by "does a preparation exist for
 *      it?" — a real domain fact, not a speculative enum column added to
 *      `PrintProject` ahead of any second consumer.
 *   2. `AssetRecord` cannot express original → prepared lineage honestly:
 *      `vectorAssetId` means "a vector companion" and `printAssetId` means
 *      "a print-ready production asset". Neither means "the customer upload
 *      this was derived from", and reusing one would make a narrower field
 *      lie (explicitly forbidden by the Phase 1 brief).
 *   3. The customer's prepared-artwork APPROVAL must survive reload and is
 *      not any existing flag: `finalDirectionConfirmed` means "no more
 *      creative changes" in the generated-concept lifecycle and is reset by
 *      `selectConcept`; `selectedArtworkVersionId` means "the direction I'm
 *      working with". Neither means "this prepared file faithfully
 *      represents my upload".
 *
 * `analysis` / `preparation` are loosely typed as plain objects for the same
 * domain-layer-independence reason `ProductionAssetValidation.report` is —
 * they are narrowed at the `ArtworkPreparationCapability` boundary that
 * writes and reads them. Both are INTERNAL diagnostics: customer-facing copy
 * is derived from them (`preparation-copy.ts`), never rendered from them.
 */
export interface ArtworkPreparation {
  id: string;
  projectId: string;
  status: ArtworkPreparationStatus;
  /**
   * The customer's uploaded bytes, exactly as received. Immutable — every
   * transformation produces a NEW asset and this id never changes.
   */
  originalAssetId: string;
  /** The derived transparent PNG. `null` until background preparation runs. */
  preparedAssetId: string | null;
  /**
   * The `ArtworkVersion` (`kind: "prepared_upload"`) created when the
   * customer approves the prepared artwork — the handoff Phase 2's
   * `FinalArtwork` pipeline consumes. `null` until approval.
   *
   * Phase 2: together with `status === "approved"`, this IS the production
   * authority for the upload workflow — `FinalArtworkJob.artworkPreparationId`
   * points back here rather than at a fabricated `FinalDirectionApproval`.
   */
  preparedArtworkVersionId: string | null;
  /** Sanitized customer filename. Display only — never a storage path. */
  originalFilename: string | null;
  /** Deterministic `ArtworkAnalysis`. Internal diagnostics; never rendered raw. */
  analysis: Record<string, unknown>;
  /** Deterministic `BackgroundPreparationRecord`. `null` until prepared. */
  preparation: Record<string, unknown> | null;
  /**
   * Existing Artwork → Print Ready Phase 1.2: the customer's own background
   * cleanup, as the ORDERED LIST OF POINTS THEY CLICKED. `null` until they
   * click something.
   *
   * Deliberately the INPUT, not the output. The prepared PNG is a derived
   * asset that any of these clicks replaces; the clicks are the only fact the
   * customer actually authored, and re-running the deterministic pipeline over
   * the immutable original with this list reproduces the prepared bytes
   * exactly. That is what makes a reload, a retry, and an undo all cheap and
   * all honest — and it is why storing a pixel mask here instead would be
   * strictly worse: a mask cannot be replayed against a re-analysis, cannot be
   * undone one step at a time, and could disagree with the original it claims
   * to describe.
   *
   * Loosely typed for the same reason `analysis` and `preparation` are:
   * `GuidedCleanupRecord` is narrowed at the `ArtworkPreparationCapability`
   * boundary that writes and reads it.
   */
  guidedCleanup: Record<string, unknown> | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 2M Phase 2C (Goal 12): authoritative Print Validation's persisted
 * home. Deliberately its own record — never a single status column on
 * `ArtworkVersion` (Phase 2A/2B both audited and rejected that; see
 * ARCHITECTURE.md) — because one `FinalArtworkJob` may eventually produce
 * more than one production asset (PNG today; SVG/PDF reserved for later),
 * and each asset's readiness is independently true or false. Append-only:
 * a revalidation creates a new row rather than overwriting the last one, so
 * validation history stays auditable (Constitution §6.11).
 */
export interface ProductionAssetValidation {
  id: string;
  projectId: string;
  finalArtworkJobId: string;
  /** The production `AssetRecord` this validation run evaluated — never a concept-stage asset. */
  assetId: string;
  /**
   * Loosely typed as `string` (mirrors `TShirtDesignBrief.deferredSections`)
   * to avoid a domain → capabilities import cycle; narrowed to
   * `PrintValidationStatus` at the capability boundary that writes it
   * (`FinalArtworkWorkerCapability`).
   */
  status: string;
  /**
   * The full, internal `PrintValidationReport` this run produced — check
   * reasons, requirements, required transformations. Print-shop/internal
   * diagnostics only; never surfaced to the customer as-is (Goal 13).
   * Serialized as a plain object (mirrors `AssetRecord.metadata`) for the
   * same domain-layer-independence reason `status` is loosely typed.
   */
  report: Record<string, unknown>;
  validatedAt: string;
  createdAt: string;
}
