/**
 * Long-term domain entrypoint.
 * Sprint 2C: re-exports existing Sprint 1 domain types/helpers so future
 * imports can target `@/domain` without forcing a mass move yet.
 */

export type {
  ArtworkKind,
  ArtworkVersion,
  ConversationMessage,
  ConversationPhase,
  DesignConversation,
  MessageRole,
  PrintPlacement,
  PrintProject,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";

export {
  ARTWORK_KINDS,
  CONVERSATION_PHASES,
  PROJECT_STATUSES,
} from "./constants";

export {
  OPENING_PROMPT,
  applyUserReplyToBrief,
  nextPhaseAfterUserReply,
  projectNameFromBrief,
  promptForPhase,
} from "@/lib/domain/conversation";

export {
  buildPlaceholderConcepts,
  type ConceptSeed,
} from "@/lib/domain/concepts";
