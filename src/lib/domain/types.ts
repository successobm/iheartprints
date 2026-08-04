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
  "ask_product",
  "ask_design",
  "ask_shirt_color",
  "ask_text",
  "skip_references",
  "generating",
  "concepts_ready",
  "ask_revisions",
  "revision_received",
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
  printPlacement: PrintPlacement;
  intendedPrintWidthIn: number | null;
  preferredColors: string[];
  designStyle: string | null;
  additionalInstructions: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesignConversation {
  id: string;
  projectId: string;
  phase: ConversationPhase;
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
  createdAt: string;
}

export interface ProjectSnapshot {
  project: PrintProject;
  brief: TShirtDesignBrief;
  conversation: DesignConversation;
  messages: ConversationMessage[];
  artworkVersions: ArtworkVersion[];
}
