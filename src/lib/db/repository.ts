import type {
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
  PrintProject,
  ProductionAssetValidation,
  ProjectSnapshot,
  ProjectStatus,
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
export type CreateFinalArtworkJobInput =
  | {
      sourceKind: "generated_concept";
      finalDirectionApprovalId: string;
      artworkVersionId: string;
    }
  | {
      sourceKind: "prepared_upload";
      artworkPreparationId: string;
      artworkVersionId: string;
      /** The production print width, in inches, this job is enqueued for — half of its idempotency key. */
      productionWidthIn: number;
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
  approvedAt: string | null;
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

export interface ProjectRepository {
  createProject(): Promise<ProjectSnapshot>;
  getProject(projectId: string): Promise<ProjectSnapshot | null>;
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
  createGenerationJob(
    projectId: string,
    input: CreateGenerationJobInput,
  ): Promise<GenerationJob>;
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
  getFinalArtworkJobByApprovalId(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob | null>;
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
}
