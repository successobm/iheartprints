import type {
  ArtworkVersion,
  AssetRecord,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  ConversationMessage,
  ConversationPhase,
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  DesignConversation,
  GenerationJob,
  InterviewStateData,
  MessageRole,
  PrintProject,
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

export interface ApproveDesignBriefInput {
  briefId: string;
  versionNumber: number;
  content: DesignBriefSnapshotContent;
}

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
      Pick<PrintProject, "name" | "status" | "selectedArtworkVersionId">
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
}
