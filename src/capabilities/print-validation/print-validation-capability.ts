import type { ValidationReport } from "@/capabilities/shared/contracts";

/**
 * Independent print validation. Must never modify Design Briefs.
 * Sprint 2C: contract + placeholder only.
 */
export interface PrintValidationCapability {
  validateArtwork(input: {
    artworkId: string;
    designBriefVersionId?: string | null;
  }): Promise<ValidationReport>;
}

export function createPrintValidationCapability(): PrintValidationCapability {
  return {
    async validateArtwork({ artworkId, designBriefVersionId }) {
      return {
        artworkId,
        designBriefVersionId: designBriefVersionId ?? null,
        checks: [],
        overall: "not_run",
      };
    },
  };
}
