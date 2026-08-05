/**
 * Revision lifecycle contracts. Behavior not implemented in Sprint 2C.
 * Sprint 1 revision notes still flow through Intent Extraction → Design Brief.
 */
export type RevisionClassification =
  | "brief_intent_change"
  | "artwork_execution_tweak"
  | "unclassified";

export interface RevisionRecord {
  id: string;
  designId: string;
  classification: RevisionClassification;
  sourceArtworkId?: string | null;
  sourceBriefId?: string | null;
  createdAt: string;
}

export interface RevisionCapability {
  classifyRevisionRequest(_input: {
    designId: string;
    message: string;
  }): RevisionClassification;
  /** Future: fork working brief from approved version. */
  forkBriefFromApproved(_designId: string): Promise<null>;
  listRevisions(_designId: string): Promise<RevisionRecord[]>;
}

export function createRevisionCapability(): RevisionCapability {
  return {
    classifyRevisionRequest() {
      return "unclassified";
    },
    async forkBriefFromApproved() {
      return null;
    },
    async listRevisions() {
      return [];
    },
  };
}
