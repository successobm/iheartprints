export const PROJECT_STATUSES = [
  "intake",
  "ready_to_generate",
  "generating",
  "concepts_ready",
  "revision_requested",
  "approved",
  "finalizing",
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

export type ArtworkKind = "concept" | "revision" | "final";

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
export interface GenerationPromptRequest {
  product: string;
  subject: string;
  style: string | null;
  colors: string[];
  productColor: string | null;
  requiredWording: string | null;
  printLocation: PrintPlacement | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  notes: string | null;
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
  createdAt: string;
}

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
