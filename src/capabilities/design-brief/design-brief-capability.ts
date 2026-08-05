import {
  UniqueConstraintViolationError,
  type ProjectRepository,
} from "@/lib/db/repository";
import type {
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type { BriefPatchProposal } from "@/capabilities/shared/contracts";

/**
 * Authoritative Design Brief capability.
 * All brief mutations must go through this boundary.
 */
export interface DesignBriefCapability {
  getWorkingBrief(designId: string): Promise<TShirtDesignBrief>;
  /**
   * Accept or reject an Intent Extraction proposal.
   * Sprint 1/2C: accepts any non-empty field patch (no per-field validation yet).
   */
  applyProposal(
    designId: string,
    proposal: BriefPatchProposal,
  ): Promise<TShirtDesignBrief>;
  /** Most recent durable approval, if any. */
  getLatestApprovedVersion(
    designId: string,
  ): Promise<DesignBriefVersion | null>;
  /**
   * Freezes the current working brief as a new immutable, durable version.
   *
   * Idempotency: if the latest approved version's content is identical to
   * the current working brief, that existing version is returned rather than
   * creating a duplicate. If a concurrent request already inserted the next
   * version number, the resulting unique-constraint violation is resolved by
   * refetching and returning the winning row instead of erroring.
   */
  approveWorkingBrief(designId: string): Promise<DesignBriefVersion>;
}

export function createDesignBriefCapability(
  repo: ProjectRepository,
): DesignBriefCapability {
  return {
    async getWorkingBrief(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot.brief;
    },

    async applyProposal(designId, proposal) {
      if (Object.keys(proposal.fields).length === 0) {
        return this.getWorkingBrief(designId);
      }
      return repo.updateBrief(designId, proposal.fields);
    },

    async getLatestApprovedVersion(designId) {
      return repo.getLatestDesignBriefVersion(designId);
    },

    async approveWorkingBrief(designId) {
      const brief = await this.getWorkingBrief(designId);
      const content = toSnapshotContent(brief);
      const existing = await repo.getLatestDesignBriefVersion(designId);

      if (existing && contentEquals(existing.content, content)) {
        return existing;
      }

      const nextVersionNumber = (existing?.versionNumber ?? 0) + 1;

      try {
        return await repo.approveDesignBrief(designId, {
          briefId: brief.id,
          versionNumber: nextVersionNumber,
          content,
        });
      } catch (error) {
        if (error instanceof UniqueConstraintViolationError) {
          const latest = await repo.getLatestDesignBriefVersion(designId);
          if (latest) return latest;
        }
        throw error;
      }
    },
  };
}

function toSnapshotContent(
  brief: TShirtDesignBrief,
): DesignBriefSnapshotContent {
  return {
    productSummary: brief.productSummary,
    designDescription: brief.designDescription,
    exactText: brief.exactText,
    shirtColor: brief.shirtColor,
    printPlacement: brief.printPlacement,
    preferredColors: [...brief.preferredColors],
    designStyle: brief.designStyle,
    additionalInstructions: brief.additionalInstructions,
  };
}

function contentEquals(
  a: DesignBriefSnapshotContent,
  b: DesignBriefSnapshotContent,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
