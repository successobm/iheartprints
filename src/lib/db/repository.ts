import type {
  ArtworkVersion,
  ConversationMessage,
  ConversationPhase,
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  DesignConversation,
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
}

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
  addMessage(
    projectId: string,
    input: CreateMessageInput,
  ): Promise<ConversationMessage>;
  addArtworkVersions(
    projectId: string,
    versions: CreateArtworkVersionInput[],
  ): Promise<ArtworkVersion[]>;
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
}
