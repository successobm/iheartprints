import {
  UniqueConstraintViolationError,
  type ProjectRepository,
} from "@/lib/db/repository";
import { toDesignBriefSnapshotContent } from "@/lib/domain/brief-snapshot";
import type {
  DesignBriefSnapshotContent,
  DesignBriefVersion,
  PrintPlacement,
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
  /**
   * Live Acceptance Cleanup (Issue 5): records the customer's chosen
   * PRODUCTION print width, in inches — authoritative production intent.
   *
   * Separate from `applyProposal` on purpose. This is not an Intent
   * Extraction proposal about the design; it is a production specification,
   * and it is deliberately the one brief field excluded from
   * `DesignBriefSnapshotContent` (see `brief-snapshot.ts`) and from
   * `diffBriefSections`. That exclusion is what guarantees the property the
   * Constitution needs here: choosing a size can never approve a new brief
   * version, mark concepts stale, trigger a creative revision, or reach an
   * image provider. It only changes what the production pipeline is told to
   * produce.
   *
   * The caller is responsible for resolving/clamping the value against the
   * placement's printable band (`resolveProductionWidth`) — this boundary
   * persists an already-decided figure.
   */
  setIntendedPrintWidth(
    designId: string,
    widthIn: number | null,
  ): Promise<TShirtDesignBrief>;
  /**
   * Existing Artwork → Print Ready Phase 1: records the PRODUCTION CONTEXT an
   * uploaded-artwork customer states — what we're printing on, its colour,
   * and where the print goes.
   *
   * Separate from `applyProposal` for the same reason `setIntendedPrintWidth`
   * is: this is not an Intent Extraction interpretation of a conversational
   * message, and labelling it `source: "intent_extraction"` to reuse that
   * path would make the provenance a lie. The customer answered a direct
   * question with a direct value.
   *
   * It deliberately touches ONLY these three fields. `designDescription`,
   * `exactText`, `designStyle`, and every other creative field stay untouched
   * — for uploaded artwork the pixels are the design, and inventing a written
   * description of them would create a second, competing source of truth.
   *
   * `undefined` leaves a field alone; an explicit `null` clears it.
   */
  setUploadedArtworkContext(
    designId: string,
    input: {
      productSummary?: string | null;
      shirtColor?: string | null;
      printPlacement?: PrintPlacement | null;
    },
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

    async setIntendedPrintWidth(designId, widthIn) {
      return repo.updateBrief(designId, { intendedPrintWidthIn: widthIn });
    },

    async setUploadedArtworkContext(designId, input) {
      const patch: Partial<TShirtDesignBrief> = {};
      if (input.productSummary !== undefined) {
        patch.productSummary = normalizeOptionalText(input.productSummary);
      }
      if (input.shirtColor !== undefined) {
        patch.shirtColor = normalizeOptionalText(input.shirtColor);
      }
      if (input.printPlacement !== undefined) {
        patch.printPlacement = input.printPlacement;
      }

      if (Object.keys(patch).length === 0) return this.getWorkingBrief(designId);
      return repo.updateBrief(designId, patch);
    },

    async getLatestApprovedVersion(designId) {
      return repo.getLatestDesignBriefVersion(designId);
    },

    async approveWorkingBrief(designId) {
      const brief = await this.getWorkingBrief(designId);
      const content = toDesignBriefSnapshotContent(brief);
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

function contentEquals(
  a: DesignBriefSnapshotContent,
  b: DesignBriefSnapshotContent,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whitespace-only input is "not answered", never a stored empty string. */
function normalizeOptionalText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
