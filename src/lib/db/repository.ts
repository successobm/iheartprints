import type {
  ArtworkVersion,
  ConversationMessage,
  ConversationPhase,
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
}
