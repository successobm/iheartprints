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
  // Sprint 2D: Design Summary approval gate (additive).
  "awaiting_summary_confirmation",
  "brief_approved",
  "edit_requested",
  "continue_requested",
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
  /** Sprint 2D: the approved Design Brief version that authorized this concept. */
  designBriefVersionId: string | null;
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
  printPlacement: PrintPlacement;
  preferredColors: string[];
  designStyle: string | null;
  additionalInstructions: string | null;
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
