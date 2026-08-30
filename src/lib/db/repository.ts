import type {
  AcquisitionFreeConceptClaim,
  AcquisitionSession,
  ArtworkPreparation,
  ArtworkPreparationStatus,
  ArtworkVersion,
  AssetRecord,
  ConceptDirectionKey,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  ConversationMessage,
  ConversationPhase,
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  DesignConversation,
  FinalArtworkJob,
  FinalDirectionApproval,
  GenerationJob,
  InterviewStateData,
  MessageRole,
  PaidImageIntent,
  PaidImageIntentStatus,
  PaymentEvent,
  PaymentEventApplication,
  PaymentProviderKey,
  PaymentTransaction,
  PrintProject,
  ProductionAssetValidation,
  ProductionProfile,
  ProductionUnlock,
  ProjectSnapshot,
  ProjectStatus,
  SignPreparation,
  SignPreparationStatus,
  StoredRequestedProductionOutput,
  TShirtDesignBrief,
} from "@/lib/domain/types";

export interface CreateMessageInput {
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CreateArtworkVersionInput {
  versionNumber: number;
  kind: ArtworkVersion["kind"];
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
  /** Sprint 2D: required provenance link to the approved brief that authorized this concept. */
  designBriefVersionId: string | null;
  /**
   * Sprint 2H Part 1: internal generation provenance. Optional so
   * placeholder-only call sites (and old tests) don't have to supply them —
   * repository implementations default missing values to `null`.
   */
  generationJobId?: string | null;
  primaryAssetId?: string | null;
  thumbnailAssetId?: string | null;
  providerKey?: string | null;
  /**
   * Sprint 2I Phase 1: optional Concept Evaluation fields written at
   * concept persistence time. Default null when omitted.
   */
  evaluationStatus?: ConceptEvaluationStatus | null;
  evaluation?: ConceptEvaluation | null;
  evaluationEvaluatedAt?: string | null;
  evaluationProviderKey?: string | null;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: lineage — which artwork (if
   * any) this one is a targeted revision of, and which catalog direction it
   * used. Both optional so existing call sites/tests default to `null`.
   */
  sourceArtworkVersionId?: string | null;
  conceptDirectionKey?: ConceptDirectionKey | null;
}

/** Sprint 2I Phase 1: update Concept Evaluation fields on an existing concept. */
export interface UpdateArtworkEvaluationInput {
  evaluationStatus: ConceptEvaluationStatus;
  evaluation: ConceptEvaluation;
  evaluationEvaluatedAt: string;
  evaluationProviderKey: string;
}

/** Sprint 2H Part 1: input for creating a durable generation job record. */
export interface CreateGenerationJobInput {
  designBriefVersionId: string;
  /** Sprint 2H Part 2A: which customer-facing flow this job belongs to. */
  kind: GenerationJob["kind"];
  conceptCount: number;
  providerKey: string;
  idempotencyKey: string;
  /** Sprint 2G Live Acceptance Corrective Pass — see `GenerationJob.targetArtworkVersionId`. */
  targetArtworkVersionId?: string | null;
  /** True Source-Image Targeted Revision — see `GenerationJob.revisionInstruction`. */
  revisionInstruction?: string | null;
  /**
   * Sprint A4 Correction 1: set ONLY when this job spends an acquisition
   * session's one free concept. Enforced unique per session by the database,
   * so the insert itself is the authority — see
   * `FreeConceptAlreadyConsumedError`.
   */
  acquisitionSessionId?: string | null;
}

/**
 * Sprint A4 Correction 1: the database refused a second free-concept
 * generation job for an acquisition session that already has one.
 *
 * This is a NORMAL outcome, not an infrastructure fault: it is what a
 * customer clicking twice, a duplicated request, a second project in the
 * same session, or a retry after a lost consumption write all look like from
 * the database's point of view. It is thrown rather than returned because
 * `createGenerationJob` has exactly one honest answer for every other case
 * (the job), and a nullable return would be indistinguishable from failure.
 *
 * Callers convert it into a customer-safe refusal. Nothing was spent: the
 * insert is refused before any job exists for a worker to claim.
 */
export class FreeConceptAlreadyConsumedError extends Error {
  constructor() {
    super("This acquisition session has already used its free concept.");
    this.name = "FreeConceptAlreadyConsumedError";
  }
}

export type UpdateGenerationJobInput = Partial<
  Pick<
    GenerationJob,
    | "status"
    | "attempts"
    | "lastError"
    | "startedAt"
    | "completedAt"
    | "heartbeatAt"
  >
>;

/** Sprint 2H Part 1: input for registering a stored/generated asset. */
export type CreateAssetInput = Omit<
  AssetRecord,
  "id" | "projectId" | "createdAt"
>;

/**
 * Phase 2C0.5: reserving one logical paid image intent — the durable
 * at-most-once claim taken BEFORE any paid provider call.
 */
export interface ReservePaidImageIntentInput {
  generationJobId: string;
  /** Deterministic — see `buildPaidImageIntentKey`. */
  intentKey: string;
  intentKind: string;
  directionKey: string;
  /** 1-based budget slot; unique per job. */
  paidIntentOrdinal: number;
  providerKey: string;
}

/**
 * Phase 2C0.5. Three genuinely different outcomes, modelled explicitly
 * rather than as a nullable row, because the caller must behave differently
 * for each and "no row" would conflate two of them:
 *
 *   "created"       — this is a brand-new logical intent; it has consumed a
 *                     budget slot and may proceed to dispatch.
 *   "existing"      — this exact intent already exists. Whether it may be
 *                     dispatched again is decided from its own status and
 *                     dispatch count, never from the fact that it was found.
 *   "ordinal_taken" — a concurrent worker won this budget slot. The caller
 *                     re-reads the job's intents and tries the next slot;
 *                     no paid call has happened.
 */
export type PaidImageIntentReservation =
  | { outcome: "created"; intent: PaidImageIntent }
  | { outcome: "existing"; intent: PaidImageIntent }
  | { outcome: "ordinal_taken" };

/** Phase 2C0.5: terminal write for one logical paid image intent. */
export interface CompletePaidImageIntentInput {
  status: Extract<PaidImageIntentStatus, "succeeded" | "failed">;
  /** Sanitized concept envelope — never prompt text, bytes, or credentials. */
  result?: Record<string, unknown> | null;
  providerRequestId?: string | null;
  lastError?: string | null;
}

/**
 * Phase 2C.2C: durable failure evidence for one logical paid image intent —
 * the NON-terminal counterpart to `CompletePaidImageIntentInput`.
 *
 * This exists because `completePaidImageIntent` could only ever write a
 * TERMINAL status, so a dispatch that failed with retries still remaining
 * had nowhere to record what happened. The live consequence: a Soft
 * replacement that OpenAI billed and answered, whose local persistence then
 * failed, left `provider_request_id = null` and `last_error = null` on a row
 * still reading `reserved`. The paid request id existed in memory at the
 * moment of failure and was simply dropped.
 */
export interface RecordPaidImageIntentFailureInput {
  /** Sanitized classification + description — see `describePaidImageFailure`. */
  lastError: string;
  /**
   * The provider's own request id, when the dispatch got far enough to
   * learn one. Never clears a previously-recorded id: `null`/omitted means
   * "nothing new to say", not "forget what you knew".
   */
  providerRequestId?: string | null;
  /**
   * `true` marks the intent terminally `"failed"`. Omitted/`false` leaves
   * the status untouched, so an intent whose parent job still intends to
   * retry stays retry-eligible within its existing dispatch budget.
   */
  terminal?: boolean;
}

export interface ApproveDesignBriefInput {
  briefId: string;
  versionNumber: number;
  content: DesignBriefSnapshotContent;
}

/** Sprint 2M Phase 2B. */
export interface CreateFinalDirectionApprovalInput {
  artworkVersionId: string;
  designBriefVersionId: string;
}

/**
 * Sprint 2M Phase 2B, generalized by Existing Artwork → Print Ready Phase 2.
 *
 * A discriminated union rather than four optional fields, because "exactly one
 * production authority" is a domain invariant, not a convention: a job with
 * both (or neither) is meaningless, and the database enforces the same rule
 * with a CHECK constraint. Implementations must throw
 * `UniqueConstraintViolationError` on a duplicate for the relevant key —
 * `(project, approval)` for a generated concept, `(project, preparation,
 * production width)` for a prepared upload.
 */
/**
 * Sprint A2 Correction 2 (Goal 3): the production output this job is being
 * created to satisfy, snapshotted from the project's CURRENT intent by the
 * caller and immutable afterwards. Required on both variants — there is no
 * "the caller forgot" path, because a job with no bound intent is exactly
 * the ambiguity this correction removes.
 *
 * Always normalized (`normalizeProductionIntent`), so `"production_png"` is
 * written rather than `null` for an ordinary request. `null` in the column
 * is reserved for jobs enqueued before the column existed.
 */
type FinalArtworkJobProductionIntent = {
  requestedProductionOutput: StoredRequestedProductionOutput;
};

/**
 * Print'em All Phase 2: the canonical production-treatment identity a job is
 * enqueued for, snapshotted from the project's durable treatment authority.
 *
 * Part of job identity for both workflows, exactly like `productionWidthIn`
 * and `requestedProductionOutput`: different settings are different plates
 * and must be different jobs, so an operator adjusting a screen cannot
 * silently re-aim work that is already queued or already done.
 */
export interface FinalArtworkJobTreatmentIntent {
  productionTreatmentKey: string;
}

export type CreateFinalArtworkJobInput =
  | ({
      sourceKind: "generated_concept";
      finalDirectionApprovalId: string;
      artworkVersionId: string;
      /**
       * Print'em All Phase 1: the CONFIRMED physical print width, in inches,
       * this job is enqueued for — now part of create_new job identity too,
       * exactly as it already was for prepared_upload.
       *
       * Previously absent, so a create_new job read the live working brief at
       * run time and silently re-aimed itself when the size changed
       * underneath it. Binding it here is what makes a queued job for a
       * superseded size detectably stale.
       */
      productionWidthIn: number;
    } & FinalArtworkJobProductionIntent &
      FinalArtworkJobTreatmentIntent)
  | ({
      sourceKind: "prepared_upload";
      artworkPreparationId: string;
      artworkVersionId: string;
      /** The production print width, in inches, this job is enqueued for — part of its idempotency key. */
      productionWidthIn: number;
    } & FinalArtworkJobProductionIntent &
      FinalArtworkJobTreatmentIntent)
  | {
      sourceKind: "sign_preparation";
      signPreparationId: string;
      /** The canonical `SignRepairPlan` identity this job is enqueued to execute — the full idempotency key alongside the preparation id. */
      signPlanKey: string;
      /** No `ArtworkVersion` exists for a sign job — see `FinalArtworkJob.artworkVersionId`'s doc. Always the authorizing `SignPreparation.id`. */
      artworkVersionId: string;
    };

/**
 * Sprint 2M Phase 2C: mirrors `UpdateGenerationJobInput`. Sprint 2M Phase 2E
 * adds the paid-call idempotency triple (Goal 3) — see `FinalArtworkJob`'s
 * doc.
 */
export type UpdateFinalArtworkJobInput = Partial<
  Pick<
    FinalArtworkJob,
    | "status"
    | "attempts"
    | "lastError"
    | "startedAt"
    | "completedAt"
    | "heartbeatAt"
    | "providerKey"
    | "providerRequestId"
    | "providerStatus"
    | "providerRecoveryAttempts"
  >
>;

/** Sprint 2M Phase 2C: input for persisting one authoritative Print Validation run against a production asset. */
export interface CreateProductionAssetValidationInput {
  finalArtworkJobId: string;
  assetId: string;
  status: string;
  report: Record<string, unknown>;
}

/**
 * Existing Artwork → Print Ready Phase 1: creating the durable record of one
 * customer-uploaded artwork, at the moment its immutable original has landed
 * in storage and deterministic analysis has run.
 */
export interface CreateArtworkPreparationInput {
  originalAssetId: string;
  originalFilename: string | null;
  analysis: Record<string, unknown>;
}

/**
 * Existing Artwork → Print Ready Phase 1. Deliberately narrow: `originalAssetId`
 * is NOT patchable — the customer's upload is immutable, and the only way to
 * work from different source bytes is a new preparation.
 */
export type UpdateArtworkPreparationInput = Partial<{
  status: ArtworkPreparationStatus;
  preparedAssetId: string | null;
  preparedArtworkVersionId: string | null;
  analysis: Record<string, unknown>;
  preparation: Record<string, unknown> | null;
  /** Phase 1.2: the customer's ordered guided-cleanup clicks. */
  guidedCleanup: Record<string, unknown> | null;
  /** Intelligent Separation Phase 9: the operator-confirmed region decision set. */
  separation: Record<string, unknown> | null;
  approvedAt: string | null;
}>;

/**
 * Signs Phase S1: creating the durable record of one rigid-sign artwork, at
 * the moment its immutable original has landed in storage and deterministic
 * inspection has run. Mirrors `CreateArtworkPreparationInput`'s shape and
 * discipline.
 */
export interface CreateSignPreparationInput {
  originalAssetId: string;
  originalFilename: string | null;
  inspection: Record<string, unknown> | null;
}

/**
 * Signs Phase S1. Deliberately narrow: `originalAssetId` is NOT patchable —
 * the customer's upload is immutable, and the only way to work from
 * different source bytes is a new preparation.
 */
export type UpdateSignPreparationInput = Partial<{
  status: SignPreparationStatus;
  orderedWidthIn: number | null;
  orderedHeightIn: number | null;
  specConfirmedAt: string | null;
  resolutionPolicyId: string | null;
  inspection: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  planKey: string | null;
}>;

/**
 * Thrown when a repository detects a duplicate (project_id, version_number)
 * approval insert — used by DesignBriefCapability to resolve idempotent retries.
 */
export class UniqueConstraintViolationError extends Error {
  constructor(constraint: string) {
    super(`Unique constraint violated: ${constraint}`);
    this.name = "UniqueConstraintViolationError";
  }
}

/**
 * Sprint A4: the three genuinely different outcomes of trying to allocate a
 * session's one free concept to a project, modelled explicitly because the
 * caller must behave differently for each and a nullable row would conflate
 * two of them (the same reasoning as `PaidImageIntentReservation`).
 *
 *   "allocated" — this session had no allocation and now has one for this
 *                 project. Generation may proceed as the free concept.
 *   "resumed"   — this session's allocation was ALREADY this project. A
 *                 reload, a second tab, a duplicate request, or a retry
 *                 after a failed enqueue all land here. Generation may
 *                 proceed as the same free concept; nothing new is spent.
 *   "exhausted" — the free concept is allocated elsewhere, or already
 *                 consumed by a durable job. No free generation.
 */
export type FreeConceptAllocation =
  | { outcome: "allocated"; session: AcquisitionSession }
  | { outcome: "resumed"; session: AcquisitionSession }
  | { outcome: "exhausted"; session: AcquisitionSession };

/**
 * Sprint A5.1: what a caller must supply to grant a production unlock.
 *
 * There is no `status` field: a grant is always `"active"`, because a record
 * that could be inserted already-revoked would be a fiction with a
 * `granted_at` nobody ever granted. Revocation is its own operation on an
 * existing row.
 */
export interface CreateProductionUnlockInput {
  /**
   * Resolved by the caller from the PROJECT's own durable binding
   * (`PrintProject.acquisitionSessionId`) — never from a cookie, a header, or
   * a request body. The repository does not verify this; the gate
   * (`AcquisitionCapability.authorizeFinalization`) cross-checks it against
   * the project's binding and fails closed on a mismatch.
   */
  acquisitionSessionId: string;
  productionProfile: ProductionProfile;
}

/**
 * Sprint A5.1: the two genuinely different outcomes of a grant, distinguished
 * for the same reason `FreeConceptAllocation` and `PaidImageIntentReservation`
 * are — a nullable row would conflate them.
 *
 *   "granted"  — this call created the active unlock.
 *   "existing" — an active unlock for this (project, profile) already
 *                existed. A duplicate request, a double click, or the loser
 *                of a genuine race. Returns the WINNING row, which is the
 *                fact the caller needs; the project is unlocked either way.
 *
 * Note there is no "failed" outcome. A grant that loses the uniqueness race
 * has not failed at anything — the desired end state holds.
 */
export type ProductionUnlockGrant =
  | { outcome: "granted"; unlock: ProductionUnlock }
  | { outcome: "existing"; unlock: ProductionUnlock };

/**
 * Sprint A5.3: what a caller must supply to open a checkout attempt.
 *
 * Every field is SERVER-RESOLVED — the acquisition session from the
 * project's own durable binding, the profile/amount/currency from
 * server-side configuration. Nothing here may originate in a request body,
 * and the shape carries no field a browser could meaningfully supply.
 */
export interface OpenPaymentTransactionInput {
  acquisitionSessionId: string;
  productionProfile: ProductionProfile;
  provider: PaymentProviderKey;
  /** Positive integer, minor units. Frozen at creation. */
  amountMinor: number;
  /** Lowercase ISO 4217. Frozen at creation. */
  currency: string;
}

/**
 * Sprint A5.3: the two outcomes of opening an attempt, distinguished for the
 * same reason `ProductionUnlockGrant`'s are.
 *
 *   "opened"   — this call created the outstanding attempt.
 *   "existing" — an outstanding attempt already existed. A second tab, a
 *                double click, a duplicated request, or the loser of a
 *                genuine race. Returns the WINNER, which may be
 *                `pending_provider` (resume it) or `created` (reuse it).
 */
export type PaymentTransactionOpening =
  | { outcome: "opened"; transaction: PaymentTransaction }
  | { outcome: "existing"; transaction: PaymentTransaction };

/**
 * Sprint A5.3: proof that a provider checkout session genuinely exists.
 *
 * `providerPaymentIntentId` is optional because most providers do not create
 * one until the customer actually pays — its absence at bind time is normal,
 * not a partial write.
 */
export interface BindProviderCheckoutSessionInput {
  providerCheckoutSessionId: string;
  providerCheckoutUrl: string;
  providerPaymentIntentId?: string | null;
}

/**
 * Sprint A5.4: everything the atomic authority is allowed to know.
 *
 * Note what is absent and why: no project id, no acquisition session id, no
 * production profile. They are derived from the transaction row inside the
 * operation. Every provider-reported value below exists to be COMPARED, never
 * to establish a fact.
 */
export interface ApplyPaymentEventInput {
  provider: PaymentProviderKey;
  /** The provider's event id. UNIQUE — the idempotency fence. */
  providerEventId: string;
  /** Verbatim provider event type, for forensics only. */
  eventType: string;
  /** SHA-256 (hex) of the verified raw bytes. Never the payload itself. */
  payloadDigest: string;
  /** Closed vocabulary decided by the provider adapter. */
  action: "activate" | "expire" | "ignore";
  /** A LOOKUP HANDLE for the durable row. `null` for an ignored event. */
  paymentTransactionId: string | null;
  /** Cross-checked against the stored session id; a mismatch refuses. */
  providerCheckoutSessionId: string | null;
  /** Bound only on success. The column's UNIQUE constraint is a second fence. */
  providerPaymentIntentId: string | null;
  /** Compared exactly. No conversion, no rounding, no tolerance. */
  amountMinor: number | null;
  /** Compared exactly. */
  currency: string | null;
}

/** Sprint A4: normalized email plus the moment it was captured. */
export interface CaptureAcquisitionEmailInput {
  /** Already trimmed/lowercased by `AcquisitionCapability` — repositories never normalize. */
  email: string;
}

export interface ProjectRepository {
  /**
   * Sprint A4: `acquisitionSessionId` binds the new project to the session
   * that created it — the durable authority every paid-value gate resolves
   * from. Optional, defaulting to `null`, for exactly one reason: internal
   * callers and capability-level tests that create a project directly have
   * no acquisition session and must not be forced to fabricate one. A
   * `null` binding is the LEGACY reading (grandfathered), and the customer
   * API path always supplies a real id.
   */
  createProject(acquisitionSessionId?: string | null): Promise<ProjectSnapshot>;
  getProject(projectId: string): Promise<ProjectSnapshot | null>;
  /**
   * Phase 28P: every project's bare row (never the full `ProjectSnapshot`
   * — no brief, conversation, messages, or artwork versions). Internal-only
   * caller today: `continue-as-internal-job.ts`'s idempotency check, which
   * must answer "has this exact source artwork already been continued into
   * an internal project?" without a dedicated indexed table (see that
   * file's doc comment for why a full scan is an acceptable V1 trade-off
   * here). Never exposed through a customer-facing route — nothing about
   * this method scopes by session or ownership, so a caller that is not
   * already internally-authorized must never reach it.
   */
  listProjects(): Promise<PrintProject[]>;
  updateProject(
    projectId: string,
    patch: Partial<
      Pick<
        PrintProject,
        | "name"
        | "status"
        | "selectedArtworkVersionId"
        | "revisionPending"
        | "finalDirectionConfirmed"
      >
    >,
  ): Promise<PrintProject>;
  updateBrief(
    projectId: string,
    patch: Partial<
      Omit<TShirtDesignBrief, "id" | "projectId" | "createdAt" | "updatedAt">
    >,
  ): Promise<TShirtDesignBrief>;
  updateConversationPhase(
    projectId: string,
    phase: ConversationPhase,
  ): Promise<DesignConversation>;
  /**
   * Sprint 2F: persists adaptive interview bookkeeping (pending section, ask
   * counts, dismissed advisories) separately from `phase` so a reload can
   * resume the adaptive loop. Never used for Design Brief content.
   */
  updateConversationInterviewState(
    projectId: string,
    interviewState: InterviewStateData,
  ): Promise<DesignConversation>;
  addMessage(
    projectId: string,
    input: CreateMessageInput,
  ): Promise<ConversationMessage>;
  addArtworkVersions(
    projectId: string,
    versions: CreateArtworkVersionInput[],
  ): Promise<ArtworkVersion[]>;
  /**
   * Sprint 2I Phase 1: persist Concept Evaluation on an existing artwork
   * version. Idempotent callers should skip when evaluationStatus is already
   * set. Never deletes or replaces the concept itself.
   */
  updateArtworkEvaluation(
    artworkVersionId: string,
    input: UpdateArtworkEvaluationInput,
  ): Promise<ArtworkVersion>;
  selectArtworkVersion(
    projectId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot>;
  /**
   * Live Acceptance Cleanup (Issue 2): the exact inverse of
   * `selectArtworkVersion` — returns the project to "no concept selected".
   * Clears `PrintProject.selectedArtworkVersionId` AND every
   * `ArtworkVersion.isSelected` in one place, so the two can never disagree
   * (the same reason `selectArtworkVersion` owns both writes).
   *
   * Deliberately NOT expressible as `updateProject({ selectedArtworkVersionId:
   * null })`: that would leave `isSelected` set on the artwork row, and a
   * client-side visual reset would leave both. Selection is server state.
   *
   * Never deletes an artwork version, a batch, a job, or any history — the
   * concepts themselves are untouched and remain selectable.
   */
  clearArtworkSelection(projectId: string): Promise<ProjectSnapshot>;
  setProjectStatus(
    projectId: string,
    status: ProjectStatus,
  ): Promise<PrintProject>;
  /**
   * Sprint 2D: durable, append-only approval record.
   * Implementations must throw UniqueConstraintViolationError on a duplicate
   * (project_id, version_number) rather than silently overwriting history.
   */
  approveDesignBrief(
    projectId: string,
    input: ApproveDesignBriefInput,
  ): Promise<DesignBriefVersion>;
  getLatestDesignBriefVersion(
    projectId: string,
  ): Promise<DesignBriefVersion | null>;
  getDesignBriefVersionById(
    versionId: string,
  ): Promise<DesignBriefVersion | null>;

  /**
   * Sprint 2H Part 1: real generation job persistence, backing
   * ConceptGenerationCapability's idempotency and retry strategy. Never
   * exposed through `ProjectSnapshot` — internal tracing only.
   */
  /**
   * Sprint A4 Correction 1: when `input.acquisitionSessionId` is set, THIS
   * INSERT IS THE ENTITLEMENT AUTHORITY.
   *
   * Implementations must make both uniqueness rules real, and must
   * distinguish them by re-reading rather than by parsing an error string:
   *
   *   (project_id, idempotency_key)   the same logical job already exists →
   *                                   return the WINNER'S row. A double
   *                                   click, a duplicated request, or a
   *                                   retry is resuming one job, not
   *                                   requesting a second.
   *   (acquisition_session_id)        this session already has a free-concept
   *                                   job, and it is a DIFFERENT one →
   *                                   throw `FreeConceptAlreadyConsumedError`.
   *
   * The second rule is what makes a second free concept impossible even when
   * `recordFreeConceptConsumed` never ran — the crash window that no amount
   * of application ordering can close on its own.
   */
  createGenerationJob(
    projectId: string,
    input: CreateGenerationJobInput,
  ): Promise<GenerationJob>;
  /**
   * Sprint A4 Correction 1: the free-concept job this session spent, if any
   * — the RECONCILIATION source for consumption.
   *
   * `AcquisitionSession.freeConceptConsumedAt` is written immediately after
   * the job insert, but the two are separate writes and a crash can land
   * between them. This answers the same question from the row the database
   * itself guarantees is unique, so a session whose marker is missing still
   * reads as consumed instead of handing out a second free concept.
   */
  getFreeConceptGenerationJob(
    acquisitionSessionId: string,
  ): Promise<GenerationJob | null>;
  /**
   * Sprint A4 Correction 2: the durable, session-owned claim on the ONE free
   * concept attempt — the LIFETIME entitlement authority.
   *
   * This exists because the Correction 1 authority (a partial unique index
   * on `generation_jobs.acquisition_session_id`) only constrains rows that
   * exist: deleting the free job freed the slot for another. The claim is
   * owned by the session, holds no foreign key to the job, and therefore
   * keeps enforcing after the job it names has been deleted.
   *
   * Taken ATOMICALLY as part of the `generation_jobs` insert (a BEFORE
   * INSERT trigger in Postgres; the same single locked operation in the
   * local store), so there is no window in which a job exists without a
   * claim or a claim exists without a job.
   *
   * This is what `AcquisitionCapability` reconciles from — never the
   * `free_concept_consumed_at` marker alone, and never the job alone.
   */
  getFreeConceptClaim(
    acquisitionSessionId: string,
  ): Promise<AcquisitionFreeConceptClaim | null>;
  getGenerationJobByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<GenerationJob | null>;
  getGenerationJob(jobId: string): Promise<GenerationJob | null>;
  listGenerationJobs(projectId: string): Promise<GenerationJob[]>;
  updateGenerationJob(
    jobId: string,
    patch: UpdateGenerationJobInput,
  ): Promise<GenerationJob>;
  /**
   * Sprint 2H Part 2A: the worker's entry point. Atomically-enough claims
   * the single oldest "queued" or "recoverable" job across every project
   * (real background work is never scoped to one caller's project) and
   * marks it "running" with a fresh `startedAt`/`heartbeatAt` and
   * incremented `attempts`, or returns `null` if nothing is due. Uses an
   * optimistic conditional update (claim wins only if the job's status
   * still matched what was read) so two concurrent callers can never both
   * claim the same job — implementations must guarantee this even without
   * a real row lock.
   */
  claimNextQueuedJob(): Promise<GenerationJob | null>;
  /** Sprint 2H Part 2A: cheap liveness signal while a worker is actively running a job. */
  touchGenerationJobHeartbeat(jobId: string): Promise<void>;
  /**
   * Sprint 2H Part 2A: sweeps "running" jobs whose heartbeat is older than
   * `staleAfterMs` (or was never set) and flips them to "recoverable" so
   * `claimNextQueuedJob` can pick them back up. Returns the jobs it
   * recovered.
   */
  recoverAbandonedJobs(staleAfterMs: number): Promise<GenerationJob[]>;

  // --- Sprint A4: acquisition sessions ---------------------------------

  /**
   * Creates a new anonymous acquisition session holding the supplied opaque
   * token. The token is generated by the capability (never by the
   * repository) so token entropy policy lives in one auditable place.
   */
  createAcquisitionSession(sessionToken: string): Promise<AcquisitionSession>;
  getAcquisitionSessionByToken(
    sessionToken: string,
  ): Promise<AcquisitionSession | null>;
  getAcquisitionSession(sessionId: string): Promise<AcquisitionSession | null>;
  /**
   * Atomically allocates this session's one free concept to `projectId`.
   *
   * Implementations MUST make the allocation a single conditional write
   * (`... where free_concept_project_id is null`), never a read followed by
   * an unconditional write: two concurrent first-generation requests — a
   * double click, two tabs, a duplicated HTTP request — must resolve to one
   * `"allocated"` and one `"resumed"`, never two allocations.
   *
   * A session whose free concept is already CONSUMED (a durable generation
   * job exists) is always `"exhausted"`, even for the same project. That is
   * what stops a second free generation on the project the free concept was
   * spent on.
   */
  allocateFreeConcept(
    sessionId: string,
    projectId: string,
  ): Promise<FreeConceptAllocation>;
  /**
   * Records the durable generation job that CONSUMED the free concept —
   * the irreversible half of the entitlement.
   *
   * Conditional on `free_concept_generation_job_id is null`, so a late or
   * duplicated call can never re-point consumption at a different job.
   * Returns the session as it stands afterwards; a caller that lost the
   * race sees the winning job id, which is exactly the fact it needs.
   */
  recordFreeConceptConsumed(
    sessionId: string,
    generationJobId: string,
  ): Promise<AcquisitionSession | null>;
  /**
   * Persists the captured email. Last write wins so a customer who mistyped
   * their address can correct it; `emailCapturedAt` is stamped on the FIRST
   * capture and never moved, because "when did this prospect give us an
   * address" is not re-answered by a correction.
   *
   * Never touches `entitlement` — capturing an email is not a grant.
   */
  captureAcquisitionEmail(
    sessionId: string,
    input: CaptureAcquisitionEmailInput,
  ): Promise<AcquisitionSession | null>;
  /**
   * Grants the internal entitlement, with an audit timestamp. Only ever
   * called after a server-side secret comparison succeeds; the repository
   * itself performs no authorization.
   */
  grantInternalEntitlement(
    sessionId: string,
  ): Promise<AcquisitionSession | null>;

  // --- Sprint A5.1: production unlocks (commercial entitlement) --------

  /**
   * The project's live commercial entitlement for one production profile,
   * or `null`.
   *
   * Implementations MUST filter on `status = 'active'` in the query rather
   * than returning the newest row for the caller to inspect: a revoked
   * unlock reaching a gate that forgot to check is the one failure mode this
   * method exists to make impossible. `AcquisitionCapability` re-verifies
   * anyway (`productionUnlockAuthorizes`) — the two checks are deliberate
   * defense in depth, not redundancy, because the local and Supabase stores
   * narrow persisted values independently.
   *
   * A row whose persisted profile or status this build cannot interpret must
   * never be returned as active. Both stores narrow through
   * `readStoredProductionProfile` / `readStoredProductionUnlockStatus`, which
   * fail closed to an unrecognized sentinel rather than coercing to the one
   * value this build happens to implement.
   */
  getActiveProductionUnlock(
    projectId: string,
    productionProfile: ProductionProfile,
  ): Promise<ProductionUnlock | null>;

  /**
   * Grants a production unlock for a project, idempotently.
   *
   * THE UNIQUENESS IS THE GUARANTEE, not a read-before-write. Two concurrent
   * grants — a duplicate request, two operator clicks, and (in A5.3+) two
   * webhook deliveries — must resolve to exactly ONE active row. The Postgres
   * implementation gets this from the partial unique index
   * `production_unlocks_active_per_project_profile_idx` and re-reads the
   * winner on `unique_violation`; the local store gets it from its own
   * process-wide lock around the same check-then-insert. Neither may ever
   * produce two active unlocks for one (project, profile).
   *
   * The loser of a race is reported as `"existing"` rather than thrown: it is
   * an ordinary, expected outcome, and the caller's correct behavior is
   * identical either way — the project is unlocked.
   *
   * `acquisitionSessionId` is supplied by the caller, which must resolve it
   * from the PROJECT's own durable binding and never from a cookie, header,
   * or request body. The repository performs no authorization of its own.
   */
  createProductionUnlock(
    projectId: string,
    input: CreateProductionUnlockInput,
  ): Promise<ProductionUnlockGrant>;

  /**
   * Withdraws the active unlock for a project and profile (refund,
   * chargeback, operator action). Returns the revoked row, or `null` when
   * there was nothing active to revoke.
   *
   * NEVER deletes the row, and never touches `final_artwork_jobs`, assets, or
   * production validations. Revocation stops FUTURE finalization; artwork
   * already produced remains exactly as it was, because it genuinely was
   * produced. A later re-grant inserts a NEW row rather than reviving this
   * one — the partial unique index only constrains active rows, so the audit
   * trail accumulates instead of being overwritten.
   */
  revokeProductionUnlock(
    projectId: string,
    productionProfile: ProductionProfile,
    reason: string | null,
  ): Promise<ProductionUnlock | null>;

  // --- Sprint A5.3: payment transactions (checkout attempts) -----------

  /**
   * The project's current OUTSTANDING checkout attempt for one production
   * profile (`pending_provider` or `created`), or `null`.
   *
   * Implementations MUST filter on the outstanding statuses in the query.
   * The terminal ones must not surface here: returning a `failed` attempt
   * would strand a customer who is entitled to try again, and returning a
   * `paid` one would put a completed purchase back in front of them.
   */
  getOutstandingPaymentTransaction(
    projectId: string,
    productionProfile: ProductionProfile,
  ): Promise<PaymentTransaction | null>;

  getPaymentTransaction(id: string): Promise<PaymentTransaction | null>;

  /**
   * Opens a checkout attempt in the PRE-PROVIDER state
   * (`status: "pending_provider"`) — a durable row with no provider session
   * behind it yet.
   *
   * THE ROW MUST EXIST FIRST. Its id is what the caller hands the provider
   * as an idempotency key and as the metadata handle a later verified
   * webhook reconciles through; there is nothing else stable to use, and
   * generating an id without persisting it would leave a crash with no way
   * back to the session it created.
   *
   * THE UNIQUENESS IS THE GUARANTEE. At most one outstanding attempt per
   * (project, profile), enforced by the partial unique index
   * `payment_transactions_outstanding_per_project_profile_idx`. A caller
   * that loses the race is reported `"existing"` with the WINNER, never
   * thrown at — two tabs must converge on one payment page, and an error
   * here would tempt a retry that creates a second one.
   *
   * `amountMinor`, `currency`, and `productionProfile` are frozen from the
   * caller's server-resolved offer and never re-read from configuration
   * afterwards. `acquisitionSessionId` must be resolved from the PROJECT's
   * own durable binding — the repository performs no authorization.
   */
  openPaymentTransaction(
    projectId: string,
    input: OpenPaymentTransactionInput,
  ): Promise<PaymentTransactionOpening>;

  /**
   * Binds a genuinely-created provider checkout session to a
   * `pending_provider` attempt, moving it to `"created"`.
   *
   * Conditional on the row still being `pending_provider`, so a late or
   * duplicated bind can never re-point a transaction at a different session
   * or resurrect a terminal one. Returns the transaction as it genuinely
   * stands; a caller that lost the race sees the winning session, which is
   * exactly the fact it needs.
   *
   * The database independently refuses a `created` row that is missing its
   * session id or URL (`payment_transactions_created_is_bound`), so a
   * partial bind cannot produce a checkout with nowhere to send anyone.
   */
  bindProviderCheckoutSession(
    id: string,
    input: BindProviderCheckoutSessionInput,
  ): Promise<PaymentTransaction | null>;

  /**
   * Marks an attempt `"failed"`, freeing the outstanding slot.
   *
   * ONLY ever called for a failure that PROVABLY never created a provider
   * session. An ambiguous provider failure must leave the row
   * `pending_provider` instead: a session may really exist, and freeing the
   * slot would let a second checkout start alongside it. Conditional on the
   * row still being `pending_provider`.
   */
  failPendingPaymentTransaction(
    id: string,
    reason: string | null,
  ): Promise<PaymentTransaction | null>;

  // --- Sprint A5.4: verified payment events + atomic activation --------

  /**
   * THE ATOMIC PAYMENT-TO-ENTITLEMENT TRANSITION, and the only thing in this
   * repository that may ever create a `ProductionUnlock` from a payment.
   *
   * ONE INDIVISIBLE OPERATION. Recording the verified event, reconciling it
   * against the durable transaction, marking that transaction paid, and
   * activating the unlock either ALL happen or NONE do. Implementations must
   * not expose this as several calls a caller sequences, because the two
   * states it exists to prevent are exactly the partial ones:
   *
   *   paid, no unlock    the customer was charged and can produce nothing.
   *   unlock, not paid   production reconstruction was given away.
   *
   * The Supabase implementation calls the `apply_payment_event` database
   * function — a real PostgreSQL transaction, because the REST API cannot span
   * two tables otherwise. The local store performs the same sequence under its
   * process-wide lock. Both make identical decisions.
   *
   * WHAT IT MAY NOT BE TOLD: `projectId`, `acquisitionSessionId`, or
   * `productionProfile`. Those are read from the transaction row named by
   * `paymentTransactionId`. A webhook able to supply them could unlock a
   * different customer's project, so the parameter simply does not exist.
   *
   * Every other provider-reported value is COMPARED against stored state,
   * never used to establish it. Amount and currency must match EXACTLY.
   *
   * Returns `"duplicate"` when this provider event was already recorded — the
   * uniqueness on `provider_event_id` participates in the transaction, so a
   * concurrent redelivery blocks and then finds the conflict rather than
   * reading, seeing nothing, and granting a second time.
   */
  applyPaymentEvent(
    input: ApplyPaymentEventInput,
  ): Promise<PaymentEventApplication>;

  /** Read-only, for tests and operational forensics. Never a gate input. */
  getPaymentEventByProviderId(
    provider: PaymentProviderKey,
    providerEventId: string,
  ): Promise<PaymentEvent | null>;

  // --- Phase 2C0.5: durable paid image intents -------------------------

  /**
   * Durably reserves ONE logical paid image intent, BEFORE any paid
   * provider call. Never overwrites an existing intent: an intent key that
   * already exists comes back as `"existing"` with whatever state it is
   * genuinely in, which is what makes recovery reuse (rather than re-buy)
   * an image the platform already owns.
   *
   * Implementations must make both uniqueness rules real, not advisory:
   *   (project_id, intent_key)                → at-most-once paid identity
   *   (generation_job_id, paid_intent_ordinal) → atomic budget-slot claim
   *
   * A lost race on the ordinal is reported as `"ordinal_taken"` rather than
   * thrown, because it is an ordinary, expected outcome under concurrency
   * and no paid call has happened.
   */
  reservePaidImageIntent(
    projectId: string,
    input: ReservePaidImageIntentInput,
  ): Promise<PaidImageIntentReservation>;
  /**
   * Authorizes exactly one paid provider dispatch for an intent, and is the
   * ONLY thing that may do so. Conditional by construction: succeeds only
   * while the intent is still `"reserved"` and has dispatches remaining,
   * and stamps a fresh `claimToken` that fences out any older worker still
   * holding the previous one. Returns `null` when the dispatch is refused
   * (already succeeded, already failed, or out of dispatches) — the caller
   * must NOT call the provider in that case.
   */
  beginPaidImageIntentDispatch(
    intentId: string,
    claimToken: string,
    maxDispatches: number,
  ): Promise<PaidImageIntent | null>;
  /**
   * Terminal write for one intent, fenced on `claimToken`. A zombie worker
   * whose job was reclaimed holds a stale token and gets `null` back rather
   * than clobbering the live worker's result.
   */
  completePaidImageIntent(
    intentId: string,
    claimToken: string,
    input: CompletePaidImageIntentInput,
  ): Promise<PaidImageIntent | null>;
  /**
   * Phase 2C.2C: records durable failure evidence on an intent WITHOUT
   * necessarily ending its life. Fenced on `claimToken` exactly as
   * `completePaidImageIntent` is — a zombie worker holding a stale token
   * gets `null` back and cannot overwrite newer state.
   *
   * Implementations must guarantee all four:
   *   - a `"succeeded"` intent is never modified (a durable success can
   *     never be downgraded by a late failure write from any worker);
   *   - `providerRequestId` is only ever written, never cleared;
   *   - `terminal !== true` leaves `status` exactly as it was;
   *   - `terminal === true` writes `status = "failed"`.
   */
  recordPaidImageIntentFailure(
    intentId: string,
    claimToken: string,
    input: RecordPaidImageIntentFailureInput,
  ): Promise<PaidImageIntent | null>;
  getPaidImageIntentByKey(
    projectId: string,
    intentKey: string,
  ): Promise<PaidImageIntent | null>;
  /** Every intent this job has ever reserved, oldest slot first. */
  listPaidImageIntentsForJob(
    projectId: string,
    generationJobId: string,
  ): Promise<PaidImageIntent[]>;

  /** Sprint 2H Part 1: real asset persistence, backing AssetCapability. */
  createAsset(projectId: string, input: CreateAssetInput): Promise<AssetRecord>;
  listAssets(projectId: string): Promise<AssetRecord[]>;
  getAssetById(assetId: string): Promise<AssetRecord | null>;
  /**
   * Sprint 2H Part 2A: hard-deletes an asset row. Only ever used for
   * cleaning up an orphaned upload (bytes landed in storage but the
   * concept/job that would have referenced them never completed) — never
   * for removing a customer-visible asset (Constitution §6.11, Version
   * Everything).
   */
  deleteAsset(assetId: string): Promise<void>;

  // --- Sprint 2M Phase 2B: final direction approval + final artwork job ---

  /**
   * Inserts a new "active" `FinalDirectionApproval` row. Implementations
   * must throw `UniqueConstraintViolationError` if another row for this
   * project is already "active" (at most one active approval per project —
   * `FinalArtworkCapability` is responsible for superseding the prior one
   * first) rather than allowing two simultaneously-active approvals.
   */
  createFinalDirectionApproval(
    projectId: string,
    input: CreateFinalDirectionApprovalInput,
  ): Promise<FinalDirectionApproval>;
  getActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null>;
  /**
   * Marks the project's current active approval (if any) as superseded.
   * Idempotent no-op (returns `null`) when nothing is currently active —
   * safe to call unconditionally from the regeneration-completion path.
   */
  supersedeActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null>;

  /**
   * Idempotent production-finalization request, keyed 1:1 to one
   * `FinalDirectionApproval`. Implementations must throw
   * `UniqueConstraintViolationError` on a duplicate
   * `(project_id, final_direction_approval_id)` insert rather than creating
   * a second competing job. Phase 2B never claims or runs this job.
   */
  createFinalArtworkJob(
    projectId: string,
    input: CreateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob>;
  /**
   * DEPRECATED for job resolution (Sprint A2 Correction 2). One approval may
   * now own more than one job — one per requested production output — so
   * "the job for this approval" is no longer a well-formed question. It
   * returns the OLDEST matching row. Use `listFinalArtworkJobsForApproval`
   * and match on bound intent when deciding whether a job satisfies a
   * request.
   *
   * Sprint A2 Correction 3 removed its last production-behaviour caller:
   * delivery resolution used to come through here and could hand a customer
   * a historical PNG as fulfillment of a request it did not answer. Exactly
   * ONE caller remains — `local-final-artwork-trigger.ts`'s `next dev`
   * stranded-job recovery, which only re-triggers an already-queued job and
   * is fenced by the worker regardless of which job it picks. That fact is
   * pinned by a test; if a second caller ever appears, check it against
   * `resolveCurrentMatchingProductionJob` first.
   */
  getFinalArtworkJobByApprovalId(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob | null>;
  /**
   * Sprint A2 Correction 2: every job ever enqueued for one
   * `FinalDirectionApproval`, oldest first — the create_new counterpart of
   * `listFinalArtworkJobsForPreparation`, and for the same reason it exists:
   * an approval legitimately owns more than one job once the customer's
   * requested production output changes, and matching them is a domain
   * decision (`productionIntentMatches`) rather than something to express in
   * the query.
   *
   * Always project-scoped — an approval id from another project can never
   * return rows here.
   */
  /**
   * Print'em All Phase 2: every finalization job for this project that a
   * worker can still act on (`queued` / `running` / `recoverable`).
   *
   * Deliberately project-scoped and workflow-agnostic rather than resolved
   * through an approval or a preparation: the question it answers — "is a
   * plate being made right now?" — is about the PROJECT, and a job under a
   * superseded authority that is still running is still running.
   *
   * Empty is the common case and means nothing is in flight, whatever
   * `PrintProject.status` happens to say (see
   * `ACTIVE_FINAL_ARTWORK_JOB_STATUSES` for why those can disagree).
   */
  listActiveFinalArtworkJobs(projectId: string): Promise<FinalArtworkJob[]>;
  listFinalArtworkJobsForApproval(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob[]>;
  /**
   * Existing Artwork → Print Ready Phase 2: every finalization job ever
   * enqueued for one `ArtworkPreparation`, oldest first. Returns the whole
   * history rather than one row because a project may legitimately own more
   * than one (the customer changed production size after a plate was already
   * produced — a different physical specification is a different deliverable,
   * never a rewrite of the old one).
   *
   * Matching by production width is deliberately left to the caller: an
   * inches figure is a float, and "the same size" is a tolerance question
   * (`FinalArtworkCapability` owns that policy), not something to express as
   * SQL float equality.
   *
   * Always project-scoped — a preparation id from another project can never
   * return rows here (Goal 18).
   */
  listFinalArtworkJobsForPreparation(
    projectId: string,
    artworkPreparationId: string,
  ): Promise<FinalArtworkJob[]>;
  /** Signs Phase S2: mirrors `listFinalArtworkJobsForPreparation` for the sign-preparation authority. */
  listFinalArtworkJobsForSignPreparation(
    projectId: string,
    signPreparationId: string,
  ): Promise<FinalArtworkJob[]>;
  /** Sprint 2M Phase 2C. Also needed to re-resolve `designBriefVersionId` (via the approval, not denormalized on the job) once the worker claims a job. */
  getFinalDirectionApprovalById(
    id: string,
  ): Promise<FinalDirectionApproval | null>;

  // --- Sprint 2M Phase 2C: final artwork worker -------------------------

  getFinalArtworkJob(jobId: string): Promise<FinalArtworkJob | null>;
  updateFinalArtworkJob(
    jobId: string,
    patch: UpdateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob>;
  /**
   * The worker's entry point — mirrors `claimNextQueuedJob` exactly (same
   * atomic-claim contract: optimistic conditional update, "only one caller
   * ever wins", real Supabase row-conditional update or the local store's
   * mutex-serialized equivalent).
   */
  claimNextQueuedFinalArtworkJob(): Promise<FinalArtworkJob | null>;
  touchFinalArtworkJobHeartbeat(jobId: string): Promise<void>;
  /** Mirrors `recoverAbandonedJobs` — single atomic conditional update, no select-then-write gap. */
  recoverAbandonedFinalArtworkJobs(
    staleAfterMs: number,
  ): Promise<FinalArtworkJob[]>;

  /**
   * Sprint 2M Phase 2C (Goal 12): persists one authoritative Print
   * Validation run against a real production asset. Append-only — a
   * revalidation always inserts a new row, never overwrites the last one.
   */
  createProductionAssetValidation(
    projectId: string,
    input: CreateProductionAssetValidationInput,
  ): Promise<ProductionAssetValidation>;
  /** Most recent validation for a given job, if any — used for idempotent retry (Goal 16). */
  getLatestProductionAssetValidationForJob(
    projectId: string,
    finalArtworkJobId: string,
  ): Promise<ProductionAssetValidation | null>;

  // --- Existing Artwork → Print Ready Phase 1: uploaded-artwork preparation ---

  createArtworkPreparation(
    projectId: string,
    input: CreateArtworkPreparationInput,
  ): Promise<ArtworkPreparation>;
  /**
   * The project's current preparation — the most recently created one. Also
   * the authoritative answer to "is this a `prepare_existing` project?": a
   * non-null result IS the workflow identity, which is why Phase 1 needs no
   * workflow enum column anywhere (see `ArtworkPreparation`'s doc comment).
   */
  getArtworkPreparation(projectId: string): Promise<ArtworkPreparation | null>;
  /**
   * By id, WITHOUT a project filter — callers are responsible for checking
   * `projectId` themselves. Deliberately shaped this way (mirroring
   * `getFinalDirectionApprovalById`) so a cross-project id is detected as a
   * mismatch by the capability rather than silently returning `null`, which
   * would be indistinguishable from "does not exist".
   */
  getArtworkPreparationById(id: string): Promise<ArtworkPreparation | null>;
  updateArtworkPreparation(
    id: string,
    patch: UpdateArtworkPreparationInput,
  ): Promise<ArtworkPreparation>;

  /**
   * Signs Phase S1: persist the rigid-sign preparation record for one
   * project. A row's existence IS the sign-workflow identity for that
   * project — mirroring `ArtworkPreparation`'s no-workflow-enum rule.
   */
  createSignPreparation(
    projectId: string,
    input: CreateSignPreparationInput,
  ): Promise<SignPreparation>;
  /** Latest sign preparation for the project, or `null`. */
  getSignPreparation(projectId: string): Promise<SignPreparation | null>;
  getSignPreparationById(id: string): Promise<SignPreparation | null>;
  updateSignPreparation(
    id: string,
    patch: UpdateSignPreparationInput,
  ): Promise<SignPreparation>;
}
